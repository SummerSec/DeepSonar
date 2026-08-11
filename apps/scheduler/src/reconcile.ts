import { forceRemoveContainer, listDeepSonarContainers } from "@deepsonar/runtime-sandbox";
import { sql } from "./db.js";
import { planeWriteback } from "./plane-sync.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { advanceCanvasAfterTerminalJob, recoverVerifyJobTerminal } from "./core.js";
import { revokeJobTokens } from "./gateway.js";
import { revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import { finalizeReportJob } from "./report.js";
import { sharedAssetsVolumeManager } from "./runtime.js";

/**
 * 重启 reconcile（JOB-04）：进程重启后内存沙箱注册表清空，DB 与 docker 引擎可能不一致：
 * 1. 容器在、job 非活动（终态/不存在）→ 孤儿容器强删（INC-01 防线：凭据不留滞在容器里）
 * 2. job claimed/provisioning → 上一进程死在 provision 途中；尚未触碰沙箱，重置回 pending 重排
 * 3. job running → 执行上下文随进程丢失 → orphan（可人工 resume），残留容器一并销毁
 *
 * 必须在 dispatcher/reaper 启动前执行完，避免新调度与旧残留交错。
 */
export async function reconcileOnBoot(): Promise<void> {
  const lifecycle = createSqlJobLifecycleApplication();
  const containers = await listDeepSonarContainers();
  const activeJobs = await sql`
    SELECT id, status, sandbox_id FROM jobs WHERE status IN ('claimed','provisioning','running')`;
  const activeJobIds = new Set(activeJobs.map((j) => j.id as string));

  for (const volume of await sharedAssetsVolumeManager.listManaged()) {
    if (activeJobIds.has(volume.jobId)) continue;
    await sharedAssetsVolumeManager.removeForJob(volume.jobId)
      .then(() => console.warn(`[reconcile] 回收孤儿共享资产卷 ${volume.volumeName}`))
      .catch((e) => console.error(`[reconcile] 共享资产卷回收失败 ${volume.volumeName}:`, e instanceof Error ? e.message : e));
  }

  // 1. 孤儿容器（标签指向的 job 已非活动）
  for (const c of containers) {
    if (activeJobIds.has(c.jobId)) continue;
    await forceRemoveContainer(c.containerId)
      .then(() => console.warn(`[reconcile] 回收孤儿容器 ${c.containerId}（job ${c.jobId} 非活动）`))
      .catch((e) => console.error(`[reconcile] 容器回收失败 ${c.containerId}:`, e instanceof Error ? e.message : e));
  }

  // 2. provision 途中中断 → 重置回 pending（无副作用，安全重排）
  const reset = await lifecycle.reconcileProvisioning();
  if (reset.length > 0) {
    console.warn(`[reconcile] ${reset.length} 个 provision 途中 job 已重置回 pending`);
  }
  for (const job of reset) await sharedAssetsVolumeManager.removeForJob(job.id as string).catch(() => undefined);

  // 3. running 中断 → orphan + 销毁残留容器 + 画布节点同步 + Plane 回写
  const orphaned = await lifecycle.reconcileRunning();
  const containerByJob = new Map(containers.map((c) => [c.jobId, c.containerId]));
  for (const j of orphaned) {
    const jobId = j.id as string;
    const cid = (j.sandbox_id as string | null) ?? containerByJob.get(jobId);
    if (cid) {
      await forceRemoveContainer(cid)
        .catch((e) => console.error(`[reconcile] 容器回收失败 ${cid}:`, e instanceof Error ? e.message : e));
    }
    await sharedAssetsVolumeManager.removeForJob(jobId).catch(() => undefined);
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
    // §6.3：orphan 即吊销短期模型 Token
    await revokeJobTokens(jobId, "orphan_reconcile").catch(() => {});
    await revokeJobCapabilityTokens(jobId, "orphan_reconcile").catch(() => {});

    // 启动恢复也必须执行与实时终态入口相同的业务收口，不能只改 jobs 表。
    if (j.type === "verify_finding") {
      await recoverVerifyJobTerminal(jobId, "orphan", (j.error as string) ?? null).catch((e) =>
        console.error(`[reconcile] verify recovery failed:`, e),
      );
    } else if (j.type === "report") {
      await sql.begin(async (tx) => {
        await finalizeReportJob(tx as unknown as typeof sql, jobId, {
          failed: true,
          error: (j.error as string) ?? "orphan_reconcile",
        });
      }).catch((e) => console.error(`[reconcile] report recovery failed:`, e));
    }

    if (j.canvas_id && j.type !== "report") {
      await sql.begin(async (tx) => {
        await advanceCanvasAfterTerminalJob(
          tx as unknown as typeof sql,
          {
            id: j.id,
            project_id: j.project_id,
            canvas_id: j.canvas_id,
            type: j.type,
            priority: j.priority ?? 0,
          },
          "orphan",
        );
      }).catch((e) => console.error(`[reconcile] terminal canvas advance failed:`, e));
    }
    await planeWriteback(jobId).catch(() => {});
  }
  if (orphaned.length > 0) {
    console.warn(`[reconcile] ${orphaned.length} 个 running job 已标记 orphan（可 resume）`);
  }

  if (containers.length > 0 || reset.length > 0 || orphaned.length > 0) {
    console.log(`[reconcile] 完成：容器 ${containers.length}，重置 ${reset.length}，orphan ${orphaned.length}`);
  }
}
