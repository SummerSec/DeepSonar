import assert from "node:assert/strict";
import test from "node:test";
import {
  PlanExecutionState,
  PlanObjectivePatch,
  applyPlanObjectivePatch,
  readPersistedPlanObjective,
} from "./domains/plan-protocol/objective.js";

const OBJECTIVE_PATCH = {
  expected_revision: null,
  goal: "Collect and verify the scoped execution evidence",
  completion: {
    mode: "all_tasks" as const,
    description: "Every planned task must have a retained output",
    required_outputs: [],
  },
  budget: {
    max_tasks: 8,
    max_rounds: 4,
    max_no_progress_rounds: 2,
    max_parallel_tasks: 1,
  },
};

test("authorized objective CAS creates a durable revision without changing task input identity", () => {
  const target = {
    content: "The saved task boundary remains unchanged",
    network_policy: { allow_egress: false },
    plan_execution: {
      v: 1,
      objective_id: "11111111-1111-4111-8111-111111111111",
      objective_revision: "7",
      plan_job_id: "22222222-2222-4222-8222-222222222222",
      route_revision: "3",
      lifetime_tasks_dispatched: 4,
      lifetime_rounds: 3,
      no_progress_rounds: 1,
      last_progress_at: "2026-10-31T00:00:00.000Z",
      stop_reason: null,
      stopped_at: null,
    },
  };
  const first = applyPlanObjectivePatch({
    title: "Scoped execution",
    target,
    patch: OBJECTIVE_PATCH,
    now: "2026-10-31T00:00:01.000Z",
  });
  assert.equal(first.objective.revision, "1");
  assert.equal(first.objective.status, "active");
  assert.equal(readPersistedPlanObjective(first.target)?.objective_id, first.objective.objective_id);

  const second = applyPlanObjectivePatch({
    title: "Scoped execution",
    target: first.target,
    patch: {
      ...OBJECTIVE_PATCH,
      expected_revision: "1",
      goal: "Collect and verify the revised scoped evidence",
    },
    now: "2026-10-31T00:00:02.000Z",
  });
  assert.equal(second.objective.revision, "2");
  assert.equal(second.objective.objective_id, first.objective.objective_id);
  assert.equal(second.objective.input_sha256, first.objective.input_sha256);
  assert.deepEqual(second.target.plan_execution, target.plan_execution);
});

test("objective CAS rejects stale writers and models cannot use the user patch schema", () => {
  const parsed = PlanObjectivePatch.safeParse(OBJECTIVE_PATCH);
  assert.equal(parsed.success, true);
  const first = applyPlanObjectivePatch({
    title: "Scoped execution",
    target: {},
    patch: OBJECTIVE_PATCH,
    now: "2026-10-31T00:00:01.000Z",
  });
  assert.throws(
    () => applyPlanObjectivePatch({
      title: "Scoped execution",
      target: first.target,
      patch: OBJECTIVE_PATCH,
      now: "2026-10-31T00:00:02.000Z",
    }),
    (error: unknown) => error instanceof Error && error.message.includes("revision"),
  );
  assert.equal(PlanObjectivePatch.safeParse({ ...OBJECTIVE_PATCH, next_goal: "weaken the criteria" }).success, false);
});

test("execution state is strict and restart-readable", () => {
  const state = {
    v: 1 as const,
    objective_id: "11111111-1111-4111-8111-111111111111",
    objective_revision: "2",
    plan_job_id: "22222222-2222-4222-8222-222222222222",
    route_revision: "4",
    lifetime_tasks_dispatched: 6,
    lifetime_rounds: 4,
    no_progress_rounds: 2,
    last_progress_at: "2026-10-31T00:00:00.000Z",
    stop_reason: "budget_exhausted",
    stopped_at: "2026-10-31T00:01:00.000Z",
  };
  assert.deepEqual(PlanExecutionState.parse(state), state);
  assert.equal(PlanExecutionState.safeParse({ ...state, lifetime_tasks_dispatched: -1 }).success, false);
  assert.equal(PlanExecutionState.safeParse({ ...state, unexpected: true }).success, false);
});
