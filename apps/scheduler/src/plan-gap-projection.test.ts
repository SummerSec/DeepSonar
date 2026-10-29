import assert from "node:assert/strict";
import test from "node:test";
import { Plan, mergePlanAudit, PlanResult } from "@deepsonar/shared-types";
import { projectPlanGaps, renderPlanGapReport } from "./domains/plan-protocol/gap-projection.js";

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
  assert.match(rendered, /````json/);
});
