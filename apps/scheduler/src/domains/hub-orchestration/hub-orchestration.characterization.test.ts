import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createHubOrchestrationApplication,
  isHubRoundWithinBudget,
  shouldConsiderHubTrigger,
  shouldWakeEvidenceHub,
} from "./application.js";

test("Hub evidence wakeups and round budgets remain edge-triggered", () => {
  assert.equal(shouldWakeEvidenceHub(null, "evidence-v1"), true);
  assert.equal(shouldWakeEvidenceHub("evidence-v1", "evidence-v1"), false);
  assert.equal(shouldWakeEvidenceHub("evidence-v1", "evidence-v2"), true);
  assert.equal(isHubRoundWithinBudget(0, 1), true);
  assert.equal(isHubRoundWithinBudget(1, 1), false);
  assert.equal(isHubRoundWithinBudget(5, 3), false);
});

test("Hub trigger policy preserves non-recursive and explicit wake paths", () => {
  assert.equal(shouldConsiderHubTrigger("hub_reason", {}), false);
  assert.equal(shouldConsiderHubTrigger("hub_reason", { idleWake: true }), true);
  assert.equal(shouldConsiderHubTrigger("hub_reason", { force: true }), true);
  assert.equal(shouldConsiderHubTrigger("audit", {}), true);
});

test("Hub application keeps no-op guards before touching the transaction", async () => {
  let queryCount = 0;
  const fakeTx = ((..._args: unknown[]) => {
    queryCount += 1;
    return Promise.resolve([]);
  }) as never;
  const app = createHubOrchestrationApplication(fakeTx, {
    rulesForProject: async () => ({
      minVerifySeverity: "high",
      auditTimeoutSec: 60,
      hubEnabled: true,
      maxHubRounds: 3,
    }),
    lockCanvasForConvergence: async () => true,
    readCanvasConvergence: async () => ({ hub_paused: false, auto_stopped: false }),
    patchCanvasConvergence: async () => ({ hub_paused: false, auto_stopped: false }),
    careSeverities: () => ["critical", "high"],
    resolveAgentSnapshotForJob: async () => ({}),
    recordJobSharedAssets: async () => {},
    fixedPriorityForJob: () => 500,
    insertEdgeIfAbsent: async () => undefined,
    settleCanvasFindingsAtGuardrail: async () => undefined,
    evaluateAnalysisCompleteGate: async () => ({ ok: false, blockers: ["fixture"] }),
    hasSucceededRoleWork: async () => false,
    maybeDispatchReport: async () => undefined,
  });

  await app.maybeTriggerHub(fakeTx, undefined);
  await app.maybeTriggerHub(fakeTx, {
    id: "hub",
    project_id: "project",
    canvas_id: "canvas",
    type: "hub_reason",
  });
  assert.equal(queryCount, 0, "invalid and recursive Hub wakeups must stop before SQL");
});

test("core keeps the historical facade while delegating Hub orchestration", () => {
  const source = readFileSync(new URL("../../core.ts", import.meta.url), "utf8");
  const application = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  assert.match(source, /createHubOrchestrationApplication/);
  assert.match(source, /hubOrchestrationApplication\.maybeTriggerHub/);
  assert.match(source, /hubOrchestrationApplication\.advanceCanvasAfterTerminalJob/);
  assert.match(source, /hubOrchestrationApplication\.triggerHubFromHumanComment/);
  assert.match(source, /export async function maybeTriggerHub\([\s\S]*?return hubOrchestrationApplication\.maybeTriggerHub/);
  assert.ok(
    application.indexOf("ports.lockCanvasForConvergence(tx, canvasId)") <
      application.indexOf("const activeHub"),
    "Hub eligibility must lock the canvas before checking duplicate active Hub jobs",
  );
  assert.match(application, /assertFrozenRuntimeImageLocal/);
  assert.match(application, /runtimeImageNotLocalCanvasBlock/);
  assert.match(application, /RuntimeImageNotLocalError/);
  assert.match(application, /isHubRoundWithinBudget\(Number\(count\), rules\.maxHubRounds\)/);
  assert.match(application, /dispatched_prompt: extractDispatchPrompt\("hub_reason"/);
  assert.match(application, /requirements_json = requirements_json - 'hub_evidence_signature'/);
});
