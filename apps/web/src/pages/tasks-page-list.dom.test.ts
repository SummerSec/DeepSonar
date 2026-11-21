import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { api, type CanvasSummary } from "../api";
import { AuthProvider } from "../auth";
import { ConfirmDialogProvider } from "../components/ConfirmDialog";

function deferred() {
  let resolve!: (rows: CanvasSummary[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CanvasSummary[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function canvas(id: string, findings: number): CanvasSummary {
  return {
    id, title: id, target_json: {}, created_at: "2026-11-21T00:00:00Z",
    status: "active", archived_at: null, started_at: null, ended_at: null,
    job_count: 0, active_count: 0, execution_active_count: 0, pending_count: 0,
    execution_state: "running", root_status: null, report_status: null,
    finding_count: findings, confirmed_count: 0, last_job_id: null,
    last_job_status: null, last_job_priority: null, last_job_at: null,
  };
}

test("task lists and counters belong to the selected project and status through loading, failures and polling", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1" });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const requests: { projectId: string; status: string; result: ReturnType<typeof deferred> }[] = [];
  const polls = new Map<number, () => void>();
  let nextTimer = 0;
  const mocks = [
    mock.method(api, "projects", async () => []),
    // An unauthenticated context keeps the independent project queue panel inactive.
    mock.method(api, "authStatus", async () => ({ auth_required: true, has_users: true, bootstrap_available: false, default_admin_credentials_active: false, session_ttl_days: 1 })),
    mock.method(api, "canvases", (projectId: string, options: { status: string }) => {
      const result = deferred();
      requests.push({ projectId, status: options.status, result });
      return result.promise;
    }),
    mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      if (delay === 5000) polls.set(id, callback);
      return id;
    }),
    mock.method(globalThis, "clearInterval", (id: number) => { polls.delete(id); }),
    mock.method(dom.window, "setInterval", () => ++nextTimer),
    mock.method(dom.window, "clearInterval", () => {}),
  ];
  const { createRoot } = await import("react-dom/client");
  const { TasksPage } = await import("./TasksPage");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let navigate!: ReturnType<typeof useNavigate>;
  function Page() {
    navigate = useNavigate();
    return createElement(TasksPage);
  }
  const text = () => container.textContent ?? "";
  const counters = () => [...container.querySelectorAll('[role="group"][aria-label="任务列表统计"] strong')].map(node => node.textContent);
  const request = () => requests.at(-1)!.result;
  const poll = () => act(async () => {
    assert.equal(polls.size, 1, "only the current list poll remains installed");
    for (const callback of polls.values()) callback();
  });
  const select = async (label: string) => {
    await act(async () => {
      const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
      assert.ok(trigger);
      trigger.click();
    });
    await act(async () => {
      const option = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.trim() === label);
      assert.ok(option);
      option.click();
    });
  };
  const noPreviousResult = (title: string) => {
    assert.equal(container.querySelectorAll("article").length, 0, title);
    assert.deepEqual(counters(), [], "unloaded counters must not reuse previous values or claim zero");
    assert.doesNotMatch(text(), /下达第一项任务|暂无知识整理历史/, "unavailable data is not an empty result");
  };
  try {
    await act(async () => root.render(createElement(MemoryRouter, { initialEntries: ["/projects/A/tasks"] },
      createElement(AuthProvider, null, createElement(ConfirmDialogProvider, null,
        createElement(Routes, null, createElement(Route, { path: "/projects/:projectId/tasks", element: createElement(Page) })))))));
    await act(async () => request().resolve([
      { ...canvas("常用任务 A", 7), job_count: 1, active_count: 1, execution_active_count: 1 },
      canvas("常用任务 B", 0),
    ]));
    assert.match(text(), /常用任务 A/);
    assert.deepEqual(counters(), ["2", "1", "7"]);

    await select("知识整理历史");
    assert.deepEqual([requests.at(-1)!.projectId, requests.at(-1)!.status], ["A", "knowledge_history"]);
    noPreviousResult("switching filters immediately hides the old tasks while the request is delayed");
    assert.ok(container.querySelector('[role="status"][aria-label="正在加载任务列表"]'));
    await act(async () => request().reject(new Error("历史暂不可用")));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /历史暂不可用/);
    noPreviousResult("a failed history request must not leave active tasks under its heading");

    await poll();
    await act(async () => request().resolve([canvas("知识历史 A", 3)]));
    assert.match(text(), /知识历史 A/);
    assert.doesNotMatch(text(), /常用任务 A|历史暂不可用/);
    assert.deepEqual(counters(), ["1", "0", "3"]);

    await poll();
    assert.match(text(), /知识历史 A/, "a refresh of the same filter keeps its last successful result");
    const pendingRefresh = request();
    await poll();
    assert.equal(request(), pendingRefresh, "a slow refresh must not overlap another poll that could finish out of order");
    assert.match(text(), /知识历史 A/);
    await act(async () => request().reject(new Error("刷新暂不可用")));
    assert.match(text(), /知识历史 A/);
    assert.match(text(), /刷新暂不可用/);
    assert.deepEqual(counters(), ["1", "0", "3"]);

    await act(async () => navigate("/projects/B/tasks"));
    assert.deepEqual([requests.at(-1)!.projectId, requests.at(-1)!.status], ["B", "knowledge_history"]);
    noPreviousResult("switching projects hides the previous project's tasks and counters");
    assert.doesNotMatch(text(), /刷新暂不可用/, "errors also belong to their project and filter");
    const lateHistory = request();
    await select("已归档");
    const archived = request();
    await act(async () => lateHistory.resolve([canvas("迟到的旧筛选结果", 9)]));
    noPreviousResult("a late response cannot replace the current filter's loading state");
    await act(async () => archived.resolve([]));
    assert.deepEqual(counters(), ["0", "0", "0"], "a successful empty result can show real zero counts");
    assert.doesNotMatch(text(), /迟到的旧筛选结果|知识历史 A/);
  } finally {
    act(() => root.unmount());
    for (const item of mocks.reverse()) item.mock.restore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
