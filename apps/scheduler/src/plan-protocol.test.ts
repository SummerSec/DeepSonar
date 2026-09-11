import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PLATFORM_TOOLS,
  ControlEventEnvelope,
  ControlToolInputSchemasJson,
  EventEnvelope,
  Plan,
  PlanResult,
  SubmitPlanPayload,
  adaptHubCompleteToPlanResult,
  adaptHubIntentsToPlan,
  adaptIntentToPlanTask,
  mergePlanAudit,
  toMcpToolInputSchema,
  trimPlan,
} from "@deepsonar/shared-types";
import { PLATFORM_OPERATION_IDS } from "./domains/platform-api/operations.js";
import { eventRateLimitBucket } from "./domains/event-ingestion/rate-limit.js";

const PROMPT = "X".repeat(32);
const EVENT_ID = "00000000-0000-4000-8000-000000000044";

function sampleTask(id = "explore-auth", extras: Record<string, unknown> = {}) {
  return {
    id,
    title: "梳理登录与会话入口",
    role: "explore",
    description: "定位登录与会话校验链路",
    prompt: PROMPT,
    from: [],
    depends_on: [],
    inputs: [],
    expected_outputs: ["入口清单"],
    ...extras,
  };
}

function samplePlan(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    goal: "确认认证入口与会话",
    assumptions: ["目标仓库可读"],
    tasks: [sampleTask()],
    completion: {
      mode: "explicit_result" as const,
      description: "由 PlanResult 声明是否继续",
      required_outputs: [],
    },
    open_questions: [],
    ...overrides,
  };
}

test("Plan / PlanResult schemas accept Phase 1 fixtures and reject illegal graphs", () => {
  assert.equal(Plan.safeParse(samplePlan()).success, true);
  assert.equal(SubmitPlanPayload.safeParse({ plan: samplePlan() }).success, true);
  assert.equal(Plan.safeParse(samplePlan({
    tasks: [
      sampleTask("a", { depends_on: ["b"] }),
      sampleTask("b", { depends_on: ["a"] }),
    ],
  })).success, false);
  assert.equal(Plan.safeParse(samplePlan({
    tasks: [sampleTask("a"), sampleTask("a")],
  })).success, false);
  assert.equal(Plan.safeParse(samplePlan({
    tasks: [sampleTask("a", { depends_on: ["missing"] })],
  })).success, false);
  assert.equal(PlanResult.safeParse({
    v: 1,
    outcome: "complete",
    summary: "证据已经足够收敛",
  }).success, false);
  assert.equal(PlanResult.safeParse({
    v: 1,
    outcome: "complete",
    summary: "证据已经足够收敛",
    termination_reason: "evidence_complete",
  }).success, true);
  assert.equal(PlanResult.safeParse({
    v: 1,
    outcome: "continue",
    summary: "还需要继续动态验证",
  }).success, true);
});

test("submit_plan and submit_plan_result MCP schemas stay single objects", () => {
  for (const name of ["submit_plan", "submit_plan_result"] as const) {
    const schema = ControlToolInputSchemasJson[name];
    assert.equal(schema.type, "object");
    assert.equal(Array.isArray(schema.anyOf), false);
    assert.equal(Array.isArray(schema.oneOf), false);
    assert.doesNotThrow(() => toMcpToolInputSchema(
      name === "submit_plan" ? SubmitPlanPayload : PlanResult,
    ));
  }
  assert.ok(ALL_PLATFORM_TOOLS.includes("submit_plan"));
  assert.ok(ALL_PLATFORM_TOOLS.includes("submit_plan_result"));
  assert.deepEqual(PLATFORM_OPERATION_IDS, ALL_PLATFORM_TOOLS);
  assert.equal(eventRateLimitBucket("plan"), "standard");
  assert.equal(eventRateLimitBucket("plan_result"), "standard");
});

test("Intent adapter maps one Hub intent to one PlanTask without inventing extra work", () => {
  const intent = {
    from: ["00000000-0000-4000-8000-000000000001"],
    role: "explore",
    description: "确认目标材料与版本范围",
    prompt: "定位任务目标的权威材料，记录版本、来源和仍缺失的信息；只提交新增事实。",
    runtime_image_key: "deepsonar-base",
  };
  const task = adaptIntentToPlanTask(intent, 0);
  assert.equal(task.id, "intent-1");
  assert.equal(task.role, "explore");
  assert.equal(task.prompt, intent.prompt);
  assert.deepEqual(task.from, intent.from);
  assert.equal(task.runtime_image_key, "deepsonar-base");
  const plan = adaptHubIntentsToPlan([intent, { ...intent, role: "analyze", description: "分析认证边界条件" }]);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[1]?.id, "intent-2");
  assert.equal(plan.tasks[1]?.role, "analyze");
  const result = adaptHubCompleteToPlanResult({
    from: [],
    description: "目标已被当前引用证据完整覆盖",
  });
  assert.equal(result.outcome, "complete");
  assert.equal(result.termination_reason, "hub_complete");
});

test("Scheduler trim caps tasks and dangling depends_on while keeping the raw plan intact", () => {
  const raw = Plan.parse(samplePlan({
    budget: { max_tasks: 1 },
    tasks: [
      sampleTask("keep-me"),
      sampleTask("drop-me", { depends_on: ["keep-me"] }),
    ],
  }));
  const { trimmed, reasons } = trimPlan(raw, { maxTasks: 10 });
  assert.equal(trimmed.tasks.length, 1);
  assert.equal(trimmed.tasks[0]?.id, "keep-me");
  assert.ok(reasons.some((reason) => reason.startsWith("dropped_tasks")));
  assert.equal(raw.tasks.length, 2);
});

test("plan audit merge keeps raw/trim/result/termination on one record", () => {
  const raw = Plan.parse(samplePlan());
  const first = mergePlanAudit(null, {
    source: "submit_plan",
    raw,
    trimmed: raw,
    trim_reasons: [],
  }, "2026-09-11T00:00:00.000Z");
  const result = PlanResult.parse({
    v: 1,
    outcome: "blocked",
    summary: "缺少隔离测试账号",
    termination_reason: "missing_credential",
  });
  const merged = mergePlanAudit(first, {
    source: "submit_plan",
    result,
    termination_reason: result.termination_reason,
  }, "2026-09-11T00:01:00.000Z");
  assert.equal(merged.raw?.goal, raw.goal);
  assert.equal(merged.result?.outcome, "blocked");
  assert.equal(merged.termination_reason, "missing_credential");
});

test("Control and ingest envelopes accept plan and plan_result", () => {
  const planPayload = { plan: samplePlan() };
  const resultPayload = {
    v: 1 as const,
    outcome: "needs_human" as const,
    summary: "需要确认风险接受边界",
    termination_reason: "business_decision",
  };
  for (const envelope of [ControlEventEnvelope, EventEnvelope]) {
    assert.equal(envelope.safeParse({
      v: 1,
      event_id: EVENT_ID,
      type: "plan",
      payload: planPayload,
    }).success, true);
    assert.equal(envelope.safeParse({
      v: 1,
      event_id: EVENT_ID,
      type: "plan_result",
      payload: resultPayload,
    }).success, true);
    assert.equal(envelope.safeParse({
      v: 1,
      event_id: EVENT_ID,
      type: "plan",
      payload: { goal: "missing wrapper" },
    }).success, false);
  }
});
