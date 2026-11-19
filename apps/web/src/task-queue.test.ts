import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AuthMe, ProjectTaskQueue } from "./api";
import {
  canAccessProjectScope,
  groupProjectTaskQueue,
  projectTaskQueueAction,
  projectTaskQueueBlockReasonLabel,
} from "./task-queue-model";
import { projectTaskQueueCreatedMessage } from "./components/ProjectTaskQueuePanel";

const projectViewer: AuthMe = {
  auth_required: true,
  authenticated: true,
  actor: { type: "api_token", name: "viewer", role: null, project_id: "project-a", scopes: ["tasks:read"] },
  user: null,
};

const queue: ProjectTaskQueue = {
  project_id: "project-a",
  paused: false,
  pause_reason: null,
  has_more: false,
  items: [
    { id: "active", canvas_id: "canvas-a", title: "当前任务", state: "active", created_at: "2026-11-08T00:00:00Z", started_at: null, ended_at: null, block_reason: "waiting_human" },
    { id: "queued", canvas_id: "canvas-b", title: "后续任务", state: "queued", created_at: "2026-11-08T00:01:00Z", started_at: null, ended_at: null, block_reason: "waiting_turn" },
    { id: "done", canvas_id: "canvas-c", title: "历史任务", state: "succeeded", created_at: "2026-11-07T00:00:00Z", started_at: null, ended_at: "2026-11-07T01:00:00Z", block_reason: null },
  ],
};

test("project queue access checks both capability and project-bound token scope", () => {
  assert.equal(canAccessProjectScope(projectViewer, "project-a", ["tasks:read"]), true);
  assert.equal(canAccessProjectScope(projectViewer, "project-b", ["tasks:read"]), false);
  assert.equal(canAccessProjectScope(projectViewer, "project-a", ["jobs:control"]), false);
  assert.equal(canAccessProjectScope(null, "project-a", ["tasks:read"]), false);
});

test("queue rows separate active placeholder, FIFO waiters, and ended history", () => {
  const groups = groupProjectTaskQueue(queue);
  assert.deepEqual(groups.active.map((item) => item.id), ["active"]);
  assert.deepEqual(groups.queued.map((item) => item.id), ["queued"]);
  assert.deepEqual(groups.history.map((item) => item.id), ["done"]);
  assert.equal(projectTaskQueueBlockReasonLabel("waiting_human"), "等待人工处理");
  assert.equal(projectTaskQueueBlockReasonLabel("unknown_effect"), "存在未结清的外部效果");
});

test("failure resume requires explicit skip and unknown effects disable queue resume", () => {
  assert.equal(projectTaskQueueAction({ ...queue, paused: true, pause_reason: "manual" }), "resume");
  assert.equal(projectTaskQueueAction({
    ...queue,
    paused: true,
    pause_reason: "manual",
    items: [{ ...queue.items[0]!, block_reason: "task_failed" }, ...queue.items.slice(1)],
  }), "resume-after-failure", "manual pause does not bypass acknowledgement of a failed head");
  assert.equal(projectTaskQueueAction({
    ...queue,
    paused: true,
    pause_reason: "task_failed",
    items: [{ ...queue.items[0]!, block_reason: "task_failed" }, ...queue.items.slice(1)],
  }), "resume-after-failure");
  assert.equal(projectTaskQueueAction({
    ...queue,
    paused: true,
    pause_reason: "task_cancelled",
    items: [{ ...queue.items[1]!, block_reason: "task_cancelled" }, ...queue.items.slice(0, 1), ...queue.items.slice(2)],
  }), "resume-after-failure");
  assert.equal(projectTaskQueueAction({
    ...queue,
    paused: true,
    pause_reason: "manual",
    items: [{ ...queue.items[0]!, block_reason: "unknown_effect" }, ...queue.items.slice(1)],
  }), null);
});

test("creation toast follows accepted enqueue state and does not claim Hub has started", () => {
  assert.equal(projectTaskQueueCreatedMessage(true, true, null), "任务已加入项目串行队列，轮到它时才会开始。");
  assert.equal(projectTaskQueueCreatedMessage(true, false, null), "任务已创建，但服务端未确认加入项目串行队列。");
  assert.equal(projectTaskQueueCreatedMessage(false, false, null), "任务已入队，Hub 正在决定执行路径");
});

test("task creation and project page expose queue controls without adding a project tab", () => {
  const page = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./components/ProjectTaskQueuePanel.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(panel, /加入项目串行队列/);
  assert.match(page, /enqueue: true/);
  assert.match(page, /taskFeedbackItems\(result\)\.length \|\| result\.enqueued/);
  assert.match(page, /ProjectTaskQueuePanel projectId=/);
  assert.match(page, /queueState: c\.queue_state/);
  assert.match(page, /queueState: canvas\.queue_state/);
  assert.match(panel, /轮到它时才会开始/);
  assert.match(client, /projectTaskQueue:/);
  assert.match(client, /setProjectTaskQueuePaused:/);
  assert.match(client, /acknowledge_failed_head/);
  assert.match(client, /enqueueProjectTaskQueueItem:/);
  assert.match(client, /enqueued: boolean/);
  assert.match(panel, /REFRESH_MS = 15_000/);
  assert.match(panel, /clearInterval\(timer\)/);
  assert.match(panel, /generation !== queueGeneration\.current/);
  assert.match(panel, /api\.setProjectTaskQueuePaused\(projectId, paused, failedHeadId\)/);
  assert.match(panel, /if \(!active \|\| mutationLock\.current \|\| inFlight\) return/);
  assert.match(panel, /controller\.abort\(\)/);
  assert.match(panel, /canAccessProjectScope\(me, projectId, \["jobs:control"\]\)/);
  assert.match(panel, /setReloadKey\(\(key\) => key \+ 1\)/);
  assert.match(panel, /has_more \? "还有更多项目未显示/);
});

test("yielded tasks remain visible separately from execution order and terminal history", () => {
  const yielded={...queue.items[0],id:"500",state:"yielded" as const};
  const grouped=groupProjectTaskQueue({...queue,items:[yielded]});
  assert.deepEqual(grouped.yielded,[yielded]);
  assert.deepEqual(grouped.queued,[]);
  assert.deepEqual(grouped.history,[]);
});

test("queue button sends one precise yield decision, retries its identity and renders the yielded task", async () => {
  const {JSDOM}=await import("jsdom");
  const {act,createElement}=await import("react");
  const {createRoot}=await import("react-dom/client");
  const {MemoryRouter}=await import("react-router-dom");
  const {api}=await import("./api");
  const {AuthProvider}=await import("./auth");
  const {ConfirmDialogProvider}=await import("./components/ConfirmDialog");
  const {ProjectTaskQueuePanel}=await import("./components/ProjectTaskQueuePanel");
  const dom=new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",{url:"http://127.0.0.1"});
  const globals:Record<string,unknown>={window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,
    HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{value,configurable:true});
  const original={authStatus:api.authStatus,projectTaskQueue:api.projectTaskQueue,yieldProjectTaskQueue:api.yieldProjectTaskQueue,
    setProjectTaskQueuePaused:api.setProjectTaskQueuePaused};
  const item={...queue.items[0]!,id:"42",yield_request:{request_id:"11111111-1111-4111-8111-111111111111",expected_revision:3}};
  const oldYielded=Array.from({length:100},(_,index)=>({...queue.items[0]!,id:String(index+1),canvas_id:`old-${index}`,
    state:"yielded" as const,yield_request:null}));
  let current:ProjectTaskQueue={...queue,has_more:true,items:[item,...oldYielded.slice(0,99)]};
  const decisions:Array<Parameters<typeof api.yieldProjectTaskQueue>[1]>=[];
  let finish:((value:ProjectTaskQueue)=>void)|undefined;
  const container=dom.window.document.getElementById("root")!;
  const root=createRoot(container);
  const yieldButton=()=>[...container.querySelectorAll("button")].find(button=>button.textContent?.includes("暂存并让下一项先做"));
  try {
    api.authStatus=async()=>({auth_required:false,has_users:false,bootstrap_available:false,default_admin_credentials_active:false,session_ttl_days:1});
    api.projectTaskQueue=async()=>current;
    api.yieldProjectTaskQueue=async(projectId,input)=>{
      assert.equal(projectId,queue.project_id);decisions.push(input);
      if(decisions.length===1) throw new Error("connection closed after submission");
      return new Promise<ProjectTaskQueue>(resolve=>{finish=resolve;});
    };
    await act(async()=>root.render(createElement(MemoryRouter,null,createElement(AuthProvider,null,
      createElement(ConfirmDialogProvider,null,createElement(ProjectTaskQueuePanel,{projectId:queue.project_id}))))));
    assert.ok(yieldButton());
    await act(async()=>yieldButton()!.click());
    assert.match(container.textContent??"",/暂存让位失败/);
    await act(async()=>{yieldButton()!.click();yieldButton()!.click();});
    assert.equal(decisions.length,2,"the pending retry blocks duplicate clicks");
    assert.deepEqual(decisions[1],decisions[0],"network uncertainty retries the exact mutation");
    assert.deepEqual({...decisions[0],mutation_id:"same"},{mutation_id:"same",canvas_id:item.canvas_id,expected_item_id:"42",
      request_id:item.yield_request.request_id,expected_revision:3});
    current={...queue,items:[{...item,state:"yielded",yield_request:null}]};
    await act(async()=>{finish!(current);await Promise.resolve();});
    assert.equal(yieldButton(),undefined);
    assert.match(container.textContent??"",/暂存等待回复/);
    assert.match(container.textContent??"",/回复后排到队尾/);
    let acknowledged:string|undefined;
    current={...queue,paused:true,pause_reason:"task_failed",has_more:true,
      items:[{...item,state:"active",block_reason:"task_failed",yield_request:null},...oldYielded.slice(0,99)]};
    api.setProjectTaskQueuePaused=async(projectId,paused,headId)=>{
      assert.equal(projectId,queue.project_id);assert.equal(paused,false);acknowledged=headId;
      return {...current,paused:false,pause_reason:null,items:current.items.map(entry=>entry.id===item.id?{...entry,state:"failed",block_reason:null}:entry)};
    };
    await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-label="刷新项目队列"]')!.click());
    const skip=[...container.querySelectorAll("button")].find(button=>button.textContent==="确认后跳过并继续");
    assert.ok(skip,"failed head remains actionable with a full yielded projection");
    await act(async()=>skip.click());
    const confirm=[...dom.window.document.querySelectorAll("button")].find(button=>button.textContent==="跳过并继续");
    assert.ok(confirm);await act(async()=>confirm.click());
    assert.equal(acknowledged,item.id,"skip uses the current head identity");
  } finally {
    act(()=>root.unmount());Object.assign(api,original);dom.window.close();
    for(const [key,descriptor] of previous) {if(descriptor) Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];}
  }
});
