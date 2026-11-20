import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { api, type FindingDetail, type FindingSummary, type PageEnvelope, type ProjectFindingsSummary } from "./api";
import { FindingDetailPanel } from "./FindingDetailPanel";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
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

test("Finding detail keeps one candidate entry and its state across conditional sections and reloads", async () => {
  const env = setup();
  const original = {
    finding: api.finding, findingSharedAssets: api.findingSharedAssets,
    findingCandidates: api.findingCandidates, setFindingDisposition: api.setFindingDisposition,
  };
  const originalError = console.error;
  const keyWarnings: string[] = [];
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("same key")) keyWarnings.push(args.map(String).join(" "));
    else originalError(...args);
  };
  let needsHuman = false;
  let showResearch = false;
  function detail(id: string): FindingDetail {
    return {
      verification_control: { verify_status: needsHuman ? "needs_human" : "pending", subject_revision: null, latest_round_id: null },
      finding: { ...finding(id), verify_status: needsHuman ? "needs_human" : "pending",
        raw_json: {}, source_job_type: "analyze", source_job_status: "succeeded" },
      verification_jobs: [], verification_rounds: [], source_events: [],
      cluster_members: showResearch ? [{ finding_id: id, is_canonical: true,
        canonical_finding_id: null, dedupe_reason: null, priority_score: null,
        title: id, verify_status: "pending", severity: "high", job_id: "job-a" }] : [],
      trace: {
        source: { job_id: "job-a", job_type: "analyze", job_status: "succeeded", node_id: null,
          job_node_id: null, canvas_id: "task-a", at: "2026-01-01T00:00:00.000Z" },
        evidence: { review: [], test: [] }, rounds: [], intents: [], hubs: [],
        flow: { nodes: [], edges: [] }, gaps: [], node_ids: [], edge_ids: [],
      },
    };
  }
  const candidateRequests: Array<{ id: string; signal?: AbortSignal }> = [];
  api.finding = async id => detail(id);
  api.findingSharedAssets = async () => ({ items: [], limit: 50, offset: 0 });
  api.setFindingDisposition = async id => detail(id).finding;
  api.findingCandidates = (id, _cursor, signal) => {
    candidateRequests.push({ id, signal });
    return deferred<Awaited<ReturnType<typeof api.findingCandidates>>>().promise;
  };
  // Use the actual drawer composition: isolated candidate tests cannot catch sibling key collisions.
  async function render(id: string) {
    await act(async () => env.root.render(<MemoryRouter><ConfirmDialogProvider>
      <FindingDetailPanel findingId={id} onClose={() => {}} />
    </ConfirmDialogProvider></MemoryRouter>));
  }
  async function click(label: string) {
    const button = Array.from(env.container.querySelectorAll("button")).find(item => item.textContent === label);
    assert.ok(button, `${label} exists`);
    await act(async () => button.click());
  }
  function entries() {
    assert.equal(env.container.querySelectorAll('[aria-label="已计算的词法候选"]').length, 1);
    assert.equal(env.container.querySelectorAll('[aria-label="相似文本检索"]').length, 1);
  }
  try {
    await render("subject-a");
    entries();
    assert.equal(candidateRequests.length, 0, "candidate reads stay opt-in");
    await click("查看已计算候选");
    const expandedEntry = env.container.querySelector('[aria-label="已计算的词法候选"]');
    for (let index = 0; index < 6; index++) {
      needsHuman = index % 2 === 0;
      showResearch = index % 3 === 0;
      await click("待处置");
      entries();
      assert.equal(env.container.querySelector('[aria-label="已计算的词法候选"]'), expandedEntry);
      assert.equal(expandedEntry?.querySelector("button")?.getAttribute("aria-expanded"), "true");
      assert.equal(candidateRequests.length, 1, "reload must not remount or refetch candidates");
      assert.equal(candidateRequests[0].signal?.aborted, false);
    }
    await render("subject-b");
    entries();
    assert.equal(candidateRequests[0].signal?.aborted, true);
    assert.equal(env.container.querySelector('[aria-label="已计算的词法候选"] button')?.getAttribute("aria-expanded"), "false");
    await click("查看已计算候选");
    assert.equal(candidateRequests[1].id, "subject-b");
    assert.deepEqual(keyWarnings, [], "drawer siblings must have unique keys");
  } finally {
    await env.cleanup();
    Object.assign(api, original);
    console.error = originalError;
  }
});
