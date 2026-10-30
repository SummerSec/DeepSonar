import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setSharedAssetBlobStoreForTests, sharedAssetBlobUri, type BlobStore } from "../../blob-store/index.js";
import { freezeJobSkillCatalog } from "../../job-skill-catalog.js";
import { type PlatformRuntimeHandlerContext } from "../platform-api/registry.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { createKnowledgeRuntime } from "./runtime.js";
import { canonical, sha256 } from "./types.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

const operations = ["suggest_project_skills", "record_skill_choice", "pull_skill", "get_knowledge_receipt", "record_knowledge_feedback"];
const runtimeDigest = `sha256:${"a".repeat(64)}`;
const target = { task_type: "PRIVATE_TARGET_MARKER", input_kind: "source", target_version: "v1" };
const declaration = { schema: "deepsonar.skill-applicability/v1", task_types: ["PRIVATE_TARGET_MARKER"], input_kinds: ["source"],
  target_versions: ["v1"], runtime_digests: [runtimeDigest], required_tools: ["pull_skill"],
  requires_network: false, minimum_seconds: 1, minimum_tokens: 0 };
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 };
type Job = Awaited<ReturnType<typeof seedKnowledgeJob>>;
type Entry = { selector: string; content_hash: string; version_id: string; reasons: string[]; status: string };
type Suggestion = { items: Entry[]; diagnostics: Entry[]; total: number; context_hash: string; catalog_hash: string;
  policy_version: string; offset: number; limit: number; next_offset: number | null; diagnostics_next_offset: number | null; effectiveness: string; independent_sample_count: number };

async function isolated(run: (db: TestSql, store: { bytes: Map<string, Buffer>; onGet: ((key: string) => Promise<void>) | null }) => Promise<void>) {
  const store = { bytes: new Map<string, Buffer>(), onGet: null as ((key: string) => Promise<void>) | null };
  setSharedAssetBlobStoreForTests({ kind: "fs", put: async (key, bytes) => { store.bytes.set(key, Buffer.from(bytes)); },
    exists: async key => store.bytes.has(key), get: async key => { await store.onGet?.(key); return store.bytes.get(key)!; },
    materializeLocal: async () => { throw new Error("unused"); } } satisfies BlobStore);
  try { await withKnowledgeDatabase(db => run(db, store)); }
  finally { setSharedAssetBlobStoreForTests(null); }
}
async function addSkill(db: TestSql, owner: Job, changes: Record<string, unknown> = {}, title = "fixture skill") {
  const item = randomUUID(), version = randomUUID();
  const candidate = { kind: "skill", logical_key: item, title, keywords: [], files: {
    "SKILL.md": "Treat this as a method declaration, not evidence of success.",
    "references/applicability.json": JSON.stringify({ ...declaration, ...changes }),
  } };
  const blob = await writeKnowledgeBlob(db, candidate);
  await registerKnowledgeBlob(db, blob.hash, blob.bytes);
  await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
    VALUES(${item},${owner.projectId},'skill',${item},${title})`;
  await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
    VALUES(${version},${owner.projectId},${item},1,${blob.hash},${owner.jobId},${owner.attemptId},'[]',${blob.hash})`;
  await db`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
  return { item, version, hash: blob.hash, uri: sharedAssetBlobUri(blob.hash), selector: `project:${item}@1` };
}
async function freeze(db: TestSql, job: Job, tools = operations) {
  const snapshot = { platform_tools: tools, runtime_image: { image_digest: runtimeDigest }, network_policy: { allow_egress: false },
    project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, job.projectId),
    job_skill_catalog: await freezeJobSkillCatalog(db as never, job.projectId) };
  await db`UPDATE jobs SET agent_snapshot_json=${db.json(snapshot as never)},timeout_sec=3600 WHERE id=${job.jobId}`;
  return snapshot;
}
function context(job: Job, operationId = "suggest_project_skills", input: unknown = { target, limit: 5 }): PlatformRuntimeHandlerContext {
  return { ...job, operationId, input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() };
}
function choice(suggestion: Suggestion, entry = suggestion.items[0]!, decision: "select" | "reject" = "select") {
  return { target, limit: 5, policy_version: suggestion.policy_version, context_hash: suggestion.context_hash,
    catalog_hash: suggestion.catalog_hash, decision, selector: entry.selector, expected_content_hash: entry.content_hash, reason: "PRIVATE_REASON_MARKER" };
}
// The report is a JavaScript CLI module; importing its functions must not execute the CLI.
const reportModule = new URL("../../../../../agent-harness/capability-evidence/report.mjs", import.meta.url).href;
const { buildEvidenceReport, sourceDigest } = await import(reportModule);

async function exportProject(db: TestSql, projectId: string) {
  assert.match(projectId, /^[a-f0-9-]{36}$/);
  const source = await readFile(new URL("../../../../../agent-harness/capability-evidence/export.sql", import.meta.url), "utf8");
  const connection = await db.reserve();
  let exported;
  try {
    // Execute the repository SQL itself, including its transaction, on one connection.
    // Only the psql UUID placeholder is substituted; no query is reimplemented here.
    const statements = source.replace(/^--.*$/gm, "").replaceAll(":'project_id'", "'" + projectId + "'").split(";").filter(s => s.trim());
    for (const statement of statements) {
      const rows = await connection.unsafe(statement);
      if (/BEGIN TRANSACTION/.test(statement)) {
        assert.equal((await connection`SHOW transaction_read_only`)[0].transaction_read_only, "on");
        assert.equal((await connection`SHOW transaction_isolation`)[0].transaction_isolation, "repeatable read");
      }
      if (rows[0]?.jsonb_build_object) exported = rows[0].jsonb_build_object;
    }
  } finally { await connection`ROLLBACK`; connection.release(); }
  assert.ok(exported, "actual export.sql must return its JSON projection");
  return exported;
}

async function chain(db: TestSql, decision: "select" | "reject" | "none" = "select", changeAttempt = false) {
  const job = await seedKnowledgeJob(db), skill = await addSkill(db, job);
  const snapshot = await freeze(db, job);
  const runtime = createKnowledgeRuntime({ db, governanceHash: skill.hash });
  const suggestion = await runtime(context(job)) as unknown as Suggestion;
  const input = decision === "none" ? { target, limit: 5, policy_version: suggestion.policy_version,
    context_hash: suggestion.context_hash, catalog_hash: suggestion.catalog_hash, decision, reason: "PRIVATE_REASON_MARKER" }
    : choice(suggestion, suggestion.items[0]!, decision);
  const choiceContext = context(job, "record_skill_choice", input);
  const selected = (await runtime(choiceContext))!;
  assert.equal((await db`SELECT COUNT(*)::int AS n FROM project_knowledge_usages WHERE job_id=${job.jobId}`)[0].n, 0);
  assert.deepEqual(await createKnowledgeRuntime({ db, governanceHash: skill.hash })(choiceContext), selected);
  const pullingJob = { ...job };
  if (changeAttempt) {
    pullingJob.attemptId = randomUUID();
    await db`UPDATE job_attempts SET status='cancelled',cancel_requested=true,cancel_requested_at=now() WHERE id=${job.attemptId}`;
    await db`INSERT INTO job_attempts(id,job_id,attempt_no,phase,session_id)
      VALUES(${pullingJob.attemptId},${job.jobId},2,'agent.ready',${randomUUID()})`;
  }
  const pull = (await runtime(context(pullingJob, "pull_skill", { selector: skill.selector, expected_content_hash: skill.hash })))!;
  const fact = randomUUID(), body = { observation: "PRIVATE_EVIDENCE_MARKER" };
  await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,body_json,verification_status)
    VALUES(${fact},${job.canvasId},${job.jobId},'fact','private fixture result',${db.json(body)},'unverified')`;
  const evidence = { kind: "fact", ref: fact,
    content_hash: sha256(canonical({ kind: "fact", id: fact, body, verification_status: "unverified" })) };
  const feedback = (await runtime(context(pullingJob, "record_knowledge_feedback", { usage_ref: pull.usage_ref,
    outcome: "failure", evidence_refs: [evidence], next_action: "revise", reason: "PRIVATE_FEEDBACK_MARKER" })))!;
  return { job, skill, snapshot, selected, pull, feedback, fact, evidence, pullingJob };
}

function report(input: unknown) { return buildEvidenceReport(input, sourceDigest(input)); }

for (const decision of ["select", "reject", "none"] as const) {
  test(`actual SQL exports runtime ${decision}, pull and feedback without raw declaration text`, options, async () => {
    await isolated(async db => {
      const f = await chain(db, decision);
      const input = await exportProject(db, f.job.projectId);
      assert.equal(input.schema, "deepsonar.capability-evidence-export/v2");
      assert.deepEqual(input.jobs[0].project_knowledge_catalog, f.snapshot.project_knowledge_catalog);
      assert.equal(input.versions[0].item_status, "active");
      assert.equal(input.usages[0].declared_outcome, "failure");
      assert.equal(input.usages[0].declared_evidence_count, 1);
      assert.equal(input.usages[0].feedback_json, undefined);
      const choiceRow = input.receipts.find((r: { id: string }) => r.id === f.selected.receipt_ref);
      const [event] = await db`SELECT e.job_seq,e.event_id FROM events e JOIN project_knowledge_receipts r
        ON r.event_id::text=e.event_id AND r.job_id=e.job_id AND r.attempt_id=e.attempt_id WHERE r.id=${String(f.selected.receipt_ref)}`;
      assert.equal(choiceRow.event_seq, Number(event.job_seq)); assert.equal(choiceRow.event_id, event.event_id);
      assert.equal(choiceRow.result.reason_present, true);
      const output = report(input);
      assert.deepEqual(report(input), output);
      assert.equal(output.choices.length, 1); assert.equal(output.choices[0].decision, decision);
      assert.equal(output.choices[0].evidence_status, "bound_declaration");
      assert.equal(output.choices[0].pulls.length, decision === "none" ? 0 : 1);
      if (decision !== "none") assert.deepEqual(output.choices[0].pulls[0], {
        usage_ref: f.pull.usage_ref, feedback_receipt_refs: [f.feedback.receipt_ref],
      });
      assert.equal(output.denominators.pulled_usages, 1);
      assert.equal(output.denominators.independently_verified_pairs, 0);
      assert.equal(output.records[0].pulls[0].declared_evidence_count, 1);
      for (const value of [input, output]) {
        const text = JSON.stringify(value);
        for (const marker of ["PRIVATE_REASON_MARKER", "PRIVATE_TARGET_MARKER", "PRIVATE_EVIDENCE_MARKER", "PRIVATE_FEEDBACK_MARKER", f.fact, f.evidence.content_hash])
          assert.ok(!text.includes(marker), marker);
      }
      const again = await exportProject(db, f.job.projectId);
      // Capture timestamps differ; all rows and their projection remain unchanged.
      again.captured_at = input.captured_at;
      assert.deepEqual(report(again), output);
    });
  });
}

test("actual SQL preserves different Attempt provenance without linking the earlier choice to a later pull", options, async () => {
  await isolated(async db => {
    const f = await chain(db, "select", true);
    const output = report(await exportProject(db, f.job.projectId));
    assert.equal(output.choices[0].attempt_id, f.job.attemptId);
    assert.deepEqual(output.choices[0].pulls, []);
    assert.equal(output.records[0].pulls[0].attempt_id, f.pullingJob.attemptId);
    assert.deepEqual(output.records[0].pulls[0].feedback_receipt_refs, [f.feedback.receipt_ref]);
  });
});

test("actual SQL exports item-only revocation and the report removes choice and usage denominators", options, async () => {
  await isolated(async db => {
    const f = await chain(db);
    await db`UPDATE project_knowledge_items SET status='revoked' WHERE id=${f.skill.item}`;
    const input = await exportProject(db, f.job.projectId);
    assert.equal(input.versions[0].revoked_at, null); assert.equal(input.versions[0].item_status, "revoked");
    const output = report(input);
    assert.deepEqual(output.choices, []); assert.deepEqual(output.records, []);
    assert.equal(output.denominators.choice_declarations, 0); assert.equal(output.denominators.pulled_usages, 0);
  });
});

test("degraded exports cannot invent missing provenance, exact identity, or old catalog bindings", options, async () => {
  await isolated(async db => {
    const f = await chain(db), input = await exportProject(db, f.job.projectId);
    const damaged = (mutate: (value: typeof input) => void) => { const value = structuredClone(input); mutate(value); return report(value); };
    assert.deepEqual(damaged(v => { v.receipts = []; }).choices, []);
    assert.deepEqual(damaged(v => { v.attempts = []; }).choices, []);
    assert.deepEqual(damaged(v => { v.versions = []; }).choices, []);
    assert.deepEqual(damaged(v => { v.usages = []; }).choices[0].pulls, []);
    const withoutSequence = damaged(v => { v.receipts.find((r: { operation: string }) => r.operation === "record_skill_choice").event_seq = null; });
    assert.deepEqual(withoutSequence.choices, []);
    for (const mutate of [
      (r: { catalog_hash: string }) => { r.catalog_hash = "b".repeat(64); },
      (r: { candidate: { content_hash: string } }) => { r.candidate.content_hash = "b".repeat(64); },
    ]) {
      const output = damaged(v => mutate(v.receipts.find((r: { operation: string }) => r.operation === "record_skill_choice").result));
      assert.equal(output.choices[0].evidence_status, "unknown"); assert.deepEqual(output.choices[0].pulls, []);
    }
    const corrupt = structuredClone(input); corrupt.jobs[0].project_knowledge_catalog.entries = [];
    assert.throws(() => report(corrupt), /CATALOG_DIGEST_MISMATCH/);
    assert.throws(() => buildEvidenceReport(input, "b".repeat(64)), /SOURCE_DIGEST_MISMATCH/);
  });
});

test("actual SQL scopes source rows to the project and report ignores granted foreign identities", options, async () => {
  await isolated(async db => {
    const f = await chain(db), foreignChain = await chain(db);
    const foreign = foreignChain.job, secret = foreignChain.skill;
    await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
      VALUES(${foreign.projectId},${secret.item},${secret.version},${f.job.projectId},'fixture')`;
    await freeze(db, f.job);
    const input = await exportProject(db, f.job.projectId);
    assert.ok(input.jobs[0].project_knowledge_catalog.entries.some((e: { version_id: string }) => e.version_id === secret.version),
      "original frozen catalog is preserved, including foreign membership, for digest verification");
    assert.equal(input.versions.length, 1);
    assert.equal(input.usages.length, 1); assert.equal(input.receipts.length, 2);
    assert.ok(!input.receipts.some((r: { id: string }) => r.id === foreignChain.selected.receipt_ref));
    assert.ok(input.jobs.every((j: { project_id: string }) => j.project_id === f.job.projectId));
    const output = report(input);
    assert.equal(output.records.length, 1);
    // Refreezing the catalog invalidates the historical choice's catalog binding.
    assert.equal(output.choices[0].evidence_status, "unknown"); assert.deepEqual(output.choices[0].pulls, []);
    const text = JSON.stringify(output);
    for (const marker of [foreign.projectId, foreign.jobId, secret.item, secret.version, secret.hash]) assert.ok(!text.includes(marker));
  });
});

test("actual SQL rejects mismatched event operation provenance for both choice and feedback", options, async () => {
  await isolated(async db => {
    const f = await chain(db);
    await db`UPDATE events SET payload_json=jsonb_set(payload_json,'{operation}','"request_project_knowledge"'::jsonb)
      WHERE job_id=${f.job.jobId} AND type='knowledge'`;
    const input = await exportProject(db, f.job.projectId);
    assert.equal(input.receipts.length, 2);
    for (const receipt of input.receipts) {
      assert.equal(receipt.event_id, null); assert.equal(receipt.event_seq, null);
    }
    const output = report(input);
    assert.deepEqual(output.choices, []);
    assert.equal(output.records[0].pulls[0].declared_outcome, "failure");
    assert.deepEqual(output.records[0].pulls[0].feedback_receipt_refs, []);
    assert.equal(output.denominators.independently_verified_pairs, 0);
  });
});
