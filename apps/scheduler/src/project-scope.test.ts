import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  canvasScopeDecision,
  isProjectScopedActor,
  isUuid,
  PROJECT_MISMATCH,
  projectScopeAllows,
  resolveActorProjectId,
} from "./project-scope.js";
import { projectScopeHook } from "./project-scope-hook.js";

test("project scope allows same project and internal actors only", () => {
  assert.equal(projectScopeAllows(null, "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-b"), false);
});

test("project actors cannot aim a write at another project id", () => {
  assert.equal(isProjectScopedActor("project-a"), true);
  assert.equal(isProjectScopedActor(null), false);
  assert.deepEqual(resolveActorProjectId("project-a", undefined), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveActorProjectId("project-a", "project-a"), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveActorProjectId("project-a", "project-b"), { ok: false, error_code: PROJECT_MISMATCH });
  assert.deepEqual(resolveActorProjectId(null, "project-b"), { ok: true, projectId: "project-b" });
});

test("resource UUID validation rejects malformed route ids before SQL", () => {
  assert.equal(isUuid("00000000-0000-0000-0000-000000000001"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(undefined), false);
});

test("canvas ownership distinguishes unknown and cross-project resources", () => {
  assert.equal(canvasScopeDecision("project-a", undefined), "not_found");
  assert.equal(canvasScopeDecision("project-a", "project-b"), "mismatch");
  assert.equal(canvasScopeDecision("project-a", "project-a"), "allow");
});

type CapturedReply = { code?: number; body?: unknown };

function fakeRequest(
  url: string,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
  method = "GET",
): FastifyRequest {
  return { routeOptions: { url }, params, query, method, body: undefined } as unknown as FastifyRequest;
}

function fakeReply(state: CapturedReply): FastifyReply {
  const reply = {
    code(value: number) {
      state.code = value;
      return reply;
    },
    send(value: unknown) {
      state.body = value;
      return reply;
    },
  };
  return reply as unknown as FastifyReply;
}

// #489：管理端点非 UUID 路径/查询 id 必须在进 SQL 前返回 400 INVALID_ID，
// 而不是让 Postgres 抛 22P02 再变成 500。无 project 作用域的 admin token
// （actor 为空）同样要命中——旧实现把 /projects/:id 校验放在了 actor 早退之后。
test("UUID guard rejects malformed route ids on management routes before SQL", async () => {
  const admin = {} as FastifyRequest["actor"];
  const cases: Array<{ url: string; params?: Record<string, string>; query?: Record<string, string> }> = [
    { url: "/projects/:id", params: { id: "not-a-uuid" } },
    { url: "/projects/:id/canvases", params: { id: "x" } },
    { url: "/projects/:id/settings", params: { id: "x" } },
    { url: "/projects/:id/quality", params: { id: "x" } },
    { url: "/projects/:id/quality/replay", params: { id: "x" } },
    { url: "/projects/:id/exports", params: { id: "x" } },
    { url: "/projects/:id/archive", params: { id: "x" } },
    { url: "/projects/:id/readiness", params: { id: "x" } },
    { url: "/projects/:id/runtime-images/:imageId", params: { id: "00000000-0000-4000-8000-000000000001", imageId: "x" } },
    { url: "/credentials/:id", params: { id: "x" } },
    { url: "/credentials/:id/impact", params: { id: "x" } },
    { url: "/credentials/:id/models", params: { id: "x" } },
    { url: "/credentials/:id/test", params: { id: "x" } },
    { url: "/credentials/:id/rotate", params: { id: "x" } },
    { url: "/credentials/:id/status", params: { id: "x" } },
    { url: "/skill-sources/:id", params: { id: "x" } },
    { url: "/skill-sources/:id/sync", params: { id: "x" } },
    { url: "/skill-sources/:id/trust", params: { id: "x" } },
    { url: "/runtime-image-versions/:id/usage", params: { id: "x" } },
    { url: "/runtime-image-versions/:id/rescan", params: { id: "x" } },
    { url: "/runtime-image-versions/:id/status", params: { id: "x" } },
    { url: "/runtime-images/:id/official-digest", params: { id: "x" } },
    { url: "/tokens/:id/revoke", params: { id: "x" } },
    { url: "/runtime-images", query: { project_id: "not-a-uuid" } },
    // #490: overview/ops silently ignored a malformed project_id and returned
    // global data as if it were the caller's scope.
    { url: "/dashboard/overview", query: { project_id: "not-a-uuid" } },
    { url: "/dashboard/ops", query: { project_id: "not-a-uuid" } },
    { url: "/dashboard/overview", query: { canvas_id: "not-a-uuid" } },
    { url: "/projects/:id/quality", params: { id: "00000000-0000-4000-8000-000000000001" }, query: { canvas_id: "not-a-uuid" } },
    { url: "/projects/:id/quality/replay", params: { id: "00000000-0000-4000-8000-000000000001" }, query: { canvas_id: "not-a-uuid" } },
  ];
  for (const item of cases) {
    const state: CapturedReply = {};
    const req = fakeRequest(item.url, item.params ?? {}, item.query ?? {});
    // admin token: no actor project scope; the guard must still run.
    (req as { actor?: unknown }).actor = admin;
    await projectScopeHook(req, fakeReply(state));
    assert.equal(state.code, 400, item.url);
    assert.equal((state.body as { error_code?: string }).error_code, "INVALID_ID", item.url);
  }
});

test("UUID guard lets valid ids pass (no early 400)", async () => {
  const state: CapturedReply = {};
  const req = fakeRequest("/projects/:id", { id: "00000000-0000-4000-8000-000000000001" });
  await projectScopeHook(req, fakeReply(state));
  assert.equal(state.code, undefined);
  assert.equal(state.body, undefined);
});
