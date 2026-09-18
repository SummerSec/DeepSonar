/**
 * Governed language-server adapter (#604).
 *
 * Agents call typed operations only — never free-form JSON-RPC.
 * Bounds: timeouts, call budget, response size, workspace path sandbox.
 * Transport is injectable so unit tests do not need a real clangd binary.
 */
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const LANGUAGE_SERVER_CLANGD_ID = "language-server.clangd";
export const LANGUAGE_SERVER_UNAVAILABLE_CODE = "capability_unavailable";
export const LANGUAGE_SERVER_OPERATIONS = Object.freeze([
  "definition",
  "references",
  "hover",
  "document_symbol",
  "workspace_symbol",
  "diagnostics",
]);

export const DEFAULT_LIMITS = Object.freeze({
  max_calls_per_job: 64,
  timeout_ms: 30_000,
  max_response_bytes: 262_144,
});

const LSP_METHOD = Object.freeze({
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  document_symbol: "textDocument/documentSymbol",
  workspace_symbol: "workspace/symbol",
  diagnostics: "textDocument/diagnostic",
});

function sha256Of(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function assertInsideWorkspace(workspaceRoot, targetPath) {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const err = new Error("path_outside_workspace");
    err.code = "path_outside_workspace";
    throw err;
  }
  return resolved;
}

async function fingerprintCompileCommands(workspaceRoot, compileCommandsPath) {
  if (!compileCommandsPath) return null;
  const resolved = assertInsideWorkspace(workspaceRoot, compileCommandsPath);
  try {
    await access(resolved);
  } catch {
    return null;
  }
  const body = await readFile(resolved, "utf8");
  return sha256Of(body);
}

function truncateResult(value, maxBytes) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false, notes: [] };
  }
  const sliced = encoded.subarray(0, maxBytes).toString("utf8");
  return {
    value: { truncated_json_prefix: sliced, original_bytes: encoded.byteLength },
    truncated: true,
    notes: [`response exceeded max_response_bytes=${maxBytes}`],
  };
}

function unavailableResult(ctx, reason, message) {
  return {
    schema: "deepsonar.language-server-result/v1",
    is_finding: false,
    job_id: ctx.jobId,
    workspace: ctx.workspaceRoot,
    revision: ctx.revision,
    server: ctx.server,
    server_version: ctx.serverVersion,
    capability_id: ctx.capabilityId,
    request_type: ctx.requestType,
    file_ranges: ctx.fileRanges ?? [],
    compile_commands_fingerprint: ctx.compileCommandsFingerprint ?? null,
    truncated: false,
    truncation_notes: [],
    inconclusive: true,
    unavailable_code: LANGUAGE_SERVER_UNAVAILABLE_CODE,
    unavailable_reason: reason,
    evidence_ref: ctx.evidenceRef ?? `lsp://${ctx.capabilityId}/${ctx.requestType}`,
    result: { message },
  };
}

/**
 * @typedef {object} LspTransport
 * @property {(method: string, params: unknown, timeoutMs: number) => Promise<unknown>} request
 */

/**
 * Create a bounded clangd adapter session.
 */
export function createLanguageServerAdapter(options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const workspaceRoot = path.resolve(options.workspaceRoot ?? "/workspace");
  const jobId = options.jobId ?? "job-unknown";
  const revision = options.revision ?? "unknown";
  const server = options.server ?? "clangd";
  const serverVersion = options.serverVersion ?? "image-pinned";
  const capabilityId = options.capabilityId ?? LANGUAGE_SERVER_CLANGD_ID;
  const transport = options.transport;
  let calls = 0;

  async function run(operation, params = {}) {
    if (!LANGUAGE_SERVER_OPERATIONS.includes(operation)) {
      return unavailableResult(
        { jobId, workspaceRoot, revision, server, serverVersion, capabilityId, requestType: operation },
        "unregistered",
        `unsupported operation: ${operation}`,
      );
    }

    if (calls >= limits.max_calls_per_job) {
      return unavailableResult(
        { jobId, workspaceRoot, revision, server, serverVersion, capabilityId, requestType: operation },
        "budget_exceeded",
        `max_calls_per_job=${limits.max_calls_per_job} exhausted`,
      );
    }
    calls += 1;

    const compileCommandsPath = params.compile_commands_path ?? params.compileCommandsPath ?? "compile_commands.json";
    let compileCommandsFingerprint = null;
    try {
      compileCommandsFingerprint = await fingerprintCompileCommands(workspaceRoot, compileCommandsPath);
    } catch (error) {
      if (error?.code === "path_outside_workspace") {
        return unavailableResult(
          { jobId, workspaceRoot, revision, server, serverVersion, capabilityId, requestType: operation },
          "path_outside_workspace",
          "compile_commands path escapes workspace",
        );
      }
      throw error;
    }
    if (!compileCommandsFingerprint) {
      return unavailableResult(
        { jobId, workspaceRoot, revision, server, serverVersion, capabilityId, requestType: operation },
        "missing_precondition",
        "compile_commands.json missing or unreadable",
      );
    }

    let fileRanges = [];
    if (params.path) {
      try {
        const resolved = assertInsideWorkspace(workspaceRoot, params.path);
        const relative = path.relative(workspaceRoot, resolved);
        fileRanges = [{
          path: relative,
          start_line: Number(params.line ?? 0),
          start_character: Number(params.character ?? 0),
          end_line: Number(params.line ?? 0),
          end_character: Number(params.character ?? 0),
        }];
      } catch (error) {
        if (error?.code === "path_outside_workspace") {
          return unavailableResult(
            { jobId, workspaceRoot, revision, server, serverVersion, capabilityId, requestType: operation },
            "path_outside_workspace",
            "query path escapes workspace",
          );
        }
        throw error;
      }
    }

    if (!transport || typeof transport.request !== "function") {
      return unavailableResult(
        {
          jobId, workspaceRoot, revision, server, serverVersion, capabilityId,
          requestType: operation, fileRanges, compileCommandsFingerprint,
        },
        "missing_precondition",
        "language-server transport is not available in this environment",
      );
    }

    const method = LSP_METHOD[operation];
    const lspParams = operation === "workspace_symbol"
      ? { query: params.query ?? "" }
      : {
          textDocument: { uri: `file://${path.resolve(workspaceRoot, params.path ?? ".")}` },
          position: { line: Number(params.line ?? 0), character: Number(params.character ?? 0) },
          ...(operation === "references" ? { context: { includeDeclaration: true } } : {}),
        };

    let raw;
    try {
      raw = await Promise.race([
        transport.request(method, lspParams, limits.timeout_ms),
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            const err = new Error("timeout");
            err.code = "timeout";
            reject(err);
          }, limits.timeout_ms);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } catch (error) {
      const reason = error?.code === "timeout" ? "timeout" : "missing_precondition";
      return unavailableResult(
        {
          jobId, workspaceRoot, revision, server, serverVersion, capabilityId,
          requestType: operation, fileRanges, compileCommandsFingerprint,
        },
        reason,
        error instanceof Error ? error.message : String(error),
      );
    }

    const trimmed = truncateResult(raw, limits.max_response_bytes);
    return {
      schema: "deepsonar.language-server-result/v1",
      is_finding: false,
      job_id: jobId,
      workspace: workspaceRoot,
      revision,
      server,
      server_version: serverVersion,
      capability_id: capabilityId,
      request_type: operation,
      file_ranges: fileRanges,
      compile_commands_fingerprint: compileCommandsFingerprint,
      truncated: trimmed.truncated,
      truncation_notes: trimmed.notes,
      inconclusive: false,
      unavailable_code: null,
      unavailable_reason: null,
      evidence_ref: `lsp://${capabilityId}/${operation}/${sha256Of(JSON.stringify(trimmed.value)).slice(7, 23)}`,
      result: trimmed.value,
    };
  }

  return {
    limits,
    calls: () => calls,
    run,
  };
}

/** Convenience: mock transport for offline tests. */
export function createMockLspTransport(handler) {
  return {
    async request(method, params) {
      return handler(method, params);
    },
  };
}
