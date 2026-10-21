import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
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
  const helperScript=join(directory,'borrow-helper.ps1');
  // Match the production bridge's -File entry point. A detached Windows
  // PowerShell -Command child exited 0 without running its command in CI.
  await writeFile(helperScript,`
    $ErrorActionPreference='Stop'
    $stage='input';$h=[IntPtr]::Zero
    try {
      [Console]::Error.WriteLine('{"stage":"helper_started"}')
      $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
      $stage='compile';Add-Type -Path $r.library
      $stage='borrow';$h=[UpgradeWindows]::BorrowLease([int]$r.owner_pid,$r.handle,$r.owner_creation)
      $stage='ready';[Console]::Out.WriteLine((@{borrower=$PID}|ConvertTo-Json -Compress))
      $stage='sleep';Start-Sleep -Seconds 90
    } catch {
      [Console]::Error.WriteLine((@{stage=$stage;type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}|ConvertTo-Json -Compress));exit 74
    } finally {if($h -ne [IntPtr]::Zero){[UpgradeWindows]::CloseLease($h)}}
  `);
  const owner=spawn(process.execPath,['--input-type=module','-e',`
    import {spawn} from 'node:child_process';import {win32} from 'node:path';import {fileURLToPath} from 'node:url';
    import {windowsUpgradeOperation,withWindowsUpgradeLock} from ${JSON.stringify(windowsUrl)};
    const diagnostic=(stage,extra={})=>process.stderr.write(JSON.stringify({stage,...extra})+'\\n');
    process.on('uncaughtException',error=>{diagnostic('owner_exception',{code:error.code??null,name:error.name});process.exit(1);});
    process.on('beforeExit',code=>diagnostic('owner_before_exit',{code}));
    let lease;const operation=request=>{const result=windowsUpgradeOperation(request);if(request.action==='acquire')lease=result;return result;};
    await withWindowsUpgradeLock(process.argv[1],async()=>{
      diagnostic('owner_acquired');
      // Keep the helper's output connected directly to the test reader. An
      // owner-owned forwarding pipe would close when we kill that owner and
      // could terminate PowerShell before testing the borrowed lock.
      // Windows/libuv ties ordinary children to the owner's lifetime. Detach
      // this test helper so there really is a live orphan after owner death.
      const helper=spawn(win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.argv[2]],{stdio:['pipe','inherit','inherit'],detached:true,windowsHide:true});
      helper.on('spawn',()=>diagnostic('helper_spawned'));
      helper.on('error',error=>diagnostic('helper_error',{code:error.code??null}));
      helper.on('exit',(code,signal)=>diagnostic('helper_exit',{code,signal}));
      helper.stdin.on('error',error=>diagnostic('helper_stdin_error',{code:error.code??null}));
      helper.stdin.end(JSON.stringify({...lease,owner_pid:process.pid,library:fileURLToPath(${JSON.stringify(library.href)})}));
      await new Promise(()=>{});
    },{operation});`,file,helperScript],{stdio:['pipe','pipe','pipe']});
  let diagnostics='';owner.stderr.on('data',data=>{diagnostics+=data.toString();});
  const safeDiagnostics=()=>diagnostics.split(/\r?\n/).flatMap(line=>{
    try {const {stage,code,signal,type,hresult,name}=JSON.parse(line);return typeof stage==='string'?[{stage,code,signal,type,hresult,name}]:[];}catch{return [];}
  }).slice(-12);
  let borrower;
  t.after(async()=>{try{owner.kill('SIGKILL');}catch{}if(borrower)try{process.kill(borrower,'SIGKILL');}catch{}await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
  const data=await Promise.race([once(owner.stdout,'data'),once(owner,'exit').then(([code,signal])=>{throw new Error('native owner failed before borrowing: '+JSON.stringify({code,signal,diagnostics:safeDiagnostics()}));})]);
  borrower=JSON.parse(data[0].toString()).borrower;
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must be alive before owner termination');
  const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
  assert.doesNotThrow(()=>process.kill(borrower,0),'borrower must survive owner termination');
  const {withUpgradeLock}=await import('./platform-upgrade-lock.mjs');
  await assert.rejects(withUpgradeLock(file,async()=>assert.fail('orphan helper still owns the lock')),/another upgrade/);
  process.kill(borrower,'SIGKILL');borrower=null;
  await withUpgradeLock(file,async()=>{});
});
