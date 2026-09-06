import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_INPUT_ERROR_CODES } from "./control-input.js";
import {
  acceptedEventAttribution,
  EVENT_LINEARIZATION,
  isSemanticAcceptingStatus,
  jobNotRunningError,
  LATE_EVENT_JOB_STATUSES,
  lateEventAttribution,
} from "./event-attribution.js";

test("only running Jobs accept semantic events", () => {
  assert.equal(isSemanticAcceptingStatus("running"), true);
  for (const status of LATE_EVENT_JOB_STATUSES) {
    assert.equal(isSemanticAcceptingStatus(status), false, status);
  }
});

test("late events keep the stable job_not_running code and attribution details", () => {
  for (const status of ["cancelled", "timeout", "orphan", "succeeded", "waiting_human"]) {
    const attribution = lateEventAttribution({
      jobId: "job-1",
      jobStatus: status,
      attemptId: "attempt-1",
    });
    assert.equal(attribution.linearization, EVENT_LINEARIZATION);
    assert.equal(attribution.accepted, false);
    assert.equal(attribution.canvas_mutated, false);
    const error = jobNotRunningError(attribution);
    assert.equal(error.code, CONTROL_INPUT_ERROR_CODES.jobNotRunning);
    assert.deepEqual(error.details, attribution);
    assert.equal(error.retryable, false);
  }
});

test("accepted attribution records the lock-time Attempt and job_seq", () => {
  assert.deepEqual(acceptedEventAttribution({ jobId: "job-1", attemptId: "attempt-9", jobSeq: 4 }), {
    job_id: "job-1",
    job_status: "running",
    attempt_id: "attempt-9",
    job_seq: 4,
    linearization: EVENT_LINEARIZATION,
    accepted: true,
    canvas_mutated: true,
  });
});
