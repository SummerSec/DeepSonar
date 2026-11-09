import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeTaskActions,
  isInterruptedJobReplaySafe,
  projectDashboardActions,
  projectFindingActions,
  projectJobActions,
  projectTaskActions,
  projectUnknownEffectAction,
  sortTaskActions,
} from "./task-actions";
import type { TaskAction } from "./types";

function action(partial: Partial<TaskAction> & Pick<TaskAction, "id" | "kind" | "priority">): TaskAction {
  return {
    title: partial.id,
    reason: "r",
    impact: "i",
    evidence_refs: partial.evidence_refs ?? [],
    recommended_action: "review_evidence",
    reversible: true,
    next_state: "needs_human",
    ...partial,
  };
}

test("actions classify conflict, human, repair, retry and unknown effect", () => {
  const rows = projectTaskActions({
    findings: [
      { id: "f1", title: "登录绕过", verify_status: "confirmed" },
      { id: "f2", title: "待确认项", verify_status: "needs_human" },
    ],
    facts: [
      { id: "a", verification: { finding_id: "f1", outcome: "supports" } },
      { id: "b", verification: { finding_id: "f1", outcome: "refutes" } },
      { id: "c", verification_status: "needs_human", finding: { id: "f2" } },
    ],
    jobs: [
      { id: "j1", type: "review", status: "waiting_human" },
      { id: "j2", type: "test", status: "failed", error: "schema mismatch" },
      { id: "j3", type: "explore", status: "timeout", replay_safe: true },
    ],
    interventions: [{ id: "h1", reason: "请确认复现步骤", findingId: "f2", jobId: "j1", pending: true }],
    reportStale: true,
  });

  assert.equal(rows[0]?.kind, "human_decision");
  assert.equal(rows[0]?.priority, "critical");
  assert.match(rows[0]?.title ?? "", /冲突/);
  assert.ok(!rows.some((row) => row.id === "finding:f2:needs_human"), "the concrete request replaces its generic Finding wait");
  assert.ok(rows.some((row) => row.id === "human:h1"));
  assert.ok(rows.some((row) => row.recommended_action === "reply_to_agent"));
  assert.ok(rows.some((row) => row.kind === "platform_blocker"));
  assert.ok(rows.some((row) => row.kind === "transient_retry"));
  assert.ok(rows.some((row) => row.id === "report:stale"));

  const unknown = projectUnknownEffectAction({ jobId: "j9", effectId: "e1", effectKind: "http_request" });
  assert.equal(unknown.kind, "unknown_effect");
  assert.equal(unknown.reversible, false);
  assert.equal(unknown.recommended_action, "confirm_unknown_effect");
  assert.equal(unknown.next_state, "needs_confirmation");
  assert.doesNotMatch(unknown.title, /失败/);
});

test("timeout or orphan without a proven effect ledger needs confirmation, not retry", () => {
  assert.equal(isInterruptedJobReplaySafe({ id: "j", status: "timeout" }), false);
  assert.equal(isInterruptedJobReplaySafe({
    id: "j",
    status: "timeout",
    replay_safe: true,
    unknown_effects: [{ effect_id: "e1", status: "unknown" }],
  }), false);
  assert.equal(isInterruptedJobReplaySafe({ id: "j", status: "orphan", replay_safe: true }), true);

  const unproven = projectTaskActions({
    jobs: [
      { id: "t1", type: "explore", status: "timeout" },
      { id: "o1", type: "review", status: "orphan" },
      {
        id: "t2",
        type: "test",
        status: "timeout",
        unknown_effects: [{ effect_id: "e9", effect_kind: "http_request", status: "effect_pending" }],
      },
    ],
  });
  assert.equal(unproven.length, 3);
  for (const row of unproven) {
    assert.equal(row.kind, "unknown_effect");
    assert.equal(row.recommended_action, "needs_confirmation");
    assert.equal(row.next_state, "needs_confirmation");
    assert.equal(row.reversible, false);
    assert.notEqual(row.recommended_action, "retry_same_session");
    assert.doesNotMatch(row.title, /可安全重试/);
  }
  assert.ok(unproven.some((row) => row.evidence_refs.includes("effect:e9")));

  const proven = projectTaskActions({
    jobs: [{ id: "t3", type: "explore", status: "timeout", replay_safe: true }],
  });
  assert.equal(proven[0]?.kind, "transient_retry");
  assert.equal(proven[0]?.recommended_action, "inspect_recovery");
});

test("dashboard and job projectors keep unproven timeout in needs_confirmation", () => {
  const dashboard = projectDashboardActions({
    jobs: [{ id: "j5", project_id: "p1", canvas_id: "c1", type: "test", status: "orphan" }],
    findings: [],
  });
  assert.equal(dashboard[0]?.kind, "unknown_effect");
  assert.equal(dashboard[0]?.recommended_action, "needs_confirmation");
  assert.equal(dashboard[0]?.href, "/projects/p1/tasks/c1?tab=jobs&job=j5");

  const job = projectJobActions({
    job: { id: "j6", type: "test", status: "timeout", error: "gateway timeout" },
    effects: [{ effect_id: "eff", effect_kind: "egress", status: "unknown" }],
  });
  assert.equal(job.repair?.category, "unknown_external_effect");
  assert.equal(job.actions[0]?.next_state, "needs_confirmation");
  assert.equal(job.actions[0]?.recommended_action, "needs_confirmation");

  const provenJob = projectJobActions({
    job: { id: "j7", type: "test", status: "timeout" },
    effects: [],
  });
  assert.equal(provenJob.repair?.category, "transient_retryable");
  assert.equal(provenJob.actions[0]?.recommended_action, "inspect_recovery");

  assert.equal(projectFindingActions({
    finding: { id: "f9", title: "旧失败", verify_status: "pending" },
    jobError: "old boom",
    jobStatus: "failed",
  })[0]?.kind, "human_decision");

  const settledProvision = projectJobActions({
    job: { id: "j8", type: "audit", status: "failed", error: "DOCKER::SANDBOX_START_FAILED" },
    effects: [{ effect_id: "provision:1", effect_kind: "provision", status: "settled" }],
  });
  assert.notEqual(settledProvision.repair?.category, "unknown_external_effect");
  assert.deepEqual(settledProvision.repair?.accepted_effects, ["provision ×1"]);
  assert.equal(settledProvision.repair?.unknown_effects.length, 0);
});

test("sort and dedupe keep a single highest-priority action per evidence", () => {
  const sorted = sortTaskActions([
    action({ id: "b", kind: "transient_retry", priority: "normal" }),
    action({ id: "a", kind: "human_decision", priority: "critical" }),
    action({ id: "c", kind: "model_repair", priority: "high" }),
  ]);
  assert.deepEqual(sorted.map((row) => row.id), ["a", "c", "b"]);

  const deduped = dedupeTaskActions([
    action({ id: "x", kind: "human_decision", priority: "high", evidence_refs: ["finding:1"] }),
    action({ id: "y", kind: "human_decision", priority: "normal", evidence_refs: ["finding:1"] }),
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.id, "x");
});


test("host current projection governs repair, human wait and recovery independently of historical errors", () => {
  const project = (status: string, allowed_actions: string[], blocker: string | null, error = "schema mismatch") =>
    projectTaskActions({ jobs: [{ id: "job", status, error,
      execution_state: { authority: "scheduler", status, allowed_actions, blocker } }] })[0];
  assert.equal(project("running", ["correct_proposal"], null)?.recommended_action, "correct_proposal");
  assert.equal(project("waiting_human", ["reconcile_effects"], "effects_require_reconciliation")?.kind, "unknown_effect");
  assert.equal(project("waiting_human", ["wait_for_human"], "human_already_accepted")?.recommended_action, "inspect_recovery", "without a human node, inspect the current state instead of guessing a reply");
  const platform = project("waiting_human", ["wait_for_platform", "request_recovery"], "platform_blocker_accepted");
  assert.equal(platform?.kind, "platform_blocker");
  assert.equal(platform?.recommended_action, "inspect_recovery", "configuration/authority repair is not an Agent reply or automatic resume");
  assert.notEqual(project("waiting_human", ["inspect_state"], "wait_subject_unknown")?.recommended_action, "reply_to_agent");
  assert.equal(project("failed", ["request_recovery"], "execution_inactive")?.recommended_action, "request_recovery");
  assert.equal(project("failed", ["inspect_state"], "REPAIR_DEADLINE_EXHAUSTED")?.recommended_action, "inspect_recovery");
  const ended = projectTaskActions({ jobs: [{ id: "ended", status: "failed", error: "invalid_payload" }] })[0];
  assert.equal(ended?.kind, "platform_blocker");
  assert.notEqual(ended?.recommended_action, "retry_same_session");
  assert.equal(ended?.next_state, "failed");
});

test("an accepted human request replaces its duplicate waiting_human projection", () => {
  const guidance = {
    question: "是否允许这项任务继续？",
    required_action: "在平台中确认授权范围",
    reply_instructions: "回复确认的范围，不要粘贴秘密",
    after_reply: "Agent 会按宿主准入重新提交",
  };
  const rows = projectTaskActions({
    jobs: [{
      id: "job-human",
      status: "waiting_human",
      execution_state: { authority: "scheduler", status: "waiting_human", allowed_actions: ["wait_for_human"], blocker: "human_already_accepted" },
    }],
    interventions: [{ id: "human-2", reason: "完整请求原因", findingId: "finding-2", jobId: "job-human", pending: true, guidance, guidanceStatus: "available", subjectKind: "business_decision", subjectLabel: "业务决定" }],
  });
  const humanBlockers = rows.filter((row) => row.evidence_refs.includes("job:job-human") && row.kind === "human_decision");
  assert.equal(humanBlockers.length, 1);
  assert.equal(humanBlockers[0]?.id, "human:human-2");
  assert.deepEqual(humanBlockers[0]?.human_request?.guidance, guidance);

  const missingRequest = projectTaskActions({ jobs: [{ id: "job-without-node", status: "waiting_human" }] });
  assert.equal(missingRequest[0]?.recommended_action, "inspect_recovery", "a missing human node must keep the real recovery projection visible");
});

test("unknown effects and independent finding conflicts survive human-request deduplication", () => {
  const human = { id: "human-3", reason: "授权请求", findingId: "finding-3", jobId: "job-3", pending: true };
  const reconciliation = projectTaskActions({
    jobs: [{
      id: "job-3",
      status: "waiting_human",
      execution_state: {
        authority: "scheduler",
        status: "waiting_human",
        allowed_actions: ["wait_for_human", "reconcile_effects"],
        blocker: "effects_require_reconciliation",
      },
    }],
    interventions: [human],
  });
  assert.equal(reconciliation[0]?.kind, "unknown_effect", "effect reconciliation keeps its higher priority");
  assert.ok(reconciliation.some((row) => row.id === "human:human-3"));

  const conflict = projectTaskActions({
    facts: [
      { id: "supports", verification: { finding_id: "finding-4", outcome: "supports" } },
      { id: "refutes", verification: { finding_id: "finding-4", outcome: "refutes" } },
    ],
    interventions: [{ id: "human-finding", reason: "请检查证据", findingId: "finding-4", pending: true }],
  });
  assert.ok(conflict.some((row) => row.id === "finding:finding-4:conflict"));
  assert.ok(conflict.some((row) => row.id === "human:human-finding"));
});

test("a finding request replaces its generic needs_human card while conflict evidence stays separate", () => {
  const rows = projectTaskActions({
    findings: [{ id: "finding-request", title: "待人工项目", verify_status: "needs_human" }],
    facts: [
      { id: "finding-support", verification: { finding_id: "finding-request", outcome: "supports" } },
      { id: "finding-refute", verification: { finding_id: "finding-request", outcome: "refutes" } },
    ],
    interventions: [{
      id: "human-finding-request",
      reason: "请先核对该 Finding 的复现路径",
      findingId: "finding-request",
      pending: true,
      subjectKind: "finding",
      subjectLabel: "证据判断",
    }],
  });
  assert.ok(rows.some((row) => row.id === "human:human-finding-request"));
  assert.ok(rows.some((row) => row.id === "finding:finding-request:conflict"));
  assert.ok(!rows.some((row) => row.id === "finding:finding-request:needs_human"));
});

test("credential and authorization blockers merge with the accepted human request card", () => {
  for (const [kind, subjectLabel] of [["credential", "凭据配置"], ["authorization", "授权确认"]] as const) {
    const rows = projectTaskActions({
      jobs: [{
        id: `job-${kind}`,
        status: "waiting_human",
        execution_state: {
          authority: "scheduler",
          status: "waiting_human",
          allowed_actions: ["wait_for_platform"],
          blocker: "platform_blocker_accepted",
        },
      }],
      interventions: [{
        id: `human-${kind}`,
        reason: "平台等待当前配置或授权请求",
        jobId: `job-${kind}`,
        pending: true,
        subjectKind: kind,
        subjectLabel,
      }],
    });
    const blockers = rows.filter((row) => row.evidence_refs.includes(`job:job-${kind}`));
    assert.equal(blockers.length, 1, `${kind} request and host projection represent one blocker`);
    assert.equal(blockers[0]?.kind, "platform_blocker");
    assert.equal(blockers[0]?.human_request?.subjectLabel, subjectLabel);
    assert.equal(blockers[0]?.recommended_action, "reply_to_agent");
  }
});
