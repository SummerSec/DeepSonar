import assert from "node:assert/strict";
import test from "node:test";
import { config, managesHostDockerRuntime } from "./config.js";
import {
  hostDiskAllowsDispatch,
  refreshHostDiskPressure,
  shouldNotifyDiskRecovery,
} from "./host-disk.js";

function statfsAt(usedPercent: number) {
  const blocks = 10_000n;
  const used = BigInt(Math.floor(usedPercent * 100));
  return async () => ({ blocks, bavail: blocks - used });
}

test("host Docker lifecycle follows OpenSandbox Docker, not Kata or deleted providers", () => {
  assert.equal(managesHostDockerRuntime({ agentMode: "real", provider: "opensandbox" }), true);
  assert.equal(managesHostDockerRuntime({
    agentMode: "real",
    provider: "opensandbox",
    openSandbox: { kubernetes: true },
  }), false);
  assert.equal(managesHostDockerRuntime({ agentMode: "fake", provider: "opensandbox" }), false);
  assert.equal(managesHostDockerRuntime({ agentMode: "real", provider: "local-docker" }), false);
});

test("host disk pressure distinguishes ok, warning and dispatch-blocking error", async () => {
  const ok = await refreshHostDiskPressure(statfsAt(config.hostDisk.warningPercent - 1));
  assert.equal(ok.level, "ok");
  assert.equal(hostDiskAllowsDispatch(ok), true);

  const warning = await refreshHostDiskPressure(statfsAt(config.hostDisk.warningPercent));
  assert.equal(warning.level, "warning");
  assert.equal(hostDiskAllowsDispatch(warning), true);

  const error = await refreshHostDiskPressure(statfsAt(config.hostDisk.errorPercent));
  assert.equal(error.level, "error");
  assert.equal(hostDiskAllowsDispatch(error), false);
});

test("host disk statfs failure fails closed", async () => {
  const status = await refreshHostDiskPressure(async () => {
    throw new Error("mount unavailable");
  });
  assert.equal(status.level, "unknown");
  assert.equal(status.error, "mount unavailable");
  assert.equal(hostDiskAllowsDispatch(status), false);
});

test("disk recovery transition wakes dispatch only after a blocked state", () => {
  const base = {
    path: "/host-disk",
    warningPercent: 85,
    errorPercent: 90,
    checkedAt: "2026-08-18T00:00:00.000Z",
    error: null,
  };
  assert.equal(shouldNotifyDiskRecovery(
    { ...base, level: "error", usedPercent: 95 },
    { ...base, level: "warning", usedPercent: 86 },
  ), true);
  assert.equal(shouldNotifyDiskRecovery(
    { ...base, level: "warning", usedPercent: 86 },
    { ...base, level: "ok", usedPercent: 70 },
  ), false);
});
