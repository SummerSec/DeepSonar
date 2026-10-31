import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const application = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
const policy = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
const sideEffects = readFileSync(new URL("../event-ingestion/side-effects.ts", import.meta.url), "utf8");
const report = readFileSync(new URL("../../report.ts", import.meta.url), "utf8");

test("research persistence never writes Finding verify or severity columns", () => {
  assert.doesNotMatch(application, /UPDATE findings SET/);
  assert.doesNotMatch(application, /verify_status\s*=/);
  assert.doesNotMatch(application, /SET[\s\S]{0,80}severity\s*=/);
  assert.match(application, /INSERT INTO finding_research_runs/);
  assert.match(application, /INSERT INTO finding_dedupe_clusters/);
  assert.match(application, /INSERT INTO finding_research /);
  assert.match(application, /status = 'failed'/);
});

test("research policy stays isolated from verify and report gates", () => {
  assert.doesNotMatch(policy, /evaluateAnalysisCompleteGate|maybeDispatchReport|verify_status\s*=/);
  assert.match(policy, /never reads or writes verify_status/);
});

test("emit and report hooks keep research best-effort and after the verify gate", () => {
  assert.match(sideEffects, /runFindingResearchBestEffort/);
  assert.match(sideEffects, /evaluateFollowup[\s\S]*runFindingResearchBestEffort/);
  const callIdx = report.indexOf("await runFindingResearchBestEffort");
  const gateIdx = report.indexOf("if (!gate.ok)");
  assert.ok(callIdx > 0 && gateIdx > 0 && callIdx > gateIdx, "research must run only after the report gate decision");
});

test("best-effort research isolates persistence failures with a savepoint", () => {
  assert.match(application, /function withResearchSavepoint/);
  assert.match(application, /nested\.savepoint\(/);
  const bestEffort = application.slice(application.indexOf("export async function runFindingResearchBestEffort"));
  assert.match(bestEffort, /withResearchSavepoint\(tx, \(inner\) => runFindingResearch/);
  assert.match(bestEffort, /withResearchSavepoint\(tx, \(inner\) => recordFailedRun/);
});
