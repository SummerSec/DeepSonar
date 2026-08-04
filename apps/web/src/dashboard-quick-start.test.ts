import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMe, AuthStatus, Project } from "./api.js";
import {
  hasQuickStartWritePermission,
  isPermissionError,
  networkOverrideValue,
  quickStartNetworkQuery,
  quickStartTaskPayload,
  readinessFailures,
  runQuickStart,
  type QuickStartApi,
} from "./dashboard-quick-start.js";
import type { ReadinessResponse } from "@deepsonar/shared-types";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  plane_project_id: null,
  canvas_id: "22222222-2222-4222-8222-222222222222",
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
  }
  assert.deepEqual(calls, ["project", "readiness"]);
});

test("permission denial recognizes viewer and HTTP 403 responses", () => {
  assert.equal(hasQuickStartWritePermission(authStatus, actor({ role: "viewer", scopes: ["projects:read", "tasks:read"] })), false);
  assert.equal(hasQuickStartWritePermission(authStatus, actor({ role: "operator", scopes: [] })), true);
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
