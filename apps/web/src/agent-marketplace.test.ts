import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMe } from "./api";
import { AGENT_PACK_SCHEMA, canInstallAgentPack, parseAgentPack } from "./agent-marketplace";

test("agent pack parser accepts a credential-free v1 package", () => {
  const pack = parseAgentPack(JSON.stringify({
    schema: AGENT_PACK_SCHEMA,
    name: "community_review",
    title: "社区复核",
    description: "独立复核模板",
    publisher: "local",
    version: "1.0.0",
    config: { agent_cli: "pi", env_vars: {}, config_files: [] },
  }));
  assert.equal(pack.name, "community_review");
  assert.equal(pack.config.agent_cli, "pi");
  assert.equal("credentials" in pack.config, false);
  assert.equal(pack.config.dsh_task_mode, "standard");
  assert.equal("pi_extensions" in pack.config, false);
});

test("agent pack rejects credentials field (#690)", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA, name: "cred", title: "Cred", description: "x", publisher: "local", version: "1.0.0",
  };
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "pi", credentials: [] } })));
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "pi", credentials: [{ credential_id: "11111111-1111-4111-8111-111111111111", purpose: "llm" }] } })));
});

test("agent pack rejects pi_extensions capability field (#690)", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA, name: "pi_web", title: "Pi web", description: "web access", publisher: "local", version: "1.0.0",
  };
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "pi", pi_extensions: ["pi-web-access"] } })));
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "pi", pi_extensions: ["not-registered"] } })));
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "claude-code", pi_extensions: ["pi-web-access"] } })));
});

test("agent pack validates DSH task mode", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA, name: "dsh_ptc", title: "DSH PTC", description: "PTC preset", publisher: "local", version: "1.0.0",
  };
  assert.equal(parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "dsh", dsh_task_mode: "ptc" } })).config.dsh_task_mode, "ptc");
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { agent_cli: "dsh", reasoning: "max" } })), /未知字段: reasoning/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { dsh_task_mode: "auto" } })), /dsh_task_mode/);
});

test("agent pack round-trips a validated context window budget and defaults it to null", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA,
    name: "context_pack",
    title: "Context pack",
    description: "Context budget fixture",
    publisher: "local",
    version: "1.0.0",
  };
  assert.equal(parseAgentPack(JSON.stringify({ ...base, config: {} })).config.context_window_tokens, null);
  assert.equal(
    parseAgentPack(JSON.stringify({ ...base, config: { context_window_tokens: 1_000_000 } })).config.context_window_tokens,
    1_000_000,
  );
  for (const invalid of [1023, 10_000_001, 1024.5, "1000000"]) {
    assert.throws(
      () => parseAgentPack(JSON.stringify({ ...base, config: { context_window_tokens: invalid } })),
      /context_window_tokens/,
    );
  }
});

test("agent pack parser rejects credentials and secret-like environment keys", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA,
    name: "unsafe_pack",
    title: "Unsafe",
    description: "Unsafe fixture",
    publisher: "local",
    version: "1.0.0",
  };
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { credentials: [{ credential_id: "x", purpose: "model" }] } })), /不得携带 credentials/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { env_vars: { API_TOKEN: "secret" } } })), /长期密钥/);
});

test("agent pack parser matches the scheduler role-name contract", () => {
  const invalid = JSON.stringify({
    schema: AGENT_PACK_SCHEMA,
    name: "surface-map",
    title: "Surface map",
    description: "Maps the target surface.",
    publisher: "local",
    version: "1.0.0",
    config: {},
  });
  assert.throws(() => parseAgentPack(invalid), /name/);
});

test("agent pack parser rejects unknown and nested secret fields", () => {
  const base = {
    schema: AGENT_PACK_SCHEMA,
    name: "safe_name",
    title: "Safe",
    description: "Safe fixture",
    publisher: "local",
    version: "1.0.0",
  };
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { api_key: "secret" } })), /未知字段/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { mcps: [{ authorization: "Bearer secret" }] } })), /长期密钥/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { env_keys: "ANTHROPIC_API_KEY" } })), /字符串数组/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { modules: {} } })), /字符串数组/);
  assert.throws(() => parseAgentPack(JSON.stringify({ ...base, config: { env_vars: { DEEPSONAR_JOB_TOKEN: "x" } } })), /系统保留/);
});

test("agent pack install rejects project-scoped actors", () => {
  const globalActor: AuthMe = { auth_required: true, authenticated: true, actor: { type: "api_token", name: "global", scopes: ["agents:write"], project_id: null, role: null }, user: null };
  const projectActor: AuthMe = { auth_required: true, authenticated: true, actor: { type: "api_token", name: "project", scopes: ["agents:write"], project_id: "project-id", role: null }, user: null };
  assert.equal(canInstallAgentPack(globalActor), true);
  assert.equal(canInstallAgentPack(projectActor), false);
});
