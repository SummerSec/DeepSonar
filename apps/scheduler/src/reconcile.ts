import { forceRemoveContainer, listDfhContainers } from "@dfh/runtime-sandbox";
import { sql } from "./db.js";
import { planeWriteback } from "./plane-sync.js";

/**
 * 重启 reconcile（JOB-04）：进程重启后内存沙箱注册表清空，DB 与 docker 引擎可能不一致：
 * 1. 容器在、job 非活动（终态/不存在）→ 孤儿容器强删（INC-01 防线：凭据不留滞在容器里）
 * 2. job claimed/provisioning → 上一进程死在 provision 途中；尚未触碰沙箱，重置回 pending 重排
 * 3. job running → 执行上下文随进程丢失 → orphan（可人工 resume），残留容器一并销毁
 *
 * 必须在 dispatcher/reaper 启动前执行完，避免新调度与旧残留交错。
 */
export async function reconcileOnBoot(): Promise<void> {
  const containers = await listDfhContainers();
  const activeJobs = await sql`
    SELECT id, status, sandbox_id FROM jobs WHERE status IN ('claimed','provisioning','running')`;
  const activeJobIds = new Set(activeJobs.map((j) => j.id as string));

  // 1. 孤儿容器（标签指向的 job 已非活动）
  for (const c of containers) {
    if (activeJobIds.has(c.jobId)) continue;
    await forceRemoveContainer(c.containerId)
      .then(() => console.warn(`[reconcile] 回收孤儿容器 ${c.containerId}（job ${c.jobId} 非活动）`))
      .catch((e) => console.error(`[reconcile] 容器回收失败 ${c.containerId}:`, e instanceof Error ? e.message : e));
  }

  // 2. provision 途中中断 → 重置回 pending（无副作用，安全重排）
  const reset = await sql`
    UPDATE jobs SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
    WHERE status IN ('claimed','provisioning')
    RETURNING id`;
  if (reset.length > 0) {
    console.warn(`[reconcile] ${reset.length} 个 provision 途中 job 已重置回 pending`);
  }

  // 3. running 中断 → orphan + 销毁残留容器 + 画布节点同步 + Plane 回写
  const orphaned = await sql`
    UPDATE jobs SET status = 'orphan', finished_at = now(),
                    error = COALESCE(error, '') || '调度器重启（执行中断）'
    WHERE status = 'running'
    RETURNING id, sandbox_id`;
  const containerByJob = new Map(containers.map((c) => [c.jobId, c.containerId]));
  for (const j of orphaned) {
    const cid = (j.sandbox_id as string | null) ?? containerByJob.get(j.id as string);
    if (cid) {
      await forceRemoveContainer(cid)
        .catch((e) => console.error(`[reconcile] 容器回收失败 ${cid}:`, e instanceof Error ? e.message : e));
    }
    await sql`
      UPDATE canvas_nodes SET status = 'failed', updated_at = now()
      WHERE job_id = ${j.id} AND node_type = ANY(${["job", "intent"]})`;
    await planeWriteback(j.id as string).catch(() => {});
  }
  if (orphaned.length > 0) {
    console.warn(`[reconcile] ${orphaned.length} 个 running job 已标记 orphan（可 resume）`);
  }

  if (containers.length > 0 || reset.length > 0 || orphaned.length > 0) {
    console.log(`[reconcile] 完成：容器 ${containers.length}，重置 ${reset.length}，orphan ${orphaned.length}`);
  }
}
