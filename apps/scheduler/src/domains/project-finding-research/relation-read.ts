import { createHash } from "node:crypto";
import { sql } from "../../db.js";
import { isUuid } from "../../project-scope.js";
import {
  compareAuthoritativeIdentity,
  PLATFORM_IDENTITY_FIELDS,
  STRONG_IDENTITY_FIELDS,
  STRONG_RELATION_QUALITY_GATE_STATUS,
  STRONG_RELATION_RULE_VERSION,
  STRONG_RELATIONS_PUBLISHED,
  type PlatformIdentityField,
  type StrongRelationKind,
} from "./identity.js";
import { loadCurrentIdentitySnapshot } from "./identity-mapping-store.js";
import { loadFindingEnvelope } from "./relation-computation.js";
import { fail } from "./relation-errors.js";
import { IDENTITY_SOURCE_AUTHORITY_BASIS } from "./identity-source-store.js";

type Db = typeof sql;

export const RELATION_RESULT_LIMIT = 50;
export const CANVAS_FINDING_LIMIT = 500;
export const CANVAS_RELATION_LIMIT = 2_000;
export const CANVAS_RESPONSE_BYTES = 512 * 1024;

const CURSOR_KIND = "finding_strong_relations" as const;

interface RelationCursor {
  v: 1;
  kind: typeof CURSOR_KIND;
  project: string;
  subject: string;
  after: string;
  binding: string;
}

interface ReadBudget {
  usedRelations: number;
  usedBytes: number;
}

function parseRelationCursor(value: unknown): RelationCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) fail("INVALID_CURSOR");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) fail("INVALID_CURSOR");
  let parsed: unknown;
  try { parsed = JSON.parse(decoded.toString("utf8")); } catch { fail("INVALID_CURSOR"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("INVALID_CURSOR");
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "after,binding,kind,project,subject,v"
    || row.v !== 1 || row.kind !== CURSOR_KIND
    || typeof row.project !== "string" || !isUuid(row.project)
    || typeof row.subject !== "string" || !isUuid(row.subject)
    || typeof row.after !== "string" || !isUuid(row.after)
    || typeof row.binding !== "string" || !/^[a-f0-9]{64}$/u.test(row.binding)) fail("INVALID_CURSOR");
  return row as unknown as RelationCursor;
}

function relationBinding(project: string, subject: string, generation: string, source: string, identity: string): string {
  return createHash("sha256")
    .update(JSON.stringify([project, subject, generation, source, identity, STRONG_RELATION_RULE_VERSION]))
    .digest("hex");
}

export interface StrongRelationPage {
  authority_basis: typeof IDENTITY_SOURCE_AUTHORITY_BASIS;
  independent_external_verification: false;
  subject_id: string;
  project_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "stale";
  rebuilding: boolean;
  active_generation: string | null;
  rule_version: string;
  quality_gate_status: typeof STRONG_RELATION_QUALITY_GATE_STATUS;
  published: false;
  identity_status: "authoritative" | "insufficient_information";
  query_plane: "current";
  processed_at: string | null;
  error_code: string | null;
  attempts: number;
  examined: number;
  pair_truncated: boolean | null;
  read_status: "complete" | "truncated" | "blocked";
  read_reason: string | null;
  next_cursor: string | null;
  stale_results_omitted: boolean;
  items: Array<{
    relation_id: string;
    finding_id: string;
    kind: StrongRelationKind;
    matched_fields: PlatformIdentityField[];
    different_fields: PlatformIdentityField[];
    root_cause_continuation: boolean;
    processed_at: string;
  }>;
}

function relationId(project: string, left: string, right: string): string {
  return `sha256:${createHash("sha256").update(`${project}:${left}:${right}`, "utf8").digest("hex")}`;
}

function emptyPage(findingId: string, projectId: string): StrongRelationPage {
  return {
    authority_basis: IDENTITY_SOURCE_AUTHORITY_BASIS,
    independent_external_verification: false,
    subject_id: findingId,
    project_id: projectId,
    status: "stale",
    rebuilding: false,
    active_generation: null,
    rule_version: STRONG_RELATION_RULE_VERSION,
    quality_gate_status: STRONG_RELATION_QUALITY_GATE_STATUS,
    published: STRONG_RELATIONS_PUBLISHED,
    identity_status: "insufficient_information",
    query_plane: "current",
    processed_at: null,
    error_code: null,
    attempts: 0,
    examined: 0,
    pair_truncated: null,
    read_status: "complete",
    read_reason: null,
    next_cursor: null,
    stale_results_omitted: false,
    items: [],
  };
}

async function readStrongRelationPageInTransaction(
  findingId: string,
  cursor: RelationCursor | null,
  tx: Db,
  authorizedProjectId: string | null | undefined,
  includeSuppressed: boolean,
  budget?: ReadBudget,
): Promise<StrongRelationPage | null> {
  const envelope = await loadFindingEnvelope(tx, findingId, authorizedProjectId);
  if (!envelope) return null;
  const snapshot = await loadCurrentIdentitySnapshot(findingId, envelope.project_id, tx);
  const [work] = await tx`SELECT status, generation, active_generation, error_code, attempts
    FROM project_finding_relation_work WHERE project_id = ${envelope.project_id}::uuid`;
  if (cursor && (cursor.project.toLowerCase() !== envelope.project_id.toLowerCase()
    || cursor.subject.toLowerCase() !== findingId.toLowerCase())) fail("CURSOR_SCOPE_MISMATCH");
  const binding = work?.active_generation
    ? relationBinding(envelope.project_id, findingId, String(work.active_generation), envelope.source_fingerprint, snapshot.fingerprint)
    : null;
  if (cursor && cursor.binding !== binding) fail("CURSOR_GAP");
  const [source] = work?.active_generation ? await tx`SELECT processed_at, source_fingerprint,
    identity_fingerprint, rule_version, examined, pair_truncated, read_status, read_reason
    FROM project_finding_relation_sources
    WHERE project_id = ${envelope.project_id}::uuid AND generation = ${work.active_generation}::uuid
      AND finding_id = ${findingId}::uuid` : [];
  const fresh = Boolean(source && source.source_fingerprint === envelope.source_fingerprint
    && source.identity_fingerprint === snapshot.fingerprint && source.rule_version === STRONG_RELATION_RULE_VERSION);
  const readStatus = snapshot.history_truncated
    ? "blocked" as const
    : source?.read_status === "blocked"
      ? "blocked" as const
      : source?.read_status === "truncated"
        ? "truncated" as const
        : "complete" as const;
  const readReason = snapshot.history_truncated
    ? "IDENTITY_MAPPING_HISTORY_LIMIT" : source?.read_reason ? String(source.read_reason) : null;
  const result: StrongRelationPage = {
    authority_basis: IDENTITY_SOURCE_AUTHORITY_BASIS,
    independent_external_verification: false,
    subject_id: findingId,
    project_id: envelope.project_id,
    status: work?.status === "failed" ? "failed" : work?.status === "running" ? "running" : fresh ? "succeeded" : "stale",
    rebuilding: Boolean(work && work.generation !== work.active_generation),
    active_generation: work?.active_generation ? String(work.active_generation) : null,
    rule_version: STRONG_RELATION_RULE_VERSION,
    quality_gate_status: STRONG_RELATION_QUALITY_GATE_STATUS,
    published: STRONG_RELATIONS_PUBLISHED,
    identity_status: STRONG_IDENTITY_FIELDS.every((field) => snapshot.fields[field].status === "valid")
      ? "authoritative" : "insufficient_information",
    query_plane: "current",
    processed_at: fresh && source?.processed_at ? new Date(String(source.processed_at)).toISOString() : null,
    error_code: work?.error_code ? String(work.error_code) : null,
    attempts: Number(work?.attempts ?? 0),
    examined: fresh ? Number(source?.examined ?? 0) : 0,
    pair_truncated: fresh ? Boolean(source?.pair_truncated) : null,
    read_status: readStatus,
    read_reason: readReason,
    next_cursor: null,
    stale_results_omitted: false,
    items: [],
  };
  if (readStatus === "blocked" || !work?.active_generation) return result;
  const rows = await tx`SELECT * FROM project_finding_relations
    WHERE project_id = ${envelope.project_id}::uuid AND generation = ${work.active_generation}::uuid
      AND ((left_id = ${findingId}::uuid ${cursor ? tx`AND right_id > ${cursor.after}::uuid` : tx``})
        OR (right_id = ${findingId}::uuid ${cursor ? tx`AND left_id > ${cursor.after}::uuid` : tx``}))
    ORDER BY CASE WHEN left_id = ${findingId}::uuid THEN right_id ELSE left_id END
    LIMIT ${RELATION_RESULT_LIMIT + 1}`;
  const pageRows = rows.slice(0, RELATION_RESULT_LIMIT);
  for (const row of pageRows) {
    const leftId = String(row.left_id);
    const rightId = String(row.right_id);
    const peerId = leftId === findingId ? rightId : leftId;
    const peer = await loadFindingEnvelope(tx, peerId, envelope.project_id);
    if (!peer) {
      result.stale_results_omitted = true;
      continue;
    }
    const peerSnapshot = await loadCurrentIdentitySnapshot(peerId, envelope.project_id, tx);
    const decision = compareAuthoritativeIdentity(
      leftId === findingId ? snapshot : peerSnapshot,
      rightId === findingId ? snapshot : peerSnapshot,
    );
    const currentSourceMatch = (leftId === findingId ? envelope.source_fingerprint : peer.source_fingerprint) === String(row.left_source_fingerprint)
      && (rightId === findingId ? envelope.source_fingerprint : peer.source_fingerprint) === String(row.right_source_fingerprint);
    const currentIdentityMatch = (leftId === findingId ? snapshot.fingerprint : peerSnapshot.fingerprint) === String(row.left_identity_fingerprint)
      && (rightId === findingId ? snapshot.fingerprint : peerSnapshot.fingerprint) === String(row.right_identity_fingerprint);
    if (peerSnapshot.history_truncated || String(row.rule_version) !== STRONG_RELATION_RULE_VERSION || row.published !== false
      || !currentSourceMatch || !currentIdentityMatch
      || (decision.kind !== "same_problem" && decision.kind !== "same_root_cause_different_instance")
      || decision.kind !== row.relation_kind) {
      result.stale_results_omitted = true;
      continue;
    }
    if (!includeSuppressed) continue;
    const item = {
      relation_id: relationId(envelope.project_id, leftId, rightId),
      finding_id: peerId,
      kind: row.relation_kind as StrongRelationKind,
      matched_fields: row.matched_fields as PlatformIdentityField[],
      different_fields: row.different_fields as PlatformIdentityField[],
      root_cause_continuation: Boolean(row.root_cause_continuation),
      processed_at: new Date(String(row.processed_at)).toISOString(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (budget && (budget.usedRelations >= CANVAS_RELATION_LIMIT
      || budget.usedBytes + bytes > CANVAS_RESPONSE_BYTES)) {
      result.read_status = "truncated";
      result.read_reason = budget.usedRelations >= CANVAS_RELATION_LIMIT
        ? "CANVAS_RELATION_LIMIT" : "CANVAS_RESPONSE_BYTE_LIMIT";
      break;
    }
    result.items.push(item);
    if (budget) {
      budget.usedRelations += 1;
      budget.usedBytes += bytes;
    }
  }
  if (rows.length > RELATION_RESULT_LIMIT && pageRows.at(-1)) {
    const last = pageRows.at(-1)!;
    const after = String(String(last.left_id) === findingId ? last.right_id : last.left_id);
    if (budget) {
      result.read_status = "truncated";
      result.read_reason = result.read_reason ?? "RELATION_PAGE_LIMIT";
    } else {
      result.next_cursor = Buffer.from(JSON.stringify({
        v: 1, kind: CURSOR_KIND, project: envelope.project_id, subject: findingId,
        after, binding,
      }), "utf8").toString("base64url");
    }
  }
  if (result.pair_truncated) {
    result.read_status = "truncated";
    result.read_reason = result.read_reason ?? "DERIVATION_PAIR_LIMIT";
  }
  if (result.stale_results_omitted && result.status !== "failed") result.status = "stale";
  return result;
}

export async function readStrongRelationPage(
  findingId: string,
  cursorValue: unknown,
  db: Db = sql,
  authorizedProjectId?: string | null,
  includeSuppressed = false,
): Promise<StrongRelationPage | null> {
  if (!isUuid(findingId)) fail("INVALID_ID");
  if (authorizedProjectId !== undefined && authorizedProjectId !== null && !isUuid(authorizedProjectId)) fail("INVALID_ID");
  const cursor = parseRelationCursor(cursorValue);
  return db.begin("isolation level repeatable read read only", async (raw) => {
    const tx = raw as unknown as Db;
    await tx`SET LOCAL statement_timeout = '3000ms'`;
    return readStrongRelationPageInTransaction(findingId, cursor, tx, authorizedProjectId, includeSuppressed);
  });
}

export interface CanvasStrongRelationPage {
  authority_basis: typeof IDENTITY_SOURCE_AUTHORITY_BASIS;
  independent_external_verification: false;
  canvas_id: string;
  project_id: string;
  quality_gate_status: typeof STRONG_RELATION_QUALITY_GATE_STATUS;
  published: false;
  read_status: "complete" | "truncated" | "blocked";
  read_reason: string | null;
  truncated: boolean;
  finding_count: number;
  query_budget: {
    max_findings: number;
    max_relations: number;
    max_response_bytes: number;
    used_findings: number;
    used_relations: number;
    used_response_bytes: number;
  };
  items: Array<StrongRelationPage["items"][number] & { subject_id: string }>;
}

export async function readCanvasStrongRelations(
  canvasId: string,
  db: Db = sql,
  authorizedProjectId?: string | null,
  includeSuppressed = false,
): Promise<CanvasStrongRelationPage | null> {
  if (!isUuid(canvasId)) fail("INVALID_ID");
  if (authorizedProjectId !== undefined && authorizedProjectId !== null && !isUuid(authorizedProjectId)) fail("INVALID_ID");
  return db.begin("isolation level repeatable read read only", async (raw) => {
    const tx = raw as unknown as Db;
    await tx`SET LOCAL statement_timeout = '5000ms'`;
    const [canvas] = await tx`SELECT id, project_id FROM canvases
      WHERE id = ${canvasId}::text
        AND (${authorizedProjectId ?? null}::uuid IS NULL OR project_id = ${authorizedProjectId ?? null}::uuid)`;
    if (!canvas) return null;
    const findings = await tx`SELECT f.id FROM findings f JOIN jobs j
      ON j.id = f.job_id AND j.project_id = f.project_id
      WHERE j.canvas_id = ${canvasId}::text AND f.project_id = ${canvas.project_id}::uuid
      ORDER BY f.id LIMIT ${CANVAS_FINDING_LIMIT + 1}`;
    const findingTruncated = findings.length > CANVAS_FINDING_LIMIT;
    const budget: ReadBudget = { usedRelations: 0, usedBytes: 0 };
    const items: CanvasStrongRelationPage["items"] = [];
    const seen = new Set<string>();
    let readStatus: CanvasStrongRelationPage["read_status"] = findingTruncated ? "truncated" : "complete";
    let readReason: string | null = findingTruncated ? "CANVAS_FINDING_LIMIT" : null;
    for (const row of findings.slice(0, CANVAS_FINDING_LIMIT)) {
      if (readReason === "CANVAS_RESPONSE_BYTE_LIMIT") break;
      const page = await readStrongRelationPageInTransaction(
        String(row.id), null, tx, String(canvas.project_id), includeSuppressed, budget,
      );
      if (!page) continue;
      if (page.read_status === "blocked") {
        readStatus = "blocked";
        readReason = page.read_reason ?? "RELATION_READ_BLOCKED";
        items.length = 0;
        break;
      }
      if (page.read_status === "truncated") {
        readStatus = "truncated";
        readReason = readReason ?? page.read_reason;
      }
      for (const item of page.items) {
        if (seen.has(item.relation_id)) continue;
        seen.add(item.relation_id);
        items.push({ ...item, subject_id: String(row.id) });
      }
      if (budget.usedRelations >= CANVAS_RELATION_LIMIT || budget.usedBytes >= CANVAS_RESPONSE_BYTES) {
        readStatus = "truncated";
        readReason = budget.usedRelations >= CANVAS_RELATION_LIMIT
          ? "CANVAS_RELATION_LIMIT" : "CANVAS_RESPONSE_BYTE_LIMIT";
        break;
      }
    }
    return {
      authority_basis: IDENTITY_SOURCE_AUTHORITY_BASIS,
      independent_external_verification: false,
      canvas_id: String(canvas.id),
      project_id: String(canvas.project_id),
      quality_gate_status: STRONG_RELATION_QUALITY_GATE_STATUS,
      published: STRONG_RELATIONS_PUBLISHED,
      read_status: readStatus,
      read_reason: readReason,
      truncated: readStatus === "truncated",
      finding_count: Math.min(findings.length, CANVAS_FINDING_LIMIT),
      query_budget: {
        max_findings: CANVAS_FINDING_LIMIT,
        max_relations: CANVAS_RELATION_LIMIT,
        max_response_bytes: CANVAS_RESPONSE_BYTES,
        used_findings: Math.min(findings.length, CANVAS_FINDING_LIMIT),
        used_relations: budget.usedRelations,
        used_response_bytes: budget.usedBytes,
      },
      items,
    };
  });
}

export { emptyPage };
