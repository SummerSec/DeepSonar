import assert from "node:assert/strict";
import test from "node:test";
import { NUL_REPLACEMENT, scrubPostgresJson } from "./pg-text-safety.js";

test("scrubPostgresJson 只替换 U+0000，保留换行与制表符", () => {
  const scrubbed = scrubPostgresJson({ message: "a\u0000b\nc\td", percent: 30, nested: "\u0000" });
  assert.deepEqual(scrubbed, { message: `a${NUL_REPLACEMENT}b\nc\td`, percent: 30, nested: NUL_REPLACEMENT });
  assert.doesNotMatch(scrubbed.message, /\u0000/u);
});

test("scrubPostgresJson 深度清洗数组与对象键值，不修改入参", () => {
  const input = { title: "x\u0000y", items: [{ body: "\u0000start" }, "plain"], keep: null };
  const scrubbed = scrubPostgresJson(input);
  assert.deepEqual(scrubbed, {
    title: `x${NUL_REPLACEMENT}y`,
    items: [{ body: `${NUL_REPLACEMENT}start` }, "plain"],
    keep: null,
  });
  assert.equal(input.title, "x\u0000y", "the accepted payload object must stay untouched for digest verification");
});

test("scrubPostgresJson 也清洗对象键（FindingPayload.raw 允许动态键）", () => {
  const bob = scrubPostgresJson({ raw: { ["a\u0000b"]: "value" } });
  assert.deepEqual(bob, { raw: { [`a${NUL_REPLACEMENT}b`]: "value" } });
  assert.ok(!JSON.stringify(bob).includes("\u0000"), "no U+0000 may escape into the stored JSON representation");
});

test("scrubPostgresJson 保持非普通对象（日期/类实例）引用不变", () => {
  const at = new Date("2026-11-11T00:00:00.000Z");
  const scrubbed = scrubPostgresJson({ at, flag: true, count: 2 });
  assert.equal(scrubbed.at, at);
  assert.deepEqual(scrubbed, { at, flag: true, count: 2 });
});