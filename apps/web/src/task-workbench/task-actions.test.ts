import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeTaskActions,
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
      { id: "j3", type: "explore", status: "timeout" },
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
