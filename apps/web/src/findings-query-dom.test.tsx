import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, type FindingSummary, type PageEnvelope, type ProjectFindingsSummary } from "./api";
import { FindingsPage } from "./pages/FindingsPage";
import { useFindingsQuery } from "./useFindingsQuery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function finding(id: string): FindingSummary {
  return {
    id, title: id, project_id: "project-a", job_id: "job-a", node_id: null,
    fingerprint: id, severity: "high", profile: "security.vulnerability", category: null,
    tags_json: [], evidence_refs_json: [], scoring_json: {}, location: null, summary: null,
    verify_status: "pending", disposition: "open", created_at: "2026-01-01T00:00:00.000Z",
  };
}
function page(id: string, next: string | null = null): PageEnvelope<FindingSummary> {
  return { items: [finding(id)], after: null, next_cursor: next, has_more: Boolean(next), watermark: "now", live: false };
}
const summary: ProjectFindingsSummary = {
  project_id: "project-a", total: 1, project_total: 1, list_window: 500, truncated: false,
  profiles: [{ key: "security.vulnerability", count: 1 }], severity: [{ key: "high", count: 1 }],
  verify_status: [{ key: "pending", count: 1 }], disposition: [{ key: "open", count: 1 }], canvases: [],
};

function setup() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://127.0.0.1" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const originalPage = api.findingsPage;
  const originalSummary = api.projectFindingsSummary;
  const requests: Array<{ options: Parameters<typeof api.findingsPage>[0]; pending: ReturnType<typeof deferred<PageEnvelope<FindingSummary>>> }> = [];
  api.findingsPage = (options) => {
    const pending = deferred<PageEnvelope<FindingSummary>>();
    requests.push({ options, pending });
    return pending.promise;
  };
  api.projectFindingsSummary = async () => summary;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let renders = 0;
  const onRender = () => {
    // Bound a regression rather than allowing the original effect loop to hang the test process.
    assert.ok(++renders < 40, "query change must settle without an update-depth loop");
  };
  return {
    root, container, requests, onRender, renders: () => renders,
    async cleanup() {
      await act(async () => root.unmount());
      api.findingsPage = originalPage;
      api.projectFindingsSummary = originalSummary;
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
      }
    },
  };
}

test("FindingsPage survives slow filter/page changes and ignores superseded responses", async () => {
  const env = setup();
  const router = createMemoryRouter([{ path: "/projects/:projectId/findings", element: <FindingsPage scope="project" /> }], {
    initialEntries: ["/projects/project-a/findings?panel=risk"],
  });
  try {
    await act(async () => env.root.render(<Profiler id="findings" onRender={env.onRender}><RouterProvider router={router} /></Profiler>));
    assert.equal(env.requests.length, 1);
    await act(async () => env.requests[0].pending.resolve(page("initial", "page-two")));
    const checkbox = env.container.querySelector<HTMLInputElement>('input[aria-label="选择 initial"]')!;
    await act(async () => checkbox.click());
    assert.equal(checkbox.checked, true);

    await act(async () => router.navigate("?panel=risk&severity=high"));
    assert.equal(env.requests.length, 2);
    assert.equal(env.requests[1].options?.severity, "high");
    assert.ok(!env.container.textContent?.includes("initial"), "old records disappear while new filter is pending");
    await act(async () => env.requests[1].pending.resolve(page("filtered", "page-two")));
    assert.ok(env.container.textContent?.includes("filtered"));
    assert.equal(env.container.querySelector<HTMLInputElement>('input[aria-label="选择 filtered"]')?.checked, false);

    const next = Array.from(env.container.querySelectorAll("button")).find((button) => button.textContent === "下一页")!;
    await act(async () => next.click());
    assert.equal(router.state.location.search.includes("cursor=page-two"), true);
    assert.equal(env.requests[2].options?.after, "page-two");
    assert.equal(env.requests[2].options?.severity, "high");
    assert.ok(!env.container.textContent?.includes("filtered"));
    await act(async () => env.requests[2].pending.resolve(page("second-page")));
    assert.ok(env.container.textContent?.includes("second-page"));

    await act(async () => router.navigate("?severity=low"));
    await act(async () => router.navigate("?severity=medium"));
    await act(async () => env.requests[4].pending.resolve(page("new-response")));
    await act(async () => env.requests[3].pending.resolve(page("stale-response")));
    assert.ok(env.container.textContent?.includes("new-response"));
    assert.ok(!env.container.textContent?.includes("stale-response"));
    assert.ok(env.renders() < 40);
  } finally {
    router.dispose();
    await env.cleanup();
  }
});

test("useFindingsQuery keeps the pending rows identity stable across parent rerenders", async () => {
  const env = setup();
  let latest: ReturnType<typeof useFindingsQuery> | undefined;
  function Probe({ severity }: { severity: string }) {
    latest = useFindingsQuery("project", "project-a", { project_id: "project-a", severity }, null);
    return <span>{latest.loading ? "loading" : latest.rows.map((row) => row.title).join(",")}</span>;
  }
  try {
    await act(async () => env.root.render(<Probe severity="high" />));
    await act(async () => env.requests[0].pending.resolve(page("initial")));
    await act(async () => env.root.render(<Probe severity="low" />));
    const pendingRows = latest!.rows;
    assert.equal(latest!.loading, true);
    await act(async () => env.root.render(<Probe severity="low" />));
    assert.equal(latest!.rows, pendingRows);
    assert.equal(env.requests.length, 2, "parent rerender must not restart the request");
    await act(async () => env.requests[1].pending.reject(new Error("403 revoked")));
    assert.equal(latest!.loading, false);
    assert.deepEqual(latest!.rows, []);
    assert.equal(latest!.summary, null);
    assert.match(latest!.error!, /403 revoked/);
  } finally {
    await env.cleanup();
  }
});
