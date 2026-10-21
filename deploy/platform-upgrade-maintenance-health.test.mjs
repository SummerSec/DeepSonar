import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMaintenanceWeb, assertMaintenanceDatabase} from './platform-upgrade-maintenance-health.mjs';
test('web verification requires internal and explicitly configured external HTTP success', async () => {
  let internal = false, external = false;
  await verifyMaintenanceWeb({dc: args => {internal = args.includes('web');}, webUrl: 'http://127.0.0.1:18888/', request: async (_url, options) => {external = true; assert.equal(options.redirect, 'error'); return {ok: true};}});
  assert.equal(internal && external, true);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {}, webUrl: 'https://example.test', request: async () => ({ok: false})}), /verification failed/);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {throw new Error('web stopped');}}), /web stopped/);
  await assert.rejects(verifyMaintenanceWeb({dc: () => {}, webUrl: 'http://public.example.test'}), /HTTPS or loopback/);
});
test('target readiness checks exact schema, DB identity, phase and claims atomically', () => {
  const state = {generation: 'generation', target: {schema_version: 61, version: '2.0.0'}}, saved = {runtime: {role: 'candidate_role'}};
  const row = {schema_version: 61, phase: 'preparing', generation: state.generation, runtime_role: saved.runtime.role, target_version: '2.0.0', claims_paused: true};
  assert.doesNotThrow(() => assertMaintenanceDatabase(row, {state, saved, phase: 'preparing'}));
  for (const key of Object.keys(row)) assert.throws(() => assertMaintenanceDatabase({...row, [key]: 'wrong'}, {state, saved, phase: 'preparing'}));
  assert.throws(() => assertMaintenanceDatabase(row, {state, saved, phase: 'active'}));
});
