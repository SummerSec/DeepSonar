import assert from "node:assert/strict";
import {
  RUNTIME_TEST_TOOLCHAIN_POLICY,
  RUNTIME_TOOL_MANUALS_POLICY,
  SPECIALTY_RUNTIME_IMAGE_POLICIES,
  withRuntimeTestToolchainPolicy,
} from "../apps/scheduler/src/domains/role-runtime-snapshot/index.ts";

const custom = "operator-authored test instructions";
const manualsThenToolchain = `${RUNTIME_TOOL_MANUALS_POLICY}\n\n${RUNTIME_TEST_TOOLCHAIN_POLICY}`;
const evidenceHeading = "### Runtime evidence submission (Scheduler policy)";

// Preserve exact ordering of existing blocks and require the role-scoped evidence block.
function assertPolicyPrefix(policy: string | null, expectedPrefix: string): void {
  assert.ok(policy);
  const blocks = policy.split(`\n\n${evidenceHeading}`);
  assert.equal(blocks.length, 2, "exactly one role-scoped evidence block is required");
  assert.equal(blocks[0], expectedPrefix);
  assert.ok(blocks[1].trim(), "the evidence block must not be empty");
}

assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Java uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Python uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Go uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Rust uses/);
assert.match(RUNTIME_TEST_TOOLCHAIN_POLICY, /Do \*\*not\*\* install or download JDK, Maven/);
assert.match(RUNTIME_TOOL_MANUALS_POLICY, /\/opt\/deepsonar\/manuals/);
assert.match(RUNTIME_TOOL_MANUALS_POLICY, /INDEX\.md/);

assertPolicyPrefix(
  withRuntimeTestToolchainPolicy("test", null, "deepsonar-kali-minimal"),
  manualsThenToolchain,
);
assertPolicyPrefix(
  withRuntimeTestToolchainPolicy("test", RUNTIME_TEST_TOOLCHAIN_POLICY, "deepsonar-base"),
  manualsThenToolchain,
);
assertPolicyPrefix(
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
assertPolicyPrefix(
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
  /rust_ASC/,
  /droidasc-python/,
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

// Check whole injected prompts so specialty blocks cannot reintroduce maker
// operations into Verify or omit ordinary-worker evidence safeguards.
for (const imageKey of [
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  ...SPECIALTY_RUNTIME_IMAGE_POLICIES.map((policy) => policy.image_key),
]) {
  for (const role of ["test", "review", "audit", "verify", "report", "hub_reason"]) {
    const policy = withRuntimeTestToolchainPolicy(role, custom, imageKey);
    assert.ok(policy);
    assert.ok(policy.startsWith(`${RUNTIME_TOOL_MANUALS_POLICY}\n\n${custom}`));
    assert.equal(policy.split(evidenceHeading).length, 2);
    assert.equal(withRuntimeTestToolchainPolicy(role, policy, imageKey), policy);

    if (role === "verify") {
      assert.doesNotMatch(policy, /\b(?:emit_fact|emit_finding|request_human)\b/);
      assert.match(policy, /mark_job_done with verdict=rework and a nonempty missing_evidence array/);
      assert.match(policy, /mark_job_done with verdict=needs_human/);
      assert.match(policy, /Never invent a Finding ID or confirm from static narration alone/);
    } else if (role === "report") {
      assert.match(policy, /Report only projects the frozen input/);
      assert.match(policy, /mark_job_done\.summary; do not execute new tests or change Finding states/);
      assert.doesNotMatch(policy, /\b(?:emit_fact|emit_finding|request_human)\b/);
    } else if (role === "hub_reason") {
      assert.match(policy, /runtime manuals do not grant evidence-writing operations/);
      assert.doesNotMatch(policy, /\b(?:emit_fact|emit_finding|request_human)\b/);
    } else {
      assert.match(policy, /Only a Job bound to a supplied target Finding may submit emit_fact\.verification, using that exact finding_id and subject_revision/);
      assert.match(policy, /Without a target Finding, submit an ordinary emit_fact with title and description/);
      assert.match(policy, /omit verification and never invent a finding_id/);
      assert.match(policy, /record attempted negative controls or refutations explicitly in attempted_refutation/);
      assert.match(policy, /otherwise use a platform_blocker subject/);
      assert.match(policy, /needs_human is mark_job_done\.verdict only for Verify, not emit_fact\.verification\.outcome/);
      assert.match(policy, /Ordinary workers finish with summary and no verdict/);
    }
  }
}

console.log("OK: runtime policy selection, role-scoped evidence, manuals injection, and idempotence");

const reversePolicy = withRuntimeTestToolchainPolicy("audit", null, "deepsonar-reverse") ?? "";
if (!reversePolicy.includes("Reverse / REA+Ghidra runtime")) {
  throw new Error("reverse specialty policy missing");
}
if (!reversePolicy.includes("binary.rea.cli") && !reversePolicy.includes("rea-agents@6.4.0")) {
  throw new Error("reverse policy missing REA pin guidance");
}
