import assert from "node:assert/strict";
import test from "node:test";
import { DonePayload, FactPayload, FindingPayload, VerificationEvidence } from "@deepsonar/shared-types";
import {
  buildEvidenceSnapshot, closeVerifyRound, createVerifyRound, evaluateFindingFactGate,
  maybeReverifyAfterFollowup, projectVerifyEvidenceForPrompt,
} from "./verify.js";
import { fakeFindingPayload, fakeVerificationFact, fakeVerifyDone } from "./fake-agent-evidence.js";
import { attachVerificationEvidence } from "./verify-attach-evidence.js";
import { findingVerificationSummaries } from "./verify-summaries.js";
import { findingProposalToArtifact } from "./domains/artifacts/model.js";

const FINDING = "00000000-0000-4000-8000-000000000590";
const finding = {
  id: FINDING, job_id: "origin", project_id: "project", severity: "high",
  profile: "security.vulnerability", verify_status: "pending", node_id: "finding-node",
  raw_json: { impact: { impact_flow: "Cross-user request exposes victim data" }, verification_state: { subject_revision: "rev" } },
};
function row(kind: string, verification: Record<string, unknown> = {}, status = "succeeded") {
  return {
    id: `${kind}-fact`, job_id: `${kind}-job`, job_type: kind, job_status: status,
    body_json: { verification: {
      finding_id: FINDING, evidence_kind: kind, outcome: "supports", subject_revision: "rev",
      source_job_id: `${kind}-job`, source_role: kind, steps: ["run negative control"],
      expected: "deny access", actual: "victim data returned", artifact_refs: [{ uri: "shared://proof", sha256: "aaaa" }],
      attempted_refutation: ["Retested with an unrelated user and a denied control"], ...verification,
    } },
  };
}
function transaction(rows: ReturnType<typeof row>[], opts: { explicit?: boolean; attempt?: number; maxRounds?: number | null; priorRounds?: string[]; subject?: typeof finding } = {}) {
  const subject = opts.subject ?? structuredClone(finding);
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const round = { id: "round", finding_id: FINDING, status: opts.explicit ? "running" : "pending", attempt: opts.attempt ?? 1, verify_job_id: opts.explicit ? "verify-job" : null };
  const tx = (parts: TemplateStringsArray | unknown, ...values: unknown[]): any => {
    if (!Array.isArray(parts)) return parts;
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT status FROM finding_verification_rounds")) return Promise.resolve((opts.priorRounds ?? []).slice(0, Number(values[2])).map(status => ({ status })));
    if (query.startsWith("SELECT n.id")) return Promise.resolve(rows);
    if (query.includes("SELECT config_json FROM projects")) return Promise.resolve([{ config_json: { rules: { minVerifySeverity: "high", maxFollowupDepth: 9, ...(opts.maxRounds === null ? {} : { maxVerificationRounds: opts.maxRounds ?? 3 }), maxNoProgressRounds: 3 } } }]);
    if (query.includes("SELECT rules_json")) return Promise.resolve([]);
    if (query.startsWith("SELECT id FROM canvases")) return Promise.resolve([{ id: "canvas" }]);
    if (query.startsWith("SELECT MAX")) return Promise.resolve([{ max_attempt: 0 }]);
    if (query.startsWith("SELECT * FROM finding_verification_rounds")) return Promise.resolve(opts.explicit ? [round] : []);
    if (query.startsWith("SELECT * FROM jobs")) return Promise.resolve([{ id: "verify-job", type: "verify_finding", finding_id: FINDING, project_id: "project", canvas_id: null }]);
    if (query.includes("FROM findings")) return Promise.resolve([subject]);
    if (query.startsWith("SELECT")) return Promise.resolve([]);
    writes.push({ query, values });
    return Promise.resolve([]);
  };
  tx.json = (value: unknown) => value;
  // Report dispatch is a separate derivative; this fake transaction isolates it.
  tx.savepoint = async () => undefined;
  return { tx: tx as unknown as Parameters<typeof createVerifyRound>[0], writes };
}
const confirmedWrite = (writes: ReturnType<typeof transaction>["writes"]) => writes.some(({ query, values }) => query.includes("verify_status = 'confirmed'") || (query.includes("UPDATE findings SET verify_status") && values.includes("confirmed")));

for (const route of ["create", "followup", "explicit"] as const) {
  for (const scenario of ["review_only", "no_refutation", "no_impact", "complete", "failed", "stale_review", "refutes", "conflict"] as const) {
    test(`confirmation ${route}: ${scenario}`, async () => {
      const rows = scenario === "review_only" ? [row("review")] : [
        row("review", scenario === "stale_review" ? { subject_revision: "old" } : scenario === "refutes" || scenario === "conflict" ? { outcome: "refutes" } : {}),
        row("test", scenario === "refutes" ? { outcome: "refutes" } : {}, scenario === "failed" ? "failed" : "succeeded"),
      ];
      if (scenario === "no_refutation") for (const item of rows) item.body_json.verification.attempted_refutation = [];
      const subject = structuredClone(finding);
      if (scenario === "no_impact") subject.raw_json.impact.impact_flow = "";
      const { tx, writes } = transaction(rows, { explicit: route === "explicit", subject });
      if (route === "create") await createVerifyRound(tx, { projectId: "project", canvasId: "canvas", finding: subject, parentJobId: "origin", followupDepth: 0, priorityBase: 1 });
      else if (route === "followup") await maybeReverifyAfterFollowup(tx, { id: "test-job", project_id: "project", canvas_id: "canvas", payload_json: { verification_followup: { finding_id: FINDING } } });
      else {
        const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "succeeded", proposedVerdict: "confirmed" });
        assert.equal(result.outcome, scenario === "complete" ? "confirmed" : "rework");
      }
      assert.equal(confirmedWrite(writes), scenario === "complete");
    });
  }
}

test("prompt snapshot preserves failed facts and the complete decision", () => {
  const evidence = buildEvidenceSnapshot([row("review"), row("test", {}, "failed")], "origin");
  const decision = evaluateFindingFactGate(finding, evidence, "origin");
  const projected = projectVerifyEvidenceForPrompt(evidence);
  assert.equal(decision.gate.ok, false);
  assert.equal(decision.gate.result, "failed");
  assert.equal((projected.facts as Record<string, unknown>[]).find((fact) => fact.node_id === "test-fact")?.job_status, "failed");
  assert.equal((projected.strategy as Record<string, unknown>).ok, false);
  assert.equal((projected.confirmation_context as Record<string, unknown>).profile, finding.profile);
});

test("refutation must come from current successful independent used Facts", () => {
  for (const bad of [row("test", {}, "failed"), row("review", { subject_revision: "old" }), { ...row("test"), job_id: "origin" }]) {
    const rows = [row("review", { attempted_refutation: [] }), row("test", { attempted_refutation: [] }), { ...bad, id: "excluded-fact" }];
    const result = evaluateFindingFactGate(finding, buildEvidenceSnapshot(rows, "origin"), "origin");
    assert.equal(result.strategy.ok, false);
    assert.ok(result.strategy.required_missing.includes("attempted_refutation"));
  }
});

test("integrity-rich authoritative facts cannot be shadowed by a slim projection", () => {
  const evidence = buildEvidenceSnapshot([row("review"), row("test", { observed_content_digests: { "shared://proof": "bbbb" } })], "origin");
  const result = evaluateFindingFactGate(finding, evidence, "origin");
  assert.equal(result.gate.ok, false);
  assert.equal(result.gate.result, "insufficient");
  assert.ok(result.strategy.required_missing.includes("content_digest_mismatch"));
});

test("security summaries preserve required gaps and the composed gate result", async () => {
  const { tx } = transaction([row("review")]);
  const summary = (await findingVerificationSummaries(tx, [FINDING])).get(FINDING)!;
  assert.ok((summary.missing_evidence as string[]).includes("runtime_test"));
  assert.equal(summary.gate_result, "insufficient");
});

test("strict refutation contract accepts bounded structured attempts only", () => {
  const base = { finding_id: FINDING, evidence_kind: "review", outcome: "supports", subject_revision: "rev" };
  assert.equal(VerificationEvidence.safeParse({ ...base, attempted_refutation: ["negative control"] }).success, true);
  for (const attempted_refutation of [[" "], ["x".repeat(2001)], Array(21).fill("x"), "free text", [1]]) {
    assert.equal(VerificationEvidence.safeParse({ ...base, attempted_refutation }).success, false);
  }
});

test("attachment persists submitted attempts together with scheduler-owned provenance", async () => {
  const writes: any[] = [];
  const tx: any = (parts: any, ...values: any[]) => {
    if (!Array.isArray(parts)) return parts;
    const query = parts.join("?");
    if (query.includes("FROM findings")) return Promise.resolve([{ ...finding, raw_json: finding.raw_json }]);
    if (query.includes("FROM jobs")) return Promise.resolve([{ id: "origin", project_id: "project" }]);
    if (query.includes("SELECT canvas_id")) return Promise.resolve([{ canvas_id: "canvas" }]);
    if (query.includes("SELECT id, canvas_id, job_id")) return Promise.resolve([{ id: "fact", canvas_id: "canvas", job_id: "review-job" }]);
    if (query.includes("UPDATE canvas_nodes")) { writes.push(values[0]); return Promise.resolve([{ id: "fact" }]); }
    return Promise.resolve([]);
  };
  tx.json = (value: unknown) => value;
  await attachVerificationEvidence(tx, { id: "review-job", type: "review", project_id: "project" }, "fact", "canvas", {
    finding_id: FINDING, evidence_kind: "review", outcome: "supports", subject_revision: "rev", attempted_refutation: ["negative control"],
  });
  assert.deepEqual(writes[0].verification.attempted_refutation, ["negative control"]);
  assert.equal(writes[0].verification.source_job_id, "review-job");
});

test("Finding Artifact preserves the validated impact contract", () => {
  const artifact = findingProposalToArtifact({ title: "finding", profile: "security.vulnerability", impact: finding.raw_json.impact } as Parameters<typeof findingProposalToArtifact>[0]);
  assert.deepEqual((artifact.extensions!["security.vulnerability"] as any).impact, finding.raw_json.impact);
});

test("incomplete review cannot satisfy the security pair merely by existing", () => {
  const evidence = buildEvidenceSnapshot([row("review", { expected: null }), row("test")], "origin");
  const result = evaluateFindingFactGate(finding, evidence, "origin");
  assert.equal(result.strategy.ok, false);
  assert.ok(result.strategy.required_missing.includes("independent_review"));
});

test("proposal at the round budget settles inconclusive rather than false confirmation", async () => {
  const { tx, writes } = transaction([row("review")], { explicit: true, attempt: 3 });
  const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "succeeded", proposedVerdict: "confirmed" });
  assert.equal(result.outcome, "inconclusive");
  assert.equal(confirmedWrite(writes), false);
});

test("failed Verify execution cannot confirm even with complete evidence", async () => {
  const { tx, writes } = transaction([row("review"), row("test")], { explicit: true });
  const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "failed" });
  assert.notEqual(result.outcome, "confirmed");
  assert.equal(confirmedWrite(writes), false);
});

test("incomplete refutation blocks without falsely settling the Finding", async () => {
  const rows = [row("review", { outcome: "refutes", expected: null, actual: null })];
  const result = evaluateFindingFactGate(finding, buildEvidenceSnapshot(rows, "origin"), "origin");
  assert.equal(result.gate.result, "insufficient");
  assert.ok(result.gate.missing.includes("structured_refuting_fact"));
  const { tx, writes } = transaction(rows);
  await createVerifyRound(tx, { projectId: "project", canvasId: "canvas", finding, parentJobId: "origin", followupDepth: 0, priorityBase: 1 });
  assert.equal(writes.some(({ query, values }) => query.includes("UPDATE findings SET verify_status") && values.includes("refuted")), false);
});

test("stale incomplete refutation does not override current complete evidence", () => {
  const rows = [row("review"), row("test"), { ...row("review", { outcome: "refutes", expected: null, actual: null, subject_revision: "old" }), id: "stale" }];
  const result = evaluateFindingFactGate(finding, buildEvidenceSnapshot(rows, "origin"), "origin");
  assert.equal(result.strategy.ok, true);
  assert.deepEqual(result.gate.used_fact_ids, ["review-fact", "test-fact"]);
});

test("integrity-invalid refutation cannot settle refuted", async () => {
  const rows = [row("review", { outcome: "refutes", observed_content_digests: { "shared://proof": "bbbb" } })];
  const result = evaluateFindingFactGate(finding, buildEvidenceSnapshot(rows, "origin"), "origin");
  assert.equal(result.strategy.gate.result, "rejected");
  assert.equal(result.gate.result, "insufficient");
  assert.ok(result.gate.missing.includes("content_digest_mismatch"));
  const { tx, writes } = transaction(rows);
  await createVerifyRound(tx, { projectId: "project", canvasId: "canvas", finding, parentJobId: "origin", followupDepth: 0, priorityBase: 1 });
  assert.equal(writes.some(({ query, values }) => query.includes("UPDATE findings SET verify_status") && values.includes("refuted")), false);
});


test("fake emitted Finding and Facts satisfy the full security contract; Verify uses the same gate", () => {
  const proposal = FindingPayload.parse(fakeFindingPayload());
  assert.equal(proposal.profile, "security.vulnerability");
  assert.equal(proposal.raw?.source, "fake-agent");
  const subject = { id: FINDING, job_id: "origin", profile: proposal.profile, raw_json: { impact: proposal.impact } };
  const rows = (["review", "test"] as const).map((kind) => ({
    id: `${kind}-fact`, job_id: `${kind}-job`, job_type: kind, job_status: "succeeded",
    body_json: FactPayload.parse(fakeVerificationFact(FINDING, `${kind}-job`, kind, null)),
  }));
  const snapshot = () => buildEvidenceSnapshot(rows, "origin");
  assert.equal(evaluateFindingFactGate(subject, snapshot(), "origin").strategy.ok, true);
  assert.equal(DonePayload.parse(fakeVerifyDone(subject, snapshot())).verdict, "confirmed");

  for (const missing of ["impact_flow", "attempted_refutation", "qualified_test_artifact_refs", "independent_review"]) {
    const incompleteSubject = structuredClone(subject);
    const incompleteRows = structuredClone(rows);
    if (missing === "impact_flow") incompleteSubject.raw_json.impact = undefined;
    if (missing === "attempted_refutation") {
      for (const row of incompleteRows) delete row.body_json.verification!.attempted_refutation;
    }
    if (missing === "qualified_test_artifact_refs") delete incompleteRows[1].body_json.verification!.artifact_refs;
    if (missing === "independent_review") incompleteRows[0].body_json.verification!.expected = undefined;
    const evidence = buildEvidenceSnapshot(incompleteRows, "origin");
    const decision = evaluateFindingFactGate(incompleteSubject, evidence, "origin");
    assert.equal(decision.strategy.gate.ok, true, "the inner Fact-first gate alone is insufficient");
    assert.equal(decision.strategy.ok, false);
    const done = DonePayload.parse(fakeVerifyDone(incompleteSubject, evidence));
    assert.equal(done.verdict, "rework");
    assert.ok(done.missing_evidence?.includes(missing), `${missing}: ${JSON.stringify(done)}`);
  }
  assert.equal(fakeVerifyDone(null, snapshot()).verdict, "rework");
});

for (const maxRounds of [null, 0, 3]) {
  test(`verification round budget ${maxRounds ?? "unset"} at round four`, async () => {
    const { tx, writes } = transaction([row("review")], { explicit: true, attempt: 4, maxRounds });
    const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "succeeded", proposedVerdict: "confirmed" });
    assert.equal(result.outcome, maxRounds === 3 ? "inconclusive" : "rework");
    assert.equal(confirmedWrite(writes), false, "unlimited rounds do not relax the evidence gate");
  });
}

for (const scenario of [
  { name: "initial failure plus five retries can retry once more", prior: Array(5).fill("failed"), stopped: false },
  { name: "initial failure plus six retries stop", prior: Array(6).fill("failed"), stopped: true },
  { name: "successful execution resets consecutive failures even when verdict is rework", prior: ["failed", "rework", ...Array(5).fill("failed")], stopped: false },
]) {
  test(`unlimited verification retains failure guard: ${scenario.name}`, async () => {
    const { tx } = transaction([row("review")], { explicit: true, attempt: 20, maxRounds: 0, priorRounds: scenario.prior });
    const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "failed", error: "transport unavailable" });
    assert.equal(result.outcome, scenario.stopped ? "inconclusive" : "rework");
    assert.equal(result.forceHub, !scenario.stopped);
  });
}
test("unlimited verification still stops cancellation immediately", async () => {
  const { tx } = transaction([row("review")], { explicit: true, attempt: 20, maxRounds: 0 });
  const result = await closeVerifyRound(tx, "verify-job", { jobStatus: "cancelled" });
  assert.equal(result.outcome, "inconclusive");
  assert.equal(result.forceHub, false);
});
