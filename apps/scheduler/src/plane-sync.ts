import { PlaneClient, parseIssueTask } from "@dfh/plane-client";
import { config } from "./config.js";
import { createJob, ensureCanvasForTask, transitionJob } from "./core.js";
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

  const projects = await sql`SELECT id, plane_project_id FROM projects`;
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

async function pollProject(plane: PlaneClient, projectId: string, planeProjectId: string): Promise<number> {
  const [states, issues] = await Promise.all([
    plane.stateMap(planeProjectId),
    plane.listIssues(planeProjectId),
  ]);
  const readyId = states.get(config.plane.readyState);
  const inProgressId = states.get(config.plane.inProgressState);
  if (!readyId) return 0;

  let created = 0;
  for (const issue of issues) {
    if (issue.state !== readyId) continue;
    const { type, params } = parseIssueTask(issue);
    if (!type) continue; // 无 type= 标记的 issue 不领取

    // 一任务一画布：同一 issue 重试复用同一画布（root 节点带任务目标）
    const canvasId = await ensureCanvasForTask({
      projectId,
      planeIssueId: issue.id,
      title: issue.name,
      target: { type, ...params },
    });

    const { job, duplicated } = await createJob({
      projectId,
      canvasId,
      planeIssueId: issue.id,
      type,
      payload: params,
      timeoutSec: type === "verify_finding" ? config.timeouts.verifySec : config.timeouts.auditSec,
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
  // 失败重试上限：同一 issue 反复失败会成死循环（回 Ready → 再领取 → 再失败）
  // 达到上限后留在 In Progress + 评论提示，交人工处理（resume 可手动复活）
  const MAX_AUTO_RETRIES = 3;
  let exhausted = false;
  if (!ok) {
    const [{ attempts }] = await sql<[{ attempts: number }]>`
      SELECT COUNT(*)::int AS attempts FROM jobs WHERE plane_issue_id = ${job.plane_issue_id}`;
    exhausted = attempts >= MAX_AUTO_RETRIES;
  }
  // 失败不置 Done：回 Ready 等重试；重试耗尽则留在 In Progress 等人工
  await plane
    .updateIssueState(
      job.plane_project_id,
      job.plane_issue_id,
      ok ? doneId : exhausted
        ? (states.get(config.plane.inProgressState) ?? doneId)
        : (states.get(config.plane.readyState) ?? doneId),
    )
    .catch((e) => console.error("[plane] 回写失败:", e));
  await plane
    .addComment(
      job.plane_project_id,
      job.plane_issue_id,
      `<p>🤖 job ${job.id} 结束：<b>${job.status}</b>${job.error ? ` — ${job.error}` : ""}${exhausted ? `（自动重试已达 ${MAX_AUTO_RETRIES} 次上限，请人工介入）` : ""}</p>`,
    )
    .catch(() => {});
}

export function startPlaneSync() {
  if (!config.plane.enabled) {
    console.log("[plane] 未配置 PLANE_WORKSPACE_SLUG，Plane 同步停用（可手动 POST /jobs）");
    return () => {};
  }
  const timer = setInterval(() => {
    void planePollOnce().catch((e) => console.error("[plane]", e));
  }, config.timeouts.pollIntervalSec * 1000);
  void planePollOnce().catch((e) => console.error("[plane]", e));
  return () => clearInterval(timer);
}

export { transitionJob };
