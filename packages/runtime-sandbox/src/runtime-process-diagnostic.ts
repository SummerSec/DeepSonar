import type { RuntimeHost, RuntimeProcess } from "./runtime-host.js";

export interface ProcessErrorDiagnostic {
  name?: string;
  code?: string;
  message?: string;
  cause?: ProcessErrorDiagnostic;
}

export type RuntimeKillCaller = "terminal_result" | "pi_rpc_failure" | "output_capture_failure" | "runtime_exception" | "transport_cleanup" | "terminal_close" | "unspecified_host";
export interface RuntimeCleanupDiagnostic {
  outcome: "confirmed" | "http_error" | "transport_error" | "timeout";
  http_status: number | null;
  requested_at: string;
  completed_at: string;
}
export interface RuntimeProcessObservation {
  process_sequence: number;
  process_id: string | null;
  diagnostic: RuntimeProcessDiagnostic;
  cleanup: RuntimeCleanupDiagnostic | null;
}

/** Host observations only: neither an exit receipt nor permission to replay effects. */
export interface RuntimeProcessDiagnostic {
  source: "opensandbox_pty";
  phase: "create" | "connect" | "stream";
  termination: "process_exit" | "transport_closed" | "transport_error" | "protocol_error" | "host_kill" | "connect_timeout" | "create_error";
  exit_frame: { type: "exit"; exit_code: number | null; valid: boolean; observed_after_termination: boolean } | null;
  websocket_close: { code: number | null; reason: string; was_clean: boolean | null } | null;
  websocket_error: ProcessErrorDiagnostic | null;
  server_error?: string;
  server_error_code?: string;
  host_kill_requested: boolean;
  host_kill_caller?: RuntimeKillCaller;
  close_requested: boolean;
}

export function safeProcessDiagnosticText(value: unknown, secrets: readonly string[], maxBytes = 512): string {
  if (typeof value !== "string") return "";
  let text = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, "[REDACTED_URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, "[REDACTED]")
    .replace(/((?:api[-_]?key|token|secret|password|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/giu, "$1[REDACTED]")
    .split(/[\r\n]/u, 1)[0]!.replace(/[\x00-\x1f\x7f]/gu, " ");
  // Redaction precedes the UTF-8 limit, including secrets crossing its boundary.
  let bytes = 0;
  let result = "";
  for (const point of text) {
    const length = Buffer.byteLength(point);
    if (bytes + length > maxBytes) break;
    bytes += length;
    result += point;
  }
  return result;
}

export function projectProcessError(value: unknown, secrets: readonly string[], depth = 0): ProcessErrorDiagnostic {
  if (!value || typeof value !== "object") return { message: safeProcessDiagnosticText(value, secrets) };
  const error = value as Record<string, unknown>;
  return {
    ...(typeof error.name === "string" ? { name: safeProcessDiagnosticText(error.name, secrets, 128) } : {}),
    ...(typeof error.code === "string" || typeof error.code === "number" ? { code: safeProcessDiagnosticText(String(error.code), secrets, 128) } : {}),
    ...(typeof error.message === "string" ? { message: safeProcessDiagnosticText(error.message, secrets) } : {}),
    ...(error.cause && depth < 2 ? { cause: projectProcessError(error.cause, secrets, depth + 1) } : {}),
  };
}

export class RuntimeProcessFailure extends Error {
  constructor(readonly code: string, readonly diagnostic: RuntimeProcessDiagnostic,
    readonly processId?: string, readonly cleanup?: RuntimeCleanupDiagnostic) {
    super(code);
    this.name = "RuntimeProcessFailure";
  }
}

export function runtimeProcessFailure(error: unknown, depth = 0): RuntimeProcessFailure | undefined {
  if (error instanceof RuntimeProcessFailure) return error;
  if (error instanceof Error && depth < 3) return runtimeProcessFailure(error.cause, depth + 1);
  return undefined;
}

export function canRetainTerminalResult(
  error: unknown,
  terminalResult: { isError?: boolean } | undefined,
  closeReason: string | undefined,
  diagnosticTransport: boolean,
): boolean {
  if (!terminalResult || closeReason !== "terminal_result") return false;
  const failure = runtimeProcessFailure(error);
  // An intentional kill is cleanup of the observed terminal, including an
  // unsuccessful one. Preserve that failure's reason instead of replacing it
  // with a fabricated exit or a host-kill transport error. Other hosts retain
  // their existing successful-terminal shutdown behavior.
  return failure ? failure.diagnostic.termination === "host_kill"
    : !diagnosticTransport && terminalResult.isError === false;
}

function redactDiagnosticValues(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return safeProcessDiagnosticText(value, secrets);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactDiagnosticValues(entry, secrets)]),
  );
  return value;
}

/** One adapter-owned diagnostic per terminal process, including startup/write failures. */
export function observeRuntimeProcesses(
  host: RuntimeHost,
  secrets: readonly string[],
  onEvent?: (event: Record<string, unknown>) => void,
  onProcessDiagnostic?: (observation: RuntimeProcessObservation) => Promise<void>,
): RuntimeHost {
  let sequence = 0;
  return {
    run: (command, options) => host.run(command, options),
    uploadFile: (content, dest) => host.uploadFile(content, dest),
    readWorkspaceFile: (file, max) => host.readWorkspaceFile(file, max),
    writeHumanInboxFile: (file, bytes) => host.writeHumanInboxFile(file, bytes),
    async runAsync(command, options) {
      const processSequence = ++sequence;
      let publication: Promise<void> | undefined;
      const publish = (diagnostic?: RuntimeProcessDiagnostic, processId?: string, cleanup?: RuntimeCleanupDiagnostic): Promise<void> => {
        if (publication) return publication;
        if (!diagnostic) return Promise.resolve();
        publication = (async () => {
          // The transport already redacts before bounding; repeat exact-value redaction
          // here for custom hosts, without exposing arbitrary Error objects or stacks.
          const event = { type: "runtime.diagnostic", code: "OPENSANDBOX_PTY_TERMINATION",
            process_sequence: processSequence, ...(processId ? { process_id: safeProcessDiagnosticText(processId, secrets, 128) } : {}), ...diagnostic };
          onEvent?.(redactDiagnosticValues(event, secrets) as Record<string, unknown>);
          if (processId && secrets.some(secret => secret && processId.includes(secret))) throw new Error("RUNTIME_PROCESS_ID_INVALID");
          await onProcessDiagnostic?.({ process_sequence: processSequence,
            process_id: processId ?? null,
            diagnostic: redactDiagnosticValues(diagnostic, secrets) as RuntimeProcessDiagnostic, cleanup: cleanup ?? null });
        })();
        return publication;
      };
      let exec: RuntimeProcess;
      try {
        exec = await host.runAsync(command, { ...options, diagnosticSecrets: [...secrets, ...(options?.diagnosticSecrets ?? [])] });
      } catch (error) {
        const failure = runtimeProcessFailure(error);
        await publish(failure?.diagnostic, failure?.processId, failure?.cleanup);
        throw error;
      }
      const terminal = () => publish(exec.getTerminationDiagnostic?.(), exec.id, exec.getCleanupDiagnostic?.());
      return {
        id: exec.id,
        get stdinClosed() { return exec.stdinClosed; },
        ...(exec.getTerminationDiagnostic ? { getTerminationDiagnostic: () => exec.getTerminationDiagnostic!() } : {}),
        ...(exec.getCleanupDiagnostic ? { getCleanupDiagnostic: () => exec.getCleanupDiagnostic!() } : {}),
        async write(data) {
          try { await exec.write(data); }
          catch (error) {
            if (runtimeProcessFailure(error)) await exec.kill("transport_cleanup").catch(() => {});
            await terminal();
            throw error;
          }
        },
        closeStdin: () => exec.closeStdin(),
        async kill(caller) { try { await exec.kill(caller); } finally { await terminal(); } },
        ...(exec.resize ? { resize: (cols: number, rows: number) => exec.resize!(cols, rows) } : {}),
        async *[Symbol.asyncIterator]() {
          try { yield* exec; }
          catch (error) { await exec.kill("transport_cleanup").catch(() => {}); throw error; }
          finally {
            if (exec.getTerminationDiagnostic) await exec.kill("transport_cleanup").catch(() => {});
            await terminal();
          }
        },
      };
    },
  };
}
