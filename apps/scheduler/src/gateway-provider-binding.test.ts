import assert from "node:assert/strict";
import test from "node:test";
import { assertGatewayProviderBinding, freezeGatewayProviderBinding, GatewayProviderBindingError } from "./gateway-provider-binding.js";

const credential = () => ({
  id: "synthetic-credential", provider: "openai", agent_cli: "pi",
  public_metadata_json: { base_url: "http://127.0.0.1:18081/v1" },
  settings_config_json: { provider: "synthetic", baseUrl: "http://127.0.0.1:18081/v1", api: "openai-completions",
    apiKey: "synthetic-key-one", headers: { "X-Tenant": "alpha", Authorization: "Bearer synthetic-key-one" },
    models: [{ id: "synthetic-model", headers: { "X-Model-Policy": "first" } }],
    extension: { nested: { z: 2, a: 1 }, order: ["first", "second"] } },
});
const hasCode = (code: GatewayProviderBindingError["code"]) => (error: unknown) => error instanceof GatewayProviderBindingError && error.code === code;

test("provider binding canonicalizes object keys, preserves array order and stores only a digest", () => {
  const original = credential();
  const binding = freezeGatewayProviderBinding(original);
  assert.deepEqual(Object.keys(binding).sort(), ["credential_id", "fingerprint", "version"]);
  assert.match(binding.fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(binding).includes("synthetic-key"));
  const reordered = { ...original, settings_config_json: { ...original.settings_config_json,
    extension: { order: ["first", "second"], nested: { a: 1, z: 2 } } } };
  assert.deepEqual(freezeGatewayProviderBinding(reordered), binding);
  reordered.settings_config_json.extension.order.reverse();
  assert.throws(() => assertGatewayProviderBinding(binding, reordered), hasCode("GATEWAY_PROVIDER_BINDING_CHANGED"));
});

test("secret rotation and operational credential fields do not change the binding", () => {
  const original = credential();
  const binding = freezeGatewayProviderBinding(original);
  const rotated = { ...original, secret_ciphertext: "synthetic-ciphertext", secret_nonce: "synthetic-nonce",
    secret_key_id: "synthetic-key-id", fingerprint: "synthetic-secret-fingerprint", last4: "9999",
    health_status: "degraded", model_catalog_json: [{ id: "new-discovery" }], model_catalog_fetched_at: "2099-01-01",
    public_metadata_json: { ...original.public_metadata_json, model_concurrency: 2 },
    settings_config_json: { ...original.settings_config_json, apiKey: "synthetic-key-two",
      headers: { ...original.settings_config_json.headers, Authorization: "Bearer synthetic-key-two" } } };
  assert.deepEqual(freezeGatewayProviderBinding(rotated), binding);
  assert.doesNotThrow(() => assertGatewayProviderBinding(binding, rotated));
});

test("provider, CLI, endpoint and provider/model business headers remain bound", () => {
  const original = credential();
  const binding = freezeGatewayProviderBinding(original);
  for (const current of [
    { ...original, id: "different-credential" }, { ...original, provider: "anthropic" }, { ...original, agent_cli: "dsh" },
    { ...original, settings_config_json: { ...original.settings_config_json, headers: { ...original.settings_config_json.headers, "X-Tenant": "beta" } } },
    { ...original, settings_config_json: { ...original.settings_config_json, models: [{ id: "synthetic-model", headers: { "X-Model-Policy": "second" } }] } },
    { ...original, public_metadata_json: { base_url: "http://127.0.0.1:18082/v1" },
      settings_config_json: { ...original.settings_config_json, baseUrl: "http://127.0.0.1:18082/v1" } },
  ]) assert.throws(() => assertGatewayProviderBinding(binding, current), hasCode("GATEWAY_PROVIDER_BINDING_CHANGED"));
});

test("legacy/invalid binding and metadata/profile target mismatch fail closed", () => {
  const original = credential();
  for (const absent of [undefined, null]) assert.throws(() => assertGatewayProviderBinding(absent, original), hasCode("GATEWAY_PROVIDER_BINDING_MISSING"));
  for (const invalid of [{}, { version: 2 }, [], { version: 1, credential_id: original.id, fingerprint: "bad" }]) {
    assert.throws(() => assertGatewayProviderBinding(invalid, original), hasCode("GATEWAY_PROVIDER_BINDING_INVALID"));
  }
  assert.throws(() => freezeGatewayProviderBinding({ ...original, public_metadata_json: { base_url: "http://127.0.0.1:18082/v1" } }),
    hasCode("GATEWAY_PROVIDER_ENDPOINT_MISMATCH"));
  const fallback = { id: "synthetic-default", provider: "anthropic", agent_cli: "claude-code", settings_config_json: {} };
  assert.doesNotThrow(() => freezeGatewayProviderBinding(fallback));
});
