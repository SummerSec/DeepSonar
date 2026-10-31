import { config } from "../../config.js";
import { sql } from "../../db.js";

export type RepairTokenBudget = {
  receipt_ref: string;
  attempt_id: string;
  limit_tokens: number | null;
  known_tokens: number;
  remaining_tokens: number | null;
  usage_status: "known" | "pending" | "unknown";
};

/** Freeze 0 as unlimited; historical null/missing receipts retain their closed policy. */
export function configuredRepairTokenLimit(): number | null {
  const value = config.gateway.repairMaxTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Caller holds the Job lock. Costs are a projection of the existing ledger, never a second balance. */
export async function readRepairTokenBudget(db: typeof sql, jobId: string): Promise<RepairTokenBudget | null> {
  const [first] = await db`SELECT event_id,payload_json FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'
    AND payload_json->>'status'='rejected' ORDER BY job_seq LIMIT 1`;
  if (!first) return null;
  const limit = first.payload_json.repair_token_limit;
  const rows = await db`SELECT e.status,l.settlement_status,l.total_tokens FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
    AND e.intent_json->>'repair_receipt_ref'=${String(first.event_id)}`;
  let known = 0;
  let state: RepairTokenBudget["usage_status"] = "known";
  for (const row of rows) {
    if (row.status === "effect_pending" && row.settlement_status == null) {
      if (state !== "unknown") state = "pending";
    } else if (row.status !== "settled" || row.settlement_status !== "settled") state = "unknown";
    if (row.settlement_status === "settled") {
      const count = Number(row.total_tokens);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(known + count)) state = "unknown";
      else known += count;
    }
  }
  const cap = Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
  return { receipt_ref: String(first.event_id), attempt_id: String(first.payload_json.attempt_id), limit_tokens: cap, known_tokens: known,
    remaining_tokens: state === "known" && cap !== null && cap > 0 ? Math.max(0, cap - known) : null, usage_status: state };
}

export class RepairTokenBudgetError extends Error {
  constructor(readonly code: string, message: string, readonly budget?: RepairTokenBudget) { super(message); }
}

/** Bound generated output as well as admission. Input/cache cost is known only after the response. */
export function boundRepairOutput(body: unknown, path: string, remaining: number | null): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw new RepairTokenBudgetError("REPAIR_PROTOCOL_UNSUPPORTED", "Repair requires a supported JSON model request");
  }
  const normalized = path.replace(/^\/?(?:v1\/)?/u, "");
  const field = normalized === "messages" || normalized === "completions" ? "max_tokens"
    : normalized === "chat/completions" ? "max_completion_tokens" : normalized === "responses" ? "max_output_tokens" : null;
  if (!field) throw new RepairTokenBudgetError("REPAIR_PROTOCOL_UNSUPPORTED", "Repair usage is unsupported for this upstream protocol");
  const input = body as Record<string, unknown>;
  if ((input.n !== undefined && input.n !== 1) || (input.best_of !== undefined && input.best_of !== 1)
    || (normalized === "completions" && typeof input.prompt !== "string")) {
    throw new RepairTokenBudgetError("REPAIR_PROTOCOL_UNSUPPORTED", "Repair supports one completion and no batch or best-of generation");
  }
  const cap = (value: unknown): number | undefined => {
    if (value === undefined) return remaining ?? undefined;
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new RepairTokenBudgetError("REPAIR_PROTOCOL_UNSUPPORTED", "Repair output limit must be a positive integer");
    }
    return remaining === null ? Number(value) : Math.min(Number(value), remaining);
  };
  const output: Record<string, unknown> = { ...input };
  const outputCap = cap(input[field]);
  if (outputCap !== undefined) output[field] = outputCap;
  if (normalized === "chat/completions") {
    if ("max_tokens" in output) {
      const legacyCap = cap(input.max_tokens);
      output.max_tokens = outputCap === undefined ? legacyCap : Math.min(legacyCap!, outputCap);
      delete output.max_completion_tokens;
    }
    // Provider-generated terminal usage is required; model/tool contents never substitute for it.
    if (output.stream === true) output.stream_options = { ...(typeof input.stream_options === "object" && input.stream_options ? input.stream_options : {}), include_usage: true };
  }
  return output;
}

/** Pending effects reserve the entire remaining allowance until authoritative settlement. */
export function assertRepairTokenBudget(budget: RepairTokenBudget | null, newRequest: boolean): void {
  if (!budget) return;
  if (budget.usage_status !== "known") throw new RepairTokenBudgetError(
    budget.usage_status === "pending" ? "REPAIR_USAGE_PENDING" : "REPAIR_USAGE_UNKNOWN",
    "Repair usage is not settled; reconcile the existing request before continuing", budget);
  if (newRequest && budget.limit_tokens === null) throw new RepairTokenBudgetError(
    "REPAIR_TOKEN_LIMIT_UNCONFIGURED", "The frozen repair policy does not permit model requests", budget);
  if (budget.remaining_tokens === 0) throw new RepairTokenBudgetError(
    "REPAIR_TOKEN_EXHAUSTED", "Repair token allowance exhausted; stop and request human intervention", budget);
}

/** The Job lock also serializes admission against the first rejection and terminal acceptance. */
export async function admitGatewayRepair(db: typeof sql, jobId: string, attemptId: string): Promise<RepairTokenBudget | null> {
  const [job] = await db`SELECT status,lease_expires_at>clock_timestamp() AS leased,
    started_at+timeout_sec*interval '1 second'>clock_timestamp() AS within_time
    FROM jobs WHERE id=${jobId} FOR UPDATE`;
  const budget = await readRepairTokenBudget(db, jobId);
  if (!budget) return null;
  if (budget.attempt_id !== attemptId) throw new RepairTokenBudgetError(
    "REPAIR_ATTEMPT_CHANGED", "Another Attempt cannot resume the original repair session", budget);
  const [attempt] = await db`SELECT id FROM job_attempts WHERE id=${attemptId} AND job_id=${jobId}
    AND status='active' AND NOT cancel_requested FOR UPDATE`;
  if (!job || job.status !== "running" || !job.leased || !job.within_time || !attempt) {
    throw new RepairTokenBudgetError("REPAIR_JOB_INACTIVE", "Repair requires an active Job, Attempt, lease and time budget", budget);
  }
  const [accepted] = await db`SELECT event_id FROM events WHERE job_id=${jobId} AND type='control_receipt'
    AND payload_json->>'operation'='mark_job_done' AND payload_json->>'status'='persisted_deferred' LIMIT 1`;
  if (accepted) throw new RepairTokenBudgetError("COMPLETION_ALREADY_ACCEPTED", "Completion already accepted; reconcile its receipt", budget);
  assertRepairTokenBudget(budget, true);
  return budget;
}

/** Caller holds the Job lock; an explicit total ceiling covers every model request and token rotation. */
export async function readJobTokenAllowance(db: typeof sql, jobId: string, budget?: RepairTokenBudget): Promise<number | null> {
  const [totalLimit] = await db`SELECT MIN(max_tokens) AS cap FROM job_tokens WHERE job_id=${jobId} AND max_tokens IS NOT NULL`;
  if (totalLimit?.cap != null) {
    const [usage] = await db`SELECT COALESCE(SUM(l.total_tokens) FILTER (WHERE l.settlement_status='settled'),0) AS total,
      COUNT(*) FILTER (WHERE e.status<>'settled' OR l.settlement_status IS DISTINCT FROM 'settled') AS unresolved
      FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
      WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'`;
    const total = Number(usage.total), cap = Number(totalLimit.cap);
    if (Number(usage.unresolved) > 0 || !Number.isSafeInteger(total) || !Number.isSafeInteger(cap)) {
      throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_UNKNOWN", "Job token usage requires reconciliation", budget);
    }
    if (total >= cap) throw new RepairTokenBudgetError("JOB_TOKEN_EXHAUSTED", "Job token allowance exhausted", budget);
    return cap - total;
  }
  return null;
}
