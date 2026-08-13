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

test("平台控制 Skill 按保留名称保持不可替换", () => {
  const injected = injectPlatformControlSkill([
    { name: "review", files: { "SKILL.md": "role" } },
    { name: DEEPSONAR_CONTROL_SKILL_NAME, files: { "SKILL.md": "role override" } },
  ]) as Array<{ name?: string; files?: Record<string, string> }>;
  assert.equal(injected.filter((skill) => skill.name === DEEPSONAR_CONTROL_SKILL_NAME).length, 1);
  assert.deepEqual(injected.at(-1), DEEPSONAR_CONTROL_SKILL);
  assert.equal(injected[0]?.name, "review");
});

test("平台 Skill 记录 Job 级 API 的发现和调用路径", () => {
  const content = DEEPSONAR_CONTROL_SKILL.files["SKILL.md"];
  assert.match(content, /GET \$DEEPSONAR_API_BASE_URL\/agent\/capabilities_list/);
  assert.match(content, /GET \$DEEPSONAR_API_BASE_URL\/openapi\.json/);
  assert.match(content, /POST \$DEEPSONAR_API_BASE_URL\/operations\/:operationId/);
  assert.match(content, /Idempotency-Key/);
  assert.match(content, /Agent.*MCP.*API.*自行二选一/);
  assert.match(content, /HTTP API 是长期统一控制面.*MCP 仅作为待淘汰的过渡通道/);
  assert.equal(DEEPSONAR_CONTROL_SKILL_SHA256, "417ebdc6b802394cb0334285331cc6d9ad99c00cf32aaf0d792cda533b815733");
});

test("平台 API 基地址必须可从沙箱访问并指向当前 Job", () => {
  assert.equal(
    platformApiBaseUrl({ baseUrl: "http://deepsonar-gateway-proxy:3100/control/v1/", jobId: "job-1" }),
    "http://deepsonar-gateway-proxy:3100/control/v1/jobs/job-1",
  );
  assert.throws(
    () => platformApiBaseUrl({ baseUrl: "http://localhost:3100/control/v1", jobId: "job-1" }),
    /sandbox-reachable/,
  );
});

test("冻结的平台操作保持快照顺序和精确值", () => {
  const snapshot = ["emit_progress", "publish_shared_asset", "mark_job_done"];
  assert.deepEqual(frozenPlatformOperations(snapshot), snapshot);
});
