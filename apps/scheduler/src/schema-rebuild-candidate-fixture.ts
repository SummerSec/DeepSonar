/** Exact v64 -> current baseline regression, including existing C generations.
 * CI fetch-depth: 0 makes the pinned PR804 source available; never replace it
 * with a current-layout fixture marked as an old version. */
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

const V64_COMMIT = "6a8ab4ad777df0c727b82b34834f43c99fbd7843";
const CANDIDATE_TABLES = ["project_finding_candidate_scan", "project_finding_candidate_work", "project_finding_candidate_sources", "project_finding_candidate_edges"];
const RELATION_TABLES = ["project_finding_identity_sources", "project_finding_identity_source_revisions", "project_finding_identity_mappings", "project_finding_relation_scan", "project_finding_relation_sources", "project_finding_relation_work", "project_finding_relations"];
const NEW_TABLES = [...CANDIDATE_TABLES, ...RELATION_TABLES];
const CANDIDATE_INDEXES = ["project_finding_candidate_work_due", "project_finding_candidate_edges_right"];

function schemaV64(): string {
  let schema: string;
  try {
    schema = execFileSync("git", ["show", `${V64_COMMIT}:database/schema.sql`], {
      cwd: resolve(dirname(SCHEMA_FILE), ".."), encoding: "utf8", stdio: "pipe", timeout: 10_000,
    });
  } catch {
    throw new Error("Pinned v64 schema unavailable; candidate upgrade fixture requires full Git history without a current-schema fallback.");
  }
  assert.match(schema, /INSERT INTO schema_meta \(id, version\) VALUES \('global', 64\)/);
  assert.match(schema, /CREATE TABLE project_finding_features/);
  assert.match(schema, /CREATE INDEX findings_project_scan_idx ON findings\(project_id, id\)/);
  for (const name of NEW_TABLES) assert.ok(!schema.includes(name));
  return schema;
}
async function assertNoCandidates(db: ReturnType<typeof postgres>): Promise<void> {
  for (const name of [...NEW_TABLES, ...CANDIDATE_INDEXES]) {
    assert.equal((await db`SELECT to_regclass(${'public.' + name})::text AS name`)[0].name, null, name);
  }
}
async function captureHistory(db: ReturnType<typeof postgres>): Promise<Record<string, unknown>> {
  const records: Record<string, unknown> = {};
  for (const table of ["projects", "canvases", "jobs", "findings", "finding_verification_rounds", "artifacts", "artifact_claims", "artifact_evidence", "canvas_nodes", "canvas_edges", "events", "event_dedup", "project_finding_feature_scan", "project_finding_feature_work", "project_finding_features"]) {
    const rows = await db.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
    records[table] = rows.map(row => row.row);
  }
  return records;
}

async function assertCandidateConstraints(db: ReturnType<typeof postgres>, project: string, own: string[], foreign: string): Promise<void> {
  const generation = randomUUID();
  const [left, right] = [...own].sort();
  const source = (finding: string, examined = 2, limited = true) => db`
    INSERT INTO project_finding_candidate_sources(project_id,generation,finding_id,input_digest,lexical_digest,rule_version,examined,rank_truncated,window_limited)
    VALUES (${project},${generation},${finding},'input','lexical','constraint-fixture',${examined},false,${limited})`;
  const edge = (a: string, b: string, kind = "similar", score = 0.5) => db`
    INSERT INTO project_finding_candidate_edges(project_id,generation,left_id,right_id,left_input_digest,right_input_digest,left_lexical_digest,right_lexical_digest,kind,matched_fields,score,rule_version)
    VALUES (${project},${generation},${a},${b},'left-input','right-input','left-lexical','right-lexical',${kind},${['lexical.tokens']},${score},'constraint-fixture')`;
  await assert.rejects(source(foreign), { code: "23503" });
  await assert.rejects(source(left, 129), { code: "23514" });
  await assert.rejects(source(left, -1), { code: "23514" });
  await assert.rejects(source(left, 1, false), { code: "23514" });
  await assert.rejects(edge(right, left), { code: "23514" });
  await assert.rejects(edge(left, left), { code: "23514" });
  const foreignPair = [left, foreign].sort();
  await assert.rejects(edge(foreignPair[0], foreignPair[1]), { code: "23503" });
  await assert.rejects(edge(left, right, "same_issue"), { code: "23514" });
  await assert.rejects(edge(left, right, "similar", 1.1), { code: "23514" });
  await assert.rejects(edge(left, right, "similar", Number.NaN), { code: "23514" });
  await assert.rejects(db`INSERT INTO project_finding_candidate_work(project_id,rule_version,attempts) VALUES (${project},'constraint-fixture',4)`, { code: "23514" });
  await assert.rejects(db`INSERT INTO project_finding_candidate_work(project_id,rule_version,status) VALUES (${project},'constraint-fixture','unknown')`, { code: "23514" });
  await source(left);
  await edge(left, right);
  await assert.rejects(source(left), { code: "23505" });
  await assert.rejects(edge(left, right), { code: "23505" });
  // Test FK cascades inside a rolled-back transaction; preserve all source history.
  await assert.rejects(db.begin(async tx => {
    await tx`DELETE FROM findings WHERE id=${left}`;
    assert.equal((await tx`SELECT count(*)::int AS n FROM project_finding_candidate_sources`)[0].n, 0);
    assert.equal((await tx`SELECT count(*)::int AS n FROM project_finding_candidate_edges`)[0].n, 0);
    throw new Error("rollback candidate cascade probe");
  }), /rollback candidate cascade probe/);
  await db`DELETE FROM project_finding_candidate_edges WHERE project_id=${project}`;
  await db`DELETE FROM project_finding_candidate_sources WHERE project_id=${project}`;
}

export async function runCandidateSchemaRebuildFixture(testUrl: string): Promise<void> {
  const adminUrl = new URL(testUrl); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const prefix = `candidate_rebuild_${randomUUID().replaceAll("-", "")}`;
  const targetName = `${prefix}_target`, backupName = `${prefix}_backup`;
  const targetUrl = new URL(testUrl); targetUrl.pathname = `/${targetName}`;
  const backupUrl = new URL(testUrl); backupUrl.pathname = `/${backupName}`;
  const db = postgres(targetUrl.toString(), { max: 2 });
  const backup = postgres(backupUrl.toString(), { max: 1 });
  const dumpDir = mkdtempSync(join(tmpdir(), "deepsonar-770-candidate-rebuild-"));
  const previousUrl = process.env.DATABASE_URL;
  try {
    await admin.unsafe(`CREATE DATABASE "${targetName}"`);
    await admin.unsafe(`CREATE DATABASE "${backupName}"`);
    const bootstrap = await db.reserve();
    try { await bootstrap.unsafe(schemaV64()); } finally { bootstrap.release(); }
    await assertNoCandidates(db);
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 64);
    assert.equal((await db`SELECT indisunique FROM pg_index WHERE indexrelid='findings_project_scan_idx'::regclass`)[0].indisunique, false);
    const project = randomUUID(), foreignProject = randomUUID();
    const own = [randomUUID(), randomUUID()], foreign = randomUUID();
    const featureGeneration = randomUUID();
    const { loadFeatureSource } = await import("./domains/project-finding-research/store.js");
    const { EXTRACTOR_VERSION, extractFindingFeatures, sourceInputDigest } = await import("./domains/project-finding-research/model.js");
    for (const projectId of [project, foreignProject]) {
      await db`INSERT INTO projects(id,name) VALUES (${projectId},'v64 historical source')`;
      await db`INSERT INTO project_finding_feature_work(project_id,generation,active_generation,extractor_version,status,next_run_at)
        VALUES (${projectId},${featureGeneration},${featureGeneration},${EXTRACTOR_VERSION},'succeeded',now()+interval '1 hour')`;
    }
    for (const id of [...own, foreign]) {
      const projectId = id === foreign ? foreignProject : project;
      const canvas = randomUUID(), job = randomUUID(), artifact = randomUUID(), node = randomUUID(), jobNode = randomUUID(), event = randomUUID();
      const payload = { title: "跨任务历史相似文本", summary: "Historical matching text retains independently verified evidence across a durable candidate upgrade.", profile: "general" };
      await db`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${projectId},'historical task')`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${job},${projectId},${canvas},'audit','succeeded',${db.json({ source_version: "historical-version" })})`;
      await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status) VALUES
        (${jobNode},${canvas},${job},'intent','historical job','succeeded'),(${node},${canvas},${job},'finding',${payload.title},'confirmed')`;
      await db`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type) VALUES (${canvas},${jobNode},${node},'produces')`;
      await db`INSERT INTO artifacts(id,project_id,canvas_id,job_id,node_id,artifact_key,kind,source_operation,source_event_id)
        VALUES (${artifact},${projectId},${canvas},${job},${node},${`finding:${job}:source`},'general','emit_finding',${event})`;
      await db`INSERT INTO artifact_claims(artifact_id,statement) VALUES (${artifact},${payload.summary})`;
      await db`INSERT INTO artifact_evidence(artifact_id,statement,uri,polarity) VALUES (${artifact},'historical evidence','src/source.ts:17','supports')`;
      await db`INSERT INTO findings(id,project_id,job_id,artifact_id,node_id,fingerprint,source_digest,title,summary,profile,location,evidence_refs_json,verify_status,disposition)
        VALUES (${id},${projectId},${job},${artifact},${node},'source',${`v1:${'7'.repeat(64)}`},${payload.title},${payload.summary},'general','src/source.ts:17',${db.json(['src/source.ts:17'])},'confirmed','resolved')`;
      await db`INSERT INTO finding_verification_rounds(finding_id,attempt,status,final_outcome,evidence_snapshot_json)
        VALUES (${id},1,'confirmed','confirmed',${db.json({ artifact_id: artifact, finding_id: id })})`;
      await db`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES (${job},${event},1,'finding',${db.json(payload)})`;
      await db`INSERT INTO event_dedup(event_id,job_id) VALUES (${event},${job})`;
      const input = (await loadFeatureSource(db, id))!;
      await db`INSERT INTO project_finding_features(finding_id,project_id,generation,extractor_version,input_digest,features_json)
        VALUES (${id},${projectId},${featureGeneration},${EXTRACTOR_VERSION},${sourceInputDigest(input)},${db.json(extractFindingFeatures(input) as never)})`;
    }
    const history = await captureHistory(db);
    process.env.DATABASE_URL = targetUrl.toString();
    const reserve = () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>;
    const plan = await rebuildSchemaOnReservedSession(reserve, { mode: "plan", terminateScheduler: false });
    assert.equal(plan.plan.currentVersion, 64);
    assert.equal(plan.plan.targetVersion, SCHEMA_VERSION);
    assert.deepEqual([...plan.plan.newTables].sort(), [...NEW_TABLES].sort());
    assert.equal(plan.applied, false);
    await assertNoCandidates(db);
    assert.deepEqual(await captureHistory(db), history);
    const rebuilt = await rebuildSchemaOnReservedSession(reserve, { mode: "apply", dumpDir, keepStaging: true, terminateScheduler: false });
    assert.equal(rebuilt.applied, true);
    assert.ok(rebuilt.dumpPath, "a real backup file is mandatory");
    assert.equal(readFileSync(rebuilt.dumpPath).subarray(0, 5).toString(), "PGDMP");
    restoreFindingSourceBackup(backupUrl, rebuilt.dumpPath);
    assert.equal((await backup`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 64);
    await assertNoCandidates(backup);
    assert.deepEqual(await captureHistory(backup), history, "actual v64 backup preserves source and C generation history");
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION);
    assert.deepEqual(await captureHistory(db), history);
    assert.equal((await db`SELECT indisunique FROM pg_index WHERE indexrelid='findings_project_scan_idx'::regclass`)[0].indisunique, true);
    for (const name of [...NEW_TABLES, ...CANDIDATE_INDEXES]) {
      assert.equal((await db`SELECT to_regclass(${'public.' + name})::text AS name`)[0].name, name);
    }
    assert.deepEqual((await db`SELECT id,cursor_id FROM project_finding_candidate_scan`).map(row => ({ ...row })), [{ id: "global", cursor_id: null }]);
    for (const name of NEW_TABLES.filter(name => !name.endsWith("_scan"))) {
      assert.equal(Number((await db.unsafe(`SELECT count(*) AS n FROM ${name}`))[0].n), 0);
    }
    await assertCandidateConstraints(db, project, own, foreign);
    assert.deepEqual(await captureHistory(db), history, "constraint/cascade probes leave all historical rows intact");
    const { processCandidateBatch, requestCandidateRebuild } = await import("./domains/project-finding-research/candidate-store.js");
    const { readCandidatePage } = await import("./domains/project-finding-research/candidate-read.js");
    const build = async () => {
      await db.begin(tx => requestCandidateRebuild(project, tx));
      for (let tick = 0; tick < 8; tick++) {
        await processCandidateBatch(db);
        const [work] = await db`SELECT status,error_code FROM project_finding_candidate_work WHERE project_id=${project}`;
        if (work?.status === "succeeded") return;
        assert.notEqual(work?.status, "failed", "candidate fixture computation must succeed");
      }
      assert.fail("isolated candidate fixture did not finish within eight bounded batches");
    };
    const derivedContent = async () => {
      const sources = await db`SELECT to_jsonb(s) - 'generation' - 'processed_at' AS row
        FROM project_finding_candidate_sources s WHERE project_id=${project} ORDER BY finding_id`;
      const edges = await db`SELECT to_jsonb(e) - 'generation' - 'processed_at' AS row
        FROM project_finding_candidate_edges e WHERE project_id=${project} ORDER BY left_id,right_id`;
      return { sources: sources.map(row => row.row), edges: edges.map(row => row.row) };
    };
    await build();
    const firstPage = await readCandidatePage(own[0], undefined, db, project);
    assert.equal(firstPage?.status, "succeeded");
    assert.deepEqual(firstPage?.items.map(item => item.finding_id), [own[1]]);
    const first = await derivedContent();
    assert.equal(first.sources.length, 2);
    assert.equal(first.edges.length, 1, "both directional submissions share one canonical pair");
    assert.deepEqual(await captureHistory(db), history, "candidate processing must not rewrite source or C history");
    await db`DELETE FROM project_finding_candidate_edges WHERE project_id=${project}`;
    await db`DELETE FROM project_finding_candidate_sources WHERE project_id=${project}`;
    await build();
    const secondPage = await readCandidatePage(own[0], undefined, db, project);
    assert.equal(secondPage?.status, "succeeded");
    assert.notEqual(secondPage?.active_generation, firstPage?.active_generation);
    assert.deepEqual(await derivedContent(), first, "derived candidates rebuild deterministically under a new generation");
    assert.deepEqual(await captureHistory(db), history);

  } finally {
    await db.end(); await backup.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${targetName}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${backupName}"`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    rmSync(dumpDir, { recursive: true, force: true });
  }
}
