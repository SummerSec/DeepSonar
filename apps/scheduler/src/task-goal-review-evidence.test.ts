import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { sql } from "./db.js";
import { loadGoalReviewEvidence } from "./task-goal-review-evidence.js";

const job = "00000000-0000-4000-8000-000000000001";
const attempt = "00000000-0000-4000-8000-000000000002";
const factId = "00000000-0000-4000-8000-000000000003";
const artifact = "00000000-0000-4000-8000-000000000004";
const evidenceId = "00000000-0000-4000-8000-000000000005";
const hash = createHash("sha256").update("retained proof").digest("hex");
const fact = { id: factId, artifact_id: artifact, revision: 1, body_json: { artifact_id: artifact }, event_payload: { description: "review observation" } };
const evidence = { id: evidenceId, uri: `attempts/${attempt}/proof.txt`, sha256: hash, statement: "proof" };
function database(facts = [fact], items = [evidence]) {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?"); queries.push(query);
    return query.includes("FROM canvas_nodes") ? facts : items;
  }) as unknown as typeof sql;
  return { db, queries };
}
test("active submission binds own current Fact/Artifact/event and retained-file metadata without finalized reads", async () => {
  const { db, queries } = database();
  const result = await loadGoalReviewEvidence(db, "p", "c", job, attempt, [factId], false);
  assert.deepEqual(result.blockedReasons, []);
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0].fact_id, factId);
  assert.match(queries[0], /n.job_id=/);
  assert.match(queries[0], /e.attempt_id=/);
  assert.match(queries[0], /a.superseded_at IS NULL/);
  assert.match(queries[0], /n.verification_status <> 'rejected'/);
  assert.doesNotMatch(queries[0], /verification_status='verified'/);
});
test("unavailable/foreign observations and attempt-external file paths cannot bind", async () => {
  assert.ok((await loadGoalReviewEvidence(database([]).db, "p", "c", job, attempt, [factId], false)).blockedReasons.length);
  for (const uri of ["https://127.0.0.1/proof", "../proof", "attempts/other/proof", `attempts/${attempt}/../proof`]) {
    const result = await loadGoalReviewEvidence(database([fact], [{ ...evidence, uri }]).db, "p", "c", job, attempt, [factId], false);
    assert.ok(result.blockedReasons.includes("goal_review_evidence_binding_invalid"));
  }
});
test("changed Fact or Evidence content changes its proof binding", async () => {
  const original = await loadGoalReviewEvidence(database().db, "p", "c", job, attempt, [factId], false);
  const changed = await loadGoalReviewEvidence(database([{ ...fact, revision: 2 }]).db, "p", "c", job, attempt, [factId], false);
  assert.notEqual(original.bindings[0].content_sha256, changed.bindings[0].content_sha256);
});
test("byte validation requires finalized valid manifest and digest, never metadata alone", async () => {
  // Use the production inspector through the configured blob root in a fresh test process.
  const root = await mkdtemp(path.join(tmpdir(), "goal-review-proof-"));
  process.env.BLOB_DIR = root;
  const jobRoot = path.join(root, "jobs", job);
  await mkdir(path.join(jobRoot, "attempts", attempt), { recursive: true });
  const file = path.join(jobRoot, evidence.uri);
  await writeFile(file, "retained proof");
  const manifest = { job_id: job, finalized_at: "2026-10-30T00:00:00Z", files: [{ path: evidence.uri, sha256: hash, bytes: 14 }] };
  try {
    await writeFile(path.join(jobRoot, "manifest.json"), JSON.stringify(manifest));
    const valid = await loadGoalReviewEvidence(database().db, "p", "c", job, attempt, [factId], true);
    assert.deepEqual(valid.blockedReasons, []);
    await writeFile(file, "tampered proof");
    assert.ok((await loadGoalReviewEvidence(database().db, "p", "c", job, attempt, [factId], true)).blockedReasons.length);
    await writeFile(path.join(jobRoot, "manifest.json"), JSON.stringify({ ...manifest, inflight: true }));
    assert.ok((await loadGoalReviewEvidence(database().db, "p", "c", job, attempt, [factId], true)).blockedReasons.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
