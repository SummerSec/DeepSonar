import { readFile,writeFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReplayReport } from './report.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const destination=resolve(root,'artifacts/plan-replay/report.json');
await rm(destination,{force:true}); // A failed rerun must never leave an older green report.
if(!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; skipped DB tests cannot satisfy replay');
const baselineBytes=await readFile(new URL('./baseline.json',import.meta.url),'utf8');
const work=await mkdtemp(resolve(tmpdir(),'plan-replay-'));
try {
  const output=resolve(work,'observations.jsonl');await writeFile(output,'',{mode:0o600});
  const started=performance.now();
  const run=spawnSync(process.env.npm_execpath ? process.execPath : 'pnpm',[
    ...(process.env.npm_execpath?[process.env.npm_execpath]:[]),'--filter','@deepsonar/scheduler','exec','tsx','--test','src/plan-decision.integration.test.ts',
  ],{cwd:root,env:{...process.env,PLAN_REPLAY_OUTPUT:output},stdio:'inherit',timeout:180_000});
  const rows=(await readFile(output,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
  const dirty=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
  const report=buildReplayReport(baselineBytes,rows,{commit:git.status===0?git.stdout.trim():null,
    dirty:dirty.status===0?Boolean(dirty.stdout.trim()):null,exit_code:run.status??1,
    elapsed_ms:Math.round(performance.now()-started),elapsed_scope:'entire_isolated_fixture_including_setup_not_model_time'});
  await mkdir(dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:destination,passed:report.passed,denominator:report.denominator}));
  if(!report.passed) process.exitCode=1;
}finally{await rm(work,{recursive:true,force:true});}
