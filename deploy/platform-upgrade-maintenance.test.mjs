import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runMaintenanceUpgrade} from './platform-upgrade-maintenance.mjs';
const steps = ['prepareIdentity', 'pauseAndDrain', 'fence', 'backup', 'candidate', 'rebuild', 'configurePreparing', 'startPreparing', 'verifyPreparing', 'activate', 'verifyActive'];
const planHash = 'a'.repeat(64);
const options = {action: 'apply', target: '1.2.3', approvedPlanHash: planHash};
function fixture() {
  let journal = null, phase = 'inactive', activatedGeneration;
  const calls = [], effects = new Set();
  const io = {
    readJournal: async () => structuredClone(journal), writeJournal: async value => {journal = structuredClone(value);},
    deploymentBinding: async () => ({project: 'isolated', composeHash: 'fixture'}),
    resolveTarget: async () => {calls.push('resolve'); return {version: '1.2.3', digest: 'sha256:fixture'};},
    plan: async () => ({plan_hash: planHash, risks: [{code: 'DDL_CHANGE'}], blocking_errors: []}),
    inspectActivation: async () => ({status: phase, generation: activatedGeneration, receipt_id: 'release'}),
    rollbackPreparing: async state => {calls.push('rollback'); return {paused: true, source_selected: true, receipt_id: state.generation};},
  };
  for (const step of steps) io[step] = async state => {
    calls.push(step); effects.add(`${state.generation}:${step}`);
    if (step === 'activate') {phase = 'active'; activatedGeneration = state.generation; return {active: true, generation: state.generation, receipt_id: 'release'};}
    return {ok: true, receipt_id: step};
  };
  return {io, calls, effects, state: () => journal, setPhase: value => {phase = value;}};
}
test('check stays read-only; risky apply needs exact plan approval', async () => {
  const {io, calls, state} = fixture();
  await runMaintenanceUpgrade(io, {...options, action: 'check'});
  assert.equal(state(), null); assert.deepEqual(calls, ['resolve']);
  await assert.rejects(runMaintenanceUpgrade(io, {...options, approvedPlanHash: undefined}), /APPROVAL_REQUIRED/);
  assert.equal(state(), null);
});
test('completed apply is idempotent and does not resolve mutable release again', async () => {
  const {io, calls, effects} = fixture();
  await runMaintenanceUpgrade(io, options);
  const size = effects.size;
  await runMaintenanceUpgrade(io, options);
  assert.equal(effects.size, size);
  assert.equal(calls.filter(call => call === 'resolve').length, 1);
  assert.equal(calls.includes('rollback'), false);
});
for (const step of steps) test(`lost actor response at ${step} never rolls back activated writes`, async () => {
  const {io, calls, state} = fixture();
  const original = io[step]; let once = true;
  io[step] = async value => {const receipt = await original(value); if (once) {once = false; throw new Error('lost response');} return receipt;};
  await assert.rejects(runMaintenanceUpgrade(io, options));
  const activated = steps.indexOf(step) >= steps.indexOf('activate');
  assert.equal(calls.includes('rollback'), !activated);
  assert.equal(state().status, activated ? 'active_repair' : 'rolled_back');
  await runMaintenanceUpgrade(io, options);
  assert.equal(state().status, 'complete');
});
test('unknown activation and different recovery target never select old source', async () => {
  const {io, calls, setPhase, state} = fixture();
  io.fence = async () => {setPhase('unknown'); throw new Error('transport lost');};
  await assert.rejects(runMaintenanceUpgrade(io, options), /RECOVERY_UNCERTAIN/);
  assert.equal(calls.includes('rollback'), false);
  assert.equal(state().status, 'recovery_uncertain');
  await assert.rejects(runMaintenanceUpgrade(io, {...options, target: '1.2.4'}), /BINDING_MISMATCH/);
  assert.equal(calls.filter(call => call === 'resolve').length, 1);
});
test('resume after journal write interruption revalidates each intent', async () => {
  const {io, state} = fixture(); const write = io.writeJournal; let failed = false;
  io.writeJournal = async value => {if (value.intent === 'backup' && !failed) {failed = true; throw new Error('disk unavailable');} await write(value);};
  await assert.rejects(runMaintenanceUpgrade(io, options));
  await runMaintenanceUpgrade(io, options);
  assert.equal(state().status, 'complete');
});
for (const step of steps) test(`durable intent survives host journal outage after ${step}`, async () => {
  const {io, state} = fixture(); const original = io[step], write = io.writeJournal;
  let diskLost = false, once = true;
  io.writeJournal = async value => {if (diskLost) throw new Error('host interrupted'); await write(value);};
  io[step] = async value => {const receipt = await original(value); if (once) {once = false; diskLost = true;} return receipt;};
  await assert.rejects(runMaintenanceUpgrade(io, options));
  assert.equal(state().intent, step);
  diskLost = false;
  await runMaintenanceUpgrade(io, options);
  assert.equal(state().status, 'complete');
});
test('prior activation evidence cannot be undone by an inconsistent inactive probe', async () => {
  const {io, calls, setPhase} = fixture();
  await runMaintenanceUpgrade(io, options);
  setPhase('inactive');
  await assert.rejects(runMaintenanceUpgrade(io, {...options, action: 'rollback'}), /FORWARD_REPAIR/);
  assert.equal(calls.includes('rollback'), false);
});
test('explicit rollback may omit target and preserves no-effect original running state', async () => {
  const {io, state} = fixture();
  io.prepareIdentity = async () => {throw new Error('bootstrap not started');};
  io.rollbackPreparing = async () => ({unchanged: true, paused: false, receipt_id: 'unchanged'});
  await assert.rejects(runMaintenanceUpgrade(io, options));
  assert.equal(state().rollback.unchanged, true);
  const result = await runMaintenanceUpgrade(io, {action: 'rollback'});
  assert.equal(result.paused, false);
  assert.equal(result.unchanged, true);
});
test('unchanged recovery preserves and reports an existing operator pause', async () => {
  const {io, state} = fixture();
  io.pauseAndDrain = async () => {throw new Error('operator pause belongs to another workflow');};
  io.rollbackPreparing = async value => ({unchanged: true, paused: true, reason: 'maintenance', receipt_id: value.generation});
  await assert.rejects(runMaintenanceUpgrade(io, options));
  assert.equal(state().status, 'rolled_back');
  assert.deepEqual({unchanged: state().rollback.unchanged, paused: state().rollback.paused, reason: state().rollback.reason}, {unchanged: true, paused: true, reason: 'maintenance'});
  const result = await runMaintenanceUpgrade(io, {action: 'rollback'});
  assert.equal(result.unchanged, true); assert.equal(result.paused, true);
});
test('reapply after rollback rereads source plan and preserves explicit reset selection', async () => {
  const {io, state} = fixture(); let fail = true;
  io.plan = async (_target, settings) => ({plan_hash: planHash, risks: [{code: 'RESET_ROLE_IDENTITY'}], blocking_errors: [], reset_role_identity: settings ? settings.resetRoleIdentity : true, source_environment_sha256: settings ? 'new' : 'old'});
  const backup = io.backup;
  io.backup = async value => {if (fail) {fail = false; throw new Error('backup interrupted');} return backup(value);};
  await assert.rejects(runMaintenanceUpgrade(io, options));
  assert.equal(state().plan.source_environment_sha256, 'old');
  await runMaintenanceUpgrade(io, options);
  assert.equal(state().plan.source_environment_sha256, 'new'); assert.equal(state().plan.reset_role_identity, true);
});
test('drain timeout keeps the same generation paused with original services and resumes draining', async () => {
  const {io, state, calls} = fixture(); let settled = false;
  const drain = io.pauseAndDrain;
  io.pauseAndDrain = async value => {if (!settled) throw new Error('unknown effect remains'); return drain(value);};
  io.rollbackPreparing = async value => ({awaiting_drain: true, paused: true, services_unchanged: true, receipt_id: value.generation});
  await assert.rejects(runMaintenanceUpgrade(io, options));
  const generation = state().generation;
  assert.equal(state().status, 'awaiting_drain');
  assert.equal(calls.includes('fence'), false); assert.equal(calls.includes('backup'), false);
  settled = true;
  await runMaintenanceUpgrade(io, options);
  assert.equal(state().generation, generation); assert.equal(state().status, 'complete');
});
test('safe rollback replan can be inspected and approved when its structural hash changed', async () => {
  const {io, state} = fixture(); let failed = false;
  const originalBackup = io.backup;
  io.backup = async value => {if (!failed) {failed = true; throw new Error('backup error');} return originalBackup(value);};
  await assert.rejects(runMaintenanceUpgrade(io, options));
  const changed = 'b'.repeat(64);
  io.plan = async (_target, settings) => {assert.equal(settings.recovery, true); return {plan_hash: changed, risks: [{code: 'DDL_CHANGE'}], blocking_errors: []};};
  const check = await runMaintenanceUpgrade(io, {...options, action: 'check'});
  assert.equal(check.plan.plan_hash, changed);
  await assert.rejects(runMaintenanceUpgrade(io, options), /APPROVAL_REQUIRED/);
  assert.equal(state().status, 'rolled_back');
  await runMaintenanceUpgrade(io, {...options, approvedPlanHash: changed});
  assert.equal(state().status, 'complete'); assert.equal(state().plan.plan_hash, changed);
});
