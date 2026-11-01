import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { projectScopeHook } from "../../project-scope-hook.js";
import { requireFindingQualityAssets } from "./quality-assets.js";
import { loadStoredFindingQualityReport } from "./quality-worker.js";
import type { Actor } from "../../auth.js";
import { sql } from "../../db.js";
import { QualityContractError, QualityDatasetBodySchema, QualityDigestSchema,
  QualityTimestampSchema, QualityUuidSchema, QUALITY_INPUT_BYTES, qualityDatasetDigests, qualityDigest, assertQualityBudget } from "./quality-contract.js";
import { appendQualityRecord, assertQualityAuthority, assertLoadedQualityScope,
  loadQualityProtocol, loadQualityRecord, registerQualityProtocol, qualityVersion, type QualityRecordKind } from "./quality-store.js";
import { withQualityHead, advanceQualityHead, loadQualityHistory, persistQualityExposure, type QualityHead } from "./quality-state-store.js";
import { summarizeQualityHistory, validateQualityRecord, validateQualityReceiptChain, type QualityReceipt } from "./quality-ledger.js";

export const QUALITY_API_MODULE_URL = import.meta.url;
type Db = typeof sql;
export const FindingQualityVersionSchema = z.object({ expected_version: z.string().transform(qualityVersion) }).strict();
const internalQualityBlockers = Object.freeze([
  "INDEPENDENT_HUMAN_LABELS_UNVERIFIED", "NATURAL_HUMAN_ALIASES_UNVERIFIED",
  "EXTERNAL_SOURCE_PROVENANCE_UNVERIFIED", "PREACCESS_THRESHOLD_ADOPTION_UNVERIFIED",
]);

/** Engineering admission is distinct from quality acceptance. No management
 * caller can supply verification/pass flags or turn an account into a person. */
export function findingQualityEvidenceStatus() {
  return { quality_status: "not_evaluated" as const, blockers: internalQualityBlockers };
}
async function protocolForMutation(tx: Db, head: QualityHead) {
  const protocol = await loadQualityProtocol(head.project_id, head.protocol_id, tx);
  assertLoadedQualityScope(head.project_id, protocol.body);
  if (Date.now() >= Date.parse(protocol.body.valid_until)) throw new QualityContractError("QUALITY_PROTOCOL_EXPIRED");
  if (["revoked", "blocked"].includes(head.phase)) throw new QualityContractError("QUALITY_PROTOCOL_INACTIVE");
  return protocol;
}
function scopeBody(protocol: Awaited<ReturnType<typeof loadQualityProtocol>>) {
  return { protocol_digest: String(protocol.row.protocol_digest), scope_digest: qualityDigest(protocol.body.scope) };
}
async function writeTransition(tx: Db, head: QualityHead, actor: Actor, kind: QualityRecordKind,
  subjectId: string, body: Record<string, unknown>, phase: QualityHead["phase"]) {
  const record = await appendQualityRecord(tx, { projectId: head.project_id, protocolId: head.protocol_id,
    actor, kind, subjectId, body });
  return { record, head: await advanceQualityHead(tx, head, record, phase), ...findingQualityEvidenceStatus() };
}

export async function freezeFindingQualityProtocol(projectId: string, protocolId: string,
  expectedVersion: string, actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId);
  return withQualityHead(projectId, protocolId, expectedVersion, async (tx, head) => {
    const protocol = await protocolForMutation(tx, head);
    const history = await loadQualityHistory(tx, projectId);
    const exposure = summarizeQualityHistory({ project_id: projectId, protocol_id: protocolId, ...history });
    if (exposure.exposure_status !== "none_observed_in_supplied_history") throw new QualityContractError("QUALITY_HOLDOUT_ALREADY_EXPOSED_OR_UNKNOWN");
    return writeTransition(tx, head, actor, "freeze", head.latest_record_id,
      { ...scopeBody(protocol), thresholds_digest: qualityDigest(protocol.body.thresholds) }, "frozen");
  }, db);
}
export async function declareFindingQualityDataset(projectId: string, protocolId: string,
  expectedVersion: string, actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId);
  return withQualityHead(projectId, protocolId, expectedVersion, async (tx, head) => {
    const protocol = await protocolForMutation(tx, head);
    if (!head.freeze_record_id) throw new QualityContractError("QUALITY_FREEZE_REQUIRED");
    return writeTransition(tx, head, actor, "dataset_declaration", head.freeze_record_id,
      { ...scopeBody(protocol), dataset_digest: protocol.body.scope.dataset_digest }, "frozen");
  }, db);
}

/** The Host MUST first commit persistQualityExposure in preParsing. A forged
 * access object is not accepted: its real SQL row/actor and current head are
 * reloaded under CAS. No raw JSON/schema processing may precede that exposure. */
export async function admitFindingQualityPayload(projectId: string, protocolId: string,
  exposure: { record: Record<string, unknown>; head: { version: string } }, value: unknown,
  actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId);
  const version = qualityVersion(exposure.head.version);
  return withQualityHead(projectId, protocolId, version, async (tx, head) => {
    const access = validateQualityRecord((await loadQualityRecord(projectId, protocolId, String(exposure.record.id), tx)).row);
    if (access.kind !== "holdout_access" || access.id !== head.latest_record_id
      || access.actor_type !== actor.type || access.actor_id !== actor.id) throw new QualityContractError("QUALITY_ACCESS_BINDING_MISMATCH");
    const protocol = await protocolForMutation(tx, head);
    if (access.body.protocol_digest !== protocol.row.protocol_digest
      || access.body.scope_digest !== qualityDigest(protocol.body.scope)) throw new QualityContractError("QUALITY_ACCESS_BINDING_MISMATCH");
    assertQualityBudget(value);
    const dataset = QualityDatasetBodySchema.parse(value), digests = qualityDatasetDigests(dataset);
    for (const key of Object.keys(digests) as Array<keyof typeof digests>) {
      if (digests[key] !== protocol.body.scope[key]) throw new QualityContractError("QUALITY_DATASET_BINDING_MISMATCH");
    }
    const payload = await writeTransition(tx, head, actor, "holdout_payload", access.id,
      { ...scopeBody(protocol), dataset }, "frozen");
    const admission = await writeTransition(tx, payload.head, actor, "dataset_admission", String(payload.record.id),
      { ...scopeBody(protocol), dataset_digest: digests.dataset_digest }, "admitted");
    const runId = randomUUID();
    // One immutable admitted dataset per protocol. No restart/generation reset
    // can hide lifetime exposure; Scheduler alone executes this bounded work.
    await tx`INSERT INTO project_finding_quality_work(project_id,protocol_id,dataset_record_id,state_json)
      VALUES(${projectId},${protocolId},${String(admission.record.id)},${tx.json({ run_id: runId, next_ordinal: 0 })})`;
    return { ...admission, run_id: runId };
  }, db);
}

export const FindingQualityReviewSchema = z.object({ expected_version: z.string().transform(qualityVersion),
  evidence_digest: QualityDigestSchema.nullable(), expires_at: QualityTimestampSchema }).strict();
export async function reviewFindingQualityEvaluation(projectId: string, protocolId: string,
  value: unknown, actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId); assertQualityBudget(value);
  const input = FindingQualityReviewSchema.parse(value);
  return withQualityHead(projectId, protocolId, input.expected_version, async (tx, head) => {
    const protocol = await protocolForMutation(tx, head);
    if (!head.evaluation_record_id) throw new QualityContractError("QUALITY_EVALUATION_REQUIRED");
    const evaluation = validateQualityRecord((await loadQualityRecord(projectId, protocolId, head.evaluation_record_id, tx)).row);
    if (evaluation.kind !== "evaluation") throw new QualityContractError("QUALITY_EVALUATION_BINDING_MISMATCH");
    const body = (evaluation as QualityReceipt<"evaluation">).body;
    if (Date.parse(input.expires_at) <= Date.now() || Date.parse(input.expires_at) > Date.parse(protocol.body.valid_until)) {
      throw new QualityContractError("QUALITY_REVIEW_EXPIRY_INVALID");
    }
    // Durable review candidate only. Natural-human independence and external
    // evidence remain unknown; this never publishes a current certificate.
    const candidate = await writeTransition(tx, head, actor, "review", evaluation.id, { ...scopeBody(protocol),
      run_id: body.binding.run_id, dataset_id: body.binding.dataset_id, report_digest: body.report_digest,
      evidence_digest: input.evidence_digest, expires_at: input.expires_at }, "reviewed");
    const history = await loadQualityHistory(tx, projectId);
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    if (!clock) throw new QualityContractError("QUALITY_CLOCK_UNAVAILABLE");
    const chain = validateQualityReceiptChain({ project_id: projectId, protocol_id: protocolId,
      review_id: String(candidate.record.id), current_scope: protocol.body.scope,
      current_time: new Date(clock.now as string | Date).toISOString(), ...history });
    // This verifies only the full durable chain and known principal conflicts.
    // Structural validity does not authenticate distinct natural humans.
    // A digest-shaped evaluation alone is not a run: reconstruct the current
    // immutable observation cohort and metrics in this same MVCC snapshot.
    await loadStoredFindingQualityReport(tx, projectId, protocolId);
    return { ...candidate, chain };
  }, db, { isolationLevel: "repeatable_read" });
}
export const FindingQualityRevokeSchema = z.object({ expected_version: z.string().transform(qualityVersion), reason: z.string().min(1).max(200) }).strict();
export async function revokeFindingQualityProtocol(projectId: string, protocolId: string,
  value: unknown, actor: Actor, db: Db = sql) {
  assertQualityAuthority(actor, projectId); assertQualityBudget(value);
  const input = FindingQualityRevokeSchema.parse(value);
  return withQualityHead(projectId, protocolId, input.expected_version, async (tx, head) => {
    const protocol = await loadQualityProtocol(projectId, protocolId, tx);
    const result = await writeTransition(tx, head, actor, "revoke", head.latest_record_id,
      { ...scopeBody(protocol), reason: input.reason }, "revoked");
    await tx`UPDATE project_finding_quality_work SET status='failed',last_error_code='QUALITY_PROTOCOL_REVOKED',updated_at=clock_timestamp()
      WHERE project_id=${projectId} AND protocol_id=${protocolId} AND status IN ('pending','running')`;
    // Invalidate only this protocol's current tuple; do not clear another
    // certificate or any immutable exposure/history/observations.
    await tx`UPDATE project_finding_quality_current SET version=version+1,protocol_id=NULL,certificate_record_id=NULL,scope_digest=NULL,updated_at=clock_timestamp()
      WHERE project_id=${projectId} AND protocol_id=${protocolId}`;
    return result;
  }, db);
}


/** Root authentication runs first. Early ownership protects exposure before
 * Fastify consumes, limits or decodes the raw request body. */
export function registerFindingQualityRoutes(app: FastifyInstance, db: Db = sql): void {
  const base = "/projects/:id/finding-quality";
  const exposures = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof persistQualityExposure>>>();
  const params = (req: FastifyRequest) => {
    const p = req.params as { id: string; protocolId?: string; declarationId?: string };
    QualityUuidSchema.parse(p.id);
    if (p.protocolId) QualityUuidSchema.parse(p.protocolId);
    if (p.declarationId) QualityUuidSchema.parse(p.declarationId);
    return p;
  };
  const authorize = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = params(req);
    assertQualityAuthority(req.actor, p.id);
    if (Object.keys(req.query ?? {}).length) throw new QualityContractError("QUALITY_QUERY_INVALID");
    reply.header("Cache-Control", "no-store");
    await projectScopeHook(req, reply);
  };
  const fail = async (error: Error & { statusCode?: number }, req: FastifyRequest, reply: FastifyReply) => {
    const access = exposures.get(req);
    if (access) {
      // A later parse/admission failure cannot roll back committed exposure.
      const p = params(req);
      try {
        await db.begin(async raw => {
          const tx = raw as unknown as Db;
          const protocol = await loadQualityProtocol(p.id, p.protocolId!, tx);
          await loadQualityRecord(p.id, p.protocolId!, String(access.record.id), tx);
          await appendQualityRecord(tx, { projectId: p.id, protocolId: p.protocolId!, kind: "rejection",
            actor: req.actor!, subjectId: String(access.record.id), body: { ...scopeBody(protocol),
              reason: error instanceof QualityContractError ? error.code : "QUALITY_PAYLOAD_INVALID" } });
        });
      } catch {
        return reply.code(500).send({ error: "QUALITY_REJECTION_WRITE_FAILED", error_code: "QUALITY_REJECTION_WRITE_FAILED", ...findingQualityEvidenceStatus() });
      }
    }
    const knownInput = error instanceof z.ZodError || error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415;
    const code = error instanceof QualityContractError ? error.code : knownInput ? "QUALITY_INPUT_INVALID" : "QUALITY_REQUEST_FAILED";
    const status = code.includes("AUTHORITY") || code.includes("PROJECT_MISMATCH") ? 403
      : code.endsWith("NOT_FOUND") ? 404 : /CONFLICT|MISMATCH|INACTIVE|EXPOSED|TRANSITION/u.test(code) ? 409
      : /ASSETS|SOURCE_CAPTURE/u.test(code) ? 503 : error.statusCode === 413 ? 413
      : error instanceof QualityContractError || knownInput ? 400 : 500;
    return reply.code(status).send({ error: code, error_code: code, ...findingQualityEvidenceStatus() });
  };
  const options = { onRequest: authorize, errorHandler: fail };
  app.get(base + "/assets", options, async () => ({ assets: requireFindingQualityAssets(), ...findingQualityEvidenceStatus() }));
  app.post(base + "/protocols", options, async req => {
    const p = params(req);
    return { protocol: await registerQualityProtocol(p.id, req.body, req.actor!, db), ...findingQualityEvidenceStatus() };
  });
  app.get(base + "/protocols/:protocolId", options, async req => {
    const p = params(req);
    return db.begin(async raw => {
      const tx = raw as unknown as Db;
      const protocol = await loadQualityProtocol(p.id, p.protocolId!, tx);
      const history = await loadQualityHistory(tx, p.id);
      const [head] = await tx`SELECT *,version::text AS version FROM project_finding_quality_heads WHERE project_id=${p.id} AND protocol_id=${p.protocolId!}`;
      const [work] = await tx`SELECT status,generation::text AS generation,processed_generation::text AS processed_generation,evaluation_record_id,last_error_code FROM project_finding_quality_work WHERE project_id=${p.id} AND protocol_id=${p.protocolId!}`;
      // Metadata only: do not leak raw labels, observations or report.input.
      return { protocol: protocol.row, head, work: work ?? null,
        history: summarizeQualityHistory({ project_id: p.id, protocol_id: p.protocolId!, ...history }), ...findingQualityEvidenceStatus() };
    });
  });
  app.get(base + "/protocols/:protocolId/report", options, async req => {
    const p = params(req);
    return db.begin("isolation level repeatable read read only", async raw => {
      const stored = await loadStoredFindingQualityReport(raw as unknown as Db, p.id, p.protocolId!);
      // Explicit metadata allowlist: raw label packets/selector traces never leave this route.
      const fields = ["schema_version", "binding", "dataset_kind", "input_digest", "observations_digest",
        "report_digest", "per_class", "candidate_recall", "labeled_pairs", "known_labeled_pairs",
        "unknown_labeled_pairs", "unknown_selected_pairs", "selected_pairs", "compared_pairs",
        "missing_subject_traces", "missing_decisions", "not_selected_positive", "not_compared_positive",
        "predicted_insufficient", "truncated_subjects", "observed_rows_including_sentinels", "blockers"] as const;
      return { generation: stored.generation, source_validation: stored.source_validation,
        report: Object.fromEntries(fields.map(key => [key, stored.report[key]])), ...findingQualityEvidenceStatus() };
    });
  });
  const versionBody = FindingQualityVersionSchema;
  app.post(base + "/protocols/:protocolId/freeze", options, async req => {
    const p = params(req), body = versionBody.parse(req.body);
    return freezeFindingQualityProtocol(p.id, p.protocolId!, body.expected_version, req.actor!, db);
  });
  app.post(base + "/protocols/:protocolId/declarations", options, async req => {
    const p = params(req), body = versionBody.parse(req.body);
    return declareFindingQualityDataset(p.id, p.protocolId!, body.expected_version, req.actor!, db);
  });
  app.post(base + "/protocols/:protocolId/declarations/:declarationId/payload", {
    ...options, bodyLimit: QUALITY_INPUT_BYTES,
    preParsing: async (req, _reply, payload) => {
      const p = params(req), key = req.headers["idempotency-key"];
      if (key !== undefined && typeof key !== "string") throw new QualityContractError("QUALITY_REQUEST_KEY_INVALID");
      const access = await persistQualityExposure({ projectId: p.id, protocolId: p.protocolId!,
        declarationId: p.declarationId!, actor: req.actor!, ...(key === undefined ? {} : { requestKey: key }) }, db);
      exposures.set(req, access);
      return payload;
    },
  }, async req => {
    const p = params(req), access = exposures.get(req);
    if (!access) throw new QualityContractError("QUALITY_ACCESS_REQUIRED");
    return admitFindingQualityPayload(p.id, p.protocolId!, access, req.body, req.actor!, db);
  });
  app.post(base + "/protocols/:protocolId/reviews", options, async req => {
    const p = params(req); return reviewFindingQualityEvaluation(p.id, p.protocolId!, req.body, req.actor!, db);
  });
  app.post(base + "/protocols/:protocolId/revoke", options, async req => {
    const p = params(req); return revokeFindingQualityProtocol(p.id, p.protocolId!, req.body, req.actor!, db);
  });
}
