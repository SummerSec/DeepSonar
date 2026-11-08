import type { MigrationConnection } from "../../migration-runner.js";
import {
  classifyEffect,
  summarizeEvidence,
  type EffectClassification,
  type EffectEvidence,
  type ReconcileSummary,
} from "./reconcile-effects.js";

export const RECONCILE_ACTIONS = ["scan", "apply"] as const;

/**
 * Operator settlement (#899).
 *
 * An effect can be permanently undecidable from platform evidence and still block a
 * cross-schema upgrade forever — the reported host had one `agent_run` on an
 * `interrupted` attempt doing exactly that. Replaying it is forbidden, so the only
 * honest exit is a human supplying the missing fact once, with an audit trail. This is
 * deliberately NOT a bulk action and NOT automatic: it settles one effect id, requires a
 * written reason, records `reconciled_by=operator-settlement` plus the evidence
 * reference, and never touches `replay_policy`.
 */
export const OPERATOR_SETTLE_OUTCOMES = ["not_applied", "applied_run_terminated", "delivered"] as const;
export type OperatorSettleOutcome = (typeof OPERATOR_SETTLE_OUTCOMES)[number];

export interface OperatorSettleInput {
  readonly effect_id: string;
  readonly outcome: OperatorSettleOutcome;
  /** Why the operator can assert this outcome; stored verbatim for audit. */
  readonly evidence: string;
  readonly operation_id: string;
}
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

export interface ReconcileRequest {
  readonly action: ReconcileAction;
  /** Stable id recorded on every touched row for audit and idempotency review. */
  readonly operation_id: string;
  /** Bounded batch so a huge backlog cannot hold one statement forever. */
  readonly limit?: number;
}

export const DEFAULT_RECONCILE_LIMIT = 5_000;

/**
 * Evidence query. Deliberately joins the facts that each rule needs, so classification
 * never depends on a second round trip that could observe a different world.
 */
const EVIDENCE_QUERY = (limit: number) => `
SELECT e.id::text AS id,
       e.effect_kind,
       a.status AS attempt_status,
       coalesce(j.sandbox_id, a.sandbox_id) AS sandbox_id,
       (SELECT count(*)::int FROM job_usage_ledger l WHERE l.attempt_id = e.attempt_id AND l.effect_id = e.effect_id) AS usage_rows,
       (SELECT n.id::text FROM canvas_nodes n WHERE n.job_id = e.job_id ORDER BY n.id LIMIT 1) AS canvas_node_id
FROM job_attempt_effects e
JOIN job_attempts a ON a.id = e.attempt_id
JOIN jobs j ON j.id = e.job_id
WHERE e.status IN ('unknown', 'effect_pending')
  -- An active Attempt may be mid-flight: the dispatcher commits the provision intent
  -- before runner.provision and binds the sandbox afterwards, so settling it here
  -- would fabricate evidence for a resource that is still being created (#874).
  AND a.status <> 'active'
ORDER BY e.effect_kind, e.created_at, e.id
LIMIT ${limit}`;

interface EvidenceRow {
  id: string;
  effect_kind: string;
  attempt_status: string | null;
  sandbox_id: string | null;
  usage_rows: number | string | null;
  canvas_node_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Quote a JSON literal for inlining; the payload is built here, never user input. */
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Quote a validated uuid[] literal. Any non-uuid id is refused rather than escaped. */
function quoteUuidArray(ids: readonly string[]): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error("INVALID_EFFECT_ID");
  }
  return `ARRAY[${ids.map((id) => `'${id}'`).join(",")}]`;
}

const toEvidence = (row: EvidenceRow): EffectEvidence => ({
  id: String(row.id),
  effectKind: String(row.effect_kind),
  attemptStatus: row.attempt_status === null || row.attempt_status === undefined ? null : String(row.attempt_status),
  sandboxId: row.sandbox_id === null || row.sandbox_id === undefined ? null : String(row.sandbox_id),
  usageRows: Number(row.usage_rows ?? 0),
  canvasNodeId: row.canvas_node_id === null || row.canvas_node_id === undefined ? null : String(row.canvas_node_id),
});

export interface ReconcileResult {
  readonly ok: boolean;
  readonly action: ReconcileAction;
  readonly applied: number;
  readonly remaining_unknown: number;
  readonly summary: ReconcileSummary;
}

/**
 * Classify the current unknown/effect_pending backlog.
 *
 * Read-only by construction: `scan` never writes, and it is the default action so an
 * operator sees the residue before any settlement happens.
 */
export async function scanUnknownEffects(db: MigrationConnection, limit = DEFAULT_RECONCILE_LIMIT) {
  // SAFETY: the projection above fixes every column name and type; postgres returns
  // exactly one row object per unknown effect, and toEvidence() re-validates each field.
  const rows = (await db.unsafe(EVIDENCE_QUERY(limit))) as EvidenceRow[];
  const effects = rows.map(toEvidence);
  return { effects, summary: summarizeEvidence(effects) };
}

/**
 * Settle the provable effects and report the residue.
 *
 * Idempotency and safety:
 *   - one UPDATE per classification group, each restricted to rows still in
 *     `unknown`/`effect_pending` — a concurrent kernel settlement always wins and the
 *     statement simply matches zero rows on a re-run;
 *   - every written row records `reconciled_by` and `reconcile_operation_id`;
 *   - undecided effects are never touched, so their `unknown` status keeps blocking
 *     the upgrade until a human supplies the missing evidence.
 */
/**
 * Job-scoped reconciliation (#874 P1-4).
 *
 * The Reaper used to fail a `waiting_human` Job for "human timeout" even when the
 * reason it never completed was an unreconciled platform effect. Before that verdict
 * the caller reconciles this Job's effects: whatever the evidence proves is settled
 * here, and the caller reports the residue explicitly instead of treating it as a
 * human problem.
 *
 * Semantics match the global runner: only `auto` classifications are settled, the
 * status guard keeps a concurrent kernel settlement authoritative, and nothing is
 * replayed.
 */
export async function reconcileJobEffects(
  db: MigrationConnection,
  jobId: string,
  operationId: string,
): Promise<{ applied: number; remaining: number; remainingKinds: string[] }> {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) throw new Error("INVALID_RECONCILE_OPERATION_ID");
  const rows = (await db.unsafe(JOB_EVIDENCE_QUERY(quoteLiteral(jobId)))) as EvidenceRow[];
  const effects = rows.map(toEvidence);
  const groups = new Map<string, { ids: string[]; classification: Extract<EffectClassification, { decision: "auto" }> }>();
  const undecided: EffectEvidence[] = [];
  for (const effect of effects) {
    const classification = classifyEffect(effect);
    if (classification.decision !== "auto") {
      undecided.push(effect);
      continue;
    }
    const key = JSON.stringify(classification.settlement);
    const existing = groups.get(key);
    if (existing) existing.ids.push(effect.id);
    else groups.set(key, { ids: [effect.id], classification });
  }
  let applied = 0;
  for (const { ids, classification } of groups.values()) {
    const payload = JSON.stringify({ ...classification.settlement, reconciled_by: "reaper-pre-timeout", reconcile_operation_id: operationId });
    const settled = (await db.unsafe(
      `UPDATE job_attempt_effects
          SET status = 'settled',
              settlement_json = settlement_json || ${quoteLiteral(payload)}::jsonb,
              settled_at = now(),
              updated_at = now()
        WHERE id = ANY(${quoteUuidArray(ids)}::uuid[])
          AND status IN ('unknown', 'effect_pending')
        RETURNING id`,
    )) as { id: string }[];
    applied += settled.length;
  }
  return {
    applied,
    remaining: undecided.length,
    remainingKinds: [...new Set(undecided.map((effect) => effect.effectKind))].sort(),
  };
}

const JOB_EVIDENCE_QUERY = (quotedJobId: string) => `
SELECT e.id::text AS id,
       e.effect_kind,
       a.status AS attempt_status,
       coalesce(j.sandbox_id, a.sandbox_id) AS sandbox_id,
       (SELECT count(*)::int FROM job_usage_ledger l WHERE l.attempt_id = e.attempt_id AND l.effect_id = e.effect_id) AS usage_rows,
       (SELECT n.id::text FROM canvas_nodes n WHERE n.job_id = e.job_id ORDER BY n.id LIMIT 1) AS canvas_node_id
FROM job_attempt_effects e
JOIN job_attempts a ON a.id = e.attempt_id
JOIN jobs j ON j.id = e.job_id
WHERE e.job_id = ${quotedJobId}::uuid AND e.status IN ('unknown', 'effect_pending')
  AND a.status <> 'active'
ORDER BY e.created_at, e.id`;

/**
 * Settle one effect from operator-supplied evidence. Returns `false` when the row is no
 * longer pending (a concurrent settlement already happened), so a retry is safe.
 */
export async function settleEffectByOperator(
  db: MigrationConnection,
  input: OperatorSettleInput,
  actor?: { type: string; id: string | null; name: string },
): Promise<{ settled: boolean; effect_id: string; outcome: OperatorSettleOutcome }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.effect_id)) {
    throw new Error("INVALID_EFFECT_ID");
  }
  if (!OPERATOR_SETTLE_OUTCOMES.includes(input.outcome)) throw new Error("INVALID_SETTLE_OUTCOME");
  if (typeof input.evidence !== "string" || input.evidence.trim().length < 8 || input.evidence.length > 512) {
    throw new Error("INVALID_SETTLE_EVIDENCE");
  }
  if (typeof input.operation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operation_id)) {
    throw new Error("INVALID_RECONCILE_OPERATION_ID");
  }
  const payload = JSON.stringify({
    outcome: input.outcome,
    reconciled_by: "operator-settlement",
    reconcile_operation_id: input.operation_id,
    operator_evidence: input.evidence.trim(),
    ...(actor ? { operator_actor: actor } : {}),
  });
  // #908 review P1: an effect belonging to a still-active attempt must never be settled
  // from the outside — the kernel still owns that outcome, and settling it would pre-empt
  // the normal settlement path.
  const rows = (await db.unsafe(
    `UPDATE job_attempt_effects e
        SET status = 'settled',
            settlement_json = e.settlement_json || ${quoteLiteral(payload)}::jsonb,
            evidence_ref = ${quoteLiteral(`operator:${input.operation_id}`)},
            settled_at = now(),
            updated_at = now()
      WHERE e.id = ${quoteLiteral(input.effect_id)}::uuid
        AND e.status IN ('unknown', 'effect_pending')
        AND NOT EXISTS (
          SELECT 1 FROM job_attempts a WHERE a.id = e.attempt_id AND a.status = 'active'
        )
      RETURNING e.id`,
  )) as { id: string }[];
  return { settled: rows.length > 0, effect_id: input.effect_id, outcome: input.outcome };
}

/** Count of effects the kernel still considers unreconciled. */
export async function countUnsettledEffects(db: MigrationConnection): Promise<number> {
  const rows = (await db.unsafe(
    `SELECT count(*)::int AS count FROM job_attempt_effects WHERE status IN ('unknown', 'effect_pending')`,
  )) as { count: number }[];
  const count = Number(rows[0]?.count);
  if (rows.length !== 1 || !Number.isSafeInteger(count) || count < 0 || rows[0]?.count == null) {
    throw new Error("INVALID_UNSETTLED_EFFECT_COUNT");
  }
  return count;
}

export async function runEffectReconcile(db: MigrationConnection, input: ReconcileRequest): Promise<ReconcileResult> {
  if (!RECONCILE_ACTIONS.includes(input.action)) throw new Error("INVALID_RECONCILE_ACTION");
  if (typeof input.operation_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operation_id)) throw new Error("INVALID_RECONCILE_OPERATION_ID");
  const limit = input.limit ?? DEFAULT_RECONCILE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_RECONCILE_LIMIT) throw new Error("INVALID_RECONCILE_LIMIT");

  const { effects, summary } = await scanUnknownEffects(db, limit);
  if (input.action === "scan") {
    return { ok: summary.undecided_count === 0, action: "scan", applied: 0, remaining_unknown: summary.unknown_total, summary };
  }

  const groups = new Map<string, { ids: string[]; classification: Extract<EffectClassification, { decision: "auto" }> }>();
  for (const effect of effects) {
    const classification = classifyEffect(effect);
    if (classification.decision !== "auto") continue;
    const key = JSON.stringify(classification.settlement);
    const existing = groups.get(key);
    if (existing) existing.ids.push(effect.id);
    else groups.set(key, { ids: [effect.id], classification });
  }

  let applied = 0;
  for (const { ids, classification } of groups.values()) {
    const payload = JSON.stringify({ ...classification.settlement, reconciled_by: "reconcile-effects", reconcile_operation_id: input.operation_id });
      // SAFETY: the statement returns only `id` for rows it actually settled, and the
    // caller counts that number; no other column is read back.
    const rows = (await db.unsafe(
      `UPDATE job_attempt_effects
          SET status = 'settled',
              settlement_json = settlement_json || ${quoteLiteral(payload)}::jsonb,
              settled_at = now(),
              updated_at = now()
        WHERE id = ANY(${quoteUuidArray(ids)}::uuid[])
          AND status IN ('unknown', 'effect_pending')
        RETURNING id`,
    )) as { id: string }[];
    applied += rows.length;
  }

  const remaining = await scanUnknownEffects(db, limit);
  return {
    ok: remaining.summary.undecided_count === 0,
    action: "apply",
    applied,
    remaining_unknown: remaining.summary.unknown_total,
    summary: remaining.summary,
  };
}