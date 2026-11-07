import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router-dom";
import { api, setLocalToken, type AuthMe, type SkillSource } from "./api";
import { AuthProvider } from "./auth";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { SkillSourceCatalogActions, type SkillSourceCatalogActionsProps } from "./components/SkillSourceCatalogActions";

const source: SkillSource = {
  id: "source-a", name: "fixture-source", repo_url: "http://127.0.0.1/skills.git", branch: "main",
  created_at: "2026-11-07T00:00:00Z", synced_at: null, trust_status: "quarantined", enabled: false,
  source_instance_id: "instance-a", revocation_epoch: "7", candidate_hash: "hash-b",
  candidate_json: {
    schema: "deepsonar.skill-source-candidate/v1", source_instance_id: "instance-a",
    repo_url: "http://127.0.0.1/skills.git", branch: "main", revocation_epoch: "7",
    commit_sha: "commit-b", content_hash: "content-b", module_count: 2,
    synced_at: "2026-11-07T00:00:00Z", synced_by: null,
  },
};
const admin: AuthMe = {
  auth_required: true, authenticated: true, user: null,
  actor: { type: "api_token", name: "fixture", role: null, scopes: ["skills:read", "skills:write"] },
};

async function fixture(run: (h: {
  render: (props?: Partial<SkillSourceCatalogActionsProps>) => Promise<void>;
  button: (text: string) => HTMLButtonElement;
  click: (text: string) => Promise<void>;
  container: HTMLElement;
  document: Document;
  hide: () => Promise<void>;
}) => Promise<void>, me = admin) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://127.0.0.1/" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const original = { authStatus: api.authStatus, authMe: api.authMe, sync: api.syncSkillSource, trust: api.trustSkillSource };
  api.authStatus = async () => ({ auth_required: true, has_users: true, bootstrap_available: false, default_admin_credentials_active: false, session_ttl_days: 1 });
  api.authMe = async () => me;
  setLocalToken("fixture-not-a-real-token");
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  let props: SkillSourceCatalogActionsProps = { source, onChanged: () => {}, scopeKey: "project-a" };
  const render = async (next: Partial<SkillSourceCatalogActionsProps> = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(createElement(MemoryRouter, null,
      createElement(AuthProvider, null, createElement(ConfirmDialogProvider, null, createElement(SkillSourceCatalogActions, props))))); });
  };
  const button = (text: string) => {
    const found = Array.from(dom.window.document.querySelectorAll("button")).find((node) => node.textContent === text);
    assert.ok(found, `missing button: ${text}`);
    return found;
  };
  const click = async (text: string) => { await act(async () => { button(text).click(); }); };
  try {
    await render();
    await run({ render, button, click, container, document: dom.window.document, hide: async () => { await act(async () => root.render(null)); } });
  } finally {
    await act(async () => root.unmount());
    api.authStatus = original.authStatus; api.authMe = original.authMe;
    api.syncSkillSource = original.sync; api.trustSkillSource = original.trust;
    setLocalToken("");
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("缺 instance/epoch/candidate 的加载态禁审批，禁用源必须先隔离", async () => {
  await fixture(async ({ render, button, container }) => {
    for (const incomplete of [
      { source_instance_id: undefined }, { revocation_epoch: undefined }, { enabled: undefined }, { trust_status: undefined }, { candidate_hash: undefined },
      { candidate_hash: null }, { candidate_json: undefined }, { candidate_json: null },
      { candidate_json: { ...source.candidate_json!, revocation_epoch: "6" } },
    ]) {
      await render({ source: { ...source, ...incomplete } });
      assert.equal(button("批准并启用").disabled, true);
    }
    await render({ source: { ...source, trust_status: "disabled" } });
    assert.equal(button("批准并启用").disabled, true);
    assert.equal(button("同步候选").disabled, true);
    assert.equal(button("移至隔离").disabled, false);
    assert.match(container.textContent!, /instance instance-a · epoch 7/);
  });
});

test("project scoped token 和只读 actor 不露全局写按钮", async () => {
  for (const actor of [{ ...admin.actor!, project_id: "project-a" }, { ...admin.actor!, role: "admin", project_id: "project-a" }, { ...admin.actor!, scopes: ["skills:read"] }]) {
    await fixture(async ({ container }) => { assert.equal(container.querySelectorAll("button").length, 0); }, { ...admin, actor });
  }
});

test("真实确认前无请求、取消无请求，确认后提交精确 nonce/hash", async () => {
  await fixture(async ({ click, document, container }) => {
    const writes: Parameters<typeof api.trustSkillSource>[] = [];
    api.trustSkillSource = async (...args) => { writes.push(args); return source; };
    await click("批准并启用");
    assert.equal(writes.length, 0);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    assert.match(dialog.textContent!, /平台全局/);
    assert.match(dialog.textContent!, /所有未显式停用此源的项目后续 Job 默认可用，无需各项目勾选/);
    assert.match(dialog.textContent!, /清理失效 RoleConfig 引用，不改已创建 Job 快照/);
    assert.match(dialog.textContent!, /hash-b/);
    await click("取消");
    assert.equal(writes.length, 0);
    await click("批准并启用");
    await click("确认批准并启用");
    assert.deepEqual(writes, [["source-a", "trusted", {
      expected_epoch: "7", expected_instance_id: "instance-a", candidate_hash: "hash-b", enabled: true,
    }]]);
    assert.match(container.textContent!, /已批准并启用平台源/);
  });
});

test("确认 B 期间候选换成 C 或 epoch/instance/作用域 ABA 后不偷偷提交新候选", async () => {
  await fixture(async ({ render, click }) => {
    let writes = 0;
    api.trustSkillSource = async () => { writes += 1; return source; };
    await click("批准并启用");
    await render({ source: { ...source, candidate_hash: "hash-c", candidate_json: { ...source.candidate_json!, commit_sha: "commit-c" } } });
    await click("确认批准并启用");
    assert.equal(writes, 0);
    await render({ source });
    await click("批准并启用");
    await render({ source: { ...source, source_instance_id: "instance-new", revocation_epoch: "8" } });
    await render({ source });
    await click("确认批准并启用");
    assert.equal(writes, 0, "equal values after ABA cannot revive old confirmation");
    await click("批准并启用");
    await render({ scopeKey: "project-b" });
    await render({ scopeKey: "project-a" });
    await click("确认批准并启用");
    assert.equal(writes, 0);
  });
});

test("同步失败仍刷新当前元数据；成功但 reload 失败不冒充写失败", async () => {
  await fixture(async ({ render, click, container }) => {
    let reloads = 0;
    await render({ onChanged: async () => { reloads += 1; } });
    api.syncSkillSource = async () => { throw new Error("SKILL_SOURCE_SYNC_FAILED"); };
    await click("同步候选");
    assert.equal(reloads, 1);
    assert.match(container.textContent!, /同步失败：SKILL_SOURCE_SYNC_FAILED/);
    api.trustSkillSource = async () => source;
    await render({ onChanged: async () => { throw new Error("read interrupted"); } });
    await click("批准并启用");
    await click("确认批准并启用");
    assert.match(container.textContent!, /已批准并启用平台源；刷新失败/);
    assert.doesNotMatch(container.textContent!, /操作失败|审批失败/);
    api.syncSkillSource = async () => ({ ok: true, modules: 2, changed: true, candidate_hash: "hash-c",
      previous_commit_sha: null, last_commit_sha: "commit-c", previous_content_hash: null, last_content_hash: "content-c", synced_at: "2026-11-07T00:00:00Z" });
    await click("同步候选");
    assert.match(container.textContent!, /候选已同步，待批准.*刷新失败/);
    assert.doesNotMatch(container.textContent!, /同步失败/);
  });
});

test("sync hash/null/undefined 分别展示待批、live 核验、未知", async () => {
  await fixture(async ({ click, container }) => {
    for (const candidate_hash of ["hash-c", null, undefined]) {
      api.syncSkillSource = async () => ({ ok: true, modules: 2, changed: true, candidate_hash,
        previous_commit_sha: null, last_commit_sha: "commit-c", previous_content_hash: null, last_content_hash: "content-c", synced_at: "2026-11-07T00:00:00Z" });
      await click("同步候选");
      const status = container.querySelector('[role="status"]')!.textContent!;
      assert.match(status, candidate_hash === undefined ? /候选状态未知/ : candidate_hash === null ? /live 目录健康核验完成/ : /候选已同步，待批准/);
    }
  });
});

test("迟到成功/失败不能跨 scope、ABA 或卸载调用旧/新 onChanged", async () => {
  await fixture(async ({ render, click, container, hide }) => {
    let oldCalls = 0; let newCalls = 0;
    let resolve!: (value: Awaited<ReturnType<typeof api.syncSkillSource>>) => void;
    let reject!: (error: Error) => void;
    const pending = () => new Promise<Awaited<ReturnType<typeof api.syncSkillSource>>>((yes, no) => { resolve = yes; reject = no; });
    api.syncSkillSource = pending;
    await render({ onChanged: () => { oldCalls += 1; } });
    await click("同步候选");
    await render({ scopeKey: "project-b", onChanged: () => { newCalls += 1; } });
    await render({ scopeKey: "project-a" });
    await act(async () => reject(new Error("late failure")));
    assert.equal(oldCalls + newCalls, 0);
    assert.doesNotMatch(container.textContent!, /late failure/);
    await click("同步候选");
    await hide();
    await act(async () => resolve({ ok: true, modules: 2, changed: true, candidate_hash: "hash-c", previous_commit_sha: null,
      last_commit_sha: "commit-c", previous_content_hash: null, last_content_hash: "content-c", synced_at: "2026-11-07T00:00:00Z" }));
    assert.equal(oldCalls + newCalls, 0);
  });
});

test("API 保留 create 200/201 existing 与 sync 候选结果，并发送精确 trust 请求体", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  let status = 200;
  let payload: unknown = { ...source, existing: true };
  globalThis.fetch = (async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const input = { name: "requested-alias", repo_url: "http://127.0.0.1/skills.git", branch: "main" };
    const reused = await api.createSkillSource(input);
    assert.equal(reused.existing, true);
    assert.equal(reused.name, "fixture-source");
    status = 201; payload = { ...source, existing: false };
    assert.equal((await api.createSkillSource(input)).existing, false);
    status = 200; payload = { candidate_hash: "hash-b" };
    assert.equal((await api.syncSkillSource(source.id)).candidate_hash, "hash-b");
    payload = source;
    await api.trustSkillSource(source.id, "trusted", { expected_epoch: "7", expected_instance_id: "instance-a", candidate_hash: "hash-b", enabled: true });
    assert.deepEqual(requests.at(-1), { url: "/api/skill-sources/source-a/trust", body: {
      trust_status: "trusted", expected_epoch: "7", expected_instance_id: "instance-a", candidate_hash: "hash-b", enabled: true,
    } });
    assert.deepEqual(requests[0], { url: "/api/skill-sources", body: input });
  } finally { globalThis.fetch = original; }
});

test("撤信任与禁用传当前 epoch/instance 且 enabled=false", async () => {
  await fixture(async ({ render, click, document }) => {
    const writes: Parameters<typeof api.trustSkillSource>[] = [];
    api.trustSkillSource = async (...args) => { writes.push(args); return source; };
    await render({ source: { ...source, trust_status: "disabled" } });
    await click("移至隔离");
    assert.match(document.querySelector('[role="alertdialog"]')!.textContent!, /平台全局操作，不是单项目操作/);
    assert.match(document.querySelector('[role="alertdialog"]')!.textContent!, /撤销 epoch 阻止后续 pull/);
    await click("确认撤销");
    await render({ source });
    await click("禁用");
    await click("确认撤销");
    assert.deepEqual(writes, [
      ["source-a", "quarantined", { expected_epoch: "7", expected_instance_id: "instance-a", enabled: false }],
      ["source-a", "disabled", { expected_epoch: "7", expected_instance_id: "instance-a", enabled: false }],
    ]);
  });
});
