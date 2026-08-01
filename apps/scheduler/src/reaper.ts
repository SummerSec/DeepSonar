import { config } from "./config.js";
import { sql } from "./db.js";
import { runner } from "./runtime.js";

/**
 * Reaper（§3.3 兜底）：调度器唯一可信的终局判定者
 * - 超时：started_at + timeout_sec 到期 → timeout
 * - 孤儿：lease 过期 → orphan（沙箱可能已死/调度器崩溃后恢复）
 */

export async function reapOnce(): Promise<{ timeouts: number; orphans: number; provisionStuck: number }> {
  const timedOut = await sql`
    UPDATE jobs SET status = 'timeout', finished_at = now(),
                    error = COALESCE(error, '') || '超时（Reaper 判定）'
    WHERE status IN ('claimed','provisioning','running')
      AND started_at IS NOT NULL
      AND started_at + (timeout_sec * interval '1 second') < now()
    RETURNING id, sandbox_id`;

  // provision 卡死（§8.3）：claimed/provisioning 超过 provision 独立超时 → failed
  const provisionStuck = await sql`
    UPDATE jobs SET status = 'failed', finished_at = now(),
                    error = COALESCE(error, '') || 'provision 超时（Reaper 判定）'
    WHERE status IN ('claimed','provisioning')
      AND claimed_at IS NOT NULL
      AND claimed_at + (${config.timeouts.provisionSec} * interval '1 second') < now()
    RETURNING id, sandbox_id`;

  const orphaned = await sql`
    UPDATE jobs SET status = 'orphan', finished_at = now(),
                    error = COALESCE(error, '') || 'lease 过期（Reaper 判定孤儿）'
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
    RETURNING id, sandbox_id`;

  for (const j of [...timedOut, ...provisionStuck, ...orphaned]) {
    if (j.sandbox_id) {
      await runner.destroy({ sandboxId: j.sandbox_id }).catch((e) => {
        console.error(`[reaper] 沙箱回收失败 ${j.sandbox_id}:`, e);
      });
    }
    // 失败不能只改 jobs 表而留下 running 画布节点（§8.3：job/intent 节点同步终态）
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${j.id} AND node_type = ANY(${["job", "intent"]})`;
    const { planeWriteback } = await import("./plane-sync.js");
    await planeWriteback(j.id).catch(() => {});
  }

  return { timeouts: timedOut.length, orphans: orphaned.length, provisionStuck: provisionStuck.length };
}

export function startReaper() {
  const timer = setInterval(() => {
    void reapOnce()
      .then((r) => {
        if (r.timeouts + r.orphans + r.provisionStuck > 0) console.log("[reaper]", r);
      })
      .catch((e) => console.error("[reaper]", e));
  }, config.timeouts.reaperIntervalSec * 1000);
  return () => clearInterval(timer);
}
