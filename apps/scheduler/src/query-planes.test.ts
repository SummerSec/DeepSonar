import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuditQueryPlane,
  QUERY_PLANE_CONTRACTS,
  QUERY_PLANES,
  queryPlaneContract,
} from "./query-planes.js";

test("three query planes are distinct and live is not an audit source", () => {
  assert.deepEqual([...QUERY_PLANES], ["current", "history", "live"]);
  assert.deepEqual(QUERY_PLANE_CONTRACTS.map((item) => item.plane), [...QUERY_PLANES]);
  assert.equal(isAuditQueryPlane("current"), true);
  assert.equal(isAuditQueryPlane("history"), true);
  assert.equal(isAuditQueryPlane("live"), false);
  assert.equal(queryPlaneContract("live").multi_replica, "not shared across Scheduler replicas");
  assert.equal(queryPlaneContract("current").append_only, false);
  assert.equal(queryPlaneContract("history").append_only, true);
});
