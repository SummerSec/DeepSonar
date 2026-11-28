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
    const page: KnowledgeActivity = {
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 },
      skipped_sources: [], items: [], next_offset: null,
    };
    return new Response(JSON.stringify(page));
  }) as typeof fetch;
  try {
    const activity = await projectKnowledgeApi.activity("project/a");
    assert.deepEqual(activity.collection, { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null });
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
    collection: { state: "halted", pending_sources: 12, consecutive_failures: 2, next_collection_at: null },
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
    const feedback = () => container.querySelector('[aria-label="知识反馈统计"]')!;
    assert.match(feedback().textContent!, /本项目拉取 5/);
    assert.match(feedback().textContent!, /反馈覆盖率 40%/);
    assert.match(feedback().textContent!, /已记录的显式反馈 2/);
    assert.match(feedback().textContent!, /尚无反馈（效果未知） 3/);
    const collection = () => container.querySelector('[aria-label="自动整理状态"]')!;
    assert.match(collection().textContent!, /自动整理已下线/);
    assert.equal(collection().querySelector("time"), null);
    assert.equal(collection().querySelectorAll("button").length, 0);
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
    assert.doesNotMatch(container.textContent!, /work-a|已登记来源 24|自动整理已停发|来源已保留/);
    await act(async () => requests[1].resolve(page("late-a")));
    assert.doesNotMatch(container.textContent!, /late-a|已登记来源 24|自动整理已停发|来源已保留/);
    assert.equal(feedback(), null, "feedback counts from a previous project are hidden during loading");
    assert.equal(requests[2].project, "b");
    assert.equal(requests[2].offset, 0);
    const nextCollection = "2026-11-17T02:00:00.000Z";
    const accumulating: KnowledgeActivity["collection"] = { state: "accumulating", pending_sources: 3,
      consecutive_failures: 0, next_collection_at: nextCollection };
    const emptyPage = page("work-b");
    await act(async () => requests[2].resolve({ ...emptyPage, collection: accumulating, items: [],
      summary: { ...emptyPage.summary, usage_count: 0, feedback_count: 0, successful_feedback: 0 } }));
    assert.match(container.textContent!, /暂无知识工作/);
    assert.match(feedback().textContent!, /反馈覆盖率 无样本/);
    assert.doesNotMatch(feedback().textContent!, /%/);
    await render("b", 1);
    assert.equal(requests.length, 4, "existing refresh trigger fetches activity once");
    await act(async () => requests[3].reject(new Error("server failure")));
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /加载积累与复用进展失败/);
    await click("重试");
    assert.equal(refreshRequests, 1, "retry uses the page refresh trigger");
    await render("b", 2);
    await render("b", 3);
    const noFeedbackPage = page("current-b");
    await act(async () => requests[5].resolve({ ...noFeedbackPage,
      summary: { ...noFeedbackPage.summary, usage_count: 503, feedback_count: 0, successful_feedback: 0 } }));
    await act(async () => requests[4].reject(new Error("late refresh failure")));
    assert.match(container.textContent!, /current-b/);
    assert.match(feedback().textContent!, /反馈覆盖率 0%/);
    assert.match(feedback().textContent!, /已记录的显式反馈 0/);
    assert.match(feedback().textContent!, /尚无反馈（效果未知） 503/);
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


test("#1256 卡片评价行按契约语义显示：不适用、未评价与有评价三态", async () => {
  const { feedbackLine } = await import("./project-knowledge-card.js");
  // 无记录：明确零样本，不写 0 次使用。
  assert.equal(feedbackLine(undefined), "当前版本暂无评价");
  assert.equal(feedbackLine({ total: 0, success: 0, failure: 0, inapplicable: 0, unrated: 0 }), "当前版本暂无评价");
  // 读过但都没评价：说清是「均未评价」，不是「无用」。
  assert.equal(feedbackLine({ total: 3, success: 0, failure: 0, inapplicable: 0, unrated: 3 }), "3 条阅读记录，均未评价");
  // 有评价：inapplicable 显示「不适用」，total 叫「阅读记录」而不是「使用次数」。
  const line = feedbackLine({ total: 8, success: 5, failure: 1, inapplicable: 2, unrated: 0 });
  assert.equal(line, "8 条阅读记录：有用 5 · 不适用 2 · 无用 1");
  assert.doesNotMatch(line, /部分有用/u);
  assert.doesNotMatch(line, /使用次数/u);
  // 有评价也有未评价时把未评价单列。
  assert.equal(feedbackLine({ total: 10, success: 5, failure: 1, inapplicable: 2, unrated: 2 }),
    "10 条阅读记录：有用 5 · 不适用 2 · 无用 1 · 未评价 2");
});

test("#1256 人类维护请求打到项目知识入口，编辑带 expected_version", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null,
  } });
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    return new Response(JSON.stringify({ item_ref: "item", version_ref: "version", version: 2, status: "active" }), { status: 201 });
  }) as typeof fetch;
  try {
    await projectKnowledgeApi.create("owner", { kind: "memory", logical_key: "human-key", title: "人工知识", content: "正文" });
    await projectKnowledgeApi.revise("owner", "item", { expected_version: 1, title: "人工知识（改）", content: "新正文", reason: "修正错别字" });
    await projectKnowledgeApi.archive("owner", "item");
    await projectKnowledgeApi.restore("owner", "item");
    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ["POST", "/api/projects/owner/knowledge"],
      ["POST", "/api/projects/owner/knowledge/item/versions"],
      ["POST", "/api/projects/owner/knowledge/item/archive"],
      ["POST", "/api/projects/owner/knowledge/item/restore"],
    ]);
    assert.equal(calls[0]?.body, '{"kind":"memory","logical_key":"human-key","title":"人工知识","content":"正文"}');
    assert.equal(calls[1]?.body, '{"expected_version":1,"title":"人工知识（改）","content":"新正文","reason":"修正错别字"}');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  }
});

test("history preview reads on demand, drops closed responses, and renders suggestions as plain text", async () => {
  const { JSDOM } = await import("jsdom");
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router-dom");
  const { ProjectKnowledgeBackfill } = await import("./pages/ProjectKnowledgeBackfill");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: { getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null } };
  const oldGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; init?: RequestInit; respond: (data: unknown) => void }> = [];
  globalThis.fetch = (input, init) => new Promise(resolve => {
    calls.push({ path: String(input), init, respond: data => resolve(new Response(JSON.stringify(data))) });
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const render = (projectId: string) => act(async () => root.render(h(MemoryRouter, null,
    h(ProjectKnowledgeBackfill, { key: projectId, projectId }))));
  const click = async (label: string) => {
    const control = [...container.querySelectorAll("button")].find(button => button.textContent === label);
    assert.ok(control, label);
    await act(async () => control.click());
  };
  const candidate = { kind: "skill", title: "示例建议", scope: "同项目", content: '<img src="/external" />',
    evidence_refs: [{ kind: "fact", ref: "fact-1" }] };
  try {
    await render("project/a");
    assert.equal(calls.length, 0);
    await click("查看历史任务沉淀");
    assert.equal(calls[0].path, "/api/projects/project%2Fa/knowledge/backfill?limit=10&offset=0");
    await act(async () => calls[0].respond({ next_offset: 10, items: [
      { job_id: "legacy", closeout_status: "legacy_preview", closeout_root_ref: null, status: "eligible" },
      { job_id: "job", closeout_status: "suggestions_available", closeout_root_ref: "root/a", status: "eligible" },
    ] }));
    assert.match(container.textContent!, /只有历史来源预览.*有可供整理的来源/);
    assert.equal(calls.length, 1);
    await click("查看建议");
    assert.equal(calls[1].path, "/api/projects/project%2Fa/knowledge/closeout/root%2Fa?limit=10&offset=0");
    await click("收起建议");
    assert.equal(calls[1].init?.signal?.aborted, true);
    await act(async () => calls[1].respond({ status: "suggestions_available", next_offset: null, items: [candidate] }));
    assert.doesNotMatch(container.textContent!, /示例建议/);
    await click("查看建议");
    await act(async () => calls[2].respond({ status: "restricted", next_offset: null, items: [candidate],
      evaluation_source_unavailable: true }));
    assert.match(container.textContent!, /当前无法查看建议内容/);
    assert.match(container.textContent!, /已有建议送评，原证据或修订版本已不可用/);
    assert.doesNotMatch(container.textContent!, /示例建议|fact-1/);
    await click("收起建议");
    await click("查看建议");
    await act(async () => calls[3].respond({ status: "suggestions_available", next_offset: null, items: [candidate] }));
    assert.match(container.textContent!, /示例建议/);
    assert.doesNotMatch(container.textContent!, /已有建议送评，原证据或修订版本已不可用/);
    assert.ok(container.textContent!.includes(candidate.content));
    assert.equal(container.querySelector("img"), null);
    await click("下一页历史");
    assert.equal(calls[4].path, "/api/projects/project%2Fa/knowledge/backfill?limit=10&offset=10");
    await render("project-b");
    assert.equal(calls[4].init?.signal?.aborted, true);
    assert.doesNotMatch(container.textContent!, /示例建议|只有历史来源预览/);
    for (const { init } of calls) {
      assert.equal(init?.method, "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.body, undefined);
      assert.deepEqual(init?.headers, { Authorization: "Bearer fixture-token" });
    }
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of oldGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
