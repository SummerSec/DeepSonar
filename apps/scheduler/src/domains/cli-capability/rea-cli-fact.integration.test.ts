/** PostgreSQL/blob-store guard fixtures, separate from required live runtime acceptance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";
import { ControlEventEnvelope, EmitFactDirectPayload } from "@deepsonar/shared-types";

test("REA archive guard rejects forged scope/provenance, stale attempts and corrupted CAS", async () => {
  const url = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(url, "TEST_DATABASE_URL required; this gate must not silently skip");
  const adminUrl = new URL(url); adminUrl.pathname = "/postgres"; adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `deepsonar_rea_guard_${process.pid}_${Date.now()}`;
  const target = new URL(url); target.pathname = `/${name}`; target.search = "";
  const blobDir = await mkdtemp(path.join(os.tmpdir(), "rea-guard-"));
  let created = false; let end: (() => Promise<unknown>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: target.toString(), AGENT_MODE: "fake", BLOB_STORE: "fs", BLOB_DIR: blobDir });
    const [{ sql, migrate }, { createAttempt }, assets, { normalizeArchivedReaFact }, { admitCliCapabilities }] = await Promise.all([
      import("../../db.js"), import("../job-attempt/application.js"), import("../shared-assets/index.js"),
      import("./rea-cli-fact.js"), import("./admit.js"),
    ]);
    end = () => sql.end({ timeout: 5 }); await migrate();
    const project = randomUUID(); const otherProject = randomUUID(); const jobId = randomUUID(); const otherJob = randomUUID();
    const digest = `sha256:${"b".repeat(64)}`;
    const admitted = admitCliCapabilities({ ids: ["binary.rea.cli"], imageKey: "deepsonar-reverse" });
    assert.ok(admitted.ok);
    const snapshot = { runtime_image: { image_key: "deepsonar-reverse", image_digest: digest }, cli_capabilities: admitted.frozen, cli_capability_pack: admitted.pack };
    for (const [pid, jid] of [[project, jobId], [otherProject, otherJob]]) {
      await sql`INSERT INTO projects (id,name) VALUES (${pid},'REA guard fixture')`;
      await sql`INSERT INTO jobs (id,project_id,type,status,sandbox_id,lease_expires_at,agent_snapshot_json)
        VALUES (${jid},${pid},'audit','running',${`fixture-${jid}`},now()+interval '1 hour',${sql.json(snapshot)})`;
    }
    const attempt = await createAttempt(sql, jobId);
    const archive = {
      schema: "deepsonar.rea-observation/v1", job_id: jobId, attempt_id: String(attempt.id), operation: "function",
      sample_path: "/workspace/sample", sample_sha256: "a".repeat(64), image_digest: digest,
      tool_versions: { rea: "6.4.0", ghidra: "12.1.4", java: "openjdk 21" }, argv: ["rea", "function", "/workspace/sample", "main", "--json"],
      exit_code: 0, stdout: JSON.stringify({ fabricated_fixture: true }), stderr: "", stdout_truncated: false, stderr_truncated: false,
      timed_out: false, cancelled: false, analysis_limits: { timeout_ms: 1000, max_output_bytes: 1024, note: "Explicit DB fixture; not real execution evidence" },
    };
    const publish = (key: string, body: unknown = archive, owner = jobId, pid = project) => assets.createSharedAsset({
      scope: "project", projectId: pid, jobId: owner, key, contentType: "application/json", bytes: Buffer.from(JSON.stringify(body)), origin: "agent", actor: `job:${owner}`,
    });
    const payload = (key: string) => ({ title: "REA guard fixture", description: "Archive admission test; not a real tool execution.", artifact: { extensions: { "binary.rea-cli": { evidence_key: key } } } });
    const valid = await publish("guard/valid.json");
    const normalized = await normalizeArchivedReaFact(jobId, payload("guard/valid.json")) as any;
    assert.equal(normalized.artifact.claims[0].status, "unknown", "fabricated archive content can only remain an untrusted observation");
    assert.equal(normalized.artifact.extensions['binary.rea-cli'].provenance_kind, "agent_reported_observation");
    assert.equal(normalized.verification, undefined);
    await publish("guard/foreign.json", archive, otherJob, otherProject);
    await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/foreign.json")), /published by this Job/);
    // Same project, different Job cannot supply this Job's archive either.
    await sql`UPDATE jobs SET project_id=${project} WHERE id=${otherJob}`;
    await publish("guard/other-job.json", archive, otherJob, project);
    await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/other-job.json")), /published by this Job/);
    const stale = await publish("guard/stale.json");
    await sql`UPDATE shared_asset_versions SET created_at=${new Date(new Date(String(attempt.started_at)).getTime() - 1000)} WHERE id=${String(stale.version_id)}`;
    await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/stale.json")), /published by this Job/);
    for (const [label, patch] of Object.entries({
      job: { job_id: otherJob }, attempt: { attempt_id: randomUUID() }, image: { image_digest: `sha256:${"c".repeat(64)}` },
      tool: { tool_versions: { ...archive.tool_versions, rea: "0.0.0" } }, limits: { analysis_limits: { ...archive.analysis_limits, timeout_ms: 600001 } },
    })) {
      const key = `guard/${label}.json`; await publish(key, { ...archive, ...patch });
      await assert.rejects(normalizeArchivedReaFact(jobId, payload(key)));
    }
    await sql`UPDATE jobs SET agent_snapshot_json=${sql.json({ runtime_image: snapshot.runtime_image })} WHERE id=${jobId}`;
    await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/valid.json")), /not frozen/);
    await sql`UPDATE jobs SET agent_snapshot_json=${sql.json(snapshot)} WHERE id=${jobId}`;
    const [blob] = await sql`SELECT blob_uri FROM shared_asset_blobs WHERE content_sha256=${String(valid.content_sha256)}`;
    const local = await assets.materializeSharedAssetBlob(String(blob.blob_uri));
    const original = await readFile(local);
    try {
      const corrupt = Buffer.from(original); corrupt[0] ^= 1; await writeFile(local, corrupt);
      await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/valid.json")), /digest mismatch/);
    } finally { await writeFile(local, original); }
    await sql`UPDATE shared_asset_versions SET bytes=10000001 WHERE id=${String(valid.version_id)}`;
    await assert.rejects(normalizeArchivedReaFact(jobId, payload("guard/valid.json")), /archive limit/);
    await sql`UPDATE shared_asset_versions SET bytes=${original.byteLength} WHERE id=${String(valid.version_id)}`;
    for (const polarity of ["supports", "contradicts"]) {
      const proposed = payload("guard/valid.json");
      const proposal = EmitFactDirectPayload.parse({ ...proposed, artifact: { ...proposed.artifact,
        evidence: [{ kind: "claim", statement: "Cannot self-verify this fixture", polarity }] } });
      await assert.rejects(normalizeArchivedReaFact(jobId, proposal), /unknown/);
    }
    // Invalid enum values are rejected by the existing strict Control schema,
    // whereas schema-valid non-unknown observations reach the archive guard.
    const invalid = { ...payload("guard/valid.json"), artifact: { ...payload("guard/valid.json").artifact,
      evidence: [{ statement: "Invalid polarity must not bypass the Control boundary", polarity: "refutes" }] } };
    const unnormalized = await normalizeArchivedReaFact(jobId, invalid);
    assert.throws(() => ControlEventEnvelope.parse({ v: 1, event_id: randomUUID(), type: "fact", payload: unnormalized }));
    await assert.rejects(normalizeArchivedReaFact(jobId, { ...payload("guard/valid.json"), verification: {
      finding_id: randomUUID(), evidence_kind: "review", outcome: "supports", subject_revision: "fixture", expected: "expected", actual: "actual",
    } }), /cannot submit a verification/);
  } finally {
    if (end) await end();
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 }); await rm(blobDir, { recursive: true, force: true });
  }
});
