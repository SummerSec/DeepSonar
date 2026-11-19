import { recordSystemAudit } from "../../audit.js";
import type { sql } from "../../db.js";

/** Caller holds the dispatch claim advisory lock. Only the original yielded membership may close. */
export async function reconcileYieldedTaskQueueItems(db: typeof sql, projectId: string, canvasId?: string): Promise<void> {
  const closed = await db`
    UPDATE project_task_queue_items i
    SET state = CASE WHEN r.checkpoint_expires_at <= clock_timestamp()
      AND r.status NOT IN ('closed','dismissed') AND j.status = 'waiting_human'
      AND c.status = 'active' AND c.archived_at IS NULL
      AND p.status = 'active' AND p.archived_at IS NULL THEN 'failed' ELSE 'cancelled' END,
      ended_at = clock_timestamp()
    FROM project_task_queue_yields y
    JOIN human_requests r ON r.id = y.request_id
    JOIN jobs j ON j.id = r.job_id
    JOIN canvases c ON c.id = y.canvas_id
    JOIN projects p ON p.id = y.project_id
    WHERE i.project_id = ${projectId} AND (${canvasId ?? null}::text IS NULL OR i.canvas_id = ${canvasId ?? null})
      AND i.canvas_id = y.canvas_id AND i.project_id = y.project_id AND i.id = y.source_item_id
      AND i.state = 'yielded' AND y.requeued_at IS NULL
      AND (r.status IN ('closed','dismissed') OR j.status <> 'waiting_human'
        OR c.status <> 'active' OR c.archived_at IS NOT NULL
        OR p.status <> 'active' OR p.archived_at IS NOT NULL
        OR r.checkpoint_expires_at <= clock_timestamp())
    RETURNING i.id::text, i.canvas_id, i.state, y.request_id,
      CASE WHEN r.status IN ('closed','dismissed') THEN r.status
        WHEN j.status <> 'waiting_human' THEN j.status
        WHEN c.status <> 'active' OR c.archived_at IS NOT NULL THEN 'canvas_archived'
        WHEN p.status <> 'active' OR p.archived_at IS NOT NULL THEN 'project_archived'
        ELSE 'HUMAN_CHECKPOINT_EXPIRED' END AS reason`;
  for (const item of closed) {
    await recordSystemAudit({ action: "task_queue.human_yield_closed", projectId,
      resourceType: "project_task_queue_item", resourceId: String(item.id),
      before: { state: "yielded", canvas_id: item.canvas_id, request_id: item.request_id },
      after: { state: item.state, reason: item.reason },
    }, db);
  }
}
