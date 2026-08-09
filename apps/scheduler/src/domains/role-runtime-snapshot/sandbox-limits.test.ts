import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSandboxLimitsOverride,
  resolveEffectiveSandboxLimits,
  SANDBOX_LIMIT_BOUNDS,
} from "./sandbox-limits.js";

test("sandbox resource overrides accept bounded Chrome-sized project values", () => {
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

test("effective limits merge project overrides over bounded server defaults", () => {
  assert.deepEqual(resolveEffectiveSandboxLimits(
    { cpu: 8, memoryMiB: 16_384 },
    { cpu: 4, memoryMiB: 8_192, pidsLimit: 1_024, capDropAll: true, noNewPrivileges: true },
  ), {
    cpu: 8,
    memoryMiB: 16_384,
    pidsLimit: 1_024,
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
