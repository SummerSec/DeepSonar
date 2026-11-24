import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanAuditRecord } from "@deepsonar/shared-types";
import { MarkdownView } from "./MarkdownView.js";
import { projectPlanGaps, withPlanGapReport } from "../../scheduler/src/domains/plan-protocol/gap-projection.js";

for (const tail of ["<!--", "```", "````json", "~~~html", "<script>", "<div hidden>"]) {
  test(`gap section is visibly rendered before an unclosed model tail ${JSON.stringify(tail)}`, () => {
    const modelText = `## 已确认问题\n\nfinding-id\n\n${tail}`;
    const markdown = withPlanGapReport(modelText, {
      v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32,
    });
    const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
    const outsideCode = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, "");
    assert.match(outsideCode, /目标与缺口（只读计划审计）/);
    assert.match(outsideCode, /unknown/);
    assert.ok(markdown.indexOf("## 目标与缺口") < markdown.indexOf(tail));
    assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<div hidden>/);
  });
}

test("#1251 有审计数据时页面与下载同一份 Markdown：结论在前、原始投影在文末", () => {
  const v1Plan = {
    v: 1, goal: "Read the historical authentication boundary", assumptions: [],
    tasks: [{ id: "historical", title: "Read historical boundary evidence", role: "review", description: "Read the historical boundary evidence",
      prompt: "Read the historical boundary evidence and retain the existing record for review.", from: [], depends_on: [], inputs: [],
      expected_outputs: ["historical-evidence"] }],
    completion: { mode: "explicit_result", description: "Historical evidence is retained", required_outputs: ["historical-evidence"] },
    budget: { max_tasks: 1 }, open_questions: [],
  };
  const audit = PlanAuditRecord.parse({ v: 1, source: "hub_intent_adapter", raw: v1Plan, trimmed: null, trim_reasons: [], result: null,
    termination_reason: null, updated_at: "2026-10-30T00:00:00.000Z" });
  const markdown = withPlanGapReport("## 结论\n\n任务做完了什么。", {
    v: 1, scope: "canvas_plan_audits", entries: [projectPlanGaps("job-gap", { plan_protocol: audit })], truncated: false, limit: 32,
  });
  const summary = markdown.indexOf("## 目标与缺口");
  const conclusion = markdown.indexOf("## 结论");
  const detail = markdown.indexOf("### 详细审计数据");
  assert.ok(summary === 0 && conclusion > summary && detail > conclusion, `顺序应为摘要→正文→详情，实际 ${summary}/${conclusion}/${detail}`);
  assert.ok(markdown.trimEnd().endsWith("```"), "原始投影必须在下载文件末尾");
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  // 第一个可见标题必须是审计段；正文与机器数据段都排在它后面，且正文先于机器数据。
  const first = html.indexOf("目标与缺口（只读计划审计）");
  const conclusionAt = html.indexOf("任务做完了什么");
  const detailAt = html.indexOf("产品投影，给排查用");
  const positions = [first, conclusionAt, detailAt];
  assert.ok(positions.every((at) => at >= 0), "三段都必须在页面渲染出来");
  assert.ok(first >= 0, "审计段必须渲染出来");
  assert.ok(conclusionAt > first, "结论正文必须排在审计摘要之后");
  assert.ok(detailAt > conclusionAt, "机器数据段必须排在正文之后");
});

test("projection text remains escaped inside its own rendered JSON fence", () => {
  const markdown = withPlanGapReport("Report body", {
    v: 1, scope: "canvas_plan_audits", truncated: false, limit: 32,
    entries: [{ job_id: '<img src=x onerror="alert(1)">\n```\n<!--', availability: "invalid", audit: null }],
  });
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  assert.doesNotMatch(html, /<img\b|<!--/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Report body/);
});

test("v2 Plan audits remain visible while historical v1 and native reports stay readable", () => {
  const v2Plan = {
    v: 2,
    objective_id: "00000000-0000-4000-8000-000000000001",
    objective_revision: "1",
    route_revision: "1",
    goal: "Verify the current authentication boundary",
    assumptions: [],
    tasks: [{
      id: "collect",
      title: "Collect current boundary evidence",
      role: "test",
      description: "Collect evidence for the current boundary",
      prompt: "Collect the authorized boundary evidence and retain the result for review.",
      from: [],
      depends_on: [],
      inputs: [],
      expected_outputs: ["boundary-evidence"],
    }],
    completion: {
      mode: "explicit_result",
      description: "Current boundary evidence is reviewed",
      required_outputs: ["boundary-evidence"],
    },
    budget: { max_tasks: 4, max_rounds: 3, max_no_progress_rounds: 1, max_parallel_tasks: 2 },
    open_questions: [],
  };
  const v2Audit = PlanAuditRecord.parse({
    v: 2,
    source: "submit_plan",
    raw: v2Plan,
    trimmed: v2Plan,
    trim_reasons: [],
    result: {
      v: 2,
      objective_id: v2Plan.objective_id,
      objective_revision: v2Plan.objective_revision,
      route_revision: v2Plan.route_revision,
      plan_sha256: "a".repeat(64),
      outcome: "continue",
      summary: "The current route is still collecting evidence",
      execution: [{ task_id: "collect", status: "running" }],
      open_questions: [],
    },
    termination_reason: null,
    updated_at: "2026-10-31T00:00:00.000Z",
  });
  const v2Projection = projectPlanGaps("job-v2", { plan_protocol: v2Audit });
  assert.equal(v2Projection.availability, "available");
  assert.equal(v2Projection.audit?.proposed_outcome, "continue");
  assert.equal(v2Projection.audit?.tasks[0]?.title, "Collect current boundary evidence");
  assert.equal(v2Projection.audit?.tasks[0]?.proposed_execution[0]?.status, "running");

  const v1Audit = PlanAuditRecord.parse({
    v: 1,
    source: "hub_intent_adapter",
    raw: {
      v: 1,
      goal: "Read the historical authentication boundary",
      assumptions: [],
      tasks: [{
        id: "historical",
        title: "Read historical boundary evidence",
        role: "review",
        description: "Read the historical boundary evidence",
        prompt: "Read the historical boundary evidence and retain the existing record for review.",
        from: [],
        depends_on: [],
        inputs: [],
        expected_outputs: ["historical-evidence"],
      }],
      completion: {
        mode: "explicit_result",
        description: "Historical evidence is retained",
        required_outputs: ["historical-evidence"],
      },
      budget: { max_tasks: 1 },
      open_questions: [],
    },
    trimmed: null,
    trim_reasons: [],
    result: null,
    termination_reason: null,
    updated_at: "2026-10-30T00:00:00.000Z",
  });
  const v1Projection = projectPlanGaps("job-v1", { plan_protocol: v1Audit });
  assert.equal(v1Projection.availability, "available");
  assert.equal(v1Projection.audit?.goal, "Read the historical authentication boundary");

  const markdown = withPlanGapReport("native report", {
    v: 1,
    scope: "canvas_plan_audits",
    entries: [v2Projection, v1Projection],
    truncated: false,
    limit: 32,
  });
  assert.match(markdown, /Collect current boundary evidence/);
  assert.match(markdown, /boundary-evidence/);
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  assert.match(html, /Collect current boundary evidence/);
  assert.match(html, /Read the historical authentication boundary/);
  assert.match(html, /running/);
  assert.equal(withPlanGapReport("native report", undefined), "native report");
});
