import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { credentialSelectionPatch, defaultCredentialUnavailable } from "./project-provider-selection";

const panel = readFileSync(new URL("./components/ProjectCliProviderAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("项目设置挂载 CLI/Provider 启用面板，不再暴露软缺省控件", () => {
  assert.match(settings, /ProjectCliProviderAllowlistPanel/);
  assert.match(panel, /CLI \/ Provider 启用/);
  assert.match(panel, /启用 Agent 类型/);
  assert.match(panel, /启用 Provider 账号/);
  assert.match(panel, /enabled_agent_clis/);
  assert.match(panel, /credentialSelectionPatch/);
  assert.doesNotMatch(panel, /缺省 CLI/);
  assert.doesNotMatch(panel, /缺省 Provider/);
  assert.doesNotMatch(panel, /缺省模型/);
  assert.doesNotMatch(panel, /Fallback 模型顺序/);
  assert.doesNotMatch(panel, /允许目录直通/);
  assert.doesNotMatch(panel, /不设（回退角色）/);
  assert.doesNotMatch(panel, /不设（Hub \/ 角色选择）/);
  assert.doesNotMatch(panel, /defaultAgentCli/);
  assert.doesNotMatch(panel, /allowModelCatalogPassthrough/);
  assert.doesNotMatch(settings, /defaultAgentCli=/);
  assert.doesNotMatch(settings, /allowModelCatalogPassthrough=/);
});

test("Provider 选项按已启用 CLI 过滤，并展示并发摘要", () => {
  assert.match(panel, /filteredByCli/);
  assert.match(panel, /concurrencySummary/);
  assert.match(panel, /账号并发/);
  assert.match(panel, /暂无兼容的 LLM Provider/);
});

test("Provider 白名单面板不展示上游模型目录诊断", () => {
  assert.match(panel, /api\.testCredential/);
  assert.match(panel, /连接失败/);
  assert.doesNotMatch(panel, /model-catalog-health|modelHealthLabel|modelDescriptorsForCredential/);
  assert.doesNotMatch(panel, /modelSummary|credentialCatalogState|credentialModels/);
  assert.doesNotMatch(panel, /模型目录未探测|上游模型目录|上游探测到|连接 \/ 目录失败|刷新中|目录/);
});


test("compatibleAgentClisForCredential 以 credential.agent_cli 独占，不按 Provider 扩", () => {
  assert.match(panel, /isCurrentAgentCli\(credential\.agent_cli\) \? \[credential\.agent_cli\] : \[\]/);
  assert.doesNotMatch(panel, /ADAPTER_CLIS\[credential\.provider\]/);
  assert.doesNotMatch(panel, /only a profile hint/);
  assert.match(panel, /exclusive|独占|唯一来源/);
});


test("ordinary save does not pin dynamic credential scope or erase preferences", () => {
  assert.match(settings, /credentialIdsConfigured=\{settings\?\.credential_ids_configured/);
  assert.match(panel, /credentialSelectionPatch\(\{ credentialSelectionChanged, credIds, defaultCredentialId, clearDefaultCredential \}\)/);
  assert.doesNotMatch(panel, /default_agent_cli: null|default_model_ref: null/);
  assert.deepEqual(credentialSelectionPatch({ credentialSelectionChanged: false, credIds: [], defaultCredentialId: "default", clearDefaultCredential: false }), {});
  assert.match(panel, /未收紧凭据范围/);
});

test("project RoleConfig editor omits identity while global preference supports automatic selection", () => {
  const editor = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
  assert.match(editor, /!projectId \? \{\s+agent_cli:/);
  assert.match(editor, /form\.agent_cli \|\| null/);
  assert.match(editor, /未指定（由可用凭据决定）/);
  assert.match(editor, /ariaLabel="全局 CLI 偏好" clearable/);
});


test("unavailable explicit credential references can only be removed by an explicit edit", () => {
  assert.match(panel, /unavailableIds = credIds\.filter/);
  assert.match(panel, /current\.filter\(\(id\) => !unavailableIds\.includes\(id\)\)/);
  assert.match(panel, /移除失效引用/);
  assert.match(panel, /账号已删除、停用或不再可访问/);
});


test("clearing an unavailable default alone keeps dynamic credential scope unconfigured", () => {
  const draft = { credentialSelectionChanged: false, credIds: [], defaultCredentialId: "missing", clearDefaultCredential: false };
  assert.equal(defaultCredentialUnavailable("missing", []), true);
  assert.equal(defaultCredentialUnavailable("missing", [{ id: "missing", status: "disabled" }]), true);
  assert.equal(defaultCredentialUnavailable("missing", [{ id: "missing", status: "active" }]), false);
  assert.equal(defaultCredentialUnavailable(null, []), false);
  assert.deepEqual(credentialSelectionPatch(draft), {}, "ordinary save preserves existing configuration");
  const patch = credentialSelectionPatch({ ...draft, clearDefaultCredential: true });
  assert.deepEqual(patch, { default_credential_id: null });
  assert.equal(Object.hasOwn(patch, "enabled_credential_ids"), false);
  assert.match(panel, /清除失效默认引用/);
  assert.match(panel, /onClick=\{\(\) => setClearDefaultCredential\(true\)\}/);
});

test("editing an explicit allowlist can remove its default without adding credentials", () => {
  assert.deepEqual(credentialSelectionPatch({ credentialSelectionChanged: true, credIds: [], defaultCredentialId: "removed", clearDefaultCredential: false }), {
    enabled_credential_ids: [], default_credential_id: null,
  });
});
