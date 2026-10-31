import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderAllowedForKind,
  projectCredentialMetadata,
  sanitizeCredentialMetadata,
  normalizeModelCatalog,
} from "./credentials.js";

test("provider/kind allowlist preserves supported mappings only", () => {
  assert.equal(isProviderAllowedForKind("llm_provider", "anthropic"), true);
  assert.equal(isProviderAllowedForKind("llm_provider", "git"), false);
  assert.equal(isProviderAllowedForKind("git", "git"), true);
  assert.equal(isProviderAllowedForKind("oci_registry", "registry.example.test"), true);
});

test("new Credential metadata accepts only server-owned fields and rejects secret-like keys", () => {
  assert.deepEqual(
    sanitizeCredentialMetadata({
      base_url: "http://127.0.0.1/v1///",
      model_concurrency: { "model-a": 2 },
      max_concurrent: 4,
    }, { kind: "llm_provider", provider: "openai" }),
    {
      base_url: "http://127.0.0.1/v1",
      model_concurrency: { "model-a": 2 },
      max_concurrent: 4,
    },
  );
  assert.throws(
    () => sanitizeCredentialMetadata({ api_key: "secret" }, { kind: "llm_provider", provider: "openai" }),
    /metadata key/,
  );
  assert.throws(
    () => sanitizeCredentialMetadata({ arbitrary: "value" }, { kind: "llm_provider", provider: "openai" }),
    /metadata key/,
  );
  assert.throws(
    () => sanitizeCredentialMetadata({ max_concurrent: "4" }, { kind: "llm_provider", provider: "openai" }),
    /JSON number/,
  );
});

test("unknown metadata keys do not survive in error metadata", () => {
  assert.throws(
    () => sanitizeCredentialMetadata({ "attacker-controlled-secret-key": "value" }, { kind: "llm_provider", provider: "openai" }),
    (error: unknown) => {
      assert.equal((error as { key?: unknown }).key, undefined);
      assert.equal(String((error as Error).message).includes("attacker-controlled-secret-key"), false);
      return true;
    },
  );
});

test("legacy/drop metadata keeps valid model and numeric entries only", () => {
  assert.deepEqual(
    projectCredentialMetadata("llm_provider", "openai", {
      allowed_model_ids: ["model-a", null, true, "", 42, "model-b"],
      model_concurrency: { "model-a": 2, "model-b": null, "model-c": true, "model-d": "4" },
      max_concurrent: "8",
    }),
    {
      model_concurrency: { "model-a": 2 },
    },
  );
});

test("base_url rejects userinfo/query/fragment and only allows http(s)", () => {
  for (const base_url of [
    "https://user:password@127.0.0.1/v1",
    "http://127.0.0.1/v1?token=secret",
    "http://127.0.0.1/v1#fragment",
    "file:///tmp/provider",
  ]) {
    assert.throws(
      () => sanitizeCredentialMetadata({ base_url }, { kind: "llm_provider", provider: "anthropic" }),
      /base_url/,
    );
  }
});

test("provider catalog is authoritative for base_url capability", () => {
  assert.throws(
    () => sanitizeCredentialMetadata({ base_url: "http://127.0.0.1/v1" }, { kind: "llm_provider", provider: "openrouter" }),
    /metadata key/,
  );
  assert.deepEqual(
    projectCredentialMetadata("llm_provider", "openrouter", {
      base_url: "http://127.0.0.1/v1",
      allowed_model_ids: ["model-a"],
    }),
    {},
  );
});

test("legacy projection drops unsafe/unknown metadata without echoing it", () => {
  const secret = "sk-legacy-secret";
  const projected = projectCredentialMetadata("llm_provider", "anthropic", {
    base_url: `http://127.0.0.1/v1?token=${secret}`,
    api_key: secret,
    unknown: secret,
    allowed_model_ids: ["claude-sonnet-4-5"],
  });
  assert.deepEqual(projected, {});
  assert.equal(JSON.stringify(projected).includes(secret), false);
});

test("leftover allowed_model_ids is rejected on write and dropped from legacy projection", () => {
  assert.throws(
    () => sanitizeCredentialMetadata({
      allowed_model_ids: ["stale-model"],
      model_concurrency: { "GLM-5.2[1M]": 2 },
    }, { kind: "llm_provider", provider: "anthropic" }),
    /metadata key/,
  );
  assert.deepEqual(
    sanitizeCredentialMetadata({
      allowed_model_ids: ["stale-model"],
      model_concurrency: { "GLM-5.2[1M]": 2 },
    }, { kind: "llm_provider", provider: "anthropic", mode: "drop" }),
    { model_concurrency: { "GLM-5.2[1M]": 2 } },
  );
});

test("model catalogs are bounded to unique safe string IDs", () => {
  assert.deepEqual(
    normalizeModelCatalog(["z", "a", "a", { id: "ignored" }, "\u0000bad", "x".repeat(201)]),
    ["a", "z"],
  );
});
