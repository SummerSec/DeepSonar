import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { config } from "../../config.js";
import { captureCheckpointFiles, checkpointHash, HumanCheckpointManifest, putCheckpointFile, readCheckpointFile,
  HUMAN_CHECKPOINT_FILE_BYTES } from "./human-checkpoint-files.js";
import { checkpointQuiescenceScript } from "./human-checkpoint-process.js";
import { CHECKPOINT_MUTATION_GUARD } from "./human-checkpoint-mutation.js";
import { checkpointGuardFixture } from "./human-checkpoint-fixture.js";
import { checkpointManagedSecrets } from "./human-checkpoint.js";

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
  const manifest = { v: 1, job_id: randomUUID(), attempt_id: randomUUID(), request_id: randomUUID(),
    snapshot_sha256: "a".repeat(64), mode: "structured", files: [] as unknown[] };
  const file = { path: "src/work.txt", bytes: 1, sha256: "b".repeat(64) };
  assert.equal(HumanCheckpointManifest.safeParse({ ...manifest, files: [file] }).success, true);
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
    { path: filePath, bytes: bytes.length, sha256: checkpointHash(bytes) }]), stderr: "" }),
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
      {path:filePath,bytes:backgroundBytes.length,sha256:checkpointHash(backgroundBytes)}])}),readWorkspaceFile:async()=>backgroundBytes};
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
