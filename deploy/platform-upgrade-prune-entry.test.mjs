import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {findPowerShell, spawnPowerShellSync} from './powershell-test-host.mjs';

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
