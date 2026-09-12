import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { INVALID_PAYLOAD, validationHttpError } from "./http-validation-error.js";
import { registerRoutes } from "./routes.js";

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
