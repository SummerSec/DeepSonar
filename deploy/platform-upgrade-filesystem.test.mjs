import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {durablePrivateWrite,readPrivateJson,durableRename,assertDirectoryDurability,assertPrivateFile,ensurePrivateDirectory} from './platform-upgrade-filesystem.mjs';

async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'upgrade-private-fs-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return directory;}
test('private durable JSON replacement and archival preserve contents and reject invalid JSON', {timeout:120000},async t=>{
  const directory=await fixture(t),file=join(directory,'identity.json');
  await assertDirectoryDurability(directory);await ensurePrivateDirectory(directory);
  assert.equal(await readPrivateJson(file),null);
  await durablePrivateWrite(file,JSON.stringify({generation:1}));await assertPrivateFile(file);
  await durablePrivateWrite(file,JSON.stringify({generation:2}));assert.deepEqual(await readPrivateJson(file),{generation:2});
  await durableRename(file,join(directory,'archive.json'));
  assert.deepEqual(await readPrivateJson(join(directory,'archive.json')),{generation:2});
  await durablePrivateWrite(file,'malformed');await assert.rejects(readPrivateJson(file));
});
test('native Windows private file ACL rejects extra readers; atomic rewrite restores private ACL', {skip:process.platform!=='win32',timeout:120000},async t=>{
  const directory=await fixture(t),file=join(directory,'identity.json');
  await durablePrivateWrite(file,'{"private":"isolated-test"}');await assertPrivateFile(file);
  const grant=spawnSync('icacls.exe',[file,'/grant','*S-1-1-0:(R)'],{encoding:'utf8',windowsHide:true});assert.equal(grant.status,0);
  await assert.rejects(assertPrivateFile(file));await assert.rejects(readPrivateJson(file));
  await durablePrivateWrite(file,'{"private":"replacement"}');await assertPrivateFile(file);
  assert.deepEqual(await readPrivateJson(file),{private:'replacement'});
});
test('native Windows rejects reparse ancestors before reading or replacing a private file', {skip:process.platform!=='win32',timeout:120000},async t=>{
  const directory=await fixture(t),real=join(directory,'real'),link=join(directory,'linked');await mkdir(real);
  await durablePrivateWrite(join(real,'identity.json'),'{}');await symlink(real,link,'junction');
  await assert.rejects(assertPrivateFile(join(link,'identity.json')));
  await assert.rejects(durablePrivateWrite(join(link,'identity.json'),'replacement'));
  await assert.rejects(assertDirectoryDurability(link));
  assert.equal(await readFile(join(real,'identity.json'),'utf8'),'{}');
});
test('native Windows unreadable existing journal is an error, never an absent journal', {skip:process.platform!=='win32',timeout:120000},async t=>{
  const directory=await fixture(t),file=join(directory,'journal.json');
  await durablePrivateWrite(file,'{"generation":"existing"}');
  const identity=spawnSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
  assert.equal(identity.status,0);
  const sid=identity.stdout.match(/S-1-[0-9-]+/)?.[0];assert.ok(sid);
  const deny=spawnSync('icacls.exe',[file,'/deny',`*${sid}:(R)`],{encoding:'utf8',windowsHide:true});
  try {
    assert.equal(deny.status,0);
    await assert.rejects(readPrivateJson(file),/Windows upgrade backend failed/);
  } finally {
    const restore=spawnSync('icacls.exe',[file,'/remove:d',`*${sid}`],{encoding:'utf8',windowsHide:true});
    assert.equal(restore.status,0);
  }
  assert.deepEqual(await readPrivateJson(file),{generation:'existing'});
});
