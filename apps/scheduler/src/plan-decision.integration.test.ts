import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Plan} from '@deepsonar/shared-types';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('Plan-aware Control API dispatch is transactional, bounded and refuses unproven completion', {skip:!databaseUrl},async()=>{
  const postgres=(await import('postgres')).default;
  const adminUrl=new URL(databaseUrl!);adminUrl.pathname='/postgres';
  const admin=postgres(adminUrl.toString(),{max:1});
  const name=`plan_decision_${process.pid}_${Date.now()}`;
  const target=new URL(databaseUrl!);target.pathname=`/${name}`;
  let close:(()=>Promise<unknown>)|undefined,end:(()=>Promise<unknown>)|undefined;
  try{
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    process.env.DATABASE_URL=target.toString();process.env.AGENT_MODE='fake';process.env.DEEPSONAR_MASTER_KEY='00'.repeat(32);
    const [{default:Fastify},{sql,migrate},api,core,{executeGraphQuery},{ControlInputError},decision]=await Promise.all([
      import('fastify'),import('./db.js'),import('./domains/platform-api/index.js'),import('./core.js'),
      import('./graph-query.js'),import('./control-input.js'),import('./domains/plan-protocol/decision.js'),
    ]);
    end=()=>sql.end({timeout:5});await migrate();
    const app=Fastify({logger:false});api.registerPlatformControlRoutes(app);await app.ready();close=()=>app.close();
    const project=randomUUID(),canvas=randomUUID(),hub=randomUUID();
    const operations=['submit_plan','graph_query','submit_hub_decision','mark_job_done','request_human'];
    await sql`INSERT INTO projects(id,name,config_json) VALUES(${project},'Bounded Plan fixture',${sql.json({rules:{hubEnabled:false}})})`;
    await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvas},${project},'Scoped objective',${sql.json({network_policy:{allow_egress:false}})})`;
    const [root]=await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json) VALUES(${canvas},'root','Scoped objective','active','{}') RETURNING id`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
      VALUES(${hub},${project},${canvas},'hub_reason','provisioning',${sql.json({name:'hub_reason',role_kind:'hub',platform_tools:operations})},'{}')`;
    const grant=await api.mintJobCapabilityToken(hub);
    await sql`UPDATE jobs SET status='running',started_at=now() WHERE id=${hub}`;
    await api.activateProvisionedJobCapabilityTokens(hub);
    api.registerRuntimeHandler(hub,async context=>{
      if(context.operationId==='graph_query') return executeGraphQuery({jobId:hub,canvasId:canvas,payload:context.input,maxCalls:100,maxBytes:1024*1024});
      const type=({submit_plan:'plan',submit_hub_decision:'hub_decision',mark_job_done:'done',request_human:'human'} as const)[context.operationId as 'submit_plan'];
      try{
        if(type==='hub_decision' || type==='human') await core.preflightDeferredSemanticEvent(hub,type,context.input);
        await core.ingestEvent(hub,{v:1,event_id:context.eventId,type,payload:context.input} as never);
        return {accepted:true,event_id:context.eventId};
      }catch(error){
        if(error instanceof ControlInputError) throw new api.PlatformRuntimeHandlerError('OPERATION_REJECTED',error.message,{statusCode:error.retryable?422:409,errorCode:error.code,retryable:error.retryable,path:error.path});
        throw error;
      }
    },operations);
    const invoke=(operation:string,payload:unknown,key=randomUUID())=>app.inject({method:'POST',url:`/control/v1/jobs/${hub}/operations/${operation}`,headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':key},payload:payload as never});
    const plan=Plan.parse({v:1,goal:'Verify scoped behavior',tasks:[{id:'sample',title:'Collect evidence',role:'review',description:'Scoped review',prompt:'Review only the saved scope and retain execution evidence.',expected_outputs:['Execution record']}],completion:{mode:'explicit_result',description:'Scoped behavior verified',required_outputs:[]}});
    const submitted=await invoke('submit_plan',{plan});assert.equal(submitted.statusCode,200,submitted.payload);
    const read=async()=>{
      const response=await invoke('graph_query',{kind:'plan_gap'});assert.equal(response.statusCode,200,response.payload);
      const body=response.json();return (body.items ?? body.result?.items)?.[0];
    };
    const basis=(gap:any,outcome='continue')=>({v:1,plan_job_id:hub,plan_sha256:gap.plan_sha256,criterion_id:'completion',expected_revision:gap.revision,
      expected_task_input_sha256:gap.task_input_sha256,expected_projection_sha256:gap.projection_sha256,source_refs:[],outcome,rationale:'Current evidence does not authorize completion',...(outcome==='continue'?{expected_gain:'Retain the missing scoped execution record'}:{})});
    const intent={from:[root.id],role:'review',description:'Collect scoped execution evidence',prompt:'Review the saved scope and retain a concrete execution record.'};
    const gap=await read();assert.ok(gap);assert.equal(gap.criteria[0].state,'unbound');
    const complete=await invoke('submit_hub_decision',{complete:{from:[root.id],description:'Claim completion without evidence'},plan_basis:basis(gap,'complete')});
    assert.equal(complete.statusCode,422,complete.payload);assert.equal(complete.json().error_code,'plan_completion_unproven');
    const rejected=await invoke('submit_hub_decision',{intents:[{...intent,role:'not-admitted-role'}],plan_basis:basis(gap)});
    assert.equal(rejected.statusCode,422,rejected.payload);
    assert.equal((await sql`SELECT id FROM jobs WHERE parent_job_id=${hub}`).length,0);
    const key=randomUUID(),proposal={intents:[intent],plan_basis:basis(gap)};
    const accepted=await invoke('submit_hub_decision',proposal,key);assert.equal(accepted.statusCode,200,accepted.payload);
    api.clearPlatformApiIdempotencyCache();
    const repeated=await invoke('submit_hub_decision',proposal,key);assert.equal(repeated.statusCode,200,repeated.payload);
    const children=await sql`SELECT * FROM jobs WHERE parent_job_id=${hub}`;assert.equal(children.length,1);
    assert.equal(children[0].payload_json.plan_context.plan_job_id,hub);
    assert.equal(children[0].agent_snapshot_json.runtime_image.image_key,'deepsonar-base');
    const stale=await invoke('submit_hub_decision',proposal);assert.equal(stale.statusCode,422,stale.payload);assert.equal(stale.json().error_code,'plan_stale_revision');
    const next=await read();assert.equal(next.supplementation_remaining,0);
    const exhausted=await invoke('submit_hub_decision',{intents:[{...intent,description:'Different title cannot reset budget'}],plan_basis:basis(next)});
    assert.equal(exhausted.statusCode,422,exhausted.payload);assert.equal(exhausted.json().error_code,'plan_budget_exhausted');
    const omitted=await invoke('submit_hub_decision',{intents:[intent]});assert.equal(omitted.statusCode,422,omitted.payload);assert.equal(omitted.json().error_code,'plan_context_required');
    assert.deepEqual(await decision.planCompletionBlockers(sql,canvas),['plan_criteria_unproven']);
    await sql`UPDATE canvases SET title='Changed saved objective' WHERE id=${canvas}`;
    const changed=await read();assert.equal(changed.stale_objective,true);
    const stop=await invoke('request_human',{reason:'Single-step budget is exhausted and current criteria require operator assessment',subject:{type:'platform_blocker',kind:'business_decision'},plan_basis:basis(changed,'needs_human')});
    assert.equal(stop.statusCode,200,stop.payload);
    assert.equal((await sql`SELECT id FROM jobs WHERE parent_job_id=${hub}`).length,1);
    assert.equal((await sql`SELECT id FROM events WHERE job_id=${hub} AND type='hub_decision'`).length,1);
    api.unregisterRuntimeHandler(hub);
  }finally{
    await close?.();await end?.();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();
  }
});
