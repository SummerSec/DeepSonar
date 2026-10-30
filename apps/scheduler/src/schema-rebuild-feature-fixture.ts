/** #770 C uses the exact schema from the pinned, merged v63 baseline. Unlike
 * the v62 Finding-shape fixture, no C tables or indexes exist before rebuild.
 * CI checks out full history (fetch-depth: 0); never substitute current schema. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";
import { restoreFindingSourceBackup } from "./schema-rebuild-finding-fixture.js";
import { SCHEMA_VERSION } from "./schema-version.js";

const V63_COMMIT = "0841f8272ab1c9c64fdfeddba7aff53f2d5c856d";
const FEATURE_TABLES = ["project_finding_feature_scan", "project_finding_feature_work", "project_finding_features"];
const FEATURE_INDEXES = ["project_finding_feature_work_due", "project_finding_features_project", "findings_project_scan_idx"];

function schemaV63(): string {
  let schema: string;
  try {
    schema = execFileSync("git", ["show", `${V63_COMMIT}:database/schema.sql`], {
      cwd: resolve(dirname(SCHEMA_FILE), ".."), encoding: "utf8", stdio: "pipe", timeout: 10_000,
    });
  } catch {
    throw new Error("Pinned v63 schema unavailable; this integration fixture requires full Git history, without a current-schema fallback.");
  }
  assert.match(schema, /INSERT INTO schema_meta \(id, version\) VALUES \('global', 63\)/);
  assert.match(schema, /source_digest text/);
  assert.match(schema, /findings_job_id_fingerprint_key UNIQUE \(job_id, fingerprint\)/);
  for (const name of [...FEATURE_TABLES, ...FEATURE_INDEXES]) assert.ok(!schema.includes(name));
  return schema;
}

async function assertNoFeatures(db: ReturnType<typeof postgres>): Promise<void> {
  for (const name of [...FEATURE_TABLES, ...FEATURE_INDEXES]) {
    assert.equal((await db`SELECT to_regclass(${'public.' + name})::text AS name`)[0].name, null, name);
  }
}

export async function runFeatureSchemaRebuildFixture(testUrl: string): Promise<void> {
  const adminUrl = new URL(testUrl); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const prefix = `feature_rebuild_${randomUUID().replaceAll("-", "")}`;
  const targetName = `${prefix}_target`, backupName = `${prefix}_backup`;
  const targetUrl = new URL(testUrl); targetUrl.pathname = `/${targetName}`;
  const backupUrl = new URL(testUrl); backupUrl.pathname = `/${backupName}`;
  const db = postgres(targetUrl.toString(), { max: 2 });
  const backup = postgres(backupUrl.toString(), { max: 1 });
  const dumpDir = mkdtempSync(join(tmpdir(), "deepsonar-770-feature-rebuild-"));
  const previousUrl = process.env.DATABASE_URL;
  try {
    await admin.unsafe(`CREATE DATABASE "${targetName}"`);
    await admin.unsafe(`CREATE DATABASE "${backupName}"`);
    const bootstrap = await db.reserve();
    try { await bootstrap.unsafe(schemaV63()); } finally { bootstrap.release(); }
    await assertNoFeatures(db);
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 63);
    assert.equal((await db`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='findings' AND column_name='source_digest'`)[0].n, 1);

    const project = randomUUID(), canvas = randomUUID(), job = randomUUID();
    const finding = randomUUID(), artifact = randomUUID(), node = randomUUID(), jobNode = randomUUID(), event = randomUUID();
    const sourceDigest = `v1:${"7".repeat(64)}`;
    const payload = { title: "保留历史发现", summary: "Historical source evidence survives the feature projection upgrade.", profile: "general" };
    await db`INSERT INTO projects(id,name) VALUES (${project},'v63 feature rebuild fixture')`;
    await db`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'historical task')`;
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES (${job},${project},${canvas},'audit','succeeded',${db.json({ frozen_source: "historical target" })})`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status) VALUES
      (${jobNode},${canvas},${job},'intent','historical source job','succeeded'),
      (${node},${canvas},${job},'finding',${payload.title},'confirmed')`;
    await db`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type) VALUES (${canvas},${jobNode},${node},'produces')`;
    await db`INSERT INTO artifacts(id,project_id,canvas_id,job_id,node_id,artifact_key,kind,source_operation,source_event_id)
      VALUES (${artifact},${project},${canvas},${job},${node},${`finding:${job}:source-770`},'general','emit_finding',${event})`;
    await db`INSERT INTO artifact_claims(artifact_id,statement,evidence_refs_json)
      VALUES (${artifact},${payload.summary},${db.json(["src/source.ts:17"])})`;
    await db`INSERT INTO artifact_evidence(artifact_id,statement,uri,polarity)
      VALUES (${artifact},'historical evidence','src/source.ts:17','supports')`;
    await db`INSERT INTO findings(id,project_id,job_id,artifact_id,node_id,fingerprint,source_digest,title,summary,profile,location,evidence_refs_json,verify_status,disposition)
      VALUES (${finding},${project},${job},${artifact},${node},'source-770',${sourceDigest},${payload.title},${payload.summary},'general','src/source.ts:17',${db.json(["src/source.ts:17"])},'confirmed','resolved')`;
    await db`INSERT INTO finding_verification_rounds(finding_id,attempt,status,final_outcome,evidence_snapshot_json)
      VALUES (${finding},1,'confirmed','confirmed',${db.json({ artifact_id: artifact, finding_id: finding })})`;
    await db`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES (${job},${event},1,'finding',${db.json(payload)})`;
    await db`INSERT INTO event_dedup(event_id,job_id) VALUES (${event},${job})`;
    const capture = async (source: typeof db) => {
      const records: Record<string, unknown> = {};
      for (const table of ["projects", "canvases", "jobs", "findings", "finding_verification_rounds", "artifacts", "artifact_claims", "artifact_evidence", "canvas_nodes", "canvas_edges", "events", "event_dedup"]) {
        const rows = await source.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
        records[table] = rows.map(row => row.row);
      }
      return records;
    };
    const history = await capture(db);
    process.env.DATABASE_URL = targetUrl.toString();
    const reserve = () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>;
    const plan = await rebuildSchemaOnReservedSession(reserve, { mode: "plan", terminateScheduler: false });
    assert.equal(plan.plan.currentVersion, 63);
    assert.equal(plan.plan.targetVersion, SCHEMA_VERSION);
    assert.deepEqual([...plan.plan.newTables].sort(), [...FEATURE_TABLES].sort());
    assert.equal(plan.applied, false);
    await assertNoFeatures(db);
    assert.deepEqual(await capture(db), history);
    const rebuilt = await rebuildSchemaOnReservedSession(reserve, { mode: "apply", dumpDir, keepStaging: true, terminateScheduler: false });
    assert.equal(rebuilt.applied, true);
    assert.ok(rebuilt.dumpPath, "a real backup file is mandatory");
    assert.equal(readFileSync(rebuilt.dumpPath).subarray(0, 5).toString(), "PGDMP");
    // Shared helper keeps connection credentials in env, redacts process errors,
    // and requires pg_restore --exit-on-error; never tolerate restore errors.
    restoreFindingSourceBackup(backupUrl, rebuilt.dumpPath);
    assert.equal((await backup`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 63);
    await assertNoFeatures(backup);
    assert.deepEqual(await capture(backup), history, "the actual on-disk v63 backup restores every source row");
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION);
    assert.deepEqual(await capture(db), history, "rebuild preserves full history including source_digest and Verify state");
    for (const name of [...FEATURE_TABLES, ...FEATURE_INDEXES]) {
      assert.equal((await db`SELECT to_regclass(${'public.' + name})::text AS name`)[0].name, name);
    }
    assert.deepEqual((await db`SELECT id,cursor_id FROM project_finding_feature_scan`).map(row => ({ ...row })), [{ id: "global", cursor_id: null }]);
    for (const name of ["project_finding_feature_work", "project_finding_features"]) {
      assert.equal(Number((await db.unsafe(`SELECT count(*) AS n FROM ${name}`))[0].n), 0);
    }

    const { processFeatureBatch, requestFeatureRebuild, readFeatureStatus } = await import("./domains/project-finding-research/store.js");
    // Explicit DB arguments avoid the module's default runtime connection; this
    // fixture is isolated even after the earlier A fixture has closed its pool.
    await processFeatureBatch(db);
    assert.equal((await readFeatureStatus(finding, project, db))?.status, "succeeded");
    const [first] = await db`SELECT generation,input_digest,features_json FROM project_finding_features WHERE finding_id=${finding}`;
    assert.ok(first);
    assert.deepEqual(await capture(db), history, "derived execution cannot mutate accepted source history");
    await db`DELETE FROM project_finding_features WHERE project_id=${project}`;
    await requestFeatureRebuild(project, db);
    await processFeatureBatch(db);
    const [second] = await db`SELECT generation,input_digest,features_json FROM project_finding_features WHERE finding_id=${finding}`;
    assert.ok(second);
    assert.notEqual(second.generation, first.generation);
    assert.equal(second.input_digest, first.input_digest);
    assert.deepEqual(second.features_json, first.features_json, "deleted derived features can be deterministically rebuilt");
    assert.equal((await readFeatureStatus(finding, project, db))?.status, "succeeded");
    assert.deepEqual(await capture(db), history);
    const [original] = await db`SELECT id,source_digest,verify_status,disposition FROM findings WHERE id=${finding}`;
    assert.deepEqual({ ...original }, { id: finding, source_digest: sourceDigest, verify_status: "confirmed", disposition: "resolved" });
  } finally {
    await db.end(); await backup.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${targetName}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${backupName}"`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    rmSync(dumpDir, { recursive: true, force: true });
  }
}
