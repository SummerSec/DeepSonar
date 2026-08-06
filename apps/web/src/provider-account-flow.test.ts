import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  ]) {
    assert.ok(flow.includes(marker), `flow should expose ${marker}`);
  }
  assert.match(flow, /setCreateSecret\(\"\"\)/);
  assert.match(flow, /(?:活跃|运行中)快照保持冻结/);
  assert.match(flow, /disabled=\{!roleConfig\.can_bind\}/);
  assert.match(flow, /项目作用域账号只能在本项目内创建 Provider 账号/);
});

test("Provider account flow user-facing copy is Chinese", () => {
  for (const chinese of [
    "接入账号，再完成绑定闭环",
    "测试连接",
    "刷新模型目录",
    "加密并添加账号",
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

test("CredentialsPanel does not render the legacy duplicate create surface", () => {
  assert.match(panel, /<ProviderAccountFlow credentials=\{creds\}/);
  assert.doesNotMatch(panel, /登记 Credential/);
  assert.doesNotMatch(panel, />\s*加密登记\s*</);
  assert.doesNotMatch(panel, /const create = async/);
});
