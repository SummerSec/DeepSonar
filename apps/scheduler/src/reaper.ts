import { config } from "./config.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { runner } from "./runtime.js";
import { reconcileCanvasBroadcasts } from "./canvas-updates.js";

/**
 * Reaper（§3.3 兜底）：调度器唯一可信的终局判定者
 * - 超时：started_at + timeout_sec 到期 → timeout
 * - 孤儿：lease 过期 → orphan（沙箱可能已死/调度器崩溃后恢复）
 */

export async function reapOnce(): Promise<{ timeouts: number; orphans: number; provisionStuck: number }> {
  await reconcileCanvasBroadcasts().catch((error) =>
    console.error("[reaper] canvas broadcast reconciliation failed:", error),
  );
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
        inc("deepsonar_sandbox_cleanup_failed_total");
        console.error(`[reaper] 沙箱回收失败 ${j.sandbox_id}:`, e);
      });
    }
    // §13.1 指标：终局原因计数
    const isTimeout = timedOut.some((x) => x.id === j.id);
    const isProvision = provisionStuck.some((x) => x.id === j.id);
    if (isTimeout) inc("deepsonar_jobs_failed_total", { reason: "timeout" });
    else if (isProvision) inc("deepsonar_jobs_failed_total", { reason: "provision_stuck" });
    else inc("deepsonar_jobs_orphan_total");
    // §6.3：终局判定即吊销短期模型 Token
    const { revokeJobTokens } = await import("./gateway.js");
    await revokeJobTokens(j.id, "reaper").catch(() => {});
    // 失败不能只改 jobs 表而留下 running 画布节点（§8.3：job/intent 节点同步终态）
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${j.id} AND node_type = ANY(${["job", "intent", "report"]})`;

    // verify 收口：不得遗留 verifying；report 失败保持 Root reporting
    const [meta] = await sql`SELECT type, error, canvas_id, project_id, priority, id FROM jobs WHERE id = ${j.id}`;
    if (meta?.type === "verify_finding") {
      const { recoverVerifyJobTerminal } = await import("./core.js");
      const status = isTimeout ? "timeout" : isProvision ? "failed" : "orphan";
      await recoverVerifyJobTerminal(j.id as string, status, (meta.error as string) ?? null).catch((e) =>
        console.error(`[reaper] verify recovery failed:`, e),
      );
    }
    if (meta?.type === "report") {
      const { finalizeReportJob } = await import("./report.js");
      await sql.begin(async (tx) => {
        await finalizeReportJob(tx as unknown as typeof sql, j.id as string, {
          failed: true,
          error: (meta.error as string) ?? "reaper",
        });
      }).catch(() => {});
    }
    // 任意非 Report job 被 reaper 收口后统一推进：analysis_complete → Report，否则空闲唤醒 Hub。
    if (meta?.canvas_id && meta.type !== "report") {
      const { advanceCanvasAfterTerminalJob } = await import("./core.js");
      await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        await advanceCanvasAfterTerminalJob(
          tx,
          {
            id: meta.id,
            project_id: meta.project_id,
            canvas_id: meta.canvas_id,
            type: meta.type,
            priority: meta.priority ?? 0,
          },
          isTimeout ? "timeout" : isProvision ? "failed" : "orphan",
        );
      }).catch((e) => console.error(`[reaper] terminal canvas advance failed:`, e));
    }

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
