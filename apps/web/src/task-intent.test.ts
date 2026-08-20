import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AuthMe } from "./api";
import { api } from "./api";
import {
  canEditTaskIntent,
  TASK_INTENT_SAVED_IDLE,
  TASK_INTENT_SAVED_RUNNING,
  taskIntentContentFromTarget,
  taskIntentSavedMessage,
} from "./task-intent";

const viewer: AuthMe = {
  auth_required: true,
  authenticated: true,
  actor: { type: "user", name: "viewer", role: "viewer", scopes: ["tasks:read"] },
  user: null,
};
const operator: AuthMe = {
  auth_required: true,
  authenticated: true,
  actor: { type: "user", name: "operator", role: "operator", scopes: ["tasks:write"] },
  user: null,
};

test("viewer stays read-only; operator can edit non-archived tasks", () => {
  assert.equal(canEditTaskIntent(viewer, false), false);
  assert.equal(canEditTaskIntent(operator, false), true);
  assert.equal(canEditTaskIntent(operator, true), false);
  assert.equal(canEditTaskIntent(null, false), false);
});

test("intent helpers prefer content and keep snapshot copy", () => {
  assert.equal(taskIntentContentFromTarget({ content: "范围", goal: "旧" }), "范围");
  assert.equal(taskIntentContentFromTarget({ goal: "仅 goal" }), "仅 goal");
  assert.equal(taskIntentSavedMessage(false), TASK_INTENT_SAVED_IDLE);
  assert.equal(taskIntentSavedMessage(true), TASK_INTENT_SAVED_RUNNING);
});

test("workbench wires PATCH save and keeps archived/viewer read-only", () => {
  const page = readFileSync(new URL("./pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(client, /updateTask:/);
  assert.match(client, /"PATCH", `\/tasks\/\$\{canvasId\}`/);
  assert.match(page, /canEditTaskIntent\(me, taskArchived\)/);
  assert.match(page, /api\.updateTask\(canvasId/);
  assert.match(page, /必要背景、边界与完成标准/);
  assert.match(page, /不会改写已在跑或已结束 Job 的冻结快照/);
  assert.match(page, /\{canEditIntent \? \(/);
});

test("api.updateTask posts title and content to the task canvas", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({
      id: "canvas",
      title: "新标题",
      target_json: { title: "新标题", content: "新内容", goal: "新内容" },
      has_active_jobs: true,
      snapshot_rewritten: false,
      message: TASK_INTENT_SAVED_RUNNING,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await api.updateTask("11111111-1111-4111-8111-111111111111", {
      title: "新标题",
      content: "新内容",
    });
    assert.equal(result.snapshot_rewritten, false);
    assert.deepEqual(calls, [{
      url: "/api/tasks/11111111-1111-4111-8111-111111111111",
      method: "PATCH",
      body: { title: "新标题", content: "新内容" },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
