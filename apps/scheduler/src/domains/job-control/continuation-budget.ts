import type { sql } from "../../db.js";

/** The first Job remains the budget authority. Execution and receipts keep their actual Job identity. */
export async function continuationBudgetScope(db: typeof sql, jobId: string) {
  const [job] = await db`SELECT COALESCE(budget_owner_job_id,id) AS root FROM jobs WHERE id=${jobId}`;
  if (!job) throw new Error("CONTINUATION_JOB_NOT_FOUND");
  const rootId = String(job.root);
  const rows = await db`SELECT id FROM jobs WHERE id=${rootId} OR budget_owner_job_id=${rootId} ORDER BY created_at,id`;
  return { rootId, jobIds: rows.map(row => String(row.id)) };
}

/** Always acquire the root before the executing Job, then Attempts and requests.
 * Canvas mutations acquire Canvas first. Settlement never acquires a root after a child. */
export async function lockContinuationBudget(db: typeof sql, jobId: string, requireOwner = true) {
  const { rootId } = await continuationBudgetScope(db, jobId);
  const [root] = await db`SELECT id,budget_execution_job_id FROM jobs WHERE id=${rootId} FOR UPDATE`;
  if (!root) throw new Error("CONTINUATION_BUDGET_ROOT_MISSING");
  if (requireOwner && String(root.budget_execution_job_id ?? root.id) !== jobId) {
    throw new Error("CONTINUATION_EXECUTION_SUPERSEDED");
  }
  if (rootId !== jobId) await db`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
  return continuationBudgetScope(db, jobId);
}

export async function assertContinuationBudgetOwner(db: typeof sql, jobId: string) {
  const [owner] = await db`SELECT root.id FROM jobs j JOIN jobs root ON root.id=COALESCE(j.budget_owner_job_id,j.id)
    WHERE j.id=${jobId} AND COALESCE(root.budget_execution_job_id,root.id)=j.id`;
  if (!owner) throw new Error("CONTINUATION_EXECUTION_SUPERSEDED");
}
