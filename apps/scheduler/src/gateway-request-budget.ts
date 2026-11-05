import { sql } from "./db.js";
import { RepairTokenBudgetError } from "./domains/event-ingestion/repair-token-budget.js";

/** Zero/absent means unlimited, never permission to remove an older finite cap. */
export function finiteRequestCap(values: Array<number | null | undefined>): number {
  const finite = values.filter((value): value is number => value != null && value > 0);
  return finite.length > 0 ? Math.min(...finite) : 0;
}

type RequestPlan = { total_requests: number; main_requests: number; background_requests: number };

/** Shared by advisory allowance and authoritative admission. */
export function resolveRequestBudget(rows: readonly Record<string, unknown>[], workload: string, plan?: RequestPlan | null) {
  let totalUsed = 0, workloadUsed = 0;
  const totals: number[] = [], workloads: number[] = [];
  for (const row of rows) {
    const used = Number(row.used_requests), cap = Number(row.max_requests), total = Number(row.request_total_limit);
    if (![used, cap, total].every((n) => Number.isSafeInteger(n) && n >= 0)
      || cap > 1_000_000 || total > 1_000_000) {
      throw new RepairTokenBudgetError("JOB_REQUEST_USAGE_UNKNOWN", "Job request history requires reconciliation");
    }
    totalUsed += used;
    totals.push(total);
    if (row.workload === workload) { workloadUsed += used; workloads.push(cap); }
  }
  if (!Number.isSafeInteger(totalUsed) || !Number.isSafeInteger(workloadUsed)) {
    throw new RepairTokenBudgetError("JOB_REQUEST_USAGE_UNKNOWN", "Job request history requires reconciliation");
  }
  const totalLimit = finiteRequestCap([...totals, plan?.total_requests]);
  const workloadLimit = finiteRequestCap([...workloads,
    plan ? workload === "main" ? plan.main_requests : plan.background_requests : 0]);
  return { totalUsed, workloadUsed, totalLimit, workloadLimit,
    exhausted: (totalLimit > 0 && totalUsed >= totalLimit) || (workloadLimit > 0 && workloadUsed >= workloadLimit) };
}

/** Caller holds the Job lock. Expired/revoked generations remain authoritative. */
export async function readHistoricalRequestBudget(db: typeof sql, jobId: string, workload: string, plan?: RequestPlan | null) {
  const rows = await db`SELECT workload, used_requests, max_requests, request_total_limit
    FROM job_tokens WHERE job_id=${jobId} ORDER BY id FOR UPDATE`;
  return resolveRequestBudget(rows, workload, plan);
}
