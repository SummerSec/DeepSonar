import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  openSandboxAllowsDispatch,
  refreshOpenSandboxServerStatus,
  resetOpenSandboxServerStatusForTests,
  sanitizeOpenSandboxHealthError,
} from "./opensandbox-health.js";

const opensandboxRuntime = {
  agentMode: "real",
  provider: "opensandbox",
  domain: "127.0.0.1:8080",
  apiKey: "super-secret-opensandbox-key",
};

test("OpenSandbox health skips non-opensandbox runtimes", async () => {
  resetOpenSandboxServerStatusForTests();
  const status = await refreshOpenSandboxServerStatus(async () => {
    throw new Error("probe must not run");
  }, { ...opensandboxRuntime, provider: "local-docker" });
  assert.equal(status.level, "skipped");
  assert.equal(openSandboxAllowsDispatch(status), true);
});

test("OpenSandbox health fails closed without API key", async () => {
  resetOpenSandboxServerStatusForTests();
  const status = await refreshOpenSandboxServerStatus(async () => {
    throw new Error("probe must not run");
  }, { ...opensandboxRuntime, apiKey: "  " });
  assert.equal(status.level, "unconfigured");
  assert.equal(openSandboxAllowsDispatch(status), false);
});

test("OpenSandbox health probe success and timeout", async () => {
  resetOpenSandboxServerStatusForTests();
  const ok = await refreshOpenSandboxServerStatus(async () => {}, opensandboxRuntime);
  assert.equal(ok.level, "ok");
  assert.equal(openSandboxAllowsDispatch(ok), true);

  resetOpenSandboxServerStatusForTests();
  const failed = await refreshOpenSandboxServerStatus(async () => {
    throw new Error(`unauthorized super-secret-opensandbox-key`);
  }, opensandboxRuntime, { retryDelaysMs: [] });
  assert.equal(failed.level, "error");
  assert.equal(failed.error?.includes("super-secret-opensandbox-key"), false);
  assert.match(failed.error ?? "", /unauthorized/);
  assert.equal(openSandboxAllowsDispatch(failed), false);
});

test("OpenSandbox health retries transient probe failures before error", async () => {
  resetOpenSandboxServerStatusForTests();
  let attempts = 0;
  const sleeps: number[] = [];
  const status = await refreshOpenSandboxServerStatus(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("getaddrinfo ENOTFOUND opensandbox");
  }, opensandboxRuntime, {
    retryDelaysMs: [5, 5],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(status.level, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(openSandboxAllowsDispatch(status), true);

  resetOpenSandboxServerStatusForTests();
  attempts = 0;
  const exhausted = await refreshOpenSandboxServerStatus(async () => {
    attempts += 1;
    throw new Error("getaddrinfo ENOTFOUND opensandbox");
  }, opensandboxRuntime, {
    retryDelaysMs: [1, 1],
    sleep: async () => {},
  });
  assert.equal(exhausted.level, "error");
  assert.equal(attempts, 3);
  assert.match(exhausted.error ?? "", /ENOTFOUND/);
  assert.equal(openSandboxAllowsDispatch(exhausted), false);
});

test("OpenSandbox health errors never echo the API key", () => {
  const message = sanitizeOpenSandboxHealthError(
    new Error("GET http://127.0.0.1:8080 failed key=super-secret-opensandbox-key"),
    "super-secret-opensandbox-key",
  );
  assert.equal(message.includes("super-secret-opensandbox-key"), false);
  assert.match(message, /<redacted>/);
});

test("dispatcher pauses OpenSandbox claims when the server probe fails", () => {
  const dispatcher = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const readiness = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");
  assert.match(dispatcher, /refreshOpenSandboxServerStatus\(\)/);
  assert.match(dispatcher, /openSandboxAllowsDispatch\(server\)/);
  assert.match(readiness, /refreshOpenSandboxServerStatus\(\)/);
  assert.match(readiness, /OPENSANDBOX_SERVER_UNAVAILABLE/);
});
