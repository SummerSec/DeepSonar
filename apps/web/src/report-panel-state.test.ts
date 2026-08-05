import assert from "node:assert/strict";
import test from "node:test";
import { ReportPanelAsyncGuard, resetReportPanelState } from "./report-panel-state";

test("canvas changes invalidate late poll and download completions", async () => {
  const guard = new ReportPanelAsyncGuard("canvas-a");
  const contextA = guard.update("canvas-a", "report-a", "succeeded");
  const pollA = guard.beginPoll();

  let appliedReports: string[] = [];
  let downloadErrors: string[] = [];
  const latePoll = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (guard.isCurrentPoll(pollA)) appliedReports.push("report-a");
      resolve();
    }, 5);
  });
  const lateDownload = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (guard.isCurrentContext(contextA)) downloadErrors.push("download-a");
      resolve();
    }, 5);
  });

  // The new canvas is visible before either deferred A completion fires.
  const reset = resetReportPanelState();
  const contextB = guard.update("canvas-b", null, null);
  assert.notEqual(contextB, contextA);
  assert.equal(guard.isCurrentContext(contextA), false);
  assert.equal(guard.isCurrentCanvas(contextA), false);
  assert.equal(reset.report, null);
  assert.equal(reset.markdown, null);
  assert.equal(reset.error, null);
  assert.equal(reset.downloadError, null);
  assert.equal(reset.downloading, null);

  await Promise.all([latePoll, lateDownload]);
  assert.deepEqual(appliedReports, []);
  assert.deepEqual(downloadErrors, []);
});

test("only the newest overlapping poll request can update state", () => {
  const guard = new ReportPanelAsyncGuard("canvas-a");
  const first = guard.beginPoll();
  const second = guard.beginPoll();

  assert.equal(guard.isCurrentPoll(first), false);
  assert.equal(guard.isCurrentPoll(second), true);
});

test("dispose invalidates every pending callback after unmount", async () => {
  const guard = new ReportPanelAsyncGuard("canvas-a");
  const context = guard.update("canvas-a", "report-a", "succeeded");
  const poll = guard.beginPoll();
  let appliedReports: string[] = [];
  let markdownResults: string[] = [];
  let downloadErrors: string[] = [];
  let retryCompletions: string[] = [];

  const lateCallbacks = [
    new Promise<void>((resolve) => setTimeout(() => {
      if (guard.isCurrentPoll(poll)) appliedReports.push("report-a");
      resolve();
    }, 5)),
    new Promise<void>((resolve) => setTimeout(() => {
      if (guard.isCurrentContext(context)) markdownResults.push("markdown-a");
      resolve();
    }, 5)),
    new Promise<void>((resolve) => setTimeout(() => {
      if (guard.isCurrentContext(context)) downloadErrors.push("download-a");
      resolve();
    }, 5)),
    new Promise<void>((resolve) => setTimeout(() => {
      if (guard.isCurrentCanvas(context)) retryCompletions.push("retry-a");
      resolve();
    }, 5)),
  ];

  guard.dispose();
  assert.equal(guard.isCurrentPoll(poll), false);
  assert.equal(guard.isCurrentContext(context), false);
  assert.equal(guard.isCurrentCanvas(context), false);
  assert.notEqual(guard.currentContext, context);

  await Promise.all(lateCallbacks);
  assert.deepEqual(appliedReports, []);
  assert.deepEqual(markdownResults, []);
  assert.deepEqual(downloadErrors, []);
  assert.deepEqual(retryCompletions, []);
});
