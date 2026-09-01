import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertOpenSandboxSdkPin, commandWithEnv, installedOpenSandboxSdkVersion, isOpenSandboxGoneError, joinCommandLogText } from "./opensandbox-sdk-client.js";
import { OPENSANDBOX_SDK_VERSION } from "./opensandbox-version.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";

test("OpenSandbox SDK pin matches the installed package and rejects drift", () => {
  assert.equal(installedOpenSandboxSdkVersion(), OPENSANDBOX_SDK_VERSION);
  assert.equal(assertOpenSandboxSdkPin(OPENSANDBOX_SDK_VERSION), OPENSANDBOX_SDK_VERSION);
  assert.throws(() => assertOpenSandboxSdkPin("0.0.1"), /OPENSANDBOX_SDK_PIN_MISMATCH/);
  assert.throws(() => assertOpenSandboxSdkPin("latest"), /OPENSANDBOX_SDK_UNPINNED/);
});

test("OpenSandbox destroy treats already-gone sandboxes as success", () => {
  assert.equal(isOpenSandboxGoneError({ statusCode: 404, message: "gone" }), true);
  assert.equal(isOpenSandboxGoneError({ error: { code: "DOCKER::SANDBOX_NOT_FOUND" } }), true);
  assert.equal(isOpenSandboxGoneError({
    statusCode: 500,
    message: 'Conflict ("removal of container abc is already in progress")',
  }), true);
  assert.equal(isOpenSandboxGoneError(new Error("ready timeout")), false);
});

test("OpenSandbox command logs join line items with newlines", () => {
  assert.equal(joinCommandLogText([{ text: "/tmp/a.jsonl" }, { text: "/tmp/b.jsonl" }]), "/tmp/a.jsonl\n/tmp/b.jsonl");
  assert.equal(joinCommandLogText([{ text: "chunk-one\nchunk-two\n" }]), "chunk-one\nchunk-two\n");
});

test("OpenSandbox runAsync env wrapping always uses a shell so compound commands stay intact", () => {
  assert.equal(commandWithEnv("true"), "true");
  assert.match(commandWithEnv("if true; then exec bash -il; fi", { TERM: "xterm" }), /env TERM='xterm' sh -c /);
});

test("OpenSandbox SDK create forwards an explicit linux/arm64 platform", () => {
  const source = readFileSync(new URL("./opensandbox-sdk-client.ts", import.meta.url), "utf8");
  assert.match(source, /input\.platform \? \{ platform: input\.platform \}/);
});

test("Pi and DSH stay on the same OpenSandbox RuntimeHost path", () => {
  for (const id of ["pi", "dsh"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.incrementalMessages, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.platformControlApi, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.interactiveTerminal, true);
  }
});
