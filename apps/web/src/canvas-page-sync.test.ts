import assert from "node:assert/strict";
import test from "node:test";
import { appendUniqueRows, mergeRefreshedPage } from "./canvas-page-sync.js";

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: String(from + i) }));

test("refresh keeps the previous keyset boundary after a new top item", () => {
  const loaded = [...rows(1, 100), { id: "101" }];
  const refreshed = [{ id: "0" }, ...rows(1, 49)];
  const merged = mergeRefreshedPage(refreshed, loaded);
  assert.equal(merged.length, 102);
  assert.equal(merged[50]?.id, "50");
  assert.equal(new Set(merged.map((row) => row.id)).size, merged.length);
});

test("load-more appends only unseen rows", () => {
  const merged = appendUniqueRows(rows(1, 3), [{ id: "3" }, { id: "4" }]);
  assert.deepEqual(merged.map((row) => row.id), ["1", "2", "3", "4"]);
});

