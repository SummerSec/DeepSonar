import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMe, AuthStatus, Project } from "./api.js";
import {
  createProjectSpace,
  hasActiveProjects,
  hasLaunchWritePermission,
  hasProjectWritePermission,
  hasQuickStartWritePermission,
  hasTaskWritePermission,
  hasNewProjectIntent,
  hasQuickStartRailIntent,
  isPermissionError,
  networkOverrideValue,
  newProjectIntentSearch,
  quickStartRailIntentSearch,
  quickStartNetworkQuery,
  quickStartTaskPayload,
  resolveReadinessFix,
  readinessFailures,
  runQuickStart,
  shouldShowNewProjectForm,
  shouldShowQuickStartRail,
  type QuickStartApi,
} from "./dashboard-quick-start.js";
import type { ReadinessResponse } from "@deepsonar/shared-types";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "本地项目",
  description: "",
  status: "active",
};

const readiness = (ready: boolean): ReadinessResponse => ({
  schema: "deepsonar.readiness/v1",
  ready,
  execution_mode: "fake",
  scope: { kind: "project", project_id: project.id },
  network_policy: { allow_egress: false, source: "project", material_source: "unspecified" },
  checks: ready
    ? [{ code: "HUB_ROLE_READY", state: "pass", severity: "info", message: "Hub 已就绪" }]
    : [{ code: "CREDENTIAL_MISSING", state: "fail", severity: "error", message: "缺少模型凭据", fix: { href: "/settings?tab=credentials", target: "凭据设置" } }],
  summary: ready ? { errors: 0, warnings: 0, infos: 1 } : { errors: 1, warnings: 0, infos: 0 },
  generated_at: "2026-08-04T00:00:00.000Z",
});

function actor(overrides: Partial<NonNullable<AuthMe["actor"]>>): AuthMe {
  return {
    auth_required: true,
    authenticated: true,
    user: null,
    actor: { type: "user", name: "operator", role: "operator", scopes: [], ...overrides },
  };
}

const authStatus: AuthStatus = {
  auth_required: true,
  has_users: true,
  bootstrap_available: false,
  default_admin_credentials_active: false,
  session_ttl_days: 7,
};

test("new-project intent query is deterministic and preserves unrelated params", () => {
  const search = newProjectIntentSearch("?source=projects&intent=old", true);
  assert.equal(search, "?source=projects&intent=new-project");
  assert.equal(hasNewProjectIntent(search), true);
  assert.equal(newProjectIntentSearch(search, false), "?source=projects");
  assert.equal(hasNewProjectIntent("?source=projects"), false);
  assert.equal(quickStartRailIntentSearch("", true), "?intent=quick-start");
  assert.equal(hasQuickStartRailIntent("?intent=quick-start"), true);
  assert.equal(hasQuickStartRailIntent("?intent=new-project"), false);
});

test("creating a project is the cold-start path; quick-start rail is only explicit", () => {
  const active = [{ status: "active" as const }];
  const archived = [{ status: "archived" as const }];
  assert.equal(hasActiveProjects(active), true);
  assert.equal(hasActiveProjects(archived), false);
  assert.equal(shouldShowNewProjectForm({ projects: active, loaded: true, loadError: null, forced: false }), false);
  assert.equal(shouldShowNewProjectForm({ projects: [], loaded: true, loadError: null, forced: false }), true);
  assert.equal(shouldShowNewProjectForm({ projects: archived, loaded: true, loadError: null, forced: false }), true);
  assert.equal(shouldShowNewProjectForm({ projects: [], loaded: false, loadError: null, forced: false }), false);
  assert.equal(shouldShowNewProjectForm({ projects: [], loaded: true, loadError: new Error("offline"), forced: false }), false);
  assert.equal(shouldShowNewProjectForm({ projects: active, loaded: true, loadError: new Error("stale"), forced: true }), true);
  assert.equal(shouldShowQuickStartRail({ projects: [], loaded: true, loadError: null, forced: false }), false);
  assert.equal(shouldShowQuickStartRail({ projects: active, loaded: true, loadError: new Error("stale"), forced: true }), true);
});

test("empty project space creates a project without readiness or a task", async () => {
  const calls: string[] = [];
  const client: QuickStartApi = {
    createProject: async (input) => { calls.push(`project:${input.name}:${input.image_strategy}`); return project; },
    readiness: async () => { calls.push("readiness"); return readiness(true); },
    createTask: async () => { calls.push("task"); return { canvas_id: "canvas", job: { id: "job", status: "pending" } }; },
  };
  const invalid = await createProjectSpace({ name: "  " }, client);
  assert.deepEqual(invalid, { kind: "invalid", message: "请填写项目名称。" });
  assert.deepEqual(calls, []);
  const created = await createProjectSpace({ name: " 空项目 ", description: "边界", imageStrategy: "project_managed" }, client);
  assert.equal(created.kind, "success");
  assert.deepEqual(calls, ["project:空项目:project_managed"]);
});

test("empty quick-start input requires an inline project before any API call", async () => {
  const calls: string[] = [];
  const client: QuickStartApi = {
    createProject: async () => { calls.push("project"); return project; },
    readiness: async () => { calls.push("readiness"); return readiness(true); },
    createTask: async () => { calls.push("task"); return { canvas_id: "canvas", job: { id: "job", status: "pending" } }; },
  };

  const result = await runQuickStart({ title: "", goal: "", project: null, newProject: null, networkOverride: "inherit" }, client);
  assert.deepEqual(result, { kind: "invalid", message: "请先写一个任务标题。" });
  assert.deepEqual(calls, []);
});

test("ready preflight creates a task and keeps the selected network override", async () => {
  const requests: Array<{ kind: string; payload?: unknown }> = [];
  const client: QuickStartApi = {
    createProject: async () => { requests.push({ kind: "project" }); return project; },
    readiness: async (_id, options) => { requests.push({ kind: "readiness", payload: options }); return readiness(true); },
    createTask: async (_id, payload) => { requests.push({ kind: "task", payload }); return { canvas_id: "canvas", job: { id: "job", status: "pending" } }; },
  };

  const result = await runQuickStart({
    title: "  检查登录边界 ",
    goal: "  找到可复现证据  ",
    project,
    newProject: null,
    networkOverride: "deny",
  }, client);
  assert.equal(result.kind, "success");
  assert.deepEqual(requests, [
    { kind: "readiness", payload: { allow_egress: false } },
    { kind: "task", payload: { title: "检查登录边界", content: "找到可复现证据", allow_egress: false } },
  ]);
});

test("快捷创建把项目镜像策略传给项目 API", async () => {
  let createdInput: { name: string; description?: string; image_strategy?: string } | null = null;
  const client: QuickStartApi = {
    createProject: async (input) => {
      createdInput = input;
      return project;
    },
    readiness: async () => readiness(true),
    createTask: async () => ({ canvas_id: "canvas", job: { id: "job", status: "pending" } }),
  };

  const result = await runQuickStart({
    title: "检查镜像策略",
    goal: "确认项目使用项目托管镜像",
    project: null,
    newProject: { name: "策略项目" },
    imageStrategy: "project_managed",
    networkOverride: "inherit",
  }, client);
  assert.equal(result.kind, "success");
  assert.equal((createdInput as { image_strategy?: string } | null)?.image_strategy, "project_managed");
});

test("readiness failure exposes repair links and prevents task creation", async () => {
  const calls: string[] = [];
  const client: QuickStartApi = {
    createProject: async () => { calls.push("project"); return project; },
    readiness: async () => { calls.push("readiness"); return readiness(false); },
    createTask: async () => { calls.push("task"); return { canvas_id: "canvas", job: { id: "job", status: "pending" } }; },
  };

  const result = await runQuickStart({
    title: "调查凭据",
    goal: "确认模型连接",
    project: null,
    newProject: { name: "新项目" },
    networkOverride: "inherit",
  }, client);
  assert.equal(result.kind, "readiness_failed");
  if (result.kind === "readiness_failed") {
    assert.equal(result.project.name, "本地项目");
    assert.equal(readinessFailures(result.readiness)[0]?.fix?.href, "/settings?tab=credentials");
    assert.equal(resolveReadinessFix(readinessFailures(result.readiness)[0]?.fix, result.readiness.scope, result.project.id)?.href, "/settings/credentials");
  }
  assert.deepEqual(calls, ["project", "readiness"]);
});

test("permission denial recognizes viewer, project-only tokens, and HTTP 403 responses", () => {
  assert.equal(hasQuickStartWritePermission(authStatus, actor({ role: "viewer", scopes: ["projects:read", "tasks:read"] })), false);
  assert.equal(hasProjectWritePermission(authStatus, actor({ role: "viewer", scopes: ["projects:read"] })), false);
  assert.equal(hasProjectWritePermission(authStatus, actor({ role: "viewer", scopes: ["projects:write"] })), true);
  assert.equal(hasTaskWritePermission(authStatus, actor({ role: "viewer", scopes: ["tasks:write"] })), true);
  assert.equal(hasLaunchWritePermission(authStatus, actor({ role: "viewer", scopes: ["tasks:write"] }), false), true);
  assert.equal(hasLaunchWritePermission(authStatus, actor({ role: "viewer", scopes: ["tasks:write"] }), true), false);
  assert.equal(hasQuickStartWritePermission(authStatus, actor({ role: "viewer", scopes: ["projects:write"] })), false);
  assert.equal(hasQuickStartWritePermission(authStatus, actor({ role: "operator", scopes: [] })), true);
  assert.equal(hasProjectWritePermission(authStatus, actor({ role: "operator", scopes: [] })), true);
  assert.equal(hasQuickStartWritePermission({ ...authStatus, auth_required: false }, null), true);
  assert.equal(isPermissionError(new Error("POST /projects -> 403: FORBIDDEN")), true);
  assert.equal(isPermissionError(new Error("GET /readiness -> 500")), false);
});

test("network advanced override maps only to the governed task boundary", () => {
  assert.equal(networkOverrideValue("inherit"), undefined);
  assert.deepEqual(quickStartNetworkQuery("inherit"), {});
  assert.deepEqual(quickStartNetworkQuery("allow"), { allow_egress: true });
  assert.deepEqual(quickStartTaskPayload({ title: "title", goal: "goal", networkOverride: "allow" }), {
    title: "title",
    content: "goal",
    allow_egress: true,
  });
});

test("readiness repair actions resolve every global and project route", () => {
  const globalScope = { kind: "global" as const, project_id: null };
  const projectScope = { kind: "project" as const, project_id: project.id };
  const actions = ["credentials", "role_config", "rules", "runtime_images"] as const;
  const expectedGlobal = {
    credentials: "/settings/credentials",
    role_config: "/agents?tab=roles",
    rules: "/settings/platform?tab=rules",
    runtime_images: "/images",
  };
  const expectedProject = {
    credentials: "/settings/credentials",
    role_config: `/projects/${project.id}/settings?tab=roles`,
    rules: `/projects/${project.id}/settings?tab=rules`,
    runtime_images: `/projects/${project.id}/images`,
  };
  for (const action of actions) {
    const global = resolveReadinessFix({ action, scope: "global", project_id: null, href: "/stale", target: action }, globalScope);
    assert.equal(global?.href, expectedGlobal[action]);
    const projectFix = resolveReadinessFix({ action, scope: "project", project_id: project.id, href: "/stale", target: action }, projectScope);
    assert.equal(projectFix?.href, expectedProject[action]);
  }
  const projectSelection = resolveReadinessFix({ action: "runtime_images", scope: "project", project_id: null, href: "/stale", target: "runtime-images" }, globalScope);
  assert.equal(projectSelection?.href, "/projects");
  const projectSelectionWithProjectScope = resolveReadinessFix({ action: "runtime_images", scope: "project", project_id: null, href: "/stale", target: "runtime-images" }, projectScope, project.id);
  assert.equal(projectSelectionWithProjectScope?.href, "/projects");
});

test("readiness fixes without action keep the Scheduler href", () => {
  const projectScope = { kind: "project" as const, project_id: project.id };
  assert.equal(resolveReadinessFix({ href: "/settings/credentials", target: "credentials" }, projectScope)?.href, "/settings/credentials");
});

test("IntentLaunchRail surfaces local image identity and a prepare link", async () => {
  const { readFileSync } = await import("node:fs");
  const rail = readFileSync(new URL("./components/IntentLaunchRail.tsx", import.meta.url), "utf8");
  assert.match(rail, /hasLaunchWritePermission/);
  assert.match(rail, /RUNTIME_IMAGE_NOT_LOCAL/);
  assert.match(rail, /去市场准备/);
  assert.match(rail, /runtime_image\.digest/);
  assert.match(rail, /runtime_image\.version/);
});

test("ProjectsPage creates an empty project without hijacking new-project into a task rail", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("./pages/ProjectsPage.tsx", import.meta.url), "utf8");
  const form = readFileSync(new URL("./components/NewProjectForm.tsx", import.meta.url), "utf8");
  assert.match(page, /NewProjectForm/);
  assert.match(page, /shouldShowNewProjectForm/);
  assert.match(page, /quickStartRailIntentSearch/);
  assert.match(form, /createProjectSpace/);
  assert.match(form, /navigate\(`\/projects\/\$\{result\.project\.id\}\/tasks`\)/);
  assert.match(form, /不会创建任务、画布或 Job/);
  assert.doesNotMatch(form, /createTask/);
});
