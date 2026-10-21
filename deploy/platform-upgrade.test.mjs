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
      if (name === 'preflight') return {schema: 'deepsonar.platform-upgrade-preflight-result/v1', ok: true, blocking_errors: [], coverage: [], not_checked: []};
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
        ? [entry, 'upgrade', 'apply', '--to', 'v1.2.3', '--api', 'http://127.0.0.1:3100', '--web-url', 'http://127.0.0.1:8080', '--approve-plan-hash', 'abc', '--nodes', 'node inventory.json', '--reset-role-identity']
        : ['-NoProfile', '-File', entry, 'upgrade', 'apply', '-UpgradeVersion', 'v1.2.3', '-ApiUrl', 'http://127.0.0.1:3100', '-WebUrl', 'http://127.0.0.1:8080', '-ApprovePlanHash', 'abc', '-Nodes', 'node inventory.json', '-ResetRoleIdentity'];
      const result = spawnSync(shell, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPGRADE_ARG_LOG: log }, encoding: 'utf8' });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [join(temp, 'platform-upgrade-host.mjs'), 'apply', '--to', 'v1.2.3', '--api', 'http://127.0.0.1:3100', '--web-url', 'http://127.0.0.1:8080', '--approve-plan-hash', 'abc', '--nodes', 'node inventory.json', '--reset-role-identity']);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}


test('host preflight rejects remote workers before starting any container', async () => {
  const calls = [];
  const io = hostAdapter({run: args => { calls.push(args); return Buffer.from('1'); }});
  const report = await io.preflight({});
  assert.equal(report.ok, false);
  assert.equal(report.blocking_errors[0].code, 'HOST_REMOTE_WORKERS_UNSUPPORTED');
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

import { createServer } from 'node:http';

async function withManagementServer(handler, fn) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousToken = process.env.DEEPSONAR_ADMIN_TOKEN;
  process.env.DEEPSONAR_ADMIN_TOKEN = 'upgrade-test-admin-token';
  try { return await fn(`http://127.0.0.1:${server.address().port}/api`); }
  finally {
    if (previousToken === undefined) delete process.env.DEEPSONAR_ADMIN_TOKEN;
    else process.env.DEEPSONAR_ADMIN_TOKEN = previousToken;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function verificationRun(args) {
  if (args.includes('psql')) return Buffer.from('59');
  if (args.includes('ps')) return Buffer.from(`container-${args.at(-1)}`);
  if (args[0] === 'inspect') {
    const service = args.at(-1).replace('container-', '');
    return Buffer.from(`ghcr.io/summersec/deepsonar-${service}@sha256:${'a'.repeat(64)}`);
  }
  return Buffer.alloc(0);
}
const verificationTarget = {
  version: '1.2.3', schema_version: 59,
  images: Object.fromEntries(['scheduler', 'web', 'image-admission'].map(service => [service, {
    registry_refs: {github: `ghcr.io/summersec/deepsonar-${service}@sha256:${'a'.repeat(64)}`},
  }])),
};
const pausedResponse = {claims_paused: true, reason: 'platform_upgrade', drained: true, in_flight: {total: 0}, effect_pending_attempts: 0, unknown_effect_attempts: 0};

test('host HTTP requests preserve Web /api prefix and wait for asynchronous readiness', async () => {
  const paths = []; let healthRequests = 0;
  await withManagementServer((req, res) => {
    paths.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer upgrade-test-admin-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') {
      healthRequests++;
      res.end(JSON.stringify({ok: true, ready: healthRequests >= 3, version: '1.2.3'}));
    } else if (req.url === '/api/platform/claims') res.end(JSON.stringify(pausedResponse));
    else { res.statusCode = 404; res.end('{}'); }
  }, async api => {
    const io = hostAdapter({api, run: verificationRun, readyTimeoutMs: 1000, readyIntervalMs: 5});
    await io.verify(verificationTarget);
  });
  assert.equal(healthRequests, 3);
  assert.deepEqual(paths, ['/api/health', '/api/health', '/api/health', '/api/platform/claims']);
});

test('host readiness retries transient HTTP failures but never resumes on timeout', async () => {
  const paths = []; let requests = 0;
  await withManagementServer((req, res) => {
    paths.push(req.url); requests++;
    res.statusCode = requests === 1 ? 503 : 200;
    res.end(JSON.stringify({ok: true, ready: false, version: '1.2.3'}));
  }, async api => {
    const io = hostAdapter({api: `${api}/`, run: verificationRun, readyTimeoutMs: 60, readyIntervalMs: 5});
    await assert.rejects(io.verify(verificationTarget), /readiness timeout; claims remain paused/);
  });
  assert.ok(requests > 1);
  assert.ok(paths.every(path => path === '/api/health'));
});

test('host pause and resume retain the configured API prefix', async () => {
  const paths = [];
  await withManagementServer((req, res) => {
    paths.push([req.method, req.url]); res.end(JSON.stringify(pausedResponse));
  }, async api => {
    const io = hostAdapter({api});
    await io.pause(); await io.resume();
  });
  assert.deepEqual(paths, [['POST', '/api/platform/claims/pause'], ['POST', '/api/platform/claims/resume']]);
});

test('a paused API on the wrong deployment cannot authorize stopping the local running platform', async () => {
  const calls = [], requests = [];
  await withManagementServer((req, res) => {
    requests.push(req.url);
    res.end(JSON.stringify(pausedResponse));
  }, async api => {
    const io = hostAdapter({api, run: args => {
      calls.push(args);
      if (!args.includes('psql')) throw new Error('must not execute Compose stop');
      return Buffer.from(JSON.stringify({...pausedResponse, claims_paused: false, reason: null}));
    }});
    assertDrained(await io.pause()); // Wrong remote API reports a successful pause.
    assertDrained(await io.claims()); // It even reports a drained platform.
    await assert.rejects(io.stop(), /not safely paused/);
  });
  assert.deepEqual(requests, ['/api/platform/claims/pause', '/api/platform/claims']);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('psql'));
  assert.equal(calls.some(args => args.includes('stop')), false);
});

test('local unresolved effects prohibit stop even when claims are paused', async () => {
  for (const patch of [{effect_pending_attempts: 1}, {unknown_effect_attempts: 1}, {in_flight: {total: 1}}]) {
    const calls = [];
    const io = hostAdapter({run: args => {
      calls.push(args);
      return Buffer.from(JSON.stringify({...pausedResponse, ...patch}));
    }});
    await assert.rejects(io.stop(), /not safely paused/);
    assert.equal(calls.some(args => args.includes('stop')), false);
  }
});

test('Compose stop runs only after the local database confirms pause and drain', async () => {
  const calls = [];
  const io = hostAdapter({run: args => {
    calls.push(args);
    return Buffer.from(JSON.stringify(pausedResponse));
  }});
  await io.stop();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('psql'));
  assert.deepEqual(calls[1].slice(-4), ['stop', 'scheduler', 'image-admission', 'web']);
});

test('isolated programmatic project and release seams do not weaken default registry policy', async () => {
  const calls = [], target = {version: '0.0.2', schema_version: 59};
  const io = hostAdapter({projectName: 'pr747-upgrade-test', releaseProvider: async () => target, run: args => {
    calls.push(args); return Buffer.from(JSON.stringify(pausedResponse));
  }});
  assert.equal(await io.release(), target);
  await io.stop();
  assert.equal(calls[0][2], 'pr747-upgrade-test');
  assert.throws(() => hostAdapter({projectName: '../production'}), /invalid Compose project/);
  const local = ['DEEPSONAR_VERSION=0.0.1', ...['SCHEDULER', 'WEB', 'IMAGE_ADMISSION'].map(key => `DEEPSONAR_${key}_IMAGE=127.0.0.1:55000/summersec/deepsonar-${key.toLowerCase().replaceAll('_', '-')}@sha256:${'a'.repeat(64)}`)].join('\n');
  assert.throws(() => platformValues(local), /official registry/);
  const source = readFileSync(join(deployDirectory, 'platform-upgrade-host.mjs'), 'utf8');
  const cli = source.slice(source.indexOf('if (process.argv[1]'));
  assert.doesNotMatch(cli, /releaseProvider|parsePlatformValues|projectName/);
});

test('recovery journal binds Compose project, config paths and actual Docker context endpoint', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ds-target-binding-'));
  const previousHost = process.env.DOCKER_HOST, previousContext = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
  let endpoint = 'tcp://fixture-user:fixture-password@127.0.0.1:2376';
  const run = args => {
    assert.equal(args[0], 'context');
    return Buffer.from(args[1] === 'show' ? 'isolated-fixture' : JSON.stringify(endpoint));
  };
  const composeContents = 'services: {}\n';
  writeFileSync(join(temp, 'compose.yml'), composeContents);
  writeFileSync(join(temp, 'other.yml'), composeContents);
  const opts = {directory: temp, projectName: 'pr747-upgrade-binding', composeFiles: ['compose.yml'], run};
  try {
    const io = hostAdapter(opts);
    await io.lock(() => io.writeState({format: 1, stage: 'stopping'}));
    const saved = JSON.parse(readFileSync(join(temp, '.upgrade', 'state.json'), 'utf8'));
    assert.equal(saved.deploymentTarget.projectName, opts.projectName);
    assert.deepEqual(saved.deploymentTarget.composeFiles, [join(temp, 'compose.yml')]);
    assert.equal(saved.deploymentTarget.envPath, join(temp, '.env'));
    assert.equal(saved.deploymentTarget.composeFileHashes.length, 1);
    assert.match(saved.deploymentTarget.composeFileHashes[0], /^[a-f0-9]{64}$/);
    assert.match(saved.deploymentTarget.dockerIdentity, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-password|fixture-user/);
    assert.equal((await hostAdapter(opts).readState()).stage, 'stopping');
    await assert.rejects(hostAdapter({...opts, projectName: 'pr747-upgrade-other'}).readState(), /deployment target missing or different/);
    await assert.rejects(hostAdapter({...opts, composeFiles: ['other.yml']}).readState(), /deployment target missing or different/);
    writeFileSync(join(temp, 'compose.yml'), 'services: {web: {image: other}}\n');
    await assert.rejects(hostAdapter(opts).readState(), /deployment target missing or different/, 'same-path topology replacement must fail closed');
    writeFileSync(join(temp, 'compose.yml'), composeContents);
    endpoint = 'unix:///other-docker.sock';
    await assert.rejects(hostAdapter(opts).readState(), /deployment target missing or different/);
    writeFileSync(join(temp, '.upgrade', 'state.json'), JSON.stringify({format: 1, stage: 'stopping'}));
    await assert.rejects(hostAdapter(opts).readState(), /deployment target missing or different/);
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext;
    rmSync(temp, {recursive: true, force: true});
  }
});

import { CONFIG_SNAPSHOT_SQL, PREFLIGHT_RESULT_SCHEMA } from './platform-upgrade-preflight.mjs';
const configReport = (ok = true) => ({schema: PREFLIGHT_RESULT_SCHEMA, ok, blocking_errors: ok ? [] : [{code: 'INVALID_GLOBAL_RULES', location: 'global_settings[0].rules_json', message: 'Configuration does not match the target contract.'}], coverage: ['global_settings'], not_checked: ['credential_authentication']});

test('host sends read-only config snapshot and resolved target environment only through isolated validator stdin', async () => {
  const calls = [], secret = 'preflight-secret-not-for-argv';
  const snapshot = {database_schema_version: 59, global_settings: [{id: 'global', rules_json: {obsolete: true}}], credentials: [{settings_config_json: {token: secret}}]};
  const run = (args, input, env, statuses) => {
    calls.push({args, input, env, statuses});
    if (args.includes('-Atc')) return Buffer.from('0');
    if (args.includes('psql')) return Buffer.from(JSON.stringify(snapshot));
    if (args.includes('config')) return Buffer.from(JSON.stringify({services: {scheduler: {environment: {DATABASE_URL: `postgres://user:${secret}@postgres/db`, DEEPSONAR_VERSION: env.DEEPSONAR_VERSION}}}}));
    assert.equal(args[0], 'run');
    return {stdout: Buffer.from(JSON.stringify(configReport(false))), status: 1};
  };
  const target = {schema_version: 59, values: {DEEPSONAR_VERSION: '1.2.3', DEEPSONAR_SCHEDULER_IMAGE: `ghcr.io/summersec/deepsonar-scheduler@sha256:${'a'.repeat(64)}`}};
  const result = await hostAdapter({run}).preflight(target);
  assert.deepEqual(result, configReport(false));
  const read = calls.find(call => call.args.includes('psql') && !call.args.includes('-Atc'));
  assert.match(read.input, /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(read.input, /COMMIT;$/);
  assert.doesNotMatch(CONFIG_SNAPSHOT_SQL, /ciphertext|nonce|auth_tag|health_detail|master_key/);
  const validate = calls.find(call => call.args[0] === 'run');
  assert.ok(validate.args.includes('--network=none') && validate.args.includes('--read-only') && validate.args.includes('-i'));
  assert.ok(!validate.args.includes('-v') && !validate.args.includes('--mount') && !validate.args.includes('-e'));
  assert.deepEqual(validate.statuses, [0, 1]);
  assert.equal(validate.args.at(-1), '/app/apps/scheduler/dist/platform-upgrade-preflight-cli.js');
  const payload = JSON.parse(validate.input);
  assert.equal(payload.environment.DEEPSONAR_VERSION, '1.2.3');
  assert.equal(payload.global_settings[0].rules_json.obsolete, true);
  assert.equal(payload.credentials[0].settings_config_json.token, secret);
  assert.ok(!JSON.stringify(calls.map(call => call.args)).includes(secret));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('check returns configuration blockers while apply refuses before pause or any journal mutation', async () => {
  const f = fixture(); f.io.preflight = async () => configReport(false);
  const plan = await upgrade('check', f.io);
  assert.deepEqual(plan.preflight, configReport(false));
  await assert.rejects(upgrade('apply', f.io), error => {
    assert.match(error.message, /configuration preflight blocked/);
    assert.deepEqual(error.preflight, configReport(false)); return true;
  });
  assert.equal(f.state(), null); assert.equal(f.paused(), false);
  assert.equal(f.calls.includes('pause'), false);
});

test('preflight subprocess failures, malformed output and status disagreement fail closed without leaking input', async () => {
  for (const failure of ['snapshot', 'compose', 'execution', 'output', 'status']) {
    const secret = 'secret-value-from-process-output';
    const run = (args) => {
      if (args.includes('-Atc')) return Buffer.from('0');
      if (args.includes('psql')) { if (failure === 'snapshot') throw new Error(secret); return Buffer.from('{}'); }
      if (args.includes('config')) { if (failure === 'compose') throw new Error(secret); return Buffer.from('{"services":{"scheduler":{"environment":{}}}}'); }
      if (failure === 'execution') throw new Error(secret);
      if (failure === 'output') return {stdout: Buffer.from(secret), status: 1};
      return {stdout: Buffer.from(JSON.stringify(configReport(true))), status: 1};
    };
    const report = await hostAdapter({run}).preflight({schema_version: 59, values: {DEEPSONAR_SCHEDULER_IMAGE: 'test@sha256:unused'}});
    assert.equal(report.ok, false, failure);
    assert.ok(!JSON.stringify(report).includes(secret));
  }
});


test('missing or malformed preflight success cannot authorize apply', async () => {
  for (const result of [undefined, null, {}, {ok: 'true'}]) {
    const f = fixture(); f.io.preflight = async () => result;
    const plan = await upgrade('check', f.io);
    assert.equal(plan.preflight.ok, false);
    assert.equal(plan.preflight.blocking_errors[0].code, 'HOST_PREFLIGHT_RESULT_MISSING');
    await assert.rejects(upgrade('apply', f.io), /configuration preflight blocked/);
    assert.equal(f.paused(), false); assert.equal(f.state(), null);
  }
});
