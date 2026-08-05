import assert from "node:assert/strict";
import test from "node:test";
import { createReportConvergenceApplication } from "./application.js";

test("report convergence application delegates report gates without opening a nested transaction", async () => {
  const calls: string[] = [];
  const app = createReportConvergenceApplication({
    buildReportInput: async () => ({ task: { canvas_id: "canvas" } }),
    buildFindingReportInput: async () => ({ scope: "finding" }),
    buildSarifFromConfirmed: () => ({ version: "2.1.0" }),
    maybeDispatchFindingReport: async () => calls.push("finding-report"),
    maybeDispatchReport: async () => calls.push("task-report"),
    finalizeReportJob: async () => calls.push("finalize"),
    readReportBlob: async () => Buffer.from("{}"),
    getTaskReport: async () => null,
    getTaskReportById: async () => null,
    getFindingReport: async () => null,
    getFindingReportById: async () => null,
    createFindingReport: async () => ({ dispatched: true }),
    retryReport: async () => ({ ok: true }),
  });
  const fakeTx = (() => Promise.resolve([])) as never;
  await app.maybeDispatchReport(fakeTx, "canvas");
  await app.maybeDispatchFindingReport(fakeTx, "finding");
  assert.deepEqual(calls, ["task-report", "finding-report"]);
});
