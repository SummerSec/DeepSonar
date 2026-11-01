import { randomUUID } from "node:crypto";
import { sql } from "../../db.js";
import type { Actor } from "../../auth.js";
import { requireFindingQualityAssets } from "./quality-assets.js";
import {
  assertQualityBudget, qualityDigest, QualityContractError,
  QualityProtocolBodySchema, QualityUuidSchema, type QualityProtocolBody,
} from "./quality-contract.js";

export const QUALITY_STORE_MODULE_URL = import.meta.url;
type Db = typeof sql;
type Row = Record<string, unknown>;
export type QualityRecordKind = "registered" | "freeze" | "dataset_declaration"
  | "holdout_access" | "holdout_payload" | "dataset_admission" | "evaluation"
  | "review" | "revoke" | "rejection" | "alias_resolution";

/** Management only. Session identity is required: API-token/display-name
 * aliases and bootstrap authority cannot manufacture an independent person.
 * Authentication establishes a platform principal, not physical human truth.
 */
export function assertQualityAuthority(actor: Actor | undefined, projectId: string): asserts actor is Actor & { id: string } {
  QualityUuidSchema.parse(projectId);
  if (!actor || actor.type !== "user" || !actor.id
    || (actor.role !== "admin" && actor.role !== "operator")
    || !actor.scopes.includes("admin") || (actor.projectId && actor.projectId !== projectId)) {
    throw new QualityContractError("QUALITY_AUTHORITY_REQUIRED");
  }
  QualityUuidSchema.parse(actor.id);
}

function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new QualityContractError("QUALITY_RECORD_INVALID");
  return parsed as Record<string, unknown>;
}
export function qualityVersion(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)
    || value.length > 19 || BigInt(value) > 9223372036854775807n) {
    throw new QualityContractError("QUALITY_VERSION_INVALID");
  }
  return value;
}

/** No input hash is trusted as loaded code/config. Data hashes are commitments
 * here; actual admission/current-data validation is a separate required gate.
 */
export function assertLoadedQualityScope(projectId: string, protocol: QualityProtocolBody): void {
  if (protocol.scope.project_id !== projectId) throw new QualityContractError("QUALITY_PROJECT_MISMATCH");
  const assets = requireFindingQualityAssets();
  const names = ["code_digest", "config_digest", "selector_digest", "normalization_digest", "strong_rule_digest",
    "extractor_version", "normalization_version", "strong_rule_version", "metric_version",
    "population_version", "label_mapping_version"] as const;
  if (names.some((name) => protocol.scope[name] !== assets[name])) throw new QualityContractError("QUALITY_LOADED_SCOPE_MISMATCH");
}

export async function loadQualityProtocol(projectId: string, protocolId: string, db: Db = sql) {
  QualityUuidSchema.parse(projectId); QualityUuidSchema.parse(protocolId);
  const [row] = await db`SELECT * FROM project_finding_quality_protocols
    WHERE project_id=${projectId} AND id=${protocolId}`;
  if (!row) throw new QualityContractError("QUALITY_PROTOCOL_NOT_FOUND");
  const body = QualityProtocolBodySchema.parse(object(row.body_json));
  if (body.scope.project_id !== projectId || qualityDigest(body) !== String(row.protocol_digest)) {
    throw new QualityContractError("QUALITY_PROTOCOL_INTEGRITY_INVALID");
  }
  return { row: row as Row, body };
}

/** Scheduler-internal ledger writer; HTTP callers never provide actor/hash/time.
 * Distinct exposure requests get distinct IDs. Immutable INSERT times are DB
 * owned and checked independently when chains are loaded, not caller metadata.
 */
export async function appendQualityRecord(db: Db, input: {
  projectId: string; protocolId: string; kind: QualityRecordKind; actor: Actor;
  body: Record<string, unknown>; subjectId?: string; requestKey?: string;
}) {
  assertQualityBudget(input.body);
  const id = randomUUID();
  const actor = { type: input.actor.type, id: input.actor.id ?? null, name: input.actor.name };
  const digestBody = { id, project_id: input.projectId, protocol_id: input.protocolId,
    kind: input.kind, subject_record_id: input.subjectId ?? null, actor, body: input.body };
  const recordDigest = qualityDigest(digestBody);
  const [row] = await db`INSERT INTO project_finding_quality_records
    (id,project_id,protocol_id,kind,record_digest,subject_record_id,request_key,actor_type,actor_id,actor_name,body_json)
    VALUES(${id},${input.projectId},${input.protocolId},${input.kind},${recordDigest},${input.subjectId ?? null},
      ${input.requestKey ?? null},${actor.type},${actor.id},${actor.name},${db.json(JSON.parse(JSON.stringify(input.body)))}) RETURNING *`;
  if (!row) throw new QualityContractError("QUALITY_RECORD_WRITE_FAILED");
  return row as Row;
}

export async function loadQualityRecord(projectId: string, protocolId: string, recordId: string, db: Db = sql) {
  QualityUuidSchema.parse(recordId);
  const [row] = await db`SELECT * FROM project_finding_quality_records
    WHERE project_id=${projectId} AND protocol_id=${protocolId} AND id=${recordId}`;
  if (!row) throw new QualityContractError("QUALITY_RECORD_NOT_FOUND");
  const body = object(row.body_json);
  const expected = qualityDigest({ id: String(row.id), project_id: String(row.project_id), protocol_id: String(row.protocol_id),
    kind: String(row.kind), subject_record_id: row.subject_record_id ? String(row.subject_record_id) : null,
    actor: { type: String(row.actor_type), id: row.actor_id ? String(row.actor_id) : null, name: String(row.actor_name) }, body });
  if (String(row.record_digest) !== expected) throw new QualityContractError("QUALITY_RECORD_INTEGRITY_INVALID");
  return { row: row as Row, body };
}

export async function registerQualityProtocol(projectId: string, value: unknown, actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId); assertQualityBudget(value);
  const body = QualityProtocolBodySchema.parse(value);
  assertLoadedQualityScope(projectId, body);
  if (Date.parse(body.valid_until) <= Date.now()) throw new QualityContractError("QUALITY_PROTOCOL_EXPIRED");
  const protocolDigest = qualityDigest(body);
  return db.begin(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [inserted] = await tx`INSERT INTO project_finding_quality_protocols
      (project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_id,created_by_actor_name)
      VALUES(${projectId},${protocolDigest},${tx.json(body)},${actor.type},${actor.id},${actor.name})
      ON CONFLICT(project_id,protocol_digest) DO NOTHING RETURNING *`;
    if (!inserted) {
      const [existing] = await tx`SELECT * FROM project_finding_quality_protocols WHERE project_id=${projectId} AND protocol_digest=${protocolDigest}`;
      if (!existing || existing.created_by_actor_id !== actor.id) throw new QualityContractError("QUALITY_PROTOCOL_CONFLICT");
      return existing as Row;
    }
    const protocolId = String(inserted.id);
    const record = await appendQualityRecord(tx, { projectId, protocolId, kind: "registered", actor,
      body: { protocol_digest: protocolDigest, scope_digest: qualityDigest(body.scope), maker_ids: [actor.id], tuner_ids: [actor.id] } });
    await tx`INSERT INTO project_finding_quality_heads(project_id,protocol_id,version,phase,latest_record_id)
      VALUES(${projectId},${protocolId},0,'registered',${String(record.id)})`;
    await tx`INSERT INTO project_finding_quality_current(project_id,version) VALUES(${projectId},0) ON CONFLICT(project_id) DO NOTHING`;
    return inserted as Row;
  });
}
