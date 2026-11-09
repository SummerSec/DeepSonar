import assert from "node:assert/strict";
import test from "node:test";
import { canClaimQueuedTask, decideTaskQueueReconciliation } from "./task-queue-model.js";

test("an unqueued canvas and the current active canvas can claim internal Jobs", () => {
  assert.equal(canClaimQueuedTask({ queuePaused: true, itemState: null, isHead: false }), true);
  assert.equal(canClaimQueuedTask({ queuePaused: true, itemState: "active", isHead: true }), true);
});

test("a paused queue blocks its queued head and every later canvas", () => {
  assert.equal(canClaimQueuedTask({ queuePaused: true, itemState: "queued", isHead: true }), false);
  assert.equal(canClaimQueuedTask({ queuePaused: false, itemState: "queued", isHead: false }), false);
  assert.equal(canClaimQueuedTask({ queuePaused: false, itemState: "succeeded", isHead: false }), false);
});

test("one succeeded Job does not finish a task before root and current report converge", () => {
  const decision = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: false,
    latestJobStatus: "succeeded",
    rootStatus: "analysis_complete",
    currentTaskReportStatus: "pending",
    reportNodeStatus: "succeeded",
  });
  assert.deepEqual(decision, { kind: "hold", blockReason: "report_pending" });
});

test("the latest task report takes precedence over a stale report node projection", () => {
  const decision = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: false,
    latestJobStatus: "succeeded",
    rootStatus: "succeeded",
    currentTaskReportStatus: "succeeded",
    reportNodeStatus: "failed",
  });
  assert.deepEqual(decision, { kind: "succeed" });
});

test("a platform-succeeded task without a report row or node does not gain a new report gate", () => {
  const decision = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: false,
    latestJobStatus: "succeeded",
    rootStatus: "succeeded",
    currentTaskReportStatus: null,
    reportNodeStatus: null,
  });
  assert.deepEqual(decision, { kind: "succeed" });
});

test("old Root and report success cannot close a newer queue generation", () => {
  const decision = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: false,
    latestJobStatus: "succeeded",
    rootStatus: "__stale_completion__",
    currentTaskReportStatus: "__stale_completion__",
    reportNodeStatus: "succeeded",
  });
  assert.deepEqual(decision, { kind: "hold", blockReason: "stale_completion" });
});

test("waiting human, unknown effects, and task pause keep the head unsettled", () => {
  const base = {
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 1,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active" as const,
    queuePaused: false,
    latestJobStatus: "succeeded",
    rootStatus: "succeeded",
    currentTaskReportStatus: "succeeded",
    reportNodeStatus: "succeeded",
  };
  assert.deepEqual(
    decideTaskQueueReconciliation({ ...base, waitingHumanCount: 1 }),
    { kind: "hold", blockReason: "waiting_human" },
  );
  assert.deepEqual(
    decideTaskQueueReconciliation({ ...base, activeJobCount: 0, unresolvedEffect: true }),
    { kind: "hold", blockReason: "unknown_effect" },
  );
  assert.deepEqual(
    decideTaskQueueReconciliation({ ...base, activeJobCount: 0, executionPaused: true }),
    { kind: "hold", blockReason: "task_paused" },
  );
});

test("a terminal latest failure pauses until explicit resume while a newer success wins over history", () => {
  const failed = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: false,
    latestJobStatus: "failed",
    rootStatus: "succeeded",
    currentTaskReportStatus: "succeeded",
    reportNodeStatus: "succeeded",
  });
  assert.deepEqual(failed, { kind: "pause", pauseReason: "task_failed" });

  const recovered = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: true,
    latestJobStatus: "succeeded",
    rootStatus: "succeeded",
    currentTaskReportStatus: "succeeded",
    reportNodeStatus: "failed",
  });
  assert.deepEqual(recovered, { kind: "succeed" });
});

test("manual queue pause still permits the active task to converge", () => {
  const decision = decideTaskQueueReconciliation({
    canvasArchived: false,
    projectArchived: false,
    executionPaused: false,
    activeJobCount: 0,
    waitingHumanCount: 0,
    unresolvedEffect: false,
    hasStarted: true,
    itemState: "active",
    queuePaused: true,
    latestJobStatus: "succeeded",
    rootStatus: "succeeded",
    currentTaskReportStatus: "succeeded",
    reportNodeStatus: "succeeded",
  });
  assert.deepEqual(decision, { kind: "succeed" });
});
