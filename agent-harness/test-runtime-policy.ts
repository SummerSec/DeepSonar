import assert from "node:assert/strict";
import {
  RUNTIME_TEST_TOOLCHAIN_POLICY,
  withRuntimeTestToolchainPolicy,
} from "../apps/scheduler/src/core.ts";

const custom = "operator-authored test instructions";

assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Java uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Python uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Go uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Rust uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Do \*\*not\*\* install or download JDK, Maven/);

assert.equal(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal"),
  RUNTIME_TEST_TOOLCHAIN_POLICY,
);
assert.equal(
  withRuntimeTestToolchainPolicy("test", RUNTIME_TEST_TOOLCHAIN_POLICY, "deepsonar-base"),
  RUNTIME_TEST_TOOLCHAIN_POLICY,
);
assert.equal(
  withRuntimeTestToolchainPolicy("verify", custom, "deepsonar-base"),
  custom,
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
  null,
);
assert.match(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-openharmony-test") ?? "",
  /OpenHarmony hdc device protocol/,
);
assert.doesNotMatch(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal") ?? "",
  /OpenHarmony hdc device protocol/,
);

console.log("OK: runtime test policy selection and idempotence");
