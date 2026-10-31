import assert from "node:assert/strict";
import test from "node:test";
import {
  isReportStale,
  projectCognitionStatus,
  projectCoveredScope,
  projectDeliveryStatus,
  projectTaskOutcomeSummary,
  projectTaskStatusLines,
  projectUncoveredScope,
} from "./task-outcome";

const lifecycle = { status: "running" as const, label: "进行中", activeCount: 1 };

test("outcome counts, stale report and coverage come from findings and facts", () => {
  const findings = [
    { id: "f1", title: "登录绕过", verify_status: "confirmed", profile: "security", category: "auth", location: "login.ts", updated_at: "2026-09-11T12:00:00.000Z" },
    { id: "f2", title: "验证码可重放", verify_status: "pending", profile: "security", category: "otp", created_at: "2026-09-11T13:00:00.000Z" },
    { id: "f3", title: "待人工项", verify_status: "needs_human", profile: "quality" },
  ];
  const facts = [
    { id: "a", verification: { finding_id: "f1", outcome: "supports" }, updated_at: "2026-09-11T11:00:00.000Z" },
    { id: "b", verification: { finding_id: "f1", outcome: "refutes" }, updated_at: "2026-09-11T11:30:00.000Z" },
    { id: "c", verification_status: "needs_human", finding: { id: "f3" } },
  ];
  const report = { version: 2, status: "succeeded", generated_at: "2026-09-11T12:30:00.000Z", updated_at: "2026-09-11T12:30:00.000Z" };

  const outcome = projectTaskOutcomeSummary({
    objective: "确认登录绕过是否可复现",
    lifecycle,
    findings,
    facts,
    report,
    now: "2026-09-11T14:00:00.000Z",
  });

  assert.equal(outcome.confirmed_count, 1);
  assert.equal(outcome.pending_verification_count, 1);
  assert.equal(outcome.needs_human_count, 2);
  assert.equal(outcome.conflict_count, 1);
  assert.equal(outcome.current_report_version, 2);
  assert.equal(outcome.report_stale, true);
  assert.deepEqual(outcome.covered_scope, ["领域：security", "类别：auth", "位置：login.ts"]);
  assert.ok(outcome.uncovered_scope.some((item) => item.includes("验证码可重放")));
  assert.match(outcome.lifecycle_reason, /冲突/);
  assert.equal(outcome.last_updated_at, "2026-09-11T13:00:00.000Z");
});

test("a succeeded report is not stale when evidence is older", () => {
  assert.equal(
    isReportStale(
      { version: 1, status: "succeeded", generated_at: "2026-09-11T12:00:00.000Z" },
      [{ id: "f1", verify_status: "confirmed", updated_at: "2026-09-11T11:00:00.000Z" }],
    ),
    false,
  );
  assert.equal(isReportStale({ version: 1, status: "generating" }, [{ id: "f1", updated_at: "2026-09-11T13:00:00.000Z" }]), false);
});

test("status lines keep execution, cognition and delivery independent", () => {
  const covered = projectCoveredScope([{ id: "f1", verify_status: "confirmed", profile: "security" }]);
  const uncovered = projectUncoveredScope(
    [{ id: "f1", verify_status: "confirmed", profile: "security" }, { id: "f2", title: "缺口", verify_status: "pending", profile: "quality" }],
    covered,
  );
  assert.deepEqual(covered, ["领域：security"]);
  assert.ok(uncovered.includes("待验证：缺口"));

  assert.equal(projectCognitionStatus({ confirmed_count: 0, pending_verification_count: 0, needs_human_count: 1, conflict_count: 1, refuted_count: 0 }), "needs_human");
  assert.equal(projectCognitionStatus({ confirmed_count: 1, pending_verification_count: 0, needs_human_count: 0, conflict_count: 1, refuted_count: 0 }), "conflict");
  assert.equal(projectCognitionStatus({ confirmed_count: 1, pending_verification_count: 0, needs_human_count: 0, conflict_count: 0, refuted_count: 0 }), "supported");
  assert.equal(projectCognitionStatus({ confirmed_count: 0, pending_verification_count: 0, needs_human_count: 0, conflict_count: 0, refuted_count: 2 }), "refuted");
  assert.equal(projectDeliveryStatus(null, false), "none");
  assert.equal(projectDeliveryStatus({ version: 1, status: "succeeded" }, true), "stale");
  assert.equal(projectDeliveryStatus({ version: 1, status: "succeeded" }, false), "delivered");
  assert.equal(projectDeliveryStatus({ version: 1, status: "generating" }, false), "draft");

  const lines = projectTaskStatusLines("completed", "conflict", "stale");
  assert.equal(lines.execution.label, "已完成");
  assert.equal(lines.cognition.label, "冲突");
  assert.equal(lines.delivery.label, "报告过时");
});
