import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENSANDBOX_EGRESS_IMAGE,
  OPENSANDBOX_EXECD_IMAGE,
  OPENSANDBOX_SDK_VERSION,
  OPENSANDBOX_SERVER_IMAGE,
  assertOpenSandboxImmutableRef,
  assertOpenSandboxSdkVersion,
  readOpenSandboxPin,
} from "./opensandbox-version.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";

test("OpenSandbox upgrades only accept pinned SDK and digest refs", () => {
  assert.equal(assertOpenSandboxSdkVersion(OPENSANDBOX_SDK_VERSION), "0.1.11");
  assert.throws(() => assertOpenSandboxSdkVersion("latest"), /OPENSANDBOX_SDK_UNPINNED/);
  assert.throws(() => assertOpenSandboxImmutableRef("opensandbox:latest", "server"), /OPENSANDBOX_PIN_UNPINNED/);
  assert.equal(
    assertOpenSandboxImmutableRef(
      "example.com/opensandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "server",
    ),
    "example.com/opensandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const pin = readOpenSandboxPin({ sdk: "0.1.11" });
  assert.equal(pin.schema, "deepsonar.opensandbox/v1");
  assert.equal(pin.serverImage, OPENSANDBOX_SERVER_IMAGE);
  assert.equal(pin.execdImage, OPENSANDBOX_EXECD_IMAGE);
  assert.equal(pin.egressImage, OPENSANDBOX_EGRESS_IMAGE);
});

test("OpenSandbox RuntimeHost is CLI-agnostic and includes Pi and DSH", () => {
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.pi.id, "pi");
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.id, "dsh");
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.pi.capabilities.incrementalMessages, true);
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.capabilities.incrementalMessages, true);
  assert.deepEqual(AGENT_CLI_RUNTIME_ADAPTERS.dsh.compatibleImageKeys, [
    "deepsonar-base",
    "deepsonar-audit",
    "deepsonar-kali-minimal",
  ]);
});
