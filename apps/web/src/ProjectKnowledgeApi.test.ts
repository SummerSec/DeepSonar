import assert from "node:assert/strict";
import test from "node:test";
import { projectKnowledgeApi, type KnowledgeActivity } from "./ProjectKnowledgeApi";

test("knowledge management requests keep exact project/version scope and surface server error codes", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const calls: Array<{ path: string; method: string; body?: string; authorization?: string }> = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null,
  } });
  globalThis.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined,
      authorization: headers.Authorization });
    if (calls.length === 2) return new Response(JSON.stringify({ error_code: "KNOWLEDGE_GRANT_DENIED" }), { status: 409 });
    return new Response(JSON.stringify({ id: "grant" }), { status: 201 });
  }) as typeof fetch;
  try {
    await projectKnowledgeApi.grant("owner", "item", "version", "grantee");
    assert.deepEqual(calls[0], {
      path: "/api/projects/owner/knowledge/item/versions/version/grants",
      method: "POST", body: '{"grantee_project_id":"grantee"}', authorization: "Bearer fixture-token",
    });
    await assert.rejects(projectKnowledgeApi.revokeVersion("owner", "item", "version", "reason"),
      /KNOWLEDGE_GRANT_DENIED/);
    assert.equal(calls[1]?.path, "/api/projects/owner/knowledge/item/versions/version/revoke");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("activity requests encode project and use bounded explicit pagination", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async input => {
    paths.push(String(input));
    return new Response(JSON.stringify({ summary: {}, items: [], next_offset: null }));
  }) as typeof fetch;
  try {
    await projectKnowledgeApi.activity("project/a");
    await projectKnowledgeApi.activity("project-b", { limit: 5, offset: 10 });
    assert.deepEqual(paths, ["/api/projects/project%2Fa/knowledge/activity?limit=10&offset=0",
      "/api/projects/project-b/knowledge/activity?limit=5&offset=10"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("activity keeps evidence boundaries, Chinese blockers, working links and project-isolated refresh/pagination", async () => {
  const { JSDOM } = await import("jsdom");
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router-dom");
  const { ProjectKnowledgeActivity } = await import("./pages/ProjectKnowledgeActivity");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalActivity = projectKnowledgeApi.activity;
  const requests: Array<{ project: string; offset: number; resolve: (page: KnowledgeActivity) => void; reject: (error: Error) => void }> = [];
  projectKnowledgeApi.activity = (project, input = {}) => new Promise((resolve, reject) => {
    requests.push({ project, offset: input.offset ?? 0, resolve, reject });
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const container = dom.window.document.getElementById("root")!;
  let refreshRequests = 0;
  const page = (id: string, next: number | null = null): KnowledgeActivity => ({
    summary: { registered_sources: 24, collected_sources: 10, skipped_sources: 2, pending_sources: 12, active_memory: 1, active_skills: 2,
      draft_items: 3, completed_work: 4, blocked_work: 1, usage_count: 5, feedback_count: 2, successful_feedback: 1 },
    skipped_sources: [{ job_id: "skipped-a", reason: "source_input_limit", at: "2026-01-01" }],
    items: [{ id, state: "blocked", stage: "maker", reason: "job_budget_exhausted", job_count: 2, run_seconds: 30,
      active_job_id: "job-a", canvas_id: "canvas-a", source_count: 10, created_at: "2026-01-01", updated_at: "2026-01-01" }], next_offset: next,
  });
  const render = (projectId: string, refresh = 0) => act(async () => root.render(h(MemoryRouter, null,
    h(ProjectKnowledgeActivity, { projectId, refresh, onRefresh: () => { refreshRequests++; } }))));
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(value => value.textContent === label);
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    await render("a");
    await act(async () => requests[0].resolve(page("work-a", 10)));
    assert.match(container.textContent!, /已登记来源 24/);
    assert.match(container.textContent!, /已纳入整理 10/);
    assert.match(container.textContent!, /已跳过来源 2/);
    assert.match(container.textContent!, /来源输入超过单次采集上限/);
    assert.match(container.textContent!, /Job 数量预算已耗尽/);
    assert.match(container.textContent!, /模型报告/);
    assert.match(container.textContent!, /不代表效果已证明/);
    assert.doesNotMatch(container.textContent!, /产物 24|成功率/);
    assert.ok(container.querySelector('a[href="/jobs?project=a&job=job-a"]'));
    assert.ok(container.querySelector('a[href="/projects/a/tasks/canvas-a"]'));
    assert.equal(container.querySelectorAll("select").length, 0);
    assert.ok(container.querySelector("details"), "execution details are disclosed on demand");
    const evidenceDetails = container.querySelector("details")!;
    assert.equal(evidenceDetails.open, false);
    await act(async () => evidenceDetails.querySelector("summary")!.click());
    assert.equal(evidenceDetails.open, true);
    await click("下一页工作");
    assert.equal(requests[1].offset, 10);
    await render("b");
    assert.doesNotMatch(container.textContent!, /work-a|已登记来源 24/);
    await act(async () => requests[1].resolve(page("late-a")));
    assert.doesNotMatch(container.textContent!, /late-a|已登记来源 24/);
    assert.equal(requests[2].project, "b");
    assert.equal(requests[2].offset, 0);
    await act(async () => requests[2].resolve({ ...page("work-b"), items: [] }));
    assert.match(container.textContent!, /暂无知识工作/);
    await render("b", 1);
    assert.equal(requests.length, 4, "existing refresh trigger fetches activity once");
    await act(async () => requests[3].reject(new Error("server failure")));
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /加载积累与复用进展失败/);
    await click("重试");
    assert.equal(refreshRequests, 1, "retry uses the page refresh trigger");
    await render("b", 2);
    await render("b", 3);
    await act(async () => requests[5].resolve(page("current-b")));
    await act(async () => requests[4].reject(new Error("late refresh failure")));
    assert.match(container.textContent!, /current-b/);
    assert.equal(container.querySelector('[role="alert"]'), null, "a late failure from an earlier refresh cannot replace current data");
  } finally {
    await act(async () => root.unmount());
    projectKnowledgeApi.activity = originalActivity;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
