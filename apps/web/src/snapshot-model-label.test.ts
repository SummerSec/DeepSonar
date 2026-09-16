import assert from "node:assert/strict";
import test from "node:test";
import { formatSnapshotModelField } from "./snapshot-model-label";

test("cli-default upstream renders operator-visible Chinese copy", () => {
  const formatted = formatSnapshotModelField("—", "cli-default:claude-opus-5");
  assert.equal(formatted.modelLabel, "未指定");
  assert.match(formatted.upstreamLabel, /CLI 默认 claude-opus-5/);
  assert.match(formatted.upstreamLabel, /实际模型不可观测/);
});

test("ordinary upstream models stay unchanged", () => {
  const formatted = formatSnapshotModelField("fable", "grok-4.5");
  assert.equal(formatted.modelLabel, "fable");
  assert.equal(formatted.upstreamLabel, "grok-4.5");
});
