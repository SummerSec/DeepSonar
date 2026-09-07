/** Job 级控制 API-only 契约冒烟：验证静态 Skill、冻结权限和 OpenAPI 投影。 */
import assert from "node:assert/strict";
import {
  DEEPSONAR_CONTROL_SKILL,
  DEEPSONAR_CONTROL_SKILL_NAME,
  DEEPSONAR_CONTROL_SKILL_SHA256,
  frozenPlatformOperations,
  injectPlatformControlSkill,
  platformApiBaseUrl,
} from "../apps/scheduler/src/platform-control-skill.js";
import { platformToolGuide } from "../apps/scheduler/src/platform-tools.js";
import {
  PLATFORM_CONTROL_ROUTE_PATHS,
  PLATFORM_OPERATION_IDS,
  buildCapabilitiesProjection,
  buildPlatformOpenApiDocument,
  operationIdsFromSnapshot,
} from "../apps/scheduler/src/domains/platform-api/operations.js";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  REQUIRED_RUNTIME_CAPABILITIES,
} from "../packages/runtime-sandbox/src/runtime-adapters.js";
import {
  ALL_PLATFORM_TOOLS,
  ControlToolInputSchemasJson,
  resolvePlatformTools,
} from "../packages/shared-types/src/index.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";

const failOnLegacyControlText = (text: string, label: string): void => {
  for (const legacy of [
    "schema_validated",
    "pending_scheduler_validation",
    "isError",
    "tools/list",
    "tools/call",
    "二选一",
    "共用宿主",
  ]) {
    assert.doesNotMatch(text, new RegExp(legacy), `${label} 含已淘汰的控制通道文案: ${legacy}`);
  }
};

const skillContent = DEEPSONAR_CONTROL_SKILL.files["SKILL.md"];
assert.equal(DEEPSONAR_CONTROL_SKILL_NAME, "deepsonar-control");
assert.equal(DEEPSONAR_CONTROL_SKILL_SHA256, "fe059d17de22295bb195e3bf95b7dbfade4fb2806baeca90f3a5d46c9fcffd19");
assert.match(skillContent, /所有 CLI 都只能使用 Job 级 HTTP 控制 API/);
assert.match(skillContent, /Agent 通过当前 CLI 可用的 HTTP 工具/);
assert.match(skillContent, /GET \$DEEPSONAR_API_BASE_URL\/agent\/capabilities_list/);
assert.match(skillContent, /GET \$DEEPSONAR_API_BASE_URL\/openapi\.json/);
assert.match(skillContent, /POST \$DEEPSONAR_API_BASE_URL\/operations\/:operationId/);
assert.match(skillContent, /Authorization: Bearer \$DEEPSONAR_API_TOKEN/);
assert.match(skillContent, /Idempotency-Key/);
assert.match(skillContent, /不要先尝试 MCP，也不要在 API 失败后回退到 MCP/);
failOnLegacyControlText(skillContent, "静态控制 Skill");

const overriddenSkills = injectPlatformControlSkill([
  { name: "review", files: { "SKILL.md": "role" } },
  { name: DEEPSONAR_CONTROL_SKILL_NAME, files: { "SKILL.md": "role override" } },
]);
assert.equal(overriddenSkills.filter((skill) => (
  skill && typeof skill === "object" && !Array.isArray(skill)
    && (skill as { name?: unknown }).name === DEEPSONAR_CONTROL_SKILL_NAME
)).length, 1);
assert.deepEqual(overriddenSkills.at(-1), DEEPSONAR_CONTROL_SKILL);

assert.equal(
  platformApiBaseUrl({ baseUrl: "http://deepsonar-gateway-proxy:3100/control/v1/", jobId }),
  `http://deepsonar-gateway-proxy:3100/control/v1/jobs/${jobId}`,
);
assert.throws(
  () => platformApiBaseUrl({ baseUrl: "http://localhost:3100/control/v1", jobId }),
  /sandbox-reachable/,
);
assert.deepEqual(
  frozenPlatformOperations(["emit_fact", "mark_job_done", "emit_fact"]),
  ["emit_fact", "mark_job_done", "emit_fact"],
);

const workerTools = resolvePlatformTools("explore", "role", {});
assert.deepEqual(workerTools, ALL_PLATFORM_TOOLS);
assert.deepEqual(PLATFORM_OPERATION_IDS, ALL_PLATFORM_TOOLS);
const workerGuide = platformToolGuide(["emit_progress", "emit_fact", "mark_job_done", "request_human"]);
for (const expected of [
  "Job-scoped control API",
  "Agent 通过自身可用的 HTTP 工具直接调用",
  "API 返回 `accepted`",
  "HTTP 错误响应",
  "emit_progress",
  "emit_fact",
  "mark_job_done",
  "request_human",
  "platform_blocker",
  "subject_revision",
]) {
  assert.match(workerGuide, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `平台工具说明缺少: ${expected}`);
}
failOnLegacyControlText(workerGuide, "平台工具说明");

const restrictedTools = resolvePlatformTools("explore", "role", {
  emit_progress: false,
  request_human: false,
  mark_job_done: false,
  ack_human_message: false,
});
assert.deepEqual(restrictedTools, [
  "list_available_roles",
  "list_available_runtime_images",
  "list_shared_assets",
  "publish_shared_asset",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
  "ack_human_message",
]);
const restrictedGuide = platformToolGuide(restrictedTools);
assert.doesNotMatch(restrictedGuide, /### `emit_progress`/);
assert.doesNotMatch(restrictedGuide, /### `request_human`/);
assert.match(restrictedGuide, /只能使用静态 `deepsonar-control` Skill 所述的 Job-scoped control API/);

for (const [adapterId, adapter] of Object.entries(AGENT_CLI_RUNTIME_ADAPTERS)) {
  assert.equal(adapter.capabilities.platformControlApi, true, `${adapterId} 未声明 Job 控制 API`);
  assert.equal("controlMcp" in adapter.capabilities, false, `${adapterId} 仍声明控制 MCP`);
  for (const capability of REQUIRED_RUNTIME_CAPABILITIES) {
    assert.equal(adapter.capabilities[capability], true, `${adapterId} 缺少运行能力 ${capability}`);
  }
}
assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(), [
  "claude-code",
  "dsh",
  "pi",
]);

assert.deepEqual(PLATFORM_CONTROL_ROUTE_PATHS, {
  capabilities: "/control/v1/jobs/:jobId/capabilities",
  openapi: "/control/v1/jobs/:jobId/openapi.json",
  operation: "/control/v1/jobs/:jobId/operations/:operationId",
});

const snapshotOperations = operationIdsFromSnapshot({
  platform_tools: ["emit_fact", "unknown_operation", "emit_fact", "mark_job_done"],
});
assert.deepEqual(snapshotOperations, ["emit_fact", "mark_job_done"]);
assert.deepEqual(operationIdsFromSnapshot({ platform_tools: ["emit_fact", 42] }), []);

const projection = buildCapabilitiesProjection({
  jobId,
  projectId,
  canvasId: null,
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  operationIds: ["emit_progress", "list_available_roles", "unknown_operation"],
});
assert.deepEqual(projection.operation_ids, ["emit_progress", "list_available_roles"]);
assert.equal("token" in projection, false);
assert.equal(projection.openapi_url, `/control/v1/jobs/${jobId}/openapi.json`);
for (const operation of projection.operations) {
  assert.equal(operation.input_schema.type, "object");
  assert.equal(operation.invoke_url, `/control/v1/jobs/${jobId}/operations/${operation.operation_id}`);
  assert.equal(operation.input_schema_url, operation.invoke_url);
  assert.deepEqual(
    operation.input_schema,
    ControlToolInputSchemasJson[operation.operation_id as keyof typeof ControlToolInputSchemasJson],
  );
}

const openapi = buildPlatformOpenApiDocument({
  jobId,
  operationIds: ["emit_progress", "list_available_roles", "unknown_operation"],
});
assert.equal(openapi.openapi, "3.0.3");
assert.equal(openapi["x-deepsonar-job-id"], jobId);
assert.deepEqual(openapi["x-deepsonar-allowed-operation-ids"], ["emit_progress", "list_available_roles"]);
const openapiPaths = openapi.paths as Record<string, Record<string, any>>;
const progressPath = openapiPaths[`/control/v1/jobs/{jobId}/operations/emit_progress`];
assert.ok(progressPath?.get);
assert.ok(progressPath?.post);
assert.equal(progressPath.post.operationId, "emit_progress");
assert.deepEqual(
  progressPath.post.requestBody.content["application/json"].schema,
  ControlToolInputSchemasJson.emit_progress,
);
assert.equal(progressPath.post.parameters.find((parameter: { name?: string }) => parameter.name === "Idempotency-Key").required, true);
assert.equal(openapiPaths["/control/v1/jobs/{jobId}/operations/emit_finding"], undefined);
assert.equal(openapiPaths["/control/v1/jobs/{jobId}/operations/unknown_operation"], undefined);

console.log(JSON.stringify({
  contract: "job-scoped-control-api-only",
  adapters: Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).length,
  operations: projection.operation_ids.length,
  guide: "complete",
}));
