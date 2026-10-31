import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildReplayReport } from './report.mjs';
import { createHash } from 'node:crypto';

const bytes=readFileSync(new URL('./baseline.json',import.meta.url),'utf8');
const baseline=JSON.parse(bytes);
const rows=baseline.modes.flatMap(mode=>baseline.cases.map(c=>({mode,id:c.id,observed:structuredClone(c.expected)})));
const provenance={commit:baseline.baseline_commit,exit_code:0};

test('frozen baseline has explicit scope, transport denominator and an independently pinned digest',()=>{
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'04299a2243cabc667eaf4e6fc2552d7ab94341d2f786213ef024681bb4f1b0b1');
  assert.equal(baseline.cases.length,16);assert.deepEqual(baseline.modes,['inline','file']);
  const report=buildReplayReport(bytes,rows,provenance);
  assert.equal(report.passed,true);assert.deepEqual(report.denominator,{expected:32,observed:32,matched:32,missing:0});
  assert.equal(report.metrics.unproven_completion.expected_cases,2);
  assert.deepEqual(report.control_observations.deliberately_unproven_completion,{expected:2,observed:2,accepted:0,rejected_as_unproven:2});
  assert.ok(report.unmeasured.every(x=>x.value===null));
});
test('missing, duplicate, unexpected and failed runs cannot look like full passing coverage',()=>{
  for(const observations of [[],rows.slice(1),[...rows,rows[0]],[...rows,{mode:'other',id:'invented',observed:{}}]]) {
    assert.equal(buildReplayReport(bytes,observations,provenance).passed,false);
  }
  assert.equal(buildReplayReport(bytes,rows,{...provenance,exit_code:1}).passed,false);
  const partial=buildReplayReport(bytes,rows.slice(1),provenance);
  assert.equal(partial.metrics.unproven_completion.missing_cases,1);
  assert.equal(partial.metrics.unproven_completion.observed_cases,1);
});
test('actual differences remain per-case and cannot be hidden by matching another case',()=>{
  const changed=structuredClone(rows);changed[0].observed.http_status=200;
  const report=buildReplayReport(bytes,changed,provenance);
  assert.equal(report.passed,false);assert.equal(report.denominator.matched,31);
  assert.equal(report.cases[0].status,'different');assert.equal(report.cases[0].observed.http_status,200);
  assert.equal(report.metrics.unproven_completion.differing_cases,1);
  assert.equal(report.control_observations.deliberately_unproven_completion.accepted,1);
});
test('malformed baseline and duplicate identities fail before computing a denominator',()=>{
  for(const value of [{...baseline,cases:[]},{...baseline,cases:[...baseline.cases,baseline.cases[0]]},{...baseline,modes:['inline','inline']}]) {
    assert.throws(()=>buildReplayReport(JSON.stringify(value),rows,provenance),/Invalid frozen baseline/);
  }
});

test('a failed rerun removes a stale green artifact before checking prerequisites',async()=>{
  const {mkdtemp,mkdir,copyFile,writeFile,access,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'plan-runner-failure-'));
  try{
    const scripts=join(root,'agent-harness/plan-replay'),artifact=join(root,'artifacts/plan-replay/report.json');
    await mkdir(scripts,{recursive:true});await mkdir(join(root,'artifacts/plan-replay'),{recursive:true});
    for(const file of ['run.mjs','report.mjs']) await copyFile(new URL(file,import.meta.url),join(scripts,file));
    await writeFile(artifact,JSON.stringify({passed:true}));
    const env={...process.env};delete env.TEST_DATABASE_URL;
    const result=spawnSync(process.execPath,[join(scripts,'run.mjs')],{env,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/TEST_DATABASE_URL is required/);
    await assert.rejects(access(artifact),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
