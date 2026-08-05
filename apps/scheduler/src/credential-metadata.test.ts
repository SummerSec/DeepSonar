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
  assert.equal(isProviderAllowedForKind("llm_provider", "plane"), false);
  assert.equal(isProviderAllowedForKind("plane", "plane"), true);
  assert.equal(isProviderAllowedForKind("git", "git"), true);
  assert.equal(isProviderAllowedForKind("oci_registry", "registry.example.test"), true);
});

test("new Credential metadata accepts only server-owned fields and rejects secret-like keys", () => {
  assert.deepEqual(
    sanitizeCredentialMetadata({
      base_url: "https://api.example.test/v1///",
      allowed_model_ids: ["model-a", "model-a"],
      model_concurrency: { "model-a": 2 },
      max_concurrent: 4,
    }, { kind: "llm_provider", provider: "openai" }),
    {
      base_url: "https://api.example.test/v1",
      allowed_model_ids: ["model-a"],
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
      allowed_model_ids: ["model-a", "model-b"],
      model_concurrency: { "model-a": 2 },
    },
  );
});

test("base_url rejects userinfo/query/fragment and only allows http(s)", () => {
  for (const base_url of [
    "https://user:password@example.test/v1",
    "https://example.test/v1?token=secret",
    "https://example.test/v1#fragment",
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
    () => sanitizeCredentialMetadata({ base_url: "https://openrouter.ai/api/v1" }, { kind: "llm_provider", provider: "openrouter" }),
    /metadata key/,
  );
  assert.deepEqual(
    projectCredentialMetadata("llm_provider", "openrouter", {
      base_url: "https://legacy.example/v1",
      allowed_model_ids: ["model-a"],
    }),
    { allowed_model_ids: ["model-a"] },
  );
});

test("legacy projection drops unsafe/unknown metadata without echoing it", () => {
  const secret = "sk-legacy-secret";
  const projected = projectCredentialMetadata("llm_provider", "anthropic", {
    base_url: `https://example.test/v1?token=${secret}`,
    api_key: secret,
    unknown: secret,
    allowed_model_ids: ["claude-sonnet-4-5"],
  });
  assert.deepEqual(projected, { allowed_model_ids: ["claude-sonnet-4-5"] });
  assert.equal(JSON.stringify(projected).includes(secret), false);
});

test("model catalogs are bounded to unique safe string IDs", () => {
  assert.deepEqual(
    normalizeModelCatalog(["z", "a", "a", { id: "ignored" }, "\u0000bad", "x".repeat(201)]),
    ["a", "z"],
  );
});
