import assert from "node:assert/strict";
import test from "node:test";
import { legacySuggestionItems } from "./legacy-knowledge-migration.js";

test("#1219 历史回执正文按 input.items 取项，来源哈希逐项对齐", () => {
  const { items, sourceHashes } = legacySuggestionItems({ input: { result: "suggestions", items: [
    { kind: "memory", title: "a" }, { kind: "skill", title: "b" }] },
  source_hashes: [["h1", "h2"], "not-an-array"] });
  assert.equal(items.length, 2);
  assert.deepEqual(sourceHashes, [["h1", "h2"], []]);
});

test("#1219 结构不符时返回空，迁移按跳过处理而不是猜内容", () => {
  for (const blob of [null, {}, { input: {} }, { input: { items: "x" } }]) {
    assert.deepEqual(legacySuggestionItems(blob), { items: [], sourceHashes: [] });
  }
});
