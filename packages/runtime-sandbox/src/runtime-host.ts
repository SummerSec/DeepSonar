/**
 * Provider-neutral runtime substrate (#162 Phase 1).
 *
 * CLI adapters, runRealAgent, session archive and human inbox may only depend
 * on these types. Provider SDKs stay inside their own adapter modules.
 */

export type RuntimeProcessChunk =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; exitCode: number };

export interface RuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RuntimeAsyncRunOptions extends RuntimeRunOptions {
  pty?: boolean;
}

export interface RuntimeProcess extends AsyncIterable<RuntimeProcessChunk> {
  readonly id?: string;
  write(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  kill(): Promise<void>;
  readonly stdinClosed: boolean;
  resize?(cols: number, rows: number): Promise<void>;
}

export interface RuntimeHost {
  run(command: string, options?: RuntimeRunOptions): Promise<RuntimeCommandResult>;
  runAsync(command: string, options?: RuntimeAsyncRunOptions): Promise<RuntimeProcess>;
  uploadFile(content: string | Buffer, destPath: string): Promise<void>;
  readWorkspaceFile(filePath: string, maxBytes: number): Promise<Buffer>;
  writeHumanInboxFile(filePath: string, bytes: Buffer): Promise<void>;
}

export interface RuntimeResource {
  resourceId: string;
  jobId: string;
  attemptId: string;
  state?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function assertWorkspaceWritePath(filePath: string): string {
  const normalized = filePath.startsWith("/")
    ? filePath.replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/")
    : filePath;
  if (
    !normalized.startsWith("/workspace/") ||
    normalized !== filePath ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`拒绝写入 workspace 之外的动态文件: ${filePath}`);
  }
  return normalized;
}
