import assert from "node:assert/strict";
import test from "node:test";
import { validateCredentialCompatibility } from "./credentials.js";

test("claude-code 只允许 anthropic 和 kimi Credential", () => {
  assert.equal(validateCredentialCompatibility("claude-code", "anthropic"), null);
  assert.equal(validateCredentialCompatibility("claude-code", "kimi"), null);
  assert.match(
    validateCredentialCompatibility("claude-code", "openai") ?? "",
    /claude-code.*anthropic\/kimi.*openai/,
  );
});

test("其他 CLI 不施加未经证实的 provider 限制", () => {
  assert.equal(validateCredentialCompatibility("open-code", "openai"), null);
  assert.equal(validateCredentialCompatibility("codex", "openrouter"), null);
  assert.equal(validateCredentialCompatibility("custom-cli", "openai"), null);
});
