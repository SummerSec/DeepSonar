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

// #1088：真实 CLI 退出与连接中断必须可区分；退出帧投影、关闭码/clean/原因单独留证。
function ptyHarness() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const ws: WebSocketLike = {
    readyState: 1,
    binaryType: "arraybuffer",
    send() {},
    close() {},
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener as (event: Record<string, unknown>) => void);
      listeners.set(type, list);
      if (type === "open") queueMicrotask(() => listener({}));
    },
  };
  const emit = (type: string, event: Record<string, unknown> = {}) =>
    listeners.get(type)?.forEach((listener) => listener(event));
  const open = () =>
    openOpenSandboxPty(
      { httpUrl: "http://127.0.0.1:44772", headers: { "OPEN-SANDBOX-API-KEY": "secret" } },
      { cwd: "/workspace", command: "pi --mode rpc", pty: true },
      {
        fetchImpl: async (_url, init) =>
          init?.method === "POST"
            ? new Response(JSON.stringify({ session_id: "pty-1" }), { status: 200 })
            : new Response(null, { status: 200 }),
        openWebSocket: () => ws,
      },
    );
  return { open, emit };
}

test("#1088 只有合法退出帧才产生 CLI 退出码，缺码退出帧按传输异常收口", async () => {
  const harness = ptyHarness();
  const handle = await harness.open();
  const iter = handle[Symbol.asyncIterator]();
  queueMicrotask(() => harness.emit("message", { data: JSON.stringify({ type: "exit" }) }));
  const terminal = await iter.next();
  assert.equal(terminal.value?.type, "process-failure", "缺少 exit_code 的退出帧不得默认成 exit 0");
  assert.match(String((terminal.value as { reason?: string })?.reason), /OPENSANDBOX_PTY_EXIT_FRAME_INVALID/u);
  assert.match(String((terminal.value as { reason?: string })?.reason), /exit_frame=invalid/u);
  assert.equal((await iter.next()).done, true);
});

test("#1088 WebSocket 关闭单独保存关闭码、clean 标记与脱敏原因，不伪造 exit 1", async () => {
  const harness = ptyHarness();
  const handle = await harness.open();
  const iter = handle[Symbol.asyncIterator]();
  queueMicrotask(() => harness.emit("close", { code: 1006, reason: "upstream\u0000gone", wasClean: false }));
  const terminal = await iter.next();
  const reason = String((terminal.value as { reason?: string })?.reason);
  assert.equal(terminal.value?.type, "process-failure");
  assert.match(reason, /OPENSANDBOX_PTY_TRANSPORT_CLOSED cause=ws-close/u);
  assert.match(reason, /exit_frame=absent close_code=1006 clean=false close_reason=upstream gone/u);
  assert.equal(reason.includes("\u0000"), false, "控制字节不得进入证据文本");
});

test("#1088 WebSocket 错误以有界脱敏原因收口，且随后关闭不再追加终态帧", async () => {
  const harness = ptyHarness();
  const handle = await harness.open();
  const iter = handle[Symbol.asyncIterator]();
  const noisy = `socket failed ${"x".repeat(400)}`;
  queueMicrotask(() => {
    harness.emit("error", { message: noisy });
    harness.emit("close", { code: 1006, reason: "late", wasClean: false });
  });
  const terminal = await iter.next();
  const reason = String((terminal.value as { reason?: string })?.reason);
  assert.equal(terminal.value?.type, "process-failure");
  assert.match(reason, /cause=ws-error/u);
  assert.match(reason, /transport_error=socket failed x+/u);
  assert.ok(reason.length <= 512, `终态原因必须有界，实际 ${reason.length}`);
  assert.equal(reason.includes("x".repeat(200)), false, "错误原因必须截断");
  assert.equal((await iter.next()).done, true, "已完成时关闭事件只留证，不追加第二个终态");
});

test("#1088 合法退出帧与关闭竞态时只产生一次真实退出码", async () => {
  const harness = ptyHarness();
  const handle = await harness.open();
  const iter = handle[Symbol.asyncIterator]();
  queueMicrotask(() => {
    harness.emit("message", { data: JSON.stringify({ type: "exit", exit_code: 7 }) });
    harness.emit("close", { code: 1000, reason: "", wasClean: true });
  });
  assert.deepEqual((await iter.next()).value, { type: "exit", exitCode: 7 });
  assert.equal((await iter.next()).done, true);
});

test("#1088 宿主主动终止不伪造退出码，按 host-kill 留证", async () => {
  const harness = ptyHarness();
  const handle = await harness.open();
  const iter = handle[Symbol.asyncIterator]();
  const pending = iter.next();
  await handle.kill();
  const terminal = await pending;
  assert.equal(terminal.value?.type, "process-failure");
  assert.match(String((terminal.value as { reason?: string })?.reason), /cause=host-kill/u);
});
