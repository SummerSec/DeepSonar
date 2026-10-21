import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
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
  const library=new URL('./platform-upgrade-windows.cs',import.meta.url);
  const helperScript=join(directory,'borrow-helper.ps1'),requestFile=join(directory,'request.json');
  const readyFile=join(directory,'ready.json'),diagnosticFile=join(directory,'stage.json');
  // Detached Windows consoles did not execute the redirected-stdio fixture
  // reliably. Only isolated OS lease metadata crosses these temporary files;
  // production requests and secrets still use the unchanged stdin bridge.
  await writeFile(helperScript,`
    param([string]$RequestPath,[string]$ReadyPath,[string]$DiagnosticPath)
    $ErrorActionPreference='Stop';$stage='input';$h=[IntPtr]::Zero
    try {
      [IO.File]::WriteAllText($DiagnosticPath,'{"stage":"helper_started"}')
      $r=[IO.File]::ReadAllText($RequestPath)|ConvertFrom-Json
      $stage='compile';Add-Type -Path $r.library
      $stage='borrow';$h=[UpgradeWindows]::BorrowLease([int]$r.owner_pid,$r.handle,$r.owner_creation)
      $stage='ready';[IO.File]::WriteAllText($ReadyPath,(@{borrower=$PID}|ConvertTo-Json -Compress))
      $stage='sleep';Start-Sleep -Seconds 90
    } catch {
      [IO.File]::WriteAllText($DiagnosticPath,(@{stage=$stage;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}|ConvertTo-Json -Compress));exit 74
    } finally {if($h -ne [IntPtr]::Zero){[UpgradeWindows]::CloseLease($h)}}
  `);
  const owner=spawn(process.execPath,['--input-type=module','-e',`
    import {spawn} from 'node:child_process';import {win32} from 'node:path';import {fileURLToPath} from 'node:url';
    import {writeFile} from 'node:fs/promises';
    import {windowsUpgradeOperation,withWindowsUpgradeLock} from ${JSON.stringify(windowsUrl)};
    const diagnostic=(stage,extra={})=>process.stderr.write(JSON.stringify({stage,...extra})+'\\n');
    let lease;const operation=request=>{const result=windowsUpgradeOperation(request);if(request.action==='acquire')lease=result;return result;};
    await withWindowsUpgradeLock(process.argv[1],async()=>{
      diagnostic('owner_acquired');
      await writeFile(process.argv[3],JSON.stringify({...lease,owner_pid:process.pid,library:fileURLToPath(${JSON.stringify(library.href)})}));
      const helper=spawn(win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.argv[2],process.argv[3],process.argv[4],process.argv[5]],{stdio:'ignore',detached:true,windowsHide:true});
      helper.on('spawn',()=>process.send({type:'helper_spawned',pid:helper.pid}));
      helper.on('error',error=>process.send({type:'helper_error',code:error.code??null}));
      helper.on('exit',(code,signal)=>process.send({type:'helper_exit',pid:helper.pid,code,signal}));
      await new Promise(()=>setInterval(()=>{},1000));
    },{operation});`,file,helperScript,requestFile,readyFile,diagnosticFile],{stdio:['ignore','ignore','pipe','ipc']});
  let borrower,spawnedHelper,helperExit,ownerExit,ownerError;
  let diagnostics='';owner.stderr.on('data',data=>{diagnostics+=data.toString();});
  owner.on('exit',(code,signal)=>{ownerExit={code,signal};});
  owner.on('error',error=>{ownerError=error.code;});
  owner.on('message',message=>{
    if(message?.type==='helper_spawned' && Number.isSafeInteger(message.pid) && message.pid>0)spawnedHelper=message.pid;
    if(message?.type==='helper_exit'){helperExit={code:message.code,signal:message.signal};if(message.pid===spawnedHelper)spawnedHelper=undefined;}
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
      borrower=spawnedHelper=undefined;
      try{owner.kill('SIGKILL');}catch{}
      owner.stderr.destroy();if(owner.connected)owner.disconnect();
      await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    }
  });
  const readJson=async path=>{
    try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
  };
  const deadline=Date.now()+30000;
  while(!borrower){
    const ready=await readJson(readyFile);
    if(ready&&spawnedHelper){assert.equal(ready.borrower,spawnedHelper);borrower=ready.borrower;break;}
    if(t.signal.aborted||Date.now()>=deadline||ownerExit||ownerError||helperExit){
      const native=await readJson(diagnosticFile);
      throw new Error('native borrow readiness failed: '+JSON.stringify({ownerExit,ownerError,helperExit,helper_spawned:!!spawnedHelper,stage:native?.stage,type:native?.type,hresult:native?.hresult}));
    }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must be alive before owner termination');
  const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must survive owner termination');
  const {withUpgradeLock}=await import('./platform-upgrade-lock.mjs');
  await assert.rejects(withUpgradeLock(file,async()=>assert.fail('orphan helper still owns the lock')),/another upgrade/);
  await stopHelper(borrower);borrower=spawnedHelper=undefined;
  await withUpgradeLock(file,async()=>{});
});
