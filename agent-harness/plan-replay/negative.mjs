import assert from 'node:assert/strict';
import { readFile,writeFile,rm } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const artifact=resolve(root,'artifacts/plan-replay/negative-regression.json');
await rm(artifact,{force:true});
const fault='unproven_completion_accepted';
const run=spawnSync(process.execPath,[fileURLToPath(new URL('./run.mjs',import.meta.url))],{
  cwd:root,env:{...process.env,PLAN_REPLAY_FAULT:fault},stdio:'inherit',timeout:200_000,
});
assert.notEqual(run.status,0,'injected control regression must fail the replay');
const path=resolve(root,'artifacts/plan-replay/report.json');
const report=JSON.parse(await readFile(path,'utf8'));
assert.equal(report.passed,false);
const first=report.cases.find(c=>c.mode==='inline' && c.id==='unproven_completion');
assert.equal(first.status,'different');assert.equal(first.observed.http_status,200);
assert.deepEqual(report.denominator,{expected:32,observed:1,matched:0,missing:31});
assert.equal(report.control_observations.deliberately_unproven_completion.accepted,1);
assert.ok(report.cases.filter(c=>c!==first).every(c=>c.status==='missing' && c.observed===null));
await writeFile(artifact,JSON.stringify({regression_passed:true,injected_test_fault:fault,report},null,2)+'\n');
await rm(path,{force:true});
console.log('Injected regression preserved actual HTTP 200 and 31 unexecuted cases as missing.');
