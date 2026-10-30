import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { api, type FindingLexicalSearchResult } from "./api";
import { FindingLexicalSearch } from "./FindingLexicalSearch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function result(subject: string, title: string | null, cursor: string | null = null): FindingLexicalSearchResult {
  return {
    subject_id: subject, project_id: "project-a", subject_digest: `input-${subject}`, subject_text_truncated: false,
    rule_version: "lexical-rule/v1", normalization_version: "normalization/v1", computed_at: "2026-10-30T00:00:00.000Z",
    examined: 128, scan_limit: 128, limit: 25, next_cursor: cursor, window_limited: true, rank_truncated: false,
    identity_status: "insufficient_information", query_plane: "current",
    items: title ? [{ finding_id: `finding-${title}`, job_id: "source-job", canvas_id: "source-task", title,
      lexical_digest: "candidate-digest", text_truncated: false, kind: "similar", matched_fields: ["declared.category", "lexical.location", "lexical.tokens"], score: 0.5555555 }] : [],
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
  const original = api.findingLexicalSearch;
  const requests: Array<{ id: string; cursor?: string | null; signal?: AbortSignal; pending: ReturnType<typeof deferred<FindingLexicalSearchResult>> }> = [];
  api.findingLexicalSearch = (id, cursor, signal) => {
    const pending = deferred<FindingLexicalSearchResult>();
    requests.push({ id, cursor, signal, pending });
    return pending.promise;
  };
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  return {
    container, requests,
    render: async (id: string) => act(async () => root.render(<MemoryRouter><FindingLexicalSearch findingId={id} /></MemoryRouter>)),
    click: async (text: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === text);
      assert.ok(button, `button ${text} exists`);
      await act(async () => button.click());
    },
    async cleanup() {
      await act(async () => root.unmount());
      api.findingLexicalSearch = original;
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("lexical search is opt-in, paginates bounded windows and refreshes the first window", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    assert.equal(env.requests.length, 0);
    await env.click("查看相似文本");
    assert.equal(env.requests[0].id, "subject-a");
    assert.equal(env.requests[0].cursor, null);
    assert.match(env.container.textContent!, /正在读取/);
    await act(async () => env.requests[0].pending.resolve(result("subject-a", "candidate-one", "opaque-next")));
    assert.match(env.container.textContent!, /仅词法相似，身份待核验/);
    assert.match(env.container.textContent!, /128.*25/);
    assert.match(env.container.textContent!, /不是全项目排名/);
    assert.match(env.container.textContent!, /input-subject-a/);
    assert.match(env.container.textContent!, /声明文本输入摘要（非证据摘要）/);
    assert.match(env.container.textContent!, /声明类别、位置文本、文本词元/);
    assert.match(env.container.textContent!, /词法分值 0.556（非概率）/);
    assert.match(env.container.textContent!, /lexical-rule\/v1/);
    assert.equal(env.container.querySelector('a')?.getAttribute("href"), "/projects/project-a/findings?finding=finding-candidate-one");
    assert.ok(env.container.querySelector('a[href="/projects/project-a/tasks/source-task?finding=finding-candidate-one"]'));
    await env.click("继续扫描");
    assert.equal(env.requests[1].cursor, "opaque-next");
    assert.ok(!env.container.textContent!.includes("candidate-one"));
    const truncated = result("subject-a", "candidate-two");
    truncated.items[0].text_truncated = true;
    await act(async () => env.requests[1].pending.resolve({ ...truncated, subject_text_truncated: true, rank_truncated: true }));
    assert.match(env.container.textContent!, /当前 Finding 文本线索已截断/);
    assert.match(env.container.textContent!, /候选文本线索已截断/);
    assert.match(env.container.textContent!, /不会补回本窗口被截断/);
    await env.click("刷新首窗口");
    assert.equal(env.requests[2].cursor, null);
    assert.ok(!env.container.textContent!.includes("candidate-two"));
    await act(async () => env.requests[2].pending.resolve(result("subject-a", null)));
    assert.match(env.container.textContent!, /本窗口无匹配候选；未召回不等于明确不同/);
    assert.ok(!Array.from(env.container.querySelectorAll("button")).some(button => button.textContent === "继续扫描"));
  } finally { await env.cleanup(); }
});

test("subject changes, refresh and collapse cancel requests and ignore late responses", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    await env.click("查看相似文本");
    await env.render("subject-b");
    assert.equal(env.requests[0].signal?.aborted, true);
    await env.click("查看相似文本");
    await act(async () => env.requests[1].pending.resolve(result("subject-b", "new-subject")));
    await act(async () => env.requests[0].pending.resolve(result("subject-a", "stale-subject")));
    assert.match(env.container.textContent!, /new-subject/);
    assert.ok(!env.container.textContent!.includes("stale-subject"));
    await env.click("刷新首窗口");
    await env.click("刷新首窗口");
    assert.equal(env.requests[2].signal?.aborted, true);
    await act(async () => env.requests[3].pending.resolve(result("subject-b", "new-refresh")));
    await act(async () => env.requests[2].pending.reject(new Error("late failure")));
    assert.match(env.container.textContent!, /new-refresh/);
    assert.equal(env.container.querySelector('[role="alert"]'), null);
    await env.click("刷新首窗口");
    await env.click("收起相似文本");
    assert.equal(env.requests[4].signal?.aborted, true);
    await act(async () => env.requests[4].pending.resolve(result("subject-b", "collapsed-secret")));
    assert.ok(!env.container.textContent!.includes("collapsed-secret"));
    await env.click("查看相似文本");
    assert.equal(env.requests[5].cursor, null);
  } finally { await env.cleanup(); }
});

test("revocation and failures clear sensitive results; 409 requires restarting from the first window", async () => {
  const env = setup();
  try {
    await env.render("subject-a");
    await env.click("查看相似文本");
    await act(async () => env.requests[0].pending.resolve(result("subject-a", "sensitive-title", "old-cursor")));
    await env.click("继续扫描");
    await act(async () => env.requests[1].pending.reject(Object.assign(new Error("403 sensitive backend detail"), { status: 403 })));
    assert.ok(!env.container.textContent!.includes("sensitive"));
    assert.match(env.container.querySelector('[role="alert"]')!.textContent!, /权限可能已变化/);
    assert.equal(env.container.querySelectorAll("a").length, 0);
    await env.click("刷新首窗口");
    await act(async () => env.requests[2].pending.reject(Object.assign(new Error("source changed"), { status: 409 })));
    assert.match(env.container.textContent!, /来源或扫描游标已变化/);
    await env.click("重新开始扫描");
    assert.equal(env.requests[3].cursor, null);
    await act(async () => env.requests[3].pending.resolve(result("subject-a", "restored")));
    await env.click("刷新首窗口");
    await act(async () => env.requests[4].pending.reject(new Error("500 raw detail")));
    assert.ok(!env.container.textContent!.includes("restored"));
    assert.ok(!env.container.textContent!.includes("raw detail"));
    assert.equal(env.container.querySelectorAll("a").length, 0);
    await env.click("刷新首窗口");
    await act(async () => env.requests[5].pending.resolve(result("wrong-subject", "wrong-private-title")));
    assert.ok(!env.container.textContent!.includes("wrong-private-title"));
    assert.ok(env.container.querySelector('[role="alert"]'));
  } finally { await env.cleanup(); }
});
