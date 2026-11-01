import { sql as qualitySql } from "../../db.js";
import { appendQualityRecord, loadQualityProtocol, loadQualityRecord, assertLoadedQualityScope } from "./quality-store.js";
import { withQualityHead, advanceQualityHead, loadQualityHistory, type QualityHead } from "./quality-state-store.js";
import { summarizeQualityHistory, validateQualityRecord, type QualityReceipt } from "./quality-ledger.js";
import { computeQualityMetrics } from "./quality-metrics.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { sql } from "../../db.js";
import { compareAuthoritativeIdentity, STRONG_IDENTITY_FIELDS } from "./identity.js";
import { loadCurrentIdentitySnapshot } from "./identity-mapping-store.js";
import { loadFindingEnvelope } from "./relation-computation.js";
import { selectStrongRelationCandidates, RELATION_PAIR_LIMIT } from "./strong-candidate-selector.js";
import { assertQualityBudget, qualityDigest, QualityContractError, QualityDigestSchema,
  QualityUuidSchema, QUALITY_TRACE_LIMIT } from "./quality-contract.js";
import { qualityVersion } from "./quality-store.js";

export const QUALITY_WORKER_MODULE_URL = import.meta.url;
type Db = typeof sql;
const binding = z.object({ finding_id: QualityUuidSchema, source_digest: QualityDigestSchema,
  identity_digest: QualityDigestSchema }).strict();
const observationSchema = z.object({
  schema_version: z.literal(1), source: binding, peers: z.array(binding).max(RELATION_PAIR_LIMIT),
  selection: z.object({ finding_id: QualityUuidSchema, peerIds: z.array(QualityUuidSchema).max(RELATION_PAIR_LIMIT),
    observedCount: z.number().int().min(0).max(RELATION_PAIR_LIMIT + 1), truncated: z.boolean(),
    countKind: z.enum(["exact", "lower_bound"]) }).strict(),
  decisions: z.array(z.object({ left_id: QualityUuidSchema, right_id: QualityUuidSchema,
    prediction: z.enum(["same_problem", "same_root_cause_different_instance", "distinct", "insufficient_information"])
  }).strict()).max(RELATION_PAIR_LIMIT),
  blockers: z.array(z.literal("INCOMPLETE_IDENTITY")),
}).strict().superRefine((v, ctx) => {
  const s = v.selection, sentinel = s.observedCount === RELATION_PAIR_LIMIT + 1;
  if (s.finding_id !== v.source.finding_id || s.truncated !== sentinel
    || s.countKind !== (sentinel ? "lower_bound" : "exact")
    || s.peerIds.length !== (sentinel ? RELATION_PAIR_LIMIT : s.observedCount)
    || v.peers.length !== s.peerIds.length || v.decisions.length !== s.peerIds.length
    || s.peerIds.some((id, i) => id <= s.finding_id || (i > 0 && id <= s.peerIds[i - 1]!)
      || v.peers[i]?.finding_id !== id || v.decisions[i]?.left_id !== s.finding_id
      || v.decisions[i]?.right_id !== id)) {
    ctx.addIssue({ code: "custom", message: "unbound raw SQL observation" });
  }
});
export type QualitySubjectObservation = z.infer<typeof observationSchema>;

async function currentSource(db: Db, projectId: string, findingId: string) {
  const envelope = await loadFindingEnvelope(db, findingId, projectId);
  if (!envelope) throw new QualityContractError("QUALITY_SOURCE_UNAVAILABLE");
  if (envelope.id !== findingId || envelope.project_id !== projectId) throw new QualityContractError("QUALITY_SOURCE_SCOPE_MISMATCH");
  const identity = await loadCurrentIdentitySnapshot(findingId, projectId, db);
  if (identity.history_truncated) throw new QualityContractError("QUALITY_IDENTITY_HISTORY_INCOMPLETE");
  return { identity, binding: { finding_id: findingId, source_digest: envelope.source_fingerprint,
    identity_digest: identity.fingerprint } };
}

/** Scheduler-internal, using actual SQL. No labels, split, lexical ranking,
 * replayed time or caller predictions enter selection/comparison. Peers
 * outside the admitted dataset remain visible, never silently filtered. */
export async function observeFindingQualitySubject(db: Db, projectId: string, findingId: string): Promise<QualitySubjectObservation> {
  QualityUuidSchema.parse(projectId); QualityUuidSchema.parse(findingId);
  const root = await currentSource(db, projectId, findingId);
  const selected = await selectStrongRelationCandidates(db, { projectId, findingId, rootCause: root.identity.fields.root_cause });
  const peers: QualitySubjectObservation["peers"] = [], decisions: QualitySubjectObservation["decisions"] = [];
  let incompleteIdentity = STRONG_IDENTITY_FIELDS.some((field) => root.identity.fields[field].status !== "valid");
  for (const peerId of selected.peerIds) {
    const peer = await currentSource(db, projectId, peerId);
    incompleteIdentity ||= STRONG_IDENTITY_FIELDS.some((field) => peer.identity.fields[field].status !== "valid");
    peers.push(peer.binding);
    decisions.push({ left_id: findingId, right_id: peerId,
      prediction: compareAuthoritativeIdentity(root.identity, peer.identity).kind });
  }
  // Identity expiry during the pass is drift too, not a usable partial report.
  for (const before of [root.binding, ...peers]) {
    const after = await currentSource(db, projectId, before.finding_id);
    if (qualityDigest(before) !== qualityDigest(after.binding)) throw new QualityContractError("QUALITY_SOURCE_CHANGED");
  }
  return observationSchema.parse({ schema_version: 1, source: root.binding, peers,
    selection: { finding_id: findingId, ...selected }, decisions,
    blockers: incompleteIdentity ? ["INCOMPLETE_IDENTITY"] : [] });
}

const observationScope = z.object({ project_id: QualityUuidSchema, protocol_id: QualityUuidSchema,
  generation: z.string(), dataset_record_id: QualityUuidSchema, subject_finding_id: QualityUuidSchema,
  ordinal: z.number().int().min(0).max(QUALITY_TRACE_LIMIT - 1) }).strict();
export type QualityObservationScope = z.infer<typeof observationScope>;

/** Immutable engineering trace, not a human/quality certificate. DB owns the
 * timestamp; it is not hashed and needs trusted SQL validation. Caller must
 * have authenticated the complete admitted receipt chain before execution. */
export async function appendFindingQualityObservation(db: Db, scopeValue: QualityObservationScope, value: unknown) {
  assertQualityBudget(value);
  const scope = observationScope.parse(scopeValue), body = observationSchema.parse(value);
  qualityVersion(scope.generation);
  if (scope.generation === "0" || scope.subject_finding_id !== body.source.finding_id) {
    throw new QualityContractError("QUALITY_OBSERVATION_SCOPE_MISMATCH");
  }
  const id = randomUUID(), inputDigest = qualityDigest({ ...scope, source: body.source, peers: body.peers });
  const digest = qualityDigest({ id, ...scope, input_digest: inputDigest, body });
  const [row] = await db`INSERT INTO project_finding_quality_observations(
    id,project_id,protocol_id,work_generation,dataset_record_id,subject_finding_id,ordinal,input_digest,record_digest,body_json)
    SELECT ${id},${scope.project_id},${scope.protocol_id},${scope.generation},${scope.dataset_record_id},
      ${scope.subject_finding_id},${scope.ordinal},${inputDigest},${digest},${db.json(body as never)}
    FROM project_finding_quality_work w
    JOIN project_finding_quality_records d ON d.project_id=w.project_id AND d.protocol_id=w.protocol_id
      AND d.id=w.dataset_record_id AND d.kind='dataset_admission'
    WHERE w.project_id=${scope.project_id} AND w.protocol_id=${scope.protocol_id}
      AND w.dataset_record_id=${scope.dataset_record_id} AND w.generation=${scope.generation}
      AND w.claimed_generation=w.generation AND w.status='running'
    RETURNING *`;
  if (!row) throw new QualityContractError("QUALITY_OBSERVATION_WRITE_FAILED");
  return row;
}

/** Overflow/missing ordinals/digest or scope drift fail closed. No replacement
 * observations, synthetic SQL replay or history erasure on retries. */
export async function loadFindingQualityObservations(db: Db, input: {
  project_id: string; protocol_id: string; generation: string; dataset_record_id: string;
}) {
  for (const id of [input.project_id, input.protocol_id, input.dataset_record_id]) QualityUuidSchema.parse(id);
  qualityVersion(input.generation);
  if (input.generation === "0") throw new QualityContractError("QUALITY_OBSERVATION_SCOPE_MISMATCH");
  const rows = await db`SELECT * FROM project_finding_quality_observations
    WHERE project_id=${input.project_id} AND protocol_id=${input.protocol_id}
      AND work_generation=${input.generation} AND dataset_record_id=${input.dataset_record_id}
    ORDER BY ordinal LIMIT ${QUALITY_TRACE_LIMIT + 1}`;
  if (rows.length > QUALITY_TRACE_LIMIT) throw new QualityContractError("QUALITY_OBSERVATION_HISTORY_INCOMPLETE");
  const observations: QualitySubjectObservation[] = [];
  for (const [ordinal, row] of rows.entries()) {
    const body = observationSchema.parse(typeof row.body_json === "string" ? JSON.parse(row.body_json) : row.body_json);
    const scope = observationScope.parse({ project_id: row.project_id, protocol_id: row.protocol_id,
      generation: String(row.work_generation), dataset_record_id: row.dataset_record_id,
      subject_finding_id: row.subject_finding_id, ordinal: row.ordinal });
    const inputDigest = qualityDigest({ ...scope, source: body.source, peers: body.peers });
    if (scope.project_id !== input.project_id || scope.protocol_id !== input.protocol_id
      || scope.generation !== input.generation || scope.dataset_record_id !== input.dataset_record_id
      || scope.subject_finding_id !== body.source.finding_id || scope.ordinal !== ordinal
      || row.input_digest !== inputDigest || row.record_digest !== qualityDigest({ id: row.id, ...scope, input_digest: inputDigest, body })) {
      throw new QualityContractError("QUALITY_OBSERVATION_INTEGRITY_INVALID");
    }
    observations.push(body);
  }
  assertQualityBudget(observations);
  return observations;
}

const snapshotOptions = { isolationLevel: "repeatable_read" as const };
const workState = z.object({ run_id: QualityUuidSchema, next_ordinal: z.number().int().min(0).max(QUALITY_TRACE_LIMIT) }).strict();
type Work = {
  project_id: string;
  protocol_id: string;
  generation: string;
  dataset_record_id: string;
  state_json: unknown;
};
type Attempt = Omit<Work, "dataset_record_id"> & {
  dataset_record_id: string | null;
};
async function sqlTime(tx: Db) {
  const [row] = await tx `SELECT clock_timestamp() AS quality_now`;
  const value = row?.quality_now;
  if (!(value instanceof Date) && typeof value !== "string")
    throw new QualityContractError("QUALITY_SQL_CLOCK_UNAVAILABLE");
  return new Date(value).toISOString();
}
async function admittedContext(tx: Db, head: QualityHead) {
  const protocol = await loadQualityProtocol(head.project_id, head.protocol_id, tx);
  assertLoadedQualityScope(head.project_id, protocol.body);
  if (Date.parse(await sqlTime(tx)) >= Date.parse(protocol.body.valid_until))
    throw new QualityContractError("QUALITY_PROTOCOL_EXPIRED");
  const history = await loadQualityHistory(tx, head.project_id);
  const summary = summarizeQualityHistory({ project_id: head.project_id, protocol_id: head.protocol_id, ...history });
  if (summary.exposure_status !== "observed")
    throw new QualityContractError("QUALITY_ADMITTED_HISTORY_INVALID");
  const records = new Map(history.records.map(raw => {
    const r = validateQualityRecord(raw);
    return [r.id, r] as const;
  }));
  if ([...records.values()].some(r => r.protocol_id === head.protocol_id && r.kind === "revoke"))
    throw new QualityContractError("QUALITY_PROTOCOL_INACTIVE");
  const chain: QualityReceipt[] = [];
  let id: string | null = head.dataset_record_id;
  for (const kind of ["dataset_admission", "holdout_payload", "holdout_access", "dataset_declaration", "freeze", "registered"] as const) {
    const row = records.get(id ?? "");
    if (!row || row.kind !== kind || row.protocol_id !== head.protocol_id || row.project_id !== head.project_id)
      throw new QualityContractError("QUALITY_ADMITTED_CHAIN_INVALID");
    chain.push(row);
    id = row.subject_record_id;
  }
  const freeze = chain[4]!, first = records.get(head.first_access_record_id ?? "");
  if (!first || first.kind !== "holdout_access" || first.protocol_id !== head.protocol_id || Date.parse(first.created_at) > Date.parse(chain[2]!.created_at))
    throw new QualityContractError("QUALITY_ADMITTED_CHAIN_INVALID");
  if (id !== null || freeze.id !== head.freeze_record_id || !summary.first_holdout_access_at || Date.parse(freeze.created_at) > Date.parse(summary.first_holdout_access_at))
    throw new QualityContractError("QUALITY_FREEZE_ORDER_INVALID");
  if (Date.parse(freeze.created_at) === Date.parse(summary.first_holdout_access_at)) {
    for (const first of summary.first_holdout_access_record_ids) {
      let row = records.get(first), found = false;
      for (let i = 0; row && i <= records.size; i++) {
        if (row.id === freeze.id) {
          found = true;
          break;
        }
        row = records.get(row.subject_record_id ?? "");
      }
      if (!found)
        throw new QualityContractError("QUALITY_FREEZE_ORDER_INVALID");
    }
  }
  const dataset = (chain[1] as QualityReceipt<"holdout_payload">).body.dataset;
  for (const source of dataset.sources) {
    const actual = (await currentSource(tx, head.project_id, source.id)).binding;
    if (actual.source_digest !== source.source_digest || actual.identity_digest !== source.identity_digest)
      throw new QualityContractError("QUALITY_ADMITTED_SOURCE_CHANGED");
  }
  const subjects = dataset.sources.filter(s => s.split === "holdout").map(s => s.id).sort();
  if (!subjects.length)
    throw new QualityContractError("QUALITY_EMPTY_HOLDOUT");
  return { protocol, dataset, subjects, admission: chain[0]! };
}
function readWork(row: Record<string, unknown>): Work {
  const generation = qualityVersion(row.generation), processed = qualityVersion(row.processed_generation);
  if (generation === "0" || BigInt(processed) > BigInt(generation))
    throw new QualityContractError("QUALITY_WORK_GENERATION_INVALID");
  if (row.claimed_generation != null && qualityVersion(row.claimed_generation) !== generation)
    throw new QualityContractError("QUALITY_WORK_VERSION_CONFLICT");
  return { project_id: QualityUuidSchema.parse(row.project_id), protocol_id: QualityUuidSchema.parse(row.protocol_id), generation, dataset_record_id: QualityUuidSchema.parse(row.dataset_record_id), state_json: row.state_json };
}
async function reportInput(tx: Db, head: QualityHead, work: Work, requireComplete = false) {
  if (head.dataset_record_id !== work.dataset_record_id)
    throw new QualityContractError("QUALITY_WORK_DATASET_MISMATCH");
  const context = await admittedContext(tx, head), state = workState.parse(work.state_json);
  const observations = await loadFindingQualityObservations(tx, work);
  if (observations.length !== state.next_ordinal || observations.some((o, i) => o.source.finding_id !== context.subjects[i]))
    throw new QualityContractError("QUALITY_WORK_CHECKPOINT_INVALID");
  if (requireComplete) {
    if (observations.length !== context.subjects.length)
      throw new QualityContractError("QUALITY_REPORT_INCOMPLETE");
    for (const observation of observations) {
      const actual = await observeFindingQualitySubject(tx, head.project_id, observation.source.finding_id);
      if (qualityDigest(actual) !== qualityDigest(observation))
        throw new QualityContractError("QUALITY_OBSERVATIONS_CHANGED");
    }
  }
  return { ...context, observations, state };
}
function competition(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return ["40001", "40P01", "QUALITY_HEAD_VERSION_CONFLICT", "QUALITY_WORK_VERSION_CONFLICT"].includes(String(code));
}
function errorCode(error: unknown) {
  return error instanceof QualityContractError && /^[A-Z0-9_]{1,160}$/.test(error.code) ? error.code : "QUALITY_WORK_FAILED";
}
/** A finite Scheduler tick. Candidate reads are hints; RR/current->head->work locks govern every write. */
export async function processFindingQualityWork(db: Db = qualitySql): Promise<boolean> {
  const [candidate] = await db `SELECT w.project_id,w.protocol_id,w.generation::text AS generation,h.version::text AS head_version FROM project_finding_quality_work w JOIN project_finding_quality_heads h USING(project_id,protocol_id) WHERE w.status IN ('pending','running') AND w.processed_generation<w.generation ORDER BY w.updated_at,w.project_id,w.protocol_id LIMIT 1`;
  if (!candidate)
    return false;
  let attempt: Attempt | undefined;
  try {
    return await withQualityHead(String(candidate.project_id), String(candidate.protocol_id), String(candidate.head_version), async (tx, head) => {
      const [row] = await tx `SELECT *,generation::text AS generation,processed_generation::text AS processed_generation,claimed_generation::text AS claimed_generation FROM project_finding_quality_work WHERE project_id=${head.project_id} AND protocol_id=${head.protocol_id} AND generation=${qualityVersion(candidate.generation)}::bigint AND status IN ('pending','running') FOR UPDATE SKIP LOCKED`;
      if (!row)
        return false;
      attempt = { project_id: head.project_id, protocol_id: head.protocol_id, generation: String(row.generation), dataset_record_id: row.dataset_record_id == null ? null : String(row.dataset_record_id), state_json: row.state_json };
      const work = readWork(row);
      if (work.project_id !== head.project_id || work.protocol_id !== head.protocol_id || work.generation !== candidate.generation)
        throw new QualityContractError("QUALITY_WORK_SCOPE_MISMATCH");
      if (head.phase !== "admitted")
        throw new QualityContractError("QUALITY_PROTOCOL_INACTIVE");
      const [claimed] = await tx `UPDATE project_finding_quality_work SET status='running',claimed_generation=generation,last_error_code=NULL,updated_at=clock_timestamp() WHERE project_id=${work.project_id} AND protocol_id=${work.protocol_id} AND generation=${work.generation}::bigint AND status IN ('pending','running') RETURNING project_id`;
      if (!claimed)
        throw new QualityContractError("QUALITY_WORK_VERSION_CONFLICT");
      const input = await reportInput(tx, head, work);
      if (input.state.next_ordinal < input.subjects.length) {
        const ordinal = input.state.next_ordinal, findingId = input.subjects[ordinal]!;
        const observation = await observeFindingQualitySubject(tx, head.project_id, findingId);
        await appendFindingQualityObservation(tx, { project_id: work.project_id, protocol_id: work.protocol_id, generation: work.generation, dataset_record_id: work.dataset_record_id, subject_finding_id: findingId, ordinal }, observation);
        const state = { run_id: input.state.run_id, next_ordinal: ordinal + 1 };
        const [advanced] = await tx `UPDATE project_finding_quality_work SET state_json=${tx.json(state)},updated_at=clock_timestamp() WHERE project_id=${work.project_id} AND protocol_id=${work.protocol_id} AND generation=${work.generation}::bigint AND dataset_record_id=${work.dataset_record_id} AND claimed_generation=generation AND status='running' RETURNING project_id`;
        if (!advanced)
          throw new QualityContractError("QUALITY_WORK_VERSION_CONFLICT");
        return true;
      }
      // Separate completion tick: bounded full read-only recheck; no appended/replaced observation.
      const checked = await reportInput(tx, head, work, true);
      const evaluatedAt = await sqlTime(tx);
      if (Date.parse(evaluatedAt) >= Date.parse(input.protocol.body.valid_until))
        throw new QualityContractError("QUALITY_PROTOCOL_EXPIRED");
      const binding = { run_id: checked.state.run_id, dataset_id: work.dataset_record_id, protocol_id: work.protocol_id, protocol_digest: String(checked.protocol.row.protocol_digest), scope: checked.protocol.body.scope, evaluated_at: evaluatedAt };
      const report = computeQualityMetrics({ binding, dataset: checked.dataset, selections: checked.observations.map(o => o.selection), decisions: checked.observations.flatMap(o => o.decisions) });
      const record = await appendQualityRecord(tx, { projectId: work.project_id, protocolId: work.protocol_id, kind: "evaluation", subjectId: work.dataset_record_id, actor: { type: "internal", id: null, projectId: work.project_id, scopes: ["admin"], name: "finding-quality-worker" }, body: { protocol_digest: binding.protocol_digest, scope_digest: qualityDigest(binding.scope), binding, report_digest: report.report_digest } });
      await advanceQualityHead(tx, head, record, "evaluated");
      const [completed] = await tx `UPDATE project_finding_quality_work SET status='completed',evaluation_record_id=${String(record.id)},processed_generation=generation,last_error_code=NULL,updated_at=clock_timestamp() WHERE project_id=${work.project_id} AND protocol_id=${work.protocol_id} AND generation=${work.generation}::bigint AND dataset_record_id=${work.dataset_record_id} AND claimed_generation=generation AND status='running' RETURNING project_id`;
      if (!completed)
        throw new QualityContractError("QUALITY_WORK_VERSION_CONFLICT");
      return true;
    }, db, snapshotOptions);
  }
  catch (error) {
    if (!attempt || competition(error))
      return false;
    const failed = attempt;
    try {
      return await withQualityHead(failed.project_id, failed.protocol_id, String(candidate.head_version), async (tx) => {
        const [locked] = await tx `SELECT project_id FROM project_finding_quality_work WHERE project_id=${failed.project_id} AND protocol_id=${failed.protocol_id} AND generation=${failed.generation}::bigint AND dataset_record_id IS NOT DISTINCT FROM ${failed.dataset_record_id}::uuid AND state_json=${tx.json(failed.state_json as never)} AND status IN ('pending','running') FOR UPDATE SKIP LOCKED`;
        if (!locked)
          return false;
        const [row] = await tx `UPDATE project_finding_quality_work SET status='failed',last_error_code=${errorCode(error)},updated_at=clock_timestamp() WHERE project_id=${failed.project_id} AND protocol_id=${failed.protocol_id} AND generation=${failed.generation}::bigint AND dataset_record_id IS NOT DISTINCT FROM ${failed.dataset_record_id}::uuid AND state_json=${tx.json(failed.state_json as never)} AND status IN ('pending','running') RETURNING project_id`;
        return Boolean(row);
      }, db, snapshotOptions);
    }
    catch {
      return false;
    }
  }
}
/** Requires caller-owned RR SQL transaction. MVCC current reads do not certify future current or people. */
export async function loadStoredFindingQualityReport(tx: Db, projectId: string, protocolId: string) {
  QualityUuidSchema.parse(projectId);
  QualityUuidSchema.parse(protocolId);
  const [isolation] = await tx `SHOW transaction_isolation`;
  if (isolation?.transaction_isolation !== "repeatable read")
    throw new QualityContractError("QUALITY_REPORT_SNAPSHOT_REQUIRED");
  const [headRow] = await tx `SELECT *,version::text AS version FROM project_finding_quality_heads WHERE project_id=${projectId} AND protocol_id=${protocolId}`;
  const [row] = await tx `SELECT *,generation::text AS generation,processed_generation::text AS processed_generation,claimed_generation::text AS claimed_generation FROM project_finding_quality_work WHERE project_id=${projectId} AND protocol_id=${protocolId}`;
  if (!headRow || !row || !["evaluated", "reviewed"].includes(String(headRow.phase)) || row.status !== "completed")
    throw new QualityContractError("QUALITY_REPORT_UNAVAILABLE");
  const head = headRow as unknown as QualityHead, work = readWork(row);
  if (work.project_id !== projectId || work.protocol_id !== protocolId || head.project_id !== projectId || head.protocol_id !== protocolId || work.generation !== row.processed_generation || work.generation !== row.claimed_generation || row.evaluation_record_id !== head.evaluation_record_id)
    throw new QualityContractError("QUALITY_REPORT_COHORT_MISMATCH");
  const evaluation = validateQualityRecord((await loadQualityRecord(projectId, protocolId, QualityUuidSchema.parse(row.evaluation_record_id), tx)).row);
  if (evaluation.kind !== "evaluation" || evaluation.subject_record_id !== work.dataset_record_id || evaluation.actor_type !== "internal" || evaluation.actor_name !== "finding-quality-worker")
    throw new QualityContractError("QUALITY_REPORT_EVALUATION_MISMATCH");
  const e = evaluation as QualityReceipt<"evaluation">, input = await reportInput(tx, head, work, true);
  const binding = { run_id: input.state.run_id, dataset_id: work.dataset_record_id, protocol_id: protocolId, protocol_digest: String(input.protocol.row.protocol_digest), scope: input.protocol.body.scope, evaluated_at: e.body.binding.evaluated_at };
  if (qualityDigest(binding) !== qualityDigest(e.body.binding) || Date.parse(binding.evaluated_at) < Date.parse(input.admission.created_at) || Date.parse(binding.evaluated_at) > Date.parse(e.created_at))
    throw new QualityContractError("QUALITY_REPORT_BINDING_MISMATCH");
  const report = computeQualityMetrics({ binding, dataset: input.dataset, selections: input.observations.map(o => o.selection), decisions: input.observations.flatMap(o => o.decisions) });
  if (report.report_digest !== e.body.report_digest)
    throw new QualityContractError("QUALITY_REPORT_DIGEST_MISMATCH");
  return { quality_status: "not_evaluated" as const, generation: work.generation, source_validation: "repeatable_read_mvcc_snapshot" as const, report };
}
/** Stop synchronously forbids new ticks and returns this worker's owned in-flight drain. */
export function startFindingQualityWorker(db: Db = qualitySql): () => Promise<void> {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped)
      return;
    pending = processFindingQualityWork(db).then(() => undefined).catch(() => {
      // SQL unavailability leaves the existing checkpoint intact.
    }).then(() => {
      if (!stopped) {
        timer = setTimeout(tick, 2000);
        timer.unref();
      }
    });
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    return pending;
  };
}
