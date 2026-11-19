import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { act } from "react";
import { JSDOM } from "jsdom";
import { api, type JobDetail } from "./api";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";

test("JobDetail recovery uses current actions and permission, with collapsed diagnostics", async context => {
  const hooks = registerHooks({ load(url, options, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return nextLoad(url, options);
  } });
  context.after(() => hooks.deregister());
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const { JobDetailPanel } = await import("./JobDetailPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const original = { ...api };
  let scopes = ["jobs:read", "jobs:control"], authError = false, jobError = false, calls = 0;
  const detail: JobDetail = {
    job: { id: "ended", project_id: "project", canvas_id: "canvas", type: "audit", status: "timeout", error: "超时（Reaper 判定）",
      started_at: null, finished_at: null, payload_json: {}, agent_snapshot_json: {},
      execution_state: { authority: "scheduler", status: "timeout", allowed_actions: ["inspect_state"], blocker: "execution_inactive" } },
    events: [], findings: [], attempts: [], effects: [], broadcasts: [], usage: [], missing_modules: [],
    dispatched_prompt: null, context_diagnostics: null, human_request: null,
  };
  Object.assign(api, {
    credentials: async () => [], authMe: async () => {
      if (authError) throw new Error("403");
      return { authenticated: true, auth_required: true, actor: { role: "operator", scopes } };
    },
    job: async () => { if (jobError) throw new Error("读取失败"); return detail; },
    jobEvidence: async () => { throw new Error("404"); }, jobSession: async () => { throw new Error("404"); },
    jobStreamPage: async () => ({ items: [], has_more: false, next_cursor: null }),
    jobEventsPage: async () => ({ items: [], has_more: false, next_cursor: null }),
    resumeJob: async () => { calls++; return {}; }, rerunJobCurrent: async () => { calls++; return {}; },
  });
  const mount = async () => {
    await act(async () => root.render(null));
    await act(async () => root.render(<ConfirmDialogProvider><JobDetailPanel jobId="ended" onClose={() => {}} /></ConfirmDialogProvider>));
  };
  const recoveryButtons = () => [...dom.window.document.querySelectorAll("button")]
    .filter(button => /重新执行|快照重跑|配置重跑/.test(button.textContent ?? ""));
  try {
    await context.test("settled timeout has one conclusion and no invented recovery action", async () => {
      await mount();
      const panel = dom.window.document.querySelector('[aria-label="修复反馈"]')!;
      assert.match(panel.firstElementChild!.textContent!, /因超时结束/);
      assert.equal(panel.querySelector("details")?.open, false);
      assert.equal(panel.querySelector("summary")?.textContent, "技术诊断（维护者）");
      assert.doesNotMatch(panel.textContent!, /未从当前错误解析|没有结构化期望/);
      assert.equal(recoveryButtons().length, 0);
      assert.equal(dom.window.document.querySelector('[aria-label="待办动作"]'), null);
    });
    await context.test("an allowed recovery remains available even without a diagnostic signal", async () => {
      detail.job.execution_state!.allowed_actions = ["request_recovery"];
      await mount();
      assert.ok(recoveryButtons().length > 0);
      const button = recoveryButtons().find(item => item.textContent === "使用原配置重新执行")!;
      await act(async () => button.click());
      assert.equal(calls, 0);
      const confirm = [...dom.window.document.querySelectorAll('[role="alertdialog"] button')].find(item => item.textContent === "旧快照重跑") as HTMLButtonElement;
      assert.ok(confirm);
      await act(async () => confirm.click());
      assert.equal(calls, 1);
    });
    await context.test("viewer and permission read failures cannot offer recovery", async () => {
      scopes = ["jobs:read"]; await mount(); assert.equal(recoveryButtons().length, 0);
      authError = true; await mount(); assert.equal(recoveryButtons().length, 0);
      authError = false;
    });
    await context.test("unknown effects and missing or mismatched state do not grant retry", async () => {
      scopes = ["jobs:control"];
      detail.effects = [{ effect_id: "run", effect_kind: "agent_run", status: "unknown" }] as JobDetail["effects"];
      detail.job.execution_state!.allowed_actions = ["reconcile_effects"];
      detail.job.execution_state!.blocker = "effects_require_reconciliation";
      await mount(); assert.equal(recoveryButtons().length, 0);
      assert.match(dom.window.document.querySelector('[aria-label="修复反馈"]')!.firstElementChild!.textContent!, /未核实/);
      detail.job.execution_state!.status = "running";
      detail.job.execution_state!.allowed_actions = ["request_recovery"];
      await mount(); assert.equal(recoveryButtons().length, 0);
      detail.job.execution_state = null;
      await mount(); assert.equal(recoveryButtons().length, 0);
      jobError = true; await mount(); assert.equal(recoveryButtons().length, 0);
      assert.match(dom.window.document.body.textContent!, /读取失败/);
    });
  } finally {
    await act(async () => root.unmount()); Object.assign(api, original); dom.window.close();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
