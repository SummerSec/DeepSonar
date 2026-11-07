import { lockCanvasForConvergence } from "../../core.js";
import { sql } from "../../db.js";
import { withOperationConflictRetry } from "../../db-conflict-retry.js";

/** Best-effort UI projection only; retrying this transaction never replays the tool. */
export async function persistJobToolProgress(
  db: typeof sql,
  input: { canvasId: string | null; jobId: string; action: string },
): Promise<void> {
  if (!input.canvasId) return;
  await withOperationConflictRetry("canvas_job_tool_progress", () => db.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql;
    // The change-log trigger locks Canvas too: acquire it before the node row.
    if (!await lockCanvasForConvergence(tx, input.canvasId)) return;
    await tx`
      UPDATE canvas_nodes
      SET body_json = body_json || ${tx.json({ last_progress: { message: input.action, kind: "tool" } })}, updated_at = now()
      WHERE canvas_id = ${input.canvasId} AND job_id = ${input.jobId} AND node_type = 'job'`;
  }));
}
