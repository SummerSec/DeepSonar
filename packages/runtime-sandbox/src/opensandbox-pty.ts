/**
 * execd PTY/pipe WebSocket client. Pinned SDK public declarations have no first-class PTY helper
 * (upstream #1078); this module is the DeepSonar-owned mapping to RuntimeProcess.
 */
import type { OpenSandboxExecHandle } from "./opensandbox.js";
import type { RuntimeProcessChunk } from "./runtime-host.js";
import { projectProcessError, RuntimeProcessFailure, safeProcessDiagnosticText, type RuntimeProcessDiagnostic } from "./runtime-process-diagnostic.js";

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
  /** Host-only; never included in the execd create body or command. */
  diagnosticSecrets?: readonly string[];
}

export interface PtyWebSocketEvent {
  data?: unknown;
  message?: string;
  error?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: PtyWebSocketEvent) => void): void;
  removeEventListener?(type: "open" | "message" | "error" | "close", listener: (event: PtyWebSocketEvent) => void): void;
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
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "" };
  const frame = value as Record<string, unknown>;
  return { type: typeof frame.type === "string" ? frame.type : "",
    ...(Number.isSafeInteger(frame.exit_code) ? { exitCode: frame.exit_code as number } : {}),
    ...(typeof frame.error === "string" ? { error: frame.error } : {}) };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function defaultOpenWebSocket(url: string, headers: Record<string, string>): WebSocketLike {
  throw new Error("OPENSANDBOX_PTY_WS_FACTORY_REQUIRED");
}

export const PTY_TERMINATION_OBSERVATION_MS = 50;
export const PTY_CONNECT_TIMEOUT_MS = 15_000;
const PTY_CLEANUP_TIMEOUT_MS = 1_000;

export async function openOpenSandboxPty(
  endpoint: OpenSandboxPtyEndpoint,
  input: OpenSandboxPtyOpenInput,
  deps: OpenSandboxPtyDeps = {},
): Promise<OpenSandboxExecHandle> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secrets = [...Object.values(endpoint.headers), ...(input.diagnosticSecrets ?? [])].filter(Boolean);
  let phase: RuntimeProcessDiagnostic["phase"] = "create";
  let termination: RuntimeProcessDiagnostic["termination"] | undefined;
  let exitFrame: RuntimeProcessDiagnostic["exit_frame"] = null;
  let websocketClose: RuntimeProcessDiagnostic["websocket_close"] = null;
  let websocketError: RuntimeProcessDiagnostic["websocket_error"] = null;
  let serverError: string | undefined;
  let hostKillRequested = false;
  let closeRequested = false;
  const diagnostic = (): RuntimeProcessDiagnostic => structuredClone<RuntimeProcessDiagnostic>({
    source: "opensandbox_pty", phase, termination: termination!, exit_frame: exitFrame,
    websocket_close: websocketClose, websocket_error: websocketError,
    ...(serverError !== undefined ? { server_error: serverError } : {}),
    host_kill_requested: hostKillRequested, close_requested: closeRequested,
  });
  const failure = (code?: string) => new RuntimeProcessFailure(
    code ?? `OPENSANDBOX_PTY_${termination!.toUpperCase()}`, diagnostic());
  let sessionId: string;
  try {
    const created = await fetchImpl(joinUrl(endpoint.httpUrl, "pty"), {
      method: "POST", headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify({ cwd: input.cwd ?? "/workspace", command: input.command }),
    });
    if (!created.ok) throw new Error(`OPENSANDBOX_PTY_CREATE_FAILED HTTP_${created.status}`);
    const body = await created.json() as { session_id?: unknown };
    if (typeof body?.session_id !== "string" || !body.session_id || body.session_id.length > 256) {
      throw new Error("OPENSANDBOX_PTY_SESSION_MISSING");
    }
    sessionId = body.session_id;
  } catch (error) {
    termination = "create_error";
    websocketError = projectProcessError(error, secrets);
    throw failure();
  }
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fetchImpl(joinUrl(endpoint.httpUrl, `pty/${encodeURIComponent(sessionId)}`), {
          method: "DELETE", headers: endpoint.headers, signal: controller.signal,
        }).catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, PTY_CLEANUP_TIMEOUT_MS); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  })();

  phase = "connect";
  let ws: WebSocketLike;
  try {
    const query = input.pty ? "" : "?pty=0";
    ws = (deps.openWebSocket ?? defaultOpenWebSocket)(
      `${toWebSocketUrl(joinUrl(endpoint.httpUrl, `pty/${encodeURIComponent(sessionId)}/ws`))}${query}`, endpoint.headers,
    );
    ws.binaryType = "arraybuffer";
  } catch (error) {
    termination = "transport_error";
    websocketError = projectProcessError(error, secrets);
    await cleanup();
    throw failure();
  }

  const chunks: RuntimeProcessChunk[] = [];
  const waiters = new Set<() => void>();
  let done = false;
  let stdinClosed = false;
  let opened = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const connected = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const wake = () => { for (const waiter of waiters) waiter(); waiters.clear(); };
  const closeSocket = () => {
    if (closeRequested) return;
    closeRequested = true;
    try { ws.close(); } catch { /* local cleanup cannot replace the first terminal source */ }
  };
  const listeners: Array<["open" | "message" | "error" | "close", (event: PtyWebSocketEvent) => void]> = [];
  const finish = () => {
    if (done) return;
    done = true;
    if (connectTimer) clearTimeout(connectTimer);
    if (settleTimer) clearTimeout(settleTimer);
    for (const [type, listener] of listeners) ws.removeEventListener?.(type, listener);
    if (termination === "process_exit") chunks.push({ type: "exit", exitCode: exitFrame!.exit_code! });
    // Freeze observations before local close; its event must not impersonate a peer close.
    closeSocket();
    wake();
    if (!opened) rejectOpen(failure());
  };
  const terminate = (source: RuntimeProcessDiagnostic["termination"]) => {
    if (done || termination) return;
    termination = source;
    if (connectTimer) clearTimeout(connectTimer);
    settleTimer = setTimeout(finish, PTY_TERMINATION_OBSERVATION_MS);
  };
  const listen = (type: typeof listeners[number][0], listener: (event: PtyWebSocketEvent) => void) => {
    listeners.push([type, listener]); ws.addEventListener(type, listener);
  };
  // Install stream and termination listeners before awaiting open: execd may send
  // output/exit immediately in the same turn as the handshake event.
  listen("message", event => {
    if (done) return;
    const data = event.data;
    if (typeof data === "string") {
      let frame: ReturnType<typeof parsePtyTextFrame>;
      try { frame = parsePtyTextFrame(data); } catch { return; }
      if (frame.type === "exit" && !exitFrame) {
        exitFrame = { type: "exit", exit_code: frame.exitCode ?? null, valid: frame.exitCode !== undefined,
          observed_after_termination: termination !== undefined };
        terminate(frame.exitCode === undefined ? "protocol_error" : "process_exit");
      } else if (frame.type === "error" && serverError === undefined) {
        serverError = safeProcessDiagnosticText(frame.error, secrets);
        terminate("protocol_error");
      }
      return;
    }
    if (termination) return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : undefined;
    const chunk = bytes ? decodePtyBinary(bytes) : undefined;
    if (chunk) { chunks.push(chunk); wake(); }
  });
  listen("error", event => {
    if (done) return;
    websocketError ??= projectProcessError(event.error ?? { message: event.message ?? "WebSocket error" }, secrets);
    terminate("transport_error");
  });
  listen("close", event => {
    if (done) return;
    websocketClose ??= { code: Number.isInteger(event.code) ? event.code! : null,
      reason: safeProcessDiagnosticText(event.reason, secrets), was_clean: typeof event.wasClean === "boolean" ? event.wasClean : null };
    terminate("transport_closed");
  });
  listen("open", () => {
    if (done || termination || opened) return;
    opened = true;
    phase = "stream";
    if (connectTimer) clearTimeout(connectTimer);
    resolveOpen();
  });
  if (!opened && !termination) connectTimer = setTimeout(() => terminate("connect_timeout"), PTY_CONNECT_TIMEOUT_MS);
  try { await connected; }
  catch (error) { await cleanup(); throw error; }

  return {
    id: sessionId,
    getTerminationDiagnostic: () => termination ? diagnostic() : undefined,
    async write(data) {
      if (termination) {
        if (!done) await new Promise<void>(resolve => waiters.add(resolve));
        throw failure();
      }
      if (stdinClosed) throw new Error("agent stdin 已关闭，无法追加消息");
      try { ws.send(encodePtyStdin(data)); }
      catch (error) {
        websocketError ??= projectProcessError(error, secrets);
        terminate("transport_error");
        // Wait for accompanying close before exposing the immutable failure.
        if (!done) await new Promise<void>(resolve => waiters.add(resolve));
        throw failure();
      }
    },
    async closeStdin() {
      // execd has no stdin EOF frame. Only the terminal-result killer may stop it.
      stdinClosed = true;
    },
    async kill() {
      stdinClosed = true;
      hostKillRequested = true;
      if (!done) {
        terminate("host_kill");
        try { ws.send(JSON.stringify({ type: "signal", signal: "SIGTERM" })); } catch { /* already closed */ }
        closeSocket();
        if (!done) await new Promise<void>(resolve => waiters.add(resolve));
      }
      await cleanup();
    },
    async resize(cols, rows) {
      if (!input.pty) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    },
    async *[Symbol.asyncIterator](): AsyncIterator<RuntimeProcessChunk> {
      while (true) {
        if (chunks.length) { yield chunks.shift()!; continue; }
        if (done) {
          if (termination !== "process_exit") throw failure();
          return;
        }
        await new Promise<void>(resolve => waiters.add(resolve));
      }
    },
  };
}
