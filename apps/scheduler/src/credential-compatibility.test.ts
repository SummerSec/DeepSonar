import assert from "node:assert/strict";
import test from "node:test";
import {
  UNKNOWN_PROVIDER_ERROR,
  projectCredentialProviderError,
  validateCredentialCompatibility,
  validateCredentialRoleConfigBinding,
  validateCredentialRuntimeMutation,
} from "./credentials.js";

test("CLI 与协议 provider 严格兼容", () => {
  assert.equal(validateCredentialCompatibility("claude-code", "anthropic"), null);
  assert.equal(validateCredentialCompatibility("open-code", "anthropic"), null);
  assert.equal(validateCredentialCompatibility("open-code", "openai"), null);
  assert.equal(validateCredentialCompatibility("codex", "openai"), null);
  assert.match(
    validateCredentialCompatibility("claude-code", "openai") ?? "",
    /claude-code.*anthropic.*openai/,
  );
});

test("未知 CLI/provider fail closed", () => {
  assert.equal(validateCredentialCompatibility("open-code", "openai"), null);
  assert.match(validateCredentialCompatibility("codex", "anthropic") ?? "", /codex.*openai/);
  assert.match(validateCredentialCompatibility("custom-cli", "openai") ?? "", /未知 agent_cli/);
});

test("legacy server provider errors are projected without rewriting arbitrary target errors", () => {
  const legacy = "legacy-provider-secret";
  assert.equal(projectCredentialProviderError(`未知 provider: ${legacy}`), UNKNOWN_PROVIDER_ERROR);
  assert.equal(projectCredentialProviderError(`未知 Credential provider: ${legacy}`), UNKNOWN_PROVIDER_ERROR);
  assert.equal(
    projectCredentialProviderError(`Credential provider 已从 ${legacy} 变更为 openai，Job 快照已过期，请刷新 pending Job 或 retry`),
    UNKNOWN_PROVIDER_ERROR,
  );
  assert.equal(projectCredentialProviderError(`target reported ${legacy}`), `target reported ${legacy}`);
  assert.equal(projectCredentialProviderError("未知 provider: openai"), "未知 provider: openai");
});

test("Credential 运行语义变更拒绝破坏既有消费者", () => {
  const consumers = [{
    source: "RoleConfig role-1",
    agentCli: "claude-code",
    model: "claude-sonnet-4-5",
    projectId: "project-1",
  }];
  assert.match(validateCredentialRuntimeMutation({
    provider: "openai",
    projectId: "project-1",
    metadata: {},
    consumers,
  }) ?? "", /RoleConfig role-1.*不兼容/);
  assert.match(validateCredentialRuntimeMutation({
    provider: "anthropic",
    projectId: "project-2",
    metadata: {},
    consumers,
  }) ?? "", /不能使用项目 project-2/);
  assert.equal(validateCredentialRuntimeMutation({
    provider: "anthropic",
    projectId: "project-1",
    metadata: { allowed_model_ids: ["claude-opus-4-1"] },
    consumers,
  }), null);
});

test("Credential 运行语义变更允许兼容的全局凭据与模型", () => {
  assert.equal(validateCredentialRuntimeMutation({
    provider: "anthropic",
    projectId: null,
    metadata: { allowed_model_ids: ["claude-sonnet-4-5"] },
    consumers: [{
      source: "pending Job job-1",
      agentCli: "claude-code",
      model: "claude-sonnet-4-5",
      projectId: "project-1",
    }],
  }), null);
});

test("Credential 配置文件 CLI 变更不能破坏已有角色绑定", () => {
  assert.match(validateCredentialRuntimeMutation({
    provider: "openai",
    projectId: null,
    metadata: {},
    settingsConfig: { config: 'model = "gpt-5"' },
    credentialAgentCli: "codex",
    consumers: [{
      source: "RoleConfig role-1",
      agentCli: "claude-code",
      model: null,
      projectId: null,
    }],
  }) ?? "", /RoleConfig role-1.*claude-code.*codex/);
});

test("RoleConfig 导入绑定复用项目作用域与 provider 校验", () => {
  const base = {
    source: "RoleConfig imported-role",
    purpose: "llm",
    agentCli: "claude-code",
    model: "claude-sonnet-4-5",
    credentialProjectId: "project-1",
    roleConfigProjectId: "project-1",
    provider: "anthropic",
    metadata: { allowed_model_ids: ["claude-sonnet-4-5"] },
  };
  assert.equal(validateCredentialRoleConfigBinding(base), null);
  assert.equal(validateCredentialRoleConfigBinding({ ...base, model: "claude-opus-4-1" }), null);
  assert.match(
    validateCredentialRoleConfigBinding({ ...base, roleConfigProjectId: null }) ?? "",
    /全局 RoleConfig.*全局 Credential/,
  );
  assert.match(
    validateCredentialRoleConfigBinding({ ...base, provider: "openai" }) ?? "",
    /不兼容.*claude-code/,
  );
});
