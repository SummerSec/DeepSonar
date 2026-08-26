import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlEventEnvelope,
  DONE_SUMMARY_MAX_BYTES,
  DonePayload,
  EmitFactDirectPayload,
  EmitFindingDirectPayload,
  HubDecisionPayload,
  ProgressPayload,
  SEMANTIC_EVENT_PAYLOAD_MAX_BYTES,
  WORKSPACE_PAYLOAD_FILE_MAX_BYTES,
} from "@deepsonar/shared-types";
import { ControlInputError } from "../../control-input.js";
import { assertSemanticEventPayloadSize, orderSemanticIngestBundle, shouldSkipTerminalAfterAcceptedHuman } from "./application.js";

import {
  DEFAULT_EVENT_RATE_LIMIT_POLICY,
  EventRateLimitError,
  eventRateLimitBucket,
  normalizeEventRateLimitPolicy,
} from "./rate-limit.js";

test("progress percent is rejected consistently at shared MCP/host schema boundaries", () => {
  for (const percent of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assert.equal(ProgressPayload.safeParse({ message: "phase", percent }).success, false);
    assert.equal(
      ControlEventEnvelope.safeParse({
        v: 1,
        event_id: "00000000-0000-4000-8000-000000000001",
        type: "progress",
        payload: { message: "phase", percent },
      }).success,
      false,
    );
  }
  assert.deepEqual(ProgressPayload.parse({ message: "phase", percent: 100 }), {
    message: "phase",
    percent: 100,
  });
});

test("missing_evidence trims values and rejects whitespace-only entries", () => {
  assert.deepEqual(DonePayload.parse({
    summary: "needs more evidence",
    verdict: "rework",
    missing_evidence: ["  independent_review  ", "runtime_test"],
  }).missing_evidence, ["independent_review", "runtime_test"]);
  assert.equal(DonePayload.safeParse({
    summary: "needs more evidence",
    verdict: "rework",
    missing_evidence: ["   "],
  }).success, false);
});

test("done summary is bounded by UTF-8 bytes with an inclusive 8192-byte boundary", () => {
  const boundary = `${"界".repeat(2730)}ab`;
  const oversized = `${boundary}界`;
  assert.equal(Buffer.byteLength(boundary, "utf8"), DONE_SUMMARY_MAX_BYTES);
  assert.equal(Buffer.byteLength(oversized, "utf8"), DONE_SUMMARY_MAX_BYTES + 3);
  assert.equal(DonePayload.safeParse({ summary: boundary }).success, true);
  assert.equal(DonePayload.safeParse({ summary: oversized }).success, false);
  assert.equal(ControlEventEnvelope.safeParse({
    v: 1,
    event_id: "00000000-0000-4000-8000-000000000002",
    type: "done",
    payload: { summary: oversized },
  }).success, false);
});

test("schema-valid oversized Fact, Finding, and Hub payloads get stable retryable control errors", () => {
  const uuid = "00000000-0000-4000-8000-000000000003";
  const values = [
    ["fact", EmitFactDirectPayload, { title: "valid fact", description: "界".repeat(10000), verification: { finding_id: uuid, evidence_kind: "test", outcome: "supports", subject_revision: "rev", steps: Array(45).fill("界".repeat(2000)) } }],
    ["finding", EmitFindingDirectPayload, { title: "valid finding", summary: "界".repeat(10000), evidence_refs: Array(50).fill("界".repeat(2000)) }],
    ["hub_decision", HubDecisionPayload, { intents: Array(5).fill(0).map((_, index) => ({ from: [], role: "analyze", description: `intent ${index}`, prompt: "界".repeat(20000) })) }],
  ] as const;
  assert.equal(WORKSPACE_PAYLOAD_FILE_MAX_BYTES, SEMANTIC_EVENT_PAYLOAD_MAX_BYTES);
  for (const [type, schema, value] of values) {
    assert.equal(schema.safeParse(value).success, true);
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") > SEMANTIC_EVENT_PAYLOAD_MAX_BYTES);
    assert.throws(
      () => assertSemanticEventPayloadSize(type, value),
      (error: unknown) => error instanceof ControlInputError && error.retryable && error.code === "invalid_payload",
    );
  }
  assert.doesNotThrow(() => assertSemanticEventPayloadSize("fact", { title: "fact", description: "界".repeat(1000) }));
});

test("rate-limit policy is bounded and terminal events use a reserved bucket", () => {
  assert.deepEqual(normalizeEventRateLimitPolicy(undefined), DEFAULT_EVENT_RATE_LIMIT_POLICY);
  assert.equal(normalizeEventRateLimitPolicy({ windowSeconds: 999999 }).windowSeconds, 3600);
  assert.equal(eventRateLimitBucket("progress"), "progress");
  assert.equal(eventRateLimitBucket("done"), "terminal");
  assert.equal(eventRateLimitBucket("human"), "terminal");
  assert.equal(eventRateLimitBucket("finding"), "standard");
});

test("rate-limit rejection exposes stable retry metadata without payload content", () => {
  const error = new EventRateLimitError({
    bucket: "progress",
    limit: 30,
    windowSeconds: 60,
    retryAfterSec: 4.2,
  });
  assert.equal(error.code, "event_rate_limited");
  assert.equal(error.retryAfterSec, 5);
  assert.deepEqual(error.metadata, {
    retry_after_sec: 5,
    bucket: "progress",
    limit: 30,
    window_seconds: 60,
  });
  assert.doesNotMatch(error.message, /secret|payload/i);
});

test("same-turn hub close keeps hub_decision before mark_job_done", () => {
  assert.deepEqual(
    orderSemanticIngestBundle([
      { type: "progress", id: "p" },
      { type: "done", id: "d1" },
      { type: "hub_decision", id: "h" },
      { type: "done", id: "d2" },
    ]).map((event) => event.id),
    ["p", "h", "d1", "d2"],
  );
});

test("same-ingest terminals after accepted request_human are skipped", () => {
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("done", true), true);
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("hub_decision", true), true);
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("human", true), false);
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("progress", true), false);
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("done", false), false);
  assert.equal(shouldSkipTerminalAfterAcceptedHuman("hub_decision", false), false);
});
