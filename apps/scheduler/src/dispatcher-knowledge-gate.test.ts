import test from 'node:test';
import assert from 'node:assert/strict';
import {claimThenTickKnowledge, requestKnowledgeAdvance, tickKnowledgeBeforeDispatch} from './dispatcher-knowledge-gate.js';
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
  const db=Object.assign(async(parts:TemplateStringsArray)=>{if(/^\s*COALESCE\(\(/.test(parts[0]))return [];reads++;stopped=true;return [{id:'pending'}];},{begin:async()=>{throw Error('must not begin after stop');}});
  const scheduler=createKnowledgeWorkScheduler({db:db as unknown as Parameters<typeof createKnowledgeWorkScheduler>[0]['db'],governanceHash:'a'.repeat(64),
    createJobInTransaction:async()=>{throw Error('must not create');},ensureCanvasForTaskInTransaction:async()=>{throw Error('must not create');}});
  assert.equal(await scheduler.tick(()=>stopped),0);assert.equal(reads,1);
});
test('knowledge claim stops after locked-row read without UPDATE',async()=>{
  const {createKnowledgeWorkScheduler}=await import('./domains/project-knowledge/work.js');
  let stopped=false,queries=0;
  const tx=async(parts:TemplateStringsArray)=>{if(/^\s*COALESCE\(\(/.test(parts[0]))return [];queries++;stopped=true;return [{id:'pending',project_id:'project'}];};
  const db=Object.assign(async(parts:TemplateStringsArray)=>{if(/^\s*COALESCE\(\(/.test(parts[0]))return [];queries++;return [{id:'pending'}];},{begin:async(fn:(value:typeof tx)=>Promise<void>)=>fn(tx)});
  const scheduler=createKnowledgeWorkScheduler({db:db as unknown as Parameters<typeof createKnowledgeWorkScheduler>[0]['db'],governanceHash:'a'.repeat(64),
    createJobInTransaction:async()=>{throw Error('must not create');},ensureCanvasForTaskInTransaction:async()=>{throw Error('must not create');}});
  assert.equal(await scheduler.tick(()=>stopped),0);assert.equal(queries,2);
});

test("#1287 领取与启动先于知识推进，知识失败不影响已领取任务", async () => {
  const order: string[] = [];
  const claimed = [{ id: "job-1" }, { id: "job-2" }];
  const count = await claimThenTickKnowledge(() => false,
    async () => { order.push("claim"); return claimed; },
    (jobs) => { order.push(`start:${jobs.length}`); },
    async () => ({ tick: async () => { order.push("tick"); throw new Error("collection slow/failed"); } }));
  assert.equal(count, 2);
  assert.deepEqual(order, ["claim", "start:2", "tick"], "普通任务必须先领取并启动，知识推进在后");
});

test("#1287 停机后不再进入知识推进，但已领取的任务照常返回", async () => {
  let stopped = false;
  const count = await claimThenTickKnowledge(() => stopped,
    async () => { stopped = true; return [{ id: "job-1" }]; },
    () => undefined,
    async () => { throw new Error("must not load knowledge scheduler after stop"); });
  assert.equal(count, 1);
});

test("#1287 知识推进在后台单飞，不阻塞随后到达的领取", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ticks = 0;
  const first = requestKnowledgeAdvance(() => false, async () => ({
    tick: async () => { ticks += 1; await gate; return 1; } }));
  const second = requestKnowledgeAdvance(() => false, async () => ({
    tick: async () => { ticks += 1; return 1; } }));
  assert.equal(first, second, "同一时刻只有一个知识 tick（单飞）");
  // 调用方不必 await：慢查询挂住时 dispatchOnce 已经返回，下一次 kick 仍能先领取。
  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "知识 tick 未返回时不应阻塞调用方");
  release();
  await first;
  assert.equal(ticks, 1);
  // 停机后不再加载知识调度器。
  let loaded = false;
  await requestKnowledgeAdvance(() => true, async () => { loaded = true; return { tick: async () => 0 }; });
  assert.equal(loaded, false);
  // 知识侧失败只记日志，不抛出。
  await requestKnowledgeAdvance(() => false, async () => ({ tick: async () => { throw new Error("collection failed"); } }));
});
