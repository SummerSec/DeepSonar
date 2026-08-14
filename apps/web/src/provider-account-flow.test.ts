import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSettingsConfigFromEditor } from "./CredentialConfigEditor";

const flow = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./CredentialsPanel.tsx", import.meta.url), "utf8");

test("Provider account flow keeps the happy path on one surface", () => {
  for (const marker of [
    "createCredential",
    "testCredential",
    "credentialModels",
    "credentialCompatibility",
    "bindableRoleConfigs",
    "bindCredentialsBatch",
    "authMe",
    "can_bind",
    "supports_base_url",
    "idempotency_key",
    "new_jobs_only",
    "refresh_pending",
    "refreshed_pending_job_count",
    "原始遗留值不会展示或回传",
    "settings_config",
    "agent_cli",
    "eligibleRoleConfigs",
    "modelsFromSettingsConfig",
    "saveEditedConfig",
    "CredentialConfigEditor",
    "openEditCredential",
    "provider-flow-credential-list",
    "buildSettingsConfigFromEditor",
  ]) {
    assert.ok(flow.includes(marker), `flow should expose ${marker}`);
  }
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  for (const marker of ["auth.json", "CcSwitchClaudeFields", "CcSwitchCodexFields", "CcSwitchOpenCodeFields", "ANTHROPIC_AUTH_TOKEN"]) {
    assert.ok(editor.includes(marker), `editor should expose ${marker}`);
  }
  assert.ok(
    editor.indexOf('ariaLabel="Agent CLI 类型"') < editor.indexOf('ariaLabel="Provider"'),
    "Agent CLI must be selected before Provider",
  );
  assert.ok(editor.includes("item.compatible_agent_cli.includes(agentCli)"));
  assert.match(flow, /setCreateSecret\(\"\"\)/);
  assert.match(flow, /(?:活跃|运行中)快照保持冻结/);
  assert.match(flow, /const canToggle = roleConfig\.can_bind && !incompatible/);
  assert.match(flow, /项目作用域账号只能在本项目内创建 Provider 账号/);
  assert.match(flow, /testCredential\(created\.id\)/);
  // No model-threshold / model-mapping bind UI.
  assert.doesNotMatch(flow, /02 \/ 模型门槛/);
  assert.doesNotMatch(flow, /02 \/ 模型映射/);
  assert.doesNotMatch(flow, /选择统一模型/);
  assert.doesNotMatch(flow, /绑定需要非空的当前模型目录|绑定需要模型目录/);
  // List first; CC Switch editor expands on edit (not always open).
  assert.doesNotMatch(flow, /模型映射/);
  assert.doesNotMatch(flow, /一键设置/);
  assert.doesNotMatch(flow, /声明支持 1M/);
  assert.match(flow, /01 \/ 账号列表/);
  assert.match(flow, /02 \/ 角色配置/);
  assert.match(flow, /03 \/ 生效策略/);
  const claudeFields = readFileSync(new URL("./CcSwitchClaudeFields.tsx", import.meta.url), "utf8");
  assert.match(claudeFields, /获取模型列表/);
  assert.match(claudeFields, /模型配置/);
  assert.match(flow, /配置文件 ·/);
});

test("Provider create/edit persists a validated top-level context window budget", () => {
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  const roleEditor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  const jobDetail = readFileSync(new URL("./JobDetailPanel.tsx", import.meta.url), "utf8");
  for (const marker of [
    "contextWindowTokens: string",
    "patchContextWindowTokens",
    "settings.context_window_tokens = value",
    "delete settings.context_window_tokens",
    "1_024",
    "10_000_000",
    "不会提升上游模型能力",
  ]) {
    assert.ok(editor.includes(marker), `credential editor should preserve context budget contract: ${marker}`);
  }
  assert.match(flow, /setEditContextWindowTokens\(extractContextWindowTokens\(settings\)\)/);
  assert.match(flow, /contextWindowTokens: createContextWindowTokens/);
  assert.match(flow, /contextWindowTokens: editContextWindowTokens/);
  assert.match(roleEditor, /context_window_tokens: contextWindowTokensFromForm\(form\.context_window_tokens\)/);
  assert.match(roleEditor, /cfg\.context_window_tokens == null \? "" : String\(cfg\.context_window_tokens\)/);
  assert.match(jobDetail, /snapStr\(snapshot, "context_window_tokens"\)/);
  assert.match(jobDetail, /CLI 客户端上下文预算/);
});

test("settings builder patches or removes the top-level context budget for every CLI shape", () => {
  const common = {
    settingsJson: "{}",
    tomlText: "model = \"gpt-5\"",
    authJson: "{}",
    secret: "secret",
    baseUrl: "https://example.test/v1",
    provider: "openai",
  };
  for (const agentCli of ["claude-code", "open-code", "pi", "codex", "dsh"] as const) {
    const added = buildSettingsConfigFromEditor({ ...common, agentCli, contextWindowTokens: "1000000" });
    assert.equal(added.ok, true);
    if (added.ok) assert.equal(added.settings.context_window_tokens, 1_000_000);
    const removed = buildSettingsConfigFromEditor({
      ...common,
      agentCli,
      settingsJson: '{"context_window_tokens":1000000}',
      contextWindowTokens: "",
    });
    assert.equal(removed.ok, true);
    if (removed.ok) assert.equal("context_window_tokens" in removed.settings, false);
  }
  for (const contextWindowTokens of ["1023", "10000001", "1024.5", "not-a-number"]) {
    const invalid = buildSettingsConfigFromEditor({ ...common, agentCli: "claude-code", contextWindowTokens });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.match(invalid.error, /1024.*10000000/);
  }
});

test("DSH provider editor exposes machine configuration without TUI surface", () => {
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /DeepSeek Harness（JSON-RPC）/u);
  assert.match(editor, /DEEPSEEK_API_KEY/);
  assert.match(editor, /deepseek-v4-flash/);
  assert.doesNotMatch(editor, /dsh-cc-tui|dsh-app-tui|dsh-app-web/);
  const settings = buildSettingsConfigFromEditor({
    agentCli: "dsh",
    settingsJson: "",
    tomlText: "",
    authJson: "",
    secret: "secret",
    baseUrl: "https://api.deepseek.com/",
    provider: "openai",
    contextWindowTokens: "128000",
  });
  assert.equal(settings.ok, true);
  if (settings.ok) {
    assert.equal(settings.settings.baseURL, "https://api.deepseek.com");
    assert.equal(settings.settings.apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(settings.settings.context_window_tokens, 128000);
    assert.doesNotMatch(JSON.stringify(settings.settings), /secret/);
  }
});

test("项目角色镜像只能由项目镜像策略管理", () => {
  const editor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(flow, /roleConfig\.project_id \?/);
  assert.match(flow, /由项目镜像策略决定/);
  assert.match(editor, /runtime_image_key: projectId \? null : form\.runtime_image_key\.trim\(\) \|\| null/);
});

test("Provider account flow user-facing copy is Chinese", () => {
  for (const chinese of [
    "接入账号，再完成绑定闭环",
    "测试连接",
    "刷新模型目录",
    "保存配置并添加账号",
    "应用到所选角色配置",
    "仅新 Job",
    "刷新 pending",
  ]) {
    assert.ok(flow.includes(chinese), `flow should show Chinese copy: ${chinese}`);
  }
  // Regression: English marketing copy from the initial #63 surface must not return.
  assert.doesNotMatch(flow, /Connect an account, then close the loop/);
  assert.doesNotMatch(flow, /Encrypt and add account/);
  assert.doesNotMatch(flow, /Test connection/);
  assert.doesNotMatch(flow, /Apply to selected RoleConfigs/);
});

test("credential and login secrets cannot be revealed in the browser", () => {
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  const flow = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");
  const claude = readFileSync(new URL("./CcSwitchClaudeFields.tsx", import.meta.url), "utf8");
  const codex = readFileSync(new URL("./CcSwitchCodexFields.tsx", import.meta.url), "utf8");
  const openCode = readFileSync(new URL("./CcSwitchOpenCodeFields.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("./pages/LoginPage.tsx", import.meta.url), "utf8");
  for (const source of [claude, codex, openCode, login]) {
    assert.doesNotMatch(source, /显示明文|显示 API Token|showKey|setShowKey/iu);
  }
  assert.match(claude, /id="cc-switch-api-key"\s+type="password"/u);
  assert.match(codex, /id="cc-switch-codex-key" type="password"/u);
  assert.match(openCode, /id="cc-switch-opencode-key" type="password"/u);
  assert.match(login, /type="password"/u);
  assert.match(flow, /setEditApiKey\(""\)/u);
  assert.match(editor, /redactSecretValues|restoreRedactedSecrets/u);
  assert.doesNotMatch(editor, /return entries\.length > 0 \? entries : .*anthropic/u);
});

test("provider UI exposes only protocol labels and the two supported OpenCode protocols", () => {
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  const openCode = readFileSync(new URL("./CcSwitchOpenCodeFields.tsx", import.meta.url), "utf8");
  const flow = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");
  assert.match(editor, /providerProtocolLabel/);
  assert.doesNotMatch(editor, /<option key=\{item\.provider\} value=\{item\.provider\}>\{item\.label\}/u);
  assert.match(openCode, /Anthropic Messages/);
  assert.match(openCode, /OpenAI Responses/);
  assert.doesNotMatch(openCode, /OpenAI Compatible|OpenRouter|Google/);
  assert.match(flow, /providerProtocolLabel/);
});

test("CredentialsPanel only hosts ProviderAccountFlow (no duplicate card grid)", () => {
  assert.match(panel, /<ProviderAccountFlow credentials=\{creds\}/);
  assert.doesNotMatch(panel, /登记 Credential/);
  assert.doesNotMatch(panel, />\s*加密登记\s*</);
  assert.doesNotMatch(panel, /const create = async/);
  // Legacy three-column credential cards removed.
  assert.doesNotMatch(panel, /credential-row/);
  assert.doesNotMatch(panel, /credential-toolbar/);
  assert.doesNotMatch(panel, /模型 未限制|个已启用/);
  assert.doesNotMatch(panel, /最近用/);
});
