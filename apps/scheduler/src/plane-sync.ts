import { issueContent, PlaneClient } from "@dfh/plane-client";
import { config } from "./config.js";
import { createJob, ensureCanvasForTask, rulesForProject, transitionJob } from "./core.js";
import { sql } from "./db.js";

/**
 * Plane 同步（§4.2 第 1–2 步 + §7 回写）：
 * - 轮询：每个已绑定项目，拉取 state=Ready 的 issue → 解析任务参数 → 建 job → issue 置 In Progress
 * - 回写：job 终态 → issue 置 Done + 评论摘要
 * PLANE_WORKSPACE_SLUG 未配置时整体停用（Phase 0 可先纯手动跑）
 */

function client(): PlaneClient | null {
  if (!config.plane.enabled) return null;
  return new PlaneClient({
    baseUrl: config.plane.baseUrl,
    token: config.plane.token,
    workspaceSlug: config.plane.workspaceSlug,
  });
}

export async function planePollOnce(): Promise<number> {
  const plane = client();
  if (!plane) return 0;

  // 只同步绑定了 Plane 且未归档的项目（0008 起 plane_project_id 可空 = 纯本地项目）
  const projects = await sql`
    SELECT id, plane_project_id FROM projects
    WHERE plane_project_id IS NOT NULL AND status = 'active'`;
  let created = 0;

  for (const p of projects) {
    // 单个项目同步失败（如 Plane 端已删除）不影响其他项目
    try {
      created += await pollProject(plane, p.id, p.plane_project_id);
    } catch (e) {
      console.error(`[plane] 项目 ${p.plane_project_id} 轮询失败:`, e instanceof Error ? e.message : e);
    }
  }
  return created;
}

/** 单项目手动补跑（POST /projects/:id/integrations/plane/sync） */
export async function planePollProject(projectId: string): Promise<number> {
  const plane = client();
  if (!plane) throw new Error("Plane 未配置（PLANE_API_TOKEN / PLANE_WORKSPACE_SLUG）");
  const [project] = await sql`
    SELECT id, plane_project_id, status FROM projects WHERE id = ${projectId}`;
  if (!project) throw new Error("project not found");
  if (!project.plane_project_id) throw new Error("项目未绑定 Plane");
  if (project.status !== "active") throw new Error("项目已归档");
  return pollProject(plane, project.id, project.plane_project_id as string);
}

async function pollProject(plane: PlaneClient, projectId: string, planeProjectId: string): Promise<number> {
  const [states, issues] = await Promise.all([
    plane.stateMap(planeProjectId),
    plane.listIssues(planeProjectId),
  ]);
  const readyId = states.get(config.plane.readyState);
  const inProgressId = states.get(config.plane.inProgressState);
  if (!readyId) return 0;

  let created = 0;
  const rules = await rulesForProject(sql, projectId);
  for (const issue of issues) {
    if (issue.state !== readyId) continue;
    const content = issueContent(issue) || issue.name;

    // 一任务一画布：同一 issue 重试复用同一画布（root 节点带任务目标）
    const canvasId = await ensureCanvasForTask({
      projectId,
      planeIssueId: issue.id,
      title: issue.name,
      target: { title: issue.name, content, goal: content },
    });

    const { job, duplicated } = await createJob({
      projectId,
      canvasId,
      planeIssueId: issue.id,
      type: "audit_module",
      payload: { title: issue.name, content, goal: content },
      timeoutSec: rules.auditTimeoutSec,
    });
    if (duplicated || !job) continue;

    created++;
    if (inProgressId) {
      await plane
        .updateIssueState(planeProjectId, issue.id, inProgressId)
        .catch((e) => console.error("[plane] 状态回写失败:", e));
    }
    await plane
      .addComment(planeProjectId, issue.id, `<p>🤖 DeepFlowHunter 已领取，job=${job.id}</p>`)
      .catch(() => {});
  }
  return created;
}

/** job 终态 → Plane 回写（dispatcher/reaper 调用） */
export async function planeWriteback(jobId: string): Promise<void> {
  const plane = client();
  if (!plane) return;
  const [job] = await sql`
    SELECT j.*, p.plane_project_id FROM jobs j
    JOIN projects p ON p.id = j.project_id
    WHERE j.id = ${jobId}`;
  if (!job?.plane_issue_id) return;

  const states = await plane.stateMap(job.plane_project_id);
  const doneId = states.get(config.plane.doneState);
  if (!doneId) return;

  const ok = job.status === "succeeded";
  // 取消 = 人工意图：不回 Ready（否则会被重新认领形成取消→重跑循环），留 In Progress 交人工
  const cancelled = job.status === "cancelled";
  // 失败重试上限：同一 issue 反复失败会成死循环（回 Ready → 再领取 → 再失败）
  // 达到上限后留在 In Progress + 评论提示，交人工处理（resume 可手动复活）
  const rules = await rulesForProject(sql, job.project_id);
  let exhausted = false;
  if (!ok && !cancelled) {
    const [{ attempts }] = await sql<[{ attempts: number }]>`
      SELECT COUNT(*)::int AS attempts FROM jobs WHERE plane_issue_id = ${job.plane_issue_id}`;
    exhausted = attempts >= rules.maxAutoRetries;
  }
  // 失败不置 Done：回 Ready 等重试；重试耗尽/人工取消则留在 In Progress 等人工
  await plane
    .updateIssueState(
      job.plane_project_id,
      job.plane_issue_id,
      ok ? doneId : exhausted || cancelled
        ? (states.get(config.plane.inProgressState) ?? doneId)
        : (states.get(config.plane.readyState) ?? doneId),
    )
    .catch((e) => console.error("[plane] 回写失败:", e));
  await plane
    .addComment(
      job.plane_project_id,
      job.plane_issue_id,
      `<p>🤖 job ${job.id} 结束：<b>${job.status}</b>${job.error ? ` — ${job.error}` : ""}${exhausted ? `（自动重试已达 ${rules.maxAutoRetries} 次上限，请人工介入）` : ""}</p>`,
    )
    .catch(() => {});
}

export function startPlaneSync() {
  if (!config.plane.enabled) {
    console.log("[plane] 未配置 PLANE_WORKSPACE_SLUG，Plane 同步停用（可手动 POST /jobs）");
    return () => {};
  }
  // 事件驱动：Plane webhook → /webhooks/plane 触发 planePollOnce（routes.ts）
  // 启动补跑一次（停机期间 Ready 的 issue 不会重发 webhook）
  void planePollOnce().catch((e) => console.error("[plane]", e));
  // 轮询仅在显式开启时启用（webhook 不可达的环境兜底；默认关闭）
  if (config.timeouts.planePollSec > 0) {
    const timer = setInterval(() => {
      void planePollOnce().catch((e) => console.error("[plane]", e));
    }, config.timeouts.planePollSec * 1000);
    console.log(`[plane] 轮询兜底已开启：${config.timeouts.planePollSec}s（默认应走 webhook 事件）`);
    return () => clearInterval(timer);
  }
  console.log("[plane] 事件驱动模式：等待 /webhooks/plane（未配 webhook 时设 PLANE_POLL_INTERVAL_SEC 兜底）");
  return () => {};
}

export { transitionJob };
