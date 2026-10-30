import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test('project Finding features require isolated PostgreSQL', { skip: 'TEST_DATABASE_URL is not set' }, () => {});
} else {
  test('feature generations recover, invalidate immediately, retain source state and enforce read permissions', async () => {
    // Scheduling is project-global; unrelated suites may leave auditable project shells.
    // Use a real isolated database, never assume a fixed number of ticks on a shared queue.
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `feature_fixture_${randomUUID().replaceAll('-', '')}`;
    const target = new URL(databaseUrl); target.pathname = `/${name}`;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      await runFeatureFixture(target.toString());
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
}

async function runFeatureFixture(databaseUrl: string): Promise<void> {
    process.env.DATABASE_URL = databaseUrl;
    const [{ migrate, sql }, { processFeatureBatch, requestFeatureRebuild, readFeatureStatus, loadFeatureSource, scanFeatureProjects }, { sourceInputDigest, EXTRACTOR_VERSION }, { default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }] = await Promise.all([
      import('../../db.js'), import('./store.js'), import('./model.js'), import('fastify'), import('@fastify/websocket'), import('../../routes.js'), import('../../auth.js'),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket); registerRoutes(app); await app.ready();
    const project = randomUUID(), other = randomUUID(), canvas = randomUUID(), job = randomUUID(), artifact = randomUUID();
    const token = generateToken();
    const findingIds = Array.from({ length: 23 }, () => randomUUID()).sort();
    const sourceId = findingIds[0];
    try {
      await sql`INSERT INTO projects(id,name) VALUES (${project},'feature fixture'),(${other},'other fixture')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'feature task')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES (${job},${project},${canvas},'audit','succeeded', '{}')`;
      await sql`INSERT INTO artifacts(id,project_id,canvas_id,job_id,artifact_key,kind,source_operation)
        VALUES (${artifact},${project},${canvas},${job},'fixture','security.finding','emit_finding')`;
      await sql`INSERT INTO artifact_evidence(artifact_id,statement) VALUES (${artifact},'evidence-sensitive-never-display')`;
      for (const id of findingIds) {
        await sql`INSERT INTO findings(id,project_id,job_id,artifact_id,fingerprint,title,summary,profile,verify_status,disposition)
          VALUES (${id},${project},${job},${artifact},${id},'中文 SQL 检索','same claim','security.vulnerability','confirmed','resolved')`;
      }
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('feature-test',${project},${token.prefix},${token.hash},${['findings:read']})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const invokeCLI = (extra: string[] = []) => promisify(execFile)(process.execPath,
        ['--import','tsx',fileURLToPath(new URL('./rebuild-cli.ts',import.meta.url)),'--project-id',project,...extra],
        {cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...process.env,DATABASE_URL:databaseUrl}});
      const rebuilt=await invokeCLI();
      assert.equal(JSON.parse(rebuilt.stdout).project_id,project);
      assert.ok(!rebuilt.stdout.includes(databaseUrl!));
      const initial = await readFeatureStatus(sourceId, project);
      assert.equal(initial?.status, 'pending');
      assert.equal(await processFeatureBatch(sql, () => false), 0);
      await sql`UPDATE platform_upgrade_state SET phase='preparing',generation='77000000-0000-0000-0000-000000000099',runtime_role='postgres',target_version='0.0.1',worker_generation_token_hash=repeat('a',64) WHERE id='global'`;
      assert.equal(await processFeatureBatch(),0);
      await assert.rejects(invokeCLI(),(error: unknown)=>String((error as {stderr:string}).stderr).trim()==='FEATURE_REBUILD_MAINTENANCE_DENIED');
      await sql`UPDATE platform_upgrade_state SET phase='active',generation='',runtime_role='',target_version='',worker_generation_token_hash='' WHERE id='global'`;
      let gateChecks=0;
      await processFeatureBatch(sql,()=>++gateChecks<3);
      assert.equal((await sql`SELECT count(*)::int AS n FROM project_finding_features WHERE project_id=${project}`)[0].n,0);
      assert.equal((await sql`SELECT attempts FROM project_finding_feature_work WHERE project_id=${project}`)[0].attempts,0);
      const before = (await sql`SELECT generation FROM project_finding_feature_work WHERE project_id=${project}`)[0].generation;
      // Workers serialize checkpoints without a process-local lease; repeated calls simulate restarts.
      await Promise.all([processFeatureBatch(), processFeatureBatch()]);
      for (let n = 0; n < 5; n++) await processFeatureBatch();
      assert.equal((await readFeatureStatus(sourceId, project))?.status, 'succeeded');
      const [count] = await sql`SELECT count(*)::int AS n FROM project_finding_features WHERE project_id=${project} AND generation=${before}`;
      assert.equal(count.n, 23);
      const own = await app.inject({ method:'GET',url:`/findings/${sourceId}`,headers });
      assert.equal(own.statusCode,200,own.payload);
      assert.equal(own.json().project_research_features.authoritative_identity_fields,0);
      assert.equal(own.json().project_research_features.relationship_status,'quality_gate_not_evaluated');
      assert.ok(!JSON.stringify(own.json().project_research_features).includes('evidence-sensitive'));
      assert.equal(await readFeatureStatus(sourceId, other),null);
      // Updating source or evidence never waits for the worker to hide a previous result.
      const oldDigest = sourceInputDigest((await loadFeatureSource(sql,sourceId))!);
      await sql`UPDATE findings SET summary='changed claim' WHERE id=${sourceId}`;
      assert.notEqual(sourceInputDigest((await loadFeatureSource(sql,sourceId))!),oldDigest);
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'stale');
      await requestFeatureRebuild(project);
      const [next] = await sql`SELECT generation,active_generation FROM project_finding_feature_work WHERE project_id=${project}`;
      assert.notEqual(next.generation,before);
      assert.equal(next.active_generation,before);
      // Force only this project due to test atomic promotion across two batches.
      await sql`UPDATE project_finding_feature_work SET next_run_at=now()+interval '1 hour' WHERE project_id<>${project}`;
      await processFeatureBatch();
      assert.equal((await sql`SELECT active_generation FROM project_finding_feature_work WHERE project_id=${project}`)[0].active_generation,before);
      await processFeatureBatch();
      assert.equal((await readFeatureStatus(sourceId,project))?.generation,next.generation);
      await sql`DELETE FROM artifact_evidence WHERE artifact_id=${artifact}`;
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'stale');
      // An obsolete generation cannot be exposed as current after a rule change/rollback.
      await sql`UPDATE project_finding_features SET extractor_version='obsolete' WHERE finding_id=${sourceId}`;
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'stale');
      await sql`UPDATE project_finding_feature_work SET status='failed',attempts=3,error_code='FEATURE_EXTRACTION_FAILED' WHERE project_id=${project}`;
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'failed');
      await requestFeatureRebuild(project);
      for(let n=0;n<3;n++) await processFeatureBatch();
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'succeeded');
      // Oversized source evidence fails explicitly and exhausts a persisted retry budget.
      await sql`INSERT INTO artifact_evidence(artifact_id,ordinal,statement)
        SELECT ${artifact}::uuid,n,'bounded source' FROM generate_series(1,129) n`;
      await requestFeatureRebuild(project);
      for(let n=0;n<3;n++) {
        await sql`UPDATE project_finding_feature_work SET next_run_at=now() WHERE project_id=${project}`;
        await processFeatureBatch();
      }
      const failed=await readFeatureStatus(sourceId,project);
      assert.equal(failed?.status,'failed'); assert.equal(failed?.attempts,3);
      await sql`DELETE FROM artifact_evidence WHERE artifact_id=${artifact}`;
      await requestFeatureRebuild(project);
      await Promise.all([processFeatureBatch(),requestFeatureRebuild(project)]);
      for(let n=0;n<4;n++) await processFeatureBatch();
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'succeeded');
      const stable = await readFeatureStatus(sourceId,project);
      await sql`UPDATE project_finding_feature_work SET next_run_at=now() WHERE project_id=${project}`;
      await processFeatureBatch();
      assert.equal(String((await readFeatureStatus(sourceId,project))?.processed_at),String(stable?.processed_at));
      const removed=JSON.parse((await invokeCLI(['--prune-inactive'])).stdout).pruned_count;
      assert.ok(removed>0 && removed<=500);
      assert.equal((await readFeatureStatus(sourceId,project))?.status,'succeeded');
      const [source] = await sql`SELECT verify_status,disposition FROM findings WHERE id=${sourceId}`;
      assert.deepEqual({verify_status:source.verify_status,disposition:source.disposition},{verify_status:'confirmed',disposition:'resolved'});
      await sql`UPDATE api_tokens SET project_id=${other} WHERE token_hash=${token.hash}`;
      assert.equal((await app.inject({method:'GET',url:`/findings/${sourceId}`,headers})).statusCode,403);
      await sql`UPDATE api_tokens SET revoked_at=now() WHERE token_hash=${token.hash}`;
      assert.equal((await app.inject({method:'GET',url:`/findings/${sourceId}`,headers})).statusCode,401);
      await sql`DELETE FROM findings WHERE id=${sourceId}`;
      assert.equal(await readFeatureStatus(sourceId,project),null);
      assert.equal((await sql`SELECT count(*)::int AS n FROM project_finding_features WHERE finding_id=${sourceId}`)[0].n,0);
      await checkBoundedQueueRecovery(sql, scanFeatureProjects, processFeatureBatch, EXTRACTOR_VERSION);
    } finally {
      await sql`UPDATE platform_upgrade_state SET phase='active',generation='',runtime_role='',target_version='',worker_generation_token_hash='' WHERE id='global'`;
      await sql`DELETE FROM api_tokens WHERE token_hash=${token.hash}`;
      await sql`DELETE FROM project_finding_feature_work WHERE project_id=ANY(${[project,other]}::uuid[])`;
      await sql`DELETE FROM findings WHERE project_id=${project}`;
      await sql`DELETE FROM artifacts WHERE project_id=${project}`;
      await sql`DELETE FROM jobs WHERE project_id=${project}`;
      await sql`DELETE FROM canvases WHERE project_id=${project}`;
      // Auth denials are append-only audit evidence; leave referenced project shells.
      const {deleteProjectsLeavingAuditShells}=await import('../../test-project-teardown.js');
      await deleteProjectsLeavingAuditShells(sql,[project,other]);
      await app.close(); await sql.end({timeout:5});
    }
}


async function checkBoundedQueueRecovery(
  db: Sql,
  scan: (tx: TransactionSql) => Promise<number>,
  processBatch: () => Promise<number>,
  currentVersion: string,
): Promise<void> {
  const projects = Array.from({ length: 29 }, () => randomUUID());
  const currentFailed = projects[0], currentPending = projects[1], activeGeneration = randomUUID();
  try {
    for (const project of projects) {
      await db`INSERT INTO projects (id, name) VALUES (${project}, 'bounded queue fixture')`;
      await db`INSERT INTO project_finding_feature_work
        (project_id, extractor_version, status, attempts, cursor_id, active_generation, error_code, next_run_at)
        VALUES (${project}, ${project === currentFailed || project === currentPending ? currentVersion : 'obsolete/v0'},
          ${project === currentPending ? 'pending' : 'failed'}, ${project === currentPending ? 1 : 3}, ${randomUUID()},
          ${activeGeneration}, 'fixture_error', CASE WHEN ${project === currentPending} THEN now() + interval '1 hour' ELSE now() - interval '1 hour' END)`;
    }
    const snapshot = () => db`SELECT * FROM project_finding_feature_work WHERE project_id = ANY(${projects}::uuid[]) ORDER BY project_id`;
    const before = await snapshot();
    await db`UPDATE project_finding_feature_scan SET cursor_id = NULL WHERE id = 'global'`;
    // Losing the process before commit must lose both registration updates and its checkpoint.
    await assert.rejects(db.begin(async (tx) => { await scan(tx); throw new Error('fixture crash'); }), /fixture crash/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db`SELECT cursor_id FROM project_finding_feature_scan WHERE id='global'`)[0].cursor_id, null);
    const [firstCount, secondCount] = [await db.begin(scan), await db.begin(scan)];
    assert.equal(firstCount, 25, 'one registration call reads only the fixed project budget');
    assert.ok(secondCount > 0 && secondCount <= 25);
    const after = await snapshot();
    for (const row of after) {
      const previous = before.find((item) => item.project_id === row.project_id)!;
      if (row.project_id === currentFailed || row.project_id === currentPending) {
        assert.deepEqual(row, previous, 'current-version work must not reset status, retries, generation or cursor');
      } else {
        assert.equal(row.extractor_version, currentVersion);
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 0);
        assert.equal(row.cursor_id, null);
        assert.equal(row.error_code, null);
        assert.notEqual(row.generation, previous.generation);
        assert.equal(row.active_generation, activeGeneration, 'recovery must retain the last active generation');
      }
    }
    // Repeated complete registry passes and worker ticks cannot replenish a current failed row's budget.
    for (let index = 0; index < 4; index += 1) { await db.begin(scan); await processBatch(); }
    const [stillFailed] = await db`SELECT * FROM project_finding_feature_work WHERE project_id=${currentFailed}`;
    assert.deepEqual(stillFailed, before.find((row) => row.project_id === currentFailed));
    const [stillPending] = await db`SELECT * FROM project_finding_feature_work WHERE project_id=${currentPending}`;
    assert.deepEqual(stillPending, before.find((row) => row.project_id === currentPending));
  } finally {
    await db`DELETE FROM projects WHERE id = ANY(${projects}::uuid[])`;
    await db`UPDATE project_finding_feature_scan SET cursor_id = NULL WHERE id='global'`;
  }
}
