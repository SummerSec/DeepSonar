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
