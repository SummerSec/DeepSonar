import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeRollback} from './platform-upgrade-maintenance-recovery.mjs';
import {assertRollbackConnection} from './platform-upgrade-maintenance-health.mjs';
function fixture() {
  let comment = null;
  const calls = [], state = {generation: 'original-generation', status: 'rolled_back', receipts: {}}, saved = {source: {database: 'source', values: {DEEPSONAR_VERSION: '1.0.0'}}, rollbackRuntime: {role: 'new_role'}, inventory: {nodes: []}, workerToken: 'token'};
  const io = {state, saved,
    scalar: async ({sql}) => sql.includes('shobj_description') ? comment : sql.includes('to_regclass') ? false : true,
    rows: async ({sql}) => {calls.push('commit'); const match = sql.match(/IS '(\{.*\})'; COMMIT;/); comment = match[1];},
    saveJournal: async value => {calls.push(value.status); Object.assign(state, value);}, saveSecrets: async () => calls.push('saveSecrets'),
    configure: async () => calls.push('configure'), start: async () => calls.push('start'), verify: async () => calls.push('verify'),
    inspectCandidate: async () => ({status: 'inactive'}),
  };
  return {io, calls, getComment: () => comment};
}
test('rollback resumption records an atomic DB activation before starting old business services', async () => {
  const {io, calls, getComment} = fixture();
  assert.equal((await resumeRollback(io)).status, 'rollback_resumed');
  assert.ok(calls.indexOf('commit') < calls.indexOf('start'));
  assert.ok(calls.indexOf('rollback_resuming') < calls.indexOf('commit'));
  assert.equal(JSON.parse(getComment()).runtime_role, 'new_role');
  assert.equal(io.state.status, 'rollback_resumed');
});
test('lost post-activation response resumes forward and never executes source activation twice', async () => {
  const {io, calls} = fixture(); let failed = false;
  io.start = async () => {calls.push('start'); if (!failed) {failed = true; throw new Error('lost response');}};
  await assert.rejects(resumeRollback(io), /lost response/);
  assert.equal(io.state.status, 'rollback_resuming');
  assert.equal((await resumeRollback(io)).status, 'rollback_resumed');
  assert.equal(calls.filter(value => value === 'commit').length, 1);
});
test('lost activation response plus changed same-version database cannot complete rollback recovery', async () => {
  const {io, calls} = fixture();
  io.saved.source.port = 5432; io.saved.rollbackRuntime.password = 'private';
  io.start = async () => {throw new Error('lost response');};
  await assert.rejects(resumeRollback(io), /lost response/);
  io.start = async () => assertRollbackConnection({role: 'new_role', password: 'private', database: 'another_same_version_database', port: 5432}, io.saved);
  await assert.rejects(resumeRollback(io), /connection mismatch/);
  assert.equal(io.state.status, 'rollback_resuming');
  assert.equal(calls.includes('verify'), false);
  assert.equal(calls.filter(value => value === 'commit').length, 1);
});
test('unknown/active target authority never unlocks source writes', async () => {
  for (const status of ['unknown', 'active']) {
    const {io, calls} = fixture(); io.inspectCandidate = async () => ({status});
    await assert.rejects(resumeRollback(io), /active or uncertain/);
    assert.deepEqual(calls, []);
  }
});
test('old source without generation admission keeps managed nodes and source fenced', async () => {
  const {io, calls} = fixture(); io.saved.inventory.nodes.push({id: 'remote'});
  await assert.rejects(resumeRollback(io), /cannot safely resume managed nodes/);
  assert.deepEqual(calls, []);
});
test('interrupted preactivation configuration can resume while retaining the same generation', async () => {
  const {io, calls} = fixture(); let failed = false;
  io.configure = async () => {if (!failed) {failed = true; throw new Error('configuration interrupted');}};
  await assert.rejects(resumeRollback(io), /configuration interrupted/);
  assert.equal(io.state.status, 'rollback_resuming');
  const generation = io.saved.rollbackGeneration, token = io.saved.rollbackWorkerToken;
  assert.equal(calls.includes('commit'), false);
  await resumeRollback(io);
  assert.equal(io.saved.rollbackGeneration, generation);
  assert.equal(io.saved.rollbackWorkerToken, token);
  assert.equal(calls.filter(value => value === 'commit').length, 1);
});
