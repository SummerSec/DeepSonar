import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { buildEvidenceSnapshot, evaluateConfirmGate, freezeVerifyFindingSubject, mapProposedVerdict } from "../../verify.js";

test("mapProposedVerdict only accepts confirmed/rework/needs_human", () => {
  assert.equal(mapProposedVerdict("confirmed"), "confirmed");
  assert.equal(mapProposedVerdict("rework"), "rework");
  assert.equal(mapProposedVerdict("needs_human"), "needs_human");
  assert.throws(() => mapProposedVerdict("false_positive"), /confirmed、rework 或 needs_human/);
  assert.throws(() => mapProposedVerdict("unknown"), /confirmed、rework 或 needs_human/);
  assert.throws(() => mapProposedVerdict(null), /confirmed、rework 或 needs_human/);
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
  assert.equal(evaluateConfirmGate(qualified).ok, true);
  assert.equal(evaluateConfirmGate(missingTest).ok, false);
});

test("confirm gate rejects subjective-only support even when review exists", () => {
  const subjective = buildEvidenceSnapshot(
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
            artifact_refs: [{ uri: "shared://only-artifact" }],
          },
        },
      },
    ],
    "origin-job",
  );
  assert.equal(subjective.qualified, true);
  const gate = evaluateConfirmGate(subjective);
  assert.equal(gate.ok, false);
  assert.ok(gate.missing.includes("machine_checkable_expected_actual"));
});

test("verify freeze helper is the only finding payload shape", () => {
  const frozen = freezeVerifyFindingSubject({
    id: "finding-1",
    title: "hidden",
    summary: "hidden summary",
    severity: "high",
    location: "a.c:1",
  });
  assert.deepEqual(Object.keys(frozen).sort(), ["artifact_refs", "id", "location"]);
});

test("finding-verification has one implementation home and no forwarding adapter", () => {
  assert.equal(existsSync(new URL("./application.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./ports.ts", import.meta.url)), false);
});

test("leftover false_positive verdict mapping is gone from Agent-facing copy", () => {
  const verify = readFileSync(new URL("../../verify.ts", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../../platform-tools.ts", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../../executor-real.ts", import.meta.url), "utf8");
  assert.doesNotMatch(verify, /false_positive 兼容期|映射为 rework/);
  assert.doesNotMatch(tools, /兼容 `false_positive`/);
  assert.doesNotMatch(executor, /false_positive→rework|false_positive/);
});

test("unused verify compat wrappers are gone", () => {
  const verify = readFileSync(new URL("../../verify.ts", import.meta.url), "utf8");
  assert.doesNotMatch(verify, /checkCareFindingsConfirmed|requireCareConfirmed|findingVerificationSummary/);
  assert.match(verify, /export async function canvasFindingsConverged/);
  assert.match(verify, /export async function findingVerificationSummaries/);
});
