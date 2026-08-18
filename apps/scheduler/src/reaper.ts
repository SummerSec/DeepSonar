import { config } from "./config.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { runner, sharedAssetsVolumeManager } from "./runtime.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { advanceCanvasAfterTerminalJob, recoverVerifyJobTerminal } from "./core.js";
import { revokeJobTokens } from "./gateway.js";
import { revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import { finalizeReportJob } from "./report.js";
import { planeWriteback } from "./plane-sync.js";

/**
 * Reaper（§3.3 兜底）：调度器唯一可信的终局判定者
 * - 超时：started_at + timeout_sec 到期 → timeout
 * - 孤儿：lease 过期 → orphan（沙箱可能已死/调度器崩溃后恢复）
 */

export async function reapOnce(): Promise<{ timeouts: number; orphans: number; provisionStuck: number; stalled: number }> {
  const lifecycle = createSqlJobLifecycleApplication();
  const timedOut = await lifecycle.reapExecutionTimeout();

  // provision 卡死（§8.3）：claimed/provisioning 超过 provision 独立超时 → failed
  const provisionStuck = await lifecycle.reapProvisionTimeout(config.timeouts.provisionSec);

  const orphaned = await lifecycle.reapLeaseOrphans();
  const stalled = await lifecycle.reapStalledExecution(config.timeouts.stallSec);

  for (const j of [...timedOut, ...provisionStuck, ...orphaned, ...stalled]) {
    const jobId = j.id as string;
    const sandboxId = j.sandbox_id as string | null | undefined;
    if (sandboxId) {
      await runner.destroy({ sandboxId }).catch((e) => {
        inc("deepsonar_sandbox_cleanup_failed_total");
        console.error(`[reaper] 沙箱回收失败 ${sandboxId}:`, e);
      });
    }
    await sharedAssetsVolumeManager.removeForJob(jobId).catch((e) => {
      inc("deepsonar_shared_assets_cleanup_failed_total");
      console.error(`[reaper] 共享资产卷回收失败 ${jobId}:`, e);
    });
    // §13.1 指标：终局原因计数
    const isTimeout = timedOut.some((x) => x.id === jobId);
    const isProvision = provisionStuck.some((x) => x.id === jobId);
    const isStalled = stalled.some((x) => x.id === jobId);
    if (isTimeout) inc("deepsonar_jobs_failed_total", { reason: "timeout" });
    else if (isProvision) inc("deepsonar_jobs_failed_total", { reason: "provision_stuck" });
    else if (isStalled) inc("deepsonar_jobs_failed_total", { reason: "stalled" });
    else inc("deepsonar_jobs_orphan_total");
    // §6.3：终局判定即吊销短期模型 Token
    await revokeJobTokens(jobId, "reaper").catch(() => {});
    await revokeJobCapabilityTokens(jobId, "reaper").catch(() => {});
    // 失败不能只改 jobs 表而留下 running 画布节点（§8.3：job/intent 节点同步终态）
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;

    // verify 收口：不得遗留 verifying；report 失败保持 Root reporting
    const [meta] = await sql`SELECT type, error, canvas_id, project_id, priority, id FROM jobs WHERE id = ${jobId}`;
    if (meta?.type === "verify_finding") {
      const status = isTimeout ? "timeout" : isProvision || isStalled ? "failed" : "orphan";
      await recoverVerifyJobTerminal(jobId, status, (meta.error as string) ?? null).catch((e) =>
        console.error(`[reaper] verify recovery failed:`, e),
      );
    }
    if (meta?.type === "report") {
      await sql.begin(async (tx) => {
        await finalizeReportJob(tx as unknown as typeof sql, jobId, {
          failed: true,
          error: (meta.error as string) ?? "reaper",
        });
      }).catch(() => {});
    }
    // 任意非 Report job 被 reaper 收口后统一推进：analysis_complete → Report，否则空闲唤醒 Hub。
    if (meta?.canvas_id && meta.type !== "report") {
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
          isTimeout ? "timeout" : isProvision || isStalled ? "failed" : "orphan",
        );
      }).catch((e) => console.error(`[reaper] terminal canvas advance failed:`, e));
    }

    await planeWriteback(jobId).catch(() => {});
  }

  return { timeouts: timedOut.length, orphans: orphaned.length, provisionStuck: provisionStuck.length, stalled: stalled.length };
}

export function startReaper() {
  const timer = setInterval(() => {
    void reapOnce()
      .then((r) => {
        if (r.timeouts + r.orphans + r.provisionStuck + r.stalled > 0) console.log("[reaper]", r);
      })
      .catch((e) => console.error("[reaper]", e));
  }, config.timeouts.reaperIntervalSec * 1000);
  return () => clearInterval(timer);
}
