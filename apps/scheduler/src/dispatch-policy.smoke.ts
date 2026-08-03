import assert from "node:assert/strict";
import {
  dispatchConcurrencyDecision,
  parseNonNegativeLimit,
} from "./dispatch-policy.js";

const base = {
  totalActive: 0,
  projectActive: 0,
  cliActive: 0,
  globalLimit: 6,
  projectLimit: 4,
  cliLimit: 4,
};

// Four claims for one project/CLI are admitted; the fifth is blocked by the
// project cap even though the global cap still has two free slots.
for (let i = 0; i < 4; i += 1) {
  assert.deepEqual(dispatchConcurrencyDecision(base), { allowed: true });
  base.totalActive += 1;
  base.projectActive += 1;
  base.cliActive += 1;
}
assert.deepEqual(dispatchConcurrencyDecision(base), { allowed: false, blockedBy: "project" });

// Exercise the independent CLI cap and explicit CLI=0 pause semantics.
assert.deepEqual(
  dispatchConcurrencyDecision({ ...base, projectActive: 0, projectLimit: 6 }),
  { allowed: false, blockedBy: "agent_cli" },
);
assert.deepEqual(
  dispatchConcurrencyDecision({ ...base, totalActive: 0, projectActive: 0, cliActive: 0, cliLimit: 0 }),
  { allowed: false, blockedBy: "agent_cli" },
);

// Persisted global/project limits reject malformed values but retain zero.
assert.equal(parseNonNegativeLimit(undefined, 6), 6);
assert.equal(parseNonNegativeLimit("not-a-number", 2), 2);
assert.equal(parseNonNegativeLimit(0, 6), 0);
assert.equal(parseNonNegativeLimit(4, 2), 4);

console.log("dispatch-policy smoke passed: global=6 project=4 claude-code=4, fifth blocked, CLI=0 paused");
