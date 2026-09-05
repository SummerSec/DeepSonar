import assert from "node:assert/strict";
import test from "node:test";
import { projectVerifyFinding } from "./graph.js";
import {
  buildEvidenceSnapshot,
  evaluateConfirmGate,
  freezeVerifyFindingSubject,
  hasMachineCheckableEvidence,
} from "./verify.js";
import { buildVerifyJobPrompt } from "./verify-prompt.js";

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-node",
    job_id: "review-job",
    job_type: "review",
    job_status: "succeeded",
    title: "maker-echo title",
    body_json: {
      description: "maker-echo description",
      verification: { evidence_kind: "review", outcome: "supports" },
    },
    ...overrides,
  };
}

function testRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-node",
    job_id: "test-job",
    job_type: "test",
    job_status: "succeeded",
    title: "runtime",
    body_json: {
      verification: {
        evidence_kind: "test",
        outcome: "supports",
        subject_revision: "rev-1",
        steps: ["run"],
        expected: "blocked",
        actual: "allowed",
      },
    },
    ...overrides,
  };
}

test("freezeVerifyFindingSubject keeps subject/location/refs and drops maker conclusions", () => {
  const frozen = freezeVerifyFindingSubject({
    id: "00000000-0000-4000-8000-000000000001",
    fingerprint: "fp-maker",
    title: "SQL 注入可接管会话",
    summary: "登录接口拼接查询，攻击者可读取任意用户。",
    severity: "critical",
    location: "src/auth/login.ts:42",
    evidence_refs_json: ["shared://poc.http", { uri: "file://trace.bin", sha256: "abc" }],
  });
  assert.deepEqual(frozen, {
    id: "00000000-0000-4000-8000-000000000001",
    location: "src/auth/login.ts:42",
    artifact_refs: [{ uri: "shared://poc.http" }, { uri: "file://trace.bin", sha256: "abc" }],
  });
  assert.equal("title" in frozen, false);
  assert.equal("summary" in frozen, false);
  assert.equal("severity" in frozen, false);
  assert.equal("fingerprint" in frozen, false);
});

test("verify GraphScope projection hides maker conclusion body", () => {
  const projected = projectVerifyFinding({
    id: "finding-1",
    node_id: "node-1",
    location: "app.c:9",
    verify_status: "verifying",
    artifact_refs: [{ uri: "shared://bytes.bin" }],
    verification: {
      eligibility: "eligible",
      verification_attempt: 2,
      latest_outcome: null,
      missing_evidence: [],
      review_evidence_ids: ["r1"],
      test_evidence_ids: ["t1"],
      conflicting_evidence_ids: [],
      summary: "maker-echo round summary",
      proposed_verdict: "confirmed",
    },
  });
  const yaml = JSON.stringify(projected);
  assert.equal(projected.id, "finding-1");
  assert.equal(projected.location, "app.c:9");
  assert.deepEqual(projected.artifact_refs, [{ uri: "shared://bytes.bin" }]);
  assert.doesNotMatch(yaml, /title/);
  assert.doesNotMatch(yaml, /severity/);
  assert.doesNotMatch(yaml, /maker-echo/);
  assert.doesNotMatch(yaml, /confirmed/);
  const verification = projected.verification as Record<string, unknown>;
  assert.deepEqual(verification.review_evidence_ids, ["r1"]);
  assert.equal("summary" in verification, false);
});

test("confirm gate requires machine-checkable expected+actual and two supporting paths", () => {
  const qualified = buildEvidenceSnapshot([reviewRow(), testRow()], "origin-job");
  assert.equal(qualified.qualified, true);
  assert.equal(hasMachineCheckableEvidence(qualified), true);
  assert.equal(evaluateConfirmGate(qualified).ok, true);

  const artifactOnly = buildEvidenceSnapshot(
    [
      reviewRow(),
      testRow({
        body_json: {
          verification: {
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "rev-1",
            steps: ["run"],
            expected: "blocked",
            artifact_refs: [{ uri: "shared://out.bin" }],
          },
        },
      }),
    ],
    null,
  );
  assert.equal(artifactOnly.qualified, true);
  assert.equal(hasMachineCheckableEvidence(artifactOnly), false);
  const blocked = evaluateConfirmGate(artifactOnly);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.missing.includes("machine_checkable_expected_actual"));

  const forked = buildEvidenceSnapshot(
    [
      reviewRow({
        body_json: { verification: { evidence_kind: "review", outcome: "refutes" } },
      }),
      testRow(),
    ],
    null,
  );
  const forkGate = evaluateConfirmGate(forked);
  assert.equal(forkGate.ok, false);
  assert.ok(forkGate.missing.includes("path_fork"));
  assert.ok(forkGate.missing.includes("unresolved_conflict"));
});

test("verify prompt is derive-first and does not echo maker conclusions", () => {
  const prompt = buildVerifyJobPrompt({
    attempt: 1,
    subject: {
      id: "00000000-0000-4000-8000-000000000002",
      location: "cmd.c:8",
      artifact_refs: [{ uri: "shared://raw.bin" }],
    },
    evidenceJson: JSON.stringify({ qualified: true, review: [], test: [] }),
    taskGoal: "审计目标二进制",
    graphYaml: "scope: verify\nfinding:\n  id: x",
  });
  assert.match(prompt, /独立推导/);
  assert.match(prompt, /DIFF/);
  assert.match(prompt, /exact match/);
  assert.match(prompt, /machine_checkable|expected 与 actual|非空 expected/);
  assert.match(prompt, /路径分叉/);
  assert.match(prompt, /cmd.c:8/);
  assert.doesNotMatch(prompt, /标题：/);
  assert.doesNotMatch(prompt, /严重度：/);
  assert.doesNotMatch(prompt, /描述：/);
});
