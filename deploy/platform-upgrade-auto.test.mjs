import test from 'node:test';
import assert from 'node:assert/strict';
import {runAutomaticUpgrade} from './platform-upgrade-auto.mjs';
import {AUTO_POLICY_SCHEMA, validateAutoPolicy, inMaintenanceWindow, isPatchIncrease, fingerprint} from './platform-upgrade-auto-policy.mjs';

const hash = 'a'.repeat(64), inWindow = new Date('2026-10-21T02:30:00Z'), outside = new Date('2026-10-21T04:00:00Z');
const policy = {schema: AUTO_POLICY_SCHEMA, enabled: true, window: {timezone: 'Etc/UTC', days: [3], start: '02:00', end: '04:00'}, signature: {enabled: true}};
const steps = ['prepareIdentity', 'pauseAndDrain', 'fence', 'backup', 'candidate', 'rebuild', 'configurePreparing', 'startPreparing', 'verifyPreparing', 'activate', 'verifyActive'];
function fixture() {
  const data = {journal: null, authorization: null, calls: [], active: false, source: '1.2.3', date: inWindow};
  const target = {version: '1.2.4', schema_version: 61};
  const plan = {plan_hash: hash, risks: [], blocking_errors: [], source_schema_version: 61, target_schema_version: 61,
    source_schema_sha256: hash, target_sql_sha256: hash, source_environment_sha256: hash,
    reset_role_identity: false, preflight_projection: 'none', preflight: {ok: true, blocking_errors: []}};
  const io = {
    readJournal: async () => structuredClone(data.journal), writeJournal: async value => {data.journal = structuredClone(value);},
    readAuthorization: async () => structuredClone(data.authorization), writeAuthorization: async value => {data.authorization = structuredClone(value);},
    deploymentBinding: async () => ({project: 'isolated'}),
    current: async () => {data.calls.push('current');return {version: data.source, environmentHash: hash};},
    discoverTarget: async () => {data.calls.push('discover');return target;},
    verifySignatures: async () => {data.calls.push('signature');return {verified: true, status: 'verified', targetSha256: hash};},
    pull: async () => {data.calls.push('pull');},
    plan: async () => {data.calls.push('plan');return plan;},
    inspectActivation: async state => data.active ? {status: 'active', generation: state.generation, receipt_id: state.generation} : {status: 'inactive'},
    rollbackPreparing: async state => {data.calls.push('rollback');return {paused: true, source_selected: true, receipt_id: state.generation};},
    archiveCompleted: async () => {data.calls.push('archive');data.journal = null;data.source = target.version;},
  };
  for (const step of steps) io[step] = async state => {
    data.calls.push(step);
    if (step === 'activate') {data.active = true;return {active: true, generation: state.generation, receipt_id: state.generation};}
    return {ok: true};
  };
  return {data, io, target, plan, run: () => runAutomaticUpgrade(io, {policy, now: () => data.date})};
}

test('strict opt-in and explicit window; overnight days and DST use local time', () => {
  assert.equal(validateAutoPolicy({schema: AUTO_POLICY_SCHEMA, enabled: false}).enabled, false);
  for (const changed of [{enabled: undefined}, {window: {...policy.window, start: '04:00'}}, {signature: {enabled: false}}, {unexpected: true}]) assert.throws(() => validateAutoPolicy({...policy, ...changed}));
  assert.equal(inMaintenanceWindow(policy, inWindow), true);
  assert.equal(inMaintenanceWindow(policy, outside), false);
  const overnight = {...policy, window: {...policy.window, start: '23:00', end: '01:00'}};
  assert.equal(inMaintenanceWindow(overnight, new Date('2026-10-22T00:30:00Z')), true);
  assert.equal(inMaintenanceWindow(overnight, new Date('2026-10-21T00:30:00Z')), false);
  const dst = {...policy, window: {timezone: 'America/New_York', days: [7], start: '01:00', end: '02:00'}};
  assert.equal(inMaintenanceWindow(dst, new Date('2026-11-01T05:30:00Z')), true);
  assert.equal(inMaintenanceWindow(dst, new Date('2026-11-01T06:30:00Z')), true);
});

test('only stable increasing patch within same major/minor', () => {
  assert.equal(isPatchIncrease('1.2.3', '1.2.4'), true);
  for (const target of ['v1.2.4', '1.2.4-rc.1', '1.2.4+build', '1.3.0', '2.2.4', '1.2.3', '1.2.2', '01.2.4']) assert.equal(isPatchIncrease('1.2.3', target), false, target);
});

test('disabled and outside window do not discover, inspect, pull or mutate', async () => {
  const f = fixture();
  assert.equal((await runAutomaticUpgrade(f.io, {policy: {...policy, enabled: false}})).reason, 'policy_disabled');
  f.data.date = outside;
  assert.equal((await f.run()).reason, 'outside_maintenance_window');
  assert.deepEqual(f.data.calls, []);
});

test('signed no-risk patch invokes real maintenance engine and persists ownership before actors', async () => {
  const f = fixture(), original = f.io.prepareIdentity;
  f.io.prepareIdentity = async state => {
    assert.equal(f.data.journal.autoAuthorizationHash, fingerprint(f.data.authorization));
    return original(state);
  };
  assert.equal((await f.run()).status, 'complete');
  assert.deepEqual(f.data.calls.filter(call => steps.includes(call)), steps);
  assert.ok(f.data.calls.indexOf('signature') < f.data.calls.indexOf('pull'));
});

for (const [name, change] of [
  ['schema change', plan => {plan.target_schema_version++;}],
  ['schema alias', plan => {plan.target_sql_sha256 = 'b'.repeat(64);}],
  ['risk', plan => {plan.risks.push('reset');}],
  ['blocking', plan => {plan.blocking_errors.push({code: 'INVALID'});}],
  ['incomplete preflight', plan => {delete plan.preflight;}],
  ['preflight blocker', plan => {plan.preflight.blocking_errors.push({code: 'INVALID'});}],
  ['reset projection', plan => {plan.reset_role_identity = true;}],
]) test(`${name} never starts maintenance`, async () => {
  const f = fixture();change(f.plan);
  await assert.rejects(f.run, /AUTO_PLAN_REQUIRES_MANUAL_UPGRADE/);
  assert.equal(f.data.journal, null);
  assert.equal(f.data.calls.includes('prepareIdentity'), false);
});

test('signature failure never pulls or authorizes maintenance', async () => {
  const f = fixture();f.io.verifySignatures = async () => ({verified: false});
  await assert.rejects(f.run, /AUTO_SIGNATURE_REQUIRED/);
  assert.equal(f.data.authorization, null);assert.equal(f.data.calls.includes('pull'), false);
});

test('slow preflight crossing end of window leaves business untouched', async () => {
  const f = fixture();f.io.plan = async () => {f.data.date = outside;return f.plan;};
  assert.equal((await f.run()).reason, 'maintenance_window_closed');
  assert.equal(f.data.authorization, null);assert.equal(f.data.journal, null);
});

test('window closes after authorization write: no generation starts', async () => {
  const f = fixture(), original = f.io.writeAuthorization;
  f.io.writeAuthorization = async value => {await original(value);f.data.date = outside;};
  assert.equal((await f.run()).reason, 'maintenance_window_closed');
  assert.equal(f.data.journal, null);
});

test('crash after initial journal write resumes pinned generation outside window without discovery or replan', async () => {
  const f = fixture(), original = f.io.writeJournal;
  f.io.writeJournal = async value => {await original(value);throw Error('power loss');};
  await assert.rejects(f.run, /power loss/);
  const generation = f.data.journal.generation;
  f.io.writeJournal = original;f.data.date = outside;f.data.calls = [];
  f.io.discoverTarget = async () => {throw Error('must not fetch latest');};
  f.io.plan = async () => {throw Error('must not re-plan interrupted candidate');};
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.data.journal.generation, generation);
});

test('receipt without generation resumes pinned target, rejects changed plan', async () => {
  const f = fixture();f.io.writeJournal = async () => {throw Error('power loss');};
  await assert.rejects(f.run, /power loss/);
  f.io.discoverTarget = async () => {throw Error('must not fetch latest');};
  f.plan.plan_hash = 'b'.repeat(64);
  await assert.rejects(f.run, /AUTO_PLAN_CHANGED/);
});

test('manual or altered journal cannot be adopted by unattended execution', async () => {
  const f = fixture();f.data.journal = {status: 'preparing'};
  await assert.rejects(f.run, /AUTO_AUTHORIZATION_MISMATCH/);
  f.data.journal = null;await f.run();f.data.journal.target.version = '1.2.5';
  await assert.rejects(f.run, /AUTO_JOURNAL_MISMATCH/);
});

test('rollback and uncertain outcomes require manual recovery; active only forward repair', async () => {
  const f = fixture();await f.run();
  for (const status of ['rolled_back', 'rolling_back', 'rollback_resumed', 'awaiting_drain', 'recovery_uncertain']) {
    f.data.journal.status = status;f.data.calls = [];
    assert.equal((await f.run()).reason, 'manual_recovery_required');assert.deepEqual(f.data.calls, []);
  }
  f.data.journal.status = 'active_repair';f.io.verifyActive = async () => {throw Error('health failed');};
  await assert.rejects(f.run);assert.equal(f.data.calls.includes('rollback'), false);
});

test('deployment binding or policy change refuses recovery', async () => {
  const f = fixture();await f.run();f.io.deploymentBinding = async () => ({project: 'another'});
  await assert.rejects(f.run, /AUTO_AUTHORIZATION_MISMATCH/);
});

test('verified manual completion can precede automatic scheduling without adopting manual recovery', async () => {
  const f = fixture();f.data.journal = {status: 'complete', binding: {project: 'isolated'}};
  f.data.authorization = {stale: true};
  assert.equal((await f.run()).reason, 'not_a_stable_patch_increase');
  assert.equal(f.data.authorization, null);assert.ok(f.data.calls.includes('archive'));
});

test('authorization persists original target even when release discovery changes after crash', async () => {
  const f = fixture(), original = f.io.writeJournal;
  f.io.writeJournal = async () => {throw Error('power loss');};await assert.rejects(f.run, /power loss/);
  f.io.writeJournal = original;f.io.discoverTarget = async () => ({version: '1.2.99', schema_version: 61});
  assert.equal((await f.run()).status, 'complete');assert.equal(f.data.journal.target.version, '1.2.4');
});
