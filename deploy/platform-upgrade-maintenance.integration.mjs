// Opt-in real image/PG/HTTP rehearsal. No builds, registry writes or production CLI bypass.
// node deploy/platform-upgrade-maintenance.integration.mjs --config refs.json --output /tmp/evidence
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {maintenanceHostAdapter} from './platform-upgrade-maintenance-host.mjs';
import {runMaintenanceUpgrade} from './platform-upgrade-maintenance.mjs';
import {loadConfig, createFixture, target, parseValues, inspectFixtureRef, docker, dc, query, request, health} from './platform-upgrade-maintenance.fixture.mjs';
const script = fileURLToPath(import.meta.url);
const snapshotSql = `SELECT json_build_object('projects',(SELECT count(*) FROM projects),'jobs',(SELECT count(*) FROM jobs),
'attempts',(SELECT count(*) FROM job_attempts),'effects',(SELECT count(*) FROM job_attempt_effects),'events',(SELECT count(*) FROM events),
'scans',(SELECT count(*) FROM runtime_image_scans),'paused',(SELECT claims_paused FROM global_settings WHERE id='global'))`;
const snapshot = (fixture, identity) => JSON.parse(query(fixture, snapshotSql, identity));
const stateOf = async fixture => JSON.parse(await readFile(join(fixture.directory,'.upgrade','maintenance.json'),'utf8'));
const secretsOf = async (fixture,state) => JSON.parse(await readFile(join(fixture.directory,'.upgrade',`identity-${state.generation}.json`),'utf8'));
function actors(config, fixture, extra = {}) {
  return maintenanceHostAdapter({directory:fixture.directory, projectName:fixture.project, composeFiles:['compose.yml'], api:fixture.api,
    version:config.newVersion, readyTimeoutMs:30_000, drainTimeoutMs:1500, parsePlatformValues:parseValues(config),
    releaseProvider:async()=>{for(const ref of Object.values(config.versions[config.newVersion])) await inspectFixtureRef(config,ref); return target(config);}, ...extra});
}
const execute = (io,config,action,hash) => io.lock(()=>runMaintenanceUpgrade(io,{action,target:config.newVersion,approvedPlanHash:hash}));
async function approved(io,config) {
  const result=await execute(io,config,'check');
  assert.equal(result.ok,true,JSON.stringify(result.plan.blocking_errors));
  assert.match(result.plan.plan_hash,/^[a-f0-9]{64}$/);
  return result.plan.plan_hash;
}
async function assertSource(config,fixture,state,marker) {
  const saved=await secretsOf(fixture,state), identity={role:saved.admin.role,database:saved.source.database};
  assert.equal(query(fixture,"SELECT version FROM schema_meta WHERE id='global'",identity),String(config.oldSchema));
  assert.equal(query(fixture,`SELECT count(*) FROM projects WHERE id='${marker}'`,identity),'1');
  assert.throws(()=>query(fixture,'SELECT 1',{role:saved.source.role,database:saved.source.database}),'retired role must fail even local trust');
  return saved;
}
async function assertActive(config,fixture,result,marker) {
  assert.equal(result.status,'complete'); const state=await stateOf(fixture), saved=await assertSource(config,fixture,state,marker);
  const identity={role:saved.admin.role,database:saved.candidateDatabase};
  assert.equal(query(fixture,"SELECT version FROM schema_meta WHERE id='global'",identity),String(config.newSchema));
  assert.equal(query(fixture,"SELECT phase FROM platform_upgrade_state WHERE id='global'",identity),'active');
  assert.equal(query(fixture,`SELECT count(*) FROM projects WHERE id='${marker}'`,identity),'1');
  assert.equal(query(fixture,`SELECT rolsuper FROM pg_roles WHERE rolname='${saved.runtime.role}'`,identity),'f');
  assert.throws(()=>query(fixture,`SET ROLE "${saved.source.role}"`,{role:saved.runtime.role,database:saved.candidateDatabase}));
  assert.throws(()=>query(fixture,'CREATE TABLE forbidden_ddl(id int)',{role:saved.runtime.role,database:saved.candidateDatabase}));
  await health(fixture,config.newVersion);
  const claims=await request(fixture,'platform/claims'); assert.equal(claims.status,200); assert.equal((await claims.json()).claims_paused,false);
  return {generation:state.generation,sourceDatabase:saved.source.database,candidateDatabase:saved.candidateDatabase};
}
async function crashChild(path) {
  const {configPath,fixture,step,hash}=JSON.parse(await readFile(path,'utf8'));
  assert.match(fixture.project,/^pr747-maint-/); process.env.DEEPSONAR_ADMIN_TOKEN=fixture.token;
  const config=await loadConfig(configPath), io=actors(config,fixture), real=io[step];
  assert.equal(typeof real,'function');
  io[step]=async state=>{await real(state); process.kill(process.pid,'SIGKILL');};
  await execute(io,config,'apply',hash); throw new Error('crash boundary not reached');
}
export async function rehearse(configPath,output) {
  const config=await loadConfig(configPath); await mkdir(output,{recursive:true,mode:0o700});
  const report={startedAt:new Date().toISOString(),oldSchema:config.oldSchema,newSchema:config.newSchema,images:[],cases:[]};
  for(const images of Object.values(config.versions)) for(const ref of Object.values(images)) {report.images.push(await inspectFixtureRef(config,ref)); docker(['pull',ref]);}
  const priorToken=process.env.DEEPSONAR_ADMIN_TOKEN;
  async function scenario(name,fn) {
    if (config.scenarios && !config.scenarios.includes(name)) {report.cases.push({name,status:'not_run',reason:'explicit scenario selection'}); return;}
    const fixture=await createFixture(config,output,name), evidence={name,project:fixture.project,status:'not_run'};
    process.env.DEEPSONAR_ADMIN_TOKEN=fixture.token;
    try {
      dc(fixture,['up','-d','--wait','--wait-timeout','180']); await health(fixture,config.oldVersion);
      assert.equal(query(fixture,"SELECT version FROM schema_meta WHERE id='global'"),String(config.oldSchema),'old image must create its own schema, never spoof schema_meta');
      const marker=randomUUID(); query(fixture,`INSERT INTO projects(id,name) VALUES('${marker}','maintenance source marker')`);
      await fn(fixture,evidence,marker); evidence.status='passed';
    } catch(error) {evidence.status='failed'; evidence.error=error.message;}
    finally {
      try {dc(fixture,['down','--volumes','--remove-orphans']); evidence.cleanedUp=true;} catch {evidence.cleanup='failed';}
      report.cases.push(evidence); await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2),{mode:0o600});
    }
  }
  try {
    await scenario('plan-approval',async fixture=>{
      const before=snapshot(fixture),io=actors(config,fixture),check=await execute(io,config,'check');
      assert.deepEqual(snapshot(fixture),before,'plan cannot change business rows or pause');
      assert.equal(check.ok,true,JSON.stringify(check.plan.blocking_errors));
      assert.ok(check.plan.risks.length>0,'cross-schema fixture must exercise explicit risk approval');
      await assert.rejects(execute(io,config,'apply'));
      await assert.rejects(execute(io,config,'apply','0'.repeat(64)));
      assert.deepEqual(snapshot(fixture),before,'rejected approval must precede pause');
    });
    await scenario('success-preparing',async(fixture,evidence,marker)=>{
      const io=actors(config,fixture),hash=await approved(io,config),activate=io.activate;
      io.activate=async state=>{
        const saved=await secretsOf(fixture,state),identity={role:saved.admin.role,database:saved.candidateDatabase};
        await health(fixture,config.newVersion,true); const before=snapshot(fixture,identity);
        const response=await request(fixture,`projects/${marker}/tasks`,{title:'must not enqueue',prompt:'maintenance guard'});
        assert.equal(response.status,503); assert.equal((await response.json()).error_code,'PLATFORM_MAINTENANCE');
        await new Promise(resolve=>setTimeout(resolve,2500)); assert.deepEqual(snapshot(fixture,identity),before,'preparing workers must not mutate business rows');
        evidence.preparingHttp=503; return activate(state);
      };
      const postgresContainer=dc(fixture,['ps','-q','postgres']);
      const oldSession=spawn('docker',['exec','-i',postgresContainer,'psql','-X','-qAt','-U','deepsonar','-d','deepsonar'],{stdio:['pipe','ignore','ignore']});
      oldSession.stdin.end("SET application_name='maintenance-old-client'; SELECT pg_sleep(600);");
      try {
        for(let i=0;i<50;i++) {
          if(query(fixture,"SELECT count(*) FROM pg_stat_activity WHERE application_name='maintenance-old-client'")==='1') break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        assert.equal(query(fixture,"SELECT count(*) FROM pg_stat_activity WHERE application_name='maintenance-old-client'"),'1');
        evidence.activation=await assertActive(config,fixture,await execute(io,config,'apply',hash),marker);
        const saved=await secretsOf(fixture,await stateOf(fixture));
        assert.equal(query(fixture,"SELECT count(*) FROM pg_stat_activity WHERE application_name='maintenance-old-client'",{role:saved.admin.role,database:'postgres'}),'0');
      } finally {if(oldSession.exitCode===null) oldSession.kill();}
    });
    for (const stoppedService of ['scheduler','web']) await scenario(`${stoppedService}-health-rollback`,async(fixture,evidence,marker)=>{
      const io=actors(config,fixture,{readyTimeoutMs:1200}),hash=await approved(io,config),start=io.startPreparing;
      io.startPreparing=async state=>{const receipt=await start(state); dc(fixture,['stop',stoppedService]); return receipt;};
      await assert.rejects(execute(io,config,'apply',hash));
      const state=await stateOf(fixture); assert.equal(state.status,'rolled_back'); const saved=await assertSource(config,fixture,state,marker);
      assert.equal(query(fixture,"SELECT claims_paused FROM global_settings WHERE id='global'",{role:saved.admin.role,database:saved.source.database}),'t');
      assert.equal(dc(fixture,['ps','--status','running','-q','scheduler','web','image-admission']),''); evidence.appsStopped=true;
      const resume=actors(config,fixture); const resumed=await resume.lock(()=>resume.resumeRollback(state));
      assert.equal(resumed.status,'rollback_resumed'); await health(fixture,config.oldVersion);
      const restored=await secretsOf(fixture,await stateOf(fixture));
      assert.equal(query(fixture,"SELECT claims_paused FROM global_settings WHERE id='global'",{role:restored.admin.role,database:restored.source.database}),'f');
      assert.equal(query(fixture,`SELECT rolsuper FROM pg_roles WHERE rolname='${restored.rollbackRuntime.role}'`,{role:restored.admin.role,database:'postgres'}),'f');
      assert.equal((await resume.lock(async()=>resume.resumeRollback(await stateOf(fixture)))).status,'rollback_resumed');
      evidence.sourceResumed=true;
    });
    for(const step of ['backup','candidate','rebuild','configurePreparing','activate']) await scenario(`crash-${step.toLowerCase()}`,async(fixture,evidence,marker)=>{
      const io=actors(config,fixture),hash=await approved(io,config),descriptor=join(fixture.directory,'crash.json');
      await writeFile(descriptor,JSON.stringify({configPath,fixture,step,hash}),{mode:0o600});
      const child=spawnSync(process.execPath,[script,'--crash-child',descriptor],{env:process.env,timeout:600_000,maxBuffer:1024*1024});
      await rm(descriptor); assert.equal(child.signal,'SIGKILL','real actor must finish before injected host crash');
      const interrupted=await stateOf(fixture); assert.equal(interrupted.intent,step);
      // Remove only this proven-dead child's exact lock; never clear a live coordinator's lock.
      await rm(join(fixture.directory,'.upgrade','lock'),{recursive:true});
      evidence.activation=await assertActive(config,fixture,await execute(actors(config,fixture),config,'apply',hash),marker);
      assert.equal(evidence.activation.generation,interrupted.generation,'same-target resume retains generation');
      if(step==='activate') await assert.rejects(execute(actors(config,fixture),config,'rollback',hash),/FORWARD_REPAIR/);
    });
    for(const blocker of ['job','effect','scan']) await scenario(`drain-${blocker}`,async(fixture,evidence,marker)=>{
      const id=randomUUID(),attempt=randomUUID();
      if(blocker==='scan') {
        const version=query(fixture,'SELECT id FROM runtime_image_versions LIMIT 1'); assert.match(version,/^[a-f0-9-]{36}$/,'real admitted image version fixture required');
        query(fixture,`INSERT INTO runtime_image_scans(id,runtime_image_version_id,status,started_at) VALUES('${id}','${version}','running',now())`);
      } else {
        query(fixture,`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json) VALUES('${id}','${marker}','explore','${blocker==='job'?'running':'failed'}','{}')`);
        if(blocker==='effect') query(fixture,`INSERT INTO job_attempts(id,job_id,attempt_no,status) VALUES('${attempt}','${id}',1,'failed'); INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status) VALUES('${attempt}','${id}','unknown','agent_run','unknown')`);
      }
      const io=actors(config,fixture),check=await execute(io,config,'check');
      if(check.ok) await assert.rejects(execute(io,config,'apply',check.plan.plan_hash));
      else assert.ok(check.plan.blocking_errors.length>0);
      assert.equal(query(fixture,"SELECT rolcanlogin FROM pg_roles WHERE rolname='deepsonar'"),'t','blocked drain must not fence source identity');
      assert.equal(query(fixture,"SELECT version FROM schema_meta WHERE id='global'"),String(config.oldSchema)); evidence.blockedBeforeFence=true;
    });
  } finally {
    if(priorToken===undefined) delete process.env.DEEPSONAR_ADMIN_TOKEN; else process.env.DEEPSONAR_ADMIN_TOKEN=priorToken;
  }
  return report;
}
if(resolve(process.argv[1]??'')===script) {
  try {
    if(process.argv[2]==='--crash-child') await crashChild(process.argv[3]);
    else {
      const args=process.argv.slice(2),opts={};
      for(let i=0;i<args.length;i+=2) {assert.ok(['--config','--output'].includes(args[i])&&args[i+1]); opts[args[i]]=resolve(args[i+1]);}
      assert.ok(opts['--config']&&opts['--output']);
      const report=await rehearse(opts['--config'],opts['--output']);
      const failed=report.cases.filter(item=>item.status==='failed'||(item.status==='passed'&&!item.cleanedUp));
      const notRun=report.cases.filter(item=>item.status==='not_run').length;
      console.log(JSON.stringify({passed:report.cases.filter(item=>item.status==='passed'&&item.cleanedUp).length,failed:failed.length,notRun,summary:join(opts['--output'],'summary.json')}));
      if(failed.length) process.exitCode=1;
    }
  } catch {console.error('maintenance rehearsal failed; inspect private evidence, raw secrets suppressed');process.exitCode=1;}
}
