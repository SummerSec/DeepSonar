import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertOpenSandboxSdkPin, commandWithEnv, installedOpenSandboxSdkVersion, isOpenSandboxGoneError, classifyOpenSandboxUploadFault, isOpenSandboxUploadFailureMessage, isTransientOpenSandboxUploadError, joinCommandLogText, writeFilesWithRetry } from "./opensandbox-sdk-client.js";
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

test("OpenSandbox SDK create forwards extensions and does not force execd isolation", () => {
  const source = readFileSync(new URL("./opensandbox-sdk-client.ts", import.meta.url), "utf8");
  assert.match(source, /input\.extensions \? \{ extensions: input\.extensions \}/);
  assert.doesNotMatch(source, /"bootstrap\.execd\.isolation": "enable"/);
});

test("OpenSandbox execd run forwards uid/gid for privileged provision writes", () => {
  const source = readFileSync(new URL("./opensandbox-sdk-client.ts", import.meta.url), "utf8");
  assert.match(source, /options\?\.uid != null \? \{ uid: options\.uid, gid: options\.gid \?\? 0 \}/);
});

test("Pi and DSH stay on the same OpenSandbox RuntimeHost path", () => {
  for (const id of ["pi", "dsh"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.incrementalMessages, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.platformControlApi, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.interactiveTerminal, true);
  }
});

test("OpenSandbox upload errors classify transient proxy 500s and keep auth failures fail-closed", () => {
  assert.equal(
    isTransientOpenSandboxUploadError(Object.assign(new Error("Upload failed (status=500)"), {
      statusCode: 500,
      code: "UNEXPECTED_RESPONSE",
    })),
    true,
  );
  assert.equal(
    isTransientOpenSandboxUploadError(new Error("An internal error occurred in the proxy: Server disconnected without sending a response")),
    true,
  );
  assert.equal(
    isTransientOpenSandboxUploadError(Object.assign(new Error("forbidden"), { statusCode: 403 })),
    false,
  );
  assert.equal(
    isTransientOpenSandboxUploadError(Object.assign(new Error("SANDBOX_NOT_FOUND"), { statusCode: 404 })),
    false,
  );
});

test("writeFilesWithRetry retries transient upload 500 then succeeds", async () => {
  const calls: number[] = [];
  const delays: number[] = [];
  await writeFilesWithRetry(
    async () => {
      calls.push(1);
      if (calls.length < 3) {
        throw Object.assign(new Error("Upload failed (status=500)"), {
          statusCode: 500,
          code: "UNEXPECTED_RESPONSE",
        });
      }
    },
    [{ path: "/workspace/a.txt", data: "x" }],
    { baseDelayMs: 1, sleep: async (ms) => { delays.push(ms); } },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1, 2]);
});

test("writeFilesWithRetry does not retry permanent failures", async () => {
  let calls = 0;
  await assert.rejects(
    () => writeFilesWithRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      },
      [{ path: "/workspace/a.txt", data: "x" }],
      { attempts: 3, baseDelayMs: 1, sleep: async () => undefined },
    ),
    /forbidden/,
  );
  assert.equal(calls, 1);
});

test("OpenSandbox SDK client routes writeFile and stdin uploads through writeFilesWithRetry", () => {
  const source = readFileSync(new URL("./opensandbox-sdk-client.ts", import.meta.url), "utf8");
  assert.match(source, /writeFilesWithRetry/);
  assert.match(source, /isTransientOpenSandboxUploadError/);
  assert.equal((source.match(/writeFilesWithRetry\(/g) ?? []).length >= 3, true);
});

test("classifyOpenSandboxUploadFault distinguishes transient vs persistent_signal after retries", () => {
  const err = Object.assign(new Error("Upload failed (status=500)"), {
    statusCode: 500,
    code: "UNEXPECTED_RESPONSE",
  });
  assert.equal(classifyOpenSandboxUploadFault(err), "transient");
  assert.equal(classifyOpenSandboxUploadFault(err, { retriesExhausted: true }), "persistent_signal");
  assert.equal(classifyOpenSandboxUploadFault(new Error("forbidden")), "none");
  assert.equal(isOpenSandboxUploadFailureMessage("Upload failed (status=503) UNEXPECTED_RESPONSE"), true);
  assert.equal(isOpenSandboxUploadFailureMessage("model 401 unauthorized"), false);
});
