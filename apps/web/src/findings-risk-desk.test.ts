import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FindingSummary, ProjectFindingsSummary } from "./api";
import {
  canvasScopedTotal,
  dispositionBadgeTone,
  filterProjectFindings,
  findingsListTruncated,
  PROJECT_DELIVERY_CAPTION,
  PROJECT_DELIVERY_TITLE,
  projectReportsRedirectPath,
  readProjectDeliveryPanel,
  writeProjectDeliveryPanel,
  researchDedupeLabel,
  researchPriorityLabel,
} from "./findings-risk-desk";

function finding(overrides: Partial<FindingSummary> = {}): FindingSummary {
  return {
    id: "finding-1",
    project_id: "project-1",
    job_id: "job-1",
    node_id: null,
    fingerprint: "fp-1",
    title: "Cache primitive",
    severity: "high",
    profile: "security.vulnerability",
    category: null,
    tags_json: [],
    evidence_refs_json: [],
    scoring_json: {},
    location: null,
    summary: "from canvas A",
    verify_status: "pending",
    disposition: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    canvas_id: "canvas-a",
    canvas_title: "任务 A",
    ...overrides,
  };
}

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
  assert.match(page, /projectFindingsSummary/);
  assert.doesNotMatch(page, /title=\{scope === "global" \? "发现" : "项目发现"\}/);
});

test("delivery panel query helpers keep risk default and reports bookmarkable", () => {
  assert.equal(readProjectDeliveryPanel(new URLSearchParams()), "risk");
  assert.equal(readProjectDeliveryPanel(new URLSearchParams("panel=reports")), "reports");
  assert.equal(writeProjectDeliveryPanel(new URLSearchParams("finding=f1"), "reports").get("panel"), "reports");
  assert.equal(writeProjectDeliveryPanel(new URLSearchParams("panel=reports&finding=f1"), "risk").get("panel"), null);
  assert.equal(projectReportsRedirectPath("proj-1"), "/projects/proj-1/findings?panel=reports");
});

test("project list keeps findings from every canvas and can filter by source task", () => {
  const rows = [
    finding(),
    finding({ id: "finding-2", canvas_id: "canvas-b", canvas_title: "任务 B", disposition: "human_reproducing" }),
  ];
  assert.equal(filterProjectFindings(rows, {}).length, 2);
  assert.deepEqual(filterProjectFindings(rows, { canvasIds: ["canvas-b"] }).map((row) => row.id), ["finding-2"]);
  assert.deepEqual(
    filterProjectFindings(rows, { dispositions: ["human_reproducing"] }).map((row) => row.id),
    ["finding-2"],
  );
});

test("risk desk totals prefer the project aggregate when the list window truncates", () => {
  const summary: ProjectFindingsSummary = {
    project_id: "project-1",
    total: 512,
    project_total: 512,
    list_window: 500,
    truncated: true,
    severity: [],
    verify_status: [],
    disposition: [],
    canvases: [
      { id: "canvas-a", title: "任务 A", count: 400 },
      { id: "canvas-b", title: "任务 B", count: 112 },
    ],
  };
  assert.equal(findingsListTruncated(500, summary.total), true);
  assert.equal(canvasScopedTotal(summary, []), 512);
  assert.equal(canvasScopedTotal(summary, ["canvas-b"]), 112);
  assert.match(dispositionBadgeTone("human_reproducing"), /violet/);
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
