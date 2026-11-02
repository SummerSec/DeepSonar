import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEffect,
  settlementWrite,
  summarizeEvidence,
  type EffectEvidence,
} from "./reconcile-effects.js";

const evidence = (overrides: Partial<EffectEvidence> = {}): EffectEvidence => ({
  id: "effect-1",
  effectKind: "agent_run",
  attemptStatus: "failed",
  sandboxId: null,
  usageRows: 0,
  canvasNodeId: null,
  ...overrides,
});

test("a terminal attempt proves an agent_run outcome", () => {
  for (const status of ["succeeded", "failed", "cancelled", "timeout", "orphan", "interrupted"]) {
    const result = classifyEffect(evidence({ attemptStatus: status }));
    if (status === "interrupted") {
      assert.equal(result.decision, "undecided", "interrupted is not terminal: the attempt may resume");
      continue;
    }
    assert.deepEqual(result, { decision: "auto", rule: "attempt_terminal", settlement: { outcome: "applied_run_terminated", attempt_status: status } });
  }
});

test("gateway_model_request is only settled when the usage ledger recorded the request", () => {
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "gateway_model_request", usageRows: 3 })),
    { decision: "auto", rule: "usage_ledger_recorded", settlement: { outcome: "applied_with_usage", usage_rows: 3 } },
  );
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "gateway_model_request", usageRows: 0 })),
    { decision: "undecided", rule: "usage_ledger_missing", missing: ["job_usage_ledger_row"] },
  );
});

test("provision is decided by whether a sandbox identity was ever recorded", () => {
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "provision", sandboxId: "sandbox-9" })),
    { decision: "auto", rule: "sandbox_identity_recorded", settlement: { outcome: "applied_resource_absent" } },
  );
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "provision", sandboxId: null })),
    { decision: "auto", rule: "sandbox_identity_absent", settlement: { outcome: "not_applied" } },
  );
  // An empty or padded identity is not evidence of creation.
  assert.equal(classifyEffect(evidence({ effectKind: "provision", sandboxId: "   " })).decision, "auto");
  assert.deepEqual(classifyEffect(evidence({ effectKind: "provision", sandboxId: "  " })).rule, "sandbox_identity_absent");
});

test("canvas_delivery needs the delivered node, and unknown kinds are never guessed", () => {
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "canvas_delivery", canvasNodeId: "node-7" })),
    { decision: "auto", rule: "canvas_node_present", settlement: { outcome: "delivered", canvas_node_id: "node-7" } },
  );
  assert.equal(classifyEffect(evidence({ effectKind: "canvas_delivery", canvasNodeId: null })).decision, "undecided");
  assert.deepEqual(
    classifyEffect(evidence({ effectKind: "provider_upload", attemptStatus: "failed" })),
    { decision: "undecided", rule: "unclassified_effect_kind", missing: ["evidence_rule_for:provider_upload"] },
  );
});

test("the summary compresses hundreds of rows into few lines and lists only the residue", () => {
  const rows: EffectEvidence[] = [
    ...Array.from({ length: 250 }, (_, index) => evidence({ id: `agent-${index}`, attemptStatus: "failed" })),
    ...Array.from({ length: 31 }, (_, index) => evidence({ id: `usage-${index}`, effectKind: "gateway_model_request", usageRows: 2 })),
    ...Array.from({ length: 26 }, (_, index) => evidence({ id: `provision-${index}`, effectKind: "provision", sandboxId: null })),
    ...Array.from({ length: 15 }, (_, index) => evidence({ id: `canvas-${index}`, effectKind: "canvas_delivery", canvasNodeId: `node-${index}` })),
    evidence({ id: "undecided-usage", effectKind: "gateway_model_request", usageRows: 0 }),
    evidence({ id: "undecided-kind", effectKind: "provider_upload" }),
  ];
  const summary = summarizeEvidence(rows);
  assert.equal(summary.unknown_total, 324);
  assert.equal(summary.auto_count, 322);
  assert.equal(summary.undecided_count, 2, "a human reads two decisions, not 324 rows");
  assert.deepEqual(summary.undecided.map((row) => row.effect_id), ["undecided-usage", "undecided-kind"]);
  assert.deepEqual(summary.undecided[0].missing, ["job_usage_ledger_row"]);
  assert.equal(summary.groups.length, 4, "one line per kind/rule/outcome");
  assert.deepEqual(
    summary.groups.map((group) => [group.effect_kind, group.outcome, group.count]),
    [
      ["agent_run", "applied_run_terminated", 250],
      ["canvas_delivery", "delivered", 15],
      ["gateway_model_request", "applied_with_usage", 31],
      ["provision", "not_applied", 26],
    ],
  );
});

test("an empty scan is a valid result, not an error", () => {
  assert.deepEqual(summarizeEvidence([]), { unknown_total: 0, auto_count: 0, undecided_count: 0, groups: [], undecided: [] });
});

test("settlement writes carry the operation id for audit and never invent an outcome", () => {
  const write = settlementWrite(evidence(), { outcome: "applied_run_terminated", attempt_status: "failed" }, "op-42");
  assert.deepEqual(write, {
    id: "effect-1",
    effect_kind: "agent_run",
    settlement: { outcome: "applied_run_terminated", attempt_status: "failed", reconciled_by: "reconcile-effects", reconcile_operation_id: "op-42" },
  });
});