import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePtyBinary,
  encodePtyStdin,
  openOpenSandboxPty,
  parsePtyTextFrame,
  PTY_BIN_STDIN,
  PTY_BIN_STDERR,
  PTY_BIN_STDOUT,
  toWebSocketUrl,
  type WebSocketLike,
} from "./opensandbox-pty.js";

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
  await assert.rejects(handle.write("late"), /stdin 已关闭/);
});
