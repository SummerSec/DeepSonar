import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFindingFeatures, extractFindingFeatures, IDENTITY_FIELDS, lexicalSimilarity,
  normalizeLexicalText, rankLexicalCandidates, sourceInputDigest,
  type FindingFeatureSource, type FindingFeatures,
} from "./model.js";

/** Synthetic behavior fixtures only; not human labels or an association-quality dataset. */
function source(id: string, title = "alpha beta"): FindingFeatureSource {
  return {
    id, project_id: "project-a", job_id: `job-${id}`, canvas_id: `canvas-${id}`,
    artifact_id: `artifact-${id}`, artifact_revision: 1, title,
    location: null, summary: null, profile: "security.vulnerability", category: "CWE-89",
    source_digest: `v1:${"a".repeat(64)}`, updated_at: "2026-10-29T00:00:00.000Z",
    evidence_refs_json: ["evidence:synthetic"], artifact_evidence: [{ id: "evidence-id", status: "submitted" }],
  };
}
function features(id: string, title?: string): FindingFeatures {
  return extractFindingFeatures(source(id, title));
}
// Only tests construct trusted values. Production extraction intentionally has no authority adapter.
function withIdentity(value: FindingFeatures, field: typeof IDENTITY_FIELDS[number], identity: string): FindingFeatures {
  return {
    ...value, identity: { ...value.identity, [field]: { value: identity,
      source: { kind: "frozen_target", ref: "synthetic:authority", revision: "fixture-v1" } } },
  };
}

test("feature extraction records declarations without inventing target or evidence authority", () => {
  const input = source("a", "tenant prod service 127.0.0.1 commit deadbeef CWE-89");
  input.location = "/search?q=1:42";
  input.summary = "The SQL query flows from q to a concatenation; model asserts same root cause.";
  const extracted = extractFindingFeatures(input);
  assert.ok(IDENTITY_FIELDS.every((field) => extracted.identity[field] === null));
  assert.equal(extracted.declared.location, input.location);
  assert.equal(extracted.declared.category, "CWE-89");
  assert.equal(extracted.artifact_revision, 1);
  assert.ok(extracted.provenance.every((item) => item.kind !== "authoritative"));
  assert.ok(!JSON.stringify(extracted).includes("evidence:synthetic"), "evidence content/ref does not leak via features");
});

test("source digests ignore object property order but change on source/evidence versions", () => {
  const input = source("a");
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as FindingFeatureSource;
  assert.equal(sourceInputDigest(input), sourceInputDigest(reordered));
  assert.notEqual(sourceInputDigest(input), sourceInputDigest({ ...input, artifact_revision: 2 }));
  assert.notEqual(sourceInputDigest(input), sourceInputDigest({ ...input, updated_at: "2026-10-29T00:00:01.000Z" }));
  assert.notEqual(sourceInputDigest(input), sourceInputDigest({ ...input, artifact_evidence: [] }));
  assert.notEqual(sourceInputDigest(input), sourceInputDigest({ ...input, title: "new source" }));
  assert.equal(extractFindingFeatures(input).source_digest, sourceInputDigest(input));
});

test("Unicode and literal location differences survive normalization", () => {
  const a = features("a", "搜索参数导致数据库查询注入");
  const b = features("b", "搜索参数导致数据库查询注入");
  assert.equal(normalizeLexicalText(" ＡＢＣ　搜索 "), "abc 搜索");
  assert.ok(a.lexical.tokens.some((token) => token.includes("搜索")));
  assert.equal(lexicalSimilarity(a, b), 1);
  const one = extractFindingFeatures({ ...source("one"), location: "/search?q=1:42" });
  const two = extractFindingFeatures({ ...source("two"), location: "/search?q=2:43" });
  assert.notEqual(one.lexical.location, two.lexical.location, "no invented route template or discarded parameter/line");
});

test("unknown equality and same CWE are insufficient for identity", () => {
  const a = features("a", "alpha");
  const b = features("b", "omega");
  const decision = compareFindingFeatures(a, b);
  assert.equal(decision.kind, "insufficient_information");
  assert.deepEqual(decision.matched_fields, ["declared.category"]);
  assert.deepEqual(decision.missing_fields, [...IDENTITY_FIELDS]);
  const identical = compareFindingFeatures(a, features("c", "alpha"));
  assert.equal(identical.kind, "similar", "identical title never becomes identity evidence");
  assert.equal(identical.reason, "lexical_overlap_only");
});

test("synthetic authority conflicts forbid same-issue and cross-version continuity is unknown", () => {
  for (const field of ["tenant", "service", "asset", "environment", "parameter", "permission_boundary", "root_cause"] as const) {
    const result = compareFindingFeatures(withIdentity(features("a"), field, "a"), withIdentity(features("b"), field, "b"));
    assert.equal(result.kind, "distinct", field);
    assert.deepEqual(result.conflicts, [field]);
  }
  const versions = compareFindingFeatures(withIdentity(features("a"), "version", "commit-a"), withIdentity(features("b"), "version", "commit-b"));
  assert.equal(versions.kind, "insufficient_information");
  assert.equal(versions.reason, "version_continuity_unknown");
  assert.deepEqual(versions.conflicts, ["version"]);
});

test("v1 strong relation gate remains closed even for synthetic matching authority", () => {
  let a = features("a");
  let b = features("b");
  for (const field of IDENTITY_FIELDS) {
    a = withIdentity(a, field, "matching-fixture");
    b = withIdentity(b, field, "matching-fixture");
  }
  const decision = compareFindingFeatures(a, b);
  assert.equal(decision.kind, "similar");
  assert.equal(decision.reason, "lexical_overlap_only");
  assert.deepEqual(decision.missing_fields, []);
  assert.deepEqual(decision.source_digests, [a.source_digest, b.source_digest]);
});

test("pair comparisons never infer transitive similarity", () => {
  const a = features("a", "alpha beta");
  const b = features("b", "alpha beta gamma delta");
  const c = features("c", "gamma delta");
  assert.equal(compareFindingFeatures(a, b).kind, "similar");
  assert.equal(compareFindingFeatures(b, c).kind, "similar");
  assert.equal(compareFindingFeatures(a, c).kind, "insufficient_information");
});

test("candidate scoring is bounded, deterministic, explicit about truncation and project scoped", () => {
  const subject = features("subject");
  const a = features("a");
  const b = features("b");
  const other = { ...features("other"), project_id: "another-project" };
  const ranked = rankLexicalCandidates(subject, [b, a, subject, other], { limit: 1, scanBudget: 4 });
  assert.deepEqual(ranked.candidates, [{ finding_id: "a", score: 1 }]);
  assert.equal(ranked.truncated, true);
  assert.equal(ranked.examined, 4);
  const limited = rankLexicalCandidates(subject, [a, b], { limit: 50, scanBudget: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.examined, 1);
  assert.throws(() => rankLexicalCandidates(subject, [a], { limit: 51, scanBudget: 1000 }), /invalid candidate budget/);
  assert.throws(() => rankLexicalCandidates(subject, [a], { limit: 1, scanBudget: 1001 }), /invalid candidate budget/);
  const denied = compareFindingFeatures(subject, other);
  assert.equal(denied.kind, "insufficient_information");
  assert.equal(denied.reason, "project_scope_mismatch");
});

test("lexical input and token truncation are surfaced and source remains fully hashed", () => {
  const input = source("a", "alpha ".repeat(4000));
  const extracted = extractFindingFeatures(input);
  assert.equal(extracted.lexical.truncated, true);
  assert.ok(extracted.lexical.title.length <= 16000);
  assert.ok(extracted.lexical.tokens.length <= 2000);
  assert.notEqual(extracted.source_digest, sourceInputDigest({ ...input, title: input.title + "tail-change" }));
});


test("mixed and equally obsolete feature versions cannot produce a relationship conclusion", () => {
  const current = features("current");
  const oldExtractor = { ...features("old-extractor"), extractor_version: "project-finding-features/obsolete" };
  const oldNormalization = { ...features("old-normalization"), normalization_version: "ascii/obsolete" };
  const conflicting = withIdentity(current, "tenant", "tenant-current");
  const oldConflicting = withIdentity(oldExtractor, "tenant", "tenant-old");
  for (const [left, right] of [
    [current, oldExtractor], [oldExtractor, current], [current, oldNormalization], [oldNormalization, current],
    [oldExtractor, oldExtractor], [oldNormalization, oldNormalization], [conflicting, oldConflicting],
  ]) {
    const decision = compareFindingFeatures(left, right);
    assert.equal(decision.kind, "insufficient_information");
    assert.equal(decision.reason, "feature_version_mismatch");
    assert.deepEqual(decision.matched_fields, []);
    assert.deepEqual(decision.conflicts, [], "obsolete authority is not reliable conflict evidence");
  }
});

test("candidate ranking excludes obsolete features and rejects an obsolete subject without scoring", () => {
  const subject = features("subject");
  const oldExtractor = { ...features("old-extractor"), extractor_version: "project-finding-features/obsolete" };
  const oldNormalization = { ...features("old-normalization"), normalization_version: "ascii/obsolete" };
  const compatible = features("compatible");
  const ranked = rankLexicalCandidates(subject, [oldExtractor, compatible, oldNormalization], { limit: 10, scanBudget: 10 });
  assert.deepEqual(ranked.candidates, [{ finding_id: "compatible", score: 1 }]);
  assert.equal(ranked.examined, 3);
  assert.equal(ranked.excluded_version_count, 2);
  assert.equal(ranked.subject_version_compatible, true);
  assert.equal(ranked.truncated, false);
  for (const obsolete of [oldExtractor, oldNormalization]) {
    const rejected = rankLexicalCandidates(obsolete, [compatible, oldExtractor, oldNormalization], { limit: 10, scanBudget: 10 });
    assert.deepEqual(rejected.candidates, []);
    assert.equal(rejected.examined, 0);
    assert.equal(rejected.subject_version_compatible, false);
  }
});
