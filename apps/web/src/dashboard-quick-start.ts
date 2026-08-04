import type {
  AuthMe,
  AuthStatus,
  Project,
} from "./api";
import type { ReadinessCheck, ReadinessResponse } from "@deepsonar/shared-types";

export const NEW_PROJECT = "__new_project__" as const;
export const LAST_PROJECT_STORAGE_KEY = "deepsonar:last-project-id";

export type NetworkOverride = "inherit" | "allow" | "deny";

export const QUICK_START_PRESETS = [
  {
    id: "security-audit",
    label: "安全审计",
    title: "对目标进行一次安全审计",
    goal: "请从可验证证据出发梳理风险面，优先确认高影响问题，并把需要复核的事实留在画布上。",
  },
  {
    id: "investigation",
    label: "问题调查",
    title: "调查一个待确认的问题",
    goal: "请先建立问题边界，再收集事实、验证假设并给出下一步建议。不要把推测当作结论。",
  },
  {
    id: "verification",
    label: "验证测试",
    title: "验证一个已有判断",
    goal: "请围绕已有判断设计最小可复现验证，记录证据、限制条件与仍需人工确认的部分。",
  },
  {
    id: "custom",
    label: "自定义",
    title: "",
    goal: "",
  },
] as const;

export type QuickStartPresetId = (typeof QUICK_START_PRESETS)[number]["id"];

export interface QuickStartTaskPayload {
  title: string;
  content: string;
  allow_egress?: boolean;
}

export interface QuickStartApi {
  createProject: (input: { name: string; description?: string }) => Promise<Project>;
  readiness: (projectId: string, options?: { allow_egress?: boolean }) => Promise<ReadinessResponse>;
  createTask: (projectId: string, payload: QuickStartTaskPayload) => Promise<{ canvas_id: string; job: { id: string; status: string } }>;
}

export interface QuickStartInput {
  title: string;
  goal: string;
  project: Project | null;
  newProject?: { name: string; description?: string } | null;
  networkOverride: NetworkOverride;
}

export type QuickStartResult =
  | { kind: "invalid"; message: string }
  | { kind: "readiness_failed"; project: Project; readiness: ReadinessResponse }
  | { kind: "success"; project: Project; task: { canvas_id: string; job: { id: string; status: string } } };

/** 只有任务边界可以从快捷入口进入；角色、镜像和凭据仍由服务端治理。 */
export function networkOverrideValue(value: NetworkOverride): boolean | undefined {
  if (value === "allow") return true;
  if (value === "deny") return false;
  return undefined;
}

export function networkOverrideLabel(value: NetworkOverride): string {
  if (value === "allow") return "允许出网";
  if (value === "deny") return "禁止出网";
  return "继承项目默认";
}

export function hasQuickStartWritePermission(status: AuthStatus | null, me: AuthMe | null): boolean {
  if (status && !status.auth_required) return true;
  if (!me?.authenticated || !me.actor) return false;
  if (me.actor.role === "admin" || me.actor.role === "operator") return true;
  const scopes = new Set(me.actor.scopes);
  return scopes.has("admin") || (scopes.has("projects:write") && scopes.has("tasks:write"));
}

export function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:->|\bstatus\s*)\s*(?:401|403)\b/.test(message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "未知错误");
}

export function readinessFailures(readiness: ReadinessResponse): ReadinessCheck[] {
  return readiness.checks.filter((check) => check.state === "fail" || check.state === "attention");
}

export function quickStartNetworkQuery(value: NetworkOverride): { allow_egress?: boolean } {
  const allow_egress = networkOverrideValue(value);
  return allow_egress === undefined ? {} : { allow_egress };
}

export function quickStartTaskPayload(input: Pick<QuickStartInput, "title" | "goal" | "networkOverride">): QuickStartTaskPayload {
  const allow_egress = networkOverrideValue(input.networkOverride);
  return {
    title: input.title.trim(),
    content: input.goal.trim(),
    ...(allow_egress === undefined ? {} : { allow_egress }),
  };
}

/**
 * The Scheduler task endpoint is atomic. Project creation is intentionally kept
 * ahead of readiness and task creation, so a failed preflight never creates a
 * pending Job. If the later task call fails, the new project remains reusable.
 */
export async function runQuickStart(input: QuickStartInput, client: QuickStartApi): Promise<QuickStartResult> {
  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!title) return { kind: "invalid", message: "请先写一个任务标题。" };
  if (!goal) return { kind: "invalid", message: "请补充目标，平台需要它来决定第一步。" };

  let project = input.project;
  if (!project && input.newProject?.name.trim()) {
    project = await client.createProject({
      name: input.newProject.name.trim(),
      ...(input.newProject.description?.trim() ? { description: input.newProject.description.trim() } : {}),
    });
  }
  if (!project) return { kind: "invalid", message: "请选择一个项目，或创建一个新的项目空间。" };

  const readiness = await client.readiness(project.id, quickStartNetworkQuery(input.networkOverride));
  if (!readiness.ready) return { kind: "readiness_failed", project, readiness };

  const task = await client.createTask(project.id, quickStartTaskPayload({ title, goal, networkOverride: input.networkOverride }));
  return { kind: "success", project, task };
}
