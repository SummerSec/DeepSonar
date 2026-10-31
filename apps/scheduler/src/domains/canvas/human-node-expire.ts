import { lockCanvasForConvergence } from "../../core.js";
import { sql } from "../../db.js";

export {
  classifyOpenHumanNodeExpiry,
  type HumanNodeExpireReason,
} from "./human-node-expire-policy.js";

const OPEN_HUMAN_STATUSES = ["open", ""] as const;

/**
 * 按画布收口 dangling human 投影。不改 Job status，也不改 Finding verify_status。
 * SQL 谓词必须与 `classifyOpenHumanNodeExpiry` 保持同义。
 */
export async function expireDanglingHumanNodes(
  tx: typeof sql,
  canvasId: string,
): Promise<number> {
  const expired = await tx`
    UPDATE canvas_nodes AS n
    SET status = 'expired',
        body_json = n.body_json || jsonb_build_object(
          'resolution', 'expired',
          'expired_at', now(),
          'expired_reason', CASE
            WHEN n.body_json->>'kind' = 'verification_blocker' THEN 'finding_not_needs_human'
            WHEN n.job_id IS NOT NULL THEN 'job_not_waiting_human'
            ELSE 'dangling_human_node'
          END
        ),
        updated_at = now()
    WHERE n.canvas_id = ${canvasId}
      AND n.node_type = 'human'
      AND COALESCE(n.status, 'open') = ANY(${OPEN_HUMAN_STATUSES})
      AND COALESCE(n.body_json->>'resolution', '') NOT IN ('ignored', 'expired')
      AND COALESCE(n.body_json->>'kind', '') <> 'finding_comment'
      AND n.body_json->>'message_id' IS NULL
      AND (
        (
          n.job_id IS NOT NULL
          AND COALESCE(n.body_json->>'kind', '') <> 'verification_blocker'
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = n.job_id AND j.status = 'waiting_human'
          )
        )
        OR (
          n.body_json->>'kind' = 'verification_blocker'
          AND NOT EXISTS (
            SELECT 1 FROM findings f
            WHERE f.id::text = n.body_json->>'finding_id'
              AND f.verify_status = 'needs_human'
          )
        )
        OR (
          n.job_id IS NULL
          AND COALESCE(n.body_json->>'kind', '') <> 'verification_blocker'
        )
      )
    RETURNING n.id`;
  return expired.length;
}

/** Reaper 存量兼底：按画布加锁后收口 dangling human 投影。 */
export async function reapExpiredHumanNodes(): Promise<number> {
  const canvases = await sql`
    SELECT DISTINCT canvas_id
    FROM canvas_nodes
    WHERE node_type = 'human'
      AND COALESCE(status, 'open') = ANY(${OPEN_HUMAN_STATUSES})
    ORDER BY canvas_id`;
  let expired = 0;
  for (const row of canvases) {
    const canvasId = String(row.canvas_id);
    const count = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await lockCanvasForConvergence(tx, canvasId);
      return expireDanglingHumanNodes(tx, canvasId);
    });
    expired += count;
  }
  return expired;
}
