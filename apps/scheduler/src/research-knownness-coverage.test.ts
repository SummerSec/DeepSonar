import assert from "node:assert/strict";
import test from "node:test";
import {
  appendHeadApplicability,
  buildCoverageReport,
  evaluateKnownness,
  evaluateScoringEvidence,
  frozenKnownnessCoverageMeta,
  type KnownnessRecord,
} from "./research-knownness-coverage.js";

function record(over: Partial<KnownnessRecord> = {}): KnownnessRecord {
  return {
    finding_id: "f1",
    pinned_revision: "v1.0.0",
    knownness: "known_issue",
    public_refs: ["CVE-2024-0001"],
    queried_at: "2026-09-17T00:00:00Z",
    query_failed: false,
    network_limited: false,
    applicability: "affected",
    applicability_rationale: "fix not present on v1.0.0",
    still_affected_on_pin: true,
    ...over,
  };
}

test("known issue still affected on pin blocks hardening downgrade", () => {
  const d = evaluateKnownness(record());
  assert.equal(d.ok, true);
  assert.equal(d.downgrade_blocked, true);
  assert.ok(d.reasons.some((r) => /hardening|公开问题/.test(r)));
});

test("known issue marked affected without still_affected_on_pin fails closed", () => {
  const d = evaluateKnownness(record({ still_affected_on_pin: false }));
  assert.equal(d.ok, false);
});

test("query failure forces unknown semantics note", () => {
  const d = evaluateKnownness(
    record({
      knownness: "novel",
      query_failed: true,
      applicability: "unknown",
      applicability_rationale: "network error",
      still_affected_on_pin: false,
      public_refs: [],
    }),
  );
  assert.ok(d.reasons.some((r) => /unknown|检索失败/.test(r)));
});

test("HEAD re-check appends without erasing pinned history", () => {
  const pinned = record({ pinned_revision: "v1.0.0", applicability: "affected" });
  const head = record({
    pinned_revision: "HEAD",
    applicability: "not_affected",
    applicability_rationale: "fixed on HEAD",
    still_affected_on_pin: false,
    knownness: "fixed_in_other_revision",
  });
  const history = appendHeadApplicability([pinned], head);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.pinned_revision, "v1.0.0");
  assert.equal(history[0]!.applicability, "affected");
  assert.equal(history[1]!.pinned_revision, "HEAD");
  assert.equal(history[1]!.applicability, "not_affected");
});

test("scoring: vector alone does not prove impact", () => {
  const r = evaluateScoringEvidence({
    profile: "security.vulnerability",
    scoring_required: true,
    vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    server_score: 9.8,
    metric_evidence_complete: true,
    impact_proven: false,
    block_reason: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.required_missing.includes("impact_not_proven"));
  assert.ok(r.reasons.some((x) => /影响已证实/.test(x)));
});

test("coverage refuses ratio without explainable denominator", () => {
  const opaque = buildCoverageReport({
    task_scope: "repo root",
    entries: [
      { component: "a", bucket: "analyzed", depth: 1, reason: "ok" },
      { component: "b", bucket: "skipped", depth: null, reason: "budget" },
    ],
    finding_count: 99,
  });
  assert.equal(opaque.denominator_explainable, false);
  assert.equal(opaque.coverage_ratio, null);
  assert.ok(/拒报|分母/.test(opaque.denominator_description));

  const explained = buildCoverageReport({
    task_scope: "apps/api/**",
    entries: [
      { component: "apps/api/auth.ts", bucket: "analyzed", depth: 2, reason: "done" },
      { component: "apps/api/admin.ts", bucket: "skipped", depth: null, reason: "allowlist" },
    ],
    finding_count: 3,
    denominator_description: "apps/api 下 2 个入口文件（任务冻结范围）",
    sampling_declared: true,
    sampling_note: "仅抽样 apps/api，不含 apps/web",
  });
  assert.equal(explained.coverage_ratio, 0.5);
  assert.equal(explained.sampling_declared, true);
  assert.match(explained.note, /Finding 数量不能替代/);
});

test("frozen meta lists non-downgrade rules", () => {
  const meta = frozenKnownnessCoverageMeta();
  assert.equal(meta.strategy_id, "research.knownness_coverage");
  assert.ok((meta.rules as string[]).some((r) => /hardening/.test(r)));
});
