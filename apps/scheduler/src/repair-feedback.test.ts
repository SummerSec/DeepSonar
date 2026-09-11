import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET,
  DONE_SUMMARY_MAX_BYTES,
  DonePayload,
  REPAIR_FEEDBACK_CATEGORIES,
  RepairFeedback,
  SEMANTIC_EVENT_PAYLOAD_MAX_BYTES,
  buildRepairFeedback,
  describeObservedShape,
  repairCategoryForControlFailure,
  repairFeedbackFromControlRejection,
  repairFeedbackFromZodIssues,
} from "@deepsonar/shared-types";
import { ControlInputError } from "./control-input.js";
import { assertSemanticEventPayloadSize } from "./domains/event-ingestion/application.js";
import { controlPlatformFailure, controlRuntimeRejection, controlSchemaRejection } from "./domains/platform-api/repair.js";

test("RepairFeedback accepts the four kernel categories and rejects unknown ones", () => {
  for (const category of REPAIR_FEEDBACK_CATEGORIES) {
    const parsed = RepairFeedback.safeParse(buildRepairFeedback({
      category,
      code: "invalid_payload",
      operation: "emit_fact",
      message: "字段不符合契约。",
    }));
    assert.equal(parsed.success, true, category);
  }
  assert.equal(RepairFeedback.safeParse({
    category: "soft_fail",
    code: "invalid_payload",
    operation: "emit_fact",
    message: "nope",
  }).success, false);
});

test("describeObservedShape keeps type/length/count and never copies contents", () => {
  const secret = "sk-live-should-not-leak";
  const shape = describeObservedShape(secret);
  assert.deepEqual(shape, { type: "string", length: secret.length, utf8_bytes: secret.length });
  assert.equal(JSON.stringify(shape).includes("sk-live"), false);
  assert.deepEqual(describeObservedShape(["a", "b", "c"]), { type: "array", length: 3 });
  assert.deepEqual(describeObservedShape({ title: "x", extra: 1 }), { type: "object", keys: 2 });
});

test("oversized mark_job_done.summary becomes model_correctable RepairFeedback", () => {
  const summary = `${"界".repeat(2730)}ab界`;
  const parsed = DonePayload.safeParse({ summary });
  assert.equal(parsed.success, false);
  const issues = parsed.success ? [] : parsed.error.issues;
  const key = "00000000-0000-4000-8000-000000000021";
  const repair = repairFeedbackFromZodIssues({
    operation: "mark_job_done",
    code: "invalid_done",
    issues,
    rawInput: { summary },
    idempotency_key: key,
  });
  assert.equal(repair.category, "model_correctable");
  assert.equal(repair.code, "invalid_done");
  assert.equal(repair.operation, "mark_job_done");
  assert.equal(repair.path, "summary");
  assert.deepEqual(repair.expected, { kind: "utf8_bytes_max", max: DONE_SUMMARY_MAX_BYTES });
  assert.deepEqual(repair.observed_shape, {
    type: "string",
    length: summary.length,
    utf8_bytes: Buffer.byteLength(summary, "utf8"),
  });
  assert.equal(repair.idempotency_key, key);
  assert.equal(repair.remaining_budget.attempts, DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET);
  assert.match(repair.next_action ?? "", /新的 Idempotency-Key/);
  assert.equal(JSON.stringify(repair).includes(summary.slice(0, 12)), false);
  const body = controlSchemaRejection({
    operation: "mark_job_done",
    code: "invalid_done",
    issues,
    rawInput: { summary },
    idempotencyKey: key,
  });
  assert.equal(body.accepted, false);
  assert.equal(body.retryable, true);
  assert.equal(body.error_code, "invalid_done");
  assert.equal(body.repair.category, "model_correctable");
  assert.notEqual(body.error, "Platform operation was rejected");
});

test("payload-size ControlInputError carries expected/observed_shape for RepairFeedback", () => {
  const value = { title: "valid fact", description: "x".repeat(SEMANTIC_EVENT_PAYLOAD_MAX_BYTES) };
  assert.throws(
    () => assertSemanticEventPayloadSize("fact", value),
    (error: unknown) => {
      assert.ok(error instanceof ControlInputError);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details?.expected, { kind: "utf8_bytes_max", max: SEMANTIC_EVENT_PAYLOAD_MAX_BYTES });
      const observed = error.details?.observed_shape as { type?: string; utf8_bytes?: number };
      assert.equal(observed.type, "json");
      assert.ok(Number(observed.utf8_bytes) > SEMANTIC_EVENT_PAYLOAD_MAX_BYTES);
      const body = controlRuntimeRejection({
        operation: "emit_fact",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        path: error.path,
        details: error.details,
        idempotencyKey: "00000000-0000-4000-8000-000000000022",
      });
      assert.equal(body.repair.category, "model_correctable");
      assert.deepEqual(body.repair.expected, { kind: "utf8_bytes_max", max: SEMANTIC_EVENT_PAYLOAD_MAX_BYTES });
      assert.match(body.repair.next_action ?? "", /payload_file|拆分/);
      return true;
    },
  );
});

test("rate-limit and fail-closed control codes map to the remaining kernel categories", () => {
  assert.equal(repairCategoryForControlFailure({ code: "event_rate_limited", statusCode: 429, retryable: true }), "transient_retryable");
  assert.equal(repairCategoryForControlFailure({ code: "tool_not_allowed", retryable: false }), "permanent_failure");
  assert.equal(repairCategoryForControlFailure({ code: "job_not_running", retryable: false }), "permanent_failure");
  const transient = repairFeedbackFromControlRejection({
    operation: "emit_progress",
    code: "event_rate_limited",
    message: "[event_rate_limited] semantic progress event budget exhausted; retry after 5s",
    retryable: true,
    statusCode: 429,
    details: { retry_after_sec: 5, bucket: "progress", limit: 30, window_seconds: 60 },
    idempotency_key: "00000000-0000-4000-8000-000000000023",
  });
  assert.equal(transient.category, "transient_retryable");
  assert.deepEqual(transient.expected, {
    kind: "rate_limit",
    retry_after_sec: 5,
    bucket: "progress",
    limit: 30,
    window_seconds: 60,
  });
  assert.match(transient.next_action ?? "", /同一 Idempotency-Key/);
  const unknown = buildRepairFeedback({
    category: "unknown_external_effect",
    code: "effect_unknown",
    operation: "destroy_sandbox",
    message: "外部效果结果未知，禁止自动重放。",
    accepted_effects: [{ effect_id: "eff-1", status: "unknown" }],
  });
  assert.equal(unknown.category, "unknown_external_effect");
  assert.equal(unknown.accepted_effects?.[0]?.status, "unknown");
});

test("handler unavailable and failed use the same transient RepairFeedback contract", () => {
  const key = "00000000-0000-4000-8000-000000000024";
  const unavailable = controlPlatformFailure({
    operation: "emit_finding",
    code: "HANDLER_UNAVAILABLE",
    message: "Runtime handler is not registered",
    idempotencyKey: key,
  });
  const failed = controlPlatformFailure({
    operation: "emit_finding",
    code: "HANDLER_FAILED",
    message: "Platform operation failed",
    idempotencyKey: key,
  });
  for (const body of [unavailable, failed]) {
    assert.equal(body.accepted, false);
    assert.equal(body.retryable, true);
    assert.equal(body.repair.category, "transient_retryable");
    assert.equal(body.repair.operation, "emit_finding");
    assert.equal(body.repair.idempotency_key, key);
    assert.match(body.repair.next_action ?? "", /同一 Idempotency-Key/);
  }
  assert.equal(unavailable.error_code, "HANDLER_UNAVAILABLE");
  assert.equal(failed.error_code, "HANDLER_FAILED");
  assert.equal(repairCategoryForControlFailure({ code: "HANDLER_UNAVAILABLE", statusCode: 503 }), "transient_retryable");
  assert.equal(repairCategoryForControlFailure({ code: "HANDLER_FAILED", statusCode: 500 }), "transient_retryable");
});
