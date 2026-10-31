import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSandboxLimitsOverrideToPlatform,
  parseSandboxLimitsOverride,
  platformSandboxResourceCeiling,
  resolveEffectiveSandboxLimits,
  SANDBOX_LIMIT_BOUNDS,
  sandboxLimitsExceedPlatform,
} from "./sandbox-limits.js";

test("sandbox resource overrides accept bounded Chrome-sized values for parse only", () => {
  assert.deepEqual(parseSandboxLimitsOverride({ cpu: 8, memoryMiB: 16_384, pidsLimit: 2_048 }), {
    cpu: 8,
    memoryMiB: 16_384,
    pidsLimit: 2_048,
  });
  assert.equal(SANDBOX_LIMIT_BOUNDS.cpu.max >= 8, true);
  assert.equal(SANDBOX_LIMIT_BOUNDS.memoryMiB.max >= 16_384, true);
});

test("sandbox resource overrides reject unsafe, non-finite, and server-owned fields", () => {
  for (const value of [
    { cpu: 0 },
    { cpu: -1 },
    { cpu: Number.POSITIVE_INFINITY },
    { memoryMiB: 0 },
    { memoryMiB: 256.5 },
    { pidsLimit: 0 },
    { pidsLimit: 32_769 },
    { capDropAll: false },
    { noNewPrivileges: false },
  ]) {
    assert.throws(() => parseSandboxLimitsOverride(value));
  }
  assert.throws(() => parseSandboxLimitsOverride([]));
  assert.deepEqual(parseSandboxLimitsOverride({}), {});
});

test("#697 effective limits take per-dimension min with platform defaults (project cannot raise)", () => {
  const platform = {
    cpu: 4,
    memoryMiB: 8_192,
    pidsLimit: 1_024,
    capDropAll: true,
    noNewPrivileges: true,
  };
  // Project raise is clamped back to platform — Chrome higher quotas stay platform env/image floor.
  assert.deepEqual(resolveEffectiveSandboxLimits(
    { cpu: 8, memoryMiB: 16_384 },
    platform,
  ), {
    cpu: 4,
    memoryMiB: 8_192,
    pidsLimit: 1_024,
    capDropAll: true,
    noNewPrivileges: true,
  });
  // Project tighten still applies.
  assert.deepEqual(resolveEffectiveSandboxLimits(
    { cpu: 1, memoryMiB: 1_024, pidsLimit: 256 },
    platform,
  ), {
    cpu: 1,
    memoryMiB: 1_024,
    pidsLimit: 256,
    capDropAll: true,
    noNewPrivileges: true,
  });
  assert.deepEqual(resolveEffectiveSandboxLimits(
    {},
    { cpu: 0, memoryMiB: Number.POSITIVE_INFINITY, pidsLimit: -1, capDropAll: false, noNewPrivileges: false },
  ), {
    cpu: 2,
    memoryMiB: 2_048,
    pidsLimit: 512,
    capDropAll: false,
    noNewPrivileges: false,
  });
});

test("#697 PUT/import reject or clamp overrides above platform ceiling", () => {
  const platform = { cpu: 2, memoryMiB: 2_048, pidsLimit: 512, capDropAll: true, noNewPrivileges: true };
  assert.equal(sandboxLimitsExceedPlatform({ cpu: 8 }, platform), true);
  assert.equal(sandboxLimitsExceedPlatform({ cpu: 1, memoryMiB: 1_024 }, platform), false);
  assert.deepEqual(platformSandboxResourceCeiling(platform), { cpu: 2, memoryMiB: 2_048, pidsLimit: 512 });
  const raised = clampSandboxLimitsOverrideToPlatform({ cpu: 8, memoryMiB: 16_384, pidsLimit: 64 }, platform);
  assert.equal(raised.changed, true);
  assert.deepEqual(raised.clamped, { cpu: 2, memoryMiB: 2_048, pidsLimit: 64 });
  const alreadyTight = clampSandboxLimitsOverrideToPlatform({ cpu: 1 }, platform);
  assert.equal(alreadyTight.changed, false);
});
