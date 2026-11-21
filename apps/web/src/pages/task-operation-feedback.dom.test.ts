import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { api, type CanvasSummary } from "../api";
import { AuthProvider } from "../auth";
import { ConfirmDialogProvider } from "../components/ConfirmDialog";
import { clearToasts, ToastHost } from "../toast";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const canvas: CanvasSummary = {
  id: "task-a", title: "反馈回归任务", target_json: {}, created_at: "2026-11-21T00:00:00Z",
  status: "active", archived_at: null, started_at: null, ended_at: null,
  job_count: 1, active_count: 1, execution_active_count: 1, pending_count: 0,
  execution_state: "running", root_status: null, report_status: null,
  finding_count: 0, confirmed_count: 0, last_job_id: null,
  last_job_status: null, last_job_priority: null, last_job_at: null,
};

async function setup(context: TestContext) {
  const dom = new JSDOM("<!doctype html><div id='page'></div><div id='toasts'></div>", { url: "http://127.0.0.1", pretendToBeVisual: true });
  const replacements = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let nextTimer = 0;
  context.mock.method(globalThis, "setInterval", () => ++nextTimer);
  context.mock.method(globalThis, "clearInterval", () => {});
  context.mock.method(dom.window, "setInterval", () => ++nextTimer);
  context.mock.method(dom.window, "clearInterval", () => {});
  context.mock.method(api, "projects", async () => []);
  // As in tasks-page-list.dom.test.ts, keep the independent project queue inactive.
  context.mock.method(api, "authStatus", async () => ({ auth_required: true, has_users: true, bootstrap_available: false, default_admin_credentials_active: false, session_ttl_days: 1 }));
  context.mock.method(api, "canvases", async () => [{ ...canvas }]);
  const { createRoot } = await import("react-dom/client");
  const { TasksPage } = await import("./TasksPage");
  const container = dom.window.document.getElementById("page")!;
  const root = createRoot(container);
  const toastRoot = createRoot(dom.window.document.getElementById("toasts")!);
  let mounted = true;
  let navigate!: ReturnType<typeof useNavigate>;
  function Page() {
    navigate = useNavigate();
    return createElement(TasksPage);
  }
  const unmountPage = () => {
    if (!mounted) return;
    act(() => root.unmount());
    mounted = false;
  };
  context.after(() => {
    unmountPage();
    act(() => toastRoot.unmount());
    clearToasts();
    context.mock.restoreAll();
    context.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  await act(async () => {
    toastRoot.render(createElement(ToastHost));
    root.render(createElement(MemoryRouter, { initialEntries: ["/projects/A/tasks"] },
      createElement(AuthProvider, null, createElement(ConfirmDialogProvider, null,
        createElement(Routes, null, createElement(Route, { path: "/projects/:projectId/tasks", element: createElement(Page) }))))));
  });
  const click = async (label: string, within: ParentNode = container) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
    assert.ok(button, `${label} button exists`);
    await act(async () => button.click());
  };
  const archive = async () => {
    await click("归档");
    const dialog = dom.window.document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    await click("归档任务", dialog);
  };
  return {
    container, dom, click, archive, unmountPage,
    tick: async (ms: number) => { await act(async () => context.mock.timers.tick(ms)); },
    switchProject: () => act(async () => navigate("/projects/B/tasks")),
    toasts: () => [...dom.window.document.querySelectorAll(".app-toast")],
  };
}

for (const operation of ["archive", "pause"] as const) {
  test(`task ${operation} API rejection stays an alert until a new success replaces it`, async context => {
    const env = await setup(context);
    const error = operation === "archive" ? "archive request denied" : "pause request denied";
    context.mock.method(api, "archiveTask", async () => { throw new Error(error); });
    context.mock.method(api, "pauseTask", async () => { throw new Error(error); });
    if (operation === "archive") await env.archive();
    else await env.click("暂停");
    assert.match(env.container.querySelector('[role="alert"]')?.textContent ?? "", new RegExp(error));
    assert.ok(env.toasts().some(node => node.getAttribute("role") === "alert" && node.textContent?.includes(error)));
    await env.tick(60_000);
    const alert = env.container.querySelector('[role="alert"]');
    assert.ok(alert, "the inline error remains after all transient lifetimes");
    assert.match(alert.textContent ?? "", new RegExp(error));
    context.mock.method(api, "pauseTask", async () => ({
      canvas_id: canvas.id, execution_state: "paused", active_count: 0, pending_count: 0, changed: true,
    }));
    await env.click("暂停");
    assert.equal(env.container.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(env.container.textContent ?? "", new RegExp(error));
    assert.match(env.container.querySelector('[role="status"]')?.textContent ?? "", /任务已暂停/);
    assert.equal(env.toasts().some(node => node.textContent?.includes(error)), false);
    await env.tick(3200);
    assert.doesNotMatch(env.container.textContent ?? "", /任务已暂停/);
  });
}

test("task failure can be dismissed and a partial pause is a warning", async context => {
  const env = await setup(context);
  context.mock.method(api, "pauseTask", async () => { throw new Error("permission denied"); });
  await env.click("暂停");
  const alert = env.container.querySelector('[role="alert"]');
  assert.ok(alert);
  const dismiss = alert.querySelector<HTMLButtonElement>("button");
  assert.ok(dismiss, "the inline failure has a dismiss control");
  await act(async () => dismiss.click());
  assert.equal(env.container.querySelector('[role="alert"]'), null);
  assert.equal(env.toasts().length, 0);
  context.mock.method(api, "pauseTask", async () => ({
    canvas_id: canvas.id, execution_state: "pausing", active_count: 1, pending_count: 0, changed: true,
  }));
  await env.click("暂停");
  assert.match(env.container.querySelector('[role="status"]')?.textContent ?? "", /暂停中/);
  assert.ok(env.toasts().some(node => node.classList.contains("is-warn")));
  await env.tick(3200);
  assert.match(env.container.textContent ?? "", /暂停中，尚有 1 个 Job 安全收尾/);
  await env.tick(2800);
  assert.doesNotMatch(env.container.textContent ?? "", /暂停中，尚有 1 个 Job 安全收尾/);
});

for (const boundary of ["unmount", "project change"] as const) {
  test(`a late task API rejection produces no toast after ${boundary}`, async context => {
    const env = await setup(context);
    const pending = deferred<Awaited<ReturnType<typeof api.pauseTask>>>();
    context.mock.method(api, "pauseTask", () => pending.promise);
    await env.click("暂停");
    if (boundary === "unmount") env.unmountPage();
    else await env.switchProject();
    await act(async () => pending.reject(new Error("late pause failure")));
    assert.equal(env.toasts().length, 0, "the toast host stays mounted to detect stale callbacks");
    assert.doesNotMatch(env.container.textContent ?? "", /late pause failure/);
    await env.tick(60_000);
    assert.equal(env.toasts().length, 0);
  });
}

test("unmounting the task page also removes its existing error toast", async context => {
  const env = await setup(context);
  context.mock.method(api, "pauseTask", async () => { throw new Error("pause denied before unmount"); });
  await env.click("暂停");
  assert.equal(env.toasts().length, 1);
  env.unmountPage();
  assert.equal(env.toasts().length, 0, "page cleanup removes its toast while the global host remains alive");
  await env.tick(60_000);
  assert.equal(env.toasts().length, 0);
});
