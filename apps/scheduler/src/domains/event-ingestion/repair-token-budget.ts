import { config } from "../../config.js";
import { sql } from "../../db.js";
import { readRepairGenerationOwner } from "../job-attempt/repair-generation.js";

export type RepairTokenBudget = {
  receipt_ref: string;
  attempt_id: string;
  limit_tokens: number | null;
  generation_ref?: string | null;
  deadline?: string | null;
  known_tokens: number;
  remaining_tokens: number | null;
  usage_status: "known" | "pending" | "unknown";
};

/** Freeze 0 as unlimited; historical null/missing receipts retain their closed policy. */
export function configuredRepairTokenLimit(): number | null {
  const value = config.gateway.repairMaxTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type BudgetReceipt = { event_id: string; payload_json: RepairReceiptPayload };
/** Only the fields this projection reads; the rest of the receipt is not our contract. */
type RepairReceiptPayload = {
  repair_token_limit?: number | null;
  execution_deadline?: string | null;
  attempt_id?: string;
};
type BudgetUsageRow = { status: string; settlement_status: string | null; total_tokens: unknown };
type BudgetOwner = { attempt_id: string | null; generation_ref: string | null; deadline: string | null };

/** Single composition point so the batch and single reads cannot drift apart. */
function composeRepairTokenBudget(
  receipt: BudgetReceipt,
  usageRows: readonly BudgetUsageRow[],
  owner: BudgetOwner,
): RepairTokenBudget {
  const payload: RepairReceiptPayload = receipt.payload_json;
  const limit = payload.repair_token_limit;
  let known = 0;
  let state: RepairTokenBudget["usage_status"] = "known";
  for (const row of usageRows) {
    if (row.status === "effect_pending" && row.settlement_status == null) {
      if (state !== "unknown") state = "pending";
    } else if (row.status !== "settled" || row.settlement_status !== "settled") state = "unknown";
    if (row.settlement_status === "settled") {
      const count = Number(row.total_tokens);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(known + count)) state = "unknown";
      else known += count;
    }
  }
  const cap = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? limit : null;
  return { receipt_ref: String(receipt.event_id), attempt_id: owner.attempt_id ?? "",
    generation_ref: owner.generation_ref, deadline: owner.deadline ?? payload.execution_deadline ?? null, limit_tokens: cap, known_tokens: known,
    remaining_tokens: state === "known" && cap !== null && cap > 0 ? Math.max(0, cap - known) : null, usage_status: state };
}

/** Caller holds the Job lock. Costs are a projection of the existing ledger, never a second balance. */
export async function readRepairTokenBudget(db: typeof sql, jobId: string): Promise<RepairTokenBudget | null> {
  const [first] = await db<BudgetReceipt[]>`SELECT event_id,payload_json FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'
    AND payload_json->>'status'='rejected' ORDER BY job_seq LIMIT 1`;
  if (!first) return null;
  const rows = await db<BudgetUsageRow[]>`SELECT e.status,l.settlement_status,l.total_tokens FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
    AND e.intent_json->>'repair_receipt_ref'=${String(first.event_id)}`;
  const owner = await readRepairGenerationOwner(db, jobId, String(first.payload_json.attempt_id));
  return composeRepairTokenBudget(first, rows, owner);
}

/**
 * Batch projection for read-only list surfaces: same figures as the single read, in
 * three queries instead of three per Job. Jobs without a rejected completion receipt
 * are absent from the map, exactly like the single read returning null.
 */
export async function readRepairTokenBudgets(db: typeof sql, jobIds: readonly string[]): Promise<Map<string, RepairTokenBudget>> {
  const ids = [...new Set(jobIds)];
  const budgets = new Map<string, RepairTokenBudget>();
  if (!ids.length) return budgets;
  const firsts = await db<Array<BudgetReceipt & { job_id: string }>>`SELECT DISTINCT ON (job_id)
      job_id::text AS job_id, event_id, payload_json FROM events
    WHERE job_id = ANY(${ids}::uuid[]) AND type='control_receipt'
      AND payload_json->>'operation'='mark_job_done' AND payload_json->>'status'='rejected'
    ORDER BY job_id, job_seq`;
  if (!firsts.length) return budgets;
  const receiptRefs = firsts.map((row) => String(row.event_id));
  const usages = await db<Array<BudgetUsageRow & { job_id: string; receipt_ref: string }>>`SELECT
      e.job_id::text AS job_id, e.intent_json->>'repair_receipt_ref' AS receipt_ref,
      e.status, l.settlement_status, l.total_tokens FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id = ANY(${ids}::uuid[]) AND e.effect_kind='gateway_model_request'
      AND e.intent_json->>'repair_receipt_ref' = ANY(${receiptRefs}::text[])`;
  const owners = await db<Array<{ job_id: string; attempt_id: string | null; generation_ref: string; deadline: string }>>`
    SELECT DISTINCT ON (e.job_id) e.job_id::text AS job_id, a.id AS attempt_id, e.event_id AS generation_ref,
      e.payload_json->>'deadline' AS deadline FROM events e
    LEFT JOIN job_attempts a ON a.job_id=e.job_id
      AND a.attempt_no=(e.payload_json->>'target_attempt_no')::int
    WHERE e.job_id = ANY(${ids}::uuid[]) AND e.type='control_receipt'
      AND e.payload_json->>'authority'='scheduler' AND e.payload_json->>'subtype'='repair_generation'
    ORDER BY e.job_id, e.job_seq DESC`;
  const ownerByJob = new Map(owners.map((row) => [String(row.job_id), row] as const));
  for (const receipt of firsts) {
    const jobId = String(receipt.job_id);
    const ownerRow = ownerByJob.get(jobId);
    const owner: BudgetOwner = ownerRow
      ? { attempt_id: ownerRow.attempt_id ? String(ownerRow.attempt_id) : null,
          generation_ref: String(ownerRow.generation_ref), deadline: String(ownerRow.deadline) }
      : { attempt_id: String(receipt.payload_json.attempt_id ?? ""), generation_ref: null, deadline: null };
    const receiptRef = String(receipt.event_id);
    const usageRows = usages.filter((row) => row.receipt_ref === receiptRef).map((row) => row);
    budgets.set(jobId, composeRepairTokenBudget(receipt, usageRows, owner));
  }
  return budgets;
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
  if (budget.deadline && Date.parse(budget.deadline) <= Date.now()) throw new RepairTokenBudgetError(
    "REPAIR_DEADLINE_EXHAUSTED", "Original completion repair deadline exhausted; stop this execution", budget);
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
      COUNT(*) FILTER (WHERE e.status='effect_pending' AND l.id IS NULL) AS pending,
      COUNT(*) FILTER (WHERE (e.status<>'settled' OR l.settlement_status IS DISTINCT FROM 'settled')
        AND NOT (e.status='effect_pending' AND l.id IS NULL)) AS unresolved
      FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
      WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'`;
    const total = Number(usage.total), cap = Number(totalLimit.cap);
    if (Number(usage.unresolved) > 0 || !Number.isSafeInteger(total) || !Number.isSafeInteger(cap)) {
      throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_UNKNOWN", "Job token usage requires reconciliation", budget);
    }
    if (Number(usage.pending) > 0) throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_PENDING", "Job token allowance is reserved by an unsettled request", budget);
    if (total >= cap) throw new RepairTokenBudgetError("JOB_TOKEN_EXHAUSTED", "Job token allowance exhausted", budget);
    return cap - total;
  }
  return null;
}

/** Before starting a successor runner; settlement paths must remain available after expiry. */
export async function assertRepairExecutionOwner(db: typeof sql, jobId: string, attemptId: string): Promise<void> {
  const budget = await readRepairTokenBudget(db, jobId);
  if (!budget) return;
  if (budget.attempt_id !== attemptId) throw new RepairTokenBudgetError("REPAIR_ATTEMPT_CHANGED", "No Scheduler generation authorizes this execution", budget);
  assertRepairTokenBudget(budget, true);
}
