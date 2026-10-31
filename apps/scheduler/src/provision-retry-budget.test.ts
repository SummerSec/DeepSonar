import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTOMATIC_PROVISION_RETRIES,
  countConsumedProvisionRetries,
  planAutomaticProvisionRetry,
  PROVISION_RETRY_REASON,
} from "./provision-retry-budget.js";

test("provision retry budget is one and ignores attempt_no", () => {
  assert.equal(MAX_AUTOMATIC_PROVISION_RETRIES, 1);
  assert.deepEqual(planAutomaticProvisionRetry(0), { retry: true, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticProvisionRetry(1), { retry: false, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticProvisionRetry(2), { retry: false, nextRetryCount: 2 });
});

test("40P01 / rerun-current attempts do not consume the sidecar retry budget", () => {
  const afterDeadlock = countConsumedProvisionRetries([
    { status: "failed", outcome_json: { reason: "exception" } },
    { status: "active", outcome_json: {} },
  ]);
  assert.equal(afterDeadlock, 0);
  assert.equal(planAutomaticProvisionRetry(afterDeadlock).retry, true);
});

test("a prior provision_retry consumes the budget even on attempt 2+", () => {
  const consumed = countConsumedProvisionRetries([
    { status: "failed", outcome_json: { reason: PROVISION_RETRY_REASON, retry_scheduled: true } },
    { status: "active", outcome_json: {} },
  ]);
  assert.equal(consumed, 1);
  assert.equal(planAutomaticProvisionRetry(consumed).retry, false);
});

test("active attempts and non-provision outcomes are not counted", () => {
  assert.equal(
    countConsumedProvisionRetries([
      { status: "active", outcome_json: { reason: PROVISION_RETRY_REASON } },
      { status: "failed", outcome_json: { reason: "reaper_timeout" } },
      { status: "failed", state_json: { outcome: { reason: PROVISION_RETRY_REASON } } },
    ]),
    1,
  );
});
