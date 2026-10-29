import assert from "node:assert/strict";
import test from "node:test";
import { FINDING_DISPOSITIONS, FINDINGS_LIST_WINDOW } from "../../finding-disposition.js";
import {
  buildProjectFindingsSummary,
  fillCountBuckets,
} from "./project-findings-summary.js";

test("project findings summary keeps a complete rollup even when the list window would truncate", () => {
  const summary = buildProjectFindingsSummary({
    projectId: "project-1",
    total: FINDINGS_LIST_WINDOW + 12,
    severity: [{ key: "high", count: 400 }, { key: "medium", count: 112 }],
    verifyStatus: [{ key: "pending", count: 300 }, { key: "confirmed", count: 212 }],
    disposition: [
      { key: "open", count: 200 },
      { key: "human_reproducing", count: 80 },
      { key: "accepted", count: 232 },
    ],
    canvases: [
      { id: "canvas-b", title: "B 任务", count: 300 },
      { id: "canvas-a", title: "A 任务", count: 212 },
    ],
  });
  assert.equal(summary.total, FINDINGS_LIST_WINDOW + 12);
  assert.equal(summary.project_total, FINDINGS_LIST_WINDOW + 12);
  assert.equal(summary.list_window, FINDINGS_LIST_WINDOW);
  assert.equal(summary.truncated, true);
  assert.equal(summary.severity.find((item) => item.key === "high")?.count, 400);
  assert.equal(summary.disposition.find((item) => item.key === "human_reproducing")?.count, 80);
  assert.deepEqual(FINDING_DISPOSITIONS, summary.disposition.map((item) => item.key));
  assert.deepEqual(summary.canvases.map((item) => item.id), ["canvas-b", "canvas-a"]);
});

test("empty project findings summary fills known buckets with zeros", () => {
  const summary = buildProjectFindingsSummary({
    projectId: "empty",
    total: 0,
    severity: [],
    verifyStatus: [],
    disposition: [],
    canvases: [],
  });
  assert.equal(summary.truncated, false);
  assert.equal(summary.total, 0);
  assert.equal(summary.project_total, 0);
  assert.deepEqual(fillCountBuckets(["open", "accepted"], []), [
    { key: "open", count: 0 },
    { key: "accepted", count: 0 },
  ]);
  assert.equal(summary.canvases.length, 0);
});


test("finding filters are bounded multi-selects and search treats SQL wildcards literally", async () => {
  const { parseFindingQuery } = await import("./finding-query.js");
  const filters = parseFindingQuery({ severity: "high,medium,high", q: "漏洞%_\\x" });
  assert.deepEqual(filters.severity, ["high", "medium"]);
  assert.equal(filters.q, "%漏洞\\%\\_\\\\x%");
  assert.equal(parseFindingQuery({ q: "   " }).q, null);
  assert.equal(parseFindingQuery({ project_id: null }).project_id, null);
  for (const query of [{ canvas_id: "bad" }, { severity: ["high"] }, { q: "x".repeat(201) }, { severity: "high,,low" }]) {
    assert.throws(() => parseFindingQuery(query), /invalid query parameter/);
  }
});
