import assert from "node:assert/strict";
import test from "node:test";
import { analysisCompleteGateExpected } from "./completion-feedback.js";
import { controlRuntimeRejection } from "../platform-api/repair.js";

test("completion gate feedback is fixed-size, deterministic and never projects arbitrary problem text", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const gate = { blockers: ["active_work", "no_role_work", `finding:${id}:pending`, `finding:${id}:verifying`,
    `finding:${id}:false_positive`, ...["confirmed", "refuted", "inconclusive"].map(s => `finding:${id}:${s}_without_round`),
    `finding:${id}:needs_human_without_blocker`, `open_round:${id}`, "SECRET", "finding:SECRET:pending"],
    problems: [{ title: "SECRET", issue: "SECRET", finding_id: "SECRET" }] };
  const expected = analysisCompleteGateExpected(gate);
  assert.deepEqual(expected.observed_counts, { active_work: 1, no_role_work: 1, finding_not_converged: 3,
    missing_verification_round: 3, missing_human_blocker: 1, open_round: 1, other: 2 });
  assert.deepEqual(expected, analysisCompleteGateExpected({ blockers: [...gate.blockers].reverse() }));
  assert.equal(expected.count_capped, false);
  assert.doesNotMatch(JSON.stringify(expected), /SECRET|aaaaaaaa/);
  assert.equal(analysisCompleteGateExpected({ blockers: Array(1000).fill("active_work") }).count_capped, false);
  const large = analysisCompleteGateExpected({ blockers: Array(10001).fill(`finding:${id}:pending`) });
  assert.equal(large.observed_counts.finding_not_converged, 1000);
  assert.equal(large.count_capped, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 1200);
  const body = controlRuntimeRejection({ operation: "submit_hub_decision", code: "invalid_payload", message: "complete rejected",
    retryable: true, statusCode: 422, path: "complete", details: { expected } });
  assert.deepEqual(body.repair.expected, expected);
  assert.deepEqual(body.details?.expected, expected, "canonical and allowlisted projection keep the same bounded object");
  assert.equal(body.repair.accepted_effects, undefined);
  assert.match(body.repair.next_action!, /expected.*Idempotency-Key/);
});
