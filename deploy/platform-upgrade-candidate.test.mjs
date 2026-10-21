import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCandidateManager} from './platform-upgrade-candidate.mjs';
const operationId = 'a'.repeat(32);
const digest = 'b'.repeat(64);
function fixture(overrides = {}) {
  const calls = [];
  const manager = createCandidateManager({operationId, sourceDatabase: 'deepsonar',
    verifyFence: async () => ({ok: true, operation_id: operationId, source_database: 'deepsonar', epoch: 3, activation: 'inactive', candidate_writes_blocked: true}),
    verifyBackup: async () => ({ok: true, operation_id: operationId, source_database: 'deepsonar', fence_epoch: 3, sha256: digest}),
    runSql: async args => {calls.push(args); return args.sql.startsWith('SELECT shobj_description') ? [{marker: JSON.stringify({operation_id: operationId, source_database: 'deepsonar', backup_sha256: digest, phase: 'restored'})}] : args.database === 'postgres' ? [] : [{claims_paused: true}];},
    runRestore: async args => {calls.push(args);}, runTargetCli: async args => {calls.push(args); return {ok: true, plan: {target_sql_sha256: digest}};}, ...overrides});
  return {manager, calls};
}
test('restore writes only candidate and revokes public connections before restore', async () => {
  const {manager, calls} = fixture();
  await manager.restore('backup');
  assert.match(calls[1].sql, /^CREATE DATABASE "ds_upgrade_/);
  assert.match(calls[3].sql, /^REVOKE CONNECT/);
  assert.deepEqual(calls[4].options, ['--exit-on-error', '--no-owner', '--no-privileges']);
  assert.equal(calls.some(call => call.database === 'deepsonar'), false);
  assert.equal(calls.some(call => /DROP/.test(call.sql ?? '')), false);
});
test('wrong epoch or missing fence prevents candidate creation', async () => {
  for (const overrides of [{verifyFence: async () => ({ok: false})}, {verifyBackup: async () => ({ok: true, fence_epoch: 2})}]) {
    const {manager, calls} = fixture(overrides);
    await assert.rejects(manager.restore('backup'));
    assert.deepEqual(calls, []);
  }
});
test('unmarked existing candidate is retained and a fresh owned name is allocated', async () => {
  const calls = [];
  const {manager} = fixture({runSql: async args => {calls.push(args); return args.sql.startsWith('SELECT datname') ? [{datname: 'ds_upgrade_' + operationId, marker: null}] : [{claims_paused: true}];}});
  await manager.restore('backup');
  assert.equal(manager.database, 'ds_upgrade_' + operationId + '00000001');
  assert.equal(calls.some(call => /DROP/.test(call.sql)), false);
});
test('restore failure never executes drop or source restore', async () => {
  const {manager, calls} = fixture({runRestore: async () => {throw new Error('restore interrupted');}});
  await assert.rejects(manager.restore('backup'), /interrupted/);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(call => /DROP/.test(call.sql ?? '')), false);
});
test('apply requires explicit approval and binds verified backup', async () => {
  const {manager, calls} = fixture();
  await assert.rejects(manager.apply('backup'), /approved plan/);
  await manager.apply('backup', digest);
  assert.deepEqual(calls.find(call => call.action === 'apply'), {action: 'apply', candidate_database: manager.database, expected_plan_hash: digest, verified_backup_sha256: digest, reset_role_identity: false});
});
test('owned interrupted restore may be recreated without touching source', async () => {
  const calls = [], database = 'ds_upgrade_' + operationId;
  const marker = JSON.stringify({operation_id: operationId, source_database: 'deepsonar', backup_sha256: digest, phase: 'restoring'});
  const {manager} = fixture({runSql: async args => {calls.push(args); return args.sql.startsWith('SELECT datname') ? [{datname: database, marker}] : [{claims_paused: true}];}});
  await manager.restore('backup');
  assert.deepEqual(calls.filter(call => call.sql.startsWith('DROP')).map(call => call.sql), [`DROP DATABASE "${database}"`]);
});
test('restored receipt resumes without recreating or restoring candidate', async () => {
  const calls = [], database = 'ds_upgrade_' + operationId;
  const marker = JSON.stringify({operation_id: operationId, source_database: 'deepsonar', backup_sha256: digest, phase: 'restored'});
  const {manager} = fixture({runSql: async args => {calls.push(args); return args.sql.startsWith('SELECT datname') ? [{datname: database, marker}] : [{claims_paused: true}];}, runRestore: async () => {assert.fail('must not restore again');}});
  await manager.restore('backup');
  assert.equal(calls.length, 2);
});
test('a prior generation candidate is accepted as the next source', () => {
  const {manager} = fixture({sourceDatabase: 'ds_upgrade_' + 'f'.repeat(32)});
  assert.equal(manager.database, 'ds_upgrade_' + operationId);
});
test('interrupted rebuild cannot destroy a candidate with uncertain activation or writable runtime', async () => {
  const marker = JSON.stringify({operation_id: operationId, source_database: 'deepsonar', backup_sha256: digest, phase: 'rebuilding'});
  for (const evidence of [{activation: 'unknown', candidate_writes_blocked: true}, {activation: 'inactive', candidate_writes_blocked: false}]) {
    const calls = [];
    const {manager} = fixture({verifyFence: async () => ({ok: true, operation_id: operationId, source_database: 'deepsonar', epoch: 3, ...evidence}),
      runSql: async args => {calls.push(args); return [{datname: 'ds_upgrade_' + operationId, marker}];}});
    await assert.rejects(manager.restore('backup'), /write fence/);
    assert.equal(calls.some(call => /DROP/.test(call.sql)), false);
  }
});
test('rebuilt candidate verifies target evidence and does not run destructive apply again', async () => {
  const calls = [];
  const marker = JSON.stringify({operation_id: operationId, source_database: 'deepsonar', backup_sha256: digest, phase: 'rebuilt', plan_hash: digest, target_sql_sha256: digest, reset_role_identity: false});
  const {manager} = fixture({runSql: async () => [{marker}], runTargetCli: async args => {calls.push(args); return {ok: true, plan: {source_schema_version: 61, target_schema_version: 61, target_sql_sha256: digest, claims_paused: true}};}});
  const result = await manager.apply('backup', digest);
  assert.equal(result.resumed, true);
  assert.equal(result.plan_hash, digest);
  assert.deepEqual(calls.map(call => call.action), ['plan']);
});
