import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { projectKnowledgeApi } from "../ProjectKnowledgeApi";

// 只挂载维护状态机：真实页面把它接在 ProjectKnowledgePage 上，这里验证评审点名的三件事——
// 草稿只在打开它的「项目+条目+基准版本」内有效、表单旁有独立反馈、下架后能原位撤销。
test("maintenance draft is bound to item and version, feedback stays near forms and undo is in place", async (context) => {
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
  const hook = await import("./useProjectKnowledgeMaintenance");
  const original = { ...projectKnowledgeApi };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  Object.assign(projectKnowledgeApi, {
    create: async (...args: unknown[]) => { calls.push({ method: "create", args }); return { item_ref: "new-item", version_ref: "v1", version: 1 }; },
    revise: async (...args: unknown[]) => { calls.push({ method: "revise", args }); return { item_ref: "item-a", version_ref: "v2", version: 2 }; },
    archive: async (...args: unknown[]) => { calls.push({ method: "archive", args }); return { item_ref: String(args[1]), status: "retired" }; },
    restore: async (...args: unknown[]) => { calls.push({ method: "restore", args }); return { item_ref: String(args[1]), status: "active" }; },
  });
  type Maintenance = ReturnType<typeof hook.useProjectKnowledgeMaintenance>;
  let api: Maintenance | null = null;
  let selected: string | null = "item-a";
  let versionId: string | null = "version-a1";
  const selectedItem: string[] = [];
  let refreshes = 0;
  function Harness() {
    api = hook.useProjectKnowledgeMaintenance({
      projectId: "project-a", selectedId: selected, versionId, refreshKey: refreshes,
      onSelectItem: (itemId) => { selectedItem.push(itemId); }, onRefresh: () => { refreshes += 1; },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    // 打开 A 的 v1 草稿
    await act(async () => { api!.openEdit({ itemId: "item-a", versionId: "version-a1", expectedVersion: 1, title: "A", content: "A-body" }); });
    assert.equal(api!.editActive, true);
    await act(async () => { api!.setEditDraft((draft) => draft && { ...draft, content: "A-edited" }); });
    // 切到另一条知识：草稿必须作废，不能用 A 的正文写 B
    selected = "item-b"; versionId = "version-b1";
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(api!.editActive, false, "切换条目后旧草稿必须失效");
    assert.equal(api!.editDraft, null, "切换条目后草稿要清掉");
    // 同一条知识从旧版切到当前版：草稿同样失效，避免绕过版本冲突
    selected = "item-a"; versionId = "version-a1";
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { api!.openEdit({ itemId: "item-a", versionId: "version-a1", expectedVersion: 1, title: "A", content: "old" }); });
    versionId = "version-a2";
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(api!.editActive, false, "切换版本后旧草稿必须失效");
    // 表单旁反馈：新建成功给提示并把页面定位到新条目
    await act(async () => { api!.setDraftTitle("新的知识"); api!.setDraftContent("正文"); });
    await act(async () => { api!.submitCreate(); await Promise.resolve(); });
    assert.match(api!.createNotice ?? "", /新建知识成功/u);
    assert.deepEqual(selectedItem, ["new-item"]);
    assert.equal((calls.find((call) => call.method === "create")?.args[1] as { logical_key: string }).logical_key, "human-note");
    // 下架后就地给出撤销，且撤销走 restore
    await act(async () => { api!.archiveItem("item-a"); await Promise.resolve(); });
    assert.deepEqual(api!.archivedHere, ["item-a"]);
    await act(async () => { api!.undoArchive("item-a"); await Promise.resolve(); });
    assert.deepEqual(api!.undoneHere, ["item-a"]);
    assert.equal(calls.filter((call) => call.method === "restore").length, 1);
  } finally {
    Object.assign(projectKnowledgeApi, original);
    await act(async () => { root.unmount(); });
  }
});
