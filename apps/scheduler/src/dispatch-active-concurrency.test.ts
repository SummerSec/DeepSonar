import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateDispatchCounts,
  activeConcurrencyForCredential,
  dispatchModelKey,
  emptyDispatchCounts,
} from "./dispatch-active-concurrency.js";

test("accumulateDispatchCounts keys model occupancy by upstream_model", () => {
  const counts = accumulateDispatchCounts([
    {
      status: "running",
      project_id: "p1",
      agent_cli: "claude-code",
      credential_id: "c1",
      credential_provider: "anthropic",
      model: "fable",
      upstream_model: "grok-4.5",
      count: 2,
    },
  ]);
  assert.equal(counts.credential.get("c1"), 2);
  assert.equal(counts.model.get(dispatchModelKey("c1", "grok-4.5")), 2);
  assert.equal(counts.cli.get("claude-code"), 2);
});

test("activeConcurrencyForCredential projects in_use / max / model_in_use", () => {
  const counts = emptyDispatchCounts();
  counts.credential.set("c1", 2);
  counts.model.set(dispatchModelKey("c1", "m-a"), 1);
  counts.model.set(dispatchModelKey("c1", "m-b"), 1);
  const view = activeConcurrencyForCredential("c1", { max_concurrent: 4 }, counts);
  assert.deepEqual(view, {
    in_use: 2,
    max_concurrent: 4,
    model_in_use: { "m-a": 1, "m-b": 1 },
  });
  const empty = activeConcurrencyForCredential("c2", {}, emptyDispatchCounts());
  assert.deepEqual(empty, { in_use: 0, max_concurrent: null });
});
