import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {maintenanceHostAdapter} from './platform-upgrade-maintenance-host.mjs';
import {durablePrivateWrite} from './platform-upgrade-maintenance-transport.mjs';
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
