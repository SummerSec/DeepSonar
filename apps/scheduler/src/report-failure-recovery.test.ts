import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTOMATIC_REPORT_RETRIES,
  planTaskReportFailureRecovery,
  readAutomaticReportRetryCount,
  reportFailureMessage,
  ROOT_STATUS_REPORT_FAILED,
  shouldKeepRootReporting,
} from "./report-failure-recovery.js";

test("empty jobs.error still yields a stable report failure message", () => {
  assert.equal(reportFailureMessage(""), "report_job_terminal_failed");
  assert.equal(reportFailureMessage("   "), "report_job_terminal_failed");
  assert.equal(reportFailureMessage(null), "report_job_terminal_failed");
  assert.equal(reportFailureMessage(undefined), "report_job_terminal_failed");
  assert.equal(
    reportFailureMessage("agent 运行失败: PostgresError deadlock detected 40P01"),
    "agent 运行失败: PostgresError deadlock detected 40P01",
  );
});

test("automatic report retry budget is one, then Root must leave reporting", () => {
  assert.equal(MAX_AUTOMATIC_REPORT_RETRIES, 1);
  assert.deepEqual(planTaskReportFailureRecovery(0), {
    retry: true,
    nextRetryCount: 1,
    settleRoot: false,
  });
  assert.deepEqual(planTaskReportFailureRecovery(1), {
    retry: false,
    nextRetryCount: 1,
    settleRoot: true,
  });
  assert.deepEqual(planTaskReportFailureRecovery(2), {
    retry: false,
    nextRetryCount: 2,
    settleRoot: true,
  });
  assert.equal(ROOT_STATUS_REPORT_FAILED, "report_failed");
});

test("40P01 and empty-error failures share the same retry budget, not error needles", () => {
  const first = planTaskReportFailureRecovery(readAutomaticReportRetryCount({}));
  assert.equal(first.retry, true);
  const afterDeadlock = planTaskReportFailureRecovery(
    readAutomaticReportRetryCount({ automatic_retry_count: first.nextRetryCount }),
  );
  assert.equal(afterDeadlock.retry, false);
  assert.equal(afterDeadlock.settleRoot, true);
  const afterEmptyError = planTaskReportFailureRecovery(
    readAutomaticReportRetryCount({ automatic_retry_count: 1, last_failure_at: "2026-09-14T10:09:30Z" }),
  );
  assert.equal(afterEmptyError.settleRoot, true);
});

test("Root stays reporting only while a new report Job is in flight or the gate bounced", () => {
  assert.equal(shouldKeepRootReporting({ dispatched: true }), true);
  assert.equal(shouldKeepRootReporting({ bounced: true, reason: "report_gate_failed_bounced_hub" }), true);
  assert.equal(shouldKeepRootReporting({ reason: "report_in_flight" }), true);
  assert.equal(shouldKeepRootReporting({ reason: "report_job_exists" }), true);
  assert.equal(shouldKeepRootReporting({ reason: "active_work" }), false);
  assert.equal(shouldKeepRootReporting({ reason: "already_succeeded" }), false);
});
