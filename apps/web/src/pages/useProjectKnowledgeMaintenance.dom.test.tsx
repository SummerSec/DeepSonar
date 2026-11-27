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
    title: "中文知识条目", keywords_json: [], status: "active", active_version_id: "version-a1", version: 1,
    content_sha256: null, generation: 1, updated_at: "2026-11-26T00:00:00.000Z" };
  const version: KnowledgeVersion = { id: "version-a1", version: 1, content_sha256: "c".repeat(64),
    creator_job_id: null, created_by_type: "human", created_by: "maintainer-a", revision_reason: null,
    sources_json: [], revoked_at: null, revoked_reason: null, created_at: "2026-11-26T00:00:00.000Z" };
  const detail: KnowledgeDetail = { ...item, versions: [version], versions_next_offset: null, proposals: [], evaluations: [], usages: [] };
  const versionDetail: KnowledgeVersionDetail = { ...version, item: { id: item.id, kind: "memory", title: item.title, logical_key: item.logical_key },
    candidate: { kind: "memory", content: "原始正文" } } as never;
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
    detail: async () => detail, version: async () => versionDetail, grants: async () => [],
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
    // 人工维护的版本在版本按钮上标出作者，不假设一定有 Job
    assert.ok(byText(/v1 · 人工维护 maintainer-a/u), "人工版本必须显示作者来源");
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
