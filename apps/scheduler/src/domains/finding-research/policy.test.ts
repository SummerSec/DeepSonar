import assert from "node:assert/strict";
import test from "node:test";
import {
  FINDING_RESEARCH_PROMPT_REVISION,
  FindingResearchJudgeError,
  clusterCandidates,
  heuristicCompare,
  rankCanonicalSet,
  runResearchPipeline,
  semanticSimilarity,
  type ResearchCandidate,
} from "./policy.js";

function finding(overrides: Partial<ResearchCandidate> = {}): ResearchCandidate {
  return {
    id: overrides.id ?? "f1",
    title: overrides.title ?? "SQL injection in login handler",
    location: overrides.location ?? "src/auth/login.ts:42",
    summary: overrides.summary ?? "unsanitized user input reaches a query",
    category: overrides.category ?? "injection",
    profile: overrides.profile ?? "security.vulnerability",
    severity: overrides.severity ?? "high",
    evidenceRefs: overrides.evidenceRefs ?? ["fact-1"],
    createdAt: overrides.createdAt ?? "2026-09-11T00:00:00.000Z",
  };
}

test("same root cause with different wording merges onto the current anchor", () => {
  const anchor = finding();
  const duplicate = finding({
    id: "f2",
    title: "SQLi in the login form",
    summary: "login query concatenates attacker-controlled input",
    createdAt: "2026-09-11T00:01:00.000Z",
  });
  const decision = heuristicCompare(duplicate, [anchor]);
  assert.equal(decision.matchAnchorId, anchor.id);
  const clustered = clusterCandidates([duplicate], [anchor]);
  assert.equal(clustered.assignments[0]?.canonicalFindingId, anchor.id);
  assert.equal(clustered.assignments[0]?.isCanonical, false);
  assert.equal(clustered.newAnchors.length, 0);
  assert.match(clustered.assignments[0]?.dedupeReason ?? "", /keep source finding/);
});

test("distinct findings grow the canonical anchor set", () => {
  const sqlInjection = finding();
  const xss = finding({
    id: "f2",
    title: "Reflected XSS in search results",
    location: "src/search/view.ts:10",
    summary: "search term is rendered without encoding",
    category: "xss",
    severity: "medium",
  });
  assert.ok(semanticSimilarity(sqlInjection, xss) < 0.3);
  const clustered = clusterCandidates([xss], [sqlInjection]);
  assert.equal(clustered.newAnchors[0]?.id, "f2");
  assert.equal(clustered.assignments[0]?.isCanonical, true);
  assert.equal(clustered.assignments[0]?.canonicalFindingId, "f2");
});

test("incremental batch only compares the new candidates against current anchors", () => {
  const seen: string[] = [];
  const anchors = [finding({ id: "anchor-1" }), finding({ id: "anchor-2", title: "XSS", location: "a.ts:1", category: "xss" })];
  const clustered = clusterCandidates(
    [
      finding({ id: "new-1", title: "SQLi in the login form" }),
      finding({ id: "new-2", title: "another sqli", location: "src/auth/login.ts:42" }),
      finding({ id: "new-3", title: "later leftover", location: "other.ts:1" }),
    ],
    anchors,
    {
      batchLimit: 2,
      judge: {
        compare(candidate, currentAnchors) {
          seen.push(`${candidate.id}:${currentAnchors.map((item) => item.id).join(",")}`);
          return { matchAnchorId: "anchor-1", reason: "test merge" };
        },
      },
    },
  );
  assert.deepEqual(clustered.processedIds, ["new-1", "new-2"]);
  assert.deepEqual(clustered.remainingIds, ["new-3"]);
  assert.deepEqual(seen, ["new-1:anchor-1,anchor-2", "new-2:anchor-1,anchor-2"]);
  assert.ok(!seen.some((entry) => entry.includes("new-3")));
});

test("priority ranking is relative and does not encode verify or severity mutation", () => {
  const ranked = rankCanonicalSet([
    finding({ id: "low", title: "info leak", severity: "low", evidenceRefs: [] }),
    finding({ id: "crit", title: "RCE", severity: "critical", evidenceRefs: ["a", "b"] }),
  ]);
  assert.equal(ranked[0]?.findingId, "crit");
  assert.ok((ranked[0]?.score ?? 0) >= (ranked[1]?.score ?? 0));
  for (const row of ranked) {
    assert.match(row.reason, /不改 verify_status\/severity\/报告门禁/);
    assert.equal("verify_status" in row, false);
    assert.equal("severity" in row, false);
  }
});

test("pipeline failure from the judge keeps candidates unassigned", () => {
  assert.throws(
    () =>
      runResearchPipeline(
        [finding({ id: "keep-me" })],
        [],
        {
          judge: {
            compare() {
              throw new FindingResearchJudgeError("model timeout");
            },
          },
        },
      ),
    /model timeout/,
  );
  const isolated = runResearchPipeline(
    [finding({ id: "pending-high", severity: "critical" })],
    [],
  );
  assert.equal(isolated.assignments[0]?.isCanonical, true);
  assert.equal(isolated.promptRevision, FINDING_RESEARCH_PROMPT_REVISION);
  assert.equal("verify_status" in isolated, false);
  assert.equal("severity" in isolated.assignments[0]!, false);
});
