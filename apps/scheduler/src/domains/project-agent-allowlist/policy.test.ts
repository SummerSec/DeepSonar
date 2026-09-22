import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectAgentAllowlistPatch,
  assertAgentCliAllowlisted,
  assertCredentialAllowlisted,
  parseProjectAgentAllowlist,
  seedProjectAgentAllowlist,
  toHubAgentCliCatalog,
  compatibleAgentClisForProvider,
  toHubProviderCatalogEntry,
} from "./policy.js";

test("parse: 缺键视为未配置，CLI 全集，凭据空", () => {
  const allowlist = parseProjectAgentAllowlist({});
  assert.equal(allowlist.configured, false);
  assert.deepEqual(allowlist.enabled_agent_clis, ["claude-code", "pi", "dsh"]);
  assert.deepEqual(allowlist.enabled_credential_ids, []);
});

test("seed: 从未配置迁移到绑定集合，不静默丢弃", () => {
  const cfg: Record<string, unknown> = {};
  const cred = "11111111-1111-4111-8111-111111111111";
  const { changed, allowlist } = seedProjectAgentAllowlist(cfg, {
    agent_clis: ["pi", "leftover"],
    credential_ids: [cred],
  });
  assert.equal(changed, true);
  assert.equal(allowlist.configured, true);
  assert.ok(allowlist.enabled_agent_clis.includes("claude-code"));
  assert.ok(allowlist.enabled_agent_clis.includes("pi"));
  assert.ok(!allowlist.enabled_agent_clis.includes("leftover" as never));
  assert.deepEqual(allowlist.enabled_credential_ids, [cred]);
  assert.equal(allowlist.default_credential_id, cred);
});

test("seed: 已配置不再改写", () => {
  const cfg: Record<string, unknown> = {
    enabled_agent_clis: ["claude-code"],
    enabled_credential_ids: [],
  };
  const { changed } = seedProjectAgentAllowlist(cfg, {
    agent_clis: ["pi"],
    credential_ids: ["11111111-1111-4111-8111-111111111111"],
  });
  assert.equal(changed, false);
  assert.deepEqual(cfg.enabled_agent_clis, ["claude-code"]);
});

test("patch: 缺省必须 ∈ 白名单；至少一种 CLI", () => {
  const cfg: Record<string, unknown> = {};
  assert.throws(
    () => applyProjectAgentAllowlistPatch(cfg, { enabled_agent_clis: [] }),
    /至少启用一种 Agent CLI/,
  );
  const allowlist = applyProjectAgentAllowlistPatch(cfg, {
    enabled_agent_clis: ["claude-code", "pi"],
    enabled_credential_ids: ["11111111-1111-4111-8111-111111111111"],
    default_agent_cli: "pi",
    default_credential_id: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(allowlist.default_agent_cli, "pi");
  assert.throws(
    () => applyProjectAgentAllowlistPatch(cfg, { default_agent_cli: "dsh" }),
    /必须属于已启用白名单/,
  );
});

test("model defaults and fallback refs stay paired with the selected Provider", () => {
  const cred = "11111111-1111-4111-8111-111111111111";
  const cfg: Record<string, unknown> = {};
  const allowlist = applyProjectAgentAllowlistPatch(cfg, {
    enabled_agent_clis: ["pi"],
    enabled_credential_ids: [cred],
    default_agent_cli: "pi",
    default_credential_id: cred,
    default_model_ref: "gpt-5",
    fallback_model_refs: ["o4-mini", "gpt-5"],
    allow_model_catalog_passthrough: true,
  });
  assert.equal(allowlist.default_model_ref, "gpt-5");
  assert.deepEqual(allowlist.fallback_model_refs, ["o4-mini", "gpt-5"]);
  assert.equal(allowlist.allow_model_catalog_passthrough, true);
  const cleared = applyProjectAgentAllowlistPatch(cfg, { default_credential_id: null });
  assert.equal(cleared.default_model_ref, null);
  assert.deepEqual(cleared.fallback_model_refs, []);
});

test("assert: 未配置不阻断；配置后 fail-closed", () => {
  const open = parseProjectAgentAllowlist({});
  assert.doesNotThrow(() => assertAgentCliAllowlisted(open, "pi"));
  assert.doesNotThrow(() => assertCredentialAllowlisted(open, "11111111-1111-4111-8111-111111111111"));

  const closed = parseProjectAgentAllowlist({
    enabled_agent_clis: ["claude-code"],
    enabled_credential_ids: ["11111111-1111-4111-8111-111111111111"],
  });
  assert.throws(() => assertAgentCliAllowlisted(closed, "pi"), /不在本项目已启用白名单/);
  assert.throws(
    () => assertCredentialAllowlisted(closed, "22222222-2222-4222-8222-222222222222"),
    /不在本项目已启用 Provider/,
  );
  assert.doesNotThrow(() => assertAgentCliAllowlisted(closed, "claude-code"));
  assert.doesNotThrow(() => assertCredentialAllowlisted(closed, "11111111-1111-4111-8111-111111111111"));
});

test("Hub catalog: CLI 与 Provider 条目含缺省标记与并发摘要", () => {
  const cred = "11111111-1111-4111-8111-111111111111";
  const allowlist = parseProjectAgentAllowlist({
    enabled_agent_clis: ["claude-code", "pi"],
    enabled_credential_ids: [cred],
    default_agent_cli: "claude-code",
    default_credential_id: cred,
  });
  const clis = toHubAgentCliCatalog(allowlist);
  assert.equal(clis.find((c) => c.agent_cli === "claude-code")?.is_default, true);
  assert.equal(clis.find((c) => c.agent_cli === "pi")?.is_default, false);

  const entry = toHubProviderCatalogEntry({
    id: cred,
    name: "main",
    provider: "anthropic",
    status: "active",
    agent_cli: "claude-code",
    public_metadata_json: { max_concurrent: 2, model_concurrency: { "claude-opus": 1 } },
    model_catalog_json: ["claude-opus"],
  }, allowlist);
  assert.ok(entry);
  assert.equal(entry!.is_default, true);
  assert.equal(entry!.max_concurrent, 2);
  assert.deepEqual(entry!.model_concurrency, { "claude-opus": 1 });
  assert.deepEqual(entry!.compatible_agent_clis, ["claude-code"]);
  assert.equal(entry!.models[0]?.model_id, "claude-opus");
  // anthropic provider catalog still supports multiple CLIs, but saved pin stays singleton.
  assert.deepEqual(
    toHubProviderCatalogEntry({
      id: cred,
      name: "pi-only",
      provider: "anthropic",
      status: "active",
      agent_cli: "pi",
    }, allowlist)!.compatible_agent_clis,
    ["pi"],
  );
  assert.equal(
    toHubProviderCatalogEntry({
      id: cred,
      name: "missing-cli",
      provider: "anthropic",
      status: "active",
    }, allowlist),
    null,
  );
  assert.equal(
    toHubProviderCatalogEntry({
      id: "22222222-2222-4222-8222-222222222222",
      name: "other",
      provider: "anthropic",
      status: "active",
      agent_cli: "claude-code",
    }, allowlist),
    null,
  );
});


test("provider catalog keeps multi-CLI protocol capability without leaking onto credential pin", () => {
  assert.deepEqual(compatibleAgentClisForProvider("anthropic"), ["claude-code", "pi", "dsh"]);
  assert.ok(compatibleAgentClisForProvider("anthropic").includes("pi"));
  const allowlist = parseProjectAgentAllowlist({
    enabled_agent_clis: ["claude-code", "pi", "dsh"],
    enabled_credential_ids: ["11111111-1111-4111-8111-111111111111"],
  });
  const pinned = toHubProviderCatalogEntry({
    id: "11111111-1111-4111-8111-111111111111",
    name: "pi-account",
    provider: "anthropic",
    status: "active",
    agent_cli: "pi",
  }, allowlist);
  assert.deepEqual(pinned!.compatible_agent_clis, ["pi"]);
  assert.ok(!pinned!.compatible_agent_clis.includes("claude-code"));
});
