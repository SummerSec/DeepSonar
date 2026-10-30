import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectFactRetainedEvidence } from "./fact-evidence-retained.js";
import { criterionEvidenceBudget } from "./domains/plan-protocol/criterion-evidence.js";

test("retained Fact references hash actual bytes with exact Job and Attempt paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fact-retained-"));
  const job = randomUUID(), attempt = randomUUID(), jobRoot = path.join(root, "jobs", job);
  const bytes = Buffer.from("retained execution proof");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const relative = `attempts/${attempt}/proof.txt`;
  const ref = { uri: `jobs/${job}/${relative}`, sha256: `sha256:${sha.toUpperCase()}` };
  const check = (refs: unknown = [ref]) => inspectFactRetainedEvidence(job, attempt, refs, criterionEvidenceBudget(), root);
  try {
    await mkdir(path.dirname(path.join(jobRoot, relative)), { recursive: true });
    await writeFile(path.join(jobRoot, relative), bytes);
    await writeFile(path.join(jobRoot, "manifest.json"), JSON.stringify({ job_id: job, finalized_at: "fixture", files: [{ path: relative, sha256: sha, bytes: bytes.length }] }));
    assert.deepEqual(await check(), { observed: { [ref.uri]: sha }, readable: true, reason: null });
    for (const uri of ["proof.txt", `attempts/${randomUUID()}/proof.txt`, `jobs/${randomUUID()}/${relative}`, "https://example.invalid/proof.txt", `attempts/${attempt}/../proof.txt`]) {
      assert.equal((await check([{ ...ref, uri }])).reason, "evidence_scope_mismatch");
    }
    assert.equal((await check([{ ...ref, uri: `attempts/${attempt}/sub/proof.txt` }])).reason, "evidence_manifest_mismatch");
    await writeFile(path.join(jobRoot, relative), "tampered proof");
    const changed = await check();
    assert.equal(changed.readable, false); assert.equal(changed.reason, "evidence_content_mismatch"); assert.deepEqual(changed.observed, {});
    await rm(path.join(jobRoot, relative));
    assert.equal((await check()).reason, "evidence_unavailable_or_budget_exceeded");
    // Even matching content and manifest cannot authorize a symlink target.
    const outside = path.join(root, "outside.txt");
    const inside = path.join(jobRoot, "inside.txt");
    await writeFile(outside, bytes);
    await writeFile(inside, bytes);
    for (const target of [outside, inside]) {
      await symlink(target, path.join(jobRoot, relative));
      const linked = await check();
      assert.equal(linked.readable, false);
      assert.equal(linked.reason, "evidence_unavailable_or_budget_exceeded");
      assert.deepEqual(linked.observed, {});
      await rm(path.join(jobRoot, relative));
    }
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
    const largeSha = createHash("sha256").update(oversized).digest("hex");
    await writeFile(path.join(jobRoot, relative), oversized);
    await writeFile(path.join(jobRoot, "manifest.json"), JSON.stringify({ job_id: job, finalized_at: "fixture", files: [{ path: relative, sha256: largeSha, bytes: oversized.length }] }));
    assert.equal((await check([{ uri: ref.uri, sha256: largeSha }])).reason, "evidence_unavailable_or_budget_exceeded");

  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference validation is bounded and aliases cannot duplicate a retained path", async () => {
  const check = (refs: unknown) => inspectFactRetainedEvidence("job", "attempt", refs, criterionEvidenceBudget(), "/not-used");
  assert.equal((await check([])).reason, "evidence_refs_missing");
  assert.equal((await check(Array(21).fill({}))).reason, "evidence_refs_over_limit");
  assert.equal((await check([{ uri: "attempts/attempt/p", sha256: "not-a-hash" }])).reason, "evidence_ref_invalid");
  assert.equal((await check(["attempts/attempt/p"])).reason, "evidence_ref_invalid");
  const sha256 = "a".repeat(64);
  assert.equal((await check([{ uri: "attempts/attempt/p", sha256 }, { uri: "jobs/job/attempts/attempt/p", sha256 }])).reason, "evidence_ref_duplicate");
});

test("twenty references use bounded batches and one shared budget; partial reads never claim overall success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fact-retained-many-"));
  const job = randomUUID(), attempt = randomUUID(), jobRoot = path.join(root, "jobs", job);
  const bytes = Buffer.from("batch fixture"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const refs = Array.from({ length: 20 }, (_, index) => ({ uri: `attempts/${attempt}/${index}.txt`, sha256 }));
  try {
    await mkdir(path.join(jobRoot, "attempts", attempt), { recursive: true });
    await Promise.all(refs.map(ref => writeFile(path.join(jobRoot, ref.uri), bytes)));
    const manifest = JSON.stringify({ job_id: job, finalized_at: "fixture", files: refs.map(ref => ({ path: ref.uri, sha256, bytes: bytes.length })) });
    await writeFile(path.join(jobRoot, "manifest.json"), manifest);
    const budget = criterionEvidenceBudget();
    const complete = await inspectFactRetainedEvidence(job, attempt, refs, budget, root);
    assert.equal(complete.readable, true); assert.equal(Object.keys(complete.observed).length, 20);
    assert.ok(budget.bytes < 8 * 1024 * 1024);
    const limited = { bytes: Buffer.byteLength(manifest) + 1 + 8 * (bytes.length + 1) };
    const partial = await inspectFactRetainedEvidence(job, attempt, refs, limited, root);
    assert.equal(partial.readable, false); assert.equal(partial.reason, "evidence_unavailable_or_budget_exceeded");
    assert.equal(Object.keys(partial.observed).length, 8); assert.equal(limited.bytes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
