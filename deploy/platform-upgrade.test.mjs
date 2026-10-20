import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { upgrade, assertDrained, forwardVersion, verifyBackup } from './platform-upgrade.mjs';
import { hostAdapter, platformValues } from './platform-upgrade-host.mjs';

function fixture(fail) {
  const calls = [];
  let state = null, paused = false;
  const target = { version: '1.1.0', schema_version: 59 };
  const current = { version: '1.0.0', schema: 59 };
  const io = {
    lock: fn => fn(), readState: async () => state,
    writeState: async value => { state = structuredClone(value); calls.push(`state:${value.stage}`); },
    release: async () => target, current: async () => current,
    claims: async () => ({ claims_paused: paused, reason: paused ? 'platform_upgrade' : null, drained: true, in_flight: { total: 0 }, effect_pending_attempts: 0, unknown_effect_attempts: 0 }),
  };
  for (const name of ['pull', 'preflight', 'schemaPlan', 'pause', 'drain', 'backup', 'verifyBackup', 'stop', 'configure', 'start', 'verify', 'resume', 'restore', 'forcePaused']) {
    io[name] = async () => {
      calls.push(name);
      if (name === 'pause' || name === 'forcePaused') paused = true;
      if (name === fail) throw new Error(`interrupted:${name}`);
      if (name === 'resume') paused = false;
      if (name === 'backup') return { file: 'database-1.dump.gz', hash: 'a'.repeat(64) };
    };
  }
  io.recoveryClaims = () => io.claims();
  return { io, calls, target, current, state: () => state, paused: () => paused, setState: value => { state = value; } };
}

test('stable versions only move forward with numeric comparison', () => {
  assert.equal(forwardVersion('1.9.9', '1.10.0'), true);
  for (const target of ['1.0.0', '0.9.9']) assert.equal(forwardVersion('1.0.0', target), false);
  for (const version of ['v1.0.0', '1.0.0-beta.1', '01.0.0', '1.0.0+build']) assert.throws(() => forwardVersion('1.0.0', version));
});

test('check does not pause or write journal; pull and isolated preflight precede pause', async () => {
  const f = fixture();
  await upgrade('check', f.io);
  assert.deepEqual(f.calls, ['pull', 'preflight']);
  await upgrade('apply', f.io);
  assert.equal(f.state().stage, 'complete');
  assert.equal(f.paused(), false);
  for (const first of ['pull', 'preflight']) assert.ok(f.calls.indexOf(first) < f.calls.indexOf('pause'));
  assert.ok(f.calls.indexOf('verifyBackup') < f.calls.indexOf('stop'));
  assert.ok(f.calls.indexOf('verify') < f.calls.indexOf('resume'));
});

test('schema changes stop before pause and require an explicit reviewed plan', async () => {
  const f = fixture(); f.target.schema_version++;
  await assert.rejects(upgrade('apply', f.io), /reviewed plan/);
  assert.ok(f.calls.includes('schemaPlan'));
  assert.equal(f.paused(), false); assert.equal(f.state(), null);
});

for (const point of ['pause', 'drain', 'backup', 'verifyBackup', 'stop', 'configure', 'start', 'verify', 'resume']) {
  test(`interruption at ${point} persists recovery and never resumes claims`, async () => {
    const f = fixture(point);
    await assert.rejects(upgrade('apply', f.io), /interrupted/);
    assert.equal(f.paused(), true);
    assert.notEqual(f.state().stage, 'complete');
    if (point !== 'resume') assert.equal(f.calls.includes('resume'), false);
    await assert.rejects(upgrade('apply', f.io), /unfinished upgrade/);
  });
}

test('failed pull or preflight never pauses the platform', async () => {
  for (const point of ['pull', 'preflight']) {
    const f = fixture(point);
    await assert.rejects(upgrade('apply', f.io));
    assert.equal(f.paused(), false); assert.equal(f.state(), null);
  }
});

test('drained projection alone cannot bypass unresolved effects, missing fields or wrong pause', () => {
  const status = { claims_paused: true, reason: 'platform_upgrade', drained: true, in_flight: { total: 0 }, effect_pending_attempts: 0, unknown_effect_attempts: 0 };
  assert.doesNotThrow(() => assertDrained(status));
  for (const patch of [{ effect_pending_attempts: 1 }, { unknown_effect_attempts: 1 }, { in_flight: { total: 1 } }, { claims_paused: false }, { reason: 'maintenance' }, { effect_pending_attempts: undefined }]) {
    assert.throws(() => assertDrained({ ...status, ...patch }), /not safely/);
  }
});

test('backup rejects empty gzip, nonarchive, corrupt compressed data and checksum mismatch', () => {
  const bytes = gzipSync(Buffer.from('PGDMP mock PostgreSQL archive'));
  const verified = verifyBackup(bytes);
  assert.equal(verified.hash.length, 64);
  assert.throws(() => verifyBackup(bytes, '0'.repeat(64)), /checksum/);
  for (const bad of [Buffer.alloc(0), gzipSync(Buffer.alloc(0)), gzipSync(Buffer.from('SQL')), bytes.subarray(0, bytes.length - 1)]) assert.throws(() => verifyBackup(bad));
});

test('rollback preserves database writes and keeps claims paused while reverting images', async () => {
  const f = fixture('verify');
  await assert.rejects(upgrade('apply', f.io));
  f.io.verify = async () => f.calls.push('verify-recovered');
  f.calls.length = 0;
  await upgrade('rollback', f.io);
  assert.deepEqual(f.calls, ['verifyBackup', 'state:reverting', 'stop', 'forcePaused', 'configure', 'state:rollback_verifying', 'start', 'verify-recovered', 'state:rolled_back']);
  assert.equal(f.paused(), true);
});

test('failed rollback configuration never starts apps or resumes; retry remains possible', async () => {
  const f = fixture('start');
  await assert.rejects(upgrade('apply', f.io));
  f.calls.length = 0;
  f.io.configure = async () => { throw new Error('configure failed'); };
  await assert.rejects(upgrade('rollback', f.io), /configure failed/);
  assert.equal(f.state().stage, 'reverting');
  assert.equal(f.calls.includes('start'), false); assert.equal(f.paused(), true);
});

test('ambiguous successful resume prevents restoring a stale snapshot', async () => {
  const f = fixture();
  const resume = f.io.resume;
  f.io.resume = async () => { await resume(); throw new Error('lost response'); };
  await assert.rejects(upgrade('apply', f.io), /lost response/);
  assert.equal(f.state().stage, 'resume_requested');
  await assert.rejects(upgrade('rollback', f.io), /operator reconciliation/);
  assert.equal(f.calls.includes('restore'), false);
});

test('dotenv duplicates and noncanonical assignments cannot bypass image verification', () => {
  const env = ['DEEPSONAR_VERSION=1.0.0', ...['SCHEDULER', 'WEB', 'IMAGE_ADMISSION'].map(name => `DEEPSONAR_${name}_IMAGE=ghcr.io/summersec/deepsonar-${name.toLowerCase().replaceAll('_', '-')}@sha256:${'a'.repeat(64)}`)].join('\n');
  assert.equal(platformValues(env).DEEPSONAR_VERSION, '1.0.0');
  for (const suffix of ['DEEPSONAR_WEB_IMAGE=mutable', ' export DEEPSONAR_WEB_IMAGE=mutable', 'DEEPSONAR_WEB_IMAGE : mutable', 'DEEPSONAR_IMAGE_TAG=latest']) assert.throws(() => platformValues(`${env}\n${suffix}`));
});


test('rollback refuses when an operator resumed claims after interruption', async () => {
  const f = fixture('start');
  await assert.rejects(upgrade('apply', f.io));
  await f.io.resume();
  f.calls.length = 0;
  await assert.rejects(upgrade('rollback', f.io), /not safely paused/);
  assert.deepEqual(f.calls, []);
});

test('resume intent is irreversible even if claims currently appear paused', async () => {
  const f = fixture('resume');
  await assert.rejects(upgrade('apply', f.io));
  assert.equal(f.paused(), true);
  await assert.rejects(upgrade('rollback', f.io), /operator reconciliation/);
});

test('corrupt recovery state cannot trigger rollback mutations', async () => {
  const f = fixture(); f.setState({format: 1, stage: 'unknown'});
  await assert.rejects(upgrade('rollback', f.io), /invalid recovery stage/);
  assert.deepEqual(f.calls, []);
});

test('current official ACR references are accepted but mismatched service repositories are rejected', () => {
  const env = ['DEEPSONAR_VERSION=1.0.0', ...['SCHEDULER', 'WEB', 'IMAGE_ADMISSION'].map(name => `DEEPSONAR_${name}_IMAGE=crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/deepsonar-${name.toLowerCase().replaceAll('_', '-')}@sha256:${'a'.repeat(64)}`)].join('\n');
  assert.equal(platformValues(env).DEEPSONAR_VERSION, '1.0.0');
  assert.throws(() => platformValues(env.replace('/deepsonar-scheduler@', '/deepsonar-web@')), /matching service/);
});

// Exercise the real entrypoint parsing without loading Docker or a deployment .env.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const deployDirectory = dirname(fileURLToPath(import.meta.url));
const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
for (const shell of ['sh', 'pwsh']) {
  test(`${shell} upgrade wrapper forwards target/API/Web and failure status to shared engine`, { skip: shell === 'pwsh' && !pwshAvailable ? 'pwsh unavailable' : false }, () => {
    const temp = mkdtempSync(join(tmpdir(), 'ds upgrade entry '));
    try {
      const bin = join(temp, 'bin'); mkdirSync(bin);
      const entry = join(temp, shell === 'sh' ? 'deploy.sh' : 'deploy.ps1');
      copyFileSync(join(deployDirectory, shell === 'sh' ? 'deploy.sh' : 'deploy.ps1'), entry);
      const log = join(temp, 'args');
      writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$UPGRADE_ARG_LOG"\nexit 17\n', { mode: 0o755 });
      const args = shell === 'sh'
        ? [entry, 'upgrade', 'apply', '--to', 'v1.2.3', '--api', 'http://127.0.0.1:3100', '--web-url', 'http://127.0.0.1:8080']
        : ['-NoProfile', '-File', entry, 'upgrade', 'apply', '-UpgradeVersion', 'v1.2.3', '-ApiUrl', 'http://127.0.0.1:3100', '-WebUrl', 'http://127.0.0.1:8080'];
      const result = spawnSync(shell, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_ARG_LOG: log }, encoding: 'utf8' });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [join(temp, 'platform-upgrade-host.mjs'), 'apply', '--to', 'v1.2.3', '--api', 'http://127.0.0.1:3100', '--web-url', 'http://127.0.0.1:8080']);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}


test('host preflight rejects remote workers before starting any container', async () => {
  const calls = [];
  const io = hostAdapter({run: args => { calls.push(args); return Buffer.from('1'); }});
  await assert.rejects(io.preflight({}), /coordinated upgrade/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].at(-1), /worker_nodes WHERE kind='remote'/);
});

test('host recovery guard is read-only and does not overwrite operator pause', async () => {
  const queries = [];
  const io = hostAdapter({run: args => {
    queries.push(args.at(-1));
    return Buffer.from(JSON.stringify({claims_paused: false, reason: null, drained: true, in_flight: {total: 0}, effect_pending_attempts: 0, unknown_effect_attempts: 0}));
  }});
  await assert.rejects(io.forcePaused(), /not safely paused/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT /);
  assert.doesNotMatch(queries[0], /UPDATE|DELETE/);
});
