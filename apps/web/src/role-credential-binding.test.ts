import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(binding, /tab=bindings/);
  assert.match(tabs, /agents: \["roles", "bindings"\]/);
  assert.match(panel, /RoleCredentialBindingPanel/);
  assert.match(panel, /凭据绑定/);
  assert.doesNotMatch(account, /bindCredentialsBatch/);
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
