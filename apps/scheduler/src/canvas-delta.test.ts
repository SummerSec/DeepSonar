import assert from "node:assert/strict";
import test from "node:test";
import { includesDeltaTimestamp, normalizeDeltaWatermark } from "./canvas-delta.js";

test("canvas delta watermark window is lower-exclusive and upper-inclusive", () => {
  const since = "2026-08-04T00:00:00.000Z";
  const upper = "2026-08-04T00:00:01.000Z";
  assert.equal(includesDeltaTimestamp("2026-08-04T00:00:00.000Z", since, upper), false);
  assert.equal(includesDeltaTimestamp(upper, since, upper), true);
  assert.equal(includesDeltaTimestamp("2026-08-04T00:00:01.001Z", since, upper), false);
  assert.equal(normalizeDeltaWatermark(new Date(upper)), upper);
});
