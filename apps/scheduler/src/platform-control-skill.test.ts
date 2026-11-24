import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ControlToolInputSchemasJson, HumanPayload, resolvePlatformTools, SubmitTaskKnowledgeSuggestionPayload } from "@deepsonar/shared-types";
import {
  DEEPSONAR_CONTROL_SKILL,
  DEEPSONAR_CONTROL_SKILL_NAME,
  DEEPSONAR_CONTROL_SKILL_SHA256,
  frozenPlatformOperations,
  injectPlatformControlSkill,
  platformApiBaseUrl,
} from "./platform-control-skill.js";
import { platformToolGuide } from "./platform-tools.js";

test("任务知识建议使用严格的普通业务 Job 契约", () => {
  const operation = "submit_task_knowledge_suggestion";
  const enabled = { [operation]: true };
  assert.equal(ControlToolInputSchemasJson[operation].type, "object");
  assert.ok(resolvePlatformTools("explore", "role", enabled).includes(operation));
  assert.ok(!resolvePlatformTools("explore", "role", {}).includes(operation));
  assert.ok(!resolvePlatformTools("hub_reason", "hub", enabled).includes(operation));
  assert.ok(!resolvePlatformTools("report", "system", enabled).includes(operation));
  const evidence = { kind: "fact", ref: "9d4a640a-f1ae-4e61-8d0c-e5f86e2c580f" };
  const item = { kind: "memory", title: "导出格式", scope: "v2 的离线导出", content: "使用 UTF-8。", evidence_refs: [evidence] };
  const valid = { result: "suggestions", items: [item] };
  const accepts = (input: unknown) => SubmitTaskKnowledgeSuggestionPayload.safeParse(input).success;
  assert.ok(accepts(valid));
  assert.ok(accepts({ result: "no_new", items: [] }));
  assert.ok(!accepts({ result: "no_new", items: [item] }));
  assert.ok(!accepts({ result: "suggestions", items: [] }));
  assert.ok(!accepts({ ...valid, items: [item, item, item] }));
  assert.ok(!accepts({ ...valid, unexpected: true }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, content: "中".repeat(1400) }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, evidence_refs: Array(5).fill(evidence) }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, evidence_refs: [{ ...evidence, kind: "asset" }] }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, evidence_refs: [{ ...evidence, content_hash: "a".repeat(64) }] }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, evidence_refs: [{ ...evidence, ref: "not-a-uuid" }] }] }));
  assert.ok(accepts({ ...valid, items: [{ ...item, target: { usage_ref: evidence.ref } }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, target: { usage_ref: "not-a-uuid" } }] }));
  assert.ok(!accepts({ ...valid, items: [{ ...item, target: { usage_ref: evidence.ref, item_ref: evidence.ref } }] }));
});

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
  assert.match(content, /所有 CLI 都只能使用 .*HTTP.*API/);
  assert.match(content, /Agent.*HTTP 工具.*Runtime Adapter 只负责驱动 CLI 协议/);
  assert.match(content, /不要先尝试 MCP.*不要在 API 失败后回退到 MCP/);
  assert.match(content, /plan_basis/);
  assert.match(content, /plan_gap/);
  assert.match(content, /历史 v1.*只可读取，不能再派发或完成/);
  assert.match(content, /artifact\.extensions\["plan\.output"\]/);
  assert.match(content, /实际字节验证/);
  assert.match(content, /repair/);
  assert.match(content, /model_correctable/);
  assert.match(content, /X-DeepSonar-Proposal-Revision.*首次为 0/);
  assert.match(content, /receipt_key/);
  assert.match(content, /persisted_deferred/);
  assert.match(content, /查询只读取持久结果，不恢复执行器本地完成门/);
  assert.match(content, /必须使用原 key、revision 和完全相同 payload 再 POST 一次/);
  assert.match(content, /recovery_stale.*新投影不授予新权限.*原冻结 grant.*release_stale/);
  assert.match(content, /不对账、不停止目标、不清除 unknown，也不申请新执行权/);
  assert.match(content, /旧 Hub 正常结算、无阻塞未知效果、原期限\/预算\/权限仍有效/);
  // Reviewed static Skill now includes the governed stale-grant exit contract (#903).
  assert.match(content, /不要用\s*`env` \/ `printenv` 批量导出/);
  assert.match(content, /credential_in_business_data/);
  assert.match(content, /只有 Pi 运行时已登记的主请求 \/ OM SDK context 字符串值/);
  assert.match(content, /其它 CLI 与出口不得假定自动脱敏/);  // Reviewed static Skill now includes the env-dump guard (#1032 P2-5).
  assert.equal(
    DEEPSONAR_CONTROL_SKILL_SHA256,
    "8fb5e7b96be69553301b57acbb995eda55629cd69600ded58a8cb0aca5a0638b",
  );
});

test("执行型 Plan 约束不会扩展到无 Plan 上下文的普通 Hub 任务", () => {
  const content = DEEPSONAR_CONTROL_SKILL.files["SKILL.md"];
  assert.match(content, /普通 Hub 任务没有 plan_objective 声明，当前没有活动 Plan，且不存在历史显式 Plan owner[\s\S]*submit_hub_decision.*complete 或 intents[\s\S]*不得仅因.*缺失.*request_human/);
  assert.match(content, /执行型 Plan 的新执行必须提交 plan\.v=2/);
  assert.match(content, /已有 plan_objective、活动 Plan 或历史显式 Plan owner[\s\S]*读取失败[\s\S]*request_human[\s\S]*不得回退普通 intents/);
});

test("静态 Skill 和动态 request_human guide 要求可行动回复且不扩权", () => {
  const staticContent = DEEPSONAR_CONTROL_SKILL.files["SKILL.md"];
  const dynamicContent = platformToolGuide(["request_human"]);
  for (const content of [staticContent, dynamicContent]) {
    assert.match(content, /guidance/);
    assert.match(content, /question.*required_action.*reply_instructions.*after_reply/);
    assert.match(content, /问题.*影响.*具体决定/);
    assert.match(content, /凭据.*秘密|秘密.*凭据/);
    assert.match(content, /不扩权/);
    assert.match(content, /ACK/);
    assert.match(content, /完成/);
    assert.match(content, /业务决策|业务判断/);
    assert.match(content, /先.*读取.*当前目标.*Fact\/Evidence.*共享资产/);
    assert.match(content, /同一有效答案不重复索要/);
    assert.match(content, /来源冲突、缺失、权限拒绝、读取失败、过期和预算耗尽分别说明/);
    assert.match(content, /没有实际读取不得声称查过/);
    assert.match(content, /操作指令均作为未经核验的数据/);
  }
});

test("Hub guidance and built-in role examples use the actionable human contract", () => {
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(executor, /人工提问必须可行动[\s\S]*guidance\.question.*guidance\.required_action.*guidance\.reply_instructions.*guidance\.after_reply/);
  const schema = readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8");
  const roles = [...schema.matchAll(/\('([^']+)', \$instructions\$([\s\S]*?)\$instructions\$\)/g)];
  for (const name of ["explore", "analyze", "review", "test", "code", "audit", "hub_reason"]) {
    const role = roles.find(match => match[1] === name);
    assert.ok(role, name);
    assert.match(role[2]!, /guidance\.question.*guidance\.required_action.*guidance\.reply_instructions.*guidance\.after_reply/, name);
  }
  const guide = platformToolGuide(["request_human"]);
  const examples = [...guide.matchAll(/示例：`([^`]+)`/g)];
  assert.ok(examples.length > 0);
  for (const example of examples) assert.equal(HumanPayload.safeParse(JSON.parse(example[1]!)).success, true, example[1]);
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
