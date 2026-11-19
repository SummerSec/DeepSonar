import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {durablePrivateWrite} from './platform-upgrade-filesystem.mjs';
import {runHostGenerationPrune} from './platform-upgrade-prune-host.mjs';
import {withUpgradeLock} from './platform-upgrade-lock.mjs';

const enabled = process.env.DEEPSONAR_FENCE_PG_TEST === '1';
test('normal prune host with isolated PostgreSQL, retained recovery source, audit and lost DROP response', {skip: !enabled}, async t => {
  const name = `pr1124-gc-${randomBytes(8).toString('hex')}`;
  const directory = await mkdtemp(join(tmpdir(), 'generation-gc-'));
  const recovery = join(directory, '.upgrade');
  const docker = (args, input) => execFileSync('docker', args, {input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000});
  const sql = (database, statement) => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'maintenance', '-d', database], statement).trim();
  const json = (database, statement) => JSON.parse(sql(database, statement));
  let created = false, session;
  t.after(async () => {if (session && session.exitCode === null) session.kill(); if (created) docker(['rm', '-f', name]); await rm(directory, {recursive: true, force: true});});
  docker(['run', '-d', '--name', name, '--label', `deepsonar.test=${name}`, '-e', 'POSTGRES_USER=maintenance', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine']);
  created = true;
  for (let i = 0; i < 100; i++) {
    try {sql('postgres', 'SELECT 1'); break;} catch {if (i === 99) throw Error('fixture PostgreSQL did not start'); await new Promise(done => setTimeout(done, 100));}
  }
  const clusterId = sql('postgres', 'SELECT system_identifier::text FROM pg_control_system()');
  const generations = ['1', '2', '3', '4'].map(digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`);
  const databases = generations.map(generation => `ds_upgrade_${generation.replaceAll('-', '')}`);
  databases[0] += '00000001';
  const binding = {root: directory, projectName: 'fixture', postgresStorageHash: 'storage', dockerIdentity: 'docker'};
  const bindingHash = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  await durablePrivateWrite(join(recovery, 'cluster-admin.json'), JSON.stringify({clusterId, operationId: generations[0], admin: {role: 'maintenance', password: 'fixture-only'}}));
  sql('postgres', `COMMENT ON ROLE maintenance IS 'deepsonar-upgrade:${generations[0]}';`);
  for (let i = 0; i < generations.length; i++) {
    const generation = generations[i], database = databases[i], source = databases[i - 1] ?? 'deepsonar';
    const marker = JSON.stringify({operation_id: generation.replaceAll('-', ''), source_database: source, backup_sha256: 'a'.repeat(64), phase: 'rebuilt'});
    sql('postgres', `CREATE DATABASE "${database}" TEMPLATE template0;`);
    sql('postgres', `COMMENT ON DATABASE "${database}" IS '${marker}'; REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC;
CREATE ROLE runtime_${i} NOLOGIN; COMMENT ON ROLE runtime_${i} IS 'deepsonar-upgrade:${generation}:runtime:${database}';
GRANT CONNECT ON DATABASE "${database}" TO runtime_${i};`);
    sql(database, `CREATE TABLE platform_upgrade_state(id text, phase text, generation text, runtime_role text);
INSERT INTO platform_upgrade_state VALUES('global','active','${generation}','runtime_${i}');
CREATE TABLE audit_logs(actor_type text,actor_id text,action text,resource_type text,resource_id text,request_id text,after_json jsonb);`);
    const operation = generation.replaceAll('-', '');
    const state = {schema: 'deepsonar.maintenance-upgrade/v1', generation, status: 'complete', binding, receipts: {
      backup: {sha256: 'a'.repeat(64), operation_id: operation, source_database: source, fence_epoch: generation},
      candidate: {database, operation_id: operation, backup_sha256: 'a'.repeat(64), fence_epoch: generation}}};
    await durablePrivateWrite(join(recovery, i === 3 ? 'maintenance.json' : `maintenance-${generation}.completed.json`), JSON.stringify(state));
    await durablePrivateWrite(join(recovery, `identity-${generation}.json`), JSON.stringify({generation, bindingHash, clusterId,
      source: {database: source}, candidateDatabase: database, runtime: {role: `runtime_${i}`}, rollbackRuntime: {role: `rollback_${i}`}}));
  }
  const current = databases[3];
  let lost = false, finalAuditFailed = false;
  const transport = {rows: async ({database, sql: statement}) => {
    if (statement.startsWith('DROP DATABASE')) {
      sql(database, statement);
      if (!lost) {lost = true; throw Error('fixture lost committed DROP response');}
      return [];
    }
    if (statement.startsWith('INSERT INTO audit_logs')) {
      if (!finalAuditFailed && statement.includes("'platform_upgrade.generation_pruned'")) {
        finalAuditFailed = true; throw Error('fixture final audit unavailable');
      }
      sql(database, statement); return [];
    }
    return json(database, `SELECT coalesce(json_agg(t),'[]'::json) FROM (${statement}) t`);
  }};
  let runtimeReferences = [current];
  const options = {recovery, binding: async () => binding, runtimeDatabases: async () => runtimeReferences,
    source: async () => ({database: current, port: 5432, values: {DEEPSONAR_SCHEDULER_IMAGE: 'fixture'}}), transport};
  const run = extra => withUpgradeLock(join(recovery, 'upgrade.lock'), () => runHostGenerationPrune({...options, ...extra}));
  const preview = await run();
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.candidates.map(row => row.name), databases.slice(0, 2));
  assert.equal(json('postgres', `SELECT count(*)::int FROM pg_database WHERE datname LIKE 'ds_upgrade_%'`)[0].count, 4);
  assert.equal(json(current, 'SELECT count(*)::int FROM audit_logs')[0].count, 0);
  await assert.rejects(run({apply: true}), /PRUNE_PLAN_APPROVAL_REQUIRED/);
  runtimeReferences = [current, databases[0]];
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /PRUNE_ELIGIBILITY_CHANGED/);
  runtimeReferences = [current];
  sql('postgres', `CREATE ROLE foreign_reader NOLOGIN; GRANT CONNECT ON DATABASE "${databases[0]}" TO foreign_reader;`);
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /PRUNE_ELIGIBILITY_CHANGED/);
  sql('postgres', `REVOKE CONNECT ON DATABASE "${databases[0]}" FROM foreign_reader; DROP ROLE foreign_reader;`);
  // A live session added after preview invalidates apply without evicting it.
  session = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'maintenance', '-d', databases[0]], {stdio: ['pipe', 'pipe', 'pipe']});
  session.stdin.end('SELECT pg_sleep(30);');
  for (let i = 0; i < 100; i++) {
    if (json('postgres', `SELECT count(*)::int FROM pg_stat_activity WHERE datname='${databases[0]}'`)[0].count > 0) break;
    await new Promise(done => setTimeout(done, 50));
  }
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /PRUNE_ELIGIBILITY_CHANGED/);
  assert.equal(session.exitCode, null);
  // Only the fixture's own connection is ended, outside the implementation.
  sql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${databases[0]}';`);
  for (let i = 0; i < 100; i++) {
    if (json('postgres', `SELECT count(*)::int FROM pg_stat_activity WHERE datname='${databases[0]}'`)[0].count === 0) break;
    await new Promise(done => setTimeout(done, 50));
  }
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /PRUNE_DROP_UNCERTAIN/);
  await assert.rejects(run(), /PRUNE_PLAN_RECOVERY_REQUIRED/);
  const replacement = databases[0];
  sql('postgres', `CREATE DATABASE "${replacement}" TEMPLATE template0;`);
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /PRUNE_DATABASE_IDENTITY_CHANGED/);
  sql('postgres', `DROP DATABASE "${replacement}";`);
  await assert.rejects(run({apply: true, approvedPlanHash: preview.plan_hash}), /fixture final audit unavailable/);
  await assert.rejects(run(), /PRUNE_PLAN_RECOVERY_REQUIRED/);
  const result = await run({apply: true, approvedPlanHash: preview.plan_hash});
  assert.equal(result.dropped.length, 2);
  assert.equal(result.dropped[0].reconciled, true);
  assert.deepEqual(json('postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'ds_upgrade_%' ORDER BY datname").map(row => row.datname), databases.slice(2));
  assert.equal(json(current, "SELECT count(*)::int FROM audit_logs WHERE action='platform_upgrade.generation_pruned'")[0].count, 2);
  assert.equal((await readFile(join(recovery, 'generation-prune-plan.json'), 'utf8')).includes('fixture-only'), false);
});
