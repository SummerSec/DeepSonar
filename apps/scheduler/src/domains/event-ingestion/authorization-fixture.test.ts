import assert from "node:assert/strict";
import test from "node:test";
import {
  DonePayload, FactPayload, FindingPayload, HistoricalSubmitPlanPayload,
  HubDecisionPayload, HumanPayload, PlanResult, ProgressPayload,
  SubmitPlanPayload, SubmitPlanResultPayload,
} from "@deepsonar/shared-types";
import { contentSha256 } from "../plan-protocol/criterion-model.js";
import { authorizationEventPayloads, authorizationPayloadFor } from "./authorization-event-test-fixture.js";

const JOB_ID = "283c85d5-a14f-47ae-a527-e8fce31bdbfb";
const schemas = {
  progress: ProgressPayload, fact: FactPayload, finding: FindingPayload,
  hub_decision: HubDecisionPayload, plan: SubmitPlanPayload,
  plan_result: SubmitPlanResultPayload, human: HumanPayload, done: DonePayload,
};

// Run without importing DB/core: malformed fixtures must fail before the SQL auth test.
for (const [type, schema] of Object.entries(schemas)) {
  test(`semantic authorization fixture ${type} satisfies the current strict schema`, () => {
    const parsed = schema.safeParse(authorizationPayloadFor(type, JOB_ID));
    assert.ok(parsed.success, `${type}: ${JSON.stringify(parsed.error?.issues)}`);
  });
}

test("Plan v2 authorization fixtures bind the actual Job, objective, route, task and canonical hash", () => {
  const payloads = authorizationEventPayloads(JOB_ID);
  assert.deepEqual(Object.keys(payloads), Object.keys(schemas), "keep all eight semantic event cases");
  const { plan, revision } = SubmitPlanPayload.parse(payloads.plan);
  const result = SubmitPlanResultPayload.parse(payloads.plan_result);
  assert.equal(revision.plan_job_id, JOB_ID);
  assert.equal(revision.objective_id, plan.objective_id);
  assert.equal(revision.expected_objective_revision, plan.objective_revision);
  assert.equal(revision.expected_route_revision, "0");
  assert.equal(plan.route_revision, "1");
  assert.equal(revision.expected_plan_sha256, null);
  assert.equal(result.objective_id, plan.objective_id);
  assert.equal(result.objective_revision, plan.objective_revision);
  assert.equal(result.route_revision, plan.route_revision);
  assert.equal(result.plan_sha256, contentSha256(plan));
  assert.deepEqual(result.execution.map(task => task.task_id), plan.tasks.map(task => task.id));
  assert.deepEqual(plan.completion.required_outputs, plan.tasks[0].expected_outputs);
  assert.ok(plan.budget.max_tasks >= plan.tasks.length);
  const otherJob = "78cf1d57-f5ae-42c8-b123-5c15180c98dd";
  assert.equal(authorizationEventPayloads(otherJob).plan.revision.plan_job_id, otherJob);
  assert.equal(authorizationEventPayloads(JOB_ID).plan_result.plan_sha256, result.plan_sha256);
});

test("deprecated Plan v1 authorization fixture is valid history but rejected for current ingestion", () => {
  const legacy = {
    plan: {
      v: 1,
      goal: "late plan goal",
      tasks: [{
        id: "late-task", title: "late task title", role: "explore",
        description: "late task description", prompt: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      }],
      completion: { mode: "explicit_result", description: "late completion policy" },
    },
  };
  assert.equal(HistoricalSubmitPlanPayload.safeParse(legacy).success, true);
  assert.equal(SubmitPlanPayload.safeParse(legacy).success, false);
});

test("deprecated Plan result v1 authorization fixture is valid history but rejected for current ingestion", () => {
  const legacy = { v: 1, outcome: "continue", summary: "late plan result summary" };
  assert.equal(PlanResult.safeParse(legacy).success, true);
  assert.equal(SubmitPlanResultPayload.safeParse(legacy).success, false);
});

test("Plan authorization fixture regressions retain strict v2 fields and expected outputs", () => {
  const { plan, plan_result } = authorizationEventPayloads(JOB_ID);
  assert.equal(SubmitPlanPayload.safeParse({ plan: plan.plan }).success, false);
  assert.equal(SubmitPlanPayload.safeParse({ ...plan, revision: { ...plan.revision, v: 1 } }).success, false);
  assert.equal(SubmitPlanPayload.safeParse({
    ...plan, plan: { ...plan.plan, tasks: plan.plan.tasks.map(task => ({ ...task, expected_outputs: [] })) },
  }).success, false);
  assert.equal(SubmitPlanResultPayload.safeParse({ ...plan_result, plan_sha256: undefined }).success, false);
  assert.equal(SubmitPlanResultPayload.safeParse({ ...plan_result, next_goal: "Replace the current objective" }).success, false);
});

test("authorization payload factory rejects unknown event types without a fallback", () => {
  assert.throws(() => authorizationPayloadFor("unknown", JOB_ID), /unknown test event type unknown/);
});
