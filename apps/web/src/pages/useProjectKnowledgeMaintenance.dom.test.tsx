import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { api } from "../api";
import { projectKnowledgeApi, type KnowledgeDetail, type KnowledgeItem, type KnowledgeVersion, type KnowledgeVersionDetail } from "../ProjectKnowledgeApi";

const submitKeys: string[] = [];

// 真正挂载页面：评审点名要求页面级证据（不是返回 null 的 Harness）。
test("knowledge maintenance keeps feedback visible, unique keys per draft and repeatable archive/undo", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  const created: Array<{ logical_key: string; title: string }> = [];
  const mutating: string[] = [];
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-abc123",
    title: "中文知识条目", keywords_json: [], status: "active", active_version_id: "version-a2", version: 2,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const authorId = "3f1d2c4b-5a69-4e78-9b01-2c3d4e5f6a7b";
  const version: KnowledgeVersion = { id: "version-a2", version: 2, content_sha256: "d".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: authorId, revision_reason: "修正了一处错别字",
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T01:00:00.000Z" };
  const older: KnowledgeVersion = { ...version, id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    revision_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  const detail: KnowledgeDetail = { ...item, versions: [version, older], versions_next_offset: null, proposals: [], evaluations: [], usages: [] };
  const versionDetails: Record<string, KnowledgeVersionDetail> = {
    [version.id]: { ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "第二版正文" } } as never,
    [older.id]: { ...older, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "第一版正文" } } as never,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null,
    setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => detail, version: async (_projectId: string, _itemId: string, versionId: string) => versionDetails[versionId] ?? versionDetails[version.id]!, grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 },
      skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }), receipts: async () => ({ items: [], next_offset: null }),
    create: async (_projectId: string, body: { logical_key: string; title: string }) => {
      created.push({ logical_key: body.logical_key, title: body.title }); mutating.push("create");
      return { item_ref: `item-${created.length}`, version_ref: `v-${created.length}`, version: 1 };
    },
    revise: async () => { mutating.push("revise"); return { item_ref: item.id, version_ref: "v2", version: 2 }; },
    archive: async () => { mutating.push("archive"); return { item_ref: item.id, status: "retired" }; },
    restore: async () => { mutating.push("restore"); return { item_ref: item.id, status: "active" }; },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    // 连续两条中文标题必须各自拿到独立标识
    for (const title of ["中文知识一", "中文知识二"]) {
      await click(byText("新建知识"));
      const input = dom.window.document.querySelector("input[aria-label='知识标题']") as HTMLInputElement;
      assert.ok(input, "新建表单要有标题输入");
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, title);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await click(byText("提交新建"));
    }
    assert.equal(created.length, 2, "两次新建都要发出请求");
    assert.notEqual(created[0]?.logical_key, created[1]?.logical_key, "两条中文标题不能撞同一个逻辑键");
    assert.ok(created.every((entry) => /^human-[\p{L}\p{N}._/-]*$/u.test(entry.logical_key) || /^human-note-[a-z0-9]+$/u.test(entry.logical_key)));
    // 人工维护的版本按真实返回形状展示：UUID 身份只显示「人工维护」，并原位显示作者与修订原因
    assert.ok(byText(/^v2 · 人工维护$/u), "人工版本必须显示作者来源，且不把 UUID 身份当名字");
    assert.ok(byText(/作者：人工维护/u), "版本详情要显示作者");
    assert.ok(byText(/修订原因：修正了一处错别字/u), "版本详情要显示可选修订原因");
    // 切到旧版：不能显示新版的原因
    await click(byText(/^v1 · 人工维护$/u));
    assert.ok(!byText(/修订原因：修正了一处错别字/u), "旧版本不能显示新版本的修订原因");
    // 新建成功的提示在表单关闭后仍然可见
    assert.ok(byText(/新建知识成功/u), "新建成功提示必须对用户可见");
    // 下架 → 撤销 → 再次下架 → 再次撤销
    for (const round of [1, 2]) {
      await click(byText("下架知识"));
      assert.equal(mutating.filter((value) => value === "archive").length, round, `第 ${round} 次下架应发出请求`);
      await click(byText("撤销下架"));
      assert.equal(mutating.filter((value) => value === "restore").length, round, `第 ${round} 次撤销应发出请求`);
      assert.ok(byText("下架知识"), `撤销后第 ${round} 轮仍可再次下架`);
    }
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("create draft stays with its project and a late response does not disturb the other project", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes, useNavigate } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  const createdProjects: string[] = [];
  submitKeys.length = 0;
  let release: ((value: { item_ref: string; version_ref: string; version: number }) => void) | null = null;
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-x1",
    title: "项目 A 的知识", keywords_json: [], status: "active", active_version_id: "version-a1", version: 1,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const version: KnowledgeVersion = { id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null,
    setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => ({ ...item, versions: [version], versions_next_offset: null, proposals: [], evaluations: [], usages: [] }),
    version: async () => ({ ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async (projectId: string) => {
      createdProjects.push(projectId);
      return new Promise((resolve) => { release = resolve; });
    },
    revise: async () => ({ item_ref: item.id, version_ref: "v2", version: 2 }),
    archive: async () => ({ item_ref: item.id, status: "retired" }),
    restore: async () => ({ item_ref: item.id, status: "active" }),
  });
  let navigate: ((to: string) => void) | null = null;
  function Bridge() { navigate = useNavigate(); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const titleInput = () => dom.window.document.querySelector("input[aria-label='知识标题']") as HTMLInputElement | null;
  // 用元素自身原型上的 setter 写入，避免跨 jsdom 实例的 instanceof 检查。
  const typeInto = (input: HTMLInputElement | null, value: string): void => {
    assert.ok(input, "新建表单要有标题输入");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Bridge),
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    // A 里写草稿但不提交
    await click(byText("新建知识"));
    await act(async () => {
      const input = titleInput()!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "项目 A 的草稿");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    // 切到 B：草稿与表单都不该带过去
    await act(async () => { navigate?.("/projects/project-b/knowledge"); });
    await flush();
    assert.ok(!titleInput(), "切到 B 后不应继续显示 A 的新建表单");
    await click(byText("新建知识"));
    assert.equal(titleInput()?.value, "", "B 的新建表单必须是空的");
    // 回到 A：草稿还在
    await act(async () => { navigate?.("/projects/project-a/knowledge"); });
    await flush();
    // A 的表单仍开着（草稿按项目保留），这里不再点按钮切换开合
    assert.equal(titleInput()?.value, "项目 A 的草稿", "回到 A 应能接着写未提交草稿");
    // A 的请求晚于切换返回：只清 A 的草稿，不改 B 的表单与选中项
    await click(byText("提交新建"));
    assert.deepEqual(createdProjects, ["project-a"]);
    await act(async () => { navigate?.("/projects/project-b/knowledge"); });
    await flush();
    // B 的表单仍开着（同样按项目保留草稿），直接写 B 自己的草稿
    await act(async () => { typeInto(titleInput(), "项目 B 正在写"); });
    // B 同时在编辑已有条目：A 的成功回执不得重置 B 的编辑草稿
    await act(async () => { navigate?.("/projects/project-b/knowledge?item=item-a"); });
    await flush();
    await click(byText(/编辑正文/u));
    const editBox = () => dom.window.document.querySelector("textarea[aria-label='编辑正文']") as HTMLTextAreaElement | null;
    assert.ok(editBox(), "B 的编辑草稿要打开");
    await act(async () => { release?.({ item_ref: "item-new-a", version_ref: "v-new-a", version: 1 }); });
    await flush();
    assert.equal(titleInput()?.value, "项目 B 正在写", "A 的迟到响应不得清掉 B 的草稿");
    assert.ok(editBox(), "A 的成功回执不得重置 B 正在进行的编辑草稿");
    assert.ok(!byText(/新建知识成功/u), "A 的成功提示不得显示在 B");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("a late create failure in one project neither shows an error nor blocks submitting in another", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes, useNavigate } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  let rejectCreate: ((error: Error) => void) | null = null;
  const createdProjects: string[] = [];
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-y1",
    title: "项目 A 的知识", keywords_json: [], status: "active", active_version_id: "version-a1", version: 1,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const version: KnowledgeVersion = { id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => ({ ...item, versions: [version], versions_next_offset: null, proposals: [], evaluations: [], usages: [] }),
    version: async () => ({ ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async (projectId: string) => {
      createdProjects.push(projectId);
      return new Promise((_resolve, reject) => { rejectCreate = reject; });
    },
    revise: async () => ({ item_ref: item.id, version_ref: "v2", version: 2 }),
    archive: async () => ({ item_ref: item.id, status: "retired" }),
    restore: async () => ({ item_ref: item.id, status: "active" }),
  });
  let navigate: ((to: string) => void) | null = null;
  function Bridge() { navigate = useNavigate(); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const titleInput = () => dom.window.document.querySelector("input[aria-label='知识标题']") as HTMLInputElement | null;
  const typeInto = (input: HTMLInputElement | null, value: string): void => {
    assert.ok(input, "新建表单要有标题输入");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null, createElement(Bridge),
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    await click(byText("新建知识"));
    await act(async () => { typeInto(titleInput(), "A 会失败的草稿"); });
    await click(byText("提交新建"));
    assert.deepEqual(createdProjects, ["project-a"]);
    // 切到 B 并开始提交
    await act(async () => { navigate?.("/projects/project-b/knowledge"); });
    await flush();
    await click(byText("新建知识"));
    await act(async () => { typeInto(titleInput(), "B 的草稿"); });
    // A 还没有响应时，B 的提交按钮就必须可用（不被别的项目的进行中状态挡住）
    const submitWhilePending = byText("提交新建") as HTMLButtonElement | undefined;
    assert.ok(submitWhilePending, "B 仍应有提交按钮");
    assert.equal(submitWhilePending!.disabled, false, "A 未返回不应阻塞 B 的提交");
    // A 迟到失败：不得在 B 显示错误，B 的按钮仍可用
    await act(async () => { rejectCreate?.(new Error("A 的提交失败")); });
    await flush();
    assert.ok(!byText(/A 的提交失败/u), "A 的失败不得显示在 B");
    const submitAfterFailure = byText("提交新建") as HTMLButtonElement | undefined;
    assert.ok(submitAfterFailure, "B 仍应有提交按钮");
    assert.equal(submitAfterFailure!.disabled, false, "A 的失败不应阻塞 B 的提交");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("a delayed create success keeps text typed after submitting and does not switch the user away", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  let release: ((value: { item_ref: string; version_ref: string; version: number }) => void) | null = null;
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-z1",
    title: "已有知识", keywords_json: [], status: "active", active_version_id: "version-a1", version: 1,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const version: KnowledgeVersion = { id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => ({ ...item, versions: [version], versions_next_offset: null, proposals: [], evaluations: [], usages: [] }),
    version: async () => ({ ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async (_projectId: string, body: { logical_key: string }) => {
      submitKeys.push(body.logical_key);
      if (submitKeys.length === 1) return new Promise((resolve) => { release = resolve; });
      return { item_ref: `item-${submitKeys.length}`, version_ref: `v-${submitKeys.length}`, version: 1 };
    },
    revise: async () => ({ item_ref: item.id, version_ref: "v2", version: 2 }),
    archive: async () => ({ item_ref: item.id, status: "retired" }),
    restore: async () => ({ item_ref: item.id, status: "active" }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const field = (label: string) => dom.window.document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLTextAreaElement | null;
  const typeInto = (input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void => {
    assert.ok(input, "输入框必须存在");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    await click(byText("新建知识"));
    await act(async () => { typeInto(field("知识标题"), "标题 X"); typeInto(field("知识正文"), "提交时的正文"); });
    await click(byText("提交新建"));
    // 等待期间用户继续输入正文
    await act(async () => { typeInto(field("知识正文"), "等待期间又写的内容"); });
    await act(async () => { release?.({ item_ref: "item-new", version_ref: "v-new", version: 1 }); });
    await flush();
    assert.equal((field("知识正文") as HTMLTextAreaElement | null)?.value, "等待期间又写的内容", "迟到的成功不得清掉后来输入的内容");
    assert.ok(byText(/上一次提交已成功；当前草稿已保留/u), "应提示草稿已保留，可继续提交");
    // 保留下来的草稿必须能继续提交：第二次用的创建标识与第一次不同，且同样成功。
    await click(byText("提交新建"));
    assert.equal(submitKeys.length, 2, "第二次提交要真的发出请求");
    assert.notEqual(submitKeys[0], submitKeys[1], "保留草稿时要换新的创建标识，避免撞同一个逻辑键");
    assert.ok(byText(/新建知识成功，已打开该条目|上一次提交已成功/u), "第二次提交也要有成功反馈");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("a delayed edit save keeps later input and can be saved again as v3", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  let release: ((value: { item_ref: string; version_ref: string; version: number }) => void) | null = null;
  const reviseCalls: Array<{ expected_version: number; content: string }> = [];
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-edit",
    title: "已有知识", keywords_json: [], status: "active", active_version_id: "version-a1", version: 1,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const version: KnowledgeVersion = { id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  const versions: KnowledgeVersion[] = [version];
  let activeVersion = "version-a1";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => ({ ...item, active_version_id: activeVersion, version: versions.length,
      versions: [...versions], versions_next_offset: null, proposals: [], evaluations: [], usages: [] }),
    version: async () => ({ ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "v1 正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async () => ({ item_ref: item.id, version_ref: "v-created", version: 1 }),
    revise: async (_projectId: string, _itemId: string, body: { expected_version: number; content: string }) => {
      reviseCalls.push({ expected_version: body.expected_version, content: body.content });
      if (reviseCalls.length === 1) return new Promise((resolve) => { release = resolve; });
      return { item_ref: item.id, version_ref: "version-a3", version: 3 };
    },
    archive: async () => ({ item_ref: item.id, status: "retired" }),
    restore: async () => ({ item_ref: item.id, status: "active" }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const field = (label: string) => dom.window.document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLTextAreaElement | null;
  const typeInto = (input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void => {
    assert.ok(input, "输入框必须存在");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    await click([...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("已有知识")) as HTMLElement | undefined);
    await click(byText(/编辑正文（基于 v1）/u));
    await act(async () => { typeInto(field("编辑正文"), "v2 正文"); });
    await click(byText(/保存为新版本（v2）/u));
    // 保存期间继续输入
    await act(async () => { typeInto(field("编辑正文"), "基于 v2 的新输入"); });
    versions.unshift({ ...version, id: "version-a2", version: 2 });
    activeVersion = "version-a2";
    await act(async () => { release?.({ item_ref: item.id, version_ref: "version-a2", version: 2 }); });
    await flush();
    assert.equal((field("编辑正文") as HTMLTextAreaElement | null)?.value, "基于 v2 的新输入", "迟到的保存回执不得清掉等待期间的新输入");
    assert.ok(byText(/已生成 v2/u), "应提示已生成 v2");
    // 同一条草稿接着保存为 v3
    await click(byText(/保存为新版本（v3）/u));
    assert.equal(reviseCalls.length, 2, "第二次保存要真的发出请求");
    assert.equal(reviseCalls[1]!.expected_version, 2, "第二次保存应基于刚生成的 v2");
    assert.equal(reviseCalls[1]!.content, "基于 v2 的新输入", "第二次保存提交的是等待期间的新输入");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("editing sends one request per click, keeps the base version across a refresh, and never leaks a late error into another project", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  let rejectEdit: ((error: Error) => void) | null = null;
  const reviseCalls: Array<{ expected_version: number; content: string }> = [];
  const itemFor = (project: string): KnowledgeItem => ({ id: `item-${project}`, project_id: project, kind: "memory",
    logical_key: `human-${project}`, title: `${project} 的知识`, keywords_json: [], status: "active",
    active_version_id: "version-a1", version: 1, content_sha256: null, generation: 1,
    updated_at: "2026-11-26T00:00:00.000Z" });
  const versionFor = (): KnowledgeVersion => ({ id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async (projectId: string) => {
      const item = itemFor(projectId);
      return { items: [item], next_offset: null };
    },
    detail: async (projectId: string) => ({ ...itemFor(projectId), versions: [versionFor()], versions_next_offset: null,
      proposals: [], evaluations: [], usages: [] }),
    version: async (projectId: string) => ({ ...versionFor(),
      item: { id: `item-${projectId}`, kind: "memory", title: `${projectId} 的知识`, logical_key: `human-${projectId}` },
      candidate: { kind: "memory", content: "v1 正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async () => ({ item_ref: "created", version_ref: "v-created", version: 1 }),
    revise: async (_projectId: string, _itemId: string, body: { expected_version: number; content: string }) => {
      reviseCalls.push({ expected_version: body.expected_version, content: body.content });
      return new Promise((_resolve, reject) => { rejectEdit = reject; }) as Promise<{ item_ref: string; version_ref: string; version: number }>;
    },
    archive: async () => ({ item_ref: "item", status: "retired" }),
    restore: async () => ({ item_ref: "item", status: "active" }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const buttons = () => [...dom.window.document.querySelectorAll("button")] as HTMLElement[];
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...buttons(), ...dom.window.document.querySelectorAll("p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const field = (label: string) => dom.window.document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLTextAreaElement | null;
  const typeInto = (input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void => {
    assert.ok(input, "输入框必须存在");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) }),
            createElement(Route, { path: "/projects/:projectId/tasks/:canvasId", element: createElement("div") })))));
    });
    await flush();
    await click([...buttons()].find((node) => (node.textContent ?? "").includes("project-a 的知识")));
    await click(byText(/编辑正文（基于 v1）/u));
    await act(async () => { typeInto(field("编辑正文"), "草稿内容"); });
    // 写到一半刷新：版本选择与草稿都要留住，基准仍是 v1。
    await click(byText("刷新"));
    assert.equal((field("编辑正文") as HTMLTextAreaElement | null)?.value, "草稿内容", "刷新不得清掉编辑内容");
    assert.ok(byText(/保存为新版本（v2）/u), "刷新后仍应停在原基准版本（v1 → 下一版仍是 v2）");
    // 连续两次点击只发一次请求。
    const saveButton = byText(/保存为新版本（v2）/u);
    await act(async () => {
      saveButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      saveButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert.equal(reviseCalls.length, 1, "同一草稿在途时不能双发");
    assert.equal(reviseCalls[0]!.expected_version, 1, "提交必须用原基准版本");
    // 迟到的失败只属于 project-a，不得写到新项目的页面上。
    await act(async () => { rejectEdit?.(new Error("project-a 保存失败")); });
    await flush();
    assert.ok(byText(/project-a 保存失败/u), "本项目的失败要能看到");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("a historical version opened from page two stays selected after a refresh", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  const item: KnowledgeItem = { id: "item-a", project_id: "project-a", kind: "memory", logical_key: "human-note-pages",
    title: "分页历史", keywords_json: [], status: "active", active_version_id: "version-v2", version: 2,
    content_sha256: null, generation: 2, updated_at: "2026-11-26T00:00:00.000Z" };
  const versionOf = (id: string, version: number): KnowledgeVersion => ({ id, version, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" });
  const v2 = versionOf("version-v2", 2);
  const v1 = versionOf("version-v1", 1);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async () => ({ items: [item], next_offset: null }),
    detail: async () => ({ ...item, versions: [v2], versions_next_offset: "page-2", proposals: [], evaluations: [], usages: [] }),
    versions: async () => ({ items: [v1], next_offset: null }),
    version: async (_p: string, _i: string, versionId: string) => ({
      ...(versionId === "version-v1" ? v1 : v2),
      item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
      candidate: { kind: "memory", content: "正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async () => ({ item_ref: item.id, version_ref: "v-x", version: 3 }),
    revise: async () => ({ item_ref: item.id, version_ref: "v-y", version: 3 }),
    archive: async () => ({ item_ref: item.id, status: "retired" }),
    restore: async () => ({ item_ref: item.id, status: "active" }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined) => {
    assert.ok(target, "期望的控件必须渲染出来");
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    await click([...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("分页历史")));
    await click(byText(/加载更多版本/u));
    await click(byText(/^v1 · /u));
    await click(byText("刷新"));
    assert.ok(byText(/编辑正文（基于 v1）/u), "只存在于第二页的历史版本，刷新后仍应保持选中");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});

test("project A's late edit result never touches project B's own draft or save state", async (context) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter, Route, Routes, useNavigate } = await import("react-router-dom");
  const { AuthProvider } = await import("../auth");
  const { ProjectKnowledgePage } = await import("./ProjectKnowledgePage");
  const originalApi = { ...api };
  const originalKnowledge = { ...projectKnowledgeApi };
  let goto: ((path: string) => void) | null = null;
  let releaseA: ((value: { item_ref: string; version_ref: string; version: number }) => void) | null = null;
  let releaseB: ((value: { item_ref: string; version_ref: string; version: number }) => void) | null = null;
  const reviseCalls: Array<{ project: string; content: string }> = [];
  const versionOf = (): KnowledgeVersion => ({ id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: null, revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" });
  const itemOf = (project: string): KnowledgeItem => ({ id: `item-${project}`, project_id: project, kind: "memory",
    logical_key: `human-${project}`, title: `${project} 的知识`, keywords_json: [], status: "active",
    active_version_id: "version-a1", version: 1, content_sha256: null, generation: 1,
    updated_at: "2026-11-26T00:00:00.000Z" });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null, setItem: () => undefined, removeItem: () => undefined,
  } });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: true }),
    authMe: async () => ({ authenticated: true, auth_required: true,
      actor: { type: "api_token", id: "maintainer", name: "maintainer", role: "operator", scopes: ["projects:read", "projects:write"] } }),
    projects: async () => [], credentials: async () => [],
  });
  Object.assign(projectKnowledgeApi, {
    list: async (projectId: string) => ({ items: [itemOf(projectId)], next_offset: null }),
    detail: async (projectId: string) => ({ ...itemOf(projectId), versions: [versionOf()], versions_next_offset: null,
      proposals: [], evaluations: [], usages: [] }),
    version: async (projectId: string) => ({ ...versionOf(),
      item: { id: `item-${projectId}`, kind: "memory", title: `${projectId} 的知识`, logical_key: `human-${projectId}` },
      candidate: { kind: "memory", content: "正文" } }) as never,
    grants: async () => [],
    activity: async () => ({ items: [], next_offset: null,
      collection: { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null },
      summary: { registered_sources: 0, collected_sources: 0, skipped_sources: 0, pending_sources: 0,
        active_memory: 0, active_skills: 0, draft_items: 0, completed_work: 0, blocked_work: 0,
        usage_count: 0, feedback_count: 0, successful_feedback: 0 }, skipped_sources: [] }) as never,
    backfill: async () => ({ items: [], next_offset: null }),
    receipts: async () => ({ items: [], next_offset: null }),
    create: async () => ({ item_ref: "created", version_ref: "v-created", version: 1 }),
    revise: async (projectId: string, _itemId: string, body: { content: string }) => {
      reviseCalls.push({ project: projectId, content: body.content });
      if (projectId === "project-a") {
        return new Promise((resolve) => { releaseA = resolve; }) as Promise<{ item_ref: string; version_ref: string; version: number }>;
      }
      return new Promise((resolve) => { releaseB = resolve; }) as Promise<{ item_ref: string; version_ref: string; version: number }>;
    },
    archive: async () => ({ item_ref: "item", status: "retired" }),
    restore: async () => ({ item_ref: "item", status: "active" }),
  });
  function Navigator(): null {
    goto = useNavigate();
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (text: string | RegExp): HTMLElement | undefined =>
    [...dom.window.document.querySelectorAll("button,p,span")].find((node) =>
      (typeof text === "string" ? node.textContent === text : text.test(node.textContent ?? ""))) as HTMLElement | undefined;
  const click = async (target: HTMLElement | undefined, label = "") => {
    assert.ok(target, `期望的控件必须渲染出来 ${label}`);
    await act(async () => { target!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await flush();
  };
  const field = (label: string) => dom.window.document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLTextAreaElement | null;
  const typeInto = (input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void => {
    assert.ok(input, "输入框必须存在");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), "value")!.set!;
    setter.call(input, value);
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ["/projects/project-a/knowledge"] },
        createElement(AuthProvider, null,
          createElement(Navigator),
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:projectId/knowledge", element: createElement(ProjectKnowledgePage) })))));
    });
    await flush();
    // 在 A 打开编辑并提交（挂起）
    await click([...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("project-a 的知识")));
    await click(byText(/编辑正文（基于 v1）/u), "A/B 编辑正文");
    await act(async () => { typeInto(field("编辑正文"), "A 的提交内容"); });
    await click(byText(/保存为新版本（v2）/u));
    // 切到 B：B 有自己的草稿与独立保存
    await act(async () => { goto?.("/projects/project-b/knowledge"); });
    await flush();
    await flush();
    await click([...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("project-b 的知识")));
    console.error("[dbg-b2]", [...dom.window.document.querySelectorAll("button")].map((n) => n.textContent).join(" | "));
    await click(byText(/编辑正文（基于 v1）/u), "A/B 编辑正文");
    await act(async () => { typeInto(field("编辑正文"), "B 自己的草稿"); });
    await click([...dom.window.document.querySelectorAll("button")].find((node) => (node.textContent ?? "").includes("保存为新版本")));
    assert.equal(reviseCalls.length, 2, "A 在途不应拦住 B 的保存");
    assert.equal(reviseCalls[1]!.project, "project-b");
    // B 在自己保存期间继续输入，然后 B 的保存先回来：草稿要保留，基准推进到新版本。
    await act(async () => { typeInto(field("编辑正文"), "B 保存期间的新输入"); });
    await act(async () => { releaseB?.({ item_ref: "item-project-b", version_ref: "version-b2", version: 2 }); });
    await flush();
    // A 迟到成功：不得改 B 的草稿、提示或选择
    await act(async () => { releaseA?.({ item_ref: "item-project-a", version_ref: "version-a2", version: 2 }); });
    await flush();
    assert.equal((field("编辑正文") as HTMLTextAreaElement | null)?.value, "B 保存期间的新输入", "A 的成功不得清掉 B 的草稿");
    assert.ok(byText(/project-b 的知识/u), "A 的成功不得把选择切回 A 的条目");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});
