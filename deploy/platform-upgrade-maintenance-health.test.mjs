import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMaintenanceWeb, assertMaintenanceDatabase, assertRollbackConnection, assertRollbackDatabase} from './platform-upgrade-maintenance-health.mjs';
test('web verification requires internal and explicitly configured external HTTP success', async () => {
  let internal = false, external = false;
  await verifyMaintenanceWeb({dc: args => {internal = args.includes('web');}, webUrl: 'http://127.0.0.1:18888/', request: async (_url, options) => {external = true; assert.equal(options.redirect, 'error'); return {ok: true};}});
  assert.equal(internal && external, true);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {}, webUrl: 'https://example.test', request: async () => ({ok: false})}), /verification failed/);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {throw new Error('web stopped');}}), /web stopped/);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {}, webUrl: 'http://public.example.test'}), /HTTPS or loopback/);
});
test('rollback success requires the exact source connection and fresh DML identity', () => {
  const saved = {source: {database: 'source', port: 5432}, rollbackRuntime: {role: 'replacement', password: 'private'}};
  const actual = {role: 'replacement', password: 'private', database: 'source', port: 5432};
  assert.doesNotThrow(() => assertRollbackConnection(actual, saved));
  for (const key of Object.keys(actual)) assert.throws(() => assertRollbackConnection({...actual, [key]: 'changed'}, saved), /connection mismatch/);
});
test('legacy and maintenance source verification rejects stale schema, pause, role and generation', () => {
  const state = {plan: {source_schema_version: 61}}, saved = {rollbackGeneration: 'new-generation', rollbackRuntime: {role: 'replacement'}, source: {values: {DEEPSONAR_VERSION: '1.0.0'}}};
  const row = {schema_version: 61, claims_paused: false, old_role_login: false, runtime_login: true, runtime_superuser: false,
    phase: 'active', generation: 'new-generation', runtime_role: 'replacement', target_version: '1.0.0'};
  for (const maintenance of [false, true]) {
    const options = {state, saved, preparing: false, maintenance};
    assert.doesNotThrow(() => assertRollbackDatabase(row, options));
    for (const key of ['schema_version', 'claims_paused', 'old_role_login', 'runtime_login', 'runtime_superuser', ...(maintenance ? ['phase', 'generation', 'runtime_role', 'target_version'] : [])]) {
      assert.throws(() => assertRollbackDatabase({...row, [key]: 'wrong'}, options));
    }
  }
});
test('target readiness checks exact schema, DB identity, phase and claims atomically', () => {
  const state = {generation: 'generation', target: {schema_version: 61, version: '2.0.0'}}, saved = {runtime: {role: 'candidate_role'}};
  const row = {schema_version: 61, phase: 'preparing', generation: state.generation, runtime_role: saved.runtime.role, target_version: '2.0.0', claims_paused: true};
  assert.doesNotThrow(() => assertMaintenanceDatabase(row, {state, saved, phase: 'preparing'}));
  for (const key of Object.keys(row)) assert.throws(() => assertMaintenanceDatabase({...row, [key]: 'wrong'}, {state, saved, phase: 'preparing'}));
  assert.throws(() => assertMaintenanceDatabase(row, {state, saved, phase: 'active'}));
});
