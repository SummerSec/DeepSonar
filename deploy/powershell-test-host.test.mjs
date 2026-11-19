import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
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
    const results = await Promise.allSettled(Array.from({length: 4}, () => promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', code], {env: {...process.env, XDG_CACHE_HOME: parent}, timeout: 45_000})));
    const caches = results.map(result => {
      assert.equal(result.status, 'fulfilled', result.reason?.message);
      return result.value.stdout.trim();
    });
    const env = {...process.env, XDG_CACHE_HOME: parent}, before = {...env};
    const parentCache = process.env.XDG_CACHE_HOME;
    for (let i = 0; i < 2; i++) {
      const result = spawnPowerShellSync(command, argv(cacheCommand), {env});
      assert.equal(result.status, 0, output(result));
      caches.push(result.stdout.trim());
    }
    assert.deepEqual(env, before, 'caller environment must not be mutated');
    assert.equal(process.env.XDG_CACHE_HOME, parentCache, 'parent environment must not be mutated');
    assert.equal(new Set(caches).size, 6, 'every invocation must have a distinct startup profile');
    for (const cache of caches) {
      assert.ok(cache.endsWith('/powershell'), 'real PowerShell must return its cache directory');
      assert.notEqual(cache, join(parent, 'powershell'));
      assert.equal(existsSync(dirname(cache)), false, 'entire per-process cache root must be cleaned after exit');
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
    const seeded = spawnSync(command, argv("$null=[System.Net.Http.HttpClient]::new(); [Threading.Thread]::Sleep(1500)"), {cwd: parent, env, encoding: 'utf8', timeout: 30_000});
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
    const control = spawnSync(command, argv("[Threading.Thread]::Sleep(1500); [Console]::Write('executed')"), {cwd: parent, env, encoding: 'utf8', timeout: 30_000});
    t.diagnostic(`unisolated control: ${output(control).slice(0, 1800)}`);
    // Restore in case the control replaced the profile on clean exit.
    writeFileSync(profile, corrupt);
    const result = spawnPowerShellSync(command, argv(cacheCommand), {cwd: parent, env, encoding: 'utf8', timeout: 30_000});
    assert.equal(result.status, 0, output(result));
    assert.ok(result.stdout.trim().endsWith('/powershell'), 'isolated command must actually execute');
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
    const helper = new URL('./powershell-test-host.mjs', import.meta.url).href;
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', `import {findPowerShell} from ${JSON.stringify(helper)}; findPowerShell({commands:['absent-pwsh']});`], {env: {...env, CI: 'true'}, encoding: 'utf8', timeout: 10_000});
    assert.notEqual(missing.status, 0, 'CI must fail on missing PowerShell by default');
    assert.match(missing.stderr, /CI must provide PowerShell/);
    writeFileSync(join(bin, 'pwsh-fallback'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    for (const body of ['echo startup-broken >&2; exit 23', 'kill -TERM $$', 'exit 0']) {
      writeFileSync(join(bin, 'pwsh'), `#!/bin/sh\n${body}\n`, {mode: 0o755});
      assert.throws(() => findPowerShell({commands: ['pwsh', 'pwsh-fallback'], env, required: false}), /PowerShell startup failed \(pwsh;/);
    }
    chmodSync(join(bin, 'pwsh'), 0o644);
    assert.throws(() => findPowerShell({commands: ['pwsh'], env, required: false}), /PowerShell.*startup.*EACCES/i);
  } finally {rmSync(bin, {recursive: true, force: true});}
});

test('launcher preserves stdin, environment, cwd, exit status and timeout', t => {
  const command = host(t); if (!command) return;
  const cwd = mkdtempSync(join(tmpdir(), 'pwsh-options-'));
  try {
    mkdirSync(join(cwd, 'child'));
    const result = spawnPowerShellSync(command, argv("[Console]::Write((@{value=$env:PW_TEST_VALUE; input=[Console]::In.ReadToEnd(); child=(Test-Path ./child); cache=$env:XDG_CACHE_HOME} | ConvertTo-Json -Compress)); exit 17"),
      {cwd, env: {...process.env, PW_TEST_VALUE: 'value'}, input: 'input', encoding: 'utf8'});
    assert.equal(result.status, 17, output(result));
    const actual = JSON.parse(result.stdout);
    assert.deepEqual({value: actual.value, input: actual.input, child: actual.child}, {value: 'value', input: 'input', child: true});
    if (unix) assert.equal(existsSync(actual.cache), false, 'nonzero exit must clean its cache root');
    const log = join(cwd, 'cache-path');
    const timeout = spawnPowerShellSync(command, argv('[IO.File]::WriteAllText($env:PW_CACHE_LOG,$env:XDG_CACHE_HOME); Start-Sleep -Seconds 20'),
      {timeout: 5000, encoding: 'utf8', env: {...process.env, PW_CACHE_LOG: log}});
    assert.equal(timeout.error?.code, 'ETIMEDOUT', output(timeout));
    assert.equal(timeout.status, null);
    if (unix) assert.equal(existsSync(readFileSync(log, 'utf8')), false, 'timeout must clean its cache root');
  } finally {rmSync(cwd, {recursive: true, force: true});}
});
