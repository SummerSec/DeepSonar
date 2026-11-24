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

test("#1251 报告正文在结论之后、原始投影在最末", () => {
  const entry = projectPlanGaps("job", { plan_protocol: audit });
  const report = { v: 1 as const, scope: "canvas_plan_audits" as const, entries: [entry], truncated: false, limit: 32 };
  const markdown = withPlanGapReport("# 任务结果\n\n任务做完了什么。", report);
  const summary = markdown.indexOf("## 目标与缺口");
  const body = markdown.indexOf("# 任务结果");
  const detail = markdown.indexOf("### 详细审计数据");
  assert.ok(summary < body && body < detail, `顺序应为摘要→正文→详情，实际 ${summary}/${body}/${detail}`);
  assert.ok(markdown.trimEnd().endsWith("```"), "原始投影必须在文末");
});

test("#1251 正文存在未闭合结构时不追加机器数据，改用下载指引", () => {
  const entry = projectPlanGaps("job", { plan_protocol: audit });
  const report = { v: 1 as const, scope: "canvas_plan_audits" as const, entries: [entry], truncated: false, limit: 32 };
  for (const tail of ["```", "```json", "~~~~md", "<!--", "<div hidden>", "<details>"]) {
    const markdown = withPlanGapReport(`# 任务结果\n\n正文\n\n${tail}`, report);
    assert.doesNotMatch(markdown, /### 详细审计数据/u, `未闭合 ${tail} 时不应追加详情`);
    assert.match(markdown, /原始投影未随正文附在文末/u);
    assert.ok(markdown.trimEnd().endsWith("读取。"), "指引必须留在文末，正文本身保持原样");
  }
  const closed = withPlanGapReport("# 任务结果\n\n```\ncode\n```\n\n<div>ok</div>", report);
  assert.match(closed, /### 详细审计数据/u, "结构闭合时仍应附上详情");
});
