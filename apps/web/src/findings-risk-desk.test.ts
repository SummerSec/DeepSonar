import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api, type FindingSummary } from "./api";
import { clearFindingQuery, findingQueryFilters, updateFindingQuery } from "./finding-query-state";
import {
  dispositionBadgeTone,
  PROJECT_DELIVERY_CAPTION,
  PROJECT_DELIVERY_TITLE,
  projectReportsRedirectPath,
  readProjectDeliveryPanel,
  writeProjectDeliveryPanel,
  researchDedupeLabel,
  researchPriorityLabel,
} from "./findings-risk-desk";

test("project delivery desk merges risk and reports and stays distinct from cross-project findings", () => {
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./pages/ProjectLayout.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const delivery = readFileSync(new URL("./pages/ProjectDeliveryPage.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./pages/FindingsPage.tsx", import.meta.url), "utf8");
  assert.match(shell, new RegExp(`label:\\s*"${PROJECT_DELIVERY_TITLE}"`));
  assert.match(shell, new RegExp(`caption:\\s*"${PROJECT_DELIVERY_CAPTION}"`));
  assert.doesNotMatch(shell, /seg:\s*"reports"/);
  assert.doesNotMatch(shell, /项目报告/);
  assert.match(shell, /跨项目发现/);
  assert.match(layout, /to: "findings"/);
  assert.doesNotMatch(layout, /to: "reports"/);
  assert.match(layout, /风险报告/);
  assert.match(app, /ProjectDeliveryPage/);
  assert.match(app, /panel=reports/);
  assert.match(delivery, /FindingsPage scope="project" hidePageChrome/);
  assert.match(delivery, /ProjectReportsPage embedded/);
  assert.match(page, /PROJECT_DELIVERY_TITLE/);
  assert.match(page, /useFindingsQuery/);
  assert.doesNotMatch(page, /title=\{scope === "global" \? "发现" : "项目发现"\}/);
});

test("delivery panel query helpers keep risk default and reports bookmarkable", () => {
  assert.equal(readProjectDeliveryPanel(new URLSearchParams()), "risk");
  assert.equal(readProjectDeliveryPanel(new URLSearchParams("panel=reports")), "reports");
  assert.equal(writeProjectDeliveryPanel(new URLSearchParams("finding=f1"), "reports").get("panel"), "reports");
  assert.equal(writeProjectDeliveryPanel(new URLSearchParams("panel=reports&finding=f1"), "risk").get("panel"), null);
  assert.equal(projectReportsRedirectPath("proj-1"), "/projects/proj-1/findings?panel=reports");
});

test("finding URL filters are translated once for server list and summary", () => {
  const params = new URLSearchParams("panel=risk&severity=high,low&profile=security.vulnerability&verify=confirmed&disposition=open&canvas=task-b&q=中文%25&finding=old&cursor=page-11");
  assert.deepEqual(findingQueryFilters(params, "project", "project-a"), {
    project_id: "project-a", severity: "high,low", profile: "security.vulnerability", verify_status: "confirmed",
    disposition: "open", canvas_id: "task-b", q: "中文%",
  });
  const changed = updateFindingQuery(params, "canvas", ["task-c"]);
  assert.equal(changed.get("cursor"), null, "filter changes restart pagination");
  assert.equal(changed.get("finding"), "old", "selected detail survives filtering");
  assert.equal(changed.get("panel"), "risk");
  const detail = updateFindingQuery(params, "finding", "new");
  assert.equal(detail.get("cursor"), "page-11", "opening a detail preserves current page");
  const restored = new URLSearchParams(detail.toString());
  assert.deepEqual(findingQueryFilters(restored, "project", "project-a"), findingQueryFilters(params, "project", "project-a"));
  const cleared = clearFindingQuery(params);
  assert.equal(cleared.get("cursor"), null);
  assert.equal(cleared.get("finding"), "old");
  assert.equal(cleared.get("panel"), "risk");
  assert.equal(params.get("cursor"), "page-11", "helpers do not mutate router state");
});

test("global query sends project multiselect and does not apply a task scope", () => {
  const filters = findingQueryFilters(new URLSearchParams("project=p1,p2&canvas=c1"), "global");
  assert.equal(filters.project_id, "p1,p2");
  assert.equal(filters.canvas_id, undefined);
  assert.match(dispositionBadgeTone("human_reproducing"), /violet/);
});

test("page wiring uses server filters, bounded pages and fail-closed refresh", () => {
  const page = readFileSync(new URL("./pages/FindingsPage.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("./useFindingsQuery.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /filterProjectFindings|api\.findings\(/);
  assert.match(page, /aria-label="发现分页"/);
  assert.match(page, /changePage\(nextCursor\)/);
  assert.match(page, /f\.updated_at \?\? f\.created_at/);
  assert.match(page, /facets\?\.canvases/);
  assert.match(page, /selectedFinding && !error/, "query access failure also unmounts an open detail");
  assert.match(hook, /api\.findingsPage/);
  assert.match(hook, /projectFindingsSummary\(query\.projectId, summaryFilters\)/);
  assert.match(hook, /setState\(\{ \.\.\.emptyState\(key\), error/);
  assert.match(hook, /setTimeout\(tick, 5000\)/);
});

test("finding API preserves cursor and all filters across pages beyond 500 rows", async () => {
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://127.0.0.1");
    urls.push(url);
    const offset = Number(url.searchParams.get("after") || 0);
    const items = Array.from({ length: Math.min(50, 551 - offset) }, (_, index) => ({ id: `finding-${offset + index}` }));
    return new Response(JSON.stringify({ items, next_cursor: offset + items.length < 551 ? String(offset + items.length) : null, has_more: offset + items.length < 551, after: String(offset), watermark: "now", live: false }), { status: 200 });
  };
  try {
    const filters = { severity: "high,low", canvas_id: "task-a,task-b", verify_status: "confirmed", disposition: "open", q: "历史%记录" };
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const page = await api.findingsPage({ ...filters, after, limit: 50 });
      ids.push(...page.items.map((row) => row.id));
      after = page.next_cursor;
    } while (after);
    assert.equal(ids.length, 551);
    assert.equal(new Set(ids).size, 551);
    assert.equal(ids.at(-1), "finding-550");
    for (const url of urls) {
      assert.equal(url.searchParams.get("limit"), "50");
      for (const [key, value] of Object.entries(filters)) assert.equal(url.searchParams.get(key), value);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research badges stay independent from verify and severity", () => {
  assert.equal(researchPriorityLabel(80), "优先 80");
  assert.equal(researchPriorityLabel(null), null);
  assert.equal(researchDedupeLabel({ is_canonical: false, canonical_finding_id: "abc" }), "语义重复");
  assert.equal(researchDedupeLabel({ is_canonical: true, dedupe_cluster_id: "c1" }), "canonical");
  assert.equal(researchDedupeLabel({ verify_status: "pending" } as FindingSummary), null);
  const page = readFileSync(new URL("./pages/FindingsPage.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./FindingDetailPanel.tsx", import.meta.url), "utf8");
  assert.match(page, /researchPriorityLabel/);
  assert.match(page, /researchDedupeLabel/);
  assert.match(panel, /研究排序不改写技术验证、严重度或报告门禁/);
  assert.match(panel, /aria-label="语义去重与研究优先级"/);
});
