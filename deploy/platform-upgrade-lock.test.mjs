import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {withUpgradeLock} from './platform-upgrade-lock.mjs';

const moduleUrl = new URL('./platform-upgrade-lock.mjs', import.meta.url).href;
const linux = {skip: process.platform !== 'linux', timeout: 15000};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'upgrade-lock-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, 'upgrade.lock');
}
function owner(file) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    import {withUpgradeLock} from ${JSON.stringify(moduleUrl)};
    await withUpgradeLock(process.argv[1], async () => {
      process.stdout.write('LOCKED\\n');
      await new Promise(resolve => process.stdin.on('end',resolve).resume());
    });`, file], {stdio: ['pipe', 'pipe', 'pipe']});
}
async function ready(child) {
  const result = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString()),
    once(child, 'exit').then(([code]) => {throw new Error(`lock owner exited ${code}`);}),
  ]);
  assert.equal(result, 'LOCKED\n');
}
async function contender(file) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withUpgradeLock} from ${JSON.stringify(moduleUrl)};
    try {await withUpgradeLock(process.argv[1], async()=>{});} catch {process.exitCode=73;}
  `, file], {stdio: 'ignore'});
  return (await once(child, 'exit'))[0];
}
test('flock child exits but parent fd retains cross-process exclusion', linux, async t => {
  const file = await fixture(t), child = owner(file);
  t.after(() => child.kill('SIGKILL'));
  await ready(child);
  assert.equal(await contender(file), 73);
  assert.equal(await contender(file), 73);
  const exited = once(child, 'exit'); child.stdin.end();
  assert.equal((await exited)[0], 0);
  assert.equal(await contender(file), 0);
  assert.equal((await stat(file)).isFile(), true);
});
test('SIGKILL releases kernel lock without deleting stale file', linux, async t => {
  const file = await fixture(t), child = owner(file);
  t.after(() => child.kill('SIGKILL'));
  await ready(child);
  assert.equal(await contender(file), 73);
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  assert.equal(await contender(file), 0);
});
test('callback failure releases lock and same-process parallel call is excluded', linux, async t => {
  const file = await fixture(t);
  await assert.rejects(withUpgradeLock(file, async () => {
    await assert.rejects(withUpgradeLock(file, async () => assert.fail('must not run')), /another upgrade/);
    throw new Error('actor failed');
  }), /actor failed/);
  assert.equal(await withUpgradeLock(file, async () => 'recovered'), 'recovered');
});
test('missing flock fails before invoking the action', linux, async t => {
  const file = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withUpgradeLock} from ${JSON.stringify(moduleUrl)};
    let invoked=false;
    try {await withUpgradeLock(process.argv[1],async()=>{invoked=true;});process.exitCode=1;}
    catch(error){if(invoked || !error.message.includes('flock is unavailable'))process.exitCode=2;}
  `, file], {stdio: 'ignore', env: {...process.env, PATH: '/nonexistent-upgrade-lock-test-bin'}});
  assert.equal((await once(child, 'exit'))[0], 0);
});
