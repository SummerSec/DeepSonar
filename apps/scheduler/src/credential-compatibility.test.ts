import assert from "node:assert/strict";
import test from "node:test";
import {
  UNKNOWN_PROVIDER_ERROR,
  planCredentialAgentCliFollow,
  projectCredentialProviderError,
  validateCredentialAgentCliExclusive,
  validateCredentialCompatibility,
  validateCredentialRoleConfigBinding,
  validateCredentialRuntimeMutation,
} from "./credentials.js";

test("CLI 与协议 provider 严格兼容", () => {
  assert.equal(validateCredentialCompatibility("claude-code", "anthropic"), null);
  assert.equal(validateCredentialCompatibility("pi", "anthropic"), null);
  assert.equal(validateCredentialCompatibility("pi", "openai"), null);
  assert.equal(validateCredentialCompatibility("dsh", "openai"), null);
  assert.match(
    validateCredentialCompatibility("claude-code", "openai") ?? "",
    /claude-code.*anthropic.*openai/,
  );
});

test("未知 CLI/provider fail closed", () => {
  assert.match(validateCredentialCompatibility("codex", "openai") ?? "", /不再支持新配置/);
  assert.match(validateCredentialCompatibility("open-code", "anthropic") ?? "", /不再支持新配置/);
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
    credentialAgentCli: "dsh",
    consumers: [{
      source: "RoleConfig role-1",
      agentCli: "claude-code",
      model: null,
      projectId: null,
    }],
  }) ?? "", /RoleConfig role-1.*不兼容.*claude-code/);
});

test("账号 agent_cli 独占：不可按 Provider 矩阵扩到其他 CLI", () => {
  assert.match(validateCredentialRuntimeMutation({
    provider: "anthropic",
    projectId: null,
    metadata: {},
    settingsConfig: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    credentialAgentCli: "claude-code",
    consumers: [{
      source: "RoleConfig hub",
      agentCli: "pi",
      model: null,
      projectId: null,
    }],
  }) ?? "", /独占绑定|agent_cli=claude-code.*pi/);
  assert.match(validateCredentialRoleConfigBinding({
    source: "RoleConfig imported-role",
    purpose: "llm",
    agentCli: "pi",
    model: null,
    credentialProjectId: "project-1",
    roleConfigProjectId: "project-1",
    provider: "anthropic",
    metadata: {},
    credentialAgentCli: "claude-code",
  }) ?? "", /独占绑定|agent_cli=claude-code.*pi/);
  assert.match(validateCredentialRoleConfigBinding({
    source: "RoleConfig imported-role",
    purpose: "llm",
    agentCli: "claude-code",
    model: null,
    credentialProjectId: "project-1",
    roleConfigProjectId: "project-1",
    provider: "anthropic",
    metadata: {},
    credentialAgentCli: "pi",
  }) ?? "", /独占绑定|agent_cli=pi.*claude-code/);
  assert.equal(validateCredentialRoleConfigBinding({
    source: "RoleConfig imported-role",
    purpose: "llm",
    agentCli: "pi",
    model: null,
    credentialProjectId: "project-1",
    roleConfigProjectId: "project-1",
    provider: "anthropic",
    metadata: {},
    credentialAgentCli: "pi",
  }), null);
  assert.match(validateCredentialAgentCliExclusive("claude-code", null) ?? "", /缺失或非法/);
  assert.match(validateCredentialAgentCliExclusive("pi", "codex") ?? "", /缺失或非法/);
});

test("兼容 provider 仍要求账号 agent_cli 与角色一致（不再跟随改写）", () => {
  const mismatch = planCredentialAgentCliFollow({
    roleAgentCli: "pi",
    credentialAgentCli: "claude-code",
    provider: "anthropic",
  });
  assert.equal(mismatch.action, "reject");
  assert.match(mismatch.action === "reject" ? mismatch.error : "", /独占绑定|claude-code.*pi/);
  assert.deepEqual(
    planCredentialAgentCliFollow({
      roleAgentCli: "pi",
      credentialAgentCli: "pi",
      provider: "anthropic",
    }),
    { action: "keep" },
  );
  const missing = planCredentialAgentCliFollow({
    roleAgentCli: "pi",
    credentialAgentCli: null,
    provider: "openai",
  });
  assert.equal(missing.action, "reject");
  assert.match(missing.action === "reject" ? missing.error : "", /缺失或非法/);
});

test("不兼容 provider 仍拒绝跟随", () => {
  const plan = planCredentialAgentCliFollow({
    roleAgentCli: "claude-code",
    credentialAgentCli: "codex",
    provider: "openai",
  });
  assert.equal(plan.action, "reject");
  assert.match(plan.action === "reject" ? plan.error : "", /claude-code.*anthropic.*openai/);
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
    credentialAgentCli: "claude-code",
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
