import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.js";

test("pagination cursors are opaque and kind scoped", () => {
  const cursor = encodeCursor({ kind: "jobs", id: "abc", created_at: "2026-08-04T00:00:00.000Z" });
  assert.equal(decodeCursor(cursor, "jobs")?.id, "abc");
  assert.equal(decodeCursor(cursor, "findings"), null);
  assert.equal(decodeCursor("not-a-cursor", "jobs"), null);
});
test("page limit is capped for bounded list endpoints", () => {
  assert.equal(pageLimit("5000"), 50);
  assert.equal(pageLimit("0"), 50);
  assert.equal(pageLimit("7"), 7);
});
