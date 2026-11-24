import assert from "node:assert/strict";
import test from "node:test";
import { Plan, mergePlanAudit, PlanResult } from "@deepsonar/shared-types";
import { projectPlanGaps, renderPlanGapDetail, renderPlanGapReport, withPlanGapReport } from "./domains/plan-protocol/gap-projection.js";

const plan = Plan.parse({
  v: 1, goal: "Verify the scoped authentication behavior",
  tasks: [{ id: "auth", title: "Check authentication", role: "test",
    description: "Check scoped authentication", prompt: "Check the authorized authentication entry and record evidence.",
    expected_outputs: ["Scoped execution evidence"], from: ["00000000-0000-4000-8000-000000000001"] }],
  completion: { mode: "explicit_result", description: "Independent evidence must cover the authorized scope" },
});
const audit = mergePlanAudit(null, { source: "submit_plan", raw: plan, trimmed: plan }, "2026-10-29T00:00:00.000Z");

for (const reason of ["not_executed", "missing_account", "tool_failed", "budget_exhausted", "negative_claim", "positive_claim", "conflicting_evidence", "stale_source", "no_progress", "unknown_external_effect"]) {
  test(`${reason} never proves a completed criterion or a negative result`, () => {
    const record = mergePlanAudit(audit, {
      source: "submit_plan",
      result: PlanResult.parse({ v: 1, outcome: "complete", summary: "Agent asserts the goal is complete",
        termination_reason: reason, execution: [{ task_id: "auth", status: "done" }] }),
      termination_reason: reason,
    }, "2026-10-29T00:01:00.000Z");
    const projection = projectPlanGaps("job", { plan_protocol: record });
    assert.equal(projection.audit?.completion_assessment, "unknown");
    assert.equal(projection.audit?.tasks[0]?.completion_assessment, "unknown");
    assert.equal(projection.audit?.proposed_outcome, "complete");
    assert.equal(projection.audit?.proposed_termination_reason, reason);
    assert.deepEqual(projection, projectPlanGaps("job", JSON.parse(JSON.stringify({ plan_protocol: record }))));
    assert.ok(!JSON.stringify(projection).includes(plan.tasks[0]!.prompt));
  });
}

test("audit identity changes with source and absent/invalid is explicit", () => {
  assert.equal(projectPlanGaps("job", {}).availability, "absent");
  assert.equal(projectPlanGaps("job", { plan_protocol: {} }).availability, "invalid");
  const first = projectPlanGaps("job", { plan_protocol: audit });
  const second = projectPlanGaps("job", { plan_protocol: { ...audit, updated_at: "2026-10-29T00:02:00.000Z" } });
  assert.notEqual(first.audit?.source_sha256, second.audit?.source_sha256);
  assert.deepEqual(first.audit?.tasks[0]?.proposed_input_refs, plan.tasks[0]!.from);
});

test("replacement plan clears stale result without changing old audit", () => {
  const completed = mergePlanAudit(audit, { source: "submit_plan",
    result: PlanResult.parse({ v: 1, outcome: "complete", summary: "Agent asserts completion", termination_reason: "claimed_done" }),
    termination_reason: "claimed_done" });
  const next = mergePlanAudit(completed, { source: "submit_plan", raw: { ...plan, goal: "A newly scoped objective" } });
  assert.equal(next.result, null);
  assert.equal(next.termination_reason, null);
  assert.equal(completed.result?.outcome, "complete");
});

test("report exposes missing and truncated coverage; untrusted fences stay quoted", () => {
  assert.equal(renderPlanGapReport(undefined), "");
  const entry = projectPlanGaps("job", { plan_protocol: { ...audit, termination_reason: "```\nmisleading" } });
  const rendered = renderPlanGapReport({ v: 1, scope: "canvas_plan_audits", entries: [entry], truncated: true, limit: 32 });
  assert.match(rendered, /unknown/);
  assert.match(rendered, /覆盖不完整/);
  // #1251 评审：原始投影不再排进摘要，改由详情段追加在文末。
  assert.doesNotMatch(rendered, /```json/);
  assert.match(renderPlanGapDetail({ v: 1, scope: "canvas_plan_audits", entries: [entry], truncated: true, limit: 32 }), /```json/);
});

test("#1250 空计划审计只给可读结论，不再倾倒原始 JSON", () => {
  const rendered = renderPlanGapReport({ v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32 });
  assert.match(rendered, /没有可用的计划审计记录/);
  assert.match(rendered, /不能证明任务未执行或没有发现/);
  assert.match(rendered, /unknown/);
  assert.doesNotMatch(rendered, /json/);
});

test("#1250 有计划审计时先给摘要，原始投影下沉到详细数据", () => {
  const entry = projectPlanGaps("job", { plan_protocol: audit });
  const rendered = renderPlanGapReport({ v: 1, scope: "canvas_plan_audits", entries: [entry], truncated: false, limit: 32 });
  assert.match(rendered, /本画布关联了 1 份计划审计快照/);
  assert.doesNotMatch(rendered, /### 详细审计数据/u, "摘要段不再携带机器数据章节");
  assert.match(rendered, /任务数 1，判据 1 项/);
  assert.match(rendered, /整体 unknown（unknown 表示目前没有权威评审/);
  assert.doesNotMatch(rendered, /```json/);
  assert.match(renderPlanGapDetail({ v: 1, scope: "canvas_plan_audits", entries: [entry], truncated: false, limit: 32 }), /```json/);
});

test("#1251 冻结快照里的内联链接与图片按纯文本渲染", async () => {
  const { renderPlanGapReport, projectPlanGaps } = await import("./domains/plan-protocol/gap-projection.js");
  const { PlanAuditRecord } = await import("@deepsonar/shared-types");
  const audit = PlanAuditRecord.parse({ v: 1, source: "submit_plan", raw: {
    v: 1, goal: "阅读 [文档](note-a) 与 ![图](shot-b.png) 后核对",
    assumptions: [], tasks: [{ id: "read", title: "阅读外部文档并核对边界条件", role: "test", description: "阅读并核对已授权文档的边界条款",
      prompt: "阅读已授权文档并核对边界条件，保留原始链接与截图来源记录，供后续独立复核使用。", from: [], depends_on: [], inputs: [],
      expected_outputs: ["notes"] }],
    completion: { mode: "explicit_result", description: "核对记录已保留并可供复核", required_outputs: ["notes"] },
    budget: { max_tasks: 2 }, open_questions: [] }, trimmed: null, trim_reasons: [], result: null,
    termination_reason: null, updated_at: "2026-11-24T00:00:00.000Z" });
  const rendered = renderPlanGapReport({ v: 1, scope: "canvas_plan_audits", entries: [projectPlanGaps("job-link", { plan_protocol: audit })], truncated: false, limit: 32 });
  assert.ok(rendered.includes("\\[文档\\](note-a)"), "内联链接的方括号必须转义");
  assert.ok(rendered.includes("!\\[图\\](shot-b.png)"), "图片语法同样必须转义");
});

test("#1251 可信区块整体前置：结果 → 审计摘要 → 原始投影 → 不可信正文", () => {
  const entry = projectPlanGaps("job", { plan_protocol: audit });
  const report = { v: 1 as const, scope: "canvas_plan_audits" as const, entries: [entry], truncated: false, limit: 32 };
  const markdown = withPlanGapReport({ trusted: "# 任务结果\n\n任务做完了什么。", untrusted: "## 模型正文\n\n自述内容。" }, report);
  const trusted = markdown.indexOf("# 任务结果");
  const summary = markdown.indexOf("## 目标与缺口");
  const detail = markdown.indexOf("### 详细审计数据");
  const untrusted = markdown.indexOf("## 模型正文");
  assert.ok(trusted === 0, "平台结果必须首屏可见");
  assert.ok(trusted < summary && summary < detail && detail < untrusted,
    `顺序应为结果→摘要→投影→正文，实际 ${trusted}/${summary}/${detail}/${untrusted}`);
});

test("#1251 未闭合的不可信尾部吞不掉任何可信区块", () => {
  const entry = projectPlanGaps("job", { plan_protocol: audit });
  const report = { v: 1 as const, scope: "canvas_plan_audits" as const, entries: [entry], truncated: false, limit: 32 };
  for (const tail of ["```", "```json", "~~~~md", "<!--", "<div hidden>", "<details>"]) {
    const markdown = withPlanGapReport({ trusted: "# 任务结果\n\n结论。", untrusted: `## 模型正文\n\n自述\n\n${tail}` }, report);
    const summary = markdown.indexOf("## 目标与缺口");
    const detail = markdown.indexOf("### 详细审计数据");
    assert.ok(summary > 0 && detail > summary, `${tail}：摘要与投影必须保留在不可信正文之前`);
    assert.ok(markdown.trimEnd().endsWith(tail), `${tail}：不可信尾部保持原样留在文末`);
    assert.doesNotMatch(markdown.slice(detail), /目标与缺口|任务结果/u, "详情段之后只有不可信正文");
  }
});

test("#1251 冻结快照文本按纯文本渲染，不能注入 Markdown 结构", () => {
  const entry = projectPlanGaps("job", { plan_protocol: { ...audit,
    termination_reason: "```\n# 伪造标题", raw: { ...(audit.raw ?? {}), goal: "目标里有 <img src=x> 与 `反引号`" } } });
  const report = { v: 1 as const, scope: "canvas_plan_audits" as const, entries: [entry], truncated: false, limit: 32 };
  const rendered = renderPlanGapReport(report);
  const summary = rendered.split("\n").filter((line) => line.includes("目标原文") || line.includes("结束理由")).join("\n");
  assert.doesNotMatch(summary, /<img/u, "尖括号必须转义");
  assert.doesNotMatch(summary, /`/u, "反引号不能留下");
  assert.match(summary, /&lt;img/u);
});
