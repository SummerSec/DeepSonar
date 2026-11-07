import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isRetryableDatabaseConflict, withOperationConflictRetry } from "./db-conflict-retry.js";
import {
  MAX_AUTOMATIC_REPORT_RETRIES,
  planTaskReportFailureRecovery,
  readAutomaticReportRetryCount,
  reportFailureMessage,
  ROOT_STATUS_REPORT_FAILED,
  shouldKeepRootReporting,
} from "./report-failure-recovery.js";

function reportRecoveryTransaction(failure: Error | null) {
  const queries: string[] = [];
  let aborted = false, queriesAfterAbort = 0;
  const tagged = async (strings: TemplateStringsArray) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (aborted) {
      queriesAfterAbort += 1;
      throw Object.assign(new Error("transaction already aborted"), { code: "25P02" });
    }
    if (query.startsWith("SELECT * FROM jobs")) return [{ id: "report-job", type: "report", canvas_id: "report-canvas", payload_json: {} }];
    if (query.startsWith("SELECT id FROM canvases")) return [{ id: "report-canvas" }];
    if (query.startsWith("SELECT id, status, summary_json FROM task_reports")) return [{ id: "report-row", summary_json: {} }];
    if (query.startsWith("SELECT id, project_id FROM canvases")) {
      if (failure) { aborted = isRetryableDatabaseConflict(failure); throw failure; }
      return []; // No new Report is admitted; the real finalizer follows its ordinary Root settlement path.
    }
    if (query.startsWith("UPDATE ")) return [];
    assert.fail(`unexpected report recovery query: ${query}`);
  };
  return { tx: Object.assign(tagged, { json: (value: unknown) => value }), queries, queriesAfterAbort: () => queriesAfterAbort };
}

for (const code of ["40P01", "40001", "55P03"]) {
  test(`#945 report redispatch preserves ${code} instead of replacing it with 25P02`, async () => {
    process.env.AGENT_MODE = "fake";
    const { finalizeReportJob } = await import("./report.js");
    const failure = Object.assign(new Error("retryable transaction conflict"), { code });
    const failed = reportRecoveryTransaction(failure);
    // This fixture implements only SQL, not a database connection or an external dispatch port.
    const asTx = (fixture: ReturnType<typeof reportRecoveryTransaction>) => fixture.tx as unknown as Parameters<typeof finalizeReportJob>[0];
    await assert.rejects(finalizeReportJob(asTx(failed), "report-job", { failed: true }), error => error === failure);
    assert.equal(failed.queriesAfterAbort(), 0, "the aborted transaction must not continue with Root settlement SQL");
    const recovered = reportRecoveryTransaction(null);
    let attempts = 0;
    await withOperationConflictRetry("report_recovery_probe", async () => {
      attempts += 1;
      await finalizeReportJob(asTx(attempts === 1 ? reportRecoveryTransaction(failure) : recovered), "report-job", { failed: true });
    }, { baseDelayMs: 0 });
    assert.equal(attempts, 2);
    assert.ok(recovered.queries.some(query => query.includes("body_json = body_json ||")), "the successful attempt settles the Root");
  });
}

test("#945 report business failures retain the existing bounded Root settlement", async () => {
  process.env.AGENT_MODE = "fake";
  const { finalizeReportJob } = await import("./report.js");
  const fixture = reportRecoveryTransaction(new Error("ordinary dispatch failure"));
  await finalizeReportJob(fixture.tx as unknown as Parameters<typeof finalizeReportJob>[0], "report-job", { failed: true });
  assert.ok(fixture.queries.some(query => query.includes("body_json = body_json ||")));
  assert.equal(fixture.queriesAfterAbort(), 0);
});

test("#945 snapshot resolution cannot hide a retryable database cause from report dispatch", () => {
  const source = readFileSync(new URL("./report.ts", import.meta.url), "utf8");
  assert.match(source, /catch \(e\) \{\s*if \(isRetryableDatabaseConflict\(e\)\) throw e;\s*console\.warn\(`\[report\] resolve snapshot failed:/);
});

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
