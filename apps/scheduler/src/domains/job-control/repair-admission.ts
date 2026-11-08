import { readMainTokenAllowance } from "../event-ingestion/model-token-allowance.js";
import { sql } from "../../db.js";
import { readRepairTokenBudget, assertRepairTokenBudget, RepairTokenBudgetError } from "../event-ingestion/repair-token-budget.js";
import { COMPLETION_REPAIR_LIMIT } from "../event-ingestion/completion-receipt.js";
import { canvasExecutionIsPaused } from "../../task-execution-control.js";

/** Read-only preflight under Canvas -> Job locks. Unknown old effects never become safe by interruption. */
export async function readRepairRequeueAdmission(db: typeof sql, jobId: string) {
  const budget = await readRepairTokenBudget(db, jobId);
  const deny = (code: string, reason: string) => ({ budget, deadline: null, blocker: { code, reason } });
  const [job] = await db`SELECT j.started_at,j.timeout_sec,j.agent_snapshot_json,c.target_json FROM jobs j
    LEFT JOIN canvases c ON c.id=j.canvas_id WHERE j.id=${jobId}`;
  if (canvasExecutionIsPaused(job?.target_json)) return deny("REPAIR_PAUSED", "任务已暂停；恢复修复前需由操作员解除暂停。");
  // Job-wide gate is intentional: an unknown or foreign effect must never become
  // safe just because one human wait was interrupted. Only make the refusal
  // diagnosable; do not narrow the WHERE clause to a single attempt or effect kind.
  const [unresolved] = await db`SELECT id,attempt_id,effect_id,effect_kind,status
    FROM job_attempt_effects WHERE job_id=${jobId} AND status<>'settled' ORDER BY id LIMIT 1`;
  if (unresolved) {
    const effect = `${String(unresolved.effect_kind ?? "unknown")}:${String(unresolved.effect_id ?? "unknown")} (status=${String(unresolved.status ?? "unknown")})`.slice(0, 160);
    return deny("REPAIR_EFFECT_UNRESOLVED", `旧执行仍有未结算或未知效果（${effect}）；先对账并确认旧执行退出，不能创建新修复代际。`);
  }
  const [requests] = await db`SELECT COALESCE(SUM(used_requests),0) AS used,
    COALESCE(SUM(used_requests) FILTER (WHERE workload='main'),0) AS main_used,
    MIN(request_total_limit) FILTER (WHERE request_total_limit>0) AS total_cap,
    MIN(max_requests) FILTER (WHERE workload='main' AND max_requests>0) AS main_cap
    FROM job_tokens WHERE job_id=${jobId}`;
  if (!Number.isSafeInteger(Number(requests.used)) || !Number.isSafeInteger(Number(requests.main_used))
    || (requests.total_cap != null && Number(requests.used) >= Number(requests.total_cap))
    || (requests.main_cap != null && Number(requests.main_used) >= Number(requests.main_cap))) {
    return deny("REPAIR_REQUESTS_EXHAUSTED", "Job 累计模型请求额度已耗尽或无法确认；不能通过新 token/代际刷新额度。");
  }
  const [history] = await db`SELECT count(*)::int AS count,
    count(*) FILTER (WHERE payload_json->>'status'='persisted_deferred')::int AS accepted
    FROM events WHERE job_id=${jobId} AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'`;
  const [done] = await db`SELECT event_id FROM events WHERE job_id=${jobId} AND type='done' LIMIT 1`;
  if (done || Number(history.accepted) > 0) return deny("COMPLETION_ALREADY_ACCEPTED", "完成提案已接受；查询原回执并结算，不重跑已接受效果。");
  try { await readMainTokenAllowance(db, jobId, job?.agent_snapshot_json, budget); }
  catch (error) {
    if (!(error instanceof RepairTokenBudgetError)) throw error;
    return deny(error.code, error.message);
  }
  // Generic recovery safety applies even when no completion was ever rejected.
  // Only repair revision/deadline accounting requires a rejected-completion root.
  if (!budget) return { budget: null, deadline: null, blocker: null };
  if (Number(history.count) >= COMPLETION_REPAIR_LIMIT) return deny("COMPLETION_REPAIR_EXHAUSTED", "Job 累计修正次数已耗尽；不创建新代际。");
  const deadline = budget.deadline ?? (job?.started_at
    ? new Date(new Date(job.started_at).getTime() + Number(job.timeout_sec) * 1000).toISOString() : null);
  if (!deadline || Date.parse(deadline) <= Date.now()) return deny("REPAIR_DEADLINE_EXHAUSTED", "原修复期限已耗尽或无法确认；不能刷新期限继续执行。");
  try { assertRepairTokenBudget({ ...budget, deadline }, true); }
  catch (error) {
    if (!(error instanceof RepairTokenBudgetError)) throw error;
    return deny(error.code, error.message);
  }
  return { budget, deadline, blocker: null };
}
