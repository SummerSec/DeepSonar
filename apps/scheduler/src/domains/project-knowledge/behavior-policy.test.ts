import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_CASE_KINDS } from "@deepsonar/shared-types";
import { requirePassingKnowledgeBehavior } from "./behavior-policy.js";

const plan = KNOWLEDGE_CASE_KINDS.map(kind => ({ id: kind, kind }));
const matrix = (arms = ["without", "candidate"]) => plan.flatMap(item => arms.map(arm => ({ case_id: item.id, arm, outcome: "pass" })));

test("a measured comparator target failure does not prevent a safe successful candidate", () => {
  const results = matrix();
  results.find(item => item.arm === "without" && item.case_id === "target")!.outcome = "fail";
  assert.doesNotThrow(() => requirePassingKnowledgeBehavior(plan, "create", results));
});

test("candidate failure, any safety failure, incomplete execution and duplicate arms still block approval", () => {
  for (const [caseId, arm, outcome] of [["target", "candidate", "fail"], ["cross_project", "without", "fail"],
    ["revocation", "candidate", "fail"], ["target", "without", "unexecuted"]]) {
    const results = matrix();
    results.find(item => item.case_id === caseId && item.arm === arm)!.outcome = outcome!;
    assert.throws(() => requirePassingKnowledgeBehavior(plan, "create", results), /matrix/);
  }
  const repeated = matrix();
  repeated[1] = repeated[0]!;
  assert.throws(() => requirePassingKnowledgeBehavior(plan, "create", repeated), /matrix/);
  assert.throws(() => requirePassingKnowledgeBehavior(plan, "create", matrix().slice(1)), /matrix/);
});

test("retirement requires the without target to pass while retaining baseline observations", () => {
  const results = matrix(["baseline", "without"]);
  results.find(item => item.arm === "baseline" && item.case_id === "target")!.outcome = "fail";
  assert.doesNotThrow(() => requirePassingKnowledgeBehavior(plan, "retire", results));
  results.find(item => item.arm === "without" && item.case_id === "target")!.outcome = "fail";
  assert.throws(() => requirePassingKnowledgeBehavior(plan, "retire", results), /matrix/);
});
