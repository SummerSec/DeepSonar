import assert from "node:assert/strict";
import test from "node:test";
import { runRealAgent } from "./runtime-agent.js";
import { createOpenSandboxRuntimeHost, type OpenSandboxSession } from "./opensandbox.js";
import { classifyCliSessionResumeError } from "./runtime-error-classification.js";
import {
  decodePtyBinary,
  encodePtyStdin,
  openOpenSandboxPty,
  parsePtyTextFrame,
  PTY_BIN_STDIN,
  PTY_BIN_STDERR,
  PTY_BIN_STDOUT,
  PTY_CONNECT_TIMEOUT_MS,
  PTY_TERMINATION_OBSERVATION_MS,
  toWebSocketUrl,
  type WebSocketLike,
} from "./opensandbox-pty.js";

type PtyEvent = { data?: unknown; message?: string; code?: number; reason?: string; wasClean?: boolean; error?: unknown };

async function ptyFixture(
  onSend?: (data: string | ArrayBuffer | Uint8Array, emit: (type: string, event?: PtyEvent) => void) => void,
  onOpen?: (emit: (type: string, event?: PtyEvent) => void) => void,
  diagnosticSecrets?: readonly string[],
) {
  const listeners = new Map<string, Array<(event: PtyEvent) => void>>();
  const emit = (type: string, event: PtyEvent = {}) => listeners.get(type)?.forEach(listener => listener(event));
  const ws: WebSocketLike = {
    readyState: 1, binaryType: "arraybuffer",
    send(data) { onSend?.(data, emit); }, close() { emit("close", { code: 1000, reason: "host close", wasClean: true }); },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      if (type === "open") queueMicrotask(() => { emit("open"); onOpen?.(emit); });
    },
  };
  const handle = await openOpenSandboxPty(
    { httpUrl: "http://localhost:44772", headers: { "OPEN-SANDBOX-API-KEY": "endpoint-secret" } },
    { command: "pi --mode rpc", pty: false, diagnosticSecrets },
    { openWebSocket: () => ws, fetchImpl: async () => new Response(JSON.stringify({ session_id: "test-pty" })) },
  );
  return { handle, emit };
}

for (const code of [1000, 1006]) {
  test(`PTY close ${code} without exit frame must not manufacture a CLI exit code`, async () => {
    const { handle, emit } = await ptyFixture();
    const observed: Array<{ type: string }> = [];
    emit("close", { code, reason: "connection lost", wasClean: code === 1000 });
    await assert.rejects(async () => { for await (const chunk of handle) observed.push(chunk); }, /OPENSANDBOX_PTY_/);
    assert.deepEqual(observed, []);
  });
}

test("PTY exit frame without an integer exit_code must not default to success", async () => {
  const { handle, emit } = await ptyFixture();
  emit("message", { data: JSON.stringify({ type: "exit" }) });
  await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } }, /OPENSANDBOX_PTY_/);
});

for (const exitCode of [0, 7, 137, -1]) {
  test(`PTY preserves actual exit ${exitCode} and accompanying close`, async () => {
    const { handle, emit } = await ptyFixture();
    emit("message", { data: JSON.stringify({ type: "exit", exit_code: exitCode }) });
    emit("close", { code: 1000, reason: "command ended", wasClean: true });
    const observed: Array<{ type: string }> = [];
    for await (const chunk of handle) observed.push(chunk);
    assert.deepEqual(observed, [{ type: "exit", exitCode }]);
    const diagnostic = handle.getTerminationDiagnostic?.();
    assert.equal(diagnostic?.termination, "process_exit");
    assert.equal(diagnostic?.exit_frame?.exit_code, exitCode);
    assert.equal(diagnostic?.websocket_close?.code, 1000);
    assert.equal(diagnostic?.websocket_close?.reason, "command ended");
    assert.equal(diagnostic?.websocket_close?.was_clean, true);
  });
}

test("PTY error drains output, preserves cause and close without accepting a late exit", async () => {
  const { handle, emit } = await ptyFixture();
  emit("message", { data: Uint8Array.of(PTY_BIN_STDOUT, 65) });
  emit("error", { error: new Error("socket failed", { cause: Object.assign(new Error("peer reset"), { code: "ECONNRESET" }) }) });
  emit("message", { data: JSON.stringify({ type: "exit", exit_code: 0 }) });
  emit("close", { code: 1006, reason: "abnormal", wasClean: false });
  const observed: Array<{ type: string }> = [];
  await assert.rejects(async () => { for await (const chunk of handle) observed.push(chunk); }, /OPENSANDBOX_PTY_/);
  assert.deepEqual(observed, [{ type: "stdout", chunk: "A" }]);
  const diagnostic = handle.getTerminationDiagnostic?.();
  assert.equal(diagnostic?.termination, "transport_error");
  assert.equal(diagnostic?.websocket_error?.cause?.code, "ECONNRESET");
  assert.equal(diagnostic?.websocket_close?.code, 1006);
  assert.equal(diagnostic?.exit_frame?.observed_after_termination, true);
});

test("PTY exit without close terminates within a bounded observation window", async () => {
  const { handle, emit } = await ptyFixture();
  emit("message", { data: JSON.stringify({ type: "exit", exit_code: 3 }) });
  const observed: Array<{ type: string }> = [];
  for await (const chunk of handle) observed.push(chunk);
  assert.deepEqual(observed, [{ type: "exit", exitCode: 3 }]);
  assert.equal(handle.getTerminationDiagnostic?.()?.websocket_close, null);
});

test("PTY host kill never manufactures a CLI exit and is idempotent", async () => {
  const { handle } = await ptyFixture();
  await handle.kill();
  await handle.kill();
  await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } }, /OPENSANDBOX_PTY_/);
  assert.equal(handle.getTerminationDiagnostic?.()?.termination, "host_kill");
  assert.equal(handle.getTerminationDiagnostic?.()?.exit_frame, null);
});

test("PTY diagnostics redact endpoint secrets, URLs and error stacks before bounding", async () => {
  const { handle, emit } = await ptyFixture();
  emit("error", { error: new Error("endpoint-secret https://user:pass@host/?credential=hidden Bearer hidden-bearer " + "x".repeat(10000)) });
  emit("close", { code: 1006, reason: "endpoint-secret https://host/?token=hidden", wasClean: false });
  await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } });
  const serialized = JSON.stringify(handle.getTerminationDiagnostic?.());
  assert.doesNotMatch(serialized, /endpoint-secret|https:|hidden|stack|opensandbox-pty\.test/);
  assert.ok(serialized.length < 4000);
  assert.match(serialized, /REDACTED/);
});

test("PTY listeners capture exit sent synchronously with open", async () => {
  const { handle } = await ptyFixture(undefined, emit => {
    emit("message", { data: JSON.stringify({ type: "exit", exit_code: 9 }) });
    emit("close", { code: 1000 });
  });
  const observed: Array<{ type: string }> = [];
  for await (const chunk of handle) observed.push(chunk);
  assert.deepEqual(observed, [{ type: "exit", exitCode: 9 }]);
});

test("PTY close before open rejects startup with close evidence", async () => {
  const listeners = new Map<string, (event: PtyEvent) => void>();
  const opening = openOpenSandboxPty(
    { httpUrl: "http://localhost:44772", headers: {} }, { pty: false },
    {
      fetchImpl: async () => new Response(JSON.stringify({ session_id: "early-close" })),
      openWebSocket: () => ({
        readyState: 0, binaryType: "arraybuffer", send() {}, close() {},
        addEventListener(type, listener) {
          listeners.set(type, listener);
          if (type === "open") queueMicrotask(() => listeners.get("close")?.({ code: 1006, reason: "handshake refused", wasClean: false }));
        },
      }),
    },
  );
  await assert.rejects(opening, (error: unknown) => {
    const failure = error as Error & { diagnostic?: { phase?: string; websocket_close?: { code?: number } } };
    assert.match(failure.message, /OPENSANDBOX_PTY_/);
    assert.equal(failure.diagnostic?.phase, "connect");
    assert.equal(failure.diagnostic?.websocket_close?.code, 1006);
    return true;
  });
});

for (const invalid of [null, "0", 0.5, {}, Number.MAX_VALUE]) {
  test(`PTY invalid exit_code ${JSON.stringify(invalid)} fails closed`, async () => {
    const { handle, emit } = await ptyFixture();
    emit("message", { data: JSON.stringify({ type: "exit", exit_code: invalid }) });
    emit("close", { code: 1000 });
    await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } }, /OPENSANDBOX_PTY_/);
    assert.equal(handle.getTerminationDiagnostic?.()?.exit_frame?.valid, false);
  });
}

test("PTY duplicate/conflicting exits preserve first authority and ignore late data", async () => {
  const { handle, emit } = await ptyFixture();
  emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });
  emit("message", { data: JSON.stringify({ type: "exit", exit_code: 0 }) });
  emit("close", { code: 1000 });
  emit("message", { data: Uint8Array.of(PTY_BIN_STDOUT, 65) });
  const observed: Array<{ type: string }> = [];
  for await (const chunk of handle) observed.push(chunk);
  assert.deepEqual(observed, [{ type: "exit", exitCode: 7 }]);
  assert.equal(handle.getTerminationDiagnostic?.()?.exit_frame?.exit_code, 7);
});

test("PTY close then exit retains the late frame without reversing transport failure", async () => {
  const { handle, emit } = await ptyFixture();
  emit("close", { code: 1000, reason: "closed", wasClean: true });
  emit("message", { data: JSON.stringify({ type: "exit", exit_code: 0 }) });
  await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } });
  const diagnostic = handle.getTerminationDiagnostic?.();
  assert.equal(diagnostic?.termination, "transport_closed");
  assert.equal(diagnostic?.exit_frame?.exit_code, 0);
  assert.equal(diagnostic?.exit_frame?.observed_after_termination, true);
});

for (const intentional of [false, true]) {
  test(`PTY successful terminal followed by ${intentional ? "host kill succeeds" : "transport loss fails"}`, async () => {
    let handle: Awaited<ReturnType<typeof openOpenSandboxPty>>;
    let prompted = false;
    const fixture = await ptyFixture((data, emit) => {
      if (!(data instanceof Uint8Array) || prompted) return;
      prompted = true;
      const output = [
        { type: "system", subtype: "init", session_id: "session-pty" },
        { type: "result", is_error: false, result: "complete" },
      ].map(record => JSON.stringify(record) + "\n").join("");
      emit("message", { data: Buffer.concat([Buffer.from([PTY_BIN_STDOUT]), Buffer.from(output)]) });
      if (intentional) setTimeout(() => { void handle.kill(); }, 20);
      else emit("close", { code: 1006, reason: "network timeout", wasClean: false });
    });
    handle = fixture.handle;
    let starts = 0;
    const session: OpenSandboxSession = {
      id: "sandbox-pty", async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
      async runAsync() { starts++; return handle; },
      async writeFile() {}, async readFile() { return Buffer.from(""); },
      async getState() { return "Running"; }, async kill() {}, async close() {},
    };
    const events: Record<string, unknown>[] = [];
    const result = await runRealAgent(createOpenSandboxRuntimeHost(session), {
      provider: "claude-code", env: {}, input: "test", onEvent: event => events.push(event),
    });
    assert.equal(result.terminalOutcome, intentional ? "success" : "failure");
    assert.equal(Boolean(result.error), !intentional);
    assert.equal(starts, 1);
    const diagnostic = events.find(event => event.code === "OPENSANDBOX_PTY_TERMINATION");
    assert.equal(diagnostic?.termination, intentional ? "host_kill" : "transport_closed");
  });
}

test("PTY stable failure identity forbids generic process resume after stringification", () => {
  for (const detail of ["network ECONNRESET", "timeout", "context window exceeded", "HTTP 503"]) {
    assert.equal(classifyCliSessionResumeError(`OPENSANDBOX_PTY_TRANSPORT_ERROR: ${detail}`), undefined);
  }
});

test("PTY redacts secrets spanning the diagnostic byte limit and bounds circular causes", async () => {
  const secret = "a-secret-crossing-byte-limit";
  const { handle, emit } = await ptyFixture(undefined, undefined, [secret]);
  const error = new Error("x".repeat(500) + secret);
  error.cause = error;
  emit("error", { error });
  await assert.rejects(async () => { for await (const _chunk of handle) { /* drain */ } });
  const diagnostic = handle.getTerminationDiagnostic?.();
  assert.equal(diagnostic?.websocket_close, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /a-secret/);
  assert.ok(Buffer.byteLength(diagnostic?.websocket_error?.message ?? "") <= 512);
  assert.equal(diagnostic?.websocket_error?.cause?.cause?.cause, undefined);
});

test("PTY server error control frame is projected, not exposed as raw stderr", async () => {
  const { handle, emit } = await ptyFixture();
  emit("message", { data: JSON.stringify({ type: "error", error: "endpoint-secret execd refused", headers: "private" }) });
  emit("close", { code: 1011, reason: "execd error", wasClean: false });
  const observed: Array<{ type: string }> = [];
  await assert.rejects(async () => { for await (const chunk of handle) observed.push(chunk); });
  assert.deepEqual(observed, []);
  assert.match(handle.getTerminationDiagnostic?.()?.server_error ?? "", /REDACTED.*execd refused/);
});

test("PTY initial stdin send failure is persisted before run initialization rethrows", async () => {
  const { handle } = await ptyFixture(() => { throw Object.assign(new Error("endpoint-secret send failed"), { code: "ECONNRESET" }); });
  const session: OpenSandboxSession = {
    id: "send-failure", async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async runAsync() { return handle; }, async writeFile() {}, async readFile() { return Buffer.from(""); },
    async getState() { return "Running"; }, async kill() {}, async close() {},
  };
  const events: Record<string, unknown>[] = [];
  await assert.rejects(runRealAgent(createOpenSandboxRuntimeHost(session), {
    provider: "claude-code", env: {}, input: "test", onEvent: event => events.push(event),
  }), /OPENSANDBOX_PTY_/);
  const diagnostics = events.filter(event => event.code === "OPENSANDBOX_PTY_TERMINATION");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.termination, "transport_error");
  assert.equal((diagnostics[0]?.websocket_error as { code?: string }).code, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(diagnostics), /endpoint-secret/);
});

test("PTY connect timeout is bounded and ignores a late open", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Map<string, (event: PtyEvent) => void>();
  let created!: () => void;
  const socketCreated = new Promise<void>(resolve => { created = resolve; });
  const opening = openOpenSandboxPty(
    { httpUrl: "http://localhost:44772", headers: {} }, { pty: false },
    {
      fetchImpl: async () => new Response(JSON.stringify({ session_id: "timeout-pty" })),
      openWebSocket: () => {
        created();
        return { readyState: 0, binaryType: "arraybuffer", send() {}, close() {},
          addEventListener(type, listener) { listeners.set(type, listener); } };
      },
    },
  );
  const rejected = assert.rejects(opening, (error: unknown) => {
    const failure = error as Error & { diagnostic?: { termination?: string; phase?: string; websocket_close?: unknown } };
    assert.equal(failure.message, "OPENSANDBOX_PTY_CONNECT_TIMEOUT");
    assert.equal(failure.diagnostic?.phase, "connect");
    assert.equal(failure.diagnostic?.websocket_close, null);
    return true;
  });
  await socketCreated;
  context.mock.timers.tick(PTY_CONNECT_TIMEOUT_MS);
  context.mock.timers.tick(PTY_TERMINATION_OBSERVATION_MS);
  await rejected;
  listeners.get("open")?.({});
});

test("OpenSandbox PTY framing encodes stdin and decodes stdout/stderr", () => {
  const encoded = encodePtyStdin("hello");
  assert.equal(encoded[0], PTY_BIN_STDIN);
  assert.equal(Buffer.from(encoded.subarray(1)).toString(), "hello");
  assert.deepEqual(decodePtyBinary(Uint8Array.of(PTY_BIN_STDOUT, 65)), { type: "stdout", chunk: "A" });
  assert.deepEqual(decodePtyBinary(Uint8Array.of(PTY_BIN_STDERR, 66)), { type: "stderr", chunk: "B" });
  assert.equal(toWebSocketUrl("http://127.0.0.1:8080"), "ws://127.0.0.1:8080");
  assert.equal(parsePtyTextFrame(JSON.stringify({ type: "exit", exit_code: 3 })).exitCode, 3);
});

test("OpenSandbox PTY client writes stdin, resizes, and surfaces exit", async () => {
  const sent: unknown[] = [];
  const listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  const ws: WebSocketLike = {
    readyState: 1,
    binaryType: "arraybuffer",
    send(data) { sent.push(data); },
    close() {
      listeners.get("close")?.forEach((listener) => listener({}));
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
      if (type === "open") queueMicrotask(() => listener({}));
    },
  };
  const fetches: Array<{ url: string; method?: string }> = [];
  const handle = await openOpenSandboxPty(
    { httpUrl: "http://127.0.0.1:44772", headers: { "OPEN-SANDBOX-API-KEY": "secret" } },
    { cwd: "/workspace", command: "pi --mode rpc", pty: true },
    {
      fetchImpl: async (url, init) => {
        fetches.push({ url: String(url), method: String(init?.method ?? "GET") });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ session_id: "pty-1" }), { status: 200 });
        }
        return new Response(null, { status: 200 });
      },
      openWebSocket: () => ws,
    },
  );
  assert.equal(handle.id, "pty-1");
  assert.equal(fetches[0]?.url, "http://127.0.0.1:44772/pty");
  await handle.write("prompt\n");
  assert.equal((sent[0] as Uint8Array)[0], PTY_BIN_STDIN);
  assert.ok(handle.resize);
  await handle.resize(80, 24);
  assert.deepEqual(JSON.parse(String(sent[1])), { type: "resize", cols: 80, rows: 24 });
  const iter = handle[Symbol.asyncIterator]();
  queueMicrotask(() => {
    listeners.get("message")?.forEach((listener) => listener({ data: JSON.stringify({ type: "exit", exit_code: 0 }) }));
  });
  const first = await iter.next();
  assert.deepEqual(first.value, { type: "exit", exitCode: 0 });
  await handle.closeStdin();
  await assert.rejects(handle.write("late"), /stdin 已关闭|OPENSANDBOX_PTY_/);
});
