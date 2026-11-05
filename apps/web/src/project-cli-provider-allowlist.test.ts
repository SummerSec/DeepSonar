import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { api, type ProjectSettings, type ProviderCredential } from "./api";
import { renderToStaticMarkup } from "react-dom/server";
import { credentialSelectionPatch, defaultCredentialCandidates, defaultCredentialUnavailable } from "./project-provider-selection";
import { ProjectCliProviderAllowlistPanel } from "./components/ProjectCliProviderAllowlistPanel";

const panel = readFileSync(new URL("./components/ProjectCliProviderAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

function renderCredentialPanel(credentialLoadState: "loading" | "error" | "loaded") {
  return renderToStaticMarkup(createElement(ProjectCliProviderAllowlistPanel, {
    projectId: "project-a",
    credentials: [],
    enabledAgentClis: ["claude-code"],
    enabledCredentialIds: ["missing"],
    credentialIdsConfigured: true,
    defaultCredentialId: "missing",
    credentialLoadState,
    onSaved: () => {},
  }));
}

test("项目设置挂载 CLI/Provider 启用面板，支持明确选择默认账号", () => {
  assert.match(settings, /ProjectCliProviderAllowlistPanel/);
  assert.match(panel, /CLI \/ Provider 启用/);
  assert.match(panel, /启用 Agent 类型/);
  assert.match(panel, /启用 Provider 账号/);
  assert.match(panel, /enabled_agent_clis/);
  assert.match(panel, /credentialSelectionPatch/);
  assert.doesNotMatch(panel, /缺省 CLI/);
  assert.doesNotMatch(panel, /缺省 Provider/);
  assert.doesNotMatch(panel, /缺省模型/);
  assert.doesNotMatch(panel, /Fallback 模型顺序/);
  assert.doesNotMatch(panel, /允许目录直通/);
  assert.doesNotMatch(panel, /不设（回退角色）/);
  assert.doesNotMatch(panel, /不设（Hub \/ 角色选择）/);
  assert.doesNotMatch(panel, /defaultAgentCli/);
  assert.doesNotMatch(panel, /allowModelCatalogPassthrough/);
  assert.doesNotMatch(settings, /defaultAgentCli=/);
  assert.doesNotMatch(settings, /allowModelCatalogPassthrough=/);
});

test("Provider 选项按已启用 CLI 过滤，并展示并发摘要", () => {
  assert.match(panel, /filteredByCli/);
  assert.match(panel, /concurrencySummary/);
  assert.match(panel, /账号并发/);
  assert.match(panel, /暂无兼容的 LLM Provider/);
});

test("Provider 白名单面板不展示上游模型目录诊断", () => {
  assert.match(panel, /api\.testCredential/);
  assert.match(panel, /连接失败/);
  assert.doesNotMatch(panel, /model-catalog-health|modelHealthLabel|modelDescriptorsForCredential/);
  assert.doesNotMatch(panel, /modelSummary|credentialCatalogState|credentialModels/);
  assert.doesNotMatch(panel, /模型目录未探测|上游模型目录|上游探测到|连接 \/ 目录失败|刷新中|目录/);
});


test("compatibleAgentClisForCredential 以 credential.agent_cli 独占，不按 Provider 扩", () => {
  assert.match(panel, /isCurrentAgentCli\(credential\.agent_cli\) \? \[credential\.agent_cli\] : \[\]/);
  assert.doesNotMatch(panel, /ADAPTER_CLIS\[credential\.provider\]/);
  assert.doesNotMatch(panel, /only a profile hint/);
  assert.match(panel, /exclusive|独占|唯一来源/);
});


test("ordinary save does not pin dynamic credential scope or erase preferences", () => {
  assert.match(settings, /credentialIdsConfigured=\{settings\?\.credential_ids_configured/);
  assert.match(panel, /credentialSelectionPatch\(\{ credentialSelectionChanged, credIds, defaultCredentialId, selectedDefaultCredentialId, credentialListLoaded \}\)/);
  assert.doesNotMatch(panel, /default_agent_cli: null|default_model_ref: null/);
  assert.deepEqual(credentialSelectionPatch({ credentialSelectionChanged: false, credIds: [], defaultCredentialId: "default", selectedDefaultCredentialId: "default", credentialListLoaded: true }), {});
  assert.match(panel, /未收紧凭据范围/);
});

test("project RoleConfig editor omits identity while global preference supports automatic selection", () => {
  const editor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /!projectId \? \{\s+agent_cli:/);
  assert.match(editor, /form\.agent_cli \|\| null/);
  assert.match(editor, /未指定（由可用凭据决定）/);
  assert.match(editor, /ariaLabel="全局 CLI 偏好" clearable/);
});


test("unavailable explicit credential references can only be removed by an explicit edit", () => {
  assert.match(panel, /unavailableIds = credIds\.filter/);
  assert.match(panel, /current\.filter\(\(id\) => !unavailableIds\.includes\(id\)\)/);
  assert.match(panel, /移除失效引用/);
  assert.match(panel, /账号已删除、停用或不再可访问/);
});

test("loading or failed credential reads never offer to remove default or allowlist references", () => {
  const loading = renderCredentialPanel("loading");
  assert.match(loading, /正在加载 Provider 账号/);
  assert.doesNotMatch(loading, /移除失效引用|清除失效默认引用/);

  const failed = renderCredentialPanel("error");
  assert.match(failed, /Provider 账号加载失败/);
  assert.doesNotMatch(failed, /移除失效引用|清除失效默认引用/);
});

test("a successful empty credential read still offers explicit stale-reference repair", () => {
  const loaded = renderCredentialPanel("loaded");
  assert.match(loaded, /移除失效引用/);
  assert.match(loaded, /清除失效默认引用/);
});

test("credential patches fail closed until the account list loaded successfully", () => {
  assert.deepEqual(credentialSelectionPatch({
    credentialSelectionChanged: true,
    credIds: [],
    defaultCredentialId: "missing",
    selectedDefaultCredentialId: null,
    credentialListLoaded: false,
  }), {});
});


test("clearing an unavailable default alone keeps dynamic credential scope unconfigured", () => {
  const draft = { credentialSelectionChanged: false, credIds: [], defaultCredentialId: "missing", selectedDefaultCredentialId: "missing", credentialListLoaded: true };
  assert.equal(defaultCredentialUnavailable("missing", []), true);
  assert.equal(defaultCredentialUnavailable("missing", [{ id: "missing", status: "disabled" }]), true);
  assert.equal(defaultCredentialUnavailable("missing", [{ id: "missing", status: "active" }]), false);
  assert.equal(defaultCredentialUnavailable(null, []), false);
  assert.deepEqual(credentialSelectionPatch(draft), {}, "ordinary save preserves existing configuration");
  const patch = credentialSelectionPatch({ ...draft, selectedDefaultCredentialId: null });
  assert.deepEqual(patch, { default_credential_id: null, default_model_ref: null, fallback_model_refs: [] });
  assert.equal(Object.hasOwn(patch, "enabled_credential_ids"), false);
  assert.match(panel, /清除失效默认引用/);
  assert.match(panel, /onClick=\{\(\) => setSelectedDefaultCredentialId\(null\)\}/);
});

test("allowlist edits never silently clear or replace a default", () => {
  assert.deepEqual(credentialSelectionPatch({ credentialSelectionChanged: true, credIds: [], defaultCredentialId: "removed", selectedDefaultCredentialId: "removed", credentialListLoaded: true }), {
    enabled_credential_ids: [],
  });
  assert.deepEqual(credentialSelectionPatch({ credentialSelectionChanged: true, credIds: [], defaultCredentialId: "removed", selectedDefaultCredentialId: null, credentialListLoaded: true }), {
    enabled_credential_ids: [], default_credential_id: null, default_model_ref: null, fallback_model_refs: [],
  });
});

const accounts = [
  { id: "a", status: "active", kind: "llm_provider", project_id: null },
  { id: "b", status: "active", kind: "llm_provider", project_id: "project-a" },
  { id: "foreign", status: "active", kind: "llm_provider", project_id: "project-b" },
  { id: "disabled", status: "disabled", kind: "llm_provider", project_id: null },
  { id: "registry", status: "active", kind: "registry", project_id: null },
];

test("default candidates respect active project visibility and explicit empty policy", () => {
  assert.deepEqual(defaultCredentialCandidates(accounts, "project-a", undefined).map((c) => c.id), ["a", "b"]);
  assert.deepEqual(defaultCredentialCandidates(accounts, "project-a", []).map((c) => c.id), []);
  assert.deepEqual(defaultCredentialCandidates(accounts, "project-a", ["b", "foreign", "disabled", "registry"]).map((c) => c.id), ["b"]);
  assert.equal(defaultCredentialUnavailable("a", defaultCredentialCandidates(accounts, "project-a", ["b"])), true);
});

test("multiple eligible accounts require an explicit selection and reset model references on change", () => {
  const draft = { credentialSelectionChanged: false, credIds: ["a", "b"], defaultCredentialId: null, selectedDefaultCredentialId: null, credentialListLoaded: true };
  assert.deepEqual(credentialSelectionPatch(draft), {}, "listing candidates never picks the first account");
  assert.deepEqual(credentialSelectionPatch({ ...draft, selectedDefaultCredentialId: "b" }), {
    default_credential_id: "b", default_model_ref: null, fallback_model_refs: [],
  });
  assert.deepEqual(credentialSelectionPatch({ ...draft, defaultCredentialId: "a", selectedDefaultCredentialId: "b" }), {
    default_credential_id: "b", default_model_ref: null, fallback_model_refs: [],
  });
  assert.deepEqual(credentialSelectionPatch({ ...draft, selectedDefaultCredentialId: "b", credentialListLoaded: false }), {});
});

test("default selector shows invalid state, explicit choice and credentials navigation", () => {
  const loaded = renderCredentialPanel("loaded");
  assert.match(loaded, /项目默认账号/);
  assert.match(loaded, /当前默认账号不可用，请清除或更换/);
  assert.match(loaded, /href="\/settings\/credentials"/);
  assert.match(loaded, /更换或清除默认账号会同时清除项目模型及备用模型引用/);
  assert.match(panel, /if \(unavailableDefault\)/);
  assert.match(panel, /const result = await api\.patchSettings/);
  assert.match(panel, /setSelectedDefaultCredentialId\(result\.default_credential_id\)/);
  assert.match(panel, /onSaved\(result\)/);
  assert.match(settings, /setSettings\(saved\)/);
});


test("user selects and clears a default; PATCH result is reflected and a failed load cannot erase edits", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const original = api.patchSettings;
  const originalProbe = api.testCredential;
  const requests: Array<Parameters<typeof api.patchSettings>[1]> = [];
  const response = { enabled_credential_ids: ["a", "b"], default_credential_id: "a" } as ProjectSettings;
  api.patchSettings = async (_projectId, body) => { requests.push(body); return response; };
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const credentials = accounts.map((account) => ({ ...account, name: account.id, provider: "fixture", agent_cli: "pi" })) as ProviderCredential[];
  credentials.push({ ...credentials[0], id: "other-cli", agent_cli: "dsh" });
  let saved: ProjectSettings | undefined;
  let callbackCount = 0;
  const props = { projectId: "project-a", credentials, enabledAgentClis: ["pi"] as ["pi"], enabledCredentialIds: ["a", "b", "other-cli"],
    credentialIdsConfigured: true, defaultCredentialId: null as string | null,
    credentialLoadState: "loaded" as "loaded" | "error", onSaved: (value?: ProjectSettings) => { saved = value; callbackCount += 1; } };
  const render = () => act(async () => { root.render(createElement(ProjectCliProviderAllowlistPanel, props)); });
  const click = async (button: Element | null | undefined) => {
    assert.ok(button);
    await act(async () => { (button as HTMLElement).click(); });
  };
  const trigger = () => container.querySelector('[aria-label="项目默认账号"]');
  const save = () => Array.from(container.querySelectorAll("button")).find((button) => /^(保存|已保存|保存失败|保存中…)$/.test(button.textContent?.trim() ?? ""));
  try {
    await render();
    assert.equal(requests.length, 0);
    assert.match(trigger()!.textContent!, /未设置默认账号/);
    await click(trigger());
    const options = Array.from(dom.window.document.querySelectorAll('[role="option"]'));
    assert.equal(options.length, 2, "foreign, disabled and non-enabled CLI credentials are not selectable");
    await click(options.find((option) => option.textContent?.includes("b · fixture")));
    await click(save());
    assert.deepEqual(requests[0], { enabled_agent_clis: ["pi"], default_credential_id: "b", default_model_ref: null, fallback_model_refs: [] });
    assert.equal(saved, response);
    assert.match(trigger()!.textContent!, /a · fixture/, "display the actual response, not the submitted draft");
    props.defaultCredentialId = response.default_credential_id;
    await render();
    await click(trigger());
    await click(Array.from(dom.window.document.querySelectorAll("button")).find((button) => button.textContent === "清空"));
    assert.match(trigger()!.textContent!, /未设置默认账号/);
    props.credentialLoadState = "error";
    await render();
    assert.equal(save()!.disabled, true, "failed reloading prevents saving pending credential edits");
    assert.equal(trigger()!.matches(":disabled"), true, "default selector is disabled after a failed read");
    assert.match(trigger()!.textContent!, /保留原默认引用/);
    assert.equal(requests.length, 1);
    props.credentialLoadState = "loaded";
    await render();
    await click(save());
    assert.deepEqual(requests[1], { enabled_agent_clis: ["pi"], default_credential_id: null, default_model_ref: null, fallback_model_refs: [] });

    // A refused write keeps the draft editable; cancel restores the server configuration.
    const choose = async (id: string) => {
      await click(trigger());
      await click(Array.from(dom.window.document.querySelectorAll('[role="option"]')).find((option) => option.textContent?.includes(`${id} · fixture`)));
    };
    await choose("b");
    api.patchSettings = async () => { throw new Error("fixture request interrupted"); };
    await click(save());
    assert.match(trigger()!.textContent!, /b · fixture/);
    assert.match(save()!.textContent!, /保存失败/);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "取消未保存变更"));
    assert.match(trigger()!.textContent!, /a · fixture/);

    // Two clicks in one turn submit once, and a project switch fences the old result.
    let finish!: (value: ProjectSettings) => void;
    let submitted = 0;
    api.patchSettings = () => { submitted += 1; return new Promise((resolve) => { finish = resolve; }); };
    await choose("b");
    const saveButton = save()!;
    await act(async () => { saveButton.click(); saveButton.click(); });
    assert.equal(submitted, 1);
    saved = undefined;
    const callbacksBeforeSwitch = callbackCount;
    props.projectId = "project-b"; // same default/array props: project identity must reset the draft
    await render();
    assert.match(trigger()!.textContent!, /a · fixture/);
    await act(async () => finish({ ...response, default_credential_id: "foreign" }));
    assert.equal(saved, undefined, "old project save cannot refresh the new project");
    assert.match(trigger()!.textContent!, /a · fixture/);

    let finishProbe!: (value: Awaited<ReturnType<typeof api.testCredential>>) => void;
    api.testCredential = () => new Promise((resolve) => { finishProbe = resolve; });
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "测试"));
    props.projectId = "project-a";
    await render();
    await act(async () => finishProbe({ ok: true } as Awaited<ReturnType<typeof api.testCredential>>));
    assert.equal(callbackCount, callbacksBeforeSwitch, "old project probe cannot refresh the new project");

    // Invalid defaults remain visible and require an explicit repair action.
    props.defaultCredentialId = "missing";
    await render();
    assert.match(trigger()!.textContent!, /当前默认账号不可用/);
    assert.equal(save()!.disabled, true);
    await click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "清除失效默认引用"));
    assert.match(trigger()!.textContent!, /未设置默认账号/);
    assert.equal(save()!.disabled, false);

    // Unmount does not cancel a possibly committed write, but must suppress UI callbacks.
    await click(save());
    assert.equal(submitted, 2);
    await act(async () => root.render(null));
    await act(async () => finish(response));
    assert.equal(callbackCount, callbacksBeforeSwitch, "unmounted save cannot call onSaved");

  } finally {
    await act(async () => root.unmount());
    api.patchSettings = original;
    api.testCredential = originalProbe;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("parent settings reload after probes preserves drafts before and during the request", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalPatch = api.patchSettings;
  const originalProbe = api.testCredential;
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const credentials = ["a", "b"].map((id) => ({ id, name: id, kind: "llm_provider", provider: "fixture", agent_cli: "pi", status: "active", project_id: null })) as ProviderCredential[];
  let finishProbe!: (result: Awaited<ReturnType<typeof api.testCredential>>) => void;
  let replaceServer!: (value: ProjectSettings) => void;
  let reloads = 0;
  const requests: Array<Parameters<typeof api.patchSettings>[1]> = [];
  api.testCredential = () => new Promise((resolve) => { finishProbe = resolve; });
  api.patchSettings = async (_id, body) => {
    requests.push(body);
    return { enabled_agent_clis: ["pi"], enabled_credential_ids: ["a", "b"], default_credential_id: body.default_credential_id ?? null } as ProjectSettings;
  };
  function Parent({ initialDefault }: { initialDefault: string | null }) {
    const [server, setServer] = useState({ enabled_agent_clis: ["pi"], enabled_credential_ids: ["a", "b"], default_credential_id: initialDefault } as ProjectSettings);
    replaceServer = setServer;
    return createElement(ProjectCliProviderAllowlistPanel, {
      projectId: "project-a", credentials, credentialLoadState: "loaded", enabledAgentClis: server.enabled_agent_clis as ["pi"],
      enabledCredentialIds: server.enabled_credential_ids, credentialIdsConfigured: true, defaultCredentialId: server.default_credential_id,
      // Model the real parent's reload: successful or failed probes both return
      // equivalent settings with freshly allocated (and possibly reordered) arrays.
      onSaved: (result?: ProjectSettings) => {
        reloads += 1;
        setServer((current) => result ?? { ...current, enabled_agent_clis: [...current.enabled_agent_clis], enabled_credential_ids: [...current.enabled_credential_ids].reverse() });
      },
    });
  }
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === label);
  const trigger = () => container.querySelector('[aria-label="项目默认账号"]')!;
  const click = async (element: Element | undefined | null) => {
    assert.ok(element);
    await act(async () => { (element as HTMLElement).click(); });
  };
  const chooseB = async () => {
    await click(trigger());
    await click(Array.from(dom.window.document.querySelectorAll('[role="option"]')).find((option) => option.textContent?.includes("b · fixture")));
  };
  try {
    for (const initialDefault of [null, "a"]) {
      for (const ok of [true, false]) {
        for (const editDuringProbe of [false, true]) {
          await act(async () => root.render(createElement(Parent, { key: `${initialDefault}-${ok}-${editDuringProbe}`, initialDefault })));
          if (!editDuringProbe) await chooseB();
          await click(button("测试"));
          if (editDuringProbe) await chooseB();
          const beforeReload = reloads;
          await act(async () => finishProbe({ ok, detail: ok ? undefined : "fixture failure" } as Awaited<ReturnType<typeof api.testCredential>>));
          assert.equal(reloads, beforeReload + 1, "probe must exercise the parent settings refresh");
          assert.match(trigger().textContent!, /b · fixture/, "equivalent server arrays must not erase unsaved B");
          await click(button("保存"));
          assert.deepEqual(requests.at(-1), { enabled_agent_clis: ["pi"], default_credential_id: "b", default_model_ref: null, fallback_model_refs: [] });
          assert.match(trigger().textContent!, /b · fixture/, "successful save applies the server result");
        }
      }
    }
    // A no-op save keeps the same configuration key. Its old success state
    // must not hide a later conflict after the user starts a new draft.
    await act(async () => root.render(createElement(Parent, { key: "no-op-save-conflict", initialDefault: null })));
    await click(button("保存"));
    assert.ok(button("已保存"));
    await chooseB();
    assert.ok(button("保存"), "a new edit clears the historical save success state");
    await click(button("测试"));
    await act(async () => replaceServer({ enabled_agent_clis: ["pi"], enabled_credential_ids: ["a", "b"], default_credential_id: "a" } as ProjectSettings));
    await act(async () => finishProbe({ ok: true } as Awaited<ReturnType<typeof api.testCredential>>));
    assert.match(trigger().textContent!, /a · fixture/);
    assert.match(container.textContent!, /项目账号配置已在服务端变更/);

    // A genuine server change is distinct from health refresh and is visible.
    await act(async () => replaceServer({ enabled_agent_clis: ["pi"], enabled_credential_ids: ["a", "b"], default_credential_id: "a" } as ProjectSettings));
    await chooseB();
    await act(async () => replaceServer({ enabled_agent_clis: ["pi"], enabled_credential_ids: ["a", "b"], default_credential_id: null } as ProjectSettings));
    assert.match(trigger().textContent!, /未设置默认账号/);
    assert.match(container.textContent!, /项目账号配置已在服务端变更/);
    await chooseB();
    await click(button("取消未保存变更"));
    assert.match(trigger().textContent!, /未设置默认账号/);
  } finally {
    await act(async () => root.unmount());
    api.patchSettings = originalPatch;
    api.testCredential = originalProbe;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
