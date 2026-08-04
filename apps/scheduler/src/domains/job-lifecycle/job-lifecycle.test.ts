import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canTransition as coreCanTransition } from "../../core.js";
import {
  createJobLifecycleApplication,
  type JobTransitionRequest,
} from "./application.js";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATUSES,
  allowedSourcesForTarget,
  canTransition,
  isKnownJobStatus,
  isTerminalJobStatus,
} from "./transition-policy.js";

const architectureDoc = readFileSync(
  new URL("../../../../../docs/ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md", import.meta.url),
  "utf8",
);

const expectedTransitions: Record<string, readonly string[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"],
  failed: ["pending"],
  timeout: ["pending"],
  orphan: ["pending"],
  succeeded: [],
  cancelled: [],
};

test("Job lifecycle policy exposes the complete legal/illegal transition matrix", () => {
  assert.deepEqual(JOB_STATUSES, Object.keys(expectedTransitions));
  assert.deepEqual(JOB_TRANSITIONS, expectedTransitions);

  const matrixStatuses: readonly string[] = [...JOB_STATUSES, "unknown"];
  for (const from of matrixStatuses) {
    for (const to of matrixStatuses) {
      const expected = expectedTransitions[from]?.includes(to) ?? false;
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }

  assert.equal(canTransition("pending", "PENDING"), false);
  assert.equal(isKnownJobStatus("running"), true);
  assert.equal(isKnownJobStatus("future_status"), false);
  assert.equal(coreCanTransition("running", "succeeded"), true, "core facade delegates to policy");
});

test("target source guards are deterministic and reject unknown targets", () => {
  assert.deepEqual(allowedSourcesForTarget("pending"), ["waiting_human", "failed", "timeout", "orphan"]);
  assert.deepEqual(allowedSourcesForTarget("cancelled"), ["pending", "claimed", "provisioning", "running", "waiting_human"]);
  assert.deepEqual(allowedSourcesForTarget("succeeded"), ["running"]);
  assert.deepEqual(allowedSourcesForTarget("unknown"), []);
});

test("terminal statuses have no outgoing transitions", () => {
  for (const status of TERMINAL_JOB_STATUSES) {
    assert.equal(isTerminalJobStatus(status), true);
    for (const target of JOB_STATUSES) assert.equal(canTransition(status, target), false);
  }
  assert.equal(isTerminalJobStatus("running"), false);
});

test("application seam passes policy-approved guards and patch to one atomic executor", async () => {
  const calls: JobTransitionRequest[] = [];
  const app = createJobLifecycleApplication(async (request) => {
    calls.push(request);
    return { id: request.jobId, status: request.to };
  });

  const patch = { started_at: new Date("2026-08-04T00:00:00.000Z") };
  const result = await app.transitionJob("job-1", "running", patch);
  assert.deepEqual(result, { id: "job-1", status: "running" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    jobId: "job-1",
    to: "running",
    allowedFrom: ["provisioning"],
    patch,
  });
});

test("patch.status cannot override the target and never reaches persistence", async () => {
  let calls = 0;
  const app = createJobLifecycleApplication(async () => {
    calls += 1;
    return { id: "unexpected", status: "succeeded" };
  });

  await assert.rejects(
    () => app.transitionJob("job-status-patch", "running", { status: "succeeded" }),
    /patch must not include status/,
  );
  assert.equal(calls, 0);
});

test("unknown targets fail before persistence and stale terminal events are idempotent", async () => {
  const calls: JobTransitionRequest[] = [];
  let status = "running";
  const app = createJobLifecycleApplication(async (request) => {
    calls.push(request);
    if (!request.allowedFrom.includes(status as (typeof JOB_STATUSES)[number])) return null;
    status = request.to;
    return { id: request.jobId, status };
  });

  await assert.rejects(() => app.transitionJob("job-2", "not-a-status"), /非法目标状态/);
  assert.equal(calls.length, 0, "invalid target must not issue SQL");

  assert.deepEqual(await app.transitionJob("job-2", "succeeded"), { id: "job-2", status: "succeeded" });
  assert.equal(status, "succeeded");
  assert.equal(await app.transitionJob("job-2", "succeeded"), null, "duplicate terminal event is a no-op");
  assert.equal(await app.transitionJob("job-2", "failed"), null, "late failure cannot overwrite success");
  assert.equal(status, "succeeded");
  assert.deepEqual(calls.map(({ to, allowedFrom }) => ({ to, allowedFrom })), [
    { to: "succeeded", allowedFrom: ["running"] },
    { to: "succeeded", allowedFrom: ["running"] },
    { to: "failed", allowedFrom: ["claimed", "provisioning", "running", "waiting_human"] },
  ]);
});

test("lock-order contract keeps Canvas-aware event ingress out of Job-first transactions", () => {
  assert.match(architectureDoc, /Event ingress \(Job-only\).*commit/s);
  assert.match(architectureDoc, /never acquire Canvas under an already-held Job lock/i);
  assert.match(architectureDoc, /Canvas-aware target.*commit.*new Canvas-first convergence transaction/s);
  assert.match(architectureDoc, /never acquire Finding\/Round child locks while the Job-first append transaction is open/);
  assert.match(architectureDoc, /ingestEvent.*applySideEffects.*migration\s+debt/s);
  assert.match(architectureDoc, /rejects a `patch\.status` property/);
});
