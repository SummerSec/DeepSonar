import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { INVALID_PAYLOAD, isPostgresParameterError, validationHttpError } from "./http-validation-error.js";
import { QueryParameterError } from "./pagination.js";
import { registerRoutes } from "./routes.js";

const FIXTURE_UUID = "11111111-1111-4111-8111-111111111111";

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/;
const ZOD_REGEX_LEAK = /\/\^|expected.*uuid|Invalid option/i;

function assertClientSafe400(response: { statusCode: number; body: string }, expectedPaths?: string[]) {
  assert.equal(response.statusCode, 400, response.body);
  const body = JSON.parse(response.body) as {
    error?: string;
    error_code?: string;
    issues?: Array<{ path: string; code: string }>;
    message?: string;
    statusCode?: number;
    stack?: string;
  };
  assert.equal(body.error_code, INVALID_PAYLOAD);
  assert.equal(body.error, "invalid request");
  assert.equal(body.statusCode, undefined);
  assert.equal(body.stack, undefined);
  assert.doesNotMatch(response.body, /Internal Server Error/);
  assert.doesNotMatch(response.body, UUID_PATTERN);
  assert.doesNotMatch(response.body, ZOD_REGEX_LEAK);
  assert.doesNotMatch(response.body, /"stack"/);
  if (expectedPaths) {
    const paths = (body.issues ?? []).map((issue) => issue.path);
    for (const path of expectedPaths) assert.ok(paths.includes(path), `missing path ${path} in ${response.body}`);
  }
}

test("ZodError maps to 400 invalid_payload without regex or enum leaks", () => {
  const parsed = z.object({
    name: z.string().min(1),
    project_id: z.string().uuid(),
    image_strategy: z.enum(["inherit_global", "project_managed"]),
  }).safeParse({
    name: 123,
    project_id: "not-a-uuid",
    image_strategy: "bogus",
  });
  assert.equal(parsed.success, false);
  const mapped = validationHttpError(parsed.error);
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.body.error_code, INVALID_PAYLOAD);
  assert.equal(mapped.body.error, "invalid request");
  const serialized = JSON.stringify(mapped.body);
  assert.doesNotMatch(serialized, UUID_PATTERN);
  assert.doesNotMatch(serialized, /inherit_global|project_managed/);
  assert.doesNotMatch(serialized, /not-a-uuid/);
  const issues = mapped.body.issues as Array<{ path: string; code: string }>;
  assert.deepEqual(new Set(issues.map((issue) => issue.path)), new Set(["name", "project_id", "image_strategy"]));
  assert.ok(issues.every((issue) => issue.code && !("message" in issue) && !("expected" in issue)));
});

test("non-validation errors are left unmapped", () => {
  assert.equal(validationHttpError(new Error("boom")), null);
  assert.equal(validationHttpError({ code: "FST_ERR_VALIDATION" })?.statusCode, 400);
});

test("Postgres parameter errors map to 400 without leaking pg code or text", () => {
  const pgError = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" });
  const mapped = validationHttpError(pgError);
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.body.error_code, INVALID_PAYLOAD);
  const serialized = JSON.stringify(mapped.body);
  assert.doesNotMatch(serialized, /22P02/);
  assert.doesNotMatch(serialized, /invalid input syntax/);
  assert.doesNotMatch(serialized, /not-a-uuid/);
  assert.equal(isPostgresParameterError(pgError), true);
  // Unrelated pg errors (e.g. unique violation) are not reclassified here.
  assert.equal(isPostgresParameterError(Object.assign(new Error("dup"), { code: "23505" })), false);
  assert.equal(validationHttpError(Object.assign(new Error("dup"), { code: "23505" })), null);
});

// #489：非 UUID 路径/查询 id 必须在进 SQL 前返回 400，而不是 500 + pg 原文。
test("management endpoints reject malformed ids with 400 INVALID_ID and no pg detail", async () => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  const paths: Array<[string, string]> = [
    ["GET", "/projects/not-a-uuid"],
    ["GET", "/projects/not-a-uuid/canvases"],
    ["GET", "/projects/not-a-uuid/settings"],
    ["GET", "/projects/not-a-uuid/quality"],
    ["GET", "/projects/not-a-uuid/quality/replay"],
    ["GET", "/projects/not-a-uuid/exports"],
    ["GET", "/projects/not-a-uuid/readiness"],
    ["PATCH", "/projects/not-a-uuid"],
    ["POST", "/projects/not-a-uuid/archive"],
    ["PATCH", "/projects/not-a-uuid/settings"],
    ["POST", "/projects/not-a-uuid/exports"],
    ["PUT", "/projects/not-a-uuid/runtime-images/not-a-uuid"],
    ["GET", "/runtime-image-versions/not-a-uuid/usage"],
    ["POST", "/runtime-image-versions/not-a-uuid/rescan"],
    ["POST", "/runtime-image-versions/not-a-uuid/status"],
    ["POST", "/runtime-images/not-a-uuid/official-digest"],
    ["GET", "/skill-sources/not-a-uuid"],
    ["DELETE", "/skill-sources/not-a-uuid"],
    ["POST", "/skill-sources/not-a-uuid/trust"],
    ["POST", "/skill-sources/not-a-uuid/sync"],
    ["GET", "/credentials/not-a-uuid"],
    ["GET", "/credentials/not-a-uuid/impact"],
    ["GET", "/credentials/not-a-uuid/models"],
    ["DELETE", "/credentials/not-a-uuid"],
    ["POST", "/credentials/not-a-uuid/test"],
    ["POST", "/credentials/not-a-uuid/models"],
    ["POST", "/credentials/not-a-uuid/rotate"],
    ["POST", "/credentials/not-a-uuid/status"],
    ["POST", "/tokens/not-a-uuid/revoke"],
    ["GET", "/runtime-images?project_id=not-a-uuid"],
    ["GET", "/dashboard/overview?project_id=not-a-uuid"],
    ["GET", "/dashboard/ops?project_id=not-a-uuid"],
    ["GET", `/projects/${FIXTURE_UUID}/quality?canvas_id=not-a-uuid`],
  ];
  try {
    for (const [method, url] of paths) {
      const response = await app.inject({ method: method as "GET", url });
      assert.equal(response.statusCode, 400, `${method} ${url} -> ${response.statusCode} ${response.body}`);
      const body = JSON.parse(response.body) as { error_code?: string; error?: string };
      assert.equal(body.error_code, "INVALID_ID", `${method} ${url}`);
      assert.doesNotMatch(response.body, /22P02|invalid input syntax|Internal Server Error|"stack"/, `${method} ${url}`);
      assert.doesNotMatch(response.body, UUID_PATTERN, `${method} ${url}`);
    }
  } finally {
    await app.close();
  }
});

test("malformed query parameters map to 400 invalid_payload instead of a silent default", () => {
  const mapped = validationHttpError(new QueryParameterError("limit"));
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.body.error_code, INVALID_PAYLOAD);
  assert.deepEqual(mapped.body.issues, [{ path: "limit", code: "invalid_query" }]);
});

// #490：分页与枚举参数非法必须 400，而不是静默按缺省值返回 200 的另一个结果集。
test("page-limit and shared-asset query errors use the shared client-error envelope", async () => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  const cases: Array<{ method: "GET" | "POST"; url: string }> = [
    { method: "GET", url: "/findings?limit=abc" },
    { method: "GET", url: "/audit-logs?limit=abc" },
    { method: "GET", url: `/canvases/${FIXTURE_UUID}/messages?limit=abc` },
    { method: "GET", url: "/shared-assets/not-a-uuid/content" },
    { method: "POST", url: "/shared-assets/not-a-uuid/archive" },
  ];
  try {
    for (const item of cases) {
      const response = await app.inject({ method: item.method, url: item.url });
      assertClientSafe400(response);
    }
    const limit = await app.inject({ method: "GET", url: "/findings?limit=abc" });
    assert.deepEqual((JSON.parse(limit.body) as { issues?: unknown }).issues, [{ path: "limit", code: "invalid_query" }]);
  } finally {
    await app.close();
  }
});

test("management API invalid bodies return 400 not 500", async () => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  const findingId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  try {
    const cases: Array<{ method: "POST" | "PATCH"; url: string; payload: Record<string, unknown>; paths?: string[] }> = [
      { method: "POST", url: "/projects", payload: {}, paths: ["name"] },
      { method: "POST", url: "/projects", payload: { name: "" }, paths: ["name"] },
      { method: "POST", url: "/projects", payload: { name: 123 }, paths: ["name"] },
      { method: "POST", url: "/projects", payload: { name: "x", image_strategy: "bogus" }, paths: ["image_strategy"] },
      { method: "POST", url: "/jobs", payload: {}, paths: ["project_id", "type"] },
      { method: "POST", url: "/jobs", payload: { project_id: "x", type: "audit" }, paths: ["project_id"] },
      { method: "PATCH", url: `/jobs/${jobId}/priority`, payload: { priority: "high" }, paths: ["priority"] },
      { method: "PATCH", url: `/findings/${findingId}/disposition`, payload: { disposition: "bogus" }, paths: ["disposition"] },
      { method: "POST", url: "/agent-roles", payload: {}, paths: ["name"] },
      { method: "POST", url: "/auth/login", payload: {}, paths: ["username", "password"] },
      { method: "POST", url: "/tokens", payload: {}, paths: ["name"] },
    ];
    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        headers: { "content-type": "application/json" },
        payload: item.payload,
      });
      assertClientSafe400(response, item.paths);
    }
  } finally {
    await app.close();
  }
});
