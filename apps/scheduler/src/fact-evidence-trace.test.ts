import assert from "node:assert/strict";
import test from "node:test";
import { factEvidenceTraceInternals } from "./fact-evidence-trace.js";

test("extractUsedFactIds prefers verification_state then confirmed round", () => {
  const fromState = factEvidenceTraceInternals.extractUsedFactIds(
    { raw_json: { verification_state: { used_fact_ids: ["a", "b"] } } },
    [],
  );
  assert.deepEqual(fromState, ["a", "b"]);

  const fromRound = factEvidenceTraceInternals.extractUsedFactIds(
    { raw_json: {} },
    [
      {
        status: "confirmed",
        final_outcome: "confirmed",
        requirements_json: { used_fact_ids: ["c"] },
      },
    ],
  );
  assert.deepEqual(fromRound, ["c"]);
});

test("extractSubjectRevision reads frozen confirm revision", () => {
  assert.equal(
    factEvidenceTraceInternals.extractSubjectRevision(
      { raw_json: { verification_state: { subject_revision: "rev@9" } } },
      [],
    ),
    "rev@9",
  );
});

test("extractUsedFactIds falls back to confirm_trace.used_fact_replay ref_ids", () => {
  const ids = factEvidenceTraceInternals.extractUsedFactIds(
    {
      raw_json: {
        verification_state: {
          confirm_trace: {
            used_fact_replay: [{ ref_id: "fact-from-replay" }],
          },
        },
      },
    },
    [],
  );
  assert.deepEqual(ids, ["fact-from-replay"]);
});
