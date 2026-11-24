import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanAuditRecord } from "@deepsonar/shared-types";
import { MarkdownView } from "./MarkdownView.js";
import { projectPlanGaps, withPlanGapReport } from "../../scheduler/src/domains/plan-protocol/gap-projection.js";

for (const tail of ["<!--", "```", "````json", "~~~html", "<script>", "<div hidden>"]) {
  test(`gap section is visibly rendered before an unclosed model tail ${JSON.stringify(tail)}`, () => {
    const markdown = withPlanGapReport({ trusted: "## 结论\n\n任务做完了什么。", untrusted: `## 已确认问题\n\nfinding-id\n\n${tail}` }, {
      v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32,
    });
    const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
    const outsideCode = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, "");
    assert.match(outsideCode, /目标与缺口（只读计划审计）/);
    assert.match(outsideCode, /unknown/);
    assert.ok(markdown.indexOf("## 目标与缺口") < markdown.indexOf(tail), "审计段必须早于不可信正文");
    assert.match(outsideCode, /任务做完了什么/u, "平台结论必须可读");
    assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<div hidden>/);
  });
}

test("#1251 冻结快照里的内联链接与图片在页面上不生成链接或图片", async () => {
  const audit = { v: 1 as const, source: "submit_plan", trim_reasons: [], result: null, termination_reason: null,
    updated_at: "2026-11-24T00:00:00.000Z", trimmed: null,
    raw: { v: 1 as const, goal: "阅读 [文档](note-a) 与 ![图](shot-b.png) 后核对边界", assumptions: [],
      tasks: [{ id: "read", title: "阅读外部文档并核对边界条件", role: "test", description: "阅读并核对已授权文档的边界条款",
        prompt: "阅读已授权文档并核对边界条件，保留原始链接与截图来源记录，供后续独立复核使用。", from: [], depends_on: [], inputs: [],
        expected_outputs: ["notes"] }],
      completion: { mode: "explicit_result" as const, description: "核对记录已保留并可供复核", required_outputs: ["notes"] },
      budget: { max_tasks: 2 }, open_questions: [] } };
  const markdown = withPlanGapReport({ trusted: "## 结论\n\n任务已按计划完成初检。" },
    { v: 1, scope: "canvas_plan_audits", entries: [projectPlanGaps("job-link", { plan_protocol: audit as never })], truncated: false, limit: 32 });
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  assert.doesNotMatch(html, /<a\s[^>]*href=/iu, "冻结快照里的链接不能变成真实链接");
  assert.doesNotMatch(html, /<img\s/iu, "冻结快照里的图片语法不能变成图片");
  assert.match(html, /文档/u, "正文语义仍要可读");
});

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
  const markdown = withPlanGapReport({ trusted: "## 结论\n\n任务做完了什么。", untrusted: "## 模型正文\n\n自述内容。" }, {
    v: 1, scope: "canvas_plan_audits", entries: [projectPlanGaps("job-gap", { plan_protocol: audit })], truncated: false, limit: 32,
  });
  const conclusion = markdown.indexOf("## 结论");
  const summary = markdown.indexOf("## 目标与缺口");
  const detail = markdown.indexOf("### 详细审计数据");
  const untrusted = markdown.indexOf("## 模型正文");
  assert.ok(conclusion === 0 && summary > conclusion && detail > summary && untrusted > detail,
    `顺序应为 结论→审计摘要→详情→模型正文，实际 ${conclusion}/${summary}/${detail}/${untrusted}`);
  assert.ok(markdown.trimEnd().endsWith("自述内容。"), "不可信正文必须留在最末");
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown, controls: false }));
  // 页面顺序与 Markdown 一致：平台结论 → 审计摘要 → 机器数据 → 模型正文。
  const conclusionAt = html.indexOf("任务做完了什么");
  const summaryAt = html.indexOf("目标与缺口（只读计划审计）");
  const detailAt = html.indexOf("产品投影，给排查用");
  const untrustedAt = html.indexOf("自述内容");
  assert.ok(conclusionAt >= 0 && summaryAt > conclusionAt && detailAt > summaryAt && untrustedAt > detailAt,
    `页面顺序应为 结论→摘要→数据→正文，实际 ${conclusionAt}/${summaryAt}/${detailAt}/${untrustedAt}`);
});

test("projection text remains escaped inside its own rendered JSON fence", () => {
  const markdown = withPlanGapReport({ trusted: "Report body" }, {
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

  const markdown = withPlanGapReport({ trusted: "native report" }, {
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
  assert.equal(withPlanGapReport({ trusted: "native report" }, undefined), "native report");
});

test("#1256 报告里的知识标题在页面渲染时不会变成链接或图片", async () => {
  const { renderKnowledgeRefsSection } = await import("../../scheduler/src/report.js");
  const section = renderKnowledgeRefsSection([{
    item_id: "item-1", version_id: "ver-1", kind: "memory",
    title: "[点我](note-a) 与 ![图](shot.png)", version: 2,
    content_sha256: "a".repeat(64), reads: 2, outcome: null,
  }]);
  const html = renderToStaticMarkup(createElement(MarkdownView, { markdown: `## 结论\n\n任务已完成。\n\n${section}`, controls: false }));
  assert.doesNotMatch(html, /<a\s[^>]*href=/iu, "标题里的链接语法不能生成真实链接");
  assert.doesNotMatch(html, /<img\s/iu, "标题里的图片语法不能生成图片");
  assert.match(html, /点我/u, "标题文字仍要可读");
});
