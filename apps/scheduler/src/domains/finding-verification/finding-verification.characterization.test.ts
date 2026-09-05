import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { buildEvidenceSnapshot, mapProposedVerdict } from "../../verify.js";

test("mapProposedVerdict keeps confirmed/needs_human and folds everything else to rework", () => {
  assert.equal(mapProposedVerdict("confirmed"), "confirmed");
  assert.equal(mapProposedVerdict("needs_human"), "needs_human");
  assert.equal(mapProposedVerdict("false_positive"), "rework");
  assert.equal(mapProposedVerdict("unknown"), "rework");
  assert.equal(mapProposedVerdict(null), "rework");
});

test("buildEvidenceSnapshot requires independent review and a supporting test", () => {
  const qualified = buildEvidenceSnapshot(
    [
      {
        id: "review-node",
        job_id: "review-job",
        job_type: "review",
        job_status: "succeeded",
        title: "review",
        body_json: { verification: { evidence_kind: "review", outcome: "supports" } },
      },
      {
        id: "test-node",
        job_id: "test-job",
        job_type: "test",
        job_status: "succeeded",
        title: "test",
        body_json: {
          verification: {
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "abc",
            steps: ["run"],
            expected: "ok",
            actual: "ok",
          },
        },
      },
    ],
    "origin-job",
  );
  assert.equal(qualified.qualified, true);
  assert.deepEqual(qualified.missing, []);

  const missingTest = buildEvidenceSnapshot(
    [
      {
        id: "review-only",
        job_id: "review-job",
        job_type: "review",
        job_status: "succeeded",
        title: "review",
        body_json: { verification: { evidence_kind: "review", outcome: "supports" } },
      },
    ],
    null,
  );
  assert.equal(missingTest.qualified, false);
  assert.ok(missingTest.missing.includes("runtime_test"));
});

test("finding-verification has one implementation home and no forwarding adapter", () => {
  assert.equal(existsSync(new URL("./application.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./ports.ts", import.meta.url)), false);
});
