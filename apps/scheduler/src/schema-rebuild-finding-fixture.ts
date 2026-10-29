/** #770 regression fixture: current baseline with only the Finding-specific v62
 * differences restored (project fingerprint unique, no source_digest). This is
 * deliberately NOT a claim to recreate the entire historical v62 baseline. */
import assert from "node:assert/strict";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";
import { SCHEMA_VERSION } from "./schema-version.js";

function priorFindingShape(): string {
  let schema = readFileSync(SCHEMA_FILE, "utf8");
  const edits = [
    [`VALUES ('global', ${SCHEMA_VERSION})`, "VALUES ('global', 62)"],
    ["  -- Nullable only for preserved historical rows; new submissions always store a digest.\n  source_digest text,\n", ""],
    ["CONSTRAINT findings_job_id_fingerprint_key UNIQUE (job_id, fingerprint)", "CONSTRAINT findings_project_id_fingerprint_key UNIQUE (project_id, fingerprint)"],
    ["  CONSTRAINT findings_source_digest_check CHECK (source_digest IS NULL OR source_digest ~ '^v1:[a-f0-9]{64}$'),\n", ""],
  ];
  for (const [before, after] of edits) {
    assert.equal(schema.split(before).length, 2, `fixture must explicitly track baseline shape: ${before}`);
    schema = schema.replace(before, after);
  }
  return schema;
}

/** Keep connection credentials out of process arguments and surfaced command errors. */
export function restoreFindingSourceBackup(
  backupUrl: URL,
  dumpPath: string,
  run: (command: string, args: readonly string[], options: ExecFileSyncOptions) => unknown = execFileSync,
): void {
  try {
    run("pg_restore", ["--exit-on-error", "--dbname", decodeURIComponent(backupUrl.pathname.slice(1)), dumpPath], {
      stdio: "pipe", timeout: 30_000,
      env: {
        ...process.env,
        PGHOST: backupUrl.hostname, PGPORT: backupUrl.port || "5432",
        PGUSER: decodeURIComponent(backupUrl.username), PGPASSWORD: decodeURIComponent(backupUrl.password),
        ...(backupUrl.searchParams.has("sslmode") ? { PGSSLMODE: backupUrl.searchParams.get("sslmode")! } : {}),
      },
    });
  } catch {
    // Do not attach the child-process error/cause/stdout/stderr: it may contain credentials.
    throw new Error("Finding rebuild backup restore failed; check matching PostgreSQL client/server versions and test database availability.");
  }
}

export async function runFindingSourceRebuildFixture(testUrl: string): Promise<void> {
  const adminUrl = new URL(testUrl); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const prefix = `finding_rebuild_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const targetName = `${prefix}_target`, backupName = `${prefix}_backup`;
  const targetUrl = new URL(testUrl); targetUrl.pathname = `/${targetName}`;
  const backupUrl = new URL(testUrl); backupUrl.pathname = `/${backupName}`;
  const db = postgres(targetUrl.toString(), { max: 2 });
  const backup = postgres(backupUrl.toString(), { max: 1 });
  const dumpDir = mkdtempSync(join(tmpdir(), "deepsonar-770-rebuild-"));
  const previousUrl = process.env.DATABASE_URL;
  const previousMode = process.env.AGENT_MODE;
  let endRuntime: (() => Promise<void>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${targetName}"`);
    await admin.unsafe(`CREATE DATABASE "${backupName}"`);
    const bootstrap = await db.reserve();
    try { await bootstrap.unsafe(priorFindingShape()); } finally { bootstrap.release(); }
    const projectId = randomUUID(), canvasId = randomUUID(), jobId = randomUUID();
    const findingId = randomUUID(), artifactId = randomUUID(), nodeId = randomUUID(), jobNodeId = randomUUID();
    const eventId = randomUUID();
    const payload = { profile: "general", title: "Historical source Finding", severity: "low" as const,
      location: "src/historical.ts:17", rule_id: "HISTORY-770",
      summary: "Historical evidence and attribution must survive the schema rebuild without changing human or technical status.",
      evidence_refs: ["src/historical.ts:17"] };
    const fingerprint = createHash("sha256").update([payload.profile, payload.title.toLowerCase(), payload.location, payload.rule_id].join("|")).digest("hex").slice(0, 16);
    const snapshot = { name: "audit", role_kind: "role", platform_tools: ["emit_finding", "mark_job_done"] };
    await db`INSERT INTO projects (id,name,config_json) VALUES (${projectId}, 'historical source rebuild', ${db.json({ rules: { hubEnabled: false } })})`;
    await db`INSERT INTO canvases (id,project_id,title,target_json) VALUES (${canvasId},${projectId},'history', ${db.json({
      effective_finding_protocol: { mode: "fixed", default_profile: "general", allowed_profiles: ["general"],
        scoring: { default_standard: "CVSS", default_version: "3.1", accepted_versions: ["3.1"], require_scoring_for_profiles: [] },
        display_name: "history", source: "task" },
    })})`;
    await db`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES (${jobId},${projectId},${canvasId},'audit','succeeded',${db.json(snapshot)})`;
    await db`INSERT INTO canvas_nodes (id,canvas_id,job_id,node_type,title,status) VALUES
      (${jobNodeId},${canvasId},${jobId},'intent','historical job','succeeded'),
      (${nodeId},${canvasId},${jobId},'finding',${payload.title},'confirmed')`;
    await db`INSERT INTO canvas_edges (canvas_id,from_node_id,to_node_id,edge_type) VALUES (${canvasId},${jobNodeId},${nodeId},'produces')`;
    await db`INSERT INTO artifacts (id,project_id,canvas_id,job_id,node_id,artifact_key,kind,source_operation,source_event_id)
      VALUES (${artifactId},${projectId},${canvasId},${jobId},${nodeId},${`finding:${fingerprint}`},'general','emit_finding',${eventId})`;
    await db`INSERT INTO artifact_claims (artifact_id,statement,evidence_refs_json) VALUES (${artifactId},${payload.summary},${db.json(payload.evidence_refs)})`;
    await db`INSERT INTO artifact_evidence (artifact_id,statement,uri,polarity) VALUES (${artifactId},'historical reference',${payload.location},'supports')`;
    await db`INSERT INTO findings (id,project_id,job_id,artifact_id,node_id,fingerprint,title,profile,summary,evidence_refs_json,verify_status,disposition)
      VALUES (${findingId},${projectId},${jobId},${artifactId},${nodeId},${fingerprint},${payload.title},'general',${payload.summary},${db.json(payload.evidence_refs)},'confirmed','resolved')`;
    await db`INSERT INTO events (job_id,event_id,job_seq,type,payload_json) VALUES (${jobId},${eventId},1,'finding',${db.json(payload)})`;
    await db`INSERT INTO event_dedup (event_id,job_id) VALUES (${eventId},${jobId})`;
    const capture = async (source: typeof db) => {
      const result: Record<string, unknown> = {};
      // Fixed table names; this isolated database contains only these historical rows.
      for (const table of ["projects", "canvases", "jobs", "findings", "artifacts", "artifact_claims", "artifact_evidence", "canvas_nodes", "canvas_edges", "events", "event_dedup"]) {
        const rows = await source.unsafe(`SELECT to_jsonb(t) - 'source_digest' AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
        result[table] = rows.map(row => row.row);
      }
      return result;
    };
    const history = await capture(db);
    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";
    const reserve = () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>;
    const plan = await rebuildSchemaOnReservedSession(reserve, { mode: "plan", terminateScheduler: false });
    assert.equal(plan.plan.currentVersion, 62);
    assert.equal(plan.applied, false);
    assert.deepEqual(await capture(db), history, "plan must not mutate historical records");
    const result = await rebuildSchemaOnReservedSession(reserve, { mode: "apply", dumpDir, keepStaging: true, terminateScheduler: false });
    assert.equal(result.applied, true);
    assert.ok(result.dumpPath, "CI requires a real pg_dump backup, not just retained staging");
    assert.equal(readFileSync(result.dumpPath).subarray(0, 5).toString(), "PGDMP");
    restoreFindingSourceBackup(backupUrl, result.dumpPath);
    assert.equal((await backup`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 62);
    assert.deepEqual(await capture(backup), history, "restored on-disk backup must preserve the full source chain");
    assert.deepEqual(await capture(db), history, "column intersection copy must preserve all original rows");
    assert.equal((await db`SELECT source_digest FROM findings WHERE id=${findingId}`)[0].source_digest, null);
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION);
    const [{ ingestEvent }, runtime] = await Promise.all([import("./core.js"), import("./db.js")]);
    endRuntime = () => runtime.sql.end({ timeout: 5 });
    await ingestEvent(jobId, { v: 1, event_id: eventId, type: "finding", payload });
    assert.deepEqual(await capture(db), history, "accepted historical event replay is still idempotent after rebuild");
    const newJobId = randomUUID();
    await db`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES (${newJobId},${projectId},${canvasId},'audit','running',${db.json(snapshot)})`;
    await db`INSERT INTO canvas_nodes (canvas_id,job_id,node_type,title,status) VALUES (${canvasId},${newJobId},'intent','new independent job','running')`;
    const freshEvent = { v: 1 as const, event_id: randomUUID(), type: "finding" as const, payload };
    await ingestEvent(newJobId, freshEvent);
    await ingestEvent(newJobId, freshEvent);
    const [fresh] = await db`SELECT f.*, a.artifact_key, a.revision FROM findings f JOIN artifacts a ON a.id=f.artifact_id WHERE f.job_id=${newJobId}`;
    assert.ok(fresh);
    assert.notEqual(fresh.id, findingId);
    assert.notEqual(fresh.artifact_id, artifactId);
    assert.equal(fresh.fingerprint, fingerprint);
    assert.equal(fresh.artifact_key, `finding:${newJobId}:${fingerprint}`);
    assert.equal(fresh.revision, 1);
    assert.equal(fresh.disposition, "open");
    assert.notEqual(fresh.verify_status, "confirmed");
    assert.equal(Number((await db`SELECT count(*) AS n FROM findings WHERE project_id=${projectId}`)[0].n), 2);
    const [old] = await db`SELECT f.id, f.job_id, f.node_id, f.verify_status, f.disposition, a.artifact_key, a.superseded_at
      FROM findings f JOIN artifacts a ON a.id=f.artifact_id WHERE f.id=${findingId}`;
    assert.deepEqual({ ...old }, { id: findingId, job_id: jobId, node_id: nodeId, verify_status: "confirmed", disposition: "resolved", artifact_key: `finding:${fingerprint}`, superseded_at: null });
  } finally {
    await endRuntime?.();
    await db.end(); await backup.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${targetName}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${backupName}"`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousMode === undefined) delete process.env.AGENT_MODE; else process.env.AGENT_MODE = previousMode;
    rmSync(dumpDir, { recursive: true, force: true });
  }
}
