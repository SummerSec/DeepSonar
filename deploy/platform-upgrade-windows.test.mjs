import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {windowsUpgradeOperation, withWindowsUpgradeLock} from './platform-upgrade-windows.mjs';

test('Windows bridge keeps paths and private bytes on stdin and suppresses native diagnostics', () => {
  let captured;
  const run = (exe,args,options) => {captured={exe,args,options};return {status:0,stdout:'{"ok":true}'};};
  windowsUpgradeOperation({action:'write',path:'C:\\private\\identity.json',contents_base64:'secret-bytes'}, {run});
  assert.equal(captured.args.includes('secret-bytes'),false);
  assert.equal(JSON.parse(captured.options.input).contents_base64,'secret-bytes');
  assert.throws(() => windowsUpgradeOperation({action:'read'}, {run:()=>({status:1,stdout:'secret-content',stderr:'secret-path'})}), error => !error.message.includes('secret-content') && !error.message.includes('secret-path'));
});
test('transferred lock survives helper completion and release is attempted once after callback failure', async () => {
  const calls=[];
  const operation=request=>{calls.push(request);if(request.action==='acquire')return {handle:'120',owner_creation:'123456'};return {ok:true};};
  await assert.rejects(withWindowsUpgradeLock('C:\\deployment\\.upgrade\\lock',async()=>{throw new Error('actor failed');},{operation,ownerPid:42}),/actor failed/);
  assert.deepEqual(calls.map(x=>x.action),['directory','acquire','release']);
  assert.deepEqual(calls[2],{action:'release',owner_pid:42,handle:'120',owner_creation:'123456'});
});
test('private I/O borrows the owner lease, and escaped callbacks cannot reuse a released handle', async () => {
  let late, observed;
  const operation=request=>request.action==='acquire'?{handle:'120',owner_creation:'123456'}:{ok:true};
  await withWindowsUpgradeLock('C:\\deployment\\lock',async()=>{
    const run=(_exe,_args,options)=>{observed=JSON.parse(options.input);return {status:0,stdout:'{"ok":true}'};};
    windowsUpgradeOperation({action:'write',path:'private',contents_base64:'secret'},{run});
    late = new Promise(resolve=>setTimeout(()=>{
      assert.throws(()=>windowsUpgradeOperation({action:'write'},{run}),/scope already closed/);resolve();
    },10));
  },{operation,ownerPid:42});
  assert.equal(observed.lock_lease.owner_pid,42);assert.equal(observed.lock_lease.handle,'120');
  await late;
});
test('uncertain release response is not retried', async () => {
  let releases=0;
  const operation=request=>{if(request.action==='acquire')return {handle:'120',owner_creation:'123456'};if(request.action==='release'){releases++;throw new Error('lost response');}return {ok:true};};
  await assert.rejects(withWindowsUpgradeLock('C:\\deployment\\lock',async()=>{},{operation}),/lost response/);
  assert.equal(releases,1);
});

test('native Windows orphaned I/O helper retains the kernel lock after owner termination', {skip:process.platform!=='win32',timeout:120000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'upgrade-windows-borrow-')),file=join(directory,'lock');
  const windowsUrl=new URL('./platform-upgrade-windows.mjs',import.meta.url).href;
  const executable=join(directory,'borrow-helper.exe'),requestFile=join(directory,'request.txt');
  const readyFile=join(directory,'ready.txt'),diagnosticFile=join(directory,'stage.json');
  const started=performance.now();
  const nativePowerShell=win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const compiled=spawnSync(nativePowerShell,['-NoLogo','-NoProfile','-NonInteractive','-Command',
    "$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -Path @($r.library,$r.fixture) -OutputAssembly $r.output -OutputType ConsoleApplication"],{
    input:JSON.stringify({library:fileURLToPath(new URL('./platform-upgrade-windows.cs',import.meta.url)),fixture:fileURLToPath(new URL('./platform-upgrade-windows-borrow-fixture.cs',import.meta.url)),output:executable}),
    encoding:'utf8',timeout:15000,windowsHide:true,
  });
  assert.equal(compiled.status,0,'native fixture compilation failed: '+String(compiled.error?.code??compiled.signal??compiled.status));
  // This watchdog has its own event loop; unlike a test timeout it still fires
  // if the test process blocks in a native call or filesystem operation.
  const watchdog=spawn(process.execPath,['-e',`
    const targets=new Set([Number(process.argv[1])]);
    process.on('message',message=>{if(message.add)targets.add(message.add);if(message.remove)targets.delete(message.remove);});
    setTimeout(()=>{process.stderr.write('native borrower fixture watchdog deadline\\n');for(const pid of [...targets].reverse())try{process.kill(pid,'SIGKILL');}catch{}process.exit(79);},45000);
  `,String(process.pid)],{stdio:['ignore','ignore','inherit','ipc']});
  const watch=message=>{if(watchdog.connected)watchdog.send(message);};
  const owner=spawn(process.execPath,['--input-type=module','-e',`
    import {spawn} from 'node:child_process';
    import {writeFile} from 'node:fs/promises';
    import {windowsUpgradeOperation,withWindowsUpgradeLock} from ${JSON.stringify(windowsUrl)};
    const diagnostic=(stage,extra={})=>process.stderr.write(JSON.stringify({stage,...extra})+'\\n');
    let lease;const operation=request=>{const result=windowsUpgradeOperation(request);if(request.action==='acquire')lease=result;return result;};
    await withWindowsUpgradeLock(process.argv[1],async()=>{
      diagnostic('owner_acquired');
      await writeFile(process.argv[3],[process.pid,lease.handle,lease.owner_creation].join('\\n'));
      const helper=spawn(process.argv[2],[process.argv[3],process.argv[4],process.argv[5]],{stdio:'ignore',detached:true,windowsHide:true});
      helper.on('spawn',()=>process.send({type:'helper_spawned',pid:helper.pid}));
      helper.on('error',error=>process.send({type:'helper_error',code:error.code??null}));
      helper.on('exit',(code,signal)=>process.send({type:'helper_exit',pid:helper.pid,code,signal}));
      await new Promise(()=>setInterval(()=>{},1000));
    },{operation});`,file,executable,requestFile,readyFile,diagnosticFile],{stdio:['ignore','ignore','pipe','ipc']});
  watch({add:owner.pid});
  let borrower,spawnedHelper,helperExit,ownerExit,ownerError;
  let diagnostics='';owner.stderr.on('data',data=>{diagnostics+=data.toString();});
  owner.on('exit',(code,signal)=>{ownerExit={code,signal};watch({remove:owner.pid});});
  owner.on('error',error=>{ownerError=error.code;});
  owner.on('message',message=>{
    if(message?.type==='helper_spawned' && Number.isSafeInteger(message.pid) && message.pid>0){spawnedHelper=message.pid;watch({add:message.pid});}
    if(message?.type==='helper_exit'){helperExit={code:message.code,signal:message.signal};if(message.pid===spawnedHelper){watch({remove:message.pid});spawnedHelper=undefined;}}
    if(message?.type==='helper_error')helperExit={code:message.code};
  });
  const stopHelper=async pid=>{
    if(!pid)return;
    try{process.kill(pid,'SIGKILL');}catch(error){if(error.code==='ESRCH')return;throw error;}
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('isolated borrower did not exit within cleanup deadline');
  };
  t.after(async()=>{
    try {if(!helperExit)await stopHelper(spawnedHelper??borrower);}
    finally {
      if(borrower)watch({remove:borrower});if(spawnedHelper)watch({remove:spawnedHelper});
      borrower=spawnedHelper=undefined;
      try{owner.kill('SIGKILL');}catch{}
      owner.stderr.destroy();if(owner.connected)owner.disconnect();
      try {await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
      finally {watchdog.kill('SIGKILL');if(watchdog.connected)watchdog.disconnect();}
    }
  });
  const readJson=async path=>{
    try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
  };
  const deadline=Date.now()+15000;
  while(!borrower){
    const ready=await readJson(readyFile);
    if(ready&&spawnedHelper){assert.equal(ready,spawnedHelper);borrower=ready;break;}
    if(t.signal.aborted||Date.now()>=deadline||ownerExit||ownerError||helperExit){
      const native=await readJson(diagnosticFile);
      throw new Error('native borrow readiness failed: '+JSON.stringify({elapsed_ms:Math.round(performance.now()-started),ownerExit,ownerError,helperExit,helper_spawned:!!spawnedHelper,stage:native?.stage,type:native?.type,hresult:native?.hresult}));
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must be alive before owner termination');
  const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must survive owner termination');
  const {withUpgradeLock}=await import('./platform-upgrade-lock.mjs');
  await assert.rejects(withUpgradeLock(file,async()=>assert.fail('orphan helper still owns the lock')),/another upgrade/);
  await stopHelper(borrower);watch({remove:borrower});borrower=spawnedHelper=undefined;
  await withUpgradeLock(file,async()=>{});
});
