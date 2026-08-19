import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_DEFAULT_AGENT_CLI,
  parseProjectImagePolicy,
  roleIdentityForProjectPolicy,
  roleNameForJobType,
  runtimeImageKeyForProjectPolicy,
  withRuntimeTestToolchainPolicy,
} from "./application.js";

test("role/runtime snapshot keeps scheduler-owned role aliases and toolchain policy", () => {
  assert.equal(roleNameForJobType("audit_module"), "audit");
  assert.equal(roleNameForJobType("verify_finding"), "verify");
  assert.equal(roleNameForJobType("report"), "report");
  assert.equal(PLATFORM_DEFAULT_AGENT_CLI, "claude-code");
  assert.match(withRuntimeTestToolchainPolicy("test", null, "deepsonar-base") ?? "", /Runtime test toolchain/);
  assert.equal(withRuntimeTestToolchainPolicy("audit", "custom", "deepsonar-audit"), "custom");
});

test("项目镜像策略按全局继承与项目托管分别选择镜像", () => {
  assert.deepEqual(parseProjectImagePolicy(undefined), {
    image_strategy: "inherit_global",
    role_runtime_images: {},
  });
  const inherited = parseProjectImagePolicy({
    image_strategy: "inherit_global",
    // 项目 RoleConfig 的遗留 runtime_image_key 也不能成为策略输入。
    runtime_image_key: "deepsonar-chrome-audit",
    // 遗留项目 RoleConfig 镜像值不在策略输入中，必须继承全局 RoleConfig。
    role_runtime_images: { audit: "deepsonar-chrome-audit" },
  });
  assert.equal(runtimeImageKeyForProjectPolicy(inherited, "audit", "openharmony"), "openharmony");

  const managed = parseProjectImagePolicy({
    image_strategy: "project_managed",
    role_runtime_images: { audit: "deepsonar-audit", review: null },
  });
  assert.equal(runtimeImageKeyForProjectPolicy(managed, "audit", "custom-audit"), "deepsonar-audit");
  assert.equal(runtimeImageKeyForProjectPolicy(managed, "review", "custom-review"), "deepsonar-base");
  assert.equal(runtimeImageKeyForProjectPolicy(managed, "test", "custom-test"), "deepsonar-base");
});

test("inherit_global 忽略遗留项目 RoleConfig 的 model 与默认 CLI", () => {
  const leftover = { model: "grok-4.5", agent_cli: "codex" };
  const global = { model: "grok-4.6", agent_cli: "claude-code" };
  const inherited = roleIdentityForProjectPolicy(parseProjectImagePolicy(undefined), leftover, global);
  assert.deepEqual(inherited, { model: "grok-4.6", agent_cli: "claude-code" });
  assert.deepEqual(
    roleIdentityForProjectPolicy(parseProjectImagePolicy({ image_strategy: "dirty" }), leftover, global),
    inherited,
  );
  const managed = roleIdentityForProjectPolicy(
    parseProjectImagePolicy({ image_strategy: "project_managed" }),
    leftover,
    global,
  );
  assert.deepEqual(managed, { model: "grok-4.5", agent_cli: "codex" });
});
