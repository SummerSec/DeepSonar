import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectModelPolicyPatch,
  assertModelAllowlisted,
  parseProjectModelPolicy,
  resolveSoftDefaultModel,
  seedProjectModelPolicy,
  toHubModelCatalogEntries,
} from "./policy.js";
import { parseProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";

test("parse: 缺键视为未配置，不限制模型", () => {
  const policy = parseProjectModelPolicy({});
  assert.equal(policy.configured, false);
  assert.deepEqual(policy.enabled_model_ids, []);
  assert.equal(policy.default_model_id, null);
  assert.deepEqual(policy.fallback_model_ids, []);
});

test("seed: 从未配置迁移到已见模型集合", () => {
  const cfg: Record<string, unknown> = {};
  const { changed, policy } = seedProjectModelPolicy(cfg, {
    model_ids: ["claude-sonnet-4-5", "claude-opus-5", "claude-sonnet-4-5", ""],
  });
  assert.equal(changed, true);
  assert.equal(policy.configured, true);
  assert.deepEqual(policy.enabled_model_ids, ["claude-sonnet-4-5", "claude-opus-5"]);
});

test("seed: 已配置不再改写", () => {
  const cfg: Record<string, unknown> = { enabled_model_ids: ["only-a"] };
  const { changed } = seedProjectModelPolicy(cfg, { model_ids: ["only-b"] });
  assert.equal(changed, false);
  assert.deepEqual(cfg.enabled_model_ids, ["only-a"]);
});

test("patch: 缺省/fallback 必须 ∈ 白名单；至少一种模型", () => {
  const cfg: Record<string, unknown> = {};
  assert.throws(
    () => applyProjectModelPolicyPatch(cfg, { enabled_model_ids: [] }),
    /至少启用一个模型/,
  );
  const policy = applyProjectModelPolicyPatch(cfg, {
    enabled_model_ids: ["claude-sonnet-4-5", "claude-opus-5"],
    default_model_id: "claude-sonnet-4-5",
    fallback_model_ids: ["claude-opus-5"],
  });
  assert.equal(policy.default_model_id, "claude-sonnet-4-5");
  assert.deepEqual(policy.fallback_model_ids, ["claude-opus-5"]);
  assert.throws(
    () => applyProjectModelPolicyPatch(cfg, { default_model_id: "gpt-5" }),
    /必须属于已启用白名单/,
  );
});

test("assert: 未配置不阻断；配置后 fail-closed（含 cli-default 剥壳）", () => {
  const open = parseProjectModelPolicy({});
  assert.doesNotThrow(() => assertModelAllowlisted(open, "anything"));

  const closed = parseProjectModelPolicy({
    enabled_model_ids: ["claude-sonnet-4-5"],
  });
  assert.throws(() => assertModelAllowlisted(closed, "claude-opus-5"), /不在本项目已启用模型白名单/);
  assert.doesNotThrow(() => assertModelAllowlisted(closed, "claude-sonnet-4-5"));
  assert.doesNotThrow(() => assertModelAllowlisted(closed, "cli-default:claude-sonnet-4-5"));
  assert.throws(() => assertModelAllowlisted(closed, null), /未能解析到模型/);
});

test("soft default: prefer > default > fallback ∩ available", () => {
  const policy = parseProjectModelPolicy({
    enabled_model_ids: ["a", "b", "c"],
    default_model_id: "a",
    fallback_model_ids: ["b", "c"],
  });
  assert.equal(resolveSoftDefaultModel({ policy, prefer: "c" }), "c");
  assert.equal(resolveSoftDefaultModel({ policy, prefer: null, available: ["b", "c"] }), "b");
  assert.equal(resolveSoftDefaultModel({ policy, prefer: null, available: ["c"] }), "c");
  assert.equal(resolveSoftDefaultModel({ policy, prefer: null, available: ["z"] }), null);
});

test("Hub catalog: 过滤项目白名单与 Provider 白名单，并标记缺省/fallback", () => {
  const cred = "11111111-1111-4111-8111-111111111111";
  const policy = parseProjectModelPolicy({
    enabled_model_ids: ["claude-sonnet-4-5", "claude-opus-5"],
    default_model_id: "claude-sonnet-4-5",
    fallback_model_ids: ["claude-opus-5"],
  });
  const agentAllowlist = parseProjectAgentAllowlist({
    enabled_agent_clis: ["claude-code"],
    enabled_credential_ids: [cred],
  });
  const entries = toHubModelCatalogEntries({
    policy,
    agentAllowlist,
    credentials: [
      {
        id: cred,
        name: "main",
        provider: "anthropic",
        status: "active",
        model_catalog_json: ["claude-sonnet-4-5", "claude-opus-5", "blocked-model"],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "other",
        provider: "anthropic",
        status: "active",
        model_catalog_json: ["claude-sonnet-4-5"],
      },
    ],
  });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.credential_id === cred));
  assert.ok(!entries.some((e) => e.model_id === "blocked-model"));
  assert.equal(entries.find((e) => e.model_id === "claude-sonnet-4-5")?.is_default, true);
  assert.equal(entries.find((e) => e.model_id === "claude-opus-5")?.is_fallback, true);
});
