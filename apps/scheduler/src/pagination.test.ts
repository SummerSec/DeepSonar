import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.js";

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

test("pagination cursors are opaque and kind scoped", () => {
  const cursor = encodeCursor({ kind: "jobs", id: "abc", created_at: "2026-08-04T00:00:00.000Z" });
  assert.equal(decodeCursor(cursor, "jobs"), null);
  assert.equal(decodeCursor(cursor, "findings"), null);
  assert.equal(decodeCursor("not-a-cursor", "jobs"), null);
});

test("database keyset cursors reject decodable invalid casts before SQL", () => {
  const stamp = "2026-08-04T00:00:00.000Z";
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "jobs", id: "not-a-uuid", created_at: stamp }), "jobs"),
    null,
  );
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "findings", id: "00000000-0000-0000-0000-000000000001", created_at: "not-a-time" }), "findings"),
    null,
  );
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "events", id: "0", created_at: stamp }), "events"),
    null,
  );
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "events", id: "-1", created_at: stamp }), "events"),
    null,
  );
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "events", id: Number.MAX_SAFE_INTEGER + 1, created_at: stamp }), "events"),
    null,
  );
  assert.equal(
    decodeCursor(rawCursor({ v: 1, kind: "events", id: "9223372036854775807", created_at: stamp }), "events")?.id,
    "9223372036854775807",
  );
});

test("valid cursors use canonical UUID and timestamp forms", () => {
  const cursor = encodeCursor({
    kind: "jobs",
    id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(decodeCursor(cursor, "jobs")?.id, "00000000-0000-0000-0000-000000000001");
});
test("page limit is capped for bounded list endpoints", () => {
  assert.equal(pageLimit("5000"), 50);
  assert.equal(pageLimit("0"), 50);
  assert.equal(pageLimit("7"), 7);
});
