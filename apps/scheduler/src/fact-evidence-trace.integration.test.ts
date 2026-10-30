import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("evidence trace requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL unset; refusing default database" }, () => {});
} else {
  test("read-only evidence trace verifies retained bytes without attesting execution", async (t) => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const name = `trace_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "evidence-trace-"));
    let created = false, close: (() => Promise<unknown>) | undefined, closeApp: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = dbUrl.toString(); process.env.BLOB_DIR = blobDir;
      process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      const [{ sql, migrate }, { ingestEvent }, { default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }] = await Promise.all([
        import("./db.js"), import("./core.js"), import("fastify"), import("@fastify/websocket"), import("./routes.js"), import("./auth.js"),
      ]);
      close = () => sql.end({ timeout: 5 }); await migrate();
      const app = Fastify({ logger: false }); closeApp = () => app.close();
      await app.register(websocket); registerRoutes(app); await app.ready();
      const snapshot = { name: "audit", role_kind: "role", platform_tools: ["emit_fact", "emit_finding", "mark_job_done"], network_policy: { allow_egress: false } };
      const tokenFor = async (projectId: string, scopes: string[]) => {
        const token = generateToken();
        await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes) VALUES('trace reader',${projectId},${token.prefix},${token.hash},${scopes})`;
        return { authorization: `Bearer ${token.plaintext}` };
      };
      const fixture = async (referenceMode: "exact" | "none" | "wrong_attempt" | "suffix" | "prefixed" = "exact") => {
        const projectId = randomUUID(), canvasId = randomUUID();
        await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'trace fixture','{"rules":{"hubEnabled":false}}'::jsonb)`;
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'trace fixture',${sql.json({ effective_finding_protocol: {
          mode: "hybrid", default_profile: "general", allowed_profiles: ["general"], scoring: { default_standard: "CVSS", default_version: "3.1", accepted_versions: ["3.1"], require_scoring_for_profiles: [] }, display_name: "fixture", source: "task",
        } })})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','fixture','active')`;
        const job = async () => {
          const jobId = randomUUID(), attemptId = randomUUID();
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json) VALUES(${jobId},${projectId},${canvasId},'audit','running',${sql.json(snapshot)},'{}'::jsonb)`;
          await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${attemptId},${jobId},1,'active','agent.ready')`;
          await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'intent','fixture','running')`;
          return { jobId, attemptId };
        };
        const maker = await job();
        await ingestEvent(maker.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: { title: "Offline parser fixture", summary: "The local parser fixture produced a reproducible response for a malformed input.", profile: "general" } } as never);
        const [finding] = await sql`SELECT id FROM findings WHERE job_id=${maker.jobId}`;
        assert.ok(finding); const findingId = String(finding.id);
        const reviewer = await job(), eventId = randomUUID();
        const relative = `attempts/${reviewer.attemptId}/result.txt`, bytes = Buffer.from("offline fixture retained output\n"), hash = createHash("sha256").update(bytes).digest("hex");
        const directory = path.join(blobDir, "jobs", reviewer.jobId), file = path.join(directory, relative);
        await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: reviewer.jobId, finalized_at: new Date().toISOString(), files: [{ path: relative, name: "result.txt", bytes: bytes.length, sha256: hash }] }));
        const uri = `jobs/${reviewer.jobId}/${relative}`;
        const declaredUri = referenceMode === "suffix" ? "result.txt" : referenceMode === "wrong_attempt" ? uri.replace(reviewer.attemptId, randomUUID()) : uri;
        await ingestEvent(reviewer.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
          title: "Independent fixture observation", description: "Retained fixture output with agent-declared execution metadata; no host command receipt.",
          verification: { finding_id: findingId, evidence_kind: "test", outcome: "supports", subject_revision: "fixture-v1", environment: "offline fixture", steps: ["agent-declared parser invocation"], expected: "Malformed input handled", actual: "Observed fixture output", exit_code: 0, artifact_refs: referenceMode === "none" ? [] : [{ uri: declaredUri, sha256: referenceMode === "prefixed" ? `sha256:${hash.toUpperCase()}` : hash }] },
        } } as never);
        const [artifact] = await sql`SELECT id,node_id FROM artifacts WHERE job_id=${reviewer.jobId} AND source_event_id=${eventId}`;
        assert.ok(artifact?.node_id); const factId = String(artifact.node_id);
        for (const current of [maker, reviewer]) {
          await sql`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${current.attemptId}`;
          await sql`UPDATE jobs SET status='succeeded' WHERE id=${current.jobId}`;
        }
        await sql`UPDATE findings SET verify_status='confirmed',raw_json=raw_json || ${sql.json({ verification_state: { subject_revision: "fixture-v1", used_fact_ids: [factId] } })} WHERE id=${findingId}`;
        const headers = await tokenFor(projectId, ["findings:read"]);
        const read = async (auth: Record<string, string> = headers) => app.inject({ method: "GET", url: `/findings/${findingId}/evidence-trace`, headers: auth });
        const trace = async () => { const response = await read(); assert.equal(response.statusCode, 200, response.payload); return response.json().fact_evidence_trace; };
        const historical = (await sql`SELECT verify_status,raw_json FROM findings WHERE id=${findingId}`)[0];
        return { projectId, canvasId, findingId, maker, reviewer, factId, artifactId: String(artifact.id), eventId, file, bytes, uri, hash, trace, read, historical };
      };
      type Fixture = Awaited<ReturnType<typeof fixture>>;
      const unchanged = async (f: Fixture) => assert.deepEqual((await sql`SELECT verify_status,raw_json FROM findings WHERE id=${f.findingId}`)[0], f.historical);
      const blocked = async (f: Fixture) => {
        const trace = await f.trace(); assert.equal(trace.replay.ok, false); assert.ok(trace.blocking_errors.length > 0);
        assert.ok(trace.facts.every((fact: { retained_bytes_verified: boolean; runtime_proof: boolean }) => !fact.retained_bytes_verified && !fact.runtime_proof));
        await unchanged(f);
      };
      await t.test("exact retained reference is checked while execution remains not attested", async () => {
        const f = await fixture(), trace = await f.trace();
        assert.equal(trace.replay.ok, true); assert.equal(trace.replay.kind, "evidence_integrity_check");
        assert.equal(trace.facts[0].retained_bytes_verified, true);
        assert.equal(trace.facts[0].runtime_claim_structured, true);
        assert.equal(trace.facts[0].execution_assurance, "not_attested"); assert.equal(trace.facts[0].runtime_proof, false);
        await unchanged(f);
        await writeFile(f.file, "tampered"); await blocked(f);
        await writeFile(f.file, f.bytes); assert.equal((await f.trace()).replay.ok, true);
        await rm(f.file); await blocked(f);
        assert.equal(trace.replay.ok, true, "prior response remains immutable history");
      });
      await t.test("prefixed uppercase declared SHA compares to exact retained bytes", async () => {
        const f = await fixture("prefixed"), trace = await f.trace();
        assert.equal(trace.replay.ok, true); assert.equal(trace.facts[0].retained_bytes_verified, true);
        assert.equal(trace.facts[0].execution_assurance, "not_attested"); await unchanged(f);
      });
      await t.test("structured runtime claims without retained references never attest execution or bytes", async () => {
        const f = await fixture("none");
        const trace = await f.trace();
        assert.equal(trace.facts[0].runtime_claim_structured, true);
        assert.equal(trace.facts[0].retained_bytes_verified, false);
        assert.equal(trace.facts[0].execution_assurance, "not_attested");
        assert.equal(trace.facts[0].runtime_proof, false); await unchanged(f);
      });
      await t.test("wrong Attempt and suffix-only references cannot match a manifest entry", async () => {
        for (const mode of ["wrong_attempt", "suffix"] as const) await blocked(await fixture(mode));
      });
      await t.test("superseded Attempt, unknown effects and rejected Fact invalidate reads", async () => {
        for (const mode of ["old_attempt", "unknown", "rejected", "failed"]) {
          const f = await fixture();
          if (mode === "old_attempt") await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${randomUUID()},${f.reviewer.jobId},2,'succeeded','terminal')`;
          if (mode === "unknown") await sql`INSERT INTO job_attempt_effects(id,attempt_id,job_id,effect_id,effect_kind,status) VALUES(${randomUUID()},${f.reviewer.attemptId},${f.reviewer.jobId},'trace-fixture','fixture','unknown')`;
          if (mode === "failed") await sql`UPDATE jobs SET status='failed' WHERE id=${f.reviewer.jobId}`;
          if (mode === "rejected") await sql`UPDATE canvas_nodes SET verification_status='rejected' WHERE id=${f.factId}`;
          await blocked(f);
        }
      });
      await t.test("cross-Canvas evidence and missing event ownership cannot become readable proof", async () => {
        for (const mode of ["canvas", "event"]) {
          const f = await fixture();
          if (mode === "canvas") {
            const other = randomUUID(); await sql`INSERT INTO canvases(id,project_id,title) VALUES(${other},${f.projectId},'other canvas')`;
            await sql`UPDATE canvas_nodes SET canvas_id=${other} WHERE id=${f.factId}`;
          } else await sql`UPDATE artifacts SET source_event_id=${randomUUID()} WHERE id=${f.artifactId}`;
          await blocked(f);
        }
      });
      await t.test("same-Canvas other-Finding proof and changed role or Job Canvas cannot be borrowed", async () => {
        const f = await fixture();
        for (const current of [f.maker, f.reviewer]) {
          await sql`UPDATE jobs SET status='running' WHERE id=${current.jobId}`;
          await sql`UPDATE job_attempts SET status='active',phase='agent.ready' WHERE id=${current.attemptId}`;
        }
        await ingestEvent(f.maker.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: { title: "Separate fixture finding", summary: "A distinct local fixture finding used to verify proof cannot cross Finding identity.", profile: "general" } } as never);
        const [other] = await sql`SELECT id FROM findings WHERE job_id=${f.maker.jobId} AND id<>${f.findingId}`;
        const [event] = await sql`SELECT payload_json FROM events WHERE job_id=${f.reviewer.jobId} AND event_id=${f.eventId}`;
        const eventId = randomUUID();
        await ingestEvent(f.reviewer.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
          title: "Other Finding observation", description: "Valid retained proof for a different Finding on the same Canvas.",
          verification: { ...event.payload_json.verification, finding_id: String(other.id) },
        } } as never);
        const [proof] = await sql`SELECT node_id FROM artifacts WHERE job_id=${f.reviewer.jobId} AND source_event_id=${eventId}`;
        for (const current of [f.maker, f.reviewer]) {
          await sql`UPDATE jobs SET status='succeeded' WHERE id=${current.jobId}`;
          await sql`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${current.attemptId}`;
        }
        await sql`UPDATE findings SET raw_json=jsonb_set(raw_json,'{verification_state,used_fact_ids}',${sql.json([String(proof.node_id)])}) WHERE id=${f.findingId}`;
        const trace = await f.trace(); assert.equal(trace.replay.ok, false); assert.equal(trace.facts[0].retained_bytes_verified, false);
        for (const mode of ["role", "job_canvas"]) {
          const own = await fixture();
          if (mode === "role") await sql`UPDATE canvas_nodes SET body_json=jsonb_set(body_json,'{verification,source_role}','"forged-role"'::jsonb) WHERE id=${own.factId}`;
          else {
            const canvasId = randomUUID(); await sql`INSERT INTO canvases(id,project_id,title) VALUES(${canvasId},${own.projectId},'moved Job')`;
            await sql`UPDATE jobs SET canvas_id=${canvasId} WHERE id=${own.reviewer.jobId}`;
          }
          await blocked(own);
        }
      });
      await t.test("multiple Facts share one bounded byte scan and cannot retain overall success", async () => {
        const f = await fixture(), entries = [], directory = path.dirname(path.dirname(path.dirname(f.file)));
        for (let index = 0; index < 3; index++) {
          const relative = `attempts/${f.reviewer.attemptId}/large-${index}.txt`, bytes = Buffer.alloc(1536 * 1024, 65 + index);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          await writeFile(path.join(directory, relative), bytes); entries.push({ path: relative, bytes: bytes.length, sha256 });
        }
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: f.reviewer.jobId, finalized_at: new Date().toISOString(), files: entries }));
        const [sourceEvent] = await sql`SELECT payload_json FROM events WHERE job_id=${f.reviewer.jobId} AND event_id=${f.eventId}`;
        await sql`UPDATE jobs SET status='running' WHERE id=${f.reviewer.jobId}`;
        await sql`UPDATE job_attempts SET status='active',phase='agent.ready' WHERE id=${f.reviewer.attemptId}`;
        const ids: string[] = [];
        for (let index = 0; index < 2; index++) {
          const eventId = randomUUID();
          await ingestEvent(f.reviewer.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
            title: `Large independent trace fixture ${index}`, description: "Retained byte budget fixture with real files and event ownership.",
            verification: { ...sourceEvent.payload_json.verification, artifact_refs: entries.map(entry => ({ uri: `jobs/${f.reviewer.jobId}/${entry.path}`, sha256: entry.sha256 })) },
          } } as never);
          const [artifact] = await sql`SELECT node_id FROM artifacts WHERE job_id=${f.reviewer.jobId} AND source_event_id=${eventId}`;
          ids.push(String(artifact.node_id));
        }
        await sql`UPDATE jobs SET status='succeeded' WHERE id=${f.reviewer.jobId}`;
        await sql`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${f.reviewer.attemptId}`;
        await sql`UPDATE findings SET raw_json=jsonb_set(raw_json,'{verification_state,used_fact_ids}',${sql.json(ids)}) WHERE id=${f.findingId}`;
        const before = (await sql`SELECT verify_status,raw_json FROM findings WHERE id=${f.findingId}`)[0], trace = await f.trace();
        assert.equal(trace.replay.ok, false); assert.equal(trace.facts.length, 2);
        assert.equal(trace.facts.filter((fact: { retained_bytes_verified: boolean }) => fact.retained_bytes_verified).length, 1, "one 4.5MiB Fact fits, the second exceeds shared 8MiB");
        assert.ok(trace.replay.blockers.length > 0);
        assert.deepEqual((await sql`SELECT verify_status,raw_json FROM findings WHERE id=${f.findingId}`)[0], before);
      });
      await t.test("oversized or malformed historical references return bounded diagnostics instead of 500", async () => {
        const f = await fixture();
        for (const ids of [["not-a-uuid"], Array.from({ length: 101 }, () => randomUUID())]) {
          await sql`UPDATE findings SET raw_json=jsonb_set(raw_json,'{verification_state,used_fact_ids}',${sql.json(ids)}) WHERE id=${f.findingId}`;
          const trace = await f.trace(); assert.equal(trace.replay.ok, false);
          assert.ok(trace.replay.blockers.length > 0); assert.ok(trace.facts.length <= 100);
        }
      });
      await t.test("read endpoint enforces authentication, read scope and project isolation", async () => {
        const f = await fixture(), other = await fixture();
        assert.equal((await f.read({})).statusCode, 401);
        assert.equal((await f.read(await tokenFor(f.projectId, ["jobs:read"])) ).statusCode, 403);
        assert.equal((await f.read(await tokenFor(other.projectId, ["findings:read"])) ).statusCode, 403);
        await unchanged(f);
      });
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (close) await close().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }); await rm(blobDir, { recursive: true, force: true });
    }
  });
}
