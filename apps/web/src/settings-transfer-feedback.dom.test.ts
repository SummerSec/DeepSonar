import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, Fragment, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { api, type EffectiveRules, type GlobalSettings, type PublicUser } from "./api";
import { AuthProvider } from "./auth";
import { SettingsPanel } from "./SettingsPanel";
import { TransferPanel } from "./TransferPanel";
import { UsersPanel } from "./UsersPanel";
import { clearToasts, ToastHost } from "./toast";

async function fixture() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const original = { authStatus: api.authStatus, globalSettings: api.globalSettings,
    patchGlobalSettings: api.patchGlobalSettings, listPlatformExports: api.listPlatformExports,
    createPlatformExport: api.createPlatformExport, listUsers: api.listUsers,
    updateUser: api.updateUser, resetUserPassword: api.resetUserPassword,
    agentRoles: api.agentRoles, globalRoleConfigs: api.globalRoleConfigs,
    skillSources: api.skillSources, deleteRole: api.deleteRole };
  api.authStatus = async () => ({ auth_required: false, has_users: false, bootstrap_available: false,
    default_admin_credentials_active: false, session_ttl_days: 1 });
  api.listPlatformExports = async () => [];
  api.globalRoleConfigs = async () => [];
  api.skillSources = async () => [];
  const settings: GlobalSettings = {
    rules: {}, effective_rules: { allowEgress: true, hubEnabled: true,
      maxGlobalJobs: null, maxJobsPerProject: null, maxConcurrentProvisioning: null,
      maxConcurrentByAgentCli: {}, maxConcurrentByProvider: {} } as EffectiveRules,
    finding_protocol: null,
    effective_finding_protocol: { mode: "fixed", default_profile: "security", allowed_profiles: ["security"],
      scoring: { default_standard: "CVSS", default_version: "3.1", accepted_versions: ["3.1"], require_scoring_for_profiles: [] },
      display_name: "Security", source: "global" },
    active_by_agent_cli: {}, active_by_provider: {},
  };
  api.globalSettings = async () => settings;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const render = (node: ReactNode) => act(async () => { root.render(h(Fragment, null, node, h(ToastHost))); });
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll("button")).find(element => element.textContent?.trim() === label);
    assert.ok(found, `button ${label} exists`);
    return found;
  };
  const click = (element: HTMLElement) => act(async () => { element.click(); });
  const alerts = () => container.querySelectorAll<HTMLElement>('.app-feedback[role="alert"]');
  const toasts = () => dom.window.document.querySelectorAll<HTMLElement>(".app-toast");
  const advance = (ms: number) => act(async () => { mock.timers.tick(ms); });
  const close = async () => {
    await act(async () => root.unmount());
    clearToasts();
    mock.timers.reset();
    Object.assign(api, original);
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  return { dom, container, settings, render, button, click, alerts, toasts, advance, close };
}

test("platform export rejects an English API reason as a persistent error and supports dismiss and recovery", async () => {
  const f = await fixture();
  const reason = "Permission denied by export policy. ".repeat(12).trim();
  let rejectExport = true;
  api.createPlatformExport = async () => {
    if (rejectExport) throw new Error(reason);
    return { id: "fixture-export", project_id: "", preset: "platform_full", modules_json: [],
      status: "pending", created_at: "2026-11-21T00:00:00Z" };
  };
  try {
    await f.render(h(TransferPanel, { projectId: null, scope: "platform" }));
    await f.click(f.button("导出平台配置"));
    assert.equal(f.alerts().length, 1);
    assert.ok(f.alerts()[0].classList.contains("is-error"));
    assert.ok(f.alerts()[0].textContent?.includes(reason), "the complete long reason is readable");
    assert.equal(f.toasts().length, 1, "one operation creates one toast");
    assert.ok(f.toasts()[0].classList.contains("is-error"));
    await f.advance(60000);
    assert.ok(f.alerts()[0].textContent?.includes(reason), "errors survive the former local timeout");
    assert.equal(f.toasts().length, 1);
    await f.click(f.alerts()[0].querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')!);
    assert.equal(f.alerts().length, 0);
    assert.equal(f.toasts().length, 0, "closing inline feedback also clears its toast");

    await f.click(f.button("导出平台配置"));
    assert.equal(f.alerts().length, 1);
    rejectExport = false;
    await f.click(f.button("导出平台配置"));
    assert.equal(f.alerts().length, 0);
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /Permission denied/);
    assert.match(f.container.querySelector('.app-feedback[role="status"]')!.textContent!, /导出已开始/);
    assert.equal(f.toasts().length, 1, "success replaces the owned failure toast");
    await f.advance(3201);
    assert.equal(f.container.querySelectorAll(".app-feedback").length, 0);
    assert.equal(f.toasts().length, 0);
  } finally { await f.close(); }
});

test("SettingsPanel saves through its real API and keeps failures outside the scroll and tab strips until recovery", async () => {
  const f = await fixture();
  let rejectSave = true;
  let calls = 0;
  api.patchGlobalSettings = async () => {
    calls += 1;
    if (rejectSave) throw new Error("database write denied");
    return f.settings;
  };
  try {
    await f.render(h(MemoryRouter, null, h(AuthProvider, null,
      h(SettingsPanel, { projectId: null, globalSection: "platform", variant: "page" }))));
    await f.click(f.button("保存规则"));
    assert.equal(calls, 1);
    assert.equal(f.alerts().length, 1);
    const failure = f.alerts()[0];
    assert.match(failure.textContent!, /保存失败.*database write denied/);
    assert.equal(failure.closest(".settings-content"), null, "feedback stays outside the scrolling settings body");
    assert.equal(failure.closest(".settings-tabs"), null, "feedback is not clipped by horizontal tabs");
    await f.advance(60000);
    assert.match(f.alerts()[0].textContent!, /database write denied/);
    rejectSave = false;
    await f.click(f.button("保存失败"));
    assert.equal(calls, 2);
    assert.equal(f.alerts().length, 0);
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /database write denied/);
    assert.match(f.container.querySelector('.app-feedback[role="status"]')!.textContent!, /规则已保存/);
    await f.advance(3201);
    assert.equal(f.container.querySelectorAll(".app-feedback").length, 0);
    assert.equal(f.toasts().length, 0);
  } finally { await f.close(); }
});

test("SettingsPanel surfaces platform loading failures in the viewport and clears them after a successful retry", async () => {
  const f = await fixture();
  let rejectLoad = true;
  api.globalSettings = async () => {
    if (rejectLoad) throw new Error("service unavailable");
    return f.settings;
  };
  try {
    await f.render(h(MemoryRouter, null, h(AuthProvider, null,
      h(SettingsPanel, { projectId: null, globalSection: "platform", variant: "page" }))));
    assert.match(f.alerts()[0].textContent!, /平台调度设置加载失败.*service unavailable/);
    assert.equal(f.alerts()[0].closest(".settings-content"), null);
    await f.advance(60000);
    assert.equal(f.alerts().length, 1);
    rejectLoad = false;
    await f.click(f.button("重试"));
    assert.equal(f.alerts().length, 0);
    assert.equal(f.toasts().length, 0);
    assert.ok(f.button("保存规则"));
  } finally { await f.close(); }
});

test("user status and password failures share dismissible feedback and successful operations replace the old error", async () => {
  const f = await fixture();
  const user: PublicUser = { id: "fixture-user", username: "fixture", display_name: "Fixture", role: "operator",
    status: "active", created_at: "2026-11-21T00:00:00Z", last_login_at: null };
  let rejectUpdate = true;
  api.listUsers = async () => [user];
  api.updateUser = async (_id, body) => {
    if (rejectUpdate) throw new Error("access denied");
    Object.assign(user, body);
    return user;
  };
  api.resetUserPassword = async () => { throw new Error("password policy rejected"); };
  f.dom.window.prompt = () => "fixture-password";
  try {
    await f.render(h(UsersPanel));
    await f.click(f.button("禁用"));
    assert.match(f.alerts()[0].textContent!, /access denied/);
    await f.click(f.button("重置密码"));
    assert.match(f.alerts()[0].textContent!, /password policy rejected/);
    assert.equal(f.toasts().length, 1);
    rejectUpdate = false;
    await f.click(f.button("禁用"));
    assert.equal(f.alerts().length, 0);
    assert.doesNotMatch(f.dom.window.document.body.textContent!, /password policy rejected|access denied/);
    assert.match(f.container.querySelector('.app-feedback[role="status"]')!.textContent!, /用户已禁用/);
    assert.ok(f.button("启用"));
  } finally { await f.close(); }
});

test("a rejected role deletion retains the form and cannot turn into a success notice", async () => {
  const f = await fixture();
  api.agentRoles = async () => [{ id: "fixture-role", name: "fixture-role", title: "Fixture role", description: "",
    builtin: false, kind: "role", ui_color: null }];
  api.deleteRole = async () => { throw new Error("role is in use"); };
  try {
    await f.render(h(MemoryRouter, null, h(AuthProvider, null,
      h(SettingsPanel, { projectId: null, globalSection: "agents", variant: "page" }))));
    const edit = f.container.querySelector<HTMLButtonElement>('button[title="编辑角色职责"]');
    assert.ok(edit);
    await f.click(edit);
    await f.click(f.button("删除"));
    assert.equal(f.alerts().length, 1);
    assert.match(f.alerts()[0].textContent!, /删除失败.*role is in use/);
    assert.equal(f.container.querySelectorAll('.app-feedback[role="status"]').length, 0);
    assert.ok(f.button("删除"), "the rejected deletion leaves the editable role intact");
    assert.equal(f.toasts().length, 1);
    assert.ok(f.toasts()[0].classList.contains("is-error"));
  } finally { await f.close(); }
});
