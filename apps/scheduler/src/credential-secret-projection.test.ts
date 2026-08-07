import assert from "node:assert/strict";
import test from "node:test";
import {
  containsSecretMask,
  MASKED_SECRET_PLACEHOLDER,
  redactSecretProjection,
  restoreMaskedSecretValues,
} from "./credential-secret-projection.js";

test("credential projection recursively redacts settings secrets and config assignments", () => {
  const original = {
    env: {
      ANTHROPIC_AUTH_TOKEN: "anthropic-live-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
    },
    options: { apiKey: "openai-live-secret", timeout: 30 },
    config: 'api_key = "toml-live-secret"\nmodel = "gpt-5"\n',
    models: [{ name: "safe model", token: "nested-live-secret" }],
  };

  const projected = redactSecretProjection(original) as Record<string, unknown>;
  const encoded = JSON.stringify(projected);
  assert.ok(encoded.includes(MASKED_SECRET_PLACEHOLDER));
  assert.equal(encoded.includes("anthropic-live-secret"), false);
  assert.equal(encoded.includes("openai-live-secret"), false);
  assert.equal(encoded.includes("toml-live-secret"), false);
  assert.equal(encoded.includes("nested-live-secret"), false);
  assert.equal((projected.env as Record<string, unknown>).ANTHROPIC_BASE_URL, "https://provider.example");
});

test("patch restore round-trips only server-owned masked values", () => {
  const original = {
    env: { OPENAI_API_KEY: "openai-live-secret", OPENAI_BASE_URL: "https://old.example" },
    config: 'api_key = "toml-live-secret"\nmodel = "gpt-5"\n',
  };
  const projected = redactSecretProjection(original) as Record<string, unknown>;
  const edited = structuredClone(projected) as Record<string, unknown>;
  (edited.env as Record<string, unknown>).OPENAI_BASE_URL = "https://new.example";
  (edited.config as string) = (edited.config as string).replace('model = "gpt-5"', 'model = "gpt-5-codex"');

  const restored = restoreMaskedSecretValues(original, edited);
  assert.deepEqual(restored, {
    env: { OPENAI_API_KEY: "openai-live-secret", OPENAI_BASE_URL: "https://new.example" },
    config: 'api_key = "toml-live-secret"\nmodel = "gpt-5-codex"\n',
  });
  assert.equal(containsSecretMask(restored), false);
});

test("unresolvable mask remains detectable and cannot become a credential secret", () => {
  const incoming = { env: { OPENAI_API_KEY: MASKED_SECRET_PLACEHOLDER } };
  assert.equal(containsSecretMask(incoming), true);
  assert.equal(containsSecretMask(restoreMaskedSecretValues({}, incoming)), true);
});
