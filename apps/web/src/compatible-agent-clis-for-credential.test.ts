import assert from "node:assert/strict";
import test from "node:test";
import { compatibleAgentClisForCredential, credentialSupportsCli } from "./components/ProjectCliProviderAllowlistPanel";
import type { ProviderCredential } from "./api";

function cred(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "demo",
    kind: "llm_provider",
    provider: "anthropic",
    project_id: null,
    key_version: 1,
    public_metadata_json: {},
    fingerprint: "abcd",
    last4: "1234",
    status: "active",
    last_used_at: null,
    rotated_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    active_concurrency: { in_use: 0, max_concurrent: null },
    agent_cli: "pi",
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["claude-opus"],
      model_catalog_fetched_at: "2026-01-01T00:00:00.000Z",
    },
    adapter: {
      adapter_id: "anthropic",
      adapter_version: "1",
      provider: "anthropic",
      label: "Anthropic",
      compatible_agent_clis: ["claude-code", "pi", "dsh"],
      gateway: {},
    },
    ...overrides,
  };
}

test("pi-only credential cannot claim claude-code compatibility", () => {
  const credential = cred({ agent_cli: "pi", provider: "anthropic" });
  assert.deepEqual(compatibleAgentClisForCredential(credential), ["pi"]);
  assert.equal(credentialSupportsCli(credential, "pi"), true);
  assert.equal(credentialSupportsCli(credential, "claude-code"), false);
  assert.equal(credentialSupportsCli(credential, "dsh"), false);
});

test("claude-code-only credential cannot claim pi compatibility", () => {
  const credential = cred({ agent_cli: "claude-code", provider: "anthropic" });
  assert.deepEqual(compatibleAgentClisForCredential(credential), ["claude-code"]);
  assert.equal(credentialSupportsCli(credential, "claude-code"), true);
  assert.equal(credentialSupportsCli(credential, "pi"), false);
});

test("missing or invalid agent_cli fail-closes to empty compatibility", () => {
  assert.deepEqual(compatibleAgentClisForCredential(cred({ agent_cli: null })), []);
  assert.deepEqual(compatibleAgentClisForCredential(cred({ agent_cli: "codex" as never })), []);
  assert.deepEqual(compatibleAgentClisForCredential(cred({ agent_cli: undefined })), []);
});
