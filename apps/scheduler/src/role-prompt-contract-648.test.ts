/**
 * #648: role prompt / Verification evidence / platform-tool allowlist alignment.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DONE_SUMMARY_MAX_BYTES,
  VERIFY_REPORT_PLATFORM_TOOLS,
  allowedPlatformTools,
  resolvePlatformTools,
} from "@deepsonar/shared-types";
import { platformToolGuide } from "./platform-tools.js";
import { buildVerifyJobPrompt } from "./verify-prompt.js";
import { RUNTIME_TEST_TOOLCHAIN_POLICY } from "./domains/role-runtime-snapshot/application.js";

const schemaSql = readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8");
const executorSource = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
const platformToolsSource = readFileSync(new URL("./platform-tools.ts", import.meta.url), "utf8");

test("#648 verify prompt examples only use supports|refutes|inconclusive (no rejects)", () => {
  const prompt = buildVerifyJobPrompt({
    attempt: 2,
    subject: { id: "00000000-0000-4000-8000-000000000099", location: "a.ts:1" },
    evidenceJson: "{}",
    taskGoal: "goal",
  });
  assert.match(prompt, /outcome=supports/);
  assert.match(prompt, /outcome=refutes/);
  assert.match(prompt, /supports\|refutes\|inconclusive/);
  assert.doesNotMatch(prompt, /rejects/);
});

test("#648 Hub verify bounce hints only allow review or test", () => {
  assert.match(executorSource, /只能派发 review 或 test/);
  assert.match(executorSource, /不得派发 audit\/explore/);
  assert.doesNotMatch(
    executorSource,
    /派发普通角色（review\/test\/audit\/explore/,
  );
  // Scheduler rejection path remains the hard gate.
  const sideEffects = readFileSync(
    new URL("./domains/event-ingestion/side-effects.ts", import.meta.url),
    "utf8",
  );
  assert.match(sideEffects, /\["review", "test"\]/);
  assert.match(sideEffects, /verify_rework.*verify_failed|verify_failed.*verify_rework/);
});

test("#648 mark_job_done summary copy uses 8192 UTF-8 bytes", () => {
  assert.equal(DONE_SUMMARY_MAX_BYTES, 8192);
  assert.match(platformToolsSource, /最多 8192 UTF-8 字节/);
  assert.doesNotMatch(platformToolsSource, /最多 10000/);
  const guide = platformToolGuide(["mark_job_done"]);
  assert.match(guide, /8192 UTF-8 字节/);
  assert.match(guide, /压缩证据描述文字.*Finding ID/);
});

test("#648 verify/report empty platform_tools_json expands to strict allowlist only", () => {
  assert.deepEqual(VERIFY_REPORT_PLATFORM_TOOLS, [
    "emit_progress",
    "mark_job_done",
    "ack_human_message",
  ]);
  for (const role of ["verify", "report"] as const) {
    const tools = resolvePlatformTools(role, "system", {});
    assert.deepEqual(tools.sort(), [...VERIFY_REPORT_PLATFORM_TOOLS].sort());
    assert.equal(tools.includes("emit_fact"), false);
    assert.equal(tools.includes("emit_finding"), false);
    assert.equal(tools.includes("request_human"), false);
    assert.deepEqual(allowedPlatformTools(role, "system").sort(), [...VERIFY_REPORT_PLATFORM_TOOLS].sort());
  }
  // Ordinary roles still expand empty config to the full catalog (minus explicit false).
  const audit = resolvePlatformTools("audit", "role", {});
  assert.ok(audit.includes("emit_finding"));
  assert.ok(audit.includes("emit_fact"));
  assert.ok(audit.length > VERIFY_REPORT_PLATFORM_TOOLS.length);
});

test("#648 schema seed documents verify terminals and report five sections", () => {
  assert.match(schemaSql, /outcome=supports.*confirmed|supports` 且门禁通过/);
  assert.match(schemaSql, /outcome=refutes.*refuted|全量 `outcome=refutes`/);
  assert.match(schemaSql, /inconclusive/);
  assert.match(schemaSql, /可修复的证据不足/);
  assert.doesNotMatch(schemaSql, /否定结论走 rework/);
  assert.match(schemaSql, /固定五类章节/);
  assert.match(schemaSql, /已确认/);
  assert.match(schemaSql, /已排除/);
  assert.match(schemaSql, /未证实/);
  assert.match(schemaSql, /待人工确认/);
  assert.match(schemaSql, /未自动验证/);
  assert.match(schemaSql, /禁止访问 Scheduler 管理 API/);
  assert.match(schemaSql, /结果仅允许通过本 Job 的受治理平台工具提交/);
  assert.doesNotMatch(schemaSql, /行号等细节可以后补/);
  assert.match(schemaSql, /重置令牌可重复使用/);
  assert.match(schemaSql, /成功重置后令牌未失效/);
});

test("RoleConfig seed prompts do not embed the platform control Skill", () => {
  const seedStart = schemaSql.indexOf("INSERT INTO role_configs (role_id, agent_cli, instructions_markdown, runtime_image_key)");
  const seedEnd = schemaSql.indexOf(") AS templates(name, instructions) ON templates.name = r.name", seedStart);
  assert.ok(seedStart >= 0 && seedEnd > seedStart, "role config seed block missing");
  const rolePromptSeed = schemaSql.slice(seedStart, seedEnd);
  assert.doesNotMatch(rolePromptSeed, /deepsonar-control/);
  assert.doesNotMatch(rolePromptSeed, /静态[^\n]*Skill/);
  // The control Skill remains platform-owned in the runtime composition.
  assert.match(executorSource, /injectPlatformControlSkill\(snapshot\.skills\)/);
  assert.match(executorSource, /deepsonar-control Skill/);
});

test("#648 test toolchain policy does not conflate inconclusive with needs_human", () => {
  assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /outcome=inconclusive/);
  assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /mark_job_done\.verdict only/);
  assert.doesNotMatch(RUNTIME_TEST_TOOLCHAIN_POLICY, /inconclusive\/needs-human evidence/);
  assert.match(schemaSql, /outcome=inconclusive/);
  assert.match(schemaSql, /needs_human` 仅是 `mark_job_done\.verdict`/);
});

test("#648 review/test emit_fact.description examples meet min length 16", () => {
  const reviewMatch = schemaSql.match(/普通复核：`emit_fact\(\{"title":"复核结论","description":"([^"]+)"\}/);
  const testMatch = schemaSql.match(/普通测试事实：`emit_fact\(\{"title":"测试结果","description":"([^"]+)"\}/);
  const verifyReview = schemaSql.match(/"title":"独立复核：权限前提成立","description":"([^"]+)"/);
  const verifyTest = schemaSql.match(/"title":"实测：未授权读取可复现","description":"([^"]+)"/);
  for (const [label, m] of [
    ["ordinary review", reviewMatch],
    ["ordinary test", testMatch],
    ["verification review", verifyReview],
    ["verification test", verifyTest],
  ] as const) {
    assert.ok(m, `${label} example missing`);
    assert.ok([...m![1]!].length >= 16, `${label} description too short: ${m![1]}`);
  }
});
