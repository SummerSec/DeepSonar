import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { act } from "react";
import { JSDOM } from "jsdom";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, type FindingSummary, type PageEnvelope } from "./api";
import { AuthProvider, RequireAuth } from "./auth";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";

async function setup(context: TestContext, paginated = false) {
  // Keep the actual task page and its requests. Graph/terminal/ledger rendering
  // belongs to separate browser flows and does not participate in these queries.
  const hooks = registerHooks({ load(url, options, nextLoad) {
    for (const name of ["CanvasView", "TerminalPanel", "UsageLedgerBoard"]) {
      if (url.endsWith(`/${name}.tsx`)) return { format: "module", source: `export function ${name}() { return null; }`, shortCircuit: true };
    }
    if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    return nextLoad(url, options);
  } });
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  dom.window.Element.prototype.scrollIntoView = () => {};
  const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, localStorage: dom.window.localStorage,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const { TaskCanvasPage } = await import("./pages/TaskCanvasPage");
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const original = { ...api };
  const findingCalls: Array<Parameters<typeof api.findingsPage>[0]> = [];
  let jobCalls = 0;
  let failFindings = false;
  let failJobs = false;
  const finding = (id: string): FindingSummary => ({
    id, title: id, project_id: "project-a", job_id: "job-a", node_id: null,
    fingerprint: id, severity: "high", profile: "security.vulnerability", category: null,
    tags_json: [], evidence_refs_json: [], scoring_json: {}, location: null, summary: null,
    verify_status: "pending", disposition: "open", created_at: "2026-01-01T00:00:00Z",
  });
  Object.assign(api, {
    authStatus: async () => ({ auth_required: false }),
    findingsPage: async (options: Parameters<typeof api.findingsPage>[0]): Promise<PageEnvelope<FindingSummary>> => {
      findingCalls.push(options);
      if (failFindings) throw new Error("findings unavailable");
      const more = paginated && !options?.after;
      return { items: [finding(options?.after ? "second-page-finding" : "first-page-finding")],
        after: options?.after ?? null, next_cursor: more ? "page-two" : null, has_more: more, watermark: "now", live: false };
    },
    jobsPage: async () => {
      jobCalls++;
      if (failJobs) throw new Error("jobs unavailable");
      return { items: [{ id: "job-a", project_id: "project-a", canvas_id: "task-a", type: "analyze",
        status: jobCalls > 1 ? "succeeded" : "pending", created_at: "2026-01-01T00:00:00Z", payload_json: {}, agent_snapshot_json: {} }],
      after: null, has_more: false, next_cursor: null };
    },
    factsPage: async () => ({ items: [], has_more: false, next_cursor: null }),
    projectReports: async () => ({ tasks: [] }),
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const router = createMemoryRouter([{ path: "/projects/:projectId/tasks/:canvasId", element:
    <AuthProvider><RequireAuth><ConfirmDialogProvider><TaskCanvasPage /></ConfirmDialogProvider></RequireAuth></AuthProvider>,
  }], { initialEntries: ["/projects/project-a/tasks/task-a?tab=findings"] });
  const render = async () => { await act(async () => root.render(<RouterProvider router={router} />)); };
  const click = async (label: string) => {
    const button = Array.from(dom.window.document.querySelectorAll("button")).find(item => item.textContent?.includes(label));
    assert.ok(button, `${label} exists`);
    await act(async () => button.click());
  };
  context.after(async () => {
    await act(async () => root.unmount());
    router.dispose();
    Object.assign(api, original);
    dom.window.close();
    context.mock.timers.reset();
    hooks.deregister();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  return { dom, router, render, click, findingCalls, jobs: () => jobCalls,
    failFindings: (value: boolean) => { failFindings = value; },
    failJobs: (value: boolean) => { failJobs = value; },
    tick: async () => { await act(async () => context.mock.timers.tick(5000)); },
  };
}

test("task page has one live default finding query and refreshes Jobs when findings fail", async context => {
  const env = await setup(context);
  await env.render();
  // One initial relationship-index read plus one live first-page owner.
  assert.equal(env.findingCalls.length, 2);
  assert.equal(env.jobs(), 1);
  await env.tick();
  assert.equal(env.findingCalls.length, 3, "one periodic request, not two");
  env.failFindings(true);
  await env.tick();
  assert.equal(env.jobs(), 3);
  assert.match(env.dom.window.document.body.textContent!, /findings unavailable/);
  await env.click("任务运行");
  assert.match(env.dom.window.document.querySelector("tbody")!.textContent!, /已完成/);
  env.failFindings(false);
  env.failJobs(true);
  await env.click("任务发现");
  await env.tick();
  assert.match(env.dom.window.document.querySelector("tbody")!.textContent!, /first-page-finding/);
});

test("task finding pagination preserves browser back and reuses the default first page", async context => {
  const env = await setup(context, true);
  await env.render();
  const firstPageCalls = env.findingCalls.filter(options => !options?.after).length;
  assert.equal(firstPageCalls, 2);
  await env.click("下一页发现");
  assert.equal(env.router.state.location.search.includes("cursor=page-two"), true);
  assert.match(env.dom.window.document.querySelector("tbody")!.textContent!, /second-page-finding/);
  const beforeBack = env.findingCalls.length;
  await act(async () => { await env.router.navigate(-1); });
  assert.equal(env.router.state.location.search.includes("cursor="), false);
  assert.match(env.dom.window.document.querySelector("tbody")!.textContent!, /first-page-finding/);
  assert.equal(env.findingCalls.length, beforeBack, "default view reuses its live query");
});
