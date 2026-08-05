import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_DEFAULT_AGENT_CLI,
  roleNameForJobType,
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
