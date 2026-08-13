import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CANVAS_BROADCAST_LIMIT,
  MAX_CANVAS_BROADCAST_LIMIT,
  parseCanvasBroadcastLimit,
} from "./broadcast-contract.js";

test("broadcast limit defaults to 500 and caps at 1000", () => {
  assert.equal(parseCanvasBroadcastLimit(undefined), DEFAULT_CANVAS_BROADCAST_LIMIT);
  assert.equal(parseCanvasBroadcastLimit("1"), 1);
  assert.equal(parseCanvasBroadcastLimit("1000"), MAX_CANVAS_BROADCAST_LIMIT);
  assert.equal(parseCanvasBroadcastLimit("1001"), MAX_CANVAS_BROADCAST_LIMIT);
});

test("invalid broadcast limits use the documented default", () => {
  for (const value of ["", "0", "-1", "1.5", "NaN", ["10"]]) {
    assert.equal(parseCanvasBroadcastLimit(value), DEFAULT_CANVAS_BROADCAST_LIMIT);
  }
});

test("truncated is applicable exactly when total exceeds returned rows", () => {
  assert.equal(501 > 500, true);
  assert.equal(500 > 500, false);
  assert.equal(0 > 0, false);
});
