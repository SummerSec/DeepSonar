import assert from "node:assert/strict";
import test from "node:test";
import { defaultCodexToml, formatTomlText, validateTomlText } from "./toml-text.js";

test("validateTomlText accepts empty as optional defaults", () => {
  const empty = validateTomlText("  ");
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.empty, true);
});

test("validateTomlText accepts codex-like tables", () => {
  const text = defaultCodexToml("https://api.openai.com/v1");
  const ok = validateTomlText(text);
  assert.equal(ok.ok, true);
  if (ok.ok && !ok.empty) {
    assert.equal(ok.value.model_provider, "custom");
    assert.equal(typeof ok.value.model_providers, "object");
  }
});

test("validateTomlText rejects broken toml", () => {
  const bad = validateTomlText("model = \n[broken");
  assert.equal(bad.ok, false);
});

test("formatTomlText round-trips", () => {
  const raw = 'model_provider="custom"\nmodel="gpt-5"\n';
  const formatted = formatTomlText(raw);
  assert.match(formatted, /model_provider/);
  assert.match(formatted, /gpt-5/);
  const again = validateTomlText(formatted);
  assert.equal(again.ok, true);
});
