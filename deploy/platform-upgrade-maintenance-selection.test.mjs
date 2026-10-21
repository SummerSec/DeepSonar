import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, readdir, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {maintenanceScenarioSelection} from './platform-upgrade-maintenance.fixture.mjs';
const name='knowledge-background-fence';

test('default rehearsal skips knowledge background case for non-61-to-62 images',()=>{
  for(const [oldSchema,newSchema] of [[59,61],[59,62],[61,63]])
    assert.deepEqual(maintenanceScenarioSelection({oldSchema,newSchema},name),{name,status:'not_run',reason:'not_applicable'});
});
test('explicit unsupported knowledge selection is a failure with a fixed code',()=>{
  const result=maintenanceScenarioSelection({oldSchema:59,newSchema:61,scenarios:[name]},name);
  assert.equal(result.status,'failed');assert.equal(result.code,'KNOWLEDGE_BACKGROUND_FENCE_SCHEMA_UNSUPPORTED');
});
test('real 61-to-62 background case runs by default or when selected',()=>{
  for(const scenarios of [undefined,[name]]) assert.deepEqual(maintenanceScenarioSelection({oldSchema:61,newSchema:62,scenarios},name),{name,status:'run'});
});
test('explicit exclusion takes precedence over applicability and leaves other cases unchanged',()=>{
  for(const [oldSchema,newSchema] of [[59,61],[61,62]]) {
    const config={oldSchema,newSchema,scenarios:['drain-job']};
    assert.deepEqual(maintenanceScenarioSelection(config,name),{name,status:'not_run',reason:'explicit scenario selection'});
    assert.deepEqual(maintenanceScenarioSelection(config,'drain-job'),{name:'drain-job',status:'run'});
  }
});
test('unsupported explicit CLI selection writes failure before image inspection, Docker or fixture creation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pr747-selection-'));
  try {
    const bin=join(directory,'bin'),output=join(directory,'evidence'),called=join(directory,'docker-called');await mkdir(bin);
    await writeFile(join(bin,'docker'),`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(called)},'unexpected');process.exit(5);`,{mode:0o700});
    const configPath=join(directory,'config.json');
    const versions=Object.fromEntries(['0.0.1','0.0.2'].map((version,i)=>[version,Object.fromEntries(['scheduler','web','image-admission'].map(service=>[service,`127.0.0.1:55000/summersec/deepsonar-${service}@sha256:${String(i+1).repeat(64)}`]))]));
    await writeFile(configPath,JSON.stringify({registry:'127.0.0.1:55000',oldVersion:'0.0.1',newVersion:'0.0.2',oldSchema:59,newSchema:61,versions,scenarios:[name]}));
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./platform-upgrade-maintenance.integration.mjs',import.meta.url)),'--config',configPath,'--output',output],{encoding:'utf8',env:{...process.env,PATH:bin},timeout:10000});
    assert.equal(result.status,1,result.stderr);assert.equal(result.signal,null);
    const report=JSON.parse(await readFile(join(output,'summary.json'),'utf8'));
    assert.deepEqual(report.images,[]);assert.equal(report.cases.length,1);
    assert.equal(report.cases[0].code,'KNOWLEDGE_BACKGROUND_FENCE_SCHEMA_UNSUPPORTED');assert.equal(report.cases[0].status,'failed');
    assert.equal(report.cases[0].project,undefined);assert.equal(report.cases[0].cleanedUp,undefined);
    assert.ok(report.finishedAt);assert.deepEqual(await readdir(output),['summary.json']);
    await assert.rejects(readFile(called),{code:'ENOENT'});
  } finally {await rm(directory,{recursive:true,force:true});}
});
