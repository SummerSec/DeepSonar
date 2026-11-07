import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { api, type AuthMe, type AuthStatus, type Project } from "./api.js";
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
import { buildRepairFeedback, type ReadinessResponse } from "@deepsonar/shared-types";

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
    : [{ code: "CREDENTIAL_MISSING", state: "fail", severity: "error", message: "缺少模型凭据", fix: { action: "credentials", scope: "global", project_id: null, href: "/settings/credentials", target: "credentials" } }],
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
    createProject: async (input) => { calls.push(`project:${input.name}:${input.description ?? ""}`); return project; },
    readiness: async () => { calls.push("readiness"); return readiness(true); },
    createTask: async () => { calls.push("task"); return { canvas_id: "canvas", job: { id: "job", status: "pending" } }; },
  };
  const invalid = await createProjectSpace({ name: "  " }, client);
  assert.deepEqual(invalid, { kind: "invalid", message: "请填写项目名称。" });
  assert.deepEqual(calls, []);
  const created = await createProjectSpace({ name: " 空项目 ", description: "边界" }, client);
  assert.equal(created.kind, "success");
  assert.deepEqual(calls, ["project:空项目:边界"]);
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

test("快捷创建新建项目不再附带镜像策略字段", async () => {
  const createdPayloads: Array<Record<string, unknown>> = [];
  const client: QuickStartApi = {
    createProject: async (input) => {
      createdPayloads.push({ ...input });
      return project;
    },
    readiness: async () => readiness(true),
    createTask: async () => ({ canvas_id: "canvas", job: { id: "job", status: "pending" } }),
  };

  const result = await runQuickStart({
    title: "检查镜像策略",
    goal: "确认项目不再托管镜像缺省",
    project: null,
    newProject: { name: "策略项目" },
    networkOverride: "inherit",
  }, client);
  assert.equal(result.kind, "success");
  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0]?.name, "策略项目");
  assert.equal(Object.prototype.hasOwnProperty.call(createdPayloads[0] ?? {}, "image_strategy"), false);
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
    assert.equal(readinessFailures(result.readiness)[0]?.fix?.href, "/settings/credentials");
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
    runtime_images: `/images?project_id=${project.id}`,
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
  const binding = resolveReadinessFix({
    action: "role_config",
    scope: "global",
    project_id: null,
    href: "/settings/credentials",
    target: "role-credential-binding",
  }, globalScope);
  assert.equal(binding?.href, "/settings/credentials");
  const bindingFromRoleHref = resolveReadinessFix({
    action: "role_config",
    scope: "project",
    project_id: project.id,
    href: `/projects/${project.id}/settings?tab=roles`,
    target: "role-credential-binding",
  }, { kind: "project", project_id: project.id });
  assert.equal(bindingFromRoleHref?.href, "/settings/credentials");
});

test("readiness fixes without action keep the Scheduler href", () => {
  const projectScope = { kind: "project" as const, project_id: project.id };
  assert.equal(resolveReadinessFix({ href: "/settings/credentials", target: "credentials" }, projectScope)?.href, "/settings/credentials");
});

test("IntentLaunchRail no longer special-cases leftover local inspect failures", async () => {
  const { readFileSync } = await import("node:fs");
  const rail = readFileSync(new URL("./components/IntentLaunchRail.tsx", import.meta.url), "utf8");
  assert.match(rail, /hasLaunchWritePermission/);
  assert.doesNotMatch(rail, /RUNTIME_IMAGE_NOT_LOCAL|去市场准备/);
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

test("a legacy create with contract warning remains a successful handoff", async () => {
  const warning = { code: "task_contract_not_assessed", path: "task_contract", message: "未评估", suggestion: "可补充契约" };
  let creates = 0;
  const result = await runQuickStart({ title: "目标", goal: "原始需求", project, networkOverride: "inherit" }, {
    createProject: async () => project,
    readiness: async () => readiness(true),
    createTask: async (_id, payload) => {
      creates += 1;
      assert.equal(payload.task_contract, undefined);
      return { canvas_id: "created-canvas", job: { id: "created-job", status: "pending" }, task_contract_warnings: [warning] };
    },
  });
  assert.equal(creates, 1);
  assert.equal(result.kind, "success");
  if (result.kind !== "success") assert.fail("created task must remain available");
  assert.equal(result.task.canvas_id, "created-canvas");
  assert.deepEqual(result.task.task_contract_warnings, [warning]);
});

test("#969 real quick-start preflight shows safe model conflicts without creating a task or leaking another project's feedback", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const original = { authStatus: api.authStatus, readiness: api.readiness, createTask: api.createTask, health: api.health };
  const projectB: Project = { ...project, id: "22222222-2222-4222-8222-222222222222", name: "项目 B" };
  const modelConflict: ReadinessResponse = {
    ...readiness(false),
    checks: [{
      code: "HUB_SNAPSHOT_UNRESOLVABLE", state: "fail", severity: "error", message: "项目 A 模型配置冲突",
      fix: { action: "role_config", scope: "project", project_id: project.id,
        href: `/projects/${project.id}/settings?tab=roles`, target: "配置项目 A 模型" },
      repair: buildRepairFeedback({
        category: "model_correctable", code: "provider_credential_no_match", operation: "resolve_agent_snapshot",
        path: "model_ref", message: "raw-provider-diagnostic-must-not-render",
        expected: { kind: "project_authorized_model", model_ref: "role-default", sample: ["vendor/model-a"] },
      }),
    }],
  };
  const readinessProjects: string[] = [];
  let taskCreates = 0;
  let delayReadiness = false;
  const deferred: { resolve?: (result: ReadinessResponse) => void } = {};
  api.authStatus = async () => ({ ...authStatus, auth_required: false });
  api.health = async () => ({
    ok: true, ready: true, version: "fixture", ts: 0,
    runtime_images: { status: "ready", error: null, retry_at: null },
    dispatcher: { enabled: true, started_at: null },
    opensandbox: { level: "skipped", domain: "", ready: true },
  });
  api.readiness = async (projectId) => {
    assert.equal(projectId, project.id, "both submitted preflights belong to project A");
    readinessProjects.push(projectId);
    return delayReadiness ? new Promise<ReadinessResponse>((resolve) => { deferred.resolve = resolve; }) : modelConflict;
  };
  api.createTask = async () => {
    taskCreates += 1;
    return { canvas_id: "unexpected-canvas", job: { id: "unexpected-job", status: "pending" } };
  };
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router-dom");
  const { AuthProvider } = await import("./auth.js");
  const { IntentLaunchRail } = await import("./components/IntentLaunchRail.js");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const projectSettingsHref = `/projects/${project.id}/settings?tab=roles`;
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "the real component must expose the requested control");
    assert.ok(element instanceof dom.window.HTMLElement);
    await act(async () => { element.click(); });
  };
  const chooseProject = async (name: string) => {
    await click(container.querySelector('[aria-label="项目空间"]'));
    await click(Array.from(dom.window.document.querySelectorAll('[role="option"]')).find((option) => option.textContent === name));
    assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 0, "choosing a portal option closes the real select");
  };
  const submit = async () => {
    const form = container.querySelector("form");
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  };
  const assertNoProjectAFeedback = () => {
    assert.doesNotMatch(container.textContent ?? "", /role-default|vendor\/model-a|项目 A 模型配置冲突|raw-provider-diagnostic-must-not-render/);
    assert.equal(container.querySelector(`a[href="${projectSettingsHref}"]`), null);
    assert.equal(container.querySelector(".intent-launch-readiness"), null, "the whole old-project preflight panel must stay hidden");
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(AuthProvider, {
        children: createElement(IntentLaunchRail, { projects: [project, projectB], forcedNewProject: false }),
      })));
    });
    assert.match(container.querySelector('[aria-label="项目空间"]')?.textContent ?? "", /本地项目/);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "问题调查"));
    await submit();
    assert.deepEqual(readinessProjects, [project.id]);
    assert.equal(taskCreates, 0, "a failed readiness must stop before POST /tasks");
    assert.match(container.textContent ?? "", /role-default/);
    assert.match(container.textContent ?? "", /vendor\/model-a/);
    assert.match(container.textContent ?? "", /项目 A 模型配置冲突/);
    assert.doesNotMatch(container.textContent ?? "", /raw-provider-diagnostic-must-not-render/);
    assert.ok(container.querySelector(`a[href="${projectSettingsHref}"]`), "preflight model conflicts provide the owning project's settings navigation");

    await chooseProject(projectB.name);
    assertNoProjectAFeedback();

    await chooseProject(project.name);
    delayReadiness = true;
    await submit();
    assert.deepEqual(readinessProjects, [project.id, project.id]);
    assert.ok(deferred.resolve, "the second project A readiness remains pending");
    await chooseProject(projectB.name);
    await act(async () => { deferred.resolve?.(modelConflict); });
    assert.match(container.querySelector('[aria-label="项目空间"]')?.textContent ?? "", /项目 B/);
    assertNoProjectAFeedback();
    assert.equal(taskCreates, 0, "a late failed preflight cannot create a task for either project");
  } finally {
    await act(async () => { deferred.resolve?.(modelConflict); root.unmount(); });
    api.authStatus = original.authStatus;
    api.readiness = original.readiness;
    api.createTask = original.createTask;
    api.health = original.health;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
