import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {findPowerShell, spawnPowerShellSync} from './powershell-test-host.mjs';

const unix = process.platform !== 'win32';
const cacheCommand = "$cache=[psobject].Assembly.GetType('System.Management.Automation.Platform').GetField('CacheDirectory',[Reflection.BindingFlags]'NonPublic,Static').GetValue($null); [Console]::Write($cache)";
const argv = command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
const output = result => `${result.error ?? ''}\nstatus=${result.status} signal=${result.signal}\n${result.stdout}\n${result.stderr}`;

function host(t) {
  const command = findPowerShell({commands: ['pwsh']});
  if (!command) t.skip('pwsh is not installed');
  return command;
}

test('parallel real PowerShell starts use distinct caches and remove only their own directories', {skip: !unix}, async t => {
  const command = host(t); if (!command) return;
  const parent = mkdtempSync(join(tmpdir(), 'pwsh-parent-cache-'));
  try {
    const sentinel = join(parent, 'keep'); writeFileSync(sentinel, 'parent cache');
    const helper = new URL('./powershell-test-host.mjs', import.meta.url).href;
    const code = `import {spawnPowerShellSync} from ${JSON.stringify(helper)};
      const result=spawnPowerShellSync(${JSON.stringify(command)}, ${JSON.stringify(argv(cacheCommand))}, {encoding:'utf8'});
      if(result.status!==0) throw new Error(JSON.stringify(result));
      process.stdout.write(result.stdout);`;
    const results = await Promise.all(Array.from({length: 4}, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code], {env: {...process.env, XDG_CACHE_HOME: parent}, timeout: 30_000})));
    const caches = results.map(result => result.stdout.trim());
    assert.equal(new Set(caches).size, 4, 'parallel processes must not share a startup profile');
    for (const cache of caches) {
      assert.notEqual(cache, join(parent, 'powershell'));
      assert.equal(existsSync(cache), false, 'per-process cache must be cleaned after exit');
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'parent cache');
  } finally {rmSync(parent, {recursive: true, force: true});}
});

test('real PowerShell ignores a corrupted inherited startup profile without modifying it', {skip: !unix}, t => {
  const command = host(t); if (!command) return;
  const parent = mkdtempSync(join(tmpdir(), 'pwsh-corrupt-cache-'));
  try {
    const env = {...process.env, XDG_CACHE_HOME: parent};
    // Seed with the real runtime, then damage one assembly-name byte, preserving
    // record lengths. This reproduces PowerShell#26528 / dotnet/runtime#121977.
    const seeded = spawnSync(command, argv("$null=[System.Net.Http.HttpClient]::new(); [Threading.Thread]::Sleep(1500)"), {env, encoding: 'utf8', timeout: 30_000});
    assert.equal(seeded.status, 0, output(seeded));
    const profile = join(parent, 'powershell', 'StartupProfileData-NonInteractive');
    const corrupt = readFileSync(profile);
    const assembly = corrupt.indexOf(Buffer.from('System.Net.Http, Version='));
    assert.ok(assembly >= 0, 'real startup profile must contain the seeded assembly');
    const token = corrupt.indexOf(Buffer.from('PublicKeyToken='), assembly);
    assert.ok(token >= 0, 'assembly display name must contain a public key token');
    corrupt[token + 'PublicKeyToken='.length + 2] = 0x90;
    writeFileSync(profile, corrupt);
    // The negative control is diagnostic: an upstream fix must not break this
    // regression, which requires isolation rather than continued upstream crashes.
    const control = spawnSync(command, argv("[Threading.Thread]::Sleep(1500); [Console]::Write('executed')"), {env, encoding: 'utf8', timeout: 30_000});
    t.diagnostic(`unisolated control: ${output(control).slice(0, 1800)}`);
    // Restore in case the control replaced the profile on clean exit.
    writeFileSync(profile, corrupt);
    const result = spawnPowerShellSync(command, argv(cacheCommand), {env, encoding: 'utf8', timeout: 30_000});
    assert.equal(result.status, 0, output(result));
    assert.notEqual(result.stdout.trim(), join(parent, 'powershell'));
    assert.deepEqual(readFileSync(profile), corrupt, 'inherited cache is untouched');
  } finally {rmSync(parent, {recursive: true, force: true});}
});

test('availability skips only missing executables; installed host errors and signals fail', {skip: !unix}, () => {
  const bin = mkdtempSync(join(tmpdir(), 'pwsh-probe-'));
  try {
    const env = {...process.env, PATH: bin};
    assert.equal(findPowerShell({commands: ['absent-pwsh'], env, required: false}), null);
    assert.throws(() => findPowerShell({commands: ['absent-pwsh'], env, required: true}), /PowerShell/);
    for (const body of ['echo startup-broken >&2; exit 23', 'kill -TERM $$', 'exit 0']) {
      writeFileSync(join(bin, 'pwsh'), `#!/bin/sh\n${body}\n`, {mode: 0o755});
      assert.throws(() => findPowerShell({commands: ['pwsh'], env, required: false}), /PowerShell.*startup/i);
    }
  } finally {rmSync(bin, {recursive: true, force: true});}
});

test('launcher preserves stdin, environment, cwd, exit status and timeout', t => {
  const command = host(t); if (!command) return;
  const cwd = mkdtempSync(join(tmpdir(), 'pwsh-options-'));
  try {
    mkdirSync(join(cwd, 'child'));
    const result = spawnPowerShellSync(command, argv("[Console]::Write($env:PW_TEST_VALUE + ':' + [Console]::In.ReadToEnd() + ':' + (Test-Path ./child)); exit 17"),
      {cwd, env: {...process.env, PW_TEST_VALUE: 'value'}, input: 'input', encoding: 'utf8'});
    assert.equal(result.status, 17, output(result));
    assert.equal(result.stdout, 'value:input:True');
    const timeout = spawnPowerShellSync(command, argv('Start-Sleep -Seconds 20'), {timeout: 1000, encoding: 'utf8'});
    assert.equal(timeout.error?.code, 'ETIMEDOUT', output(timeout));
    assert.equal(timeout.status, null);
  } finally {rmSync(cwd, {recursive: true, force: true});}
});
