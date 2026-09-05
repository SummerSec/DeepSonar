import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSettingsConfigFromEditor,
  extractBaseUrlFromSettingsClient,
  extractModelsFromSettingsClient,
  extractSecretFromSettings,
  parsePiSettingsText,
} from "./CredentialConfigEditor";
import {
  boundCredentialLabel,
  inheritIgnoresLeftoverProjectModel,
  leftoverProjectModelBindNote,
  resolvedUpstreamModel,
  roleModelLabel,
  sameLast4CredentialCount,
} from "./ProviderAccountFlow";
import { claudeMainModelPatch } from "./CcSwitchClaudeFields";

test("bound credential label disambiguates scope, id, and another selected account", () => {
  const role = {
    credential_id: "11111111-2222-4333-8444-555555555555",
    credential_name: "same-name",
    credential_project_id: "99999999-2222-4333-8444-555555555555",
    credential_project_name: "red-team",
  };
  assert.equal(boundCredentialLabel(role, role.credential_id), "same-name · 项目 red-team #11111111");
  assert.match(boundCredentialLabel(role, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), /已绑定另一账号/);
});

test("same-last4 warning catches different credentials in the same provider and CLI", () => {
  const selected = { provider: "anthropic", agent_cli: "claude-code" as const, last4: "abcd" };
  assert.equal(sameLast4CredentialCount(selected, [
    selected,
    { provider: "anthropic", agent_cli: "claude-code", last4: "abcd" },
    { provider: "openai", agent_cli: "codex", last4: "abcd" },
  ]), 2);
});

test("changing Claude main model preserves explicit Fable and subagent mappings", () => {
  assert.deepEqual(
    claudeMainModelPatch({
      ANTHROPIC_DEFAULT_FABLE_MODEL: "custom-fable",
      CLAUDE_CODE_SUBAGENT_MODEL: "custom-subagent",
    }, "old-main", "new-main"),
    { ANTHROPIC_MODEL: "new-main", ANTHROPIC_SMALL_FAST_MODEL: null },
  );
  assert.deepEqual(
    claudeMainModelPatch({
      ANTHROPIC_DEFAULT_FABLE_MODEL: "old-main",
      CLAUDE_CODE_SUBAGENT_MODEL: "old-main",
    }, "old-main", "new-main"),
    {
      ANTHROPIC_MODEL: "new-main",
      ANTHROPIC_SMALL_FAST_MODEL: null,
      ANTHROPIC_DEFAULT_FABLE_MODEL: "new-main",
      CLAUDE_CODE_SUBAGENT_MODEL: "new-main",
    },
  );
});

test("role model display separates the Claude CLI alias from the upstream model", () => {
  const settings = {
    env: {
      ANTHROPIC_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "grok-4.5",
    },
  };
  assert.equal(resolvedUpstreamModel("claude-code", "fable", settings), "grok-4.5");
  assert.match(
    roleModelLabel(
      { agent_cli: "claude-code", model: "fable" },
      { settings_config_json: settings },
    ),
    /fable.*grok-4\.5.*由别名映射决定/,
  );
});

test("inherit_global leftover project model is labeled as stored but ignored", () => {
  const leftover = {
    agent_cli: "claude-code" as const,
    model: "grok-4.5",
    scope: "project" as const,
    project_id: "11111111-1111-4111-8111-111111111111",
    image_strategy: "inherit_global" as const,
  };
  assert.equal(inheritIgnoresLeftoverProjectModel(leftover), true);
  assert.match(
    roleModelLabel(leftover, { settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } } }),
    /行上遗留.*grok-4\.5.*inherit_global 下不生效.*grok-4\.6/,
  );
  assert.equal(inheritIgnoresLeftoverProjectModel({
    ...leftover,
    image_strategy: "project_managed",
  }), false);
  const note = leftoverProjectModelBindNote({
    leftover_project_models_unchanged: true,
    role_configs: [{
      role_config_id: leftover.project_id,
      role_name: "audit",
      scope: "project",
      project_id: leftover.project_id,
      model: "grok-4.5",
      model_changed: false,
      inherit_global_ignores_project_model: true,
    }],
  } as Parameters<typeof leftoverProjectModelBindNote>[0]);
  assert.ok(note);
  assert.match(note, /项目遗留模型未改写.*grok-4\.5.*inherit_global/);
});

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
    "leftoverProjectModelBindNote",
    "inherit_global 下这些行上的 model 不会用于新 Job",
    "modelsFromSettingsConfig",
    "saveEditedConfig",
    "CredentialConfigEditor",
    "openEditCredential",
    "provider-flow-credential-list",
    "runtimeImageSelectOption",
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
  assert.match(flow, /roleConfig\.role_kind/);
  assert.match(flow, /roleConfig\.role_builtin/);
  assert.doesNotMatch(flow, /resolveBindableRoleKind|isBuiltinBindableRole/);
  assert.doesNotMatch(flow, /selectedCredential\.agent_cli && roleCli !== selectedCredential\.agent_cli/);
  assert.match(flow, /targetCatalog\s*&&\s*!targetCatalog\.compatible_agent_cli\.includes\(roleCli\)/);
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
    "patchProviderOverrides",
    "settings.context_window_tokens = contextWindowTokens",
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
    baseUrl: "http://127.0.0.1/v1",
    provider: "openai",
    reasoning: "",
  };
  for (const agentCli of ["claude-code", "pi", "dsh"] as const) {
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

test("Claude Code accepts only official effortLevel values", () => {
  const common = { agentCli: "claude-code" as const, settingsJson: "{}", tomlText: "", authJson: "", secret: "secret", baseUrl: "https://api.anthropic.com", provider: "anthropic", contextWindowTokens: "" };
  const valid = buildSettingsConfigFromEditor({ ...common, reasoning: "xhigh" });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.settings.reasoning, "xhigh");
  const invalid = buildSettingsConfigFromEditor({ ...common, reasoning: "max" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.error, /Claude Code/);
});

test("Pi uses its native reasoning controls", () => {
  const common = { settingsJson: "{}", tomlText: "model = \"gpt-5\"", authJson: "{}", secret: "secret", baseUrl: "http://127.0.0.1/v1", provider: "openai", contextWindowTokens: "" };
  assert.equal(buildSettingsConfigFromEditor({ ...common, agentCli: "pi", reasoning: "max" }).ok, true);
  assert.equal(buildSettingsConfigFromEditor({ ...common, agentCli: "pi", reasoning: "thinking-v2.5" }).ok, false);
});

test("new RoleConfig CLI options exclude leftover CLIs", () => {
  const flow = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");
  assert.match(flow, /value: "claude-code"/);
  assert.match(flow, /value: "pi"/);
  assert.match(flow, /value: "dsh"/);
  assert.doesNotMatch(flow, /AGENT_CLI_OPTIONS[\s\S]*value: "codex"/);
  assert.doesNotMatch(flow, /AGENT_CLI_OPTIONS[\s\S]*value: "open-code"/);
});

const officialLlmPiAiYaml = `llm-pi-ai:
  providers:
    xxxx:
      api: openai-responses
      baseURL: http://127.0.0.1/v1
      apiKey: sk-official-pi
      models:
        - id: gpt-5.6
agent-default-model:
  provider: xxxx
  model: gpt-5.6
`;

const officialLlmPiAiJson = `{
  "llm-pi-ai": {
    "providers": {
      "xxxx": {
        "api": "openai-responses",
        "baseURL": "http://127.0.0.1/v1",
        "apiKey": "sk-official-pi",
        "models": [{ "id": "gpt-5.6" }]
      }
    }
  },
  "agent-default-model": { "provider": "xxxx", "model": "gpt-5.6" }
}`;

test("Pi settings box accepts official llm-pi-ai YAML and JSON and extracts baseURL/model/key", () => {
  const yaml = parsePiSettingsText(officialLlmPiAiYaml);
  assert.equal(yaml.ok, true);
  if (yaml.ok && !yaml.empty) {
    assert.equal(extractBaseUrlFromSettingsClient(yaml.value), "http://127.0.0.1/v1");
    assert.deepEqual(extractModelsFromSettingsClient(yaml.value), ["gpt-5.6"]);
    assert.equal(extractSecretFromSettings(yaml.value), "sk-official-pi");
  }
  const json = parsePiSettingsText(officialLlmPiAiJson);
  assert.equal(json.ok, true);
  if (json.ok && !json.empty) {
    assert.equal(extractBaseUrlFromSettingsClient(json.value), "http://127.0.0.1/v1");
    assert.deepEqual(extractModelsFromSettingsClient(json.value), ["gpt-5.6"]);
    assert.equal(extractSecretFromSettings(json.value), "sk-official-pi");
  }
  const builtYaml = buildSettingsConfigFromEditor({
    agentCli: "pi",
    settingsJson: officialLlmPiAiYaml,
    tomlText: "",
    authJson: "",
    secret: "",
    baseUrl: "",
    provider: "openai",
    contextWindowTokens: "",
    reasoning: "",
  });
  assert.equal(builtYaml.ok, true);
  if (builtYaml.ok) {
    assert.equal(extractBaseUrlFromSettingsClient(builtYaml.settings), "http://127.0.0.1/v1");
    assert.deepEqual(extractModelsFromSettingsClient(builtYaml.settings), ["gpt-5.6"]);
    assert.equal(extractSecretFromSettings(builtYaml.settings), "sk-official-pi");
  }
  const builtJson = buildSettingsConfigFromEditor({
    agentCli: "pi",
    settingsJson: officialLlmPiAiJson,
    tomlText: "",
    authJson: "",
    secret: "",
    baseUrl: "",
    provider: "openai",
    contextWindowTokens: "",
    reasoning: "",
  });
  assert.equal(builtJson.ok, true);
  if (builtJson.ok) {
    assert.equal(extractBaseUrlFromSettingsClient(builtJson.settings), "http://127.0.0.1/v1");
    assert.deepEqual(extractModelsFromSettingsClient(builtJson.settings), ["gpt-5.6"]);
    assert.equal(extractSecretFromSettings(builtJson.settings), "sk-official-pi");
  }
});

test("DSH provider editor exposes machine configuration without TUI surface", () => {
  const editor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /DeepSeek Harness（JSON-RPC）/u);
  assert.match(editor, /Pi \/ llm-pi-ai 配置（YAML 或 JSON）/u);
  assert.match(editor, /providers/);
  assert.match(editor, /openai-responses/);
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
    reasoning: "high",
  });
  assert.equal(settings.ok, true);
  if (settings.ok) {
    assert.equal(typeof settings.settings.config, "string");
    assert.match(String(settings.settings.config), /llm-pi-ai:/);
    assert.match(String(settings.settings.config), /agent-default-model:/);
    assert.match(String(settings.settings.config), /api: openai-responses/);
    assert.ok(String(settings.settings.config).includes("baseURL: https://api.deepseek.com"));
    assert.equal(settings.settings.context_window_tokens, 128000);
    assert.equal(settings.settings.reasoning, "high");
    assert.doesNotMatch(JSON.stringify(settings.settings), /secret/);
  }
  const invalidEffort = buildSettingsConfigFromEditor({
    agentCli: "dsh", settingsJson: String(settings.ok ? settings.settings.config : ""), tomlText: "", authJson: "", secret: "secret",
    baseUrl: "https://api.deepseek.com", provider: "openai", contextWindowTokens: "", reasoning: "thinking-v2.5",
  });
  assert.equal(invalidEffort.ok, false);
  if (!invalidEffort.ok) assert.match(invalidEffort.error, /reasoningEfforts/);
});

test("reasoning is configured on Provider accounts, not RoleConfig", () => {
  const providerEditor = readFileSync(new URL("./CredentialConfigEditor.tsx", import.meta.url), "utf8");
  const roleEditor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(providerEditor, /模型思考强度（Provider 默认）/);
  assert.match(providerEditor, /自定义模型 token/);
  assert.doesNotMatch(roleEditor, /模型思考强度/);
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

test("deleteAccount hard-blocks only pending/active jobs; recoverable is a confirm warning", () => {
  const start = flow.indexOf("const deleteAccount = async");
  const end = flow.indexOf("const testConnection = async", start);
  assert.ok(start >= 0 && end > start);
  const handler = flow.slice(start, end);
  assert.match(handler, /pending > 0 \|\| active > 0/);
  assert.doesNotMatch(handler, /pending > 0 \|\| active > 0 \|\| recoverable > 0/);
  assert.match(handler, /有 \$\{recoverable\} 条可恢复历史，删除后不能再按原快照 resume/);
  assert.doesNotMatch(handler, /请等待结束、取消或完成恢复后再删/);
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
