import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { api, type EffectiveRules, type GlobalSettings, type ProjectSettings } from "./api";
import { GlobalJobQuotaSection } from "./components/GlobalJobQuotaSection";
import { ProjectJobQuotaSection } from "./components/ProjectJobQuotaSection";
import { SettingsPanel } from "./SettingsPanel";
import { AuthProvider } from "./auth";
import { MemoryRouter } from "react-router-dom";

test("global quota DOM preserves stored drafts, validates input and saves explicit null without freezing env caps", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const original = api.patchGlobalSettings;
  const originalProjectPatch = api.patchSettings;
  const originalAuthStatus = api.authStatus;
  const originalGlobalSettings = api.globalSettings;
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let stored: Record<string, unknown> = { maxGlobalJobs: 4 };
  let rules = { maxGlobalJobs: 4, maxJobsPerProject: 3, maxConcurrentProvisioning: null } as EffectiveRules;
  const writes: Record<string, unknown>[] = [];
  const render = () => act(async () => { root.render(createElement(GlobalJobQuotaSection, {
    storedRules: stored, rules, activeJobs: 2, onFlash: () => {},
    onSaved: saved => { stored = saved.rules; rules = saved.effective_rules; },
  })); });
  api.patchGlobalSettings = async body => {
    writes.push(body.rules!);
    stored = { ...stored, ...body.rules };
    rules = { ...rules, ...body.rules } as EffectiveRules;
    return { rules: stored, effective_rules: rules } as GlobalSettings;
  };
  const input = () => container.querySelector<HTMLInputElement>("#quota-maxGlobalJobs")!;
  const save = () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "保存全局调度配额")!;
  const fill = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await render();
    assert.equal(input().value, "4");
    assert.equal(container.querySelector<HTMLInputElement>("#quota-maxJobsPerProject")!.value, "", "env effective cap is not a stored draft");
    assert.ok(save().disabled);
    for (const value of ["0", "-1", "1.5", "1001"]) {
      await fill(value);
      assert.ok(save().disabled);
      assert.ok(container.querySelector('[role="alert"]'));
    }
    await fill("7");
    stored = { ...stored, maxGlobalJobs: 5 };
    rules = { ...rules, maxGlobalJobs: 5 };
    await render();
    assert.equal(input().value, "7", "refresh preserves unsaved draft");
    assert.match(container.textContent!, /当前生效 5/);
    await fill("");
    await act(async () => { save().click(); });
    assert.deepEqual(writes, [{ maxGlobalJobs: null }]);
    await render();
    assert.match(container.textContent!, /当前生效 不限/);
    assert.equal(input().value, "");
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(button => button.textContent === "恢复每项目活跃 Job 上限不限")!.click();
    });
    await act(async () => { save().click(); });
    assert.deepEqual(writes[1], { maxJobsPerProject: null });
    const projectWrites: unknown[] = [];
    let project = { rules: { maxConcurrentJobs: 3 }, effective_rules: {
      ...rules, maxJobsPerProject: null, maxConcurrentJobs: 3, maxConcurrentJobsSource: "project",
    }, active_jobs: 2 } as ProjectSettings;
    api.patchSettings = async (_id, body) => {
      projectWrites.push(body.rules);
      const value = body.rules?.maxConcurrentJobs;
      project = { ...project, rules: body.rules!, effective_rules: {
        ...project.effective_rules, maxConcurrentJobs: value as number | null,
        maxConcurrentJobsSource: value === null ? "global" : "project",
      } };
      return project;
    };
    const renderProject = () => act(async () => root.render(createElement(ProjectJobQuotaSection, {
      projectId: "fixture", settings: project, rules: project.effective_rules,
      storedQuota: project.rules.maxConcurrentJobs, onFlash: () => {}, onSettingsSaved: saved => { project = saved; },
    })));
    await renderProject();
    assert.equal(container.querySelector<HTMLInputElement>("input")!.placeholder, "继承全局 不限");
    const projectFill = async (value: string) => act(async () => {
      const element = container.querySelector<HTMLInputElement>("input")!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await projectFill("");
    await act(async () => { container.querySelector<HTMLButtonElement>("button.bg-acc-500")!.click(); });
    await renderProject();
    assert.deepEqual(projectWrites[0], { maxConcurrentJobs: null });
    assert.match(container.textContent!, /2 \/ 不限/);
    await projectFill("0");
    await act(async () => { container.querySelector<HTMLButtonElement>("button.bg-acc-500")!.click(); });
    assert.deepEqual(projectWrites[1], { maxConcurrentJobs: 0 });

    // Exercise the real parent callback: quota save must not replace the
    // unrelated rule draft with the server's unchanged effective snapshot.
    rules = { ...rules, allowEgress: true, maxConcurrentByAgentCli: {}, maxConcurrentByProvider: {} };
    stored = { maxGlobalJobs: 4 };
    api.authStatus = async () => ({ auth_required: false, has_users: false, bootstrap_available: false,
      default_admin_credentials_active: false, session_ttl_days: 1 });
    api.globalSettings = async () => ({ rules: stored, effective_rules: rules, finding_protocol: null,
      effective_finding_protocol: null, active_by_agent_cli: {}, active_by_provider: {} } as unknown as GlobalSettings);
    await act(async () => root.render(createElement(MemoryRouter, null,
      createElement(AuthProvider, null, createElement(SettingsPanel, { projectId: null, globalSection: "platform" })))));
    const outbound = () => Array.from(container.querySelectorAll("label")).find(label =>
      label.textContent?.includes("允许 Worker 访问外部网络"))!.querySelector<HTMLInputElement>("input")!;
    await act(async () => { outbound().click(); });
    assert.equal(outbound().checked, false);
    const cliSection = Array.from(container.querySelectorAll("section")).find(section =>
      section.textContent?.includes("Agent CLI 全局并发") && section.querySelector('input[type="number"]'))!;
    const cliInput = cliSection.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(cliInput, "2");
      cliInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await fill("");
    await act(async () => { save().click(); });
    assert.equal(outbound().checked, false, "quota response preserves unsaved outbound draft");
    assert.equal(cliInput.value, "2", "quota response preserves unsaved CLI draft");
    const quotaWrite = writes.at(-1)!;
    assert.deepEqual(quotaWrite, { maxGlobalJobs: null });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "保存规则")!.click();
    });
    assert.equal(writes.at(-1)!.allowEgress, false);
    assert.deepEqual(writes.at(-1)!.maxConcurrentByAgentCli, { "claude-code": 2 });
    assert.equal(Object.hasOwn(writes.at(-1)!, "maxGlobalJobs"), false, "main save does not persist quota effective values");
  } finally {
    await act(async () => root.unmount());
    api.patchGlobalSettings = original;
    api.patchSettings = originalProjectPatch;
    api.authStatus = originalAuthStatus;
    api.globalSettings = originalGlobalSettings;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
