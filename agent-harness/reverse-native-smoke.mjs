#!/usr/bin/env node
/** Single native CI/release entry point. Never treats scratch, static or QEMU as image evidence. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNativePlatform, compileSamples, LIMITS, SIZE_CEILING_MIB, MIB } from './reverse-native-common.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if (args.length===1 && ['--help','-h'].includes(args[0])) {
  console.log('Usage: node agent-harness/reverse-native-smoke.mjs --image IMAGE --arch amd64|arm64 --evidence-dir DIR\nRequires native Linux Docker, Node, gcc and x86_64-w64-mingw32-gcc. No registry writes. DIR receives measurements.json and raw evidence on success or failure.');
  process.exit(0);
}
const options={};
for (let i=0;i<args.length;i+=2) {
  assert(['--image','--arch','--evidence-dir'].includes(args[i])&&args[i+1], 'invalid CLI arguments; use --help');
  assert(!options[args[i]],'duplicate CLI argument'); options[args[i]]=args[i+1];
}
const image=options['--image'], arch=options['--arch'], directory=options['--evidence-dir'];
assert(image&&['amd64','arm64'].includes(arch)&&directory,'--image, --arch and --evidence-dir are required');
// Snapshot source state before any evidence file is created in the checkout.
const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const sourceDirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0;
const evidence=resolve(directory);
mkdirSync(evidence,{recursive:true});
assert(!existsSync(join(evidence,'measurements.json')),'evidence directory already contains a run; choose a fresh directory');
const report={schema:'deepsonar.reverse.native-measurements/v1',started_at:new Date().toISOString(),status:'failed',passed:false,image_ref:image,image_id:null,image_digest:null,platform:`linux/${arch}`,arch,native_execution:false,source_revision:sourceRevision,source_dirty:sourceDirty,limits:LIMITS,checks:{native_architecture:false,toolchain:false,reproducible_samples:false,commands:false,cancellation:false,memory:false,compressed_image_size:false,container_cleanup:false}};
const save=()=>writeFileSync(join(evidence,'measurements.json'),JSON.stringify(report,null,2)+'\n');
const docker=(argv,timeout=30000)=>execFileSync('docker',argv,{encoding:'utf8',timeout,maxBuffer:16*MIB});
const temp=mkdtempSync(join(tmpdir(),'reverse-native-'));
chmodSync(temp,0o755);
let container=null;
save();
async function imageSize(imageId) {
  const saved=spawn('docker',['save',imageId],{stdio:['ignore','pipe','pipe']});
  let stderr='',bytes=0;
  const digest=createHash('sha256');
  saved.stderr.on('data',data=>{stderr+=data;});
  const finished=new Promise((done,reject)=>{
    saved.once('error',reject); saved.once('close',code=>code===0?done():reject(new Error(`docker save exited ${code}: ${stderr}`)));
  });
  const sink=new Writable({write(chunk,_encoding,done){bytes+=chunk.length;digest.update(chunk);done();}});
  const timeout=setTimeout(()=>saved.kill('SIGKILL'),600000);
  try { await Promise.all([pipeline(saved.stdout,createGzip({level:6}),sink),finished]); }
  finally { clearTimeout(timeout); writeFileSync(join(evidence,'docker-save.stderr.txt'),stderr); }
  return {method:'docker save immutable image_id | gzip -n -6 (Node zlib gzip stream, no filename/timestamp)',gzip_bytes:bytes,gzip_mib:bytes/MIB,gzip_sha256:digest.digest('hex'),provisional_maxSizeMiB:SIZE_CEILING_MIB,passed:bytes<=SIZE_CEILING_MIB*MIB};
}
try {
  const daemon=JSON.parse(docker(['info','--format','{{json .}}']));
  const inspected=JSON.parse(docker(['image','inspect',image]))[0];
  writeFileSync(join(evidence,'docker-info.json'),JSON.stringify({OSType:daemon.OSType,Architecture:daemon.Architecture,ServerVersion:daemon.ServerVersion,CgroupVersion:daemon.CgroupVersion},null,2)+'\n');
  writeFileSync(join(evidence,'image-inspect.json'),JSON.stringify({Id:inspected.Id,RepoDigests:inspected.RepoDigests,Os:inspected.Os,Architecture:inspected.Architecture,User:inspected.Config.User,Labels:inspected.Config.Labels},null,2)+'\n');
  assertNativePlatform({arch,hostPlatform:process.platform,hostArch:process.arch,daemonOs:daemon.OSType,daemonArch:daemon.Architecture,imageOs:inspected.Os,imageArch:inspected.Architecture});
  assert.equal(inspected.Config.Labels?.['io.deepsonar.image-key'],'deepsonar-reverse','wrong image product');
  assert.equal(inspected.Config.User,'deepsonar','runtime must run as deepsonar');
  report.image_id=inspected.Id;
  report.image_digest=image.includes('@sha256:')?image.slice(image.indexOf('@')+1):(inspected.RepoDigests?.[0]?.split('@')[1]??null);
  report.repo_digests=inspected.RepoDigests??[];
  report.checks.native_architecture=true; save();
  report.samples=compileSamples(join(root,'agent-harness/fixtures/reverse-sample/sample.c'),temp);
  writeFileSync(join(temp,'samples.json'),JSON.stringify(report.samples,null,2)+'\n');
  writeFileSync(join(evidence,'samples.json'),JSON.stringify(report.samples,null,2)+'\n');
  // Preserve exact analyzed binary bytes as small public evidence artifacts.
  for (const sample of report.samples) copyFileSync(join(temp,sample.name),join(evidence,sample.name));
  for (const name of ['reverse-native-container.mjs','reverse-native-process.mjs','reverse-native-common.mjs','reverse-toolchain-check.mjs']) copyFileSync(join(root,'agent-harness',name),join(temp,name));
  for (const name of readdirSync(temp)) chmodSync(join(temp,name),0o644);
  report.checks.reproducible_samples=true; save();
  const name=`deepsonar-reverse-smoke-${arch}-${process.pid}-${Date.now()}`;
  const containerStarted=performance.now();
  container=docker(['run','--detach','--init','--name',name,'--platform',`linux/${arch}`,'--network','none','--cpus','2','--memory','4096m','--memory-swap','4096m','--pids-limit','256','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,src=${temp},dst=/inputs,readonly`,report.image_id,'sleep','infinity']).trim();
  report.container_startup_elapsed_sec=(performance.now()-containerStarted)/1000;
  report.container_startup_semantics='docker run create/start only; image already local, excludes registry pull/network time';
  save();
  const containerInfo=JSON.parse(docker(['inspect',container]))[0];
  assert.equal(containerInfo.HostConfig.Memory,LIMITS.memory_bytes);
  assert.equal(containerInfo.HostConfig.MemorySwap,LIMITS.memory_bytes);
  assert.equal(containerInfo.HostConfig.NanoCpus,LIMITS.cpu*1e9);
  assert.equal(containerInfo.HostConfig.PidsLimit,LIMITS.pids);
  assert.equal(containerInfo.HostConfig.NetworkMode,'none');
  writeFileSync(join(evidence,'container-inspect.json'),JSON.stringify({Id:containerInfo.Id,Image:containerInfo.Image,limits:{memory_bytes:containerInfo.HostConfig.Memory,swap_bytes:containerInfo.HostConfig.MemorySwap,nano_cpus:containerInfo.HostConfig.NanoCpus,pids:containerInfo.HostConfig.PidsLimit,network:containerInfo.HostConfig.NetworkMode,cap_drop:containerInfo.HostConfig.CapDrop,security_opt:containerInfo.HostConfig.SecurityOpt}},null,2)+'\n');
  let runnerError;
  try {
    const output=docker(['exec',container,'node','/inputs/reverse-native-container.mjs',arch],3600000);
    writeFileSync(join(evidence,'runner.stdout.txt'),output);
  } catch (error) {
    runnerError=error;
    writeFileSync(join(evidence,'runner.stdout.txt'),error.stdout??'');
    writeFileSync(join(evidence,'runner.stderr.txt'),error.stderr??error.message);
  }
  docker(['cp',`${container}:/workspace/reverse-evidence/.`,evidence]);
  const measured=JSON.parse(readFileSync(join(evidence,'container-measurements.json'),'utf8'));
  report.container=measured; report.queries=measured.queries;
  report.native_execution=measured.checks.native_architecture===true;
  for (const key of ['toolchain','commands','cancellation','memory']) report.checks[key]=measured.checks[key]===true;
  const final=JSON.parse(docker(['inspect',container]))[0];
  writeFileSync(join(evidence,'container-final-inspect.json'),JSON.stringify({Id:final.Id,Image:final.Image,State:{Running:final.State.Running,OOMKilled:final.State.OOMKilled,ExitCode:final.State.ExitCode}},null,2)+'\n');
  assert.equal(final.State.OOMKilled,false,'container suffered OOM');
  assert(measured.passed,measured.failure?.message??'native container tests failed');
  if (runnerError) throw runnerError;
  report.image_size=await imageSize(report.image_id);
  writeFileSync(join(evidence,'docker-save-gzip.json'),JSON.stringify(report.image_size,null,2)+'\n');
  report.checks.compressed_image_size=report.image_size.passed;
  assert(report.image_size.passed,`compressed image exceeds ${SIZE_CEILING_MIB} MiB provisional ceiling`);
} catch (error) {
  report.failure={message:error.message}; process.exitCode=1;
} finally {
  if (container) {
    // Retain partial command outputs even when runner/copy/size measurement failed.
    try { docker(['cp',`${container}:/workspace/reverse-evidence/.`,evidence]); } catch (error) { report.evidence_copy_error=error.message; }
    try {
      docker(['rm','--force',container]);
      const remaining=docker(['ps','--all','--quiet','--filter',`id=${container}`]).trim();
      assert.equal(remaining,'','smoke container remains after cleanup');
      report.checks.container_cleanup=true;
    } catch (error) { report.cleanup_error=error.message; process.exitCode=1; }
  }
  rmSync(temp,{recursive:true,force:true});
  // Include failed query records too, which may precede an incomplete aggregate.
  report.query_evidence=readdirSync(evidence).filter(name=>name.endsWith('.measurement.json')).map(name=>JSON.parse(readFileSync(join(evidence,name),'utf8')));
  report.completed_at=new Date().toISOString();
  report.passed=Object.values(report.checks).every(value=>value===true)&&!report.failure&&!report.cleanup_error;
  report.status=report.passed?'passed':'failed'; save();
}
console.log(JSON.stringify({passed:report.passed,platform:report.platform,evidence_dir:evidence,failure:report.failure?.message}));
if (!report.passed) process.exitCode=1;
