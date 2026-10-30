import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {GraphQueryPayload,HubDecisionPayload,HumanPayload,PlanDecisionBasis,repairCategoryForControlFailure} from '@deepsonar/shared-types';
import {criteriaAuthorizeCompletion} from './domains/plan-protocol/decision.js';
import {mergePlanRead} from './domains/plan-protocol/gap-query.js';
import {taskInputSha256} from './domains/plan-protocol/task-input.js';
import type {CriterionProjection,CriterionState} from './domains/plan-protocol/criterion-model.js';
import {parseHubDecisionPayload} from './graph.js';

const fact=randomUUID();
const basis=PlanDecisionBasis.parse({v:1,plan_job_id:randomUUID(),plan_sha256:'a'.repeat(64),criterion_id:'completion',
  expected_revision:'42',expected_task_input_sha256:'b'.repeat(64),expected_projection_sha256:'c'.repeat(64),
  source_refs:[{fact_id:fact,source_sha256:'d'.repeat(64)}],outcome:'continue',rationale:'A scoped evidence gap remains',expected_gain:'Collect the missing execution record'});
const intent={role:'review',description:'Review scoped execution',prompt:'Review the scoped evidence and retain the missing execution record.',from:[fact]};

test('versioned Plan metadata stays on the existing decision path',()=>{
  assert.equal(repairCategoryForControlFailure({code:'plan_unknown_effect',retryable:false}), 'unknown_external_effect');
  const decision={intents:[intent],plan_basis:basis};
  assert.equal(HubDecisionPayload.safeParse(decision).success,true);
  assert.deepEqual(parseHubDecisionPayload(decision).plan_basis,basis);
  assert.equal(HubDecisionPayload.safeParse({...decision,intents:[intent,intent]}).success,false);
  assert.equal(HubDecisionPayload.safeParse({payload_file:'plan.json',plan_basis:basis}).success,false);
  assert.equal(HubDecisionPayload.safeParse({complete:{from:[fact],description:'The scoped goal is complete'},plan_basis:basis}).success,false);
  assert.equal(PlanDecisionBasis.safeParse({...basis,v:2}).success,false);
  assert.equal(PlanDecisionBasis.safeParse({...basis,source_refs:[...basis.source_refs,...basis.source_refs]}).success,false);
  assert.equal(PlanDecisionBasis.safeParse({...basis,expected_revision:'1.5'}).success,false);
  for(const outcome of ['blocked','needs_human'] as const){
    const stop={...basis,outcome,expected_gain:undefined};
    assert.equal(HumanPayload.safeParse({reason:'Need an authorized semantic assessment',subject:{type:'platform_blocker',kind:'business_decision'},plan_basis:stop}).success,true);
    assert.equal(HubDecisionPayload.safeParse({...decision,plan_basis:stop}).success,false);
  }
});

test('complete truth table requires every necessary positively authorized criterion',()=>{
  const positive={id:'completion',text:'Scoped completion',state:'satisfied',truncated:false,
    bindings:[{state:'satisfied',reasons:[],binding:{v:1,binding_id:randomUUID(),fact_id:fact,plan_job_id:basis.plan_job_id,plan_sha256:basis.plan_sha256,criterion_id:'completion',criterion_sha256:'e'.repeat(64),expected_source_sha256:'d'.repeat(64),verification_epoch:'epoch',rationale:'Reviewed current scoped evidence',source:{job_id:randomUUID(),attempt_id:randomUUID(),event_id:randomUUID(),artifact_id:randomUUID(),artifact_revision:1,evidence_ids:[randomUUID()]},authority:'operator_attestation',assessment:'satisfies',observation:'negative'}}]} as CriterionProjection;
  assert.equal(criteriaAuthorizeCompletion([positive],['completion']),true);
  for(const state of ['unbound','insufficient','contradicted','conflict','stale','blocked'] as CriterionState[]){
    assert.equal(criteriaAuthorizeCompletion([{...positive,state}],['completion']),false,state);
  }
  assert.equal(criteriaAuthorizeCompletion([],[]),false);
  assert.equal(criteriaAuthorizeCompletion([positive],['completion','output-0']),false);
  assert.equal(criteriaAuthorizeCompletion([{...positive,truncated:true}],['completion']),false);
  for(const assessment of ['contradicts','inconclusive'] as const){
    const contradictory={...positive,bindings:positive.bindings.map(b=>({...b,binding:{...b.binding,assessment}}))};
    assert.equal(criteriaAuthorizeCompletion([contradictory],['completion']),false);
  }
  assert.equal(criteriaAuthorizeCompletion([{...positive,bindings:[]}],['completion']),false);
});

test('read proof resets on a changed projection and paging stays bounded',()=>{
  assert.deepEqual(mergePlanRead({projection_sha256:'a',criterion_ids:['completion']},{projection_sha256:'a',criterion_ids:['output-0']}),
    {projection_sha256:'a',criterion_ids:['completion','output-0']});
  assert.deepEqual(mergePlanRead({projection_sha256:'a',criterion_ids:['completion']},{projection_sha256:'b',criterion_ids:['output-0']}),
    {projection_sha256:'b',criterion_ids:['output-0']});
  assert.equal(GraphQueryPayload.safeParse({kind:'plan_gap',id:randomUUID(),ids:[fact],limit:4,cursor:'4'}).success,true);
  for(const extra of [{limit:5},{cursor:'../1'},{node_type:'fact'},{ids:Array.from({length:5},()=>randomUUID())}]){
    assert.equal(GraphQueryPayload.safeParse({kind:'plan_gap',...extra}).success,false);
  }
});

test('task input baseline includes saved intent and scope, excludes runtime convergence bookkeeping',()=>{
  const target={goal:'Scoped objective',network_policy:{allow_egress:false}};
  assert.equal(taskInputSha256('Task',target),taskInputSha256('Task',{...target,convergence:{paused_at:'now',hub_paused:true}}));
  assert.notEqual(taskInputSha256('Task',target),taskInputSha256('Task',{...target,goal:'Changed objective'}));
  assert.notEqual(taskInputSha256('Task',target),taskInputSha256('Task',{...target,network_policy:{allow_egress:true}}));
});


test('deferred runtime events preserve Plan basis for dispatch, completion and human stop',async()=>{
  const {buildDeferredSemanticTerminalEvents}=await import('./executor-real.js');
  const done={eventId:randomUUID(),summary:'Scoped execution completed'};
  const build=(decision: ReturnType<typeof parseHubDecisionPayload>)=>buildDeferredSemanticTerminalEvents({
    state:{done,hub:{eventId:randomUUID(),payload:decision},human:null},isHub:true,isVerify:false,hubDecision:decision,maxIntentsPerDecision:1,factCount:0,findingCount:0,
  });
  assert.deepEqual((build(parseHubDecisionPayload({intents:[intent],plan_basis:basis}))[0].payload as any).plan_basis,basis);
  const complete={...basis,outcome:'complete',expected_gain:undefined};
  assert.deepEqual((build(parseHubDecisionPayload({complete:{from:[fact],description:'Reviewed all current criteria'},plan_basis:complete}))[0].payload as any).plan_basis,complete);
  const stop={...basis,outcome:'needs_human' as const,expected_gain:undefined};
  const events=buildDeferredSemanticTerminalEvents({state:{done:null,hub:null,human:{eventId:randomUUID(),reason:'Need operator assessment',subject:{type:'platform_blocker',kind:'business_decision'},plan_basis:stop}},isHub:true,isVerify:false,hubDecision:null,maxIntentsPerDecision:1,factCount:0,findingCount:0});
  assert.deepEqual((events[0].payload as any).plan_basis,stop);
});


test('report availability names Plan blockers without blaming unrelated Findings',async()=>{
  const {classifyTaskReportAvailability}=await import('./report.js');
  assert.equal(classifyTaskReportAvailability({rootStatus:'analysis_complete',minVerifySeverity:null,blockers:['plan_criteria_unproven'],problems:[]}).reason,'plan_not_ready');
});
