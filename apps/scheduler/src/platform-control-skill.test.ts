import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSONAR_CONTROL_SKILL,
  DEEPSONAR_CONTROL_SKILL_NAME,
  DEEPSONAR_CONTROL_SKILL_SHA256,
  frozenPlatformOperations,
  injectPlatformControlSkill,
  platformApiBaseUrl,
} from "./platform-control-skill.js";

test("platform control skill is immutable by reserved name", () => {
  const injected = injectPlatformControlSkill([
    { name: "review", files: { "SKILL.md": "role" } },
    { name: DEEPSONAR_CONTROL_SKILL_NAME, files: { "SKILL.md": "role override" } },
  ]) as Array<{ name?: string; files?: Record<string, string> }>;
  assert.equal(injected.filter((skill) => skill.name === DEEPSONAR_CONTROL_SKILL_NAME).length, 1);
  assert.deepEqual(injected.at(-1), DEEPSONAR_CONTROL_SKILL);
  assert.equal(injected[0]?.name, "review");
});

test("platform skill content documents the Job-scoped API route siblings", () => {
  const content = DEEPSONAR_CONTROL_SKILL.files["SKILL.md"];
  assert.match(content, /GET \$DEEPSONAR_API_BASE_URL\/capabilities/);
  assert.match(content, /GET \$DEEPSONAR_API_BASE_URL\/openapi\.json/);
  assert.match(content, /POST \$DEEPSONAR_API_BASE_URL\/operations\/:operationId/);
  assert.match(content, /Idempotency-Key/);
  assert.match(content, /MCP.*API.*二选一|one transport/i);
  assert.equal(DEEPSONAR_CONTROL_SKILL_SHA256, "145ecdc6a4f8edb52502fb11beae910666f7aa975e2411572888b44104bf3b0a");
});

test("platform API base is sandbox reachable and points at the Job", () => {
  assert.equal(
    platformApiBaseUrl({ baseUrl: "http://deepsonar-gateway-proxy:3100/control/v1/", jobId: "job-1" }),
    "http://deepsonar-gateway-proxy:3100/control/v1/jobs/job-1",
  );
  assert.throws(
    () => platformApiBaseUrl({ baseUrl: "http://localhost:3100/control/v1", jobId: "job-1" }),
    /sandbox-reachable/,
  );
});

test("frozen platform operations preserve the exact snapshot order and values", () => {
  const snapshot = ["emit_progress", "publish_shared_asset", "mark_job_done"];
  assert.deepEqual(frozenPlatformOperations(snapshot), snapshot);
});
