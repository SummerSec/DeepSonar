import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Plan } from "@deepsonar/shared-types";
import { contentSha256, criterionState, planCriteria, StoredPlanCriterionBinding } from "./domains/plan-protocol/criterion-model.js";
import { FactVerificationPatch } from "./domains/canvas/fact-contract.js";

const plan = Plan.parse({ v: 1, goal: "Scoped sample", tasks: [{ id: "sample", title: "Collect evidence", role: "test", description: "Scoped execution", prompt: "Execute within the authorized scope and retain evidence.", expected_outputs: ["Execution record"] }], completion: { mode: "explicit_result", description: "Executed scoped evidence", required_outputs: ["Retained sample"] } });
const binding = StoredPlanCriterionBinding.parse({ v: 1, authority: "operator_attestation", binding_id: randomUUID(), fact_id: randomUUID(),
  plan_job_id: randomUUID(), plan_sha256: contentSha256(plan), criterion_id: "completion", criterion_sha256: contentSha256(planCriteria(plan)[0]),
  expected_source_sha256: "a".repeat(64), assessment: "satisfies", observation: "negative", verification_epoch: "epoch-1", rationale: "Operator reviewed scoped execution",
  source: { job_id: randomUUID(), attempt_id: randomUUID(), event_id: "fact-event", artifact_id: randomUUID(), artifact_revision: 1, evidence_ids: [randomUUID()] } });

test("canonical Plan identity and explicit operator request", () => {
  assert.equal(contentSha256({ b: 2, a: { d: 4, c: 3 } }), contentSha256({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(contentSha256(plan), contentSha256({ ...plan, goal: "changed" }));
  assert.deepEqual(planCriteria(plan).map(x => x.id), ["completion", "output-0"]);
  const { v, authority, binding_id, fact_id, criterion_sha256, verification_epoch, rationale, source, ...request } = binding;
  const body = { status: "verified", note: "Reviewed scoped execution", plan_binding: { ...request, expected_binding_id: null } };
  assert.equal(FactVerificationPatch.safeParse(body).success, true);
  assert.equal(FactVerificationPatch.safeParse({ ...body, note: undefined }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ ...body, status: "rejected" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ ...body, plan_binding: { ...body.plan_binding, authority: "model" } }).success, false);
});

test("aggregation never hides incomplete or conflicting evidence", () => {
  assert.equal(criterionState([], false), "unbound");
  assert.equal(criterionState(["satisfied", "contradicted"], false), "conflict");
  for (const state of ["blocked", "stale", "insufficient"] as const) assert.equal(criterionState(["satisfied", state], false), state);
  assert.equal(criterionState(["satisfied"], true), "insufficient");
});

test("current evidence, revocation and explicit positive/negative have independent meanings", async () => {
  const { evaluateCriterionBinding } = await import("./domains/plan-protocol/criterion-projection.js");
  const source = { fact_id: binding.fact_id, source_sha256: binding.expected_source_sha256, verification_epoch: "epoch-1", verification_status: "verified", eligible: true, reasons: [], source: binding.source };
  const evaluate = (s = source, b = binding) => evaluateCriterionBinding(b, contentSha256(plan), contentSha256(planCriteria(plan)[0]), s).state;
  assert.equal(evaluate(), "satisfied");
  assert.equal(evaluate(source, { ...binding, observation: "positive" }), "satisfied");
  assert.equal(evaluate(source, { ...binding, assessment: "contradicts" }), "contradicted");
  assert.equal(evaluate(source, { ...binding, assessment: "inconclusive" }), "insufficient");
  assert.equal(evaluate({ ...source, eligible: false }), "blocked");
  assert.equal(evaluate({ ...source, source_sha256: "b".repeat(64) }), "stale");
  assert.equal(evaluate({ ...source, verification_epoch: "epoch-2" }), "stale");
  assert.equal(evaluate({ ...source, verification_status: "rejected" }), "insufficient");
  assert.equal(evaluate(source, { ...binding, plan_sha256: "b".repeat(64) }), "stale");
});

test("retained bytes are bounded, scoped to the Attempt, finalized and content checked", async () => {
  const { inspectCriterionEvidence } = await import("./domains/plan-protocol/criterion-evidence.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "criterion-evidence-"));
  const job = randomUUID(), attempt = randomUUID();
  const relative = `attempts/${attempt}/sample.txt`;
  const dir = path.join(root, "jobs", job);
  const bytes = Buffer.from("observed scoped execution");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const evidence = [{ id: randomUUID(), uri: relative, sha256 }];
  const manifest = { job_id: job, finalized_at: new Date().toISOString(), files: [{ path: relative, bytes: bytes.length, sha256 }] };
  const check = (items = evidence, budget = 8192) => inspectCriterionEvidence(job, attempt, items, { bytes: budget }, root);
  try {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), bytes);
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual((await check()).reasons, []);
    assert.ok((await check(evidence, 1)).reasons.length);
    assert.ok((await check([{ ...evidence[0]!, uri: `attempts/${randomUUID()}/sample.txt` }])).reasons.includes("evidence_scope_mismatch"));
    for (const uri of ["https://example.invalid/proof", `attempts/${attempt}/../sample.txt`]) assert.ok((await check([{ ...evidence[0]!, uri }])).reasons.length);
    await writeFile(path.join(dir, relative), "tampered");
    assert.ok((await check()).reasons.includes("evidence_content_mismatch"));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, inflight: true }));
    assert.ok((await check()).reasons.length);
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    await rm(path.join(dir, relative));
    await writeFile(path.join(root, "outside.txt"), bytes);
    await symlink(path.join(root, "outside.txt"), path.join(dir, relative));
    assert.ok((await check()).reasons.length);
    assert.ok((await check([])).reasons.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
