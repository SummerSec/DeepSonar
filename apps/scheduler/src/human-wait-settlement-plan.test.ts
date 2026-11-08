import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { humanWaitResourcesPresent, planHumanWaitSettlement } from "./human-wait-settlement-plan.js";

const humanWaitInput = { jobId: "job-1", attemptId: "attempt-1", sandboxId: "sandbox-1" };
const humanWaitState = () => ({
  input: humanWaitInput,
  canvasLocked: true,
  locatorCanvasId: "canvas-1",
  job: { status: "waiting_human", canvas_id: "canvas-1", sandbox_id: "sandbox-1" },
  attempt: {
    id: "attempt-1", attempt_no: 2, status: "active",
    cancel_requested: false, sandbox_id: "sandbox-1",
  },
  humanEventId: "human-event-1",
  effect: { status: "effect_pending" },
  effectId: "agent_run:2",
});

test("human wait settlement is idempotent and never re-settles a closed run effect", () => {
  assert.deepEqual(planHumanWaitSettlement(humanWaitState()), {
    action: "settle", effectId: "agent_run:2", humanEventId: "human-event-1",
  });
  const settled = humanWaitState();
  settled.effect.status = "settled";
  assert.deepEqual(planHumanWaitSettlement(settled), { action: "already-settled" });
});

test("human wait settlement refuses unknown, foreign and missing run effects", () => {
  for (const effect of [{ status: "unknown" }, { status: "failed" }, null]) {
    assert.equal(planHumanWaitSettlement({ ...humanWaitState(), effect }).action, "skip");
  }
  assert.equal(planHumanWaitSettlement({ ...humanWaitState(), humanEventId: undefined }).action, "skip");
});

test("human wait settlement keeps every owner, status and cancellation gate", () => {
  const cases: Array<[string, (s: ReturnType<typeof humanWaitState>) => void]> = [
    ["lock", s => { s.canvasLocked = false; }],
    ["job status", s => { s.job.status = "running"; }],
    ["canvas owner", s => { s.job.canvas_id = "canvas-2"; }],
    ["job sandbox", s => { s.job.sandbox_id = "sandbox-2"; }],
    ["attempt owner", s => { s.attempt.id = "attempt-2"; }],
    ["attempt status", s => { s.attempt.status = "interrupted"; }],
    ["cancellation", s => { s.attempt.cancel_requested = true; }],
    ["attempt sandbox", s => { s.attempt.sandbox_id = "sandbox-2"; }],
  ];
  for (const [label, mutate] of cases) {
    const state = humanWaitState();
    mutate(state);
    assert.equal(planHumanWaitSettlement(state).action, "skip", `${label} must stay unresolved`);
  }
});

test("replay requires provider-backed disappearance; surviving resources stay blocked", () => {
  assert.equal(humanWaitResourcesPresent([], humanWaitInput), false);
  assert.equal(humanWaitResourcesPresent(
    [{ resourceId: "r1", jobId: "job-1", attemptId: "attempt-1" }], humanWaitInput,
  ), true);
});

test("source contract: Job-wide admission gate is unchanged and compensation is wired", () => {
  const admission = readFileSync(new URL("./domains/job-control/repair-admission.ts", import.meta.url), "utf8");
  assert.match(admission, /WHERE job_id=\$\{jobId\} AND status<>'settled'/u);
  assert.match(admission, /Unknown old effects never become safe by interruption/u);
  assert.doesNotMatch(admission, /AND effect_kind='agent_run'/u);
  const cleanup = readFileSync(new URL("./dispatcher-human-wait.ts", import.meta.url), "utf8");
  assert.match(cleanup, /runner\.listResources\(\{ jobId: input\.jobId, attemptId: input\.attemptId \}\)/u);
  assert.match(cleanup, /humanWaitResourcesPresent\(resources, input\)/u);
  assert.match(cleanup, /await runner\.destroy\(\{ sandboxId: input\.sandboxId \}\)/u);
  assert.match(cleanup, /x\.effect_kind='agent_run'/u);
  assert.match(cleanup, /x\.status='effect_pending'/u);
  const loop = readFileSync(new URL("./effect-reconcile-loop.ts", import.meta.url), "utf8");
  assert.match(loop, /await options\.humanWaitReconcile\(\)/u);
  const runnerFile = readFileSync(new URL("./domains/job-attempt/reconcile-effects-runner.ts", import.meta.url), "utf8");
  assert.match(runnerFile, /AND a\.status <> 'active'/u); // original reconciler keeps its exclusion
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(index, /humanWaitReconcile: \(\) => reconcileHumanWaitRuns\(sql, runner\)/u);
});
