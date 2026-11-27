import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { api } from "../api";
import { projectKnowledgeApi, type KnowledgeDetail, type KnowledgeItem, type KnowledgeVersion, type KnowledgeVersionDetail } from "../ProjectKnowledgeApi";

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
    // A 迟到失败：不得在 B 显示错误，也不得让 B 的提交按钮变灰
    await act(async () => { rejectCreate?.(new Error("A 的提交失败")); });
    await flush();
    assert.ok(!byText(/A 的提交失败/u), "A 的失败不得显示在 B");
    const submitB = byText("提交新建") as HTMLButtonElement | undefined;
    assert.ok(submitB, "B 仍应有提交按钮");
    assert.equal(submitB!.disabled, false, "A 未返回不应阻塞 B 的提交");
  } finally {
    Object.assign(api, originalApi);
    Object.assign(projectKnowledgeApi, originalKnowledge);
    await act(async () => { root.unmount(); });
  }
});
