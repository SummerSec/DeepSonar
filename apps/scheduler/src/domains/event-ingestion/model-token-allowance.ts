import { sql } from "../../db.js";
import type { GatewayWorkload } from "../../gateway-om-budget.js";
import { observationalMemoryConfig, parseFrozenPiExtensions } from "../../pi-extensions.js";
import { readJobTokenAllowance, RepairTokenBudgetError, type RepairTokenBudget } from "./repair-token-budget.js";

/** Repair token accounting is Job-wide for legacy Jobs.  OM Jobs keep the
 * existing repair cap on the main workload only, so background usage cannot
 * consume the main repair reserve. */
export async function readWorkloadTokenAllowance(
  db: typeof sql,
  jobId: string,
  workload: GatewayWorkload,
  budget?: RepairTokenBudget | null,
): Promise<number | null> {
  const [totalLimit] = await db`
    SELECT MIN(NULLIF(COALESCE(workload_max_tokens, max_tokens), 0)) AS cap
    FROM job_tokens
    WHERE job_id = ${jobId} AND workload = ${workload}`;
  const [usage] = await db`
    SELECT COALESCE(SUM(l.total_tokens) FILTER (WHERE l.settlement_status='settled'),0) AS total,
           COUNT(*) FILTER (WHERE e.status='effect_pending' AND l.id IS NULL) AS pending,
           COUNT(*) FILTER (WHERE (e.status <> 'settled' OR l.settlement_status IS DISTINCT FROM 'settled')
             AND NOT (e.status='effect_pending' AND l.id IS NULL)) AS unresolved
    FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
      AND COALESCE(l.workload, e.intent_json->>'workload', 'main') = ${workload}`;
  const total = Number(usage.total), cap = Number(totalLimit.cap), unresolved = Number(usage.unresolved);
  const pending = Number(usage.pending);
  if (unresolved < 0 || !Number.isSafeInteger(unresolved)
    || pending < 0 || !Number.isSafeInteger(pending)
    || (unresolved > 0 && (workload === "observational_memory" || totalLimit.cap != null))
    || total < 0 || !Number.isSafeInteger(total)
    || (totalLimit.cap != null && (cap < 0 || !Number.isSafeInteger(cap)))) {
    throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_UNKNOWN", "Job token usage requires reconciliation", budget ?? undefined);
  }
  if (pending > 0 && (workload === "observational_memory" || totalLimit.cap != null)) {
    throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_PENDING", "Job token allowance is reserved by an unsettled request", budget ?? undefined);
  }
  if (totalLimit?.cap == null) return null;
  if (total >= cap) throw new RepairTokenBudgetError("JOB_TOKEN_EXHAUSTED", "Job token allowance exhausted", budget ?? undefined);
  return cap - total;
}

/** Keep an existing Job's workload accounting scope even if rerun-current removes OM.
 * Caller holds the Job lock. Historical token rows are never discarded on rotation. */
export async function readMainTokenAllowance(db: typeof sql, jobId: string, snapshot: unknown,
  budget?: RepairTokenBudget | null): Promise<number | null> {
  const frozen = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : {};
  const om = observationalMemoryConfig(parseFrozenPiExtensions(frozen.pi_extensions));
  const [historicalOm] = om ? [] : await db`SELECT id FROM job_tokens
    WHERE job_id=${jobId} AND workload='observational_memory' LIMIT 1`;
  return om || historicalOm
    ? readWorkloadTokenAllowance(db, jobId, "main", budget)
    : readJobTokenAllowance(db, jobId, budget ?? undefined);
}
