import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFindingVerificationApplication } from "./application.js";

test("finding verification application keeps an explicit, transaction-preserving seam", async () => {
  const calls: string[] = [];
  const app = createFindingVerificationApplication({
    collectEvidenceSnapshot: async () => ({ qualified: false }),
    createVerifyRound: async () => ({ jobId: "verify", roundId: "round", attempt: 1 }),
    evaluateFollowup: async () => { calls.push("followup"); },
    settleCanvasFindingsAtGuardrail: async () => ({ settled: 1 }),
    closeVerifyRound: async () => ({ outcome: "rework", forceHub: true }),
    maybeReverifyAfterFollowup: async () => { calls.push("reverify"); },
    attachVerificationEvidence: async () => true,
    careSeverityMeta: async () => ({ careSeverities: ["high"] }),
    canvasFindingsConverged: async () => ({ ok: true, blockers: [], problems: [] }),
    evaluateAnalysisCompleteGate: async () => ({ ok: true, blockers: [], problems: [] }),
    hasSucceededRoleWork: async () => true,
    findingVerificationSummaries: async () => new Map(),
    findingVerificationSummary: async () => ({ verify_status: "pending" }),
    normalizePendingVerificationRounds: async () => ({ missingJobExamined: 0 }),
    isSeverityInVerifyScope: () => true,
    buildVerificationFollowupPayload: () => ({ scheduler_owned: true }),
    buildEvidenceSnapshot: () => ({ qualified: false }),
    mapProposedVerdict: () => "rework",
  });
  const fakeTx = (() => Promise.resolve([])) as never;
  await app.evaluateFollowup(fakeTx, { id: "job" }, { id: "finding" });
  assert.deepEqual(calls, ["followup"]);
  assert.deepEqual(await app.closeVerifyRound(fakeTx, "job", { jobStatus: "failed" }), {
    outcome: "rework",
    forceHub: true,
  });
});

test("verification context source documents its legacy adapter boundary", () => {
  const source = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  assert.match(source, /createFindingVerificationApplication/);
  assert.match(source, /caller.*transaction|transaction/);
  assert.match(source, /legacy module remains a compatibility adapter/);
});
