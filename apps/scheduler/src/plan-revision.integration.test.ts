import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Plan} from '@deepsonar/shared-types';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('Plan route revisions preserve objective, lineage and Canvas budget under concurrent ingestion',{skip:!databaseUrl},async()=>{
  const postgres=(await import('postgres')).default;
  const adminUrl=new URL(databaseUrl!);adminUrl.pathname='/postgres';
  const admin=postgres(adminUrl.toString(),{max:1});
  const name=`plan_revision_${process.pid}_${Date.now()}`,target=new URL(databaseUrl!);target.pathname=`/${name}`;
  let end:(()=>Promise<unknown>)|undefined,close:(()=>Promise<unknown>)|undefined;
  try{
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    process.env.DATABASE_URL=target.toString();process.env.AGENT_MODE='fake';process.env.DEEPSONAR_MASTER_KEY='00'.repeat(32);
    const [{sql,migrate},{ingestEvent},{createAttempt},{readPlanObjective},{ControlInputError}]=await Promise.all([
      import('./db.js'),import('./core.js'),import('./domains/job-attempt/application.js'),
      import('./domains/plan-protocol/objective.js'),import('./control-input.js'),
    ]);
    end=()=>sql.end({timeout:5});await migrate();
    const project=randomUUID();
    await sql`INSERT INTO projects(id,name,config_json) VALUES(${project},'Route revision fixture',${sql.json({rules:{hubEnabled:false,maxIntentsPerDecision:1}})})`;
    const plan=Plan.parse({v:1,goal:'Retain scoped evidence',tasks:[{id:'collect',title:'Collect evidence',role:'review',description:'Review saved scope',prompt:'Review only the saved scope and retain evidence.',expected_outputs:['Record']}],completion:{mode:'explicit_result',description:'All scoped evidence assessed',required_outputs:['Record']}});
    const newJob=async(canvas:string,tools=['submit_plan','request_human'])=>{
      const id=randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json,started_at,lease_expires_at)
        VALUES(${id},${project},${canvas},'hub_reason','running',${sql.json({name:'hub_reason',role_kind:'hub',platform_tools:tools})},'{}',now(),now()+interval '5 minutes')`;
      await createAttempt(sql,id);return id;
    };
    const submit=(job:string,payload:unknown,key=randomUUID())=>ingestEvent(job,{v:1,event_id:key,type:'plan',payload} as never);
    const fixture=async()=>{
      const canvas=randomUUID();await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvas},${project},'Saved objective',${sql.json({network_policy:{allow_egress:false}})})`;
      const owner=await newJob(canvas),origin=randomUUID();await submit(owner,{plan},origin);
      const author=await newJob(canvas);
      return {canvas,owner,author,origin};
    };
    const route=(suffix:string)=>({...plan,tasks:[{...plan.tasks[0],description:`Review saved scope ${suffix}`}],open_questions:[`Which record ${suffix}?`]});
    const proposal=async(f:Awaited<ReturnType<typeof fixture>>,next=route('revised'))=>{
      const current=await readPlanObjective(sql,f.author,f.canvas,f.owner);
      return {plan:next,revision:{v:1,kind:'route',plan_job_id:f.owner,expected_revision:current.revision,expected_plan_sha256:current.planSha,expected_task_input_sha256:current.baseline,rationale:'Change collection route only'}};
    };
    const rejects=async(action:Promise<unknown>,code?:string)=>assert.rejects(action,(error:unknown)=>error instanceof ControlInputError && (!code || error.code===code));
    const f=await fixture();
    const before=await sql`SELECT id,agent_snapshot_json FROM jobs WHERE canvas_id=${f.canvas} ORDER BY id`;
    const [originBefore]=await sql`SELECT payload_json FROM events WHERE event_id=${f.origin}`;
    const first=await proposal(f,route('first')),second={...first,plan:route('second')};
    const keys=[randomUUID(),randomUUID()];
    const raced=await Promise.allSettled([submit(f.author,first,keys[0]),submit(f.author,second,keys[1])]);
    assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
    const loser=raced.find(result=>result.status==='rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof ControlInputError);assert.equal(loser.reason.code,'plan_stale_revision');
    const winner=raced.findIndex(result=>result.status==='fulfilled'),accepted=winner===0?first:second;
    await submit(f.author,accepted,keys[winner]);
    assert.equal((await sql`SELECT id FROM events WHERE event_id=${keys[winner]}`).length,1,'same event retry is idempotent');
    await rejects(submit(f.author,{...accepted,plan:route('conflicting replay')},keys[winner]),'invalid_payload');
    await rejects(submit(f.author,first),'plan_stale_revision');
    assert.deepEqual((await sql`SELECT payload_json FROM events WHERE event_id=${f.origin}`)[0],originBefore);
    assert.deepEqual(await sql`SELECT id,agent_snapshot_json FROM jobs WHERE canvas_id=${f.canvas} ORDER BY id`,before);
    const current=await readPlanObjective(sql,f.author,f.canvas,f.owner);
    assert.equal(current.planJobId,f.owner);assert.equal(current.spent,false);assert.equal(current.staleObjective,false);
    assert.deepEqual(current.plan,Plan.parse(accepted.plan));
    await rejects(submit(f.owner,{plan}),'plan_stale_revision');
    await rejects(submit(f.author,{...await proposal(f),plan:current.plan}),'invalid_payload');
    for(const immutable of [
      {goal:'Changed user objective'}, {completion:{...plan.completion,required_outputs:[]}},
      {assumptions:['New scope assumption']},{budget:{max_tasks:2}},
    ]) await rejects(submit(f.author,{...await proposal(f),plan:{...route('changed'),...immutable}}),'invalid_payload');
    const staleInput=await proposal(f);
    await sql`UPDATE canvases SET title='Changed user objective' WHERE id=${f.canvas}`;
    await rejects(submit(f.author,staleInput),'plan_stale_revision');
    await rejects(submit(f.author,await proposal(f)),'plan_stale_revision');
    await sql`UPDATE canvases SET title='Saved objective' WHERE id=${f.canvas}`;
    const foreign=await fixture();
    await rejects(submit(foreign.author,await proposal(f)),'invalid_payload');
    const unprivileged=await newJob(f.canvas,[]);
    await rejects(submit(unprivileged,await proposal(f)),'tool_not_allowed');
    await sql`UPDATE jobs SET status='cancelled' WHERE id=${f.author}`;
    await rejects(submit(f.author,await proposal(f)));
    await sql`UPDATE jobs SET status='running' WHERE id=${f.author}`;
    const tooMany=await proposal(f);tooMany.plan.tasks.push({...tooMany.plan.tasks[0],id:'second'});
    await rejects(submit(f.author,tooMany),'invalid_payload');
    const [attempt]=await sql`SELECT id FROM job_attempts WHERE job_id=${f.author}`;
    await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status) VALUES(${attempt.id},${f.author},'unknown','execution','unknown')`;
    await rejects(submit(f.author,await proposal(f)),'plan_unknown_effect');
    await sql`UPDATE job_attempt_effects SET status='settled' WHERE attempt_id=${attempt.id}`;
    const historicalAttempt=randomUUID();
    await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${historicalAttempt},${f.author},2,'failed','terminal')`;
    await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status) VALUES(${historicalAttempt},${f.author},'historical-pending','execution','effect_pending')`;
    await rejects(submit(f.author,await proposal(f)),'plan_unknown_effect');
    await sql`UPDATE job_attempt_effects SET status='settled' WHERE attempt_id=${historicalAttempt}`;
    const pending=randomUUID(),pendingKey=randomUUID();
    await sql`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES(${f.author},${pending},100,'control_receipt',${sql.json({operation:'submit_hub_decision',status:'persisted_deferred',event_id:pendingKey})})`;
    await rejects(submit(f.author,await proposal(f)),'plan_stale_revision');
    await sql`DELETE FROM events WHERE event_id=${pending}`;
    // Persisted continue audit is the existing Canvas-wide budget authority, regardless of child status.
    const spent=randomUUID();
    await sql`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES(${f.author},${spent},101,'hub_decision',${sql.json({plan_basis:{v:1,plan_job_id:f.owner,plan_sha256:current.planSha,criterion_id:'completion',expected_revision:current.revision,expected_task_input_sha256:current.baseline,expected_projection_sha256:current.projectionSha,source_refs:[],outcome:'continue',rationale:'Scoped collection',expected_gain:'Retain record'}})})`;
    await rejects(submit(f.owner,await proposal(f)),'plan_budget_exhausted');
    // Both contenders use the original head; Canvas serialization permits only one mutation.
    const dispatchRace=await fixture();
    await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json,'{platform_tools}',${sql.json(['submit_plan','request_human','submit_hub_decision','graph_query'])}) WHERE id=${dispatchRace.author}`;
    const [dispatchRoot]=await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json) VALUES(${dispatchRace.canvas},'root','Saved objective','active','{}') RETURNING id`;
    const {executeGraphQuery}=await import('./graph-query.js');
    await executeGraphQuery({jobId:dispatchRace.author,canvasId:dispatchRace.canvas,payload:{kind:'plan_gap'}});
    const dispatchObjective=await readPlanObjective(sql,dispatchRace.author,dispatchRace.canvas,dispatchRace.owner);
    const dispatchBasis={v:1,plan_job_id:dispatchRace.owner,plan_sha256:dispatchObjective.planSha,criterion_id:'completion',expected_revision:dispatchObjective.revision,expected_task_input_sha256:dispatchObjective.baseline,expected_projection_sha256:dispatchObjective.projectionSha,source_refs:[],outcome:'continue',rationale:'Retain scoped record',expected_gain:'One scoped record'};
    const dispatchResults=await Promise.allSettled([
      submit(dispatchRace.author,await proposal(dispatchRace)),
      ingestEvent(dispatchRace.author,{v:1,event_id:randomUUID(),type:'hub_decision',payload:{intents:[{from:[dispatchRoot.id],role:'review',description:'Collect one scoped record',prompt:'Review only the saved scope and retain evidence.'}],plan_basis:dispatchBasis}} as never),
    ]);
    assert.equal(dispatchResults.filter(result=>result.status==='fulfilled').length,1,'dispatch and revision cannot both accept the old head');
    const dispatchLoser=dispatchResults.find(result=>result.status==='rejected') as PromiseRejectedResult;
    assert.ok(dispatchLoser.reason instanceof ControlInputError,String(dispatchLoser.reason?.stack ?? dispatchLoser.reason));
    assert.ok(['plan_stale_revision','plan_budget_exhausted'].includes(dispatchLoser.reason.code),String(dispatchLoser.reason));
    const editRace=await fixture(),editProposal=await proposal(editRace);
    let editingRevision:Promise<unknown>|undefined;
    await sql.begin(async tx=>{
      await tx`SELECT id FROM canvases WHERE id=${editRace.canvas} FOR UPDATE`;
      editingRevision=submit(editRace.author,editProposal).then(value=>({value}),error=>({error}));
      await tx`UPDATE canvases SET title='New saved user scope' WHERE id=${editRace.canvas}`;
    });
    const editingResult=await editingRevision as {error?:unknown};
    assert.ok(editingResult.error instanceof ControlInputError);
    assert.equal(editingResult.error.code,'plan_stale_revision','waiting route proposal must recheck the task input under Canvas lock');
    // Exercise the actual knowledge application, including its derived event ID and receipt table.
    const {createProjectKnowledgeApplication,KnowledgeOperationError}=await import('./domains/project-knowledge/application.js');
    const {canonical,sha256}=await import('./domains/project-knowledge/types.js');
    const knowledge=createProjectKnowledgeApplication({db:sql,governanceHash:'a'.repeat(64)});
    for(const order of ['knowledge_first','revision_first','concurrent'] as const){
      const mixed=await fixture(),mixedKey=randomUUID();
      await sql`UPDATE jobs SET agent_snapshot_json=agent_snapshot_json || ${sql.json({
        platform_tools:['submit_plan','suggest_project_skills','record_skill_choice'],
        project_knowledge_catalog:{entries:[],hash:sha256(canonical([]))},
        runtime_image:{image_digest:`sha256:${'a'.repeat(64)}`},network_policy:{allow_egress:false},
      })} WHERE id=${mixed.author}`;
      const target={task_type:'audit',input_kind:'source',target_version:'v1'};
      const context={jobId:mixed.author,canvasId:mixed.canvas,projectId:project,tokenId:randomUUID(),eventId:randomUUID(),idempotencyKey:mixedKey};
      const suggestion=await knowledge.invoke({...context,operationId:'suggest_project_skills',input:{target,limit:5}});
      const choice=()=>knowledge.invoke({...context,operationId:'record_skill_choice',input:{target,limit:5,policy_version:suggestion.policy_version,context_hash:suggestion.context_hash,catalog_hash:suggestion.catalog_hash,decision:'none',reason:'No applicable candidate'}});
      const mixedProposal=await proposal(mixed);
      if(order==='knowledge_first'){
        assert.equal((await choice()).decision,'none');
        await rejects(submit(mixed.author,mixedProposal,mixedKey),'invalid_payload');
      }else if(order==='revision_first'){
        await submit(mixed.author,mixedProposal,mixedKey);
        await assert.rejects(choice(),(error:unknown)=>error instanceof KnowledgeOperationError && error.error_code==='KNOWLEDGE_IDEMPOTENCY_CONFLICT');
      }else{
        const results=await Promise.allSettled([choice(),submit(mixed.author,mixedProposal,mixedKey)]);
        assert.equal(results.filter(result=>result.status==='fulfilled').length,1,'same Job lock serializes cross-ledger key ownership');
        const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
        assert.ok(rejected.reason instanceof ControlInputError || rejected.reason instanceof KnowledgeOperationError);
        assert.ok(['invalid_payload','KNOWLEDGE_IDEMPOTENCY_CONFLICT'].includes(rejected.reason instanceof KnowledgeOperationError?rejected.reason.error_code:rejected.reason.code),String(rejected.reason));
      }
      const receipts=await sql`SELECT id FROM project_knowledge_receipts WHERE job_id=${mixed.author} AND idempotency_key=${mixedKey}`;
      const revisions=await sql`SELECT id FROM events WHERE job_id=${mixed.author} AND event_id=${mixedKey} AND type='plan'`;
      assert.equal(receipts.length+revisions.length,1,'one key owns exactly one durable operation');
    }
    // HTTP success is recovered from the committed semantic event after handler/cache loss.
    const api=await import('./domains/platform-api/index.js');
    const {default:Fastify}=await import('fastify');
    const app=Fastify({logger:false});api.registerPlatformControlRoutes(app);await app.ready();close=()=>app.close();
    const http=await fixture();
    await sql`UPDATE jobs SET status='provisioning' WHERE id=${http.author}`;
    const grant=await api.mintJobCapabilityToken(http.author);
    await sql`UPDATE jobs SET status='running' WHERE id=${http.author}`;
    await api.activateProvisionedJobCapabilityTokens(http.author);
    let calls=0;
    const handler:import('./domains/platform-api/index.js').PlatformRuntimeHandler=async context=>{
      calls++;
      try{return await ingestEvent(context.jobId,{v:1,event_id:context.eventId,type:context.operationId==='submit_plan'?'plan':'human',payload:context.input} as never);}
      catch(error){if(error instanceof ControlInputError) throw new api.PlatformRuntimeHandlerError('OPERATION_REJECTED',error.message,{statusCode:409,errorCode:error.code,retryable:false});throw error;}
    };
    api.registerRuntimeHandler(http.author,handler,['submit_plan','request_human']);
    const post=(operation:string,payload:unknown,key:string)=>app.inject({method:'POST',url:`/control/v1/jobs/${http.author}/operations/${operation}`,headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':key},payload:payload as never});
    const httpKey=randomUUID(),httpPayload=await proposal(http);
    const acceptedHttp=await post('submit_plan',httpPayload,httpKey);
    assert.equal(acceptedHttp.statusCode,200,acceptedHttp.payload);assert.equal(acceptedHttp.json().receipt_status,'committed');
    const originalResponse=acceptedHttp.json(),originalCalls=calls;
    api.clearPlatformApiIdempotencyCache();api.unregisterRuntimeHandler(http.author);
    const recovered=await post('submit_plan',httpPayload,httpKey);
    assert.equal(recovered.statusCode,200,recovered.payload);assert.deepEqual(recovered.json(),originalResponse);assert.equal(calls,originalCalls);
    const lookup=await app.inject({method:'GET',url:`/control/v1/jobs/${http.author}/operations/submit_plan?receipt_key=${httpKey}`,headers:{authorization:`Bearer ${grant.token}`}});
    assert.equal(lookup.statusCode,200,lookup.payload);assert.deepEqual(lookup.json(),originalResponse);assert.equal(calls,originalCalls);
    const changedHttp=await post('submit_plan',{...httpPayload,plan:route('changed replay')},httpKey);
    assert.equal(changedHttp.statusCode,409,changedHttp.payload);assert.equal(changedHttp.json().error_code,'IDEMPOTENCY_KEY_CONFLICT');
    const wrongOperation=await post('request_human',{reason:'Wrong operation under accepted route key',subject:{type:'platform_blocker',kind:'business_decision'}},httpKey);
    assert.equal(wrongOperation.statusCode,409,wrongOperation.payload);assert.equal(wrongOperation.json().error_code,'IDEMPOTENCY_KEY_CONFLICT');
    api.registerRuntimeHandler(http.author,handler,['submit_plan','request_human']);
    const nextHttp=await proposal(http,route('another revision'));
    await sql`UPDATE jobs SET lease_expires_at=now()-interval '1 minute' WHERE id=${http.author}`;
    const expired=await post('submit_plan',nextHttp,randomUUID());assert.ok(expired.statusCode>=400,expired.payload);
    assert.equal((await sql`SELECT id FROM events WHERE job_id=${http.author} AND type='plan'`).length,1,'expired lease cannot commit a revision');
    const beforeRevocation=calls;
    await sql`UPDATE jobs SET lease_expires_at=now()+interval '5 minutes' WHERE id=${http.author}`;
    await sql`UPDATE job_capability_tokens SET revoked_at=now(),revoke_reason='test_revocation' WHERE job_id=${http.author}`;
    const revoked=await post('submit_plan',nextHttp,randomUUID());assert.ok(revoked.statusCode>=400,revoked.payload);
    assert.equal(calls,beforeRevocation,'revoked capability cannot invoke runtime');
    assert.equal((await sql`SELECT id FROM events WHERE job_id=${http.author} AND type='plan'`).length,1);
    api.unregisterRuntimeHandler(http.author);
    const human=await fixture(),objective=await readPlanObjective(sql,human.owner,human.canvas,human.owner);
    await ingestEvent(human.owner,{v:1,event_id:randomUUID(),type:'human',payload:{reason:'Operator decision before any supplementation',subject:{type:'platform_blocker',kind:'business_decision'},plan_basis:{v:1,plan_job_id:human.owner,plan_sha256:objective.planSha,criterion_id:'completion',expected_revision:objective.revision,expected_task_input_sha256:objective.baseline,expected_projection_sha256:objective.projectionSha,source_refs:[],outcome:'needs_human',rationale:'Need operator assessment'}}});
    await submit(human.author,await proposal(human));
    const afterHuman=await readPlanObjective(sql,human.author,human.canvas,human.owner);
    assert.equal(afterHuman.staleObjective,false,'accepted route revision supersedes route hash without changing user scope');
    assert.equal(afterHuman.spent,false);assert.deepEqual(afterHuman.plan.completion,plan.completion);
    assert.equal((await sql`SELECT count(*)::int AS count FROM jobs WHERE parent_job_id=${human.owner}`)[0].count,0,'route revision never dispatches');
  }finally{
    await close?.();await end?.();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();
  }
});
