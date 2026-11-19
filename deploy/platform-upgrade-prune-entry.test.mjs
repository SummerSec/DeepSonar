import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPowerShell, spawnPowerShellSync} from './powershell-test-host.mjs';
import {collectRuntimeDatabaseReferences} from './platform-upgrade-prune-host.mjs';

test('actual running and stopped Compose container environments retain databases without sessions', () => {
  const containers = ['running', 'exited'].map((status, index) => ({State: {Status: status}, Config: {
    Labels: {'com.docker.compose.project': 'fixture'}, Env: [`DATABASE_URL=postgres://runtime:private@postgres:5432/database_${index}`]}}));
  const references = () => collectRuntimeDatabaseReferences({projectName: 'fixture', source: {host: 'postgres', port: 5432},
    dc: args => {assert.deepEqual(args, ['ps', '--all', '-q']); return Buffer.from(`${'a'.repeat(64)}\n${'b'.repeat(64)}`);},
    run: args => {assert.deepEqual(args, ['inspect', 'a'.repeat(64), 'b'.repeat(64)]); return Buffer.from(JSON.stringify(containers));}});
  assert.deepEqual(references(), ['database_0', 'database_1']);
  containers[1].Config.Env = ['DATABASE_URL=postgres://runtime:private@elsewhere:5432/database_1'];
  assert.throws(references, /PRUNE_CONTAINER_DATABASE_UNBOUND/);
  containers[1].Config.Labels['com.docker.compose.project'] = 'another';
  assert.throws(references, /PRUNE_CONTAINER_BINDING_INVALID/);
});

test('both deployment entry points forward explicit prune apply and approved hash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prune-entry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await copyFile(new URL('./deploy.sh', import.meta.url), join(directory, 'deploy.sh'));
  await copyFile(new URL('./deploy.ps1', import.meta.url), join(directory, 'deploy.ps1'));
  await writeFile(join(directory, 'platform-upgrade-host.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  const approved = 'a'.repeat(64);
  for (const apply of [false, true]) {
    const expected = ['prune-generations', ...(apply ? ['--approve-plan-hash', approved, '--apply'] : [])];
    const bash = spawnSync('bash', [join(directory, 'deploy.sh'), 'upgrade', 'prune-generations',
      ...(apply ? ['--approve-plan-hash', approved, '--apply'] : [])], {encoding: 'utf8', timeout: 30_000});
    assert.equal(bash.status, 0, bash.stderr);
    assert.deepEqual(JSON.parse(bash.stdout), expected);
    const powershell = findPowerShell();
    assert.ok(powershell, 'CI must provide PowerShell for the normal Windows entry');
    const ps = spawnPowerShellSync(powershell, ['-NoProfile', '-File', join(directory, 'deploy.ps1'), 'upgrade', 'prune-generations',
      ...(apply ? ['-ApprovePlanHash', approved, '-PruneApply'] : [])]);
    assert.equal(ps.status, 0, ps.stderr);
    assert.deepEqual(JSON.parse(ps.stdout), expected);
  }
});
