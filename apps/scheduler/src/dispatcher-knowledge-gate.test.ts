import test from 'node:test';
import assert from 'node:assert/strict';
import {tickKnowledgeBeforeDispatch} from './dispatcher-knowledge-gate.js';
test('maintenance stopped entry never loads knowledge scheduler',async()=>{
  assert.equal(await tickKnowledgeBeforeDispatch(()=>true,async()=>{throw Error('must not load');}),false);
});
test('stop during module load prevents knowledge writes',async()=>{
  let stopped=false;
  assert.equal(await tickKnowledgeBeforeDispatch(()=>stopped,async()=>{stopped=true;return {tick:async()=>{throw Error('must not tick');}};}),false);
});
test('stop during knowledge tick prevents normal claim stage',async()=>{
  let stopped=false;
  assert.equal(await tickKnowledgeBeforeDispatch(()=>stopped,async()=>({tick:async predicate=>{assert.equal(predicate(),false);stopped=true;return 1;}})),false);
});
test('active generation proceeds after knowledge tick',async()=>{
  assert.equal(await tickKnowledgeBeforeDispatch(()=>false,async()=>({tick:async()=>1})),true);
});
test('knowledge claim stops after pending read without starting a transaction',async()=>{
  const {createKnowledgeWorkScheduler}=await import('./domains/project-knowledge/work.js');
  let stopped=false,reads=0;
  const db=Object.assign(async()=>{reads++;stopped=true;return [{id:'pending'}];},{begin:async()=>{throw Error('must not begin after stop');}});
  const scheduler=createKnowledgeWorkScheduler({db:db as unknown as Parameters<typeof createKnowledgeWorkScheduler>[0]['db'],governanceHash:'a'.repeat(64),
    createJobInTransaction:async()=>{throw Error('must not create');},ensureCanvasForTaskInTransaction:async()=>{throw Error('must not create');}});
  assert.equal(await scheduler.tick(()=>stopped),0);assert.equal(reads,1);
});
test('knowledge claim stops after locked-row read without UPDATE',async()=>{
  const {createKnowledgeWorkScheduler}=await import('./domains/project-knowledge/work.js');
  let stopped=false,queries=0;
  const tx=async()=>{queries++;stopped=true;return [{id:'pending',project_id:'project'}];};
  const db=Object.assign(async()=>{queries++;return [{id:'pending'}];},{begin:async(fn:(value:typeof tx)=>Promise<void>)=>fn(tx)});
  const scheduler=createKnowledgeWorkScheduler({db:db as unknown as Parameters<typeof createKnowledgeWorkScheduler>[0]['db'],governanceHash:'a'.repeat(64),
    createJobInTransaction:async()=>{throw Error('must not create');},ensureCanvasForTaskInTransaction:async()=>{throw Error('must not create');}});
  assert.equal(await scheduler.tick(()=>stopped),0);assert.equal(queries,2);
});
