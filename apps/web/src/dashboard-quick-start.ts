import type {
  AuthMe,
  AuthStatus,
  Project,
  ProjectImageStrategy,
} from "./api";
import type { ReadinessCheck, ReadinessFixAction, ReadinessResponse } from "@deepsonar/shared-types";

export const NEW_PROJECT = "__new_project__" as const;
export const LAST_PROJECT_STORAGE_KEY = "deepsonar:last-project-id";
export const QUICK_START_INTENT_PARAM = "intent";
export const QUICK_START_INTENT_VALUE = "new-project";
export const QUICK_START_RAIL_INTENT_VALUE = "quick-start";

export type NetworkOverride = "inherit" | "allow" | "deny";

/**
 * The project page owns the quick-start entry point. Keep the URL contract
 * small and deterministic so refresh/back never depends on React state or a
 * draft stored in the browser.
 */
export function hasNewProjectIntent(search: string | URLSearchParams): boolean {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(QUICK_START_INTENT_PARAM) === QUICK_START_INTENT_VALUE;
}

function intentSearch(search: string | URLSearchParams, intent: string | null): string {
  const params = typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search);
  if (intent) params.set(QUICK_START_INTENT_PARAM, intent);
  else params.delete(QUICK_START_INTENT_PARAM);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function newProjectIntentSearch(search: string | URLSearchParams, enabled: boolean): string {
  return intentSearch(search, enabled ? QUICK_START_INTENT_VALUE : null);
}

export function hasQuickStartRailIntent(search: string | URLSearchParams): boolean {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.get(QUICK_START_INTENT_PARAM) === QUICK_START_RAIL_INTENT_VALUE;
}

export function quickStartRailIntentSearch(search: string | URLSearchParams, enabled: boolean): string {
  return intentSearch(search, enabled ? QUICK_START_RAIL_INTENT_VALUE : null);
}

export function hasActiveProjects(projects: readonly Pick<Project, "status">[]): boolean {
  return projects.some((project) => project.status === "active");
}

export interface QuickStartVisibilityInput {
  projects: readonly Pick<Project, "status">[];
  loaded: boolean;
  loadError: unknown | null;
  forced: boolean;
}

/**
 * Explicit intent always wins. Automatic cold-start is only safe after a
 * successful project-list response; an empty array caused by a load failure
 * must not be mistaken for an empty account.
 */
export function shouldShowNewProjectForm(input: QuickStartVisibilityInput): boolean {
  if (input.forced) return true;
  if (!input.loaded || input.loadError) return false;
  return !hasActiveProjects(input.projects);
}

/** Quick-start is optional. It never hijacks 「新建项目」 or empty-account cold start. */
export function shouldShowQuickStartRail(input: QuickStartVisibilityInput): boolean {
  return input.forced;
}

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
  createProject: (input: { name: string; description?: string; image_strategy?: ProjectImageStrategy }) => Promise<Project>;
  readiness: (projectId: string, options?: { allow_egress?: boolean }) => Promise<ReadinessResponse>;
  createTask: (projectId: string, payload: QuickStartTaskPayload) => Promise<{ canvas_id: string; job: { id: string; status: string } }>;
}

export interface QuickStartInput {
  title: string;
  goal: string;
  project: Project | null;
  newProject?: { name: string; description?: string } | null;
  imageStrategy?: ProjectImageStrategy;
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

export function hasProjectWritePermission(status: AuthStatus | null, me: AuthMe | null): boolean {
  if (status && !status.auth_required) return true;
  if (!me?.authenticated || !me.actor) return false;
  if (me.actor.role === "admin" || me.actor.role === "operator") return true;
  const scopes = new Set(me.actor.scopes);
  return scopes.has("admin") || scopes.has("projects:write");
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

const READINESS_FIX_ACTIONS: ReadonlySet<ReadinessFixAction> = new Set([
  "credentials",
  "role_config",
  "rules",
  "runtime_images",
]);

function isReadinessFixAction(value: unknown): value is ReadinessFixAction {
  return typeof value === "string" && READINESS_FIX_ACTIONS.has(value as ReadinessFixAction);
}

function projectIdFromLegacyHref(href: string): string | null {
  return href.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] ?? null;
}

/**
 * Resolve the Scheduler's stable repair intent to a route that exists in the
 * current web app.  The legacy href is only used when an older Scheduler did
 * not provide action metadata; known legacy settings paths are normalized too.
 */
export function resolveReadinessFix(
  fix: ReadinessCheck["fix"],
  readinessScope: ReadinessResponse["scope"],
  fallbackProjectId: string | null = null,
): { href: string; target: string } | null {
  if (!fix) return null;
  const action = isReadinessFixAction(fix.action) ? fix.action : null;
  const targetScope = fix.scope ?? (readinessScope.project_id ? "project" : "global");
  const projectId = fix.project_id !== undefined
    ? fix.project_id
    : readinessScope.project_id ?? fallbackProjectId ?? projectIdFromLegacyHref(fix.href);

  if (action === "credentials") {
    return { href: "/settings/credentials", target: fix.target };
  }
  if (action === "role_config") {
    return {
      href: targetScope === "project" && projectId ? `/projects/${projectId}/settings?tab=roles` : "/agents?tab=roles",
      target: fix.target,
    };
  }
  if (action === "rules") {
    return {
      href: targetScope === "project" && projectId ? `/projects/${projectId}/settings?tab=rules` : "/settings/platform?tab=rules",
      target: fix.target,
    };
  }
  if (action === "runtime_images") {
    return {
      href: targetScope === "project" ? (projectId ? `/projects/${projectId}/images` : "/projects") : "/images",
      target: fix.target,
    };
  }

  // Backward compatibility for pre-action Scheduler responses.  Credentials
  // are always managed globally; project settings only expose roles/rules.
  if (fix.href === "/global-settings") {
    return {
      href: readinessScope.project_id ? `/projects/${readinessScope.project_id}/settings?tab=rules` : "/settings/platform?tab=rules",
      target: fix.target,
    };
  }
  if (fix.href.includes("tab=credentials")) {
    return { href: "/settings/credentials", target: fix.target };
  }
  if (fix.target === "hub-settings" || fix.target === "task-network-policy" || fix.target === "task-material-source") {
    return {
      href: readinessScope.project_id ? `/projects/${readinessScope.project_id}/settings?tab=rules` : "/settings/platform?tab=rules",
      target: fix.target,
    };
  }
  return { href: fix.href, target: fix.target };
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

export interface CreateProjectSpaceInput {
  name: string;
  description?: string;
  imageStrategy?: ProjectImageStrategy;
}

export type CreateProjectSpaceResult =
  | { kind: "invalid"; message: string }
  | { kind: "success"; project: Project };

/** Create a project space without a canvas, Hub job, or task preflight. */
export async function createProjectSpace(
  input: CreateProjectSpaceInput,
  client: Pick<QuickStartApi, "createProject">,
): Promise<CreateProjectSpaceResult> {
  const name = input.name.trim();
  if (!name) return { kind: "invalid", message: "请填写项目名称。" };
  const project = await client.createProject({
    name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    image_strategy: input.imageStrategy ?? "inherit_global",
  });
  return { kind: "success", project };
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
      image_strategy: input.imageStrategy ?? "inherit_global",
    });
  }
  if (!project) return { kind: "invalid", message: "请选择一个项目，或创建一个新的项目空间。" };

  const readiness = await client.readiness(project.id, quickStartNetworkQuery(input.networkOverride));
  if (!readiness.ready) return { kind: "readiness_failed", project, readiness };

  const task = await client.createTask(project.id, quickStartTaskPayload({ title, goal, networkOverride: input.networkOverride }));
  return { kind: "success", project, task };
}
