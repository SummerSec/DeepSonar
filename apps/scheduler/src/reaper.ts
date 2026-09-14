import { config } from "./config.js";
import { globalRules } from "./core.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { runner, sharedAssetsVolumeManager } from "./runtime.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { advanceCanvasAfterTerminalJob, lockCanvasForConvergence, recoverVerifyJobTerminal } from "./core.js";
import { revokeJobTokens } from "./gateway.js";
import { revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import { finalizeReportJob } from "./report.js";
import { cleanupManagedResourcesOnce, shouldCleanupManagedResources } from "./resource-cleanup.js";
import { releaseOrphanSandboxLeases } from "./domains/worker-nodes/registry.js";
import { reapExpiredDeviceLeases } from "./domains/device/index.js";

/**
 * Reaper（§3.3 兜底）：调度器唯一可信的终局判定者
 * - 超时：started_at + timeout_sec 到期 → timeout
 * - 孤儿：lease 过期 → orphan（沙箱可能已死/调度器崩溃后恢复）
 */

export async function reapOnce(): Promise<{ timeouts: number; orphans: number; provisionStuck: number; stalled: number }> {
  const lifecycle = createSqlJobLifecycleApplication();
  const timedOut = await lifecycle.reapExecutionTimeout();
  const liveRules = await globalRules(sql);

  // provision 卡死（§8.3）：claimed/provisioning 超过 provision 独立超时 → failed
  const provisionStuck = await lifecycle.reapProvisionTimeout(liveRules.provisionTimeoutSec);

  const orphaned = await lifecycle.reapLeaseOrphans();
  const stalled = await lifecycle.reapStalledExecution(liveRules.stallSec);

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
    const terminalStatus = isTimeout ? "timeout" : isProvision || isStalled ? "failed" : "orphan";
    const [meta] = await sql<{
      id: string;
      type: string;
      error: string | null;
      canvas_id: string | null;
      project_id: string | null;
      priority: number | null;
    }[]>`SELECT type, error, canvas_id, project_id, priority, id FROM jobs WHERE id = ${jobId}`;
    await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await lockCanvasForConvergence(tx, meta?.canvas_id ?? null);
      await tx`
        UPDATE canvas_nodes SET status = 'failed', updated_at = now()
        WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
      if (meta?.type === "report") {
        await finalizeReportJob(tx, jobId, {
          failed: true,
          error: (meta.error as string) ?? "reaper",
        });
      } else if (meta?.canvas_id && meta.type !== "report") {
        await advanceCanvasAfterTerminalJob(
          tx,
          {
            id: meta.id,
            project_id: meta.project_id,
            canvas_id: meta.canvas_id,
            type: meta.type,
            priority: meta.priority ?? 0,
          },
          terminalStatus,
        );
      }
    }).catch((e) => console.error(`[reaper] terminal canvas advance failed:`, e));
    if (meta?.type === "verify_finding") {
      await recoverVerifyJobTerminal(jobId, terminalStatus, (meta.error as string) ?? null).catch((e) =>
        console.error(`[reaper] verify recovery failed:`, e),
      );
    }

  }

  const releasedLeases = await releaseOrphanSandboxLeases();
  if (releasedLeases > 0) {
    console.warn(`[reaper] 回收 ${releasedLeases} 条终态/缺失 Job 的沙箱租约`);
  }

  // 设备租约（#495）的兼底：过期租约 → expired 且设备回 idle；broker 不可达时只记日志，
  // 由 broker 自身租约 TTL 与下一次 reap 继续收敛。
  const expiredDeviceLeases = await reapExpiredDeviceLeases().catch((error: unknown) => {
    console.error(`[reaper] 设备租约回收失败:`, error instanceof Error ? error.message : error);
    return 0;
  });
  if (expiredDeviceLeases > 0) {
    console.warn(`[reaper] 回收 ${expiredDeviceLeases} 条过期设备租约`);
  }

  return { timeouts: timedOut.length, orphans: orphaned.length, provisionStuck: provisionStuck.length, stalled: stalled.length };
}

export function startReaper() {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const result = await reapOnce();
      if (result.timeouts + result.orphans + result.provisionStuck + result.stalled > 0) {
        console.log("[reaper]", result);
      }
      if (shouldCleanupManagedResources(config.runtime)) {
        const cleanup = await cleanupManagedResourcesOnce();
        if (cleanup.removedContainers + cleanup.removedVolumes + cleanup.failures > 0) {
          console.log("[cleanup]", cleanup);
        }
      }
    })()
      .catch((e) => console.error("[reaper]", e))
      .finally(() => {
        running = false;
      });
  }, config.timeouts.reaperIntervalSec * 1000);
  return () => clearInterval(timer);
}
