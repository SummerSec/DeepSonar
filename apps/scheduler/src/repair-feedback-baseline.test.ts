import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DonePayload, RepairFeedback } from "@deepsonar/shared-types";
import { controlPlatformFailure, controlRuntimeRejection, controlSchemaRejection } from "./domains/platform-api/repair.js";

// Frozen, synthetic requests in the real Control JSON format. No model or DB.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/repair-feedback/baseline.json", import.meta.url), "utf8"));
const common = ["category", "code", "idempotency_key", "message", "next_action", "operation",
  "proposal_revision", "remaining_budget", "repair_attempt", "v"];

for (const sample of fixture.cases) {
  test(`repair baseline: ${sample.id}`, () => {
    const replay = () => {
      if (sample.source === "schema") {
        const parsed = DonePayload.safeParse(sample.payload);
        assert.equal(parsed.success, false);
        if (parsed.success) throw new Error("fixture must be rejected");
        return controlSchemaRejection({ operation: sample.operation, code: sample.code,
          issues: parsed.error.issues, rawInput: sample.payload, idempotencyKey: fixture.idempotency_key });
      }
      if (sample.source === "platform_failure") {
        return controlPlatformFailure({ operation: sample.operation, code: sample.code,
          message: sample.message, idempotencyKey: fixture.idempotency_key });
      }
      return controlRuntimeRejection({ operation: sample.operation, code: sample.code,
        message: sample.message, path: sample.path ?? undefined, retryable: sample.retryable,
        rawInput: sample.payload,
        idempotencyKey: fixture.idempotency_key });
    };
    // JSON round-trip matches the wire, omitting undefined optional properties.
    const body = JSON.parse(JSON.stringify(replay()));
    assert.equal(body.accepted, false);
    assert.equal(body.error_code, sample.code);
    assert.equal(RepairFeedback.safeParse(body.repair).success, true);
    assert.equal(body.repair.category, sample.category);
    assert.equal(body.repair.operation, sample.operation);
    assert.equal(body.repair.idempotency_key, fixture.idempotency_key);
    assert.equal(body.repair.path, sample.path ?? undefined);
    const fields = [...common, ...(sample.path ? ["path"] : []),
      ...(sample.source === "schema" ? ["expected"] : []),
      ...(sample.observed_shape ? ["observed_shape"] : [])];
    assert.deepEqual(Object.keys(body.repair).sort(), fields.sort());
    if (sample.source === "schema") {
      assert.deepEqual(body.repair.expected, sample.expected);
    }
    assert.deepEqual(body.repair.observed_shape, sample.observed_shape);
    assert.equal(JSON.stringify(body).includes("fixture-private-marker"), false);
    // Characterization, NOT a persistent repair budget: repeated calls reset to 0/8.
    assert.equal(body.repair.proposal_revision, 0);
    assert.equal(body.repair.repair_attempt, 0);
    assert.deepEqual(body.repair.remaining_budget,
      sample.category === "model_correctable" ? { attempts: 8 } : {});
    assert.deepEqual(JSON.parse(JSON.stringify(replay())), body);
    assert.equal(body.repair.accepted_effects, undefined);
    assert.equal(body.repair.current_state_ref, undefined);
  });
}

test("valid first completion and UTF-8 boundary need no schema repair", () => {
  for (const summary of ["completed", `${"界".repeat(2730)}ab`]) {
    assert.equal(DonePayload.safeParse({ summary }).success, true);
  }
});
