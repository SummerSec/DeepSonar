import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createHubOrchestrationApplication,
  hubRoundLimitLabel,
  isHubRoundWithinBudget,
  parseHubMaxRounds,
  parseHubMaxRoundsEnv,
  shouldConsiderHubTrigger,
  shouldWakeEvidenceHub,
  UNLIMITED_HUB_ROUNDS,
} from "./application.js";

test("Hub evidence wakeups and round budgets remain edge-triggered", () => {
  assert.equal(shouldWakeEvidenceHub(null, "evidence-v1"), true);
  assert.equal(shouldWakeEvidenceHub("evidence-v1", "evidence-v1"), false);
  assert.equal(shouldWakeEvidenceHub("evidence-v1", "evidence-v2"), true);
  assert.equal(
    shouldWakeEvidenceHub("evidence-v1", "evidence-v2", {
      lastGateFingerprint: "aaaa",
      gateFingerprint: "aaaa",
    }),
    false,
    "unchanged gate fingerprint is not progress even when the evidence signature grows",
  );
  assert.equal(
    shouldWakeEvidenceHub("evidence-v1", "evidence-v2", {
      lastGateFingerprint: "aaaa",
      gateFingerprint: "bbbb",
    }),
    true,
  );
  assert.equal(isHubRoundWithinBudget(0, 1), true);
  assert.equal(isHubRoundWithinBudget(1, 1), false);
  assert.equal(isHubRoundWithinBudget(5, 3), false);
  assert.equal(isHubRoundWithinBudget(0, 0), true, "0 is unlimited");
  assert.equal(isHubRoundWithinBudget(20, 0), true, "unlimited never exhausts on round count");
});

test("Hub round budget parses unlimited without silently substituting 20", () => {
  assert.equal(parseHubMaxRounds(undefined), null);
  assert.equal(parseHubMaxRounds("unlimited"), UNLIMITED_HUB_ROUNDS);
  assert.equal(parseHubMaxRounds("UNLIMITED"), UNLIMITED_HUB_ROUNDS);
  assert.equal(parseHubMaxRounds(0), UNLIMITED_HUB_ROUNDS);
  assert.equal(parseHubMaxRounds("0"), UNLIMITED_HUB_ROUNDS);
  assert.equal(parseHubMaxRounds(3), 3);
  assert.equal(parseHubMaxRounds(-1), null);
  assert.equal(parseHubMaxRounds("abc"), null);
  assert.equal(parseHubMaxRounds(true), null);
  assert.equal(parseHubMaxRounds({}), null);
  assert.equal(parseHubMaxRoundsEnv(undefined, UNLIMITED_HUB_ROUNDS).value, UNLIMITED_HUB_ROUNDS);
  assert.equal(parseHubMaxRoundsEnv(undefined, UNLIMITED_HUB_ROUNDS).invalid, false);
  assert.equal(parseHubMaxRoundsEnv("abc", UNLIMITED_HUB_ROUNDS).invalid, true);
  assert.equal(hubRoundLimitLabel(0), "unlimited");
  assert.equal(hubRoundLimitLabel(20), "20");
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

test("core composition root wires Hub orchestration without owning eligibility SQL", () => {
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
  assert.doesNotMatch(application, /assertFrozenRuntimeImageLocal|runtimeImageNotLocalCanvasBlock|RuntimeImageNotLocalError/);
  assert.match(application, /isHubRoundWithinBudget\(Number\(count\), rules\.maxHubRounds\)/);
  assert.match(application, /budget_exhausted:incomplete:\$\{limitLabel\}/);
  assert.match(application, /deepsonar_hub_budget_exhausted_total/);
  assert.doesNotMatch(application, /max_hub_rounds_incomplete/);
  assert.match(source, /parseHubMaxRounds\(raw\.maxHubRounds\) \?\? base\.maxHubRounds/);
  assert.match(application, /dispatched_prompt: extractDispatchPrompt\("hub_reason"/);
  assert.match(
    application,
    /requirements_json = \(requirements_json - 'hub_evidence_signature'\) - 'hub_gate_fingerprint'/,
  );
  assert.match(application, /root\?\.status === "report_failed"/);
});
