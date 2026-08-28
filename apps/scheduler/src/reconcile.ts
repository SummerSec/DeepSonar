import { sharedAssetsVolumeManager, runner } from "./runtime.js";
import { sql } from "./db.js";
import { inc, setGauge } from "./metrics.js";
import { planeWriteback } from "./plane-sync.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { advanceCanvasAfterTerminalJob, recoverVerifyJobTerminal } from "./core.js";
import { revokeJobTokens } from "./gateway.js";
import { revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import { finalizeReportJob } from "./report.js";
import { config } from "./config.js";
import { cleanupManagedResourcesOnce } from "./resource-cleanup.js";

/**
 * 重启 reconcile（JOB-04）：进程重启后内存沙箱注册表清空，DB 与 docker 引擎可能不一致：
 * 1. 容器在、job 非活动（终态/不存在）→ 孤儿容器强删（INC-01 防线：凭据不留滞在容器里）
 * 2. 只有 Attempt 仍处于 preparing 且没有效果记录时才可重置回 pending；
 *    provision effect_pending/unknown 无法证明外部效果未发生，必须标记 orphan，禁止重放
 * 3. job running → 执行上下文随进程丢失 → orphan（可人工 resume），残留容器一并销毁
 *
 * 必须在 dispatcher/reaper 启动前执行完，避免新调度与旧残留交错。
 */
export async function reconcileOnBoot(): Promise<void> {
  const lifecycle = createSqlJobLifecycleApplication();
  const managesReal = config.runtime.agentMode === "real";
  const containers = managesReal
    ? (await runner.listResources()).map((resource) => ({
        containerId: resource.resourceId,
        jobId: resource.jobId,
        attemptId: resource.attemptId,
        state: resource.state ?? "",
      }))
    : [];
  const activeJobs = await sql`
    SELECT j.id, j.status, j.sandbox_id, a.id AS attempt_id
      FROM jobs j
      LEFT JOIN job_attempts a ON a.job_id = j.id AND a.status = 'active'
     WHERE j.status IN ('claimed','provisioning','running')`;
  const activeJobIds = new Set(activeJobs.map((j) => j.id as string));
  const activeAttemptIds = new Map(activeJobs.map((j) => [String(j.id), j.attempt_id ? String(j.attempt_id) : null]));
  const containerByJob = new Map(containers.map((c) => [c.jobId, c.containerId]));

  for (const volume of await sharedAssetsVolumeManager.listManaged()) {
    if (activeJobIds.has(volume.jobId)) continue;
    await sharedAssetsVolumeManager.removeForJob(volume.jobId)
      .then(() => console.warn(`[reconcile] 回收孤儿共享资产卷 ${volume.volumeName}`))
      .catch((e) => {
        inc("deepsonar_shared_assets_cleanup_failed_total");
        console.error(`[reconcile] 共享资产卷回收失败 ${volume.volumeName}:`, e instanceof Error ? e.message : e);
      });
  }

  // 1. 孤儿容器（标签指向的 job 已非活动）
  for (const c of containers) {
    if (activeJobIds.has(c.jobId) && activeAttemptIds.get(c.jobId) === c.attemptId) continue;
    await runner.destroyResource({ resourceId: c.containerId, jobId: c.jobId, attemptId: c.attemptId })
      .then(() => console.warn(`[reconcile] 回收孤儿容器 ${c.containerId}（job/attempt 不匹配）`))
      .catch((e) => console.error(`[reconcile] 容器回收失败 ${c.containerId}:`, e instanceof Error ? e.message : e));
  }

  // 2. provision 恢复由 Attempt 效果账本决定：未知效果进入 orphan，只有明确未开始才重排。
  const provisionRecovery = await lifecycle.reconcileProvisioning();
  if (provisionRecovery.requeued.length > 0) {
    console.warn(`[reconcile] ${provisionRecovery.requeued.length} 个 provision 尚未开始的 job 已重置回 pending`);
  }
  for (const job of provisionRecovery.requeued) {
    await sharedAssetsVolumeManager.removeForJob(job.id as string).catch(() => {
      inc("deepsonar_shared_assets_cleanup_failed_total");
    });
  }

  // provision 外部效果未知的 Job 已由生命周期事务标记 orphan；执行与 running
  // orphan 相同的资源、Token、画布、报告和 Plane 收口，禁止它们静默留在半终态。
  for (const job of provisionRecovery.orphaned) {
    const jobId = String(job.id);
    const cid = (job.sandbox_id as string | null) ?? containerByJob.get(jobId);
    if (cid) await runner.destroyResource({ resourceId: cid, jobId, attemptId: "" }).catch(() => {});
    await sharedAssetsVolumeManager.removeForJob(jobId).catch(() => {
      inc("deepsonar_shared_assets_cleanup_failed_total");
    });
  }
  await finalizeBootOrphanJobs(provisionRecovery.orphaned);

  // sendMessage 前进程退出会留下 planned；启动后只把超过截止时间的记录
  // 标记 unknown，绝不自动重新注入同一事实。
  await sql`
    UPDATE canvas_broadcasts
       SET delivery_status = 'unknown',
           error = COALESCE(error, 'ack_lost'),
           updated_at = now()
     WHERE delivery_status = 'planned'
       AND (deadline_at IS NULL OR deadline_at < now())`;

  // 3. running 中断 → orphan + 销毁残留容器 + 画布节点同步 + Plane 回写
  const orphaned = await lifecycle.reconcileRunning();
  for (const j of orphaned) {
    const jobId = j.id as string;
    const cid = (j.sandbox_id as string | null) ?? containerByJob.get(jobId);
    if (cid) {
      await runner.destroyResource({ resourceId: cid, jobId, attemptId: "" })
        .catch((e) => console.error(`[reconcile] 容器回收失败 ${cid}:`, e instanceof Error ? e.message : e));
    }
    await sharedAssetsVolumeManager.removeForJob(jobId).catch(() => {
      inc("deepsonar_shared_assets_cleanup_failed_total");
    });
  }
  await finalizeBootOrphanJobs(orphaned);
  if (orphaned.length > 0) {
    console.warn(`[reconcile] ${orphaned.length} 个 running job 已标记 orphan（可 resume）`);
  }

  await refreshSharedAssetsOrphanMetrics();
  if (managesReal) {
    const cleanup = await cleanupManagedResourcesOnce();
    if (cleanup.removedContainers + cleanup.removedVolumes + cleanup.failures > 0) {
      console.log("[reconcile] desired-state cleanup:", cleanup);
    }
  }

  if (containers.length > 0 || provisionRecovery.requeued.length > 0 || provisionRecovery.orphaned.length > 0 || orphaned.length > 0) {
    console.log(`[reconcile] 完成：容器 ${containers.length}，重置 ${provisionRecovery.requeued.length}，provision orphan ${provisionRecovery.orphaned.length}，running orphan ${orphaned.length}`);
  }
}

async function refreshSharedAssetsOrphanMetrics(): Promise<void> {
  const activeJobs = await sql<Array<{ id: string }>>`
    SELECT id FROM jobs
     WHERE status IN ('pending','claimed','provisioning','running','waiting_human')`;
  const activeJobIds = new Set(activeJobs.map((job) => String(job.id)));
  const remainingOrphans = (await sharedAssetsVolumeManager.listManaged())
    .filter((volume) => !activeJobIds.has(volume.jobId));
  const now = Date.now();
  const oldestAgeSeconds = remainingOrphans.reduce((maximum, volume) => {
    if (!volume.createdAt) return maximum;
    const createdAt = Date.parse(volume.createdAt);
    if (!Number.isFinite(createdAt)) return maximum;
    return Math.max(maximum, (now - createdAt) / 1_000);
  }, 0);
  setGauge("deepsonar_shared_assets_orphan_volumes", remainingOrphans.length);
  setGauge("deepsonar_shared_assets_orphan_volume_age_seconds", Math.max(0, oldestAgeSeconds));
}

/**
 * Finish boot-orphan side effects after the lifecycle adapter has atomically
 * marked the whole interrupted set. Role Workers deliberately stop at this
 * recovery boundary: deriving a Hub here would be newer than the siblings and
 * steal the task-level resume entry point.
 */
export async function finalizeBootOrphanJobs(jobs: readonly Record<string, unknown>[]): Promise<void> {
  if (jobs.length === 0) return;
  const roleRows = await sql<Array<{ name: string }>>`
    SELECT name FROM agent_roles WHERE kind = 'role'`;
  const roleNames = new Set(roleRows.map((row) => String(row.name)));
  for (const job of jobs) {
    const snapshot = job.agent_snapshot_json && typeof job.agent_snapshot_json === "object"
      ? job.agent_snapshot_json as Record<string, unknown>
      : {};
    const type = String(job.type);
    const isRoleWorker = roleNames.has(type)
      || (snapshot.role_kind === "role" && !["hub_reason", "verify_finding", "report"].includes(type));
    await closeOrphanJob(job, { deferCanvasAdvance: isRoleWorker });
  }
}

async function closeOrphanJob(
  job: Record<string, unknown>,
  options: { deferCanvasAdvance: boolean },
): Promise<void> {
  const jobId = String(job.id);
  await sql`
    UPDATE canvas_nodes SET status = 'failed', updated_at = now()
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
  await revokeJobTokens(jobId, "orphan_reconcile").catch(() => {});
  await revokeJobCapabilityTokens(jobId, "orphan_reconcile").catch(() => {});
  if (job.type === "verify_finding") {
    await recoverVerifyJobTerminal(jobId, "orphan", (job.error as string) ?? null).catch((error) =>
      console.error(`[reconcile] verify recovery failed:`, error),
    );
  } else if (job.type === "report") {
    await sql.begin(async (tx) => {
      await finalizeReportJob(tx as unknown as typeof sql, jobId, {
        failed: true,
        error: (job.error as string) ?? "orphan_reconcile",
      });
    }).catch((error) => console.error(`[reconcile] report recovery failed:`, error));
  }
  if (job.canvas_id && job.type !== "report" && !options.deferCanvasAdvance) {
    await sql.begin(async (tx) => {
      await advanceCanvasAfterTerminalJob(tx as unknown as typeof sql, job, "orphan");
    }).catch((error) => console.error(`[reconcile] terminal canvas advance failed:`, error));
  }
  await planeWriteback(jobId).catch(() => {});
}
