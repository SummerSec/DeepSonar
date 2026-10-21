import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {maintenanceHostAdapter} from './platform-upgrade-maintenance-host.mjs';
import {durablePrivateWrite} from './platform-upgrade-maintenance-transport.mjs';

test('exported database overrides are rejected before any deployment operation', () => {
  for (const key of ['DEEPSONAR_DATABASE_USER', 'DEEPSONAR_DATABASE_PASSWORD', 'DEEPSONAR_DATABASE_NAME', 'DEEPSONAR_UPGRADE_GENERATION']) {
    const previous = process.env[key];
    try {
      process.env[key] = 'old-value';
      assert.throws(() => maintenanceHostAdapter({run: () => {throw new Error('unexpected Docker execution');}}), /unset deployment database\/generation overrides/);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
});

test('source planning rejects duplicate and noncanonical database assignments before Docker execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-source-env-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let calls = 0;
  const io = maintenanceHostAdapter({directory, parsePlatformValues: () => ({}), run: () => {calls++; throw new Error('unexpected Docker execution');}});
  for (const key of ['DEEPSONAR_DATABASE_USER', 'DEEPSONAR_DATABASE_PASSWORD', 'DEEPSONAR_DATABASE_NAME', 'DEEPSONAR_UPGRADE_GENERATION']) {
    for (const contents of [`${key}=first\n${key}=second\n`, `export ${key}=value\n`, ` ${key}=value\n`, `${key} =value\n`, `${key}: value\n`]) {
      await writeFile(join(directory, '.env'), contents);
      await assert.rejects(io.plan({version: '2.0.0'}, {recovery: true}), /ambiguous deployment database configuration/);
    }
  }
  assert.equal(calls, 0);
});

test('source planning decodes Compose dollar escaping exactly once before passing credentials on stdin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-source-dollar-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await writeFile(join(directory, '.env'), 'DEEPSONAR_DATABASE_PASSWORD=p$a$$word\n');
  let received;
  const run = (args, input) => {
    assert.equal(args.some(arg => arg.includes('p$a$$word')), false);
    if (args.includes('config')) return Buffer.from(JSON.stringify({services: {scheduler: {environment: {DATABASE_URL: 'postgres://deepsonar:p$$a$$$$word@postgres:5432/deepsonar'}}, postgres: {}}}));
    if (args.includes('ps')) return Buffer.from('a'.repeat(64));
    if (args.includes('inspect')) return Buffer.from('bridge');
    if (args.includes('/app/apps/scheduler/dist/platform-upgrade-schema-cli.js')) {
      received = JSON.parse(input).connection;
      throw new Error('fixture reached readonly schema planning');
    }
    if (args.includes('--network=none')) return Buffer.from('b'.repeat(64));
    throw new Error('unexpected Docker operation');
  };
  const io = maintenanceHostAdapter({directory, run, parsePlatformValues: () => ({DEEPSONAR_SCHEDULER_IMAGE: 'source-image'})});
  await assert.rejects(io.plan({version: '2.0.0', values: {DEEPSONAR_SCHEDULER_IMAGE: 'target-image'}}, {recovery: true}), /fixture reached readonly schema planning/);
  assert.deepEqual(received, {host: '127.0.0.1', port: 5432, username: 'deepsonar', password: 'p$a$$word', database: 'deepsonar'});
});

test('host refuses changed same-version source database after a lost rollback activation response before starting services', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-resume-binding-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const state = {generation: '11111111-1111-4111-8111-111111111111', binding: {}, status: 'rollback_resuming', receipts: {}, target: {version: '2.0.0', values: {DEEPSONAR_SCHEDULER_IMAGE: 'target'}}};
  const saved = {generation: state.generation, bindingHash: createHash('sha256').update('{}').digest('hex'),
    source: {database: 'source', port: 5432, values: {DEEPSONAR_VERSION: '1.0.0'}}, admin: {role: 'admin', password: 'private'},
    rollbackRuntime: {role: 'replacement', password: 'private'}, rollbackGeneration: 'rollback-generation', inventory: {nodes: []}, registeredWorkerIds: []};
  await durablePrivateWrite(join(directory, '.upgrade', `identity-${state.generation}.json`), JSON.stringify(saved));
  await writeFile(join(directory, '.env'), 'DEEPSONAR_DATABASE_NAME=another\n');
  let started = false;
  const run = (args, input) => {
    if (args.includes('up')) {started = true; throw new Error('unexpected service start');}
    if (args.includes('config')) return Buffer.from(JSON.stringify({services: {scheduler: {environment: {DATABASE_URL: 'postgres://replacement:private@postgres:5432/another'}}, postgres: {}}}));
    if (args.includes('ps')) return Buffer.from('a'.repeat(64));
    if (args.includes('inspect')) return Buffer.from('bridge');
    if (input && JSON.parse(input).sql.includes('shobj_description')) return Buffer.from(JSON.stringify([{value: JSON.stringify({schema: 'deepsonar.rollback-activation/v1', operation_generation: state.generation, runtime_role: 'replacement', active: true, generation: saved.rollbackGeneration})}]));
    throw new Error('unexpected operation');
  };
  const io = maintenanceHostAdapter({directory, run, parsePlatformValues: () => ({DEEPSONAR_VERSION: '1.0.0'})});
  await assert.rejects(io.resumeRollback(state), /rollback source database connection mismatch/);
  assert.equal(started, false);
  assert.equal(state.status, 'rollback_resuming');
});
async function probe(t, {row, runtimeExists = true, exists = true, table = true, claims, scans = 0}) {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-authority-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const state = {generation: '11111111-1111-4111-8111-111111111111', binding: {fixture: true}, target: {version: '2.0.0', values: {DEEPSONAR_SCHEDULER_IMAGE: 'trusted-image'}}};
  const saved = {generation: state.generation, bindingHash: createHash('sha256').update(JSON.stringify(state.binding)).digest('hex'),
    admin: {role: 'admin', password: 'x'.repeat(64)}, source: {role: 'retired', password: 'hidden', database: 'source'}, candidateDatabase: 'candidate', runtime: {role: 'new_runtime'}, rollbackRuntime: {role: 'rollback_runtime'}};
  await durablePrivateWrite(join(directory, '.upgrade', `identity-${state.generation}.json`), JSON.stringify(saved));
  const calls = [];
  const run = (args, input) => {
    calls.push({args, input});
    if (args.includes('ps')) return Buffer.from('a'.repeat(64));
    const {sql} = JSON.parse(input);
    if (sql.includes("'claims_paused'")) return Buffer.from(JSON.stringify([{value: claims}]));
    if (sql.includes('FROM runtime_image_scans')) return Buffer.from(JSON.stringify([{value: scans}]));
    if (sql.includes('SELECT rolcanlogin')) return Buffer.from('[{"value":true}]');
    if (sql.includes('shobj_description')) return Buffer.from('[{"value":null}]');
    if (sql.includes('EXISTS(SELECT 1 FROM pg_database')) return Buffer.from(JSON.stringify([{value: exists}]));
    if (sql.includes('to_regclass')) return Buffer.from(JSON.stringify([{value: table}]));
    if (sql.includes('EXISTS(SELECT 1 FROM pg_roles')) return Buffer.from(JSON.stringify([{value: runtimeExists}]));
    if (sql.includes('SELECT phase,generation')) return Buffer.from(JSON.stringify(row ? [row] : []));
    throw new Error('unrecognized query');
  };
  return {io: maintenanceHostAdapter({directory, run}), state, calls};
}
test('only exact authoritative active identity proves target activation', async t => {
  const {io, state} = await probe(t, {row: {phase: 'active', generation: '11111111-1111-4111-8111-111111111111', runtime_role: 'new_runtime', target_version: '2.0.0'}});
  assert.equal((await io.inspectActivation(state)).status, 'active');
});
test('foreign active generation with an existing candidate role is uncertain, never rollback authority', async t => {
  const {io, state} = await probe(t, {row: {phase: 'active', generation: 'foreign', runtime_role: 'new_runtime', target_version: '2.0.0'}});
  assert.equal((await io.inspectActivation(state)).status, 'unknown');
});
test('lost candidate database or state table after identity creation is uncertain', async t => {
  for (const flags of [{exists: false}, {table: false}]) {
    const {io, state} = await probe(t, flags);
    assert.equal((await io.inspectActivation(state)).status, 'unknown');
  }
});
test('restored source generation cannot have served target writes before candidate identity existed', async t => {
  const {io, state} = await probe(t, {runtimeExists: false, row: {phase: 'active', generation: 'source-generation', runtime_role: 'source_runtime', target_version: '1.0.0'}});
  assert.equal((await io.inspectActivation(state)).status, 'inactive');
});
test('unsettled long job or unknown effect preserves old containers and LOGIN identity during recovery', async t => {
  for (const pending of [{in_flight: {total: 1}, unknown_effect_attempts: 0}, {in_flight: {total: 0}, unknown_effect_attempts: 1}, {in_flight: {total: 0}, unknown_effect_attempts: 0, effect_pending_attempts: 1}, {in_flight: {total: 0}, unknown_effect_attempts: 0, scans: 1}]) {
    const claims = {claims_paused: true, reason: 'platform_upgrade', drained: true, effect_pending_attempts: 0, ...pending};
    const {io, state, calls} = await probe(t, {claims, scans: pending.scans ?? 0}); state.receipts = {};
    const result = await io.rollbackPreparing(state);
    assert.equal(result.awaiting_drain, true); assert.equal(result.services_unchanged, true);
    assert.equal(calls.some(call => call.args.includes('stop')), false);
    assert.equal(calls.some(call => call.input && /ALTER ROLE|pg_terminate_backend/.test(JSON.parse(call.input).sql)), false);
  }
});
