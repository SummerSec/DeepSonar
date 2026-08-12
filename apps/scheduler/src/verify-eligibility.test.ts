import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_PRIORITY,
  isSeverityInVerifyScope,
  fixedPriorityForJob,
  priorityMatchesJob,
  shouldWakeEvidenceHub,
} from "./core.js";
import { graphEligibilityReason, loadGraphEligibilityBatch } from "./dispatcher.js";
import { classifyTaskReportAvailability } from "./report.js";

test("Verify scope uses only explicit known lower severities as exclusions", () => {
  assert.equal(isSeverityInVerifyScope("high", "critical"), true);
  assert.equal(isSeverityInVerifyScope("high", "high"), true);
  assert.equal(isSeverityInVerifyScope("high", "medium"), false);
  assert.equal(isSeverityInVerifyScope("info", "low"), true, "info keeps the existing full strict mode");
  assert.equal(isSeverityInVerifyScope("high", null), true, "unscored Findings stay in scope");
  assert.equal(isSeverityInVerifyScope("high", "future-severity"), true, "unknown values stay in scope");
});

test("报告可用性按服务端完成门返回阈值内阻塞 Finding", () => {
  const availability = classifyTaskReportAvailability({
    rootStatus: "analysis_complete",
    minVerifySeverity: "high",
    blockers: ["finding:finding-1:pending"],
    problems: [{
      finding_id: "finding-1",
      title: "未收敛问题",
      severity: "high",
      verify_status: "pending",
      issue: "Finding 未收敛",
      in_care_scope: true,
    }, {
      finding_id: "finding-1",
      title: "重复问题",
      severity: "high",
      verify_status: "pending",
      issue: "重复阻塞原因",
      in_care_scope: true,
    }, {
      finding_id: "finding-low",
      title: "策略排除项",
      severity: "medium",
      verify_status: "pending",
      issue: "低于阈值",
      in_care_scope: false,
    }],
  });
  assert.equal(availability.reason, "findings_not_converged");
  assert.equal(availability.min_verify_severity, "high");
  assert.deepEqual(availability.blocking_findings.map((finding) => finding.finding_id), ["finding-1"]);
});

test("five Hub rounds do not inflate child or Verify priority", () => {
  const hub = Array.from({ length: 5 }, () => fixedPriorityForJob({ type: "hub_reason" }));
  const role = Array.from({ length: 5 }, () =>
    fixedPriorityForJob({ type: "review", purpose: "discovery" }),
  );
  const verify = Array.from({ length: 5 }, () =>
    fixedPriorityForJob({ type: "verify_finding", purpose: "verify", severity: "high" }),
  );
  assert.deepEqual(hub, Array(5).fill(FIXED_PRIORITY.hub));
  assert.deepEqual(role, Array(5).fill(FIXED_PRIORITY.role));
  assert.deepEqual(verify, Array(5).fill(FIXED_PRIORITY.verifyHigh));
  assert.ok(FIXED_PRIORITY.hub > FIXED_PRIORITY.verifyHigh);
  assert.ok(FIXED_PRIORITY.verifyHigh > FIXED_PRIORITY.role);
});

test("Verify severity ordering is critical > high > medium and roles are FIFO ties", () => {
  const jobs = [
    { id: "role-new", type: "audit", purpose: "discovery", created: 3 },
    { id: "verify-medium", type: "verify_finding", purpose: "verify", severity: "medium", created: 1 },
    { id: "role-old", type: "test", purpose: "discovery", created: 1 },
    { id: "verify-critical", type: "verify_finding", purpose: "verify", severity: "critical", created: 2 },
    { id: "verify-high", type: "verify_finding", purpose: "verify", severity: "high", created: 0 },
  ];
  const ordered = jobs
    .map((job) => ({ ...job, priority: fixedPriorityForJob(job) }))
    .sort((a, b) => b.priority - a.priority || a.created - b.created || a.id.localeCompare(b.id));
  assert.deepEqual(ordered.map((job) => job.id), [
    "verify-critical",
    "verify-high",
    "role-old",
    "role-new",
    "verify-medium",
  ]);
  assert.equal(
    fixedPriorityForJob({ type: "review", purpose: "discovery" }),
    fixedPriorityForJob({ type: "audit", purpose: "discovery" }),
  );
});

test("Hub eligibility blocks active Hub, role, and waiting-human work", () => {
  const base = { type: "hub_reason" } as const;
  assert.equal(graphEligibilityReason(base, { activeHub: true }), "hub_active");
  assert.equal(graphEligibilityReason(base, { pendingHubOlder: true }), "hub_pending_older");
  assert.equal(graphEligibilityReason(base, { activeWaitingHuman: true }), "waiting_human");
  assert.equal(graphEligibilityReason(base, { activeRole: true }), "canvas_busy");
  assert.equal(graphEligibilityReason(base, {}), null);
  assert.equal(graphEligibilityReason({ type: "report" }, { pendingReportOlder: true }), "report_pending_older");
  assert.equal(graphEligibilityReason({ type: "report" }, { rootStatus: "analysis_complete" }), null);
  assert.equal(
    graphEligibilityReason({ type: "report", payload_json: { kind: "task_report" } }, { rootStatus: "running" }),
    "report_gate",
  );
  assert.equal(
    graphEligibilityReason({ type: "report", payload_json: { kind: "finding_report" } }, { rootStatus: "running" }),
    null,
  );
  assert.equal(
    graphEligibilityReason({ type: "report", payload_json: '{"kind":"finding_report"}' }, { rootStatus: "running" }),
    null,
  );
  assert.equal(
    graphEligibilityReason(
      { type: "report", payload_json: { kind: "finding_report" } },
      { rootStatus: "running", activeCanvasJob: true },
    ),
    null,
  );
});

test("evidence-wait wakeup is edge-triggered and does not churn", () => {
  assert.equal(graphEligibilityReason({ type: "verify_finding" }, { waitingEvidence: true }), "waiting_evidence");
  assert.equal(shouldWakeEvidenceHub(null, "empty"), true);
  assert.equal(shouldWakeEvidenceHub("same", "same"), false);
  assert.equal(shouldWakeEvidenceHub("old", "new"), true);
  assert.equal(
    priorityMatchesJob({ type: "verify_finding", purpose: "verify", severity: "high" }, FIXED_PRIORITY.verifyHigh),
    true,
  );
  assert.equal(
    priorityMatchesJob({ type: "verify_finding", purpose: "verify", severity: "high" }, FIXED_PRIORITY.hub),
    false,
  );
});

test("pending Verify graph facts are loaded in one bounded-page query", async () => {
  let calls = 0;
  const verifyId = "00000000-0000-0000-0000-000000000001";
  const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings;
    calls += 1;
    const ids = values.find((value) => Array.isArray(value)) as string[] | undefined;
    return Promise.resolve([{ verify_job_id: ids?.[0] ?? verifyId }]);
  }) as unknown as Parameters<typeof loadGraphEligibilityBatch>[0];
  const batch = await loadGraphEligibilityBatch(fakeTx, [
    { id: verifyId, type: "verify_finding" } as never,
    { id: "role-id", type: "review" } as never,
  ]);
  assert.equal(calls, 1);
  assert.equal(batch.verifyWaitingIds.has(verifyId), true);
});

test("Hub and Report graph facts are batched per canvas without join fanout", async () => {
  let calls = 0;
  const canvasId = "00000000-0000-0000-0000-000000000099";
  const hubIds = Array.from({ length: 50 }, (_, i) => `hub-${i}`);
  const reportIds = Array.from({ length: 50 }, (_, i) => `report-${i}`);
  const pending = [
    ...hubIds.map((id) => ({ id, type: "hub_reason", canvas_id: canvasId })),
    ...reportIds.map((id) => ({ id, type: "report", canvas_id: canvasId })),
  ] as never[];
  const fakeTx = ((strings: TemplateStringsArray) => {
    const text = strings.join("");
    calls += 1;
    if (text.includes("node_state") && text.includes("job_state")) {
      return Promise.resolve([{
        canvas_id: canvasId,
        root_status: "analysis_complete",
        active_hub: false,
        active_waiting_human: false,
        active_role: false,
        active_canvas_job: false,
      }]);
    }
    if (text.includes("array_agg") && text.includes("oldest_hub_id")) {
      return Promise.resolve([{
        canvas_id: canvasId,
        oldest_hub_id: hubIds[0],
        oldest_task_report_id: reportIds[0],
        oldest_finding_report_id: reportIds[0],
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof loadGraphEligibilityBatch>[0];

  const batch = await loadGraphEligibilityBatch(fakeTx, pending);
  assert.equal(calls, 2, "one pre-aggregated system query plus one oldest query per page");
  assert.equal(batch.systemStates.size, pending.length);
  assert.equal(batch.systemStates.get(hubIds[0])?.pendingHubOlder, false);
  assert.equal(batch.systemStates.get(hubIds[1])?.pendingHubOlder, true);
  assert.equal(batch.systemStates.get(reportIds[0])?.pendingReportOlder, false);
  assert.equal(batch.systemStates.get(reportIds[1])?.pendingReportOlder, true);
});

test("Report FIFO is scoped so a gated task report cannot starve a finding report", async () => {
  const canvasId = "00000000-0000-0000-0000-000000000100";
  const taskReportId = "00000000-0000-0000-0000-000000000101";
  const findingReportId = "00000000-0000-0000-0000-000000000102";
  const pending = [
    { id: taskReportId, type: "report", canvas_id: canvasId, payload_json: { kind: "task_report" } },
    { id: findingReportId, type: "report", canvas_id: canvasId, payload_json: { kind: "finding_report" } },
  ] as never[];
  const fakeTx = ((strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("node_state") && text.includes("job_state")) {
      return Promise.resolve([{
        canvas_id: canvasId,
        root_status: "running",
        active_hub: false,
        active_waiting_human: false,
        active_role: false,
        active_canvas_job: false,
      }]);
    }
    if (text.includes("oldest_task_report_id") && text.includes("oldest_finding_report_id")) {
      return Promise.resolve([{
        canvas_id: canvasId,
        oldest_task_report_id: taskReportId,
        oldest_finding_report_id: findingReportId,
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof loadGraphEligibilityBatch>[0];

  const batch = await loadGraphEligibilityBatch(fakeTx, pending);
  const taskState = batch.systemStates.get(taskReportId);
  const findingState = batch.systemStates.get(findingReportId);
  assert.equal(taskState?.pendingReportOlder, false);
  assert.equal(findingState?.pendingReportOlder, false);
  assert.equal(graphEligibilityReason(pending[0], taskState ?? {}), "report_gate");
  assert.equal(graphEligibilityReason(pending[1], findingState ?? {}), null);
});
