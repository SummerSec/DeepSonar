/**
 * execd PTY/pipe WebSocket client. Official JS SDK 0.1.11 has no helper yet
 * (upstream #1078); this module is the DeepSonar-owned mapping to RuntimeProcess.
 */
import type { OpenSandboxExecHandle } from "./opensandbox.js";
import type { RuntimeProcessChunk } from "./runtime-host.js";

export const PTY_BIN_STDIN = 0x00;
export const PTY_BIN_STDOUT = 0x01;
export const PTY_BIN_STDERR = 0x02;
export const PTY_BIN_REPLAY = 0x03;

export interface OpenSandboxPtyEndpoint {
  httpUrl: string;
  headers: Record<string, string>;
}

export interface OpenSandboxPtyOpenInput {
  cwd?: string;
  command?: string;
  pty: boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown; message?: string }) => void): void;
}

export interface OpenSandboxPtyDeps {
  fetchImpl?: typeof fetch;
  openWebSocket?: (url: string, headers: Record<string, string>) => WebSocketLike;
}

export function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  throw new Error("OPENSANDBOX_PTY_URL_INVALID");
}

export function encodePtyStdin(data: string): Uint8Array {
  const body = Buffer.from(data, "utf8");
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = PTY_BIN_STDIN;
  frame.set(body, 1);
  return frame;
}

export function decodePtyBinary(data: Uint8Array): RuntimeProcessChunk | undefined {
  if (data.byteLength < 2) return undefined;
  const type = data[0];
  const payload = data[0] === PTY_BIN_REPLAY && data.byteLength > 9 ? data.subarray(9) : data.subarray(1);
  const chunk = Buffer.from(payload).toString("utf8");
  if (type === PTY_BIN_STDERR) return { type: "stderr", chunk };
  if (type === PTY_BIN_STDOUT || type === PTY_BIN_REPLAY) return { type: "stdout", chunk };
  return undefined;
}

export function parsePtyTextFrame(text: string): { type: string; exitCode?: number; error?: string } {
  const frame = JSON.parse(text) as { type?: string; exit_code?: number; error?: string };
  return { type: String(frame.type ?? ""), exitCode: frame.exit_code, error: frame.error };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function defaultOpenWebSocket(url: string, headers: Record<string, string>): WebSocketLike {
  throw new Error(`OPENSANDBOX_PTY_WS_FACTORY_REQUIRED: ${url} headers=${Object.keys(headers).length}`);
}

export async function openOpenSandboxPty(
  endpoint: OpenSandboxPtyEndpoint,
  input: OpenSandboxPtyOpenInput,
  deps: OpenSandboxPtyDeps = {},
): Promise<OpenSandboxExecHandle> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const created = await fetchImpl(joinUrl(endpoint.httpUrl, "pty"), {
    method: "POST",
    headers: { "content-type": "application/json", ...endpoint.headers },
    body: JSON.stringify({ cwd: input.cwd ?? "/workspace", command: input.command }),
  });
  if (!created.ok) {
    throw new Error(`OPENSANDBOX_PTY_CREATE_FAILED: ${created.status}`);
  }
  const body = await created.json() as { session_id?: string };
  const sessionId = body.session_id;
  if (!sessionId) throw new Error("OPENSANDBOX_PTY_SESSION_MISSING");

  const query = input.pty ? "" : "?pty=0";
  const ws = (deps.openWebSocket ?? defaultOpenWebSocket)(
    `${toWebSocketUrl(joinUrl(endpoint.httpUrl, `pty/${sessionId}/ws`))}${query}`,
    endpoint.headers,
  );
  ws.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OPENSANDBOX_PTY_CONNECT_TIMEOUT")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(event.message ?? "OPENSANDBOX_PTY_CONNECT_FAILED"));
    });
  });

  const chunks: RuntimeProcessChunk[] = [];
  const waiters: Array<(value: IteratorResult<RuntimeProcessChunk>) => void> = [];
  let done = false;
  let closed = false;

  const push = (chunk: RuntimeProcessChunk) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else chunks.push(chunk);
  };
  const finish = (exitCode = 0) => {
    if (done) return;
    done = true;
    push({ type: "exit", exitCode });
    while (waiters.length) waiters.shift()!({ value: undefined, done: true });
  };

  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") {
      try {
        const frame = parsePtyTextFrame(data);
        if (frame.type === "exit") finish(frame.exitCode ?? 0);
        if (frame.type === "error" && frame.error) push({ type: "stderr", chunk: frame.error });
      } catch {
        /* ignore non-JSON control */
      }
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : undefined;
    if (!bytes) return;
    const chunk = decodePtyBinary(bytes);
    if (chunk) push(chunk);
  });
  ws.addEventListener("close", () => finish(done ? 0 : 1));
  ws.addEventListener("error", () => finish(1));

  return {
    id: sessionId,
    async write(data) {
      if (closed || done) throw new Error("agent stdin 已关闭，无法追加消息");
      ws.send(encodePtyStdin(data));
    },
    async closeStdin() {
      // execd PTY/pipe 只转发 0x00 stdin 字节，没有关闭写端的控制帧。
      // 这里只禁止后续 write；需要立即 EOF 的 CLI 必须在命令里重定向 stdin。
      closed = true;
    },
    async kill() {
      closed = true;
      try {
        ws.send(JSON.stringify({ type: "signal", signal: "SIGTERM" }));
      } catch { /* already closed */ }
      ws.close();
      await fetchImpl(joinUrl(endpoint.httpUrl, `pty/${sessionId}`), {
        method: "DELETE",
        headers: endpoint.headers,
      }).catch(() => undefined);
      finish(1);
    },
    async resize(cols, rows) {
      if (!input.pty) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    async *[Symbol.asyncIterator](): AsyncIterator<RuntimeProcessChunk> {
      while (true) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
          continue;
        }
        if (done) return;
        const next = await new Promise<IteratorResult<RuntimeProcessChunk>>((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}
