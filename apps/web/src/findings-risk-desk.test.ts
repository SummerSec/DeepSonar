import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FindingSummary, ProjectFindingsSummary } from "./api";
import {
  canvasScopedTotal,
  dispositionBadgeTone,
  filterProjectFindings,
  findingsListTruncated,
  PROJECT_RISK_CAPTION,
  PROJECT_RISK_TITLE,
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

test("project risk desk copy is first-class and distinct from cross-project findings", () => {
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./pages/FindingsPage.tsx", import.meta.url), "utf8");
  assert.match(shell, new RegExp(`label:\\s*"${PROJECT_RISK_TITLE}"`));
  assert.match(shell, new RegExp(`caption:\\s*"${PROJECT_RISK_CAPTION}"`));
  assert.match(shell, /跨项目发现/);
  assert.match(page, /PROJECT_RISK_TITLE/);
  assert.match(page, /projectFindingsSummary/);
  assert.doesNotMatch(page, /title=\{scope === "global" \? "发现" : "项目发现"\}/);
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
