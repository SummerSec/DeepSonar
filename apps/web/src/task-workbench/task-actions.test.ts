import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeTaskActions,
  isInterruptedJobReplaySafe,
  projectTaskActions,
  projectTaskNextSteps,
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
  assert.ok(rows.some((row) => row.id === "finding:f2:needs_human"));
  assert.ok(rows.some((row) => row.recommended_action === "reply_to_agent"));
  assert.ok(rows.some((row) => row.kind === "model_repair"));
  assert.ok(rows.some((row) => row.kind === "transient_retry"));
  assert.ok(rows.some((row) => row.id === "report:stale"));

  const unknown = projectUnknownEffectAction({ jobId: "j9", effectId: "e1", effectKind: "http_request" });
  assert.equal(unknown.kind, "unknown_effect");
  assert.equal(unknown.reversible, false);
  assert.equal(unknown.recommended_action, "confirm_unknown_effect");
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
  assert.equal(proven[0]?.recommended_action, "retry_same_session");
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

test("next steps fall back when there is nothing to decide", () => {
  assert.deepEqual(projectTaskNextSteps([]), ["当前没有需要你处理的事项，系统会按已有证据继续收敛"]);
  assert.equal(projectTaskNextSteps([action({ id: "a", kind: "human_decision", priority: "high", title: "先看冲突" })]).length, 1);
});
