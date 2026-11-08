import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withOperationConflictRetry } from "../../db-conflict-retry.js";
import { applyPlanObjectivePatch } from "../plan-protocol/objective.js";
import type { HubCanvasConvergence, HubOrchestrationPorts, HubOrchestrationTransaction } from "./ports.js";
import {
  createHubOrchestrationApplication,
  formatVerifyUnclosedPausedReason,
  hubRoundLimitLabel,
  INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS,
  isHubRoundWithinBudget,
  parseHubMaxRounds,
  parseHubMaxRoundsEnv,
  shouldConsiderHubTrigger,
  shouldEscalateUnclosedVerify,
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

test("never-verified pending wakes even when evidence signature is unchanged (#574)", () => {
  assert.equal(
    shouldWakeEvidenceHub("same", "same", { neverVerified: true }),
    true,
    "signature gate must not suppress never-verified pending wakeup",
  );
  assert.equal(
    shouldWakeEvidenceHub("same", "same", { neverVerified: false }),
    false,
  );
  assert.equal(
    shouldWakeEvidenceHub("old", "new", {
      neverVerified: true,
      lastGateFingerprint: "fp",
      gateFingerprint: "fp",
    }),
    true,
    "never-verified bypasses fingerprint sameness as well",
  );
});

test("inconclusive / unclosed verify escalates after documented N hub rounds (#574)", () => {
  assert.equal(INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS, 2);
  assert.equal(shouldEscalateUnclosedVerify(0), false);
  assert.equal(shouldEscalateUnclosedVerify(1), false);
  assert.equal(shouldEscalateUnclosedVerify(2), true);
  assert.equal(shouldEscalateUnclosedVerify(5), true);
  assert.equal(
    formatVerifyUnclosedPausedReason({ inconclusive: 4, pending: 1 }),
    "verify_unclosed:high=5(inconclusive=4,pending=1)",
  );
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
    settleStalledFinding: async () => true,
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

test("stopped objectives suppress automatic and forced Hub wakes without resetting or completing the goal", async () => {
  const { objective } = applyPlanObjectivePatch({ title: "Stopped goal", target: {}, patch: {
    expected_revision: null, goal: "Retain scoped output",
    completion: { mode: "all_tasks", description: "Retain every planned output", required_outputs: [] },
    budget: { max_tasks: 2, max_rounds: 2, max_no_progress_rounds: 1, max_parallel_tasks: 1 },
  } });
  for (const status of [undefined, "active", "completed", "stopped"] as const) {
    for (const options of [{}, { idleWake: true }, { force: true }, { manual: true }]) {
      const target = status ? { plan_objective: { ...objective, status } } : {};
      const original = structuredClone(target);
      const continued = new Error("continued existing Hub admission");
      let locked = false;
      const query = async (strings: TemplateStringsArray) => {
        assert.ok(locked, "objective admission is serialized by the Canvas lock");
        const text = strings.join("?").replace(/\s+/gu, " ").trim();
        if (text.startsWith("SELECT status FROM canvas_nodes")) return [{ status: "active" }];
        if (text.startsWith("SELECT target_json FROM canvases")) return [{ target_json: target }];
        throw continued;
      };
      const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as HubOrchestrationTransaction;
      const app = createHubOrchestrationApplication(tx, {
        rulesForProject: async () => ({ minVerifySeverity: "high", auditTimeoutSec: 60, hubEnabled: true, maxHubRounds: 3 }),
        lockCanvasForConvergence: async () => { locked = true; return true; },
        readCanvasConvergence: async () => { throw continued; },
        patchCanvasConvergence: async () => { throw new Error("wake must not rewrite convergence"); },
        careSeverities: () => ["critical", "high"],
        resolveAgentSnapshotForJob: async () => { throw new Error("wake must not spend a model budget"); },
        recordJobSharedAssets: async () => {}, fixedPriorityForJob: () => 500, insertEdgeIfAbsent: async () => {},
        settleCanvasFindingsAtGuardrail: async () => { throw new Error("wake must not settle Findings"); },
        evaluateAnalysisCompleteGate: async () => { throw continued; }, hasSucceededRoleWork: async () => false,
        maybeDispatchReport: async () => { throw new Error("stopped does not mean complete"); }, settleStalledFinding: async () => false,
      });
      const wake = () => app.maybeTriggerHub(tx, { id: "worker", project_id: "project", canvas_id: "canvas", type: "explore" }, options);
      if (status === "stopped" && !("manual" in options)) await wake();
      else await assert.rejects(wake, (error: unknown) => error === continued);
      assert.deepEqual(target, original, "wake cannot change objective revision, budget or terminal meaning");
    }
  }
});

function settlementFixture(branch: "stalled" | "guardrail" | "report-dispatch", failure: unknown, abortOnFailure = true) {
  let remainingFailures = 1;
  let attempts = 0;
  let settlementCalls = 0;
  let reportCalls = 0;
  let queriesAfterAbort = 0;
  let gateCalls = 0;
  const patches: Array<Partial<HubCanvasConvergence>> = [];
  const run = async () => {
    attempts += 1;
    let aborted = false; // Each run models a fresh outer transaction.
    const query = async (strings: TemplateStringsArray) => {
      const text = strings.join("?").replace(/\s+/gu, " ").trim();
      if (aborted) {
        queriesAfterAbort += 1;
        throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      }
      if (text === "SELECT fixture_settle" || text === "SELECT fixture_report") {
        if (text === "SELECT fixture_report") reportCalls += 1;
        else settlementCalls += 1;
        const injectFailure = branch === "report-dispatch" ? text === "SELECT fixture_report" : text === "SELECT fixture_settle";
        if (injectFailure && remainingFailures > 0) {
          remainingFailures -= 1;
          aborted = abortOnFailure;
          throw failure;
        }
        return [];
      }
      if (text.startsWith("SELECT status FROM canvas_nodes")) return [{ status: "running" }];
      if (text.startsWith("SELECT target_json FROM canvases")) return [{ target_json: {} }];
      if (text.startsWith("SELECT r.id, r.finding_id")) return [];
      if (text.startsWith("SELECT 1 FROM finding_verification_rounds")) return branch === "stalled" ? [{ found: 1 }] : [];
      if (text.includes("AS hub_rounds FROM jobs")) return [{ hub_rounds: 3 }];
      if (text.startsWith("SELECT f.id, f.verify_status")) return [{ id: "finding", verify_status: "pending", requirements_json: {}, evidence_snapshot_json: {} }];
      if (text.includes("AS count FROM jobs")) return [{ count: 3 }];
      if (text.startsWith("SELECT 1 FROM jobs")) return [];
      if (text === "SELECT fixture_gate" || text === "UPDATE fixture_convergence" || text.startsWith("UPDATE canvas_nodes SET")) return [];
      throw new Error(`unexpected fixture SQL: ${text}`);
    };
    const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as HubOrchestrationTransaction;
    const settle = (inner: HubOrchestrationTransaction) => inner`SELECT fixture_settle`;
    const ports: HubOrchestrationPorts = {
      rulesForProject: async () => ({ minVerifySeverity: "high", auditTimeoutSec: 60, hubEnabled: true, maxHubRounds: 3 }),
      lockCanvasForConvergence: async () => true,
      readCanvasConvergence: async () => ({ hub_paused: false, auto_stopped: false }),
      patchCanvasConvergence: async (inner, _id, patch) => {
        await inner`UPDATE fixture_convergence`;
        patches.push(patch);
        return { hub_paused: false, auto_stopped: false, ...patch };
      },
      careSeverities: () => ["critical", "high"],
      resolveAgentSnapshotForJob: async () => { throw new Error("settlement branch must not create a Hub Job"); },
      recordJobSharedAssets: async () => {},
      fixedPriorityForJob: () => 500,
      insertEdgeIfAbsent: async () => {},
      settleCanvasFindingsAtGuardrail: settle,
      evaluateAnalysisCompleteGate: async (inner) => {
        await inner`SELECT fixture_gate`;
        gateCalls += 1;
        return { ok: branch === "report-dispatch", blockers: branch === "report-dispatch" ? [] : ["fixture"] };
      },
      hasSucceededRoleWork: async () => false,
      maybeDispatchReport: async (inner) => {
        if (branch !== "report-dispatch") throw new Error("blocked gate must not dispatch a Report");
        await inner`SELECT fixture_report`;
      },
      settleStalledFinding: async (inner) => { await settle(inner); return true; },
    };
    const app = createHubOrchestrationApplication(tx, ports);
    await app.maybeTriggerHub(tx, { id: "worker", project_id: "project", canvas_id: "canvas", type: "audit" });
  };
  return { run, patches, reportCalls: () => reportCalls, counts: () => ({ attempts, settlementCalls, queriesAfterAbort, gateCalls }) };
}

// The retry examples below use SQL-only stub ports, not production Report I/O.
for (const branch of ["stalled", "guardrail", "report-dispatch"] as const) {
  for (const code of ["40P01", "40001", "55P03"]) {
    for (const wrapped of [false, true]) {
      test(`#945 ${branch} preserves ${wrapped ? "wrapped " : ""}${code} for the outer transaction`, async () => {
        const conflict = Object.assign(new Error(`fixture ${code}`), { code });
        const failure = wrapped ? new Error("fixture wrapper", { cause: conflict }) : conflict;
        const fixture = settlementFixture(branch, failure);
        await assert.rejects(fixture.run, (error: unknown) => error === failure);
        assert.deepEqual(fixture.counts(), { attempts: 1, settlementCalls: 1, queriesAfterAbort: 0, gateCalls: branch === "report-dispatch" ? 1 : 0 });
        assert.equal(fixture.reportCalls(), branch === "report-dispatch" ? 1 : 0);
        assert.deepEqual(fixture.patches, [], "failed operation must not fall through to convergence updates");
      });

      test(`#945 ${branch} recovers through the outer retry after ${wrapped ? "wrapped " : ""}${code}`, async () => {
        const conflict = Object.assign(new Error(`fixture ${code}`), { code });
        const failure = wrapped ? new Error("fixture wrapper", { cause: conflict }) : conflict;
        const fixture = settlementFixture(branch, failure);
        const observed: unknown[] = [];
        await withOperationConflictRetry("unit_hub_settlement", fixture.run, {
          sleep: async () => {},
          onConflict: (error) => { observed.push(error); },
        });
        assert.equal(observed.length, 1);
        assert.equal(observed[0], failure, "the retry receives the original error object");
        assert.deepEqual(fixture.counts(), { attempts: 2, settlementCalls: 2, queriesAfterAbort: 0, gateCalls: branch === "report-dispatch" ? 2 : branch === "guardrail" ? 1 : 0 });
        if (branch === "report-dispatch") {
          assert.equal(fixture.reportCalls(), 2, "the SQL-only report stub succeeds in the fresh transaction");
          assert.deepEqual(fixture.patches, []);
        } else {
          assert.equal(fixture.patches.length, 1, "only the successful transaction advances convergence");
          assert.equal(fixture.patches[0].auto_stopped, true);
        }
      });
    }
  }

  test(`#945 ${branch} still isolates non-conflict business errors`, async () => {
    const failure = new Error("fixture business settlement failure");
    const fixture = settlementFixture(branch, failure, false);
    await withOperationConflictRetry("unit_hub_settlement", fixture.run, { sleep: async () => {} });
    assert.deepEqual(fixture.counts(), { attempts: 1, settlementCalls: 1, queriesAfterAbort: 0, gateCalls: branch !== "stalled" ? 1 : 0 });
    if (branch === "report-dispatch") {
      assert.equal(fixture.reportCalls(), 1, "non-conflict report errors remain isolated without an outer retry");
      assert.deepEqual(fixture.patches, []);
    } else {
      assert.equal(fixture.patches.length, 1);
      assert.equal(fixture.patches[0].auto_stopped, true);
      assert.match(fixture.patches[0].paused_reason!, branch === "stalled" ? /^verify_unclosed:/u : /^budget_exhausted:/u);
    }
  });
}

test("Hub application stop path writes paused_reason for verify-unclosed (#574)", () => {
  const application = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  assert.match(application, /stopHubForUnclosedVerify/);
  assert.match(application, /formatVerifyUnclosedPausedReason/);
  // #890: stalled Findings settle through the reason classifier instead of being
  // escalated to a human Action unconditionally.
  assert.match(application, /settleStalledFinding/);
  assert.match(application, /hub_wake_attempts/);
  assert.match(application, /neverVerified: allowNeverVerifiedWake/);
  assert.match(application, /paused_reason: pausedReason/);
  assert.match(application, /hub_stop: "verify_unclosed"/);
  assert.match(application, /INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS/);
});

test("core composition root wires Hub orchestration without owning eligibility SQL", () => {
  const source = readFileSync(new URL("../../core.ts", import.meta.url), "utf8");
  const application = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  assert.match(source, /createHubOrchestrationApplication/);
  assert.match(source, /hubOrchestrationApplication\.maybeTriggerHub/);
  assert.match(source, /hubOrchestrationApplication\.advanceCanvasAfterTerminalJob/);
  assert.match(source, /hubOrchestrationApplication\.triggerHubFromHumanComment/);
  assert.match(source, /export async function maybeTriggerHub\([\s\S]*?return hubOrchestrationApplication\.maybeTriggerHub/);
  assert.match(source, /settleStalledFinding/);
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
  assert.match(source, /const maxHubRounds = parseHubMaxRounds\(raw\.maxHubRounds\)/);
  assert.match(source, /maxHubRounds: maxHubRounds \?\? base\.maxHubRounds/);
  assert.match(application, /dispatched_prompt: extractDispatchPrompt\("hub_reason"/);
  assert.match(
    application,
    /requirements_json = \(requirements_json - 'hub_evidence_signature'\) - 'hub_gate_fingerprint'/,
  );
  assert.match(application, /root\?\.status === "report_failed"/);
});
