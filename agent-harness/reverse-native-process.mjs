/** Linux container-only process/cgroup measurement and bounded cleanup. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const sanitizeProcess = ({pid,comm,state,ppid,pgid,start}) => ({pid,comm,state,ppid,pgid,start});
/** Surface REA's stdout error without echoing arbitrary tool text or private session paths. */
export function commandFailureSummary(output) {
  let document;
  try { document=JSON.parse(output); } catch { return 'unstructured command failure; inspect retained stdout/stderr artifacts'; }
  const codes=new Set(['execution_failure','capability_unavailable','invalid_input','invalid_request','cancelled','timeout','not_found','configuration_error']);
  const causes=new Set(['GhidraLaunchError','AnalysisCapabilityUnavailableError','AnalysisCancelledError']);
  const code=document?.code ?? document?.error?.code;
  const cause=document?.details?.diagnostics?.failure_cause?.name;
  return [codes.has(code)?`REA ${code}`:'command failure',causes.has(cause)?cause:null,'inspect retained stdout/stderr artifacts'].filter(Boolean).join('; ');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function trackOwnedProcesses(known, rows, rootPid, supervisorPid) {
  const root=rows.find(row=>row.pid===rootPid && row.ppid===supervisorPid);
  if (root && !known.has(rootPid)) known.set(rootPid,{...root});
  const parents=new Set(rows.filter(row=>known.get(row.pid)?.start===row.start).map(row=>row.pid));
  for (let i=0;i<rows.length;i++) {
    let changed=false;
    for (const row of rows) {
      // First-seen identity is immutable. Never adopt a reused PID, including a reused parent.
      if (!known.has(row.pid) && parents.has(row.ppid)) {
        known.set(row.pid,{...row}); parents.add(row.pid); changed=true;
      }
    }
    if (!changed) break;
  }
  return rows.filter(row=>known.get(row.pid)?.start===row.start);
}
export function rawOutputCapture(maxBytes=8*1024*1024) {
  const chunks={out:[],err:[]}, received={out:0,err:0};
  let retained=0;
  return {
    append(which,data) {
      assert(Buffer.isBuffer(data)); received[which]+=data.length;
      const accepted=data.subarray(0,Math.max(0,maxBytes-retained));
      if (accepted.length) {chunks[which].push(accepted);retained+=accepted.length;}
      return received.out+received.err<=maxBytes;
    },
    bytes(which) {return received[which];},
    buffer(which) {return Buffer.concat(chunks[which]);},
  };
}
export function processTable() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const last = stat.lastIndexOf(')');
      const columns = stat.slice(last+2).split(' ');
      return [{pid:Number(name), comm:stat.slice(stat.indexOf('(')+1,last), state:columns[0], ppid:Number(columns[1]), pgid:Number(columns[2]), start:columns[19], cmd:readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0',' ')}];
    } catch { return []; }
  });
}
export const isGhidraAnalysisProcess = row => row.comm==='java' && /(?:^| )ghidra\.app\.util\.headless\.AnalyzeHeadless(?: |$)/.test(row.cmd);
export function ghidraAnalysisStarted(row, readLog=path=>readFileSync(path,'utf8')) {
  if (!isGhidraAnalysisProcess(row)) return false;
  const log=/(?:^| )-log ([^ ]+)(?: |$)/.exec(row.cmd)?.[1];
  if (!log || !/\/rea-ghidra-[^/]+\/ghidra\.log$/.test(log)) return false;
  try {return readLog(log).includes('ANALYZING all memory and code:');} catch {return false;}
}
export const providerProcesses = rows => rows.filter(row => row.comm === 'java' || row.comm === 'decompile' || /(?:scripts\/rea\.mjs|\/bin\/rea(?:-agents)?(?: |$)|support\/(?:analyzeHeadless|launch\.sh))/.test(row.cmd));
export function cgroupMemory() {
  const v2 = '/sys/fs/cgroup/memory.peak';
  const v1 = '/sys/fs/cgroup/memory/memory.max_usage_in_bytes';
  const path = existsSync(v2) ? v2 : v1;
  assert(existsSync(path), 'real cgroup memory peak counter is required');
  const peak = Number(readFileSync(path, 'utf8').trim());
  assert(Number.isSafeInteger(peak) && peak > 0, 'invalid cgroup memory peak');
  return { source:path, peak_bytes:peak, semantics:'kernel cgroup high-water mark, cumulative across this container; includes page cache' };
}
export function remainingProcesses(known, rows) {
  const remaining=new Map(providerProcesses(rows).map(row=>[row.pid,row]));
  for (const row of rows) if (known.get(row.pid)?.start===row.start) remaining.set(row.pid,row);
  return [...remaining.values()];
}
async function noLeftovers(owned, sample) {
  const deadline = Date.now()+5000;
  let rows;
  do {
    rows = remainingProcesses(owned,sample());
    if (!rows.length) return rows;
    await delay(100);
  } while (Date.now() < deadline);
  return rows;
}
export async function measuredCommand({ name, command, args, directory, timeoutMs=600000, cancel=false }) {
  assert.equal(providerProcesses(processTable()).length, 0, 'provider processes leaked before command');
  const started = performance.now();
  const owned = new Map();
  const analysisProcesses = new Map();
  const capture=rawOutputCapture();
  let overflow = false, timedOut = false, forcedCleanup = false;
  let signalAt = null, javaObserved = false, launchError = null;
  const child = spawn(command, args, { cwd:directory, env:process.env, stdio:['ignore','pipe','pipe'] });
  const remember = () => {
    const rows = processTable();
    const currentOwned=trackOwnedProcesses(owned,rows,child.pid,process.pid);
    for (const row of currentOwned.filter(isGhidraAnalysisProcess)) analysisProcesses.set(`${row.pid}:${row.start}`,sanitizeProcess(row));
    if (cancel && currentOwned.some(row=>ghidraAnalysisStarted(row))) javaObserved=true;
    // REA owns detached Ghidra groups. Signal its root first and verify its cleanup.
    if (cancel && javaObserved && signalAt === null) {
      signalAt=performance.now(); child.kill('SIGTERM');
    }
    return rows;
  };
  const killOwned = signal => {
    forcedCleanup=true;
    for (const row of remember()) {
      const known=owned.get(row.pid);
      if (known && known.start === row.start && row.pid !== process.pid) {
        try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  };
  const receive = (which, data) => {
    if (!capture.append(which,data)) {overflow=true;killOwned('SIGKILL');}
  };
  child.stdout.on('data', data => receive('out', data));
  child.stderr.on('data', data => receive('err', data));
  const sampler=setInterval(remember, 100);
  const timeout=setTimeout(() => { timedOut=true; killOwned('SIGKILL'); }, timeoutMs);
  const cancellationDeadline=setInterval(() => {
    if (cancel && ((signalAt !== null && performance.now()-signalAt > 20000) || (!javaObserved && performance.now()-started > 30000))) {
      timedOut=true; killOwned('SIGKILL');
    }
  },100);
  let exit;
  try {
    remember();
    exit=await new Promise(resolve => {
      child.once('error', error => { launchError=error.message; resolve({code:null,signal:null}); });
      child.once('close', (code, signal) => resolve({code,signal}));
    });
  } finally { clearInterval(sampler); clearTimeout(timeout); clearInterval(cancellationDeadline); }
  const stdout=capture.buffer('out'), stderr=capture.buffer('err');
  const output=stdout.toString('utf8');
  const elapsedMs=performance.now()-started;
  const residual=await noLeftovers(owned,remember);
  const record={ name, command, argv:args, elapsed_sec:elapsedMs/1000, exit_code:exit.code, signal:exit.signal, launch_error:launchError, timed_out:timedOut, output_truncated:overflow, stdout_bytes:capture.bytes('out'), stderr_bytes:capture.bytes('err'), stdout_retained_bytes:stdout.length, stderr_retained_bytes:stderr.length, cgroup_memory:cgroupMemory(), owned_processes:[...owned.values()].map(sanitizeProcess), residual_processes:residual.map(sanitizeProcess), forced_cleanup:forcedCleanup };
  if (cancel) Object.assign(record, { java_observed:javaObserved, ghidra_analysis_started:javaObserved, ghidra_analysis_processes:[...analysisProcesses.values()], sigterm_sent:signalAt!==null, cancellation_elapsed_sec:signalAt===null ? null : (performance.now()-signalAt)/1000 });
  writeFileSync(join(directory,`${name}.stdout.json`),stdout);
  writeFileSync(join(directory,`${name}.stderr.txt`),stderr);
  writeFileSync(join(directory,`${name}.measurement.json`),JSON.stringify(record,null,2)+'\n');
  if (residual.length) {
    killOwned('SIGTERM'); await delay(1000); killOwned('SIGKILL');
    writeFileSync(join(directory,`${name}.cleanup-processes.json`),JSON.stringify(remainingProcesses(owned,processTable()).map(sanitizeProcess),null,2)+'\n');
  }
  assert(!launchError && !timedOut && !overflow, `${name}: launch/timeout/output failure`);
  assert.equal(residual.length,0,`${name}: residual provider or owned descendant processes`);
  assert.equal(forcedCleanup,false,`${name}: forced descendant cleanup was required`);
  if (cancel) {
    assert(javaObserved && signalAt!==null, 'cancellation must interrupt real Ghidra Java analysis');
    assert.notEqual(exit.code,0,'cancelled query returned success');
    const document=JSON.parse(output);
    assert.equal(document.code ?? document.error?.code, 'cancelled', 'cancelled query must return structured cancelled code');
  } else assert.equal(exit.code,0,`${name}: ${commandFailureSummary(output)}`);
  return { record, output };
}
