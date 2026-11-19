import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { api, type EffectiveRules, type GlobalSettings } from "./api";
import { GlobalJobQuotaSection } from "./components/GlobalJobQuotaSection";

test("global quota DOM preserves stored drafts, validates input and saves explicit null without freezing env caps", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const original = api.patchGlobalSettings;
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
  } finally {
    await act(async () => root.unmount());
    api.patchGlobalSettings = original;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
