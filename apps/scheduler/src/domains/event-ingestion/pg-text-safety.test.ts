import assert from "node:assert/strict";
import test from "node:test";
import { NUL_REPLACEMENT, findPayloadNul, payloadNulPolicy, scrubPostgresJson } from "./pg-text-safety.js";

test("scrubPostgresJson 只替换 U+0000，保留换行、制表符与对象键", () => {
  const scrubbed = scrubPostgresJson({ message: "a\u0000b\nc\td", percent: 30, nested: "\u0000", ["k\u0000"]: 1 });
  assert.deepEqual(scrubbed, {
    message: `a${NUL_REPLACEMENT}b\nc\td`,
    percent: 30,
    nested: NUL_REPLACEMENT,
    ["k\u0000"]: 1,
  });
  assert.doesNotMatch(scrubbed.message, /\u0000/u);
});

test("scrubPostgresJson 深度清洗数组与嵌套值，不修改入参", () => {
  const input = { title: "x\u0000y", items: [{ body: "\u0000start" }, "plain"], keep: null };
  const scrubbed = scrubPostgresJson(input);
  assert.deepEqual(scrubbed, {
    title: `x${NUL_REPLACEMENT}y`,
    items: [{ body: `${NUL_REPLACEMENT}start` }, "plain"],
    keep: null,
  });
  assert.equal(input.title, "x\u0000y", "the accepted payload object must stay untouched for digest verification");
});

test("scrubPostgresJson 保持非普通对象（日期/类实例）引用不变", () => {
  const at = new Date("2026-11-11T00:00:00.000Z");
  const scrubbed = scrubPostgresJson({ at, flag: true, count: 2 });
  assert.equal(scrubbed.at, at);
  assert.deepEqual(scrubbed, { at, flag: true, count: 2 });
});

test("payloadNulPolicy 拒绝对象键里的 U+0000，避免替换后键碰撞丢字段", () => {
  const colliding = { raw: { ["a\u0000b"]: 1, ["a\\0b"]: 2 } };
  const found = payloadNulPolicy("finding", colliding);
  assert.deepEqual(found, { kind: "key", path: "payload.raw.<nul-key>" });
  assert.deepEqual(payloadNulPolicy("progress", { nested: [{ "\u0000": true }] })?.kind, "key");
  assert.equal(payloadNulPolicy("finding", { raw: { "a\\0b": 2 } }), null, "literal backslash-zero keys are untouched");
});

test("payloadNulPolicy 只在 plan 这类身份敏感载荷上拒绝字符串值", () => {
  assert.deepEqual(payloadNulPolicy("plan", { revision: { rationale: "why\u0000now" } }), {
    kind: "value",
    path: "payload.revision.rationale",
  });
  assert.equal(payloadNulPolicy("progress", { message: "chunk\u0000with nul" }), null, "ordinary text keeps flowing and is scrubbed at storage");
  assert.equal(payloadNulPolicy("plan", { revision: { rationale: "literal \\0 only" } }), null);
});

test("findPayloadNul 报告数组下标路径", () => {
  assert.deepEqual(findPayloadNul({ list: ["ok", "bad\u0000"] }, true), { kind: "value", path: "payload.list[1]" });
  assert.equal(findPayloadNul({ list: ["ok", "bad\u0000"] }, false), null);
});
