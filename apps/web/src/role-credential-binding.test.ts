import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindingGateReason } from "./provider-account-helpers";

const binding = readFileSync(new URL("./RoleCredentialBindingPanel.tsx", import.meta.url), "utf8");
const helpers = readFileSync(new URL("./provider-account-helpers.ts", import.meta.url), "utf8");
const tabs = readFileSync(new URL("./settings-tabs.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const account = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");

test("role credential binding is an independent Agent surface, not an account wizard step", () => {
  for (const marker of [
    "bindCredentialsBatch",
    "bindableRoleConfigs",
    "credentialCompatibility",
    "idempotency_key",
    "new_jobs_only",
    "refresh_pending",
    "refreshed_pending_job_count",
    "runtimeImageSelectOption",
    "can_bind",
    "未选择也可浏览角色",
    "生效策略（绑定域提交）",
    "应用到所选角色配置",
    "仅新 Job",
    "刷新 pending",
    "运行中与终态 Job 快照始终冻结",
  ]) {
    assert.ok(binding.includes(marker), `binding surface should expose ${marker}`);
  }
  assert.doesNotMatch(binding, /FlowStep|goToStep|canEnterRoles|请先选择 Provider 账号，再进入/);
  assert.doesNotMatch(binding, /01 \/ 账号列表|02 \/ 角色配置|03 \/ 生效策略/);
  assert.doesNotMatch(binding, /createCredential|rotateCredential|setCreateSecret/);
  assert.match(binding, /set\("tab", "bindings"\)/);
  assert.match(tabs, /\/agents\?tab=bindings/);
  assert.match(tabs, /agents: \["roles", "bindings"\]/);
  assert.match(panel, /RoleCredentialBindingPanel/);
  assert.match(panel, /凭据绑定/);
  assert.doesNotMatch(account, /bindCredentialsBatch/);
});

test("binding gate is independent of account CRUD and does not require a selected account to browse", () => {
  assert.equal(bindingGateReason(null), "");
  assert.equal(bindingGateReason({
    kind: "llm_provider",
    status: "active",
    provider_valid: false,
    health: { status: "ok", last_tested_at: "2026-01-01T00:00:00.000Z", error_category: null, detail: null, model_catalog: [], model_catalog_fetched_at: null },
  }), "请先修复 Provider 映射，再绑定。");
  assert.equal(bindingGateReason({
    kind: "llm_provider",
    status: "disabled",
    provider_valid: true,
    health: { status: "ok", last_tested_at: "2026-01-01T00:00:00.000Z", error_category: null, detail: null, model_catalog: [], model_catalog_fetched_at: null },
  }), "请先启用该账号，再绑定。");
  assert.equal(bindingGateReason({
    kind: "llm_provider",
    status: "active",
    provider_valid: true,
    health: { status: "error", last_tested_at: "2026-01-01T00:00:00.000Z", error_category: "auth", detail: null, model_catalog: [], model_catalog_fetched_at: null },
  }), "绑定前需最近一次连通性测试成功。请先到账号页测试连接后重试。");
  assert.equal(bindingGateReason({
    kind: "git",
    status: "active",
    provider_valid: true,
    health: { status: "ok", last_tested_at: "2026-01-01T00:00:00.000Z", error_category: null, detail: null, model_catalog: [], model_catalog_fetched_at: null },
  }), "仅 LLM Provider 账号可绑定到角色配置。");
  assert.equal(bindingGateReason({
    kind: "llm_provider",
    status: "active",
    provider_valid: true,
    health: { status: "ok", last_tested_at: "2026-01-01T00:00:00.000Z", error_category: null, detail: null, model_catalog: [], model_catalog_fetched_at: null },
  }), "");
});

test("binding compatibility still fail-closes on CLI / Provider mismatch", () => {
  assert.match(binding, /const canToggle = roleConfig\.can_bind && !incompatible/);
  assert.match(binding, /roleConfig\.role_kind/);
  assert.match(binding, /roleConfig\.role_builtin/);
  assert.doesNotMatch(binding, /resolveBindableRoleKind|isBuiltinBindableRole/);
  assert.doesNotMatch(binding, /selectedCredential\.agent_cli && roleCli !== selectedCredential\.agent_cli/);
  assert.match(binding, /targetCatalog\s*&&\s*!targetCatalog\.compatible_agent_cli\.includes\(roleCli\)/);
  assert.match(helpers, /配置文件 ·/);
});
