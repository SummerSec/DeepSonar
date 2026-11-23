import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { config } from "../../config.js";
import { captureCheckpointFiles, checkpointHash, HumanCheckpointManifest, putCheckpointFile, readCheckpointFile, restoreCheckpointFiles,
  HUMAN_CHECKPOINT_FILE_BYTES } from "./human-checkpoint-files.js";
import { checkpointQuiescenceScript } from "./human-checkpoint-process.js";
import { CHECKPOINT_MUTATION_GUARD } from "./human-checkpoint-mutation.js";
import { checkpointGuardFixture } from "./human-checkpoint-fixture.js";
import { checkpointManagedSecrets } from "./human-checkpoint.js";
import { collectCheckpointCredentialValues } from "./human-checkpoint-secrets.js";

test("Linux checkpoint scanner retains only owner execute with owner read/write", {skip:process.platform==='win32'},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'checkpoint-mode-'));
  const previous=config.storage.blobDir;
  Reflect.set(config.storage,'blobDir',path.join(directory,'blobs'));
  const workspace=path.join(directory,'workspace');
  await mkdir(workspace);
  const content=Buffer.from('#!/bin/sh\nprintf checkpoint-restored');
  const sourceModes=[0o644,0o755,0o777,0o4755,0o2755,0o1777,0o650,0o641];
  const host={
    run:async(command:string)=>{
      // Process isolation has its own regressions. Execute the real scanner on a private directory.
      const scanner=command.replace(checkpointQuiescenceScript(['90001:12345']),'').replaceAll('/workspace',workspace);
      const result=spawnSync('/bin/sh',['-c',scanner],{encoding:'utf8',timeout:5000});
      return {exitCode:result.status??1,stdout:result.stdout,stderr:result.stderr};
    },
    runAsync:async()=>checkpointGuardFixture(),
    readWorkspaceFile:async(filename:string)=>readFile(filename.replace('/workspace',workspace)),
  } as unknown as RuntimeHost;
  try {
    for(const mode of sourceModes) {
      const name=`file-${mode.toString(8)}.sh`;
      await writeFile(path.join(workspace,name),content);
      await chmod(path.join(workspace,name),mode);
    }
    const captured=await captureCheckpointFiles(host,randomUUID(),[],[],[]);
    assert.deepEqual(captured.map(file=>({...file,sha256:'digest'})).sort((a,b)=>a.path.localeCompare(b.path)),
      sourceModes.map(mode=>({path:`file-${mode.toString(8)}.sh`,bytes:content.length,sha256:'digest',mode:0o600|(mode&0o100)}))
        .sort((a,b)=>a.path.localeCompare(b.path)));
  } finally {
    Reflect.set(config.storage,'blobDir',previous);
    await rm(directory,{recursive:true,force:true});
  }
});

test("checkpoint restore executes captured Linux scripts and rejects hostile destinations",{skip:process.platform==='win32'},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'checkpoint-restore-'));
  const source=path.join(directory,'source'),destination=path.join(directory,'destination');
  await mkdir(source);await mkdir(destination);
  const previous=config.storage.blobDir;
  Reflect.set(config.storage,'blobDir',path.join(directory,'blobs'));
  let uploads=0;
  function localHost(root:string):RuntimeHost {
    return {
      run:async(command:string)=>{
        const executable=command.replace(checkpointQuiescenceScript(['90001:12345']),'').replaceAll('/workspace',root);
        const result=spawnSync('/bin/sh',['-c',executable],{encoding:'utf8',timeout:5000});
        return {exitCode:result.status??1,stdout:result.stdout,stderr:result.stderr};
      },
      runAsync:async()=>checkpointGuardFixture(),
      readWorkspaceFile:async(filename:string)=>readFile(filename.replace('/workspace',root)),
      uploadFile:async(bytes:Buffer,filename:string)=>{
        uploads++;
        const target=filename.replace('/workspace',root);
        await mkdir(path.dirname(target),{recursive:true});
        await writeFile(target,bytes,{mode:0o666});
        await chmod(target,0o666); // Simulate an uploader that drops executable bits and grants extra access.
      },
    } as unknown as RuntimeHost;
  }
  try {
    const filename="nested/run '$(touch injected).sh";
    await mkdir(path.join(source,'nested'));
    await writeFile(path.join(source,filename),'#!/bin/sh\nprintf checkpoint-restored\n');
    await chmod(path.join(source,filename),0o755);
    await writeFile(path.join(source,'notes.txt'),'unfinished work');
    const requestId=randomUUID();
    const files=await captureCheckpointFiles(localHost(source),requestId,[],[],[]);
    await restoreCheckpointFiles(localHost(destination),requestId,files);
    assert.equal((await lstat(path.join(destination,filename))).mode&0o7777,0o700);
    assert.equal((await lstat(path.join(destination,'notes.txt'))).mode&0o7777,0o600);
    const executed=spawnSync(path.join(destination,filename),[],{cwd:destination,encoding:'utf8'});
    assert.equal(executed.status,0,executed.stderr);
    assert.equal(executed.stdout,'checkpoint-restored');
    await assert.rejects(lstat(path.join(destination,'injected')),/ENOENT/);
    const entry=files.find(file=>file.path===filename)!;
    for(const unsafePath of ['../escape','/etc/passwd','.ssh/id_rsa','.deepsonar/control-token','nested/.env']) {
      const before=uploads;
      await assert.rejects(restoreCheckpointFiles(localHost(destination),requestId,[{...entry,path:unsafePath}]));
      assert.equal(uploads,before,'unsafe manifest must fail before any upload');
    }
    const outside=path.join(directory,'outside');await mkdir(outside);
    const protectedFile=path.join(outside,'protected');await writeFile(protectedFile,'protected',{mode:0o600});
    await symlink(outside,path.join(destination,'linked-parent'));
    await symlink(protectedFile,path.join(destination,'linked-file'));
    await link(protectedFile,path.join(destination,'hard-file'));
    for(const unsafePath of ['linked-parent/protected','linked-file','hard-file']) {
      const before=uploads;
      await assert.rejects(restoreCheckpointFiles(localHost(destination),requestId,[{...entry,path:unsafePath}]),/RESTORE_FAILED/);
      assert.equal(uploads,before,'links must be rejected before upload');
    }
    assert.equal(await readFile(protectedFile,'utf8'),'protected');
    assert.equal((await lstat(protectedFile)).mode&0o7777,0o600);
    const corrupted={...localHost(destination),uploadFile:async(bytes:Buffer,filename:string)=>{
      await localHost(destination).uploadFile(Buffer.alloc(bytes.length),filename);
    }};
    await assert.rejects(restoreCheckpointFiles(corrupted,requestId,[{...entry,path:'corrupt.sh'}]),/RESTORE_FAILED/);
    assert.equal((await lstat(path.join(destination,'corrupt.sh'))).mode&0o100,0,'unverified bytes cannot become executable');
    const failed={...localHost(destination),run:async()=>({exitCode:1,stdout:'',stderr:'private failure'})};
    await assert.rejects(restoreCheckpointFiles(failed,requestId,[entry]),/^Error: HUMAN_CHECKPOINT_RESTORE_FAILED$/);
  } finally {
    Reflect.set(config.storage,'blobDir',previous);
    await rm(directory,{recursive:true,force:true});
  }
});

test("fork chains must converge to a stable stopped set or fail closed",{skip:process.platform==='win32'},()=>{
  for(const unbounded of [false,true]) {
    const script=`import os,json,io,signal
from unittest.mock import patch
processes={1:['S',0,11],20:['S',1,200],30:['S',1,300]}
stopped=[]
def read_stat(filename,*arguments,**keywords):
 pid=int(filename.split('/')[2])
 state,parent,start=processes[pid]
 return io.StringIO(str(pid)+' (worker) '+state+' '+str(parent)+' '+'0 '*17+str(start))
def stop_process(pid,action):
 assert action==signal.SIGSTOP
 if ${unbounded?'True':'False'} or pid<38: processes[pid+1]=['S',1,(pid+1)*10]
 stopped.append(pid)
 processes[pid][0]='T'
blocked=False
with patch('builtins.open',read_stat),patch('os.listdir',side_effect=lambda directory:[str(pid) for pid in processes]),patch('os.getpid',return_value=20),patch('os.kill',stop_process):
 try: exec(${JSON.stringify(checkpointQuiescenceScript(['1:11']))})
 except RuntimeError as failure:
  assert str(failure)=='HUMAN_CHECKPOINT_PROCESS_NOT_QUIESCENT'
  blocked=True
assert blocked==${unbounded?'True':'False'}
if not blocked: assert set(stopped)==set(range(30,39)),stopped
`;
    const result=spawnSync('python3',['-c',script],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
  }
});

test("Linux kernel watch rejects a file added after candidate discovery",{skip:process.platform==='win32'},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'human-watch-'));
  try {
    for(const change of [false,true]) {
      const child=spawn('python3',['-c',CHECKPOINT_MUTATION_GUARD,directory],{stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='',readyResolve!:()=>void;
      const ready=new Promise<void>(resolve=>{readyResolve=resolve;});
      child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.includes('\n')) readyResolve();});
      child.stderr.on('data',chunk=>{stderr+=String(chunk);});
      const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      const timer=setTimeout(()=>child.kill(),5000);
      try {
        await Promise.race([ready,closed.then(()=>{throw new Error(stderr||'watch unavailable');})]);
        if(change) await writeFile(path.join(directory,'late-business-file.txt'),'new progress');
        child.stdin.end('seal\n');assert.equal(await closed,0,stderr);
        const result=JSON.parse(stdout.trim().split('\n').at(-1)!);
        assert.equal(result.sealed,!change,'kernel events must catch files absent from the manifest candidates');
      } finally {clearTimeout(timer);child.kill();}
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("host quiescence protects baseline and ancestor identities, but freezes a reused PID", {skip:process.platform==='win32'},()=>{
  const script=`import os,json,io,signal,types
from unittest.mock import patch
processes={1:['S',0,11],10:['S',1,999],20:['S',1,200],30:['S',1,300]}
stopped=[]
def read_stat(filename,*arguments,**keywords):
 pid=int(filename.split('/')[2])
 state,parent,start=processes[pid]
 return io.StringIO(str(pid)+' (worker) '+state+' '+str(parent)+' '+'0 '*17+str(start))
def stop_process(pid,action):
 assert action==signal.SIGSTOP
 stopped.append(pid)
 processes[pid][0]='T'
with patch('builtins.open',read_stat),patch('os.listdir',return_value=['1','10','20','30']),patch('os.getpid',return_value=20),patch('os.kill',stop_process):
 exec(${JSON.stringify(checkpointQuiescenceScript(['1:11','10:100']))})
assert set(stopped)=={10,30},stopped
assert processes[10][0]=='T' and processes[30][0]=='T'
`;
  const result=spawnSync('python3',['-c',script],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  assert.throws(()=>checkpointQuiescenceScript(['1:11;unsafe']),/./);
});

test("structured checkpoints reject unsafe paths, duplicate names and excessive bytes", () => {
  const manifest = { v: 2, job_id: randomUUID(), attempt_id: randomUUID(), request_id: randomUUID(),
    snapshot_sha256: "a".repeat(64), mode: "structured", files: [] as unknown[] };
  const file = { path: "src/work.txt", bytes: 1, sha256: "b".repeat(64), mode: 0o600 };
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [file] }).success, true);
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [{...file,mode:0o700}] }).success, true);
  for(const mode of [undefined,null,0,0o100,0o400,0o644,0o755,0o777,0o4600,0o2700,0o1700,-1,384.5,'0700']) {
    assert.equal(HumanCheckpointManifest.safeParse({...manifest,files:[{...file,mode}]}).success,false,`mode ${String(mode)}`);
  }
  assert.equal(HumanCheckpointManifest.safeParse({...manifest,v:1,files:[file]}).success,false,'frozen v1 must not be silently upgraded');
  for (const filePath of ["/etc/passwd", "../escape", "a/../escape", "a\\b", ".deepsonar/inbox/x", ".ssh/id_rsa",
    ".claude/config.json", ".pi/auth.json", "config/.env.local", "tokens.json", "a\0b", "C:/escape"]) {
    assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [{ ...file, path: filePath }] }).success, false, filePath);
  }
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [file, file] }).success, false);
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [{ ...file, bytes: HUMAN_CHECKPOINT_FILE_BYTES + 1 }] }).success, false);
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest,
    files: Array.from({ length: 9 }, (_, index) => ({ ...file, path: `file-${index}`, bytes: HUMAN_CHECKPOINT_FILE_BYTES })) }).success, false);
});

test("capture checks source hashes and secrets; reads reject corruption and missing local storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "human-checkpoint-"));
  const previous = config.storage.blobDir;
  Reflect.set(config.storage, "blobDir", directory);
  const requestId = randomUUID(), bytes = Buffer.from("retained work\0\xff"), filePath = "src/result.bin";
  const host = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([
    { path: filePath, bytes: bytes.length, sha256: checkpointHash(bytes), mode:0o600 }]), stderr: "" }),
    runAsync:async()=>checkpointGuardFixture(),
    readWorkspaceFile: async (requested: string) => { assert.equal(requested, `/workspace/${filePath}`); return bytes; },
  } as unknown as RuntimeHost;
  try {
    await assert.rejects(captureCheckpointFiles(host, requestId, [], []), /PROCESS_BASELINE_UNAVAILABLE/);
    const files = await captureCheckpointFiles(host, requestId, [], [], []);
    assert.equal(files.length, 1);
    assert.deepEqual(await readCheckpointFile(requestId, files[0]), bytes);
    await assert.rejects(captureCheckpointFiles(host, randomUUID(), [], ["retained"], []), /SECRET_DETECTED/);
    const backgroundToken='independent-om-fixture-token',backgroundBytes=Buffer.from(backgroundToken),backgroundRequest=randomUUID();
    const backgroundHost={...host,run:async()=>({exitCode:0,stderr:'',stdout:JSON.stringify([
      {path:filePath,bytes:backgroundBytes.length,sha256:checkpointHash(backgroundBytes),mode:0o600}])}),readWorkspaceFile:async()=>backgroundBytes};
    const managed=checkpointManagedSecrets({DEEPSONAR_GATEWAY_TOKEN:'different-main-fixture-token'},{},[backgroundToken]);
    assert.ok(checkpointManagedSecrets({}, {'auth.json':JSON.stringify({api_key:'config-only-secret'})},[]).includes('config-only-secret'));
    await assert.rejects(captureCheckpointFiles(backgroundHost,backgroundRequest,[],managed,[]),/SECRET_DETECTED/);
    await assert.rejects(readCheckpointFile(backgroundRequest,{bytes:backgroundBytes.length,sha256:checkpointHash(backgroundBytes)}),/FILE_UNAVAILABLE/);
    const changed = { ...host, readWorkspaceFile: async () => Buffer.alloc(bytes.length) };
    await assert.rejects(captureCheckpointFiles(changed, randomUUID(), [], [], []), /FILE_CHANGED/);
    const hostile = { ...host, run: async () => ({ exitCode: 0, stdout: JSON.stringify([
      { path: "../escape", bytes: 1, sha256: "a".repeat(64) }]), stderr: "" }) };
    await assert.rejects(captureCheckpointFiles(hostile, randomUUID(), [], [], []));
    const stored = await putCheckpointFile(requestId, bytes);
    await writeFile(path.join(directory, "human-checkpoints", requestId, stored.sha256), Buffer.alloc(bytes.length));
    await assert.rejects(readCheckpointFile(requestId, stored), /HASH_MISMATCH/);
    await assert.rejects(readCheckpointFile(randomUUID(), stored), /FILE_UNAVAILABLE/);
  } finally { Reflect.set(config.storage, "blobDir", previous); await rm(directory, { recursive: true, force: true }); }
});

test("checkpoint secret extraction recognizes only the defined numeric Claude environment cap", () => {
  const cap = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8" };
  assert.deepEqual(checkpointManagedSecrets(cap, {}, [], "claude-code"), []);
  assert.deepEqual(checkpointManagedSecrets(cap, {}, []), ["8"]);
  assert.deepEqual(checkpointManagedSecrets(cap, {}, [], "pi"), ["8"]);
  assert.deepEqual(checkpointManagedSecrets({}, { "settings.json": JSON.stringify({ env: cap }) }, [], "claude-code"), ["8"]);
  assert.deepEqual(checkpointManagedSecrets(cap, {}, ["8", "true", " "], "claude-code"), ["8", "true", " "]);
  for (const field of ["API_TOKEN_ENABLED", "API_KEY_FLAG", "API_TOKEN_TTL", "API_TOKEN_LIMIT", "auth_token"]) {
    for (const value of ["true", "1", "abc123"]) {
      assert.deepEqual(checkpointManagedSecrets({ [field]: value }, {}, []), [value]);
    }
  }
  for (const value of ["true", "secret", "0", "9007199254740992"]) {
    assert.deepEqual(checkpointManagedSecrets({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: value }, {}, [], "claude-code"), [value]);
  }
  assert.deepEqual(checkpointManagedSecrets({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: ["8"] }, {}, [], "claude-code"), ["8"]);
  assert.deepEqual(collectCheckpointCredentialValues({ debug: { env: cap }, API_TOKEN: ["true", "1"] }), ["8", "true", "1"]);
  assert.deepEqual(checkpointManagedSecrets({}, { "config.toml": 'api_token = "true"\n' }, []), ["true"]);
});

test("checkpoint capture retains ordinary numeric configuration while blocking short real credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-field-source-"));
  const previous = config.storage.blobDir;
  Reflect.set(config.storage, "blobDir", directory);
  const bytes = Buffer.from("saved progress with output cap 8 and a true comparison");
  const host = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([
    { path: "progress.txt", bytes: bytes.length, sha256: checkpointHash(bytes), mode: 0o600 }]), stderr: "" }),
    runAsync: async () => checkpointGuardFixture(), readWorkspaceFile: async () => bytes,
  } as unknown as RuntimeHost;
  try {
    const environment = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8" };
    const managed = checkpointManagedSecrets(environment, {}, [], "claude-code");
    assert.equal((await captureCheckpointFiles(host, randomUUID(), [], managed, [])).length, 1);
    for (const secrets of [checkpointManagedSecrets({ ...environment, API_TOKEN_ENABLED: "true" }, {}, []),
      checkpointManagedSecrets(environment, {}, ["8"], "claude-code"),
      checkpointManagedSecrets({}, { "auth.json": JSON.stringify({ token: "true" }) }, [])]) {
      await assert.rejects(captureCheckpointFiles(host, randomUUID(), [], secrets, []), /SECRET_DETECTED/u);
    }
  } finally {
    Reflect.set(config.storage, "blobDir", previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test("进程基线读取遇到不可解析输出时失败闭合并返回稳定码", async () => {
  const { readCheckpointProcessBaseline } = await import("./human-checkpoint-process.js");
  const hostWith = (result: { exitCode: number; stdout: string }) =>
    ({ run: async () => ({ ...result, stderr: "" }) }) as unknown as RuntimeHost;
  assert.deepEqual(await readCheckpointProcessBaseline(hostWith({ exitCode: 0, stdout: '["1:2"]' })), ["1:2"]);
  await assert.rejects(readCheckpointProcessBaseline(hostWith({ exitCode: 0, stdout: "not-json secret-bytes" })),
    /HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE/u);
  // 形状合法但语义非法（非数组）同样失败闭合，稳定码由 JSON 解析分支负责。
  await assert.rejects(readCheckpointProcessBaseline(hostWith({ exitCode: 0, stdout: '{"pid":1}' })));
  await assert.rejects(readCheckpointProcessBaseline(hostWith({ exitCode: 2, stdout: "" })),
    /HUMAN_CHECKPOINT_PROCESS_BASELINE_UNAVAILABLE/u);
});
