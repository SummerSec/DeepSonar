import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { act } from "react";
import { JSDOM } from "jsdom";
import { api, type JobDetail } from "./api";
import { ApiRequestError } from "./login-error";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";

type Submission = Parameters<typeof api.createHistoricalContinuation>[1];

test("JobDetail historical continuation respects permission, immutable retries and editable unsaved rejection", async context => {
  // Keep the real detail components. Stylesheets have no behavior in JSDOM.
  const hooks = registerHooks({ load(url, options, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return nextLoad(url, options);
  } });
  context.after(() => hooks.deregister());
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  // Import React DOM after installing the browser so React registers input events normally.
  const { createRoot } = await import("react-dom/client");
  const { JobDetailPanel } = await import("./JobDetailPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const original = { ...api };
  let scopes = ["jobs:read", "jobs:control"];
  let jobId = "history-source";
  const calls: Array<{ jobId: string; payload: Submission }> = [];
  let reject: Error | null = null;
  const detail: JobDetail = {
    job: { id: jobId, project_id: "project", canvas_id: "canvas", type: "audit", status: "failed", error: null,
      started_at: null, finished_at: null, payload_json: {}, agent_snapshot_json: {} },
    human_request: { event_id: "request", attempt_id: "source-attempt", created_at: "2026-11-19T00:00:00Z", current: false,
      payload: { reason: "Confirm the original authorization" } },
    human_continuation: { id: "11111111-1111-4111-8111-111111111111", revision: 4, status: "closed", checkpoint_status: "ready",
      checkpoint_error_code: null, resume_error_code: null, overdue_at: null, answered_at: null, resumed_at: null,
      mode: "structured", remaining_execution_ms: 30000 },
    events: [], findings: [], attempts: [], effects: [], broadcasts: [], usage: [], missing_modules: [],
    dispatched_prompt: null, context_diagnostics: null,
  };
  Object.assign(api, {
    credentials: async () => [], authMe: async () => ({ actor: { scopes } }),
    job: async () => ({ ...detail, job: { ...detail.job, id: jobId } }),
    jobEvidence: async () => { throw new Error("404"); }, jobSession: async () => { throw new Error("404"); },
    jobStreamPage: async () => ({ items: [], has_more: false, next_cursor: null }),
    jobEventsPage: async () => ({ items: [], has_more: false, next_cursor: null }),
    createHistoricalContinuation: async (source: string, payload: Submission) => {
      calls.push({ jobId: source, payload: structuredClone(payload) });
      if (reject) throw reject;
      return { job_id: "new-history-job", source_job_id: source, execution_state: "queued" };
    },
  });
  const mount = async () => {
    await act(async () => root.render(null));
    jobId += "-next";
    await act(async () => root.render(<ConfirmDialogProvider><JobDetailPanel jobId={jobId} onClose={() => {}} /></ConfirmDialogProvider>));
    assert.ok(dom.window.document.querySelector('[role="dialog"][aria-label="运行详情"]'));
  };
  const type = async (body: string) => {
    const textarea = dom.window.document.querySelector("textarea")!;
    assert.ok(textarea); assert.equal(textarea.disabled, false);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(textarea, body); textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  };
  const submit = async () => {
    const form = dom.window.document.querySelector("form")!;
    assert.ok(form);
    await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  };
  const rejection = (status: number, replyState?: string) => new ApiRequestError({ method: "POST", path: "/jobs/source/continuations",
    status, errorCode: "CONTINUATION_BLOCKED", taskContractFeedback: { reply_state: replyState } as ApiRequestError["taskContractFeedback"] });
  try {
    await context.test("ordinary operator submits from failed JobDetail and follows the new Job", async () => {
      await mount(); await type("Original reference"); await submit();
      assert.equal(calls.at(-1)?.jobId, jobId);
      assert.equal(calls.at(-1)?.payload.expected_revision, 4);
      assert.equal(calls.at(-1)?.payload.reply?.body, "Original reference");
      assert.equal(dom.window.document.querySelector('a[href="/jobs?job=new-history-job"]')?.textContent, "查看续做运行");
      assert.equal(dom.window.document.querySelector("textarea"), null);
    });
    for (const status of [400, 409]) await context.test(`explicit unsaved ${status} permits correcting the draft and a new proposal`, async () => {
      reject = rejection(status, status === 409 ? "reply_not_saved" : undefined);
      await mount(); await type("First reference"); await submit();
      const first = calls.at(-1)!.payload;
      assert.ok(dom.window.document.querySelector('[role="alert"]'));
      await type("Corrected reference"); reject = null; await submit();
      assert.equal(calls.at(-1)?.payload.reply?.body, "Corrected reference");
      assert.notEqual(calls.at(-1)?.payload.mutation_id, first.mutation_id);
      assert.notEqual(calls.at(-1)?.payload.reply?.message_id, first.reply?.message_id);
    });
    for (const state of ["reply_saved", "unknown"] as const) await context.test(`${state} retries the exact immutable submission`, async () => {
      reject = state === "reply_saved" ? rejection(409, state) : new Error("Response lost");
      await mount(); await type("Immutable reference"); await submit();
      const first = calls.at(-1)!;
      if (state === "reply_saved") {
        assert.equal(dom.window.document.querySelector("textarea"), null);
        assert.match(dom.window.document.body.textContent!, /回复已保存/);
      } else {
        assert.equal(dom.window.document.querySelector("textarea")?.disabled, true);
        assert.match(dom.window.document.body.textContent!, /用原内容重试/);
      }
      reject = null; await submit(); assert.deepEqual(calls.at(-1), first);
    });
    await context.test("reopening a saved reply submits only its reference", async () => {
      detail.human_continuation = { ...detail.human_continuation!, reply_message_id: "22222222-2222-4222-8222-222222222222" };
      await mount(); assert.equal(dom.window.document.querySelector("textarea"), null); await submit();
      assert.equal(calls.at(-1)?.payload.saved_reply_message_id, detail.human_continuation.reply_message_id);
      assert.equal(calls.at(-1)?.payload.reply, undefined);
    });
    await context.test("viewer reads the historical request without a continuation action", async () => {
      scopes = ["jobs:read"]; const count = calls.length; await mount();
      assert.match(dom.window.document.body.textContent!, /历史人工请求/);
      assert.equal(dom.window.document.querySelector("form"), null);
      assert.doesNotMatch(dom.window.document.body.textContent!, /基于保存进度继续/);
      assert.equal(calls.length, count);
    });
  } finally {
    await act(async () => root.unmount()); Object.assign(api, original); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
