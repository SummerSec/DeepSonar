import assert from "node:assert/strict";
import test from "node:test";
import { formatJsonObjectText, validateJsonObjectText } from "./json-text.js";

test("validateJsonObjectText accepts empty as optional defaults", () => {
  const empty = validateJsonObjectText("  ");
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.empty, true);
});

test("validateJsonObjectText rejects arrays and primitives", () => {
  assert.equal(validateJsonObjectText("[]").ok, false);
  assert.equal(validateJsonObjectText('"x"').ok, false);
  assert.equal(validateJsonObjectText("1").ok, false);
});

test("validateJsonObjectText accepts objects and reports parse position", () => {
  const ok = validateJsonObjectText('{"env":{"A":"1"}}');
  assert.equal(ok.ok, true);
  if (ok.ok && !ok.empty) assert.equal(ok.value.env && typeof ok.value.env === "object", true);

  const bad = validateJsonObjectText('{\n  "a": 1,\n}');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /JSON|Unexpected|position|Expected/i);
  }
});

test("formatJsonObjectText pretty-prints", () => {
  const formatted = formatJsonObjectText('{"env":{"ANTHROPIC_API_KEY":"x"}}');
  assert.match(formatted, /\n/);
  assert.match(formatted, /"env"/);
  assert.throws(() => formatJsonObjectText("{"), /JSON|Unexpected|position|Expected/i);
});
