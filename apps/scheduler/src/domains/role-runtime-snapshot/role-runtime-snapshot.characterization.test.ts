import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PLATFORM_DEFAULT_AGENT_CLI,
  parseProjectImagePolicy,
  persistableProjectRoleConfigModel,
  roleIdentityForProjectPolicy,
  roleNameForJobType,
  runtimeImageKeyForProjectPolicy,
  withRuntimeTestToolchainPolicy,
  SPECIALTY_RUNTIME_IMAGE_POLICIES,
  specialtyPolicyForImageKey,
} from "./application.js";

test("role/runtime snapshot keeps scheduler-owned role aliases and toolchain policy", () => {
  assert.equal(roleNameForJobType("audit_module"), "audit_module");
  assert.equal(roleNameForJobType("hub"), "hub");
  assert.equal(roleNameForJobType("hub_reason"), "hub_reason");
  assert.equal(roleNameForJobType("verify_finding"), "verify");
  assert.equal(roleNameForJobType("report"), "report");
  assert.equal(PLATFORM_DEFAULT_AGENT_CLI, "claude-code");
  assert.match(withRuntimeTestToolchainPolicy("test", null, "deepsonar-base") ?? "", /Runtime test toolchain/);
  assert.match(
    withRuntimeTestToolchainPolicy("test", null, "deepsonar-openharmony-test") ?? "",
    /OpenHarmony hdc device protocol/,
  );
  assert.doesNotMatch(
    withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal") ?? "",
    /OpenHarmony hdc device protocol/,
  );
  assert.match(
    withRuntimeTestToolchainPolicy("test", null, "deepsonar-mobile") ?? "",
    /Mobile device protocols/,
  );
  assert.doesNotMatch(
    withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal") ?? "",
    /Mobile device protocols/,
  );
  assert.equal(withRuntimeTestToolchainPolicy("audit", "custom", "deepsonar-audit"), "custom");
  const source = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /warnIgnoredLegacyAgentDefaults|legacy AGENT_PROVIDER/);
  assert.doesNotMatch(source, /jobType === "audit_module"\) return "audit"/);
});

test("specialty image boundary injects for any role; chrome/clickhouse peer mobile/OH", () => {
  assert.match(
    withRuntimeTestToolchainPolicy("audit", "custom", "deepsonar-chrome-test") ?? "",
    /Chrome CDP runtime/,
  );
  assert.match(
    withRuntimeTestToolchainPolicy("explore", null, "deepsonar-clickhouse-test") ?? "",
    /ClickHouse official runtime/,
  );
  assert.match(
    withRuntimeTestToolchainPolicy("hub_reason", "hub", "deepsonar-chrome-audit") ?? "",
    /Chrome\/C\+\+ audit toolchain/,
  );
  assert.match(
    withRuntimeTestToolchainPolicy("verify", null, "deepsonar-clickhouse-fuzz") ?? "",
    /ClickHouse fuzz runtime/,
  );
  assert.match(
    withRuntimeTestToolchainPolicy("verify", null, "deepsonar-clickhouse-fuzz") ?? "",
    /Runtime test toolchain/,
  );
  assert.doesNotMatch(
    withRuntimeTestToolchainPolicy("audit", "custom", "deepsonar-chrome-test") ?? "",
    /Runtime test toolchain/,
  );
  assert.equal(withRuntimeTestToolchainPolicy("code", null, "deepsonar-base"), null);
  assert.equal(withRuntimeTestToolchainPolicy("review", "keep", "deepsonar-kali-minimal"), "keep");

  const keys = SPECIALTY_RUNTIME_IMAGE_POLICIES.map((item) => item.image_key);
  for (const key of [
    "deepsonar-chrome-test",
    "deepsonar-chrome-audit",
    "deepsonar-chrome-fuzz",
    "deepsonar-clickhouse-test",
    "deepsonar-clickhouse-audit",
    "deepsonar-clickhouse-fuzz",
    "deepsonar-openharmony-test",
    "deepsonar-mobile",
  ]) {
    assert.ok(keys.includes(key), `missing specialty policy for ${key}`);
    assert.ok(specialtyPolicyForImageKey(key)?.body.includes("needs_human") || specialtyPolicyForImageKey(key)?.body.includes("inconclusive"));
  }
});

test("角色×镜像矩阵文档与默认 Role 镜像、专项 policy 对齐", () => {
  const matrix = readFileSync(new URL("../../../../../docs/RUNTIME_ROLE_IMAGE_MATRIX.md", import.meta.url), "utf8");
  assert.match(matrix, /角色 × 官方镜像能力矩阵/);
  assert.match(matrix, /deepsonar-kali-minimal/);
  assert.match(matrix, /deepsonar-audit/);
  assert.match(matrix, /deepsonar-base/);
  assert.match(matrix, /deepsonar-chrome-test/);
  assert.match(matrix, /deepsonar-clickhouse-test/);
  assert.match(matrix, /deepsonar-mobile/);
  assert.match(matrix, /needs_human/);
  assert.match(matrix, /withRuntimeTestToolchainPolicy/);
  assert.match(matrix, /DEFAULT_RUNTIME_IMAGE_BY_ROLE/);
  assert.match(matrix, /list_available_runtime_images/);
  assert.match(matrix, /selection_hints|purpose/);
  for (const item of SPECIALTY_RUNTIME_IMAGE_POLICIES) {
    assert.match(matrix, new RegExp(item.image_key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const toolchains = readFileSync(new URL("../../../../../docs/RUNTIME_TEST_TOOLCHAINS.md", import.meta.url), "utf8");
  assert.match(toolchains, /RUNTIME_ROLE_IMAGE_MATRIX/);
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
  const leftover = { model: "grok-4.5", agent_cli: "pi" };
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
  assert.deepEqual(managed, { model: "grok-4.5", agent_cli: "pi" });
});

test("inherit_global 项目 RoleConfig 不落库 model，project_managed 才持久化", () => {
  assert.equal(
    persistableProjectRoleConfigModel(parseProjectImagePolicy(undefined), "grok-4.5"),
    null,
  );
  assert.equal(
    persistableProjectRoleConfigModel(parseProjectImagePolicy({ image_strategy: "dirty" }), "grok-4.5"),
    null,
  );
  assert.equal(
    persistableProjectRoleConfigModel(parseProjectImagePolicy({ image_strategy: "inherit_global" }), "grok-4.5"),
    null,
  );
  assert.equal(
    persistableProjectRoleConfigModel(parseProjectImagePolicy({ image_strategy: "project_managed" }), "grok-4.5"),
    "grok-4.5",
  );
  assert.equal(
    persistableProjectRoleConfigModel(parseProjectImagePolicy({ image_strategy: "project_managed" }), "  "),
    null,
  );
});
