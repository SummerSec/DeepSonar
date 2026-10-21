import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateAutomaticTask} from './platform-upgrade-auto-template.mjs';

test('systemd output cannot load until explicitly renamed/installed; quotes paths and specifiers', () => {
  const task = generateAutomaticTask({scheduler: 'systemd', nodePath: '/usr/bin/node', hostPath: '/opt/Deep Sonar/host.mjs', policy: '/etc/deepsonar/a%$".json'});
  assert.equal(task.enabled, false);assert.equal(task.installation, 'manual_only');
  assert.ok(Object.keys(task.files).every(name => name.endsWith('.disabled')));
  const service = task.files['deepsonar-auto-upgrade.service.disabled'];
  assert.match(service, /"\/opt\/Deep Sonar\/host.mjs" "auto" "--policy"/);
  assert.ok(service.includes('a%%$$\\".json'));
  assert.match(service, /TimeoutStartSec=infinity/);
  assert.doesNotMatch(JSON.stringify(task), /ADMIN_TOKEN|Environment=|systemctl enable/);
});

test('Windows task disabled in XML and validated by real PowerShell XML parser', {skip: spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0 ? 'pwsh unavailable' : false}, () => {
  const task = generateAutomaticTask({scheduler: 'windows', nodePath: 'C:\\Program Files\\nodejs\\node.exe', hostPath: 'C:\\Deep & Sonar\\host.mjs', policy: 'C:\\Config\\policy.json'});
  const value = task.files['deepsonar-auto-upgrade.xml'];
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', "$x=[xml][Console]::In.ReadToEnd(); if($x.Task.Settings.Enabled -ne 'false'){exit 2}; if($x.Task.Settings.ExecutionTimeLimit -ne 'PT0S'){exit 3}; if($x.Task.Actions.Exec.Command -ne 'C:\\Program Files\\nodejs\\node.exe'){exit 4}; [Console]::Write($x.Task.Actions.Exec.Arguments)"], {input: value, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '"C:\\Deep & Sonar\\host.mjs" "auto" "--policy" "C:\\Config\\policy.json"');
  assert.equal(task.enabled, false);
});

test('template refuses relative or control-character paths and unsupported schedulers', () => {
  for (const policy of ['relative.json', '/etc/a\nExecStart=/evil', '/etc/\0evil']) assert.throws(() => generateAutomaticTask({scheduler: 'systemd', policy}), /ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => generateAutomaticTask({scheduler: 'cron', policy: '/etc/policy'}), /SCHEDULER_INVALID/);
});

test('real CLI produces disabled task artifacts on stdout without installation', () => {
  const host = fileURLToPath(new URL('./platform-upgrade-host.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [host, 'auto-template', '--scheduler', 'systemd', '--policy', '/etc/deepsonar/policy.json'], {encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);assert.equal(output.enabled, false);assert.equal(Object.keys(output.files).length, 2);
});

test('systemd parses generated service and timer without starting or installing either', {skip: spawnSync('systemd-analyze', ['--version']).status !== 0 ? 'systemd-analyze unavailable' : false}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-unit-'));
  try {
    const task = generateAutomaticTask({scheduler: 'systemd', policy: '/etc/deepsonar/policy.json'}), files = [];
    for (const [name, contents] of Object.entries(task.files)) {
      const path = join(directory, name.replace(/\.disabled$/, ''));await writeFile(path, contents);files.push(path);
    }
    const result = spawnSync('systemd-analyze', ['verify', ...files], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  } finally {await rm(directory, {recursive: true, force: true});}
});
