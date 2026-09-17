import assert from "node:assert/strict";
import {
  RUNTIME_TEST_TOOLCHAIN_POLICY,
  RUNTIME_TOOL_MANUALS_POLICY,
  withRuntimeTestToolchainPolicy,
} from "../apps/scheduler/src/domains/role-runtime-snapshot/index.ts";

const custom = "operator-authored test instructions";
const manualsThenToolchain = `${RUNTIME_TOOL_MANUALS_POLICY}\n\n${RUNTIME_TEST_TOOLCHAIN_POLICY}`;

assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Java uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Python uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Go uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Rust uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Do \*\*not\*\* install or download JDK, Maven/);
assert.match(RUNTIME_TOOL_MANUALS_POLICY, /\/opt\/deepsonar\/manuals/);
assert.match(RUNTIME_TOOL_MANUALS_POLICY, /INDEX\.md/);

assert.equal(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal"),
  manualsThenToolchain,
);
assert.equal(
  withRuntimeTestToolchainPolicy("test", RUNTIME_TEST_TOOLCHAIN_POLICY, "deepsonar-base"),
  manualsThenToolchain,
);
assert.equal(
  withRuntimeTestToolchainPolicy("verify", custom, "deepsonar-base"),
  `${RUNTIME_TOOL_MANUALS_POLICY}\n\n${custom}`,
);
assert.match(
  withRuntimeTestToolchainPolicy("verify", custom, "deepsonar-kali-minimal") ?? "",
  /Runtime tool manuals \(Scheduler policy\)/,
);
assert.match(
  withRuntimeTestToolchainPolicy("verify", custom, "deepsonar-kali-minimal") ?? "",
  /Runtime test toolchain \(Scheduler policy\)/,
);
assert.equal(
  withRuntimeTestToolchainPolicy("verify", custom, null),
  custom,
);
assert.equal(
  withRuntimeTestToolchainPolicy("audit", null, "deepsonar-audit"),
  RUNTIME_TOOL_MANUALS_POLICY,
);
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
assert.match(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-mobile") ?? "",
  /apkcheckpack/,
);
assert.match(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-mobile") ?? "",
  /droidasc/,
);
assert.match(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-mobile") ?? "",
  /Never invent device, traffic, or native\/OLLVM results from JADX, droidasc, or apkcheckpack/,
);
assert.doesNotMatch(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal") ?? "",
  /Mobile device protocols/,
);
assert.match(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal") ?? "",
  /Runtime tool manuals \(Scheduler policy\)/,
);

console.log("OK: runtime test policy selection, manuals injection, and idempotence");
