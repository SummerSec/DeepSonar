import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { api, type AuthMe, type ProjectSkillSourceBinding, type SkillSource } from "./api";
import { AuthProvider } from "./auth";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { ProjectSkillSourceAllowlistPanel } from "./components/ProjectSkillSourceAllowlistPanel";
import { ToastHost } from "./toast";

const hash = "a".repeat(64);
function binding(overrides: Partial<ProjectSkillSourceBinding> = {}): ProjectSkillSourceBinding {
  return {
    skill_source_id: "11111111-1111-4111-8111-111111111111", name: "fixture-skills",
    repo_url: "https://127.0.0.1/fixture-skills", branch: "main", trust_status: "trusted",
    source_enabled: true, project_enabled: true, module_count: 2,
    last_commit_sha: "a".repeat(40), last_content_hash: hash, catalog_snapshot_hash: hash,
    source_instance_id: "22222222-2222-4222-8222-222222222222", revocation_epoch: "0",
    candidate_hash: null, candidate_json: null, last_checked_at: null, last_sync_error: null,
    synced_at: "2026-11-07T00:00:00.000Z", ...overrides,
  };
}
function platformSource(source: ProjectSkillSourceBinding): SkillSource {
  return {
    id: source.skill_source_id, name: source.name, repo_url: source.repo_url, branch: source.branch,
    created_at: "2026-11-07T00:00:00.000Z", synced_at: source.synced_at,
    trust_status: source.trust_status, enabled: source.source_enabled, module_count: source.module_count,
    source_instance_id: source.source_instance_id, revocation_epoch: source.revocation_epoch,
    catalog_snapshot_hash: source.catalog_snapshot_hash, candidate_hash: source.candidate_hash,
    candidate_json: source.candidate_json, last_checked_at: null, last_sync_error: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const forbidden = () => Object.assign(new Error("403 fixture forbidden"), { status: 403 });

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(actor?: NonNullable<AuthMe["actor"]>) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  // Non-secret fixture marker; no request leaves the process because every used API is stubbed.
  dom.window.localStorage.setItem("deepsonar_api_token", "fixture-not-a-credential");
  const original = {
    authStatus: api.authStatus, authMe: api.authMe, projectSkillSources: api.projectSkillSources,
    setProjectSkillSourceEnabled: api.setProjectSkillSourceEnabled, createSkillSource: api.createSkillSource,
    syncSkillSource: api.syncSkillSource, trustSkillSource: api.trustSkillSource,
  };
  api.authStatus = async () => ({ auth_required: true, has_users: true, bootstrap_available: false, default_admin_credentials_active: false, session_ttl_days: 1 });
  api.authMe = async () => ({
    auth_required: true, authenticated: true, user: null,
    actor: actor ?? { type: "api_token", name: "fixture", role: null, scopes: ["skills:write"], project_id: null },
  });
  const rows: Record<string, ProjectSkillSourceBinding[]> = { A: [binding()], B: [binding({ name: "B-skills" })] };
  const reads: string[] = [];
  api.projectSkillSources = async (projectId) => { reads.push(projectId); return { configured: true, sources: rows[projectId] ?? [] }; };
  api.setProjectSkillSourceEnabled = async (projectId, id, enabled) => {
    const source = rows[projectId].find((entry) => entry.skill_source_id === id);
    assert.ok(source);
    const result = { ...source, project_enabled: enabled };
    rows[projectId] = rows[projectId].map((entry) => entry === source ? result : entry);
    return result;
  };
  api.createSkillSource = async () => { throw forbidden(); };
  api.syncSkillSource = async () => { throw forbidden(); };
  api.trustSkillSource = async () => { throw forbidden(); };
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  let saved = 0;
  const render = (projectId: string) => act(async () => {
    root.render(createElement(MemoryRouter, null,
      createElement(AuthProvider, null,
        createElement(ConfirmDialogProvider, null,
          createElement(ProjectSkillSourceAllowlistPanel, { projectId, onSaved: () => { saved += 1; } }),
          createElement(ToastHost)))));
  });
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === label);
  const checkbox = (name = "fixture-skills") => {
    const element = container.querySelector<HTMLInputElement>(`input[aria-label="${name} 本项目启用"]`);
    assert.ok(element);
    return element;
  };
  const click = async (element: HTMLElement | undefined | null) => { assert.ok(element); await act(async () => { element.click(); }); };
  const fill = async (placeholder: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    assert.ok(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const register = async (name = "new-name") => {
    await fill("名称（如 team-agent-skills）", name);
    await fill("https://github.com/example/team-agent-skills", "https://127.0.0.1/fixture-skills");
    await click(button("登记"));
  };
  const confirmIfPresent = async () => {
    const dialog = dom.window.document.querySelector('[role="alertdialog"]');
    if (dialog) {
      const buttons = dialog.querySelectorAll<HTMLButtonElement>("button");
      await click(buttons[buttons.length - 1]);
    }
  };
  const close = async () => {
    await act(async () => root.unmount());
    Object.assign(api, original);
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const toast = () => Array.from(dom.window.document.querySelectorAll(".app-toast")).at(-1)?.textContent ?? "";
  return { dom, container, rows, reads, render, button, checkbox, click, fill, register, confirmIfPresent, close, toast, saved: () => saved };
}
async function withFixture(run: (f: Fixture) => Promise<void>, actor?: NonNullable<AuthMe["actor"]>) {
  const f = await fixture(actor);
  try { await f.render("A"); await run(f); } finally { await f.close(); }
}

test("unsaved disable survives registration and shared sync failures, then can be cancelled", async () => {
  await withFixture(async (f) => {
    await f.click(f.checkbox());
    assert.equal(f.checkbox().checked, false);
    assert.match(f.container.textContent!, /停用待保存/);
    await f.register();
    assert.equal(f.checkbox().checked, false);
    assert.match(f.toast(), /登记失败.*403/);
    assert.ok(f.reads.length >= 2);
    const readsBeforeSync = f.reads.length;
    await f.click(f.button("同步候选"));
    await f.confirmIfPresent();
    assert.ok(f.reads.length > readsBeforeSync, "failed shared sync still refreshes server metadata");
    assert.equal(f.checkbox().checked, false);
    assert.match(f.container.textContent!, /停用待保存/);
    await f.click(f.button("取消未保存更改"));
    assert.equal(f.checkbox().checked, true);
  });
});

test("shared sync failure remains visible through a deferred metadata refresh", async () => {
  await withFixture(async (f) => {
    await f.click(f.checkbox());
    const refresh = deferred<Awaited<ReturnType<typeof api.projectSkillSources>>>();
    api.projectSkillSources = () => refresh.promise;
    await f.click(f.button("同步候选"));
    assert.match(f.container.textContent!, /同步失败.*403/);
    assert.match(f.container.textContent!, /刷新中/);
    assert.equal(f.checkbox().checked, false, "refresh preserves the mounted draft row");
    await act(async () => refresh.resolve({ configured: true, sources: f.rows.A }));
    assert.match(f.container.textContent!, /同步失败.*403/);
    assert.match(f.toast(), /同步失败.*403/);
    assert.equal(f.checkbox().checked, false);
  });
});

test("shared sync success survives a metadata refresh failure without claiming write failure", async () => {
  await withFixture(async (f) => {
    api.syncSkillSource = async () => ({ ok: true, modules: 2, changed: false, candidate_hash: null,
      previous_commit_sha: null, last_commit_sha: null, previous_content_hash: null, last_content_hash: null,
      synced_at: "2026-11-07T00:00:00.000Z" });
    const refresh = deferred<Awaited<ReturnType<typeof api.projectSkillSources>>>();
    api.projectSkillSources = () => refresh.promise;
    await f.click(f.button("同步候选"));
    const success = f.toast();
    assert.doesNotMatch(success, /同步失败/);
    await act(async () => refresh.reject(new Error("fixture metadata refresh unavailable")));
    assert.match(f.toast(), /加载 Skill 源可用性失败.*fixture metadata refresh unavailable/);
    assert.doesNotMatch(f.container.textContent!, /同步失败/);
    assert.ok(f.checkbox());
  });
});

test("server false plus unsaved check is not usable; only a confirmed save enables it", async () => {
  const f = await fixture();
  try {
    f.rows.A = [binding({ project_enabled: false })];
    await f.render("A");
    await f.click(f.checkbox());
    assert.match(f.container.textContent!, /启用待保存/);
    assert.doesNotMatch(f.container.textContent!, /本项目可用/);
    const response = deferred<ProjectSkillSourceBinding>();
    api.setProjectSkillSourceEnabled = () => response.promise;
    await f.click(f.button("保存"));
    assert.doesNotMatch(f.container.textContent!, /本项目可用/);
    f.rows.A = [binding()];
    await act(async () => response.resolve(binding()));
    assert.match(f.container.textContent!, /本项目可用/);
    assert.doesNotMatch(f.container.textContent!, /启用待保存/);
    assert.equal(f.saved(), 1);
  } finally { await f.close(); }
});

test("403 and mismatched write responses do not claim success or discard unconfirmed overrides", async () => {
  await withFixture(async (f) => {
    await f.click(f.checkbox());
    api.setProjectSkillSourceEnabled = async () => { throw forbidden(); };
    await f.click(f.button("保存"));
    assert.equal(f.checkbox().checked, false);
    assert.match(f.container.textContent!, /停用待保存/);
    assert.match(f.toast(), /保存未完成.*已确认 0 项/);
    assert.equal(f.saved(), 0);
    api.setProjectSkillSourceEnabled = async () => binding();
    await f.click(f.button("保存"));
    assert.equal(f.checkbox().checked, false);
    assert.match(f.toast(), /服务器未确认/);
    assert.equal(f.saved(), 0);
  });
});

test("partial save clears only confirmed rows and reports the remaining failure", async () => {
  await withFixture(async (f) => {
    const second = binding({ skill_source_id: "33333333-3333-4333-8333-333333333333", name: "second" });
    f.rows.A = [...f.rows.A, second];
    await f.register(); // refresh includes the second row despite the registration failure
    await f.click(f.checkbox());
    await f.click(f.checkbox("second"));
    api.setProjectSkillSourceEnabled = async (_project, id) => {
      if (id === second.skill_source_id) throw forbidden();
      f.rows.A[0] = binding({ project_enabled: false });
      return f.rows.A[0];
    };
    await f.click(f.button("保存"));
    assert.equal(Array.from(f.container.querySelectorAll("span")).filter((entry) => entry.textContent === "停用待保存").length, 1);
    assert.match(f.toast(), /已确认 1 项/);
    assert.equal(f.checkbox().checked, false);
    assert.equal(f.checkbox("second").checked, false);
    assert.equal(f.saved(), 1, "notify only the confirmed partial server change");
  });
});

test("same repository under a different name reuses the actual source without duplicate or implicit project grant", async () => {
  await withFixture(async (f) => {
    const requests: Parameters<typeof api.createSkillSource>[0][] = [];
    api.createSkillSource = async (request) => {
      requests.push(request);
      return { ...platformSource(binding()), existing: true };
    };
    await f.click(f.checkbox());
    await f.register("different-name");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].name, "different-name");
    assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 1);
    assert.equal(f.checkbox().checked, false);
    assert.match(f.toast(), /已复用「fixture-skills」/);
    assert.doesNotMatch(f.toast(), /已登记「different-name」/);
  });
});

test("a removed source override is explicit and cancellable, never transferred to another source", async () => {
  await withFixture(async (f) => {
    await f.click(f.checkbox());
    f.rows.A = [binding({ skill_source_id: "33333333-3333-4333-8333-333333333333", name: "replacement" })];
    await f.register();
    assert.match(f.container.textContent!, /fixture-skills.*已不存在/);
    assert.equal(f.checkbox("replacement").checked, true);
    assert.equal(f.button("保存")!.disabled, true);
    await f.click(f.button("取消该项更改"));
    assert.doesNotMatch(f.container.textContent!, /已不存在/);
  });
});

for (const returnToA of [false, true]) {
  test(`late A save cannot refresh, clear busy or invoke onSaved after ${returnToA ? "A→B→A" : "A→B"}`, async () => {
    await withFixture(async (f) => {
      const oldSave = deferred<ProjectSkillSourceBinding>();
      api.setProjectSkillSourceEnabled = () => oldSave.promise;
      await f.click(f.checkbox());
      await f.click(f.button("保存"));
      await f.render("B");
      assert.equal(f.checkbox("B-skills").checked, true, "A draft must not migrate to B");
      assert.equal(f.container.querySelector('input[aria-label="fixture-skills 本项目启用"]'), null,
        "the A source control is absent; a legitimate shared repository URL may still be visible in B");
      if (returnToA) await f.render("A");
      const name = returnToA ? "fixture-skills" : "B-skills";
      const newSave = deferred<ProjectSkillSourceBinding>();
      api.setProjectSkillSourceEnabled = () => newSave.promise;
      await f.click(f.checkbox(name));
      await f.click(f.button("保存"));
      const reads = f.reads.length;
      await act(async () => oldSave.resolve(binding({ project_enabled: false })));
      assert.equal(f.reads.length, reads, "old completion cannot issue a new owner reload");
      assert.ok(f.button("保存中…"), "old finally must not clear the current operation's busy state");
      assert.equal(f.saved(), 0);
      const current = binding({ name, project_enabled: false });
      f.rows[returnToA ? "A" : "B"] = [current];
      await act(async () => newSave.resolve(current));
      assert.equal(f.saved(), 1);
    });
  });
}

test("late A list and registration responses are fenced across B and ABA", async () => {
  const f = await fixture();
  try {
    const oldList = deferred<Awaited<ReturnType<typeof api.projectSkillSources>>>();
    api.projectSkillSources = (projectId) => { f.reads.push(projectId); return projectId === "A" ? oldList.promise : Promise.resolve({ configured: true, sources: f.rows.B }); };
    await f.render("A");
    await f.render("B");
    const reads = f.reads.length;
    await act(async () => oldList.resolve({ configured: true, sources: [binding({ name: "OLD-A" })] }));
    assert.doesNotMatch(f.container.textContent!, /OLD-A/);
    assert.equal(f.reads.length, reads);
    api.projectSkillSources = async (projectId) => { f.reads.push(projectId); return { configured: true, sources: f.rows[projectId] }; };
    await f.render("A");
    const oldRegistration = deferred<Awaited<ReturnType<typeof api.createSkillSource>>>();
    api.createSkillSource = () => oldRegistration.promise;
    await f.register();
    await f.render("B");
    await f.render("A");
    const readsBefore = f.reads.length;
    await act(async () => oldRegistration.resolve({ ...platformSource(binding({ name: "OLD-REGISTRATION" })), existing: true }));
    assert.equal(f.reads.length, readsBefore);
    assert.doesNotMatch(f.toast(), /OLD-REGISTRATION/);
    assert.equal(f.saved(), 0);
  } finally { await f.close(); }
});

test("late shared sync completion cannot reload a new ABA owner", async () => {
  await withFixture(async (f) => {
    const oldSync = deferred<Awaited<ReturnType<typeof api.syncSkillSource>>>();
    api.syncSkillSource = () => oldSync.promise;
    await f.click(f.button("同步候选"));
    await f.confirmIfPresent();
    await f.render("B");
    await f.render("A");
    await f.click(f.checkbox());
    const reads = f.reads.length;
    await act(async () => oldSync.reject(forbidden()));
    assert.equal(f.reads.length, reads, "old shared onChanged must be fenced by the parent owner too");
    assert.equal(f.checkbox().checked, false);
    assert.match(f.container.textContent!, /停用待保存/);
  });
});

test("read-only users cannot edit; project-scoped tokens can save flags but not manage global sources", async () => {
  await withFixture(async (f) => {
    assert.equal(f.checkbox().disabled, true);
    assert.equal(f.button("登记")!.disabled, true);
    assert.equal(f.button("保存")!.disabled, true);
  }, { type: "api_token", name: "read-only", role: null, scopes: ["skills:read"], project_id: null });
  await withFixture(async (f) => {
    assert.equal(f.checkbox().disabled, false);
    assert.equal(f.button("登记")!.disabled, true);
    assert.match(f.container.textContent!, /未限定项目的全局 skills:write/);
    await f.click(f.checkbox());
    await f.click(f.button("保存"));
    assert.equal(f.saved(), 1);
  }, { type: "api_token", name: "project-writer", role: null, scopes: ["skills:write"], project_id: "A" });
});
