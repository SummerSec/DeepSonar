import assert from 'node:assert/strict';
import test from 'node:test';
import { upgrade } from './platform-upgrade.mjs';
import { hostAdapter } from './platform-upgrade-host.mjs';
import { PREFLIGHT_RESULT_SCHEMA, preflightBlock } from './platform-upgrade-preflight.mjs';

const passingPreflight = () => ({schema: PREFLIGHT_RESULT_SCHEMA, ok: true, blocking_errors: [], coverage: [], not_checked: []});

const stages = ['pause_requested', 'backup_started', 'backup_verified', 'stopping', 'switching', 'starting', 'verified_paused', 'resume_requested', 'reverting', 'rollback_verifying'];
const earlyStages = new Set(['pause_requested', 'backup_started', 'backup_verified']);

function recovery(stage) {
  let state = stage === null ? null : {
    format: 1, stage, current: {version: '1.0.0', schema: 59},
    target: {version: '1.1.0', schema_version: 59},
    backup: {file: 'database-1.dump.gz', hash: 'a'.repeat(64)},
  };
  let paused = stage !== null;
  const calls = [];
  const io = {
    lock: fn => fn(), readState: async () => structuredClone(state),
    writeState: async value => { state = structuredClone(value); calls.push(`save:${value.stage}`); },
    release: async () => { calls.push('release'); return {version: '1.1.0', schema_version: 59}; },
    current: async () => ({version: '1.0.0', schema: 59}),
    claims: async () => ({claims_paused: paused, reason: paused ? 'platform_upgrade' : null,
      drained: true, in_flight: {total: 0}, effect_pending_attempts: 0, unknown_effect_attempts: 0}),
  };
  io.recoveryClaims = io.claims;
  for (const name of ['pull', 'preflight', 'schemaPlan', 'pause', 'drain', 'backup', 'verifyBackup', 'stop', 'forcePaused', 'configure', 'start', 'verify', 'resume', 'restore']) {
    io[name] = async value => {
      calls.push(name === 'configure' ? `configure:${value.version}` : name);
      if (name === 'preflight') return passingPreflight();
      if (name === 'pause') paused = true;
      if (name === 'resume') paused = false;
      if (name === 'backup') return {file: 'database-1.dump.gz', hash: 'a'.repeat(64)};
    };
  }
  return {io, calls, state: () => state, paused: () => paused, setPaused: value => { paused = value; }};
}

for (const stage of stages) {
  test(`repeated apply preserves ${stage} evidence before release discovery`, async () => {
    const f = recovery(stage), original = structuredClone(f.state());
    for (let i = 0; i < 2; i++) await assert.rejects(upgrade('apply', f.io), /unfinished upgrade/);
    assert.deepEqual(f.state(), original);
    assert.deepEqual(f.calls, []);
  });
  if (stage === 'resume_requested') continue;
  test(`rollback from ${stage} preserves DB and duplicate rollback is refused`, async () => {
    const f = recovery(stage);
    await upgrade('rollback', f.io);
    assert.equal(f.state().stage, 'rolled_back');
    assert.equal(f.paused(), true);
    assert.equal(f.calls.includes('restore'), false);
    assert.equal(f.calls.includes('resume'), false);
    assert.equal(f.calls.includes('configure:1.0.0'), !earlyStages.has(stage));
    if (earlyStages.has(stage)) assert.deepEqual(f.calls, ['save:rolled_back']);
    const first = [...f.calls];
    await assert.rejects(upgrade('rollback', f.io), /no interrupted upgrade/);
    assert.deepEqual(f.calls, first);
  });
}

for (const stage of [null, 'complete', 'rolled_back', 'unrecognized']) {
  test(`rollback rejects ${stage} journal without mutation`, async () => {
    const f = recovery(stage);
    await assert.rejects(upgrade('rollback', f.io), /no interrupted upgrade|invalid recovery stage/);
    assert.deepEqual(f.calls, []);
  });
}

for (const observedPaused of [true, false]) {
  test(`ambiguous resume remains blocked even when observed pause is ${observedPaused}`, async () => {
    const f = recovery(null);
    f.io.resume = async () => { f.setPaused(observedPaused); throw new Error('response lost'); };
    await assert.rejects(upgrade('apply', f.io), /response lost/);
    assert.equal(f.state().stage, 'resume_requested');
    f.calls.length = 0;
    await assert.rejects(upgrade('apply', f.io), /unfinished upgrade/);
    await assert.rejects(upgrade('rollback', f.io), /operator reconciliation/);
    assert.deepEqual(f.calls, []);
  });
}

test('rollback with missing backup or cross-schema journal never stops or configures apps', async () => {
  for (const invalid of ['missing-backup', 'cross-schema']) {
    const f = recovery('starting');
    if (invalid === 'missing-backup') delete f.state().backup;
    else f.state().target.schema_version++;
    await assert.rejects(upgrade('rollback', f.io), /missing verified recovery backup|cross-schema rollback/);
    assert.deepEqual(f.calls, invalid === 'missing-backup' ? [] : ['verifyBackup']);
    assert.equal(f.state().stage, 'starting');
  }
});

function hostPreflight() {
  const calls = [];
  let count = 0, report = passingPreflight();
  const io = hostAdapter({run: (args, input) => {
    calls.push(args);
    if (args.at(-1).includes("worker_nodes WHERE kind='remote'")) return Buffer.from(String(count));
    if (args.includes('psql')) {
      assert.match(input, /REPEATABLE READ READ ONLY/);
      return Buffer.from(JSON.stringify({database_schema_version: 59}));
    }
    if (args.includes('config')) return Buffer.from(JSON.stringify({services: {scheduler: {environment: {}}}}));
    if (args[0] === 'run') {
      assert.equal(JSON.parse(input).target_schema_version, 59);
      assert.ok(args.includes('--network=none'));
      return Buffer.from(JSON.stringify(report));
    }
    throw new Error('unexpected host command');
  }});
  const target = {schema_version: 59, values: {DEEPSONAR_SCHEDULER_IMAGE: `ghcr.io/summersec/deepsonar-scheduler@sha256:${'a'.repeat(64)}`}};
  return {io, calls, target, workers: value => { count = value; }, report: value => { report = value; }};
}

function assertRemoteBlocked(report) {
  assert.equal(report.ok, false);
  assert.deepEqual(report.blocking_errors.map(error => error.code), ['HOST_REMOTE_WORKERS_UNSUPPORTED']);
}

test('remote worker presence is re-read on each preflight; registration and removal change eligibility', async () => {
  const f = hostPreflight();
  assert.equal((await f.io.preflight(f.target)).ok, true);
  f.workers(1); f.calls.length = 0;
  assertRemoteBlocked(await f.io.preflight(f.target));
  assert.equal(f.calls.length, 1, 'reject before image execution or Compose changes');
  f.workers(0); f.calls.length = 0;
  assert.equal((await f.io.preflight(f.target)).ok, true);
  assert.ok(f.calls.some(args => args[0] === 'run'), 'removal allows target offline validation');
  // Re-reading eligibility is not a topology lock: later registrations are not fenced.
});

test('all registered remote workers block single-host preflight regardless of heartbeat or claimed version', async () => {
  const f = hostPreflight(); f.workers(2);
  assertRemoteBlocked(await f.io.preflight(f.target));
  assert.match(f.calls[0].at(-1), /^SELECT count\(\*\) FROM worker_nodes WHERE kind='remote'$/);
  // This is a host eligibility guard, not worker-version fencing or multi-node support.
});

test('target validator rejection is preserved by host transport without remote workers', async () => {
  const f = hostPreflight();
  const rejected = preflightBlock('TARGET_SCHEMA_MISMATCH', 'target.schema_version', 'Target schema mismatch.');
  f.report(rejected);
  assert.deepEqual(await f.io.preflight(f.target), rejected);
  assert.equal(f.calls.some(args => args.includes('stop') || args.includes('up')), false);
  // The fake validator proves report transport only; schema validation has its own tests.
});

for (const point of ['stop', 'configure', 'start', 'verify']) {
  test(`interrupted rollback at ${point} can retry without restoring DB or releasing claims`, async () => {
    const f = recovery('starting'), original = f.io[point];
    f.io[point] = async () => { throw new Error(`lost:${point}`); };
    await assert.rejects(upgrade('rollback', f.io), /lost:/);
    assert.equal(f.state().stage, ['start', 'verify'].includes(point) ? 'rollback_verifying' : 'reverting');
    f.io[point] = original;
    await upgrade('rollback', f.io);
    assert.equal(f.state().stage, 'rolled_back');
    assert.equal(f.paused(), true);
    assert.equal(f.calls.includes('restore'), false);
    assert.equal(f.calls.includes('resume'), false);
  });
}

test('lost completion journal write after successful resume stays at the uncertainty boundary', async () => {
  const f = recovery(null), save = f.io.writeState;
  f.io.writeState = async value => {
    if (value.stage === 'complete') throw new Error('journal disk full');
    return save(value);
  };
  await assert.rejects(upgrade('apply', f.io), /journal disk full/);
  assert.equal(f.paused(), false);
  assert.equal(f.state().stage, 'resume_requested');
  f.calls.length = 0;
  await assert.rejects(upgrade('rollback', f.io), /operator reconciliation/);
  assert.deepEqual(f.calls, []);
});

for (const remoteCount of [1, 2]) {
  test(`apply refuses host remote-worker report (${remoteCount}) before pause or journal`, async () => {
    const f = recovery(null), host = hostPreflight();
    host.workers(remoteCount);
    f.io.preflight = () => host.io.preflight(host.target);
    await assert.rejects(upgrade('apply', f.io), error => {
      assertRemoteBlocked(error.preflight);
      return true;
    });
    assert.equal(f.state(), null);
    assert.equal(f.paused(), false);
    assert.deepEqual(f.calls, ['release', 'pull']);
  });
}
