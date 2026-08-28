import assert from "node:assert/strict";
import test from "node:test";
import { assertOpenSandboxSdkPin, installedOpenSandboxSdkVersion } from "./opensandbox-sdk-client.js";
import { OPENSANDBOX_SDK_VERSION } from "./opensandbox-version.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";

test("OpenSandbox SDK pin matches the installed package and rejects drift", () => {
  assert.equal(installedOpenSandboxSdkVersion(), OPENSANDBOX_SDK_VERSION);
  assert.equal(assertOpenSandboxSdkPin(OPENSANDBOX_SDK_VERSION), OPENSANDBOX_SDK_VERSION);
  assert.throws(() => assertOpenSandboxSdkPin("0.0.1"), /OPENSANDBOX_SDK_PIN_MISMATCH/);
  assert.throws(() => assertOpenSandboxSdkPin("latest"), /OPENSANDBOX_SDK_UNPINNED/);
});

test("Pi and DSH stay on the same OpenSandbox RuntimeHost path", () => {
  for (const id of ["pi", "dsh"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.incrementalMessages, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.platformControlApi, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.interactiveTerminal, true);
  }
});
