import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { api, type FindingCandidatePage } from "./api";
import { FindingCandidates } from "./FindingCandidates";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function result(subject: string, title: string | null, cursor: string | null = null): FindingCandidatePage {
  return {
    subject_id: subject, project_id: "project-a", subject_digest: `input-${subject}`,
    status: "succeeded", rebuilding: false, active_generation: "generation-a", rule_version: "candidates/v1",
    processed_at: "2026-10-30T00:00:00.000Z", error_code: null, attempts: 0,
    examined: 25, scan_limit: 25, limit: 25, next_cursor: cursor, window_limited: true,
    stale_results_omitted: false, source_window: { examined: 128, scan_limit: 128, limit: 25, rank_truncated: false },
    identity_status: "insufficient_information", query_plane: "durable_candidates",
    items: title ? [{ finding_id: `finding-${title}`, job_id: "source-job", canvas_id: "source-task", title,
      lexical_digest: "candidate-digest", text_truncated: false, kind: "similar", matched_fields: ["lexical.tokens"],
      score: 0.5555555, processed_at: "2026-10-30T00:00:00.000Z" }] : [],
  };
}
function setup() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const original = api.findingCandidates;
  const requests: Array<{ id: string; cursor?: string | null; signal?: AbortSignal; pending: ReturnType<typeof deferred<FindingCandidatePage>> }> = [];
  api.findingCandidates = (id, cursor, signal) => {
    const pending = deferred<FindingCandidatePage>();
    requests.push({ id, cursor, signal, pending });
    return pending.promise;
  };
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  return {
    container, requests,
    render: async (id: string) => act(async () => root.render(<MemoryRouter><FindingCandidates findingId={id} /></MemoryRouter>)),
    click: async (text: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === text);
      assert.ok(button, `button ${text} exists`);
      await act(async () => button.click());
    },
    async cleanup() {
      await act(async () => root.unmount());
      api.findingCandidates = original;
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("subject changes, refresh and collapse cancel requests and ignore late responses", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    await env.click("查看已计算候选");
    await env.render("subject-b");
    assert.equal(env.requests[0].signal?.aborted, true);
    await env.click("查看已计算候选");
    await act(async () => env.requests[1].pending.resolve(result("subject-b", "new-subject")));
    await act(async () => env.requests[0].pending.resolve(result("subject-a", "stale-subject")));
    assert.match(env.container.textContent!, /new-subject/);
    assert.ok(!env.container.textContent!.includes("stale-subject"));
    await env.click("刷新候选");
    await env.click("刷新候选");
    assert.equal(env.requests[2].signal?.aborted, true);
    await act(async () => env.requests[3].pending.resolve(result("subject-b", "new-refresh")));
    await act(async () => env.requests[2].pending.reject(new Error("late failure")));
    assert.match(env.container.textContent!, /new-refresh/);
    assert.equal(env.container.querySelector('[role="alert"]'), null);
    await env.click("刷新候选");
    await env.click("收起已计算候选");
    assert.equal(env.requests[4].signal?.aborted, true);
    await act(async () => env.requests[4].pending.resolve(result("subject-b", "collapsed-secret")));
    assert.ok(!env.container.textContent!.includes("collapsed-secret"));
    await env.click("查看已计算候选");
    assert.equal(env.requests[5].cursor, null);
  } finally { await env.cleanup(); }
});

test("opt-in distinguishes persisted states from successful empty", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    assert.equal(env.requests.length, 0);
    await env.click("查看已计算候选");
    assert.match(env.container.textContent!, /正在读取候选/);
    const states = { pending: "等待后台计算", running: "后台计算中", failed: "计算失败", stale: "来源已变化", succeeded: "计算已完成" } as const;
    for (const [status, label] of Object.entries(states)) {
      if (status !== "pending") await env.click("刷新候选");
      const page = { ...result("subject-a", null), status: status as FindingCandidatePage["status"], attempts: 3, error_code: "PRIVATE_ERROR_NEVER_RENDER" };
      if (status === "pending" || status === "running") {
        page.active_generation = null; page.processed_at = null; page.source_window.examined = null;
      }
      await act(async () => env.requests.at(-1)!.pending.resolve(page));
      assert.match(env.container.textContent!, new RegExp(label));
      assert.ok(!env.container.textContent!.includes("PRIVATE_ERROR_NEVER_RENDER"));
      assert.equal(env.container.textContent!.includes("当前没有可见候选"), status === "succeeded");
      if (status === "failed") assert.match(env.container.textContent!, /尝试 3 次/);
      if (status === "pending") assert.match(env.container.textContent!, /尚未完成首轮计算/);
    }
  } finally { await env.cleanup(); }
});

test("pages explain stale omission, rebuild, provenance and terminal empty windows", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    await env.click("查看已计算候选");
    const page = result("subject-a", "candidate-one", "opaque-next");
    page.status = "stale"; page.rebuilding = true; page.stale_results_omitted = true;
    page.source_window.rank_truncated = true; page.items[0].text_truncated = true;
    await act(async () => env.requests[0].pending.resolve(page));
    for (const phrase of ["后台正在重建", "已隐藏来源失效", "128", "25", "另一端的窗口", "不是全项目排名或关系总量", "窗口内候选已截断", "声明文本线索已截断", "词法分值 0.556（非概率）", "generation-a", "candidates/v1", "非证据摘要", "input-subject-a", "candidate-digest"]) {
      assert.ok(env.container.textContent!.includes(phrase), phrase);
    }
    assert.equal(env.container.querySelector("a")?.getAttribute("href"), "/projects/project-a/findings?finding=finding-candidate-one");
    assert.ok(env.container.querySelector('a[href="/projects/project-a/tasks/source-task?finding=finding-candidate-one"]'));
    await env.click("继续读取候选");
    assert.equal(env.requests[1].cursor, "opaque-next");
    assert.ok(!env.container.textContent!.includes("candidate-one"));
    await act(async () => env.requests[1].pending.resolve(result("subject-a", null)));
    assert.match(env.container.textContent!, /本页没有当前有效候选/);
    assert.ok(!env.container.textContent!.includes("当前没有可见候选"));
    assert.ok(!Array.from(env.container.querySelectorAll("button")).some(button => button.textContent === "继续读取候选"));
    await env.click("刷新候选");
    assert.equal(env.requests[2].cursor, null);
    await act(async () => env.requests[2].pending.resolve(result("subject-a", null, "further")));
    assert.match(env.container.textContent!, /仍可继续后续窗口/);
  } finally { await env.cleanup(); }
});

test("UUID case, revoked permissions and stale cursors never retain private results", async () => {
  const env = setup();
  const canonical = "abcdef01-2345-4678-9abc-def012345678";
  try {
    await env.render(canonical.toUpperCase());
    await env.click("查看已计算候选");
    assert.equal(env.requests[0].id, canonical.toUpperCase());
    await act(async () => env.requests[0].pending.resolve(result(canonical, "canonical-result")));
    assert.match(env.container.textContent!, /canonical-result/);
    assert.equal(env.container.querySelector('[role="alert"]'), null);
    let restart = false;
    for (const status of [401, 403, 400, 409, 500]) {
      await env.click(restart ? "重新读取首窗口" : "刷新候选");
      assert.equal(env.requests.at(-1)!.cursor, null);
      await act(async () => env.requests.at(-1)!.pending.resolve(result(canonical, "private-title", "old-cursor")));
      await env.click("继续读取候选");
      await act(async () => env.requests.at(-1)!.pending.reject(Object.assign(new Error("PRIVATE_RAW_ERROR"), { status })));
      assert.ok(!env.container.textContent!.includes("private-title"));
      assert.ok(!env.container.textContent!.includes("PRIVATE_RAW_ERROR"));
      assert.equal(env.container.querySelectorAll("a").length, 0);
      restart = status === 400 || status === 409;
      assert.match(env.container.querySelector('[role="alert"]')!.textContent!, restart ? /重新读取首窗口/ : /权限可能已变化/);
    }
    await env.click("刷新候选");
    await act(async () => env.requests.at(-1)!.pending.resolve(result("wrong-subject", "wrong-private-title")));
    assert.ok(!env.container.textContent!.includes("wrong-private-title"));
    assert.ok(env.container.querySelector('[role="alert"]'));
  } finally { await env.cleanup(); }
});
