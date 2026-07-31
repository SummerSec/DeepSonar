import { config } from "./config.js";
import { sql } from "./db.js";
import { NoopRunner } from "@dfh/runtime-sandbox";

/**
 * Reaper（§3.3 兜底）：调度器唯一可信的终局判定者
 * - 超时：started_at + timeout_sec 到期 → timeout
 * - 孤儿：lease 过期 → orphan（沙箱可能已死/调度器崩溃后恢复）
 */
const runner = new NoopRunner();

export async function reapOnce(): Promise<{ timeouts: number; orphans: number }> {
  const timedOut = await sql`
    UPDATE jobs SET status = 'timeout', finished_at = now(),
                    error = COALESCE(error, '') || '超时（Reaper 判定）'
    WHERE status IN ('claimed','provisioning','running')
      AND started_at IS NOT NULL
      AND started_at + (timeout_sec * interval '1 second') < now()
    RETURNING id, sandbox_id`;

  const orphaned = await sql`
    UPDATE jobs SET status = 'orphan', finished_at = now(),
                    error = COALESCE(error, '') || 'lease 过期（Reaper 判定孤儿）'
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
    RETURNING id, sandbox_id`;

  for (const j of [...timedOut, ...orphaned]) {
    if (j.sandbox_id) {
      await runner.destroy({ sandboxId: j.sandbox_id }).catch((e) => {
        console.error(`[reaper] 沙箱回收失败 ${j.sandbox_id}:`, e);
      });
    }
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${j.id} AND node_type = 'job'`;
    const { planeWriteback } = await import("./plane-sync.js");
    await planeWriteback(j.id).catch(() => {});
  }

  return { timeouts: timedOut.length, orphans: orphaned.length };
}

export function startReaper() {
  const timer = setInterval(() => {
    void reapOnce()
      .then((r) => {
        if (r.timeouts + r.orphans > 0) console.log("[reaper]", r);
      })
      .catch((e) => console.error("[reaper]", e));
  }, config.timeouts.reaperIntervalSec * 1000);
  return () => clearInterval(timer);
}
