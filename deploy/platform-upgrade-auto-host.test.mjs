import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runHostAutomatic} from './platform-upgrade-auto-host.mjs';
import {durablePrivateWrite} from './platform-upgrade-maintenance-transport.mjs';
import {AUTO_POLICY_SCHEMA} from './platform-upgrade-auto-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = resolve(root, 'deploy/platform-upgrade-host.mjs');
const disabled = {schema: AUTO_POLICY_SCHEMA, enabled: false};
const env = {...process.env, DOCKER_HOST: 'tcp://127.0.0.1:1'};
const command = (bin, args) => spawnSync(bin, args, {cwd: root, env, encoding: 'utf8', timeout: 30_000});

test('real Node CLI auto defaults disabled without Docker or policy file', () => {
  const result = command(process.execPath, [host, 'auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {status: 'not_started', reason: 'policy_disabled'});
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
});

const shells = [['sh', ['deploy/deploy.sh', 'upgrade', 'auto']], ['pwsh', ['-NoProfile', '-File', 'deploy/deploy.ps1', 'upgrade', 'auto']]];
for (const [shell, args] of shells) test(`real ${shell} wrapper invokes Node auto with disabled policy`, {skip: spawnSync(shell, shell === 'pwsh' ? ['-NoProfile', '-Command', 'exit 0'] : ['-c', 'exit 0']).status !== 0 ? `${shell} unavailable` : false}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-cli-'));
  try {
    const policy = join(dir, 'policy.json');await durablePrivateWrite(policy, JSON.stringify(disabled));
    const result = command(shell, [...args, shell === 'pwsh' ? '-Policy' : '--policy', policy]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, 'policy_disabled');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('real manual Node CLI gets to handled adapter failure rather than circular import deadlock', () => {
  // Invalid compose project is checked synchronously before Docker/network use.
  // CLI does not expose that seam; an exported platform override is similarly
  // rejected at adapter construction, before any real deployment side effect.
  const result = spawnSync(process.execPath, [host, 'check'], {cwd: root, env: {...env, DEEPSONAR_VERSION: '1.2.3'}, encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unset DEEPSONAR_VERSION before upgrade/);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
});

test('auto refuses manual target, risk approval, and destructive reset options', async () => {
  for (const options of [{version: '1.2.4'}, {approvedPlanHash: 'a'.repeat(64)}, {resetRoleIdentity: true}]) await assert.rejects(() => runHostAutomatic(options), /AUTO_MANUAL_OPTIONS_FORBIDDEN/);
});

test('enabled host compares actual ready health with dotenv before discovering releases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-health-'));
  try {
    const now = new Date(), format = date => date.toISOString().slice(11, 16);
    const policy = join(dir, 'policy.json');
    await durablePrivateWrite(policy, JSON.stringify({schema: AUTO_POLICY_SCHEMA, enabled: true,
      window: {timezone: 'Etc/UTC', days: [1, 2, 3, 4, 5, 6, 7], start: format(new Date(+now - 120_000)), end: format(new Date(+now + 300_000))}, signature: {enabled: true}}));
    await writeFile(join(dir, '.env'), ['DEEPSONAR_VERSION=1.2.3', ...['scheduler', 'web', 'image-admission'].map(service => `DEEPSONAR_${service.replaceAll('-', '_').toUpperCase()}_IMAGE=ghcr.io/summersec/deepsonar-${service}@sha256:${'a'.repeat(64)}`)].join('\n'));
    for (const health of [{ok: false, ready: true, version: '1.2.3'}, {ok: true, ready: false, version: '1.2.3'}, {ok: true, ready: true, version: '1.2.2'}, {ok: true, ready: true, maintenance: true, version: '1.2.3'}]) {
      let calls = 0;
      await assert.rejects(() => runHostAutomatic({directory: dir, policy, run: args => {
        assert.ok(args.includes('exec'));assert.ok(args.includes('scheduler'));calls++;
        return Buffer.from(JSON.stringify(health));
      }}), /AUTO_SOURCE_NOT_HEALTHY/);
      assert.equal(calls, 1);
    }
    await assert.rejects(readFile(join(dir, '.upgrade', 'maintenance.json')), {code: 'ENOENT'});
  } finally {await rm(dir, {recursive: true, force: true});}
});
