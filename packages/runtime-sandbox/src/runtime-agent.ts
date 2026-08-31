/**
 * Provider-neutral Agent execution. Scheduler and OpenSandbox hosts
 * call runRealAgent(host, spec).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { CLI_SESSION_ADAPTERS, type SessionBundle } from "./cli-session-adapters.js";
import { assertContextResume, type ContextIdentity } from "./context-contract.js";
import type {
  AgentCommandConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
} from "./runtime-agent-config.js";
import {
  applyRuntimeOutput,
  parsePiJsonlRecord,
  PiJsonlFramer,
  requireAgentCliRuntimeAdapter,
  type AgentCliRuntimeSnapshot,
  type DshProviderRuntimeConfig,
} from "./runtime-adapters.js";
import { assertWorkspaceWritePath, shellQuote, type RuntimeHost } from "./runtime-host.js";
import { createStdinCloseKiller } from "./runtime-stdin-close.js";


export type ReasoningEffort = string;
export { createStdinCloseKiller, DEFAULT_STDIN_CLOSE_KILL_MS } from "./runtime-stdin-close.js";

export interface RealAgentSpec {
  provider: "claude-code" | "open-code" | "codex" | "dsh" | "pi";
  adapter?: AgentCliRuntimeSnapshot;
  runtimeImageKey?: string;
  /** 模型 ID（如 claude-sonnet-4-5、gpt-5） */
  model?: string;
  /** 思考/推理强度；缺省由 provider 默认 */
  reasoning?: ReasoningEffort;
  /** Frozen llm-pi-ai provider route and profile for DSH. */
  dshProvider?: DshProviderRuntimeConfig;
  /** DSH tool presentation preset; ignored by other providers. */
  dshTaskMode?: "standard" | "ptc";
  env: Record<string, string>;
  /** Hub 为本 Job 生成的本轮任务消息，等价于各 CLI 的非交互 prompt/input。 */
  input: string;
  /** 平台不可变安全边界；与 /workspace 下的角色说明文件分层。 */
  systemPrompt?: string;
  /** Agent 配置下发（CLI 本地组件文件，内容来自冻结 RoleConfig） */
  skills?: AgentSkillConfig[];
  commands?: AgentCommandConfig[];
  mcps?: AgentMcpConfig[];
  subAgents?: AgentSubAgentConfig[];
  /** Pi 仅显式加载由 Scheduler 冻结的 Extension，项目 .pi 不参与自动发现。 */
  piExtensions?: readonly string[];
  /** 本 Job 动态工作区：指令文件、Provider 配置等；只允许 /workspace 下的绝对路径。 */
  workspaceFiles?: Record<string, string>;
  /** 运行后要读回的文件 */
  resultFiles?: string[];
  /** 控制 MCP 工具名到宿主语义事件类型的映射。 */
  semanticToolEvents?: Record<string, string>;
  /** 每条完整语义事件到达时串行调用。 */
  onSemanticEvent?: (
    event: Record<string, unknown>,
    control: { readWorkspaceFile(filePath: string, maxBytes: number): Promise<Buffer> },
  ) => void | Promise<void>;
  /**
   * Run 建立后注册外部增量消息源；消息经 stdin stream-json 注入同一会话。
   * `readWorkspaceFile` 复用语义事件的安全读取边界，供 Job-scoped API
   * handler 处理 payload_file；它不会暴露宿主文件系统。
   */
  onRunReady?: (control: {
    sendMessage(content: string): Promise<void>;
    readWorkspaceFile(filePath: string, maxBytes: number): Promise<Buffer>;
    /** Scheduler-only binary write into the immutable human-message inbox. */
    writeWorkspaceFile(filePath: string, bytes: Buffer): Promise<void>;
  }) =>
    void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  /**
   * 完成门禁：result 事件到达时调用。返回 false 表示协议要求的语义事件（如
   * mark_job_done）还没齐，驱动层会用 nudgeMessage 催促同一会话继续，最多 3 次。
   */
  completionGate?: () => boolean;
  /** 门禁未过时的催促消息（executor 按角色协议给出） */
  nudgeMessage?: string;
  /** 流式进度回调（已节流） */
  onProgress?: (message: string) => void;
  /** 全量规范化事件回调（text.delta / tool.call.* / run.* 等，未节流，供实时流转发） */
  onEvent?: (event: Record<string, unknown>) => void;
  /** 上下文压缩摘要；不得携带原始 prompt 或 provider 原文。可返回更新后的身份。 */
  onContextEvent?: (event: Record<string, unknown>) => void | ContextIdentity | Promise<void | ContextIdentity>;
  /** 恢复前由调度器冻结的上下文身份。 */
  contextIdentity?: ContextIdentity;
  /** 恢复前查询适配器实际身份；返回不一致或缺失时 fail closed。 */
  getResumeContextIdentity?: (input: {
    sessionId: string;
    sessionFile?: string;
  }) => ContextIdentity | Promise<ContextIdentity>;
  /** 首次观察到稳定会话身份时持久化；同一运行内身份变化会失败关闭。 */
  onSessionIdentity?: (input: { sessionId: string; sessionFile?: string }) => void | Promise<void>;
  /** telemetry/evidence/session 输出前必须精确脱敏的短期密钥。 */
  secretValues?: readonly string[];
  /** 非语义运行流告警；告警不会进入控制事件或写库。 */
  onWarning?: (warning: { code: string; detail?: string }) => void;
  /**
   * closeStdin("terminal_result") 后若 CLI 仍驻留等 stdin，有界等待再 kill。
   * 仅测试注入短超时；默认约 8s。initial_input 不会触发。
   */
  stdinCloseKillMs?: number;
}

export interface RealAgentResult {
  text: string;
  files: Record<string, string>;
  /** CLI 原始 Session；由 provider 专属 Adapter 在沙箱销毁前读回。 */
  session?: SessionBundle;
  sessionFile?: string;
  error?: string;
  /** 区分宿主语义校验失败关闭与 Provider/CLI 运行失败。 */
  errorKind?: "semantic" | "runner";
  /** 最后一次 CLI 终态尝试；旧 runner 错误跨重试残留时仍以此为准。 */
  terminalOutcome?: "success" | "failure";
  /** Scheduler 管理的语义失败详情；不携带任意 Error 字段。 */
  errorDetails?: RuntimeErrorDetails;
}

export interface RuntimeErrorDetails {
  code: "event_rate_limited";
  metadata?: {
    bucket?: "progress" | "standard" | "terminal";
    retry_after_sec?: number;
    limit?: number;
    window_seconds?: number;
  };
}

export type ObservedSessionIdentity = { sessionId: string; sessionFile?: string };

export function mergeObservedSessionIdentity(
  current: ObservedSessionIdentity | undefined,
  observed: { sessionId?: string; sessionFile?: string },
): ObservedSessionIdentity | undefined {
  const observedSessionId = observed.sessionId?.trim();
  const observedSessionFile = observed.sessionFile?.trim();
  if (!current) {
    if (!observedSessionId) return undefined;
    return { sessionId: observedSessionId, ...(observedSessionFile ? { sessionFile: observedSessionFile } : {}) };
  }
  if (observedSessionId && observedSessionId !== current.sessionId) throw new Error("CONTEXT_SESSION_IDENTITY_CHANGED");
  if (current.sessionFile && observedSessionFile && observedSessionFile !== current.sessionFile) {
    throw new Error("CONTEXT_SESSION_FILE_CHANGED");
  }
  return current.sessionFile || !observedSessionFile ? current : { ...current, sessionFile: observedSessionFile };
}

const RATE_LIMIT_BUCKETS = new Set(["progress", "standard", "terminal"]);

function boundedRateLimitNumber(value: unknown, max: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max
    ? value as number
    : undefined;
}

/**
 * 语义回调跨越通用沙箱结果边界时，只保留 Scheduler 管理的限流码和有界元数据；
 * 丢弃错误栈、任意属性和携带 payload 的元数据。
 */
export function normalizeRuntimeErrorDetails(error: unknown): RuntimeErrorDetails | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; metadata?: unknown };
  if (candidate.code !== "event_rate_limited") return undefined;
  const metadata = candidate.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { code: "event_rate_limited" };
  }
  const source = metadata as Record<string, unknown>;
  const normalized: NonNullable<RuntimeErrorDetails["metadata"]> = {};
  if (typeof source.bucket === "string" && RATE_LIMIT_BUCKETS.has(source.bucket)) {
    normalized.bucket = source.bucket as "progress" | "standard" | "terminal";
  }
  const retryAfter = boundedRateLimitNumber(source.retry_after_sec, 3600);
  if (retryAfter !== undefined) normalized.retry_after_sec = retryAfter;
  const limit = boundedRateLimitNumber(source.limit, 10000);
  if (limit !== undefined) normalized.limit = limit;
  const windowSeconds = boundedRateLimitNumber(source.window_seconds, 3600);
  if (windowSeconds !== undefined) normalized.window_seconds = windowSeconds;
  return Object.keys(normalized).length > 0
    ? { code: "event_rate_limited", metadata: normalized }
    : { code: "event_rate_limited" };
}

/**
 * Resolve the error represented by one terminal CLI result. Completion-gate
 * retries replace this value, so a later successful result clears an earlier
 * transient Provider error and a final failed result remains authoritative.
 */
export function resolveTerminalRunError(
  outcome: { isError?: boolean; errorDetail?: string },
): string | undefined {
  return outcome.isError ? outcome.errorDetail ?? "agent 执行失败" : undefined;
}

/** CLI 同会话恢复只允许有限、明确的上游瞬态错误。 */
export const CLI_SESSION_RESUME_MAX_ATTEMPTS = 3;
export const CLI_SESSION_RESUME_BASE_DELAY_MS = 1_000;
export const CLI_SESSION_RESUME_MAX_DELAY_MS = 4_000;

export type CliSessionResumeReason = "http" | "timeout" | "network";

const HTTP_PERMANENT_STATUS_RE = /\b(?:400\s+bad\s+request|401\s+unauthorized|403\s+forbidden)\b/iu;
const HTTP_TRANSIENT_STATUS_RE = /\b(?:408\s+request\s+timeout|429\s+too\s+many\s+requests|500\s+internal\s+server\s+error|502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout)\b/iu;
const HTTP_CONTEXT_STATUS_RE = (statuses: string): RegExp => new RegExp(
  `\\b(?:http(?:\\/\\d(?:\\.\\d)?)?|status(?:[_ -]?code)?|upstream|gateway|provider|api|response|error)\\b[^\\d]{0,32}\\b(?:${statuses})\\b`,
  "iu",
);

function runtimeErrorText(error: unknown, depth = 0): string {
  if (depth > 2 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    return [
      record.name,
      record.message,
      record.code,
      record.status,
      record.statusCode,
      runtimeErrorText(record.cause, depth + 1),
    ].filter((value) => value !== undefined && value !== null).join(" ");
  }
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [
    record.name,
    record.message,
    record.code,
    record.status,
    record.statusCode,
    record.error,
    record.cause && runtimeErrorText(record.cause, depth + 1),
  ].filter((value) => value !== undefined && value !== null).join(" ");
}

/**
 * 判断一次 CLI 退出是否可以在原 Session 上继续。永久 HTTP 状态优先，
 * 防止一条错误文本同时包含网络/超时字样时误进入恢复路径。
 */
export function classifyCliSessionResumeError(error: unknown): CliSessionResumeReason | undefined {
  const text = runtimeErrorText(error);
  if (!text) return undefined;
  const status = error && typeof error === "object"
    ? (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { status?: unknown; statusCode?: unknown }).statusCode
    : undefined;
  const numericStatus = typeof status === "number"
    ? status
    : typeof status === "string" && /^\d{3}$/u.test(status)
      ? Number(status)
      : undefined;
  if (numericStatus === 400 || numericStatus === 401 || numericStatus === 403 || HTTP_PERMANENT_STATUS_RE.test(text) ||
    HTTP_CONTEXT_STATUS_RE("400|401|403").test(text)) {
    return undefined;
  }
  if ([408, 429, 500, 502, 503, 504].includes(numericStatus ?? -1) ||
    HTTP_TRANSIENT_STATUS_RE.test(text) || HTTP_CONTEXT_STATUS_RE("408|429|500|502|503|504").test(text)) {
    return "http";
  }
  if (
    /\b(?:timeout|timed[ -]?out|ETIMEDOUT|TimeoutError)\b|超时/iu.test(text) ||
    (/\bAbortError\b/iu.test(text) && /\b(?:timeout|timed[ -]?out|deadline|aborted\s+by\s+(?:a\s+)?timeout)\b/iu.test(text))
  ) {
    return "timeout";
  }
  if (
    /\b(?:network(?:\s+(?:error|failure|unavailable|unreachable|connection|request))?|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket\s+hang\s*up|connection\s+(?:reset|refused|closed|aborted|lost)|fetch\s+failed|unable\s+to\s+connect|could\s+not\s+resolve\s+host|upstream\s+(?:unreachable|unavailable)|gateway\s+unavailable)\b|上游(?:不可达|不可用)|网络(?:错误|异常|不可达|连接)/iu.test(text)
  ) {
    return "network";
  }
  return undefined;
}

/** 计算第 N 次同会话恢复前的固定指数退避（1s、2s、4s）。 */
export function cliSessionResumeDelayMs(attempt: number): number {
  const normalizedAttempt = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
  const exponent = Math.max(0, Math.min(2, normalizedAttempt - 1));
  return Math.min(CLI_SESSION_RESUME_MAX_DELAY_MS, CLI_SESSION_RESUME_BASE_DELAY_MS * 2 ** exponent);
}

async function waitForCliSessionResume(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, cliSessionResumeDelayMs(attempt)));
}

export type TerminalAttemptCloseReason = "initial_input" | "terminal_result";

export interface TerminalProcessAttempt {
  /** Diagnostic text from this process; never used to infer success. */
  finalText?: string;
  exitCode?: number;
  terminalResult?: { isError?: boolean; errorDetail?: string };
  closeReason?: TerminalAttemptCloseReason;
  stderrTail?: string;
}

export interface TerminalProcessOutcome {
  /** Whether this attempt produced an authoritative terminal observation. */
  observed: boolean;
  error?: string;
  terminalOutcome?: "success" | "failure";
}

/**
 * Resolve one CLI process attempt without consulting text from an earlier
 * attempt.  A terminal success followed by the intentional stdin close is a
 * valid completion even if the SDK reports a non-zero close code; a later
 * process exit without a terminal result is always a runner failure.
 */
export function resolveTerminalProcessOutcome(
  input: TerminalProcessAttempt,
): TerminalProcessOutcome {
  const exitCode = input.exitCode ?? 0;
  const terminalResult = input.terminalResult;
  const stderr = input.stderrTail?.trim();
  const exitError = `agent CLI 退出码 ${exitCode}${stderr ? `: ${stderr.slice(-300)}` : ""}`;
  if (terminalResult) {
    if (terminalResult.isError) {
      return {
        observed: true,
        error: resolveTerminalRunError(terminalResult),
        terminalOutcome: "failure",
      };
    }
    if (exitCode !== 0 && input.closeReason !== "terminal_result") {
      return { observed: true, error: exitError, terminalOutcome: "failure" };
    }
    return { observed: true, terminalOutcome: "success" };
  }
  if (exitCode !== 0) {
    return { observed: true, error: exitError, terminalOutcome: "failure" };
  }
  return {
    observed: true,
    error: `agent CLI exited without a structured terminal result${stderr ? `: ${stderr.slice(-300)}` : ""}`,
    terminalOutcome: "failure",
  };
}

const PLAIN_FINAL_MAX_BYTES = 1024 * 1024;

export interface PlainFinalOutputResult {
  text: string;
  stderr: string;
  events: Array<Record<string, unknown>>;
  error?: string;
  terminalOutcome?: "success" | "failure";
}

export interface PlainFinalOutputOptions {
  adapterId?: string;
  completionGate?: boolean;
}

/** Normalize a one-shot CLI's plain stdout without interpreting prose as control events. */
export function normalizePlainFinalOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  _onSemanticEvent?: (event: Record<string, unknown>) => void,
  options: PlainFinalOutputOptions = {},
): PlainFinalOutputResult {
  if (Buffer.byteLength(stdout, "utf8") > PLAIN_FINAL_MAX_BYTES) {
    throw new Error("AGENT_CLI_PLAIN_OUTPUT_TOO_LARGE");
  }
  const text = stdout.trim();
  const adapterId = options.adapterId ?? "dsh";
  const error = exitCode !== 0
    ? (stderr.trim() || `agent CLI exited with code ${exitCode}`)
    : !text
      ? `AGENT_CLI_PLAIN_OUTPUT_EMPTY: ${adapterId}`
      : options.completionGate === false
        ? `AGENT_CLI_COMPLETION_GATE_UNSATISFIED: ${adapterId}`
        : undefined;
  const events = !error
    ? [
        { type: "run.started" },
        { type: "run.completed", text },
        { type: "run.settled" },
      ]
    : [
        { type: "run.started" },
        { type: "run.failed", error },
      ];
  return {
    text,
    stderr,
    events,
    ...(error ? { error, terminalOutcome: "failure" as const } : { terminalOutcome: "success" as const }),
  };
}

/**
 * 读沙箱内文本文件。SDK 的 downloadFile 直接返回 docker getArchive 的原始 tar 字节
 * （首行是 tar 头里的文件名），不能当文件内容用；这里走 exec cat。
 * 文件不存在返回 null（调用方区分「尚未创建」与「读失败」）。
 */
async function readSandboxFileText(host: Pick<RuntimeHost, "run">, filePath: string): Promise<string | null> {
  const q = `'${filePath.replace(/'/g, `'\\''`)}'`;
  const res = await host.run(`if [ -f ${q} ]; then cat ${q}; else exit 44; fi`, { timeoutMs: 15000 });
  if (res.exitCode === 44) return null;
  if (res.exitCode !== 0) {
    throw new Error(`读取沙箱文件失败(exit=${res.exitCode}): ${res.stderr.slice(0, 200)}`);
  }
  return res.stdout;
}
const RUNTIME_DIR = "/workspace/.deepsonar";
const RUNTIME_HOME = "/workspace/.deepsonar-home";
const CLAUDE_DIR = `${RUNTIME_HOME}/.claude`;

/** 系统拥有的可写 CLI 环境；不依赖镜像继承的 HOME（非 root 镜像常仍错误指向 /root）。 */
export function runtimeCliEnv(env: Record<string, string>): Record<string, string> {
  const { CLAUDE_CONFIG_DIR: _ignoredClaudeConfigDir, ...rest } = env;
  return {
    ...rest,
    HOME: RUNTIME_HOME,
  };
}

export async function ensureRuntimeHome(host: Pick<RuntimeHost, "run">): Promise<void> {
  let result: { exitCode: number };
  try {
    result = await host.run(
      `mkdir -p -- ${shellQuote(RUNTIME_HOME)} && test -d ${shellQuote(RUNTIME_HOME)} && test -w ${shellQuote(RUNTIME_HOME)}`,
      { timeoutMs: 15_000 },
    );
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`runtime_directory_not_writable: ${RUNTIME_HOME}${detail}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`runtime_directory_not_writable: ${RUNTIME_HOME}`);
  }
}

/** claude CLI --mcp-config 格式（与 SDK buildClaudeMcpConfig 等价） */
function buildMcpConfigJson(mcps: AgentMcpConfig[]): string {
  const mcpServers = Object.fromEntries(
    mcps.filter((m) => (m as { enabled?: boolean }).enabled !== false).map((m) => {
      if (m.type === "remote") {
        return [m.name, { type: "http", url: m.url, ...(m.headers ? { headers: m.headers } : {}) }];
      }
      return [
        m.name,
        {
          type: "stdio",
          command: m.command,
          ...(m.args?.length ? { args: m.args } : {}),
          ...(m.env ? { env: m.env } : {}),
        },
      ];
    }),
  );
  return JSON.stringify({ mcpServers }, null, 2);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function safeComponentName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`拒绝 ${label}：名称不能为空`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`拒绝 ${label}：名称含 NUL/control 字符`);
  }
  const slashed = value.replaceAll("\\", "/");
  if (
    slashed.startsWith("/") ||
    path.posix.isAbsolute(slashed) ||
    /^[A-Za-z]:/.test(slashed)
  ) {
    throw new Error(`拒绝 ${label}：名称不能是绝对路径`);
  }
  if (slashed.includes("/")) {
    throw new Error(`拒绝 ${label}：名称不能包含路径分隔符`);
  }
  if (slashed === "." || slashed === "..") {
    throw new Error(`拒绝 ${label}：名称不能是 . 或 ..`);
  }
  return slashed;
}

function safeRelativeSkillFile(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`拒绝 ${label}：文件路径不能为空`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`拒绝 ${label}：文件路径含 NUL/control 字符`);
  }
  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) {
    throw new Error(`拒绝 ${label}：文件路径不能是绝对路径`);
  }
  const segments = slashed.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`拒绝 ${label}：文件路径不得包含 ..`);
  }
  if (slashed.endsWith("/")) {
    throw new Error(`拒绝 ${label}：文件路径不能指向目录`);
  }
  const normalized = path.posix.normalize(slashed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`拒绝 ${label}：文件路径归一化后越界`);
  }
  return normalized;
}

function strictChildPath(parent: string, child: string, label: string): string {
  const root = path.posix.resolve(parent);
  const resolved = path.posix.resolve(child);
  if (resolved === root || !resolved.startsWith(`${root}/`)) {
    throw new Error(`拒绝 ${label}：归一化后不在 ${root} 子树内`);
  }
  return resolved;
}

function commandMaterializationPath(name: unknown): string {
  const safeName = safeComponentName(name, "command.name");
  return strictChildPath(
    `${CLAUDE_DIR}/commands`,
    path.posix.join(`${CLAUDE_DIR}/commands`, `${safeName}.md`),
    "command.name",
  );
}

function subAgentMaterializationPath(name: unknown): string {
  const safeName = safeComponentName(name, "subAgent.name");
  return strictChildPath(
    `${CLAUDE_DIR}/agents`,
    path.posix.join(`${CLAUDE_DIR}/agents`, `${safeName}.md`),
    "subAgent.name",
  );
}

export function skillMaterializationPath(
  name: unknown,
  rel: unknown,
  provider: RealAgentSpec["provider"] = "claude-code",
): string {
  const safeName = safeComponentName(name, "embedded skill.name");
  const skillsRoot = provider === "codex"
    ? `${RUNTIME_HOME}/.codex/skills`
    : provider === "open-code"
      ? `${RUNTIME_HOME}/.config/opencode/skills`
      : provider === "dsh"
        ? `${RUNTIME_HOME}/.dsh/skills`
      : provider === "pi"
        ? `${RUNTIME_HOME}/.pi/agent/skills`
      : `${CLAUDE_DIR}/skills`;
  const root = strictChildPath(
    skillsRoot,
    path.posix.join(skillsRoot, safeName),
    "embedded skill.name",
  );
  const safeRel = safeRelativeSkillFile(rel, "embedded skill file");
  return strictChildPath(root, path.posix.join(root, safeRel), "embedded skill file");
}

function materializationPaths(
  spec: Pick<RealAgentSpec, "commands" | "subAgents" | "skills"> &
    Partial<Pick<RealAgentSpec, "provider">>,
): string[] {
  const provider = spec.provider ?? "claude-code";
  const paths: string[] = [];
  for (const command of spec.commands ?? []) {
    paths.push(commandMaterializationPath(command.name));
  }
  for (const sub of spec.subAgents ?? []) {
    paths.push(subAgentMaterializationPath(sub.name));
  }
  for (const skill of spec.skills ?? []) {
    const safeName = safeComponentName(skill.name, "skill.name");
    if (!("files" in skill)) continue; // repo skill is installed by the CLI below
    if (!skill.files || typeof skill.files !== "object" || Array.isArray(skill.files)) {
      throw new Error(`拒绝 embedded skill ${safeName}：files 必须是对象`);
    }
    for (const rel of Object.keys(skill.files)) {
      paths.push(skillMaterializationPath(safeName, rel, provider));
    }
  }
  return paths;
}

function duplicatePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const collisions = new Set<string>();
  for (const target of paths) {
    if (seen.has(target)) collisions.add(target);
    seen.add(target);
  }
  return [...collisions].sort();
}

/** Return duplicate normalized local component paths before any upload happens. */
export function materializationPathCollisions(
  spec: Pick<RealAgentSpec, "commands" | "subAgents" | "skills"> &
    Partial<Pick<RealAgentSpec, "provider">>,
): string[] {
  return duplicatePaths(materializationPaths(spec));
}

/**
 * claude CLI 的本地组件文件（替代 SDK daemon setup 的产物上传）：
 * commands → .claude/commands/<name>.md；subAgents → .claude/agents/<name>.md；
 * embedded skills → 当前 CLI 的标准 skills 目录（Claude `.claude/skills`、
 * Codex `.codex/skills`、OpenCode `.config/opencode/skills`、Pi `.pi/agent/skills`）；repo skills 需出网安装，尽力而为。
 */
async function materializeAgentFiles(
  host: Pick<RuntimeHost, "run" | "uploadFile">,
  spec: RealAgentSpec,
  cliEnv: Record<string, string>,
): Promise<void> {
  // Validate every component and normalize every target before the first mkdir
  // or upload. A malformed later component therefore cannot cause partial writes.
  const paths = materializationPaths(spec);
  const collisions = duplicatePaths(paths);
  if (collisions.length > 0) {
    throw new Error(`拒绝 materialize 组件路径冲突（不会执行覆盖写入）: ${collisions.join(", ")}`);
  }
  const writes: Array<[string, string]> = [];
  const provider = spec.provider;
  for (const command of spec.commands ?? []) {
    const frontmatter = command.description ? `---\ndescription: ${yamlScalar(command.description)}\n---\n\n` : "";
    writes.push([commandMaterializationPath(command.name), frontmatter + command.template]);
  }
  for (const sub of spec.subAgents ?? []) {
    const lines = [
      `name: ${yamlScalar(sub.name)}`,
      `description: ${yamlScalar(sub.description)}`,
      ...(sub.model ? [`model: ${yamlScalar(sub.model)}`] : []),
      ...(sub.tools?.length ? [`tools: ${sub.tools.join(", ")}`] : []),
    ];
    writes.push([subAgentMaterializationPath(sub.name), `---\n${lines.join("\n")}\n---\n\n${sub.instructions.trim()}\n`]);
  }
  for (const skill of spec.skills ?? []) {
    if (!("files" in skill) || !skill.files) continue; // repo skill 走下方安装命令
    for (const [rel, content] of Object.entries(skill.files)) {
      writes.push([skillMaterializationPath(skill.name, rel, provider), content]);
    }
  }
  for (const [filePath, content] of writes) {
    const dir = path.posix.dirname(filePath);
    await host.run(`mkdir -p -- ${shellQuote(dir)}`);
    await host.uploadFile(content, filePath);
  }
  // repo 形式 skill：需要出网，失败只告警不阻断
  for (const skill of spec.skills ?? []) {
    if ("files" in skill || !skill.repo) continue;
    const skillAgent = provider === "open-code" ? "opencode" : provider === "claude-code" ? "claude-code" : provider;
    const res = await host.run(
      `npx -y skills add ${shellQuote(skill.repo)} -g --skill ${shellQuote(skill.name)} --agent ${shellQuote(skillAgent)} -y`,
      { timeoutMs: 120_000, env: cliEnv },
    ).catch(() => null);
    if (!res || res.exitCode !== 0) console.warn(`[real-agent] repo skill 安装失败: ${skill.name}`);
  }
}

/** claude stream-json 一行 → 规范化事件（保持 executor/前端既有形状） */
export const DEFAULT_SEMANTIC_TOOL_EVENTS: Record<string, string> = {
  "mcp__deepsonar-control__emit_progress": "progress",
  "mcp__deepsonar-control__emit_fact": "fact",
  "mcp__deepsonar-control__emit_finding": "finding",
  "mcp__deepsonar-control__submit_hub_decision": "hub_decision",
  "mcp__deepsonar-control__mark_job_done": "done",
  "mcp__deepsonar-control__request_human": "human",
};

export const DEFAULT_PENDING_CONTROL_TOOL_LIMIT = 128;
const SETTLED_CONTROL_TOOL_LIMIT = 4096;

type PendingSemanticTool = {
  toolName: string;
  event: Record<string, unknown>;
};

type PartialAssistantMessage = {
  text: string;
  reasoning: string;
};

type ObservedToolKind = "control" | "other";

/** Stream-local state for two-phase control tool delivery. */
export interface SemanticToolState {
  /** Successful call ids only; failed calls are never released as events. */
  seenToolUseIds: Set<string>;
  /** Calls that received a result (success or error), preventing replay. */
  settledToolUseIds: Set<string>;
  /** Assistant control calls awaiting their matching user tool_result. */
  pendingToolUses: Map<string, PendingSemanticTool>;
  /** Bounded raw ids for control calls, which are length-validated before storage. */
  observedToolUses: Map<string, ObservedToolKind>;
  /** Hash-only tracking for ordinary tool calls; raw ids remain telemetry-compatible. */
  observedNonControlToolUseHashes: Set<string>;
  /** Bounded tool names for ordinary tool completion normalization. */
  observedNonControlToolUseNames: Map<string, string>;
  /** Hash-only settled ids for ordinary tool calls, preventing replay without raw-id retention. */
  settledNonControlToolUseHashes: Set<string>;
  /** Claude stream-json partial content used to suppress its later full block. */
  partialAssistantMessages: Map<string, PartialAssistantMessage>;
  currentPartialAssistantMessage?: string;
  nextPartialAssistantMessage: number;
  maxPendingToolUses: number;
}

export function createSemanticToolState(
  maxPendingToolUses = DEFAULT_PENDING_CONTROL_TOOL_LIMIT,
): SemanticToolState {
  return {
    seenToolUseIds: new Set(),
    settledToolUseIds: new Set(),
    pendingToolUses: new Map(),
    observedToolUses: new Map(),
    observedNonControlToolUseHashes: new Set(),
    observedNonControlToolUseNames: new Map(),
    settledNonControlToolUseHashes: new Set(),
    partialAssistantMessages: new Map(),
    nextPartialAssistantMessage: 0,
    maxPendingToolUses,
  };
}

/** Drop unresolved control calls at run end without exposing their payloads. */
export function discardPendingSemanticTools(
  state: SemanticToolState,
  onWarning?: (warning: { code: string; detail?: string }) => void,
): void {
  if (state.pendingToolUses.size === 0) {
    state.observedToolUses.clear();
    state.observedNonControlToolUseHashes.clear();
    state.observedNonControlToolUseNames.clear();
    state.settledNonControlToolUseHashes.clear();
    state.partialAssistantMessages.clear();
    state.currentPartialAssistantMessage = undefined;
    return;
  }
  onWarning?.({
    code: "control_tool_pending_discarded",
    detail: `pending_count=${state.pendingToolUses.size}`,
  });
  state.pendingToolUses.clear();
  state.observedToolUses.clear();
  state.observedNonControlToolUseHashes.clear();
  state.observedNonControlToolUseNames.clear();
  state.settledNonControlToolUseHashes.clear();
  state.partialAssistantMessages.clear();
  state.currentPartialAssistantMessage = undefined;
}

function rememberToolId(set: Set<string>, callId: string): void {
  set.add(callId);
  if (set.size <= SETTLED_CONTROL_TOOL_LIMIT) return;
  const oldest = set.values().next().value;
  if (typeof oldest === "string") set.delete(oldest);
}

function rememberObservedToolUse(state: SemanticToolState, callId: string, kind: ObservedToolKind): void {
  state.observedToolUses.set(callId, kind);
  if (state.observedToolUses.size <= SETTLED_CONTROL_TOOL_LIMIT) return;
  const oldest = state.observedToolUses.keys().next().value;
  if (typeof oldest === "string") state.observedToolUses.delete(oldest);
}

function telemetryToolHash(callId: string): string {
  return createHash("sha256").update(`deepsonar-tool-telemetry:${callId}`).digest("hex");
}

function rememberToolHash(set: Set<string>, callId: string): void {
  set.add(telemetryToolHash(callId));
  if (set.size <= SETTLED_CONTROL_TOOL_LIMIT) return;
  const oldest = set.values().next().value;
  if (typeof oldest === "string") set.delete(oldest);
}

function semanticEventId(callId: string): string {
  const bytes = createHash("sha256").update(`deepsonar-control:${callId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MAX_CONTROL_CALL_ID_LENGTH = 256;

/** Correlate control telemetry without persisting an untrusted tool id. */
function controlTelemetryCallId(callId: string): string {
  return `control-${createHash("sha256").update(`deepsonar-control-telemetry:${callId}`).digest("hex").slice(0, 24)}`;
}

function validControlCallId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CONTROL_CALL_ID_LENGTH;
}

function safeRuntimeValueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Shape-only telemetry for control inputs; never include values or field names. */
function safeControlInputShape(value: unknown): Record<string, unknown> {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) return { kind: "array", count: Math.min(value.length, 1000) };
  if (typeof value === "object") {
    return { kind: "object", field_count: Math.min(Object.keys(value as Record<string, unknown>).length, 1000) };
  }
  return { kind: safeRuntimeValueKind(value) };
}

const PARTIAL_ASSISTANT_MAX = 64_000;
const PARTIAL_ASSISTANT_MESSAGE_LIMIT = 32;

function partialAssistantKey(state: SemanticToolState): string {
  if (state.currentPartialAssistantMessage) return state.currentPartialAssistantMessage;
  state.nextPartialAssistantMessage += 1;
  const key = `stream-${state.nextPartialAssistantMessage}`;
  state.currentPartialAssistantMessage = key;
  return key;
}

function rememberPartialAssistant(
  state: SemanticToolState,
  kind: "text" | "reasoning",
  delta: string,
  messageId?: string,
): void {
  const key = messageId || partialAssistantKey(state);
  state.currentPartialAssistantMessage = key;
  const current = state.partialAssistantMessages.get(key) ?? { text: "", reasoning: "" };
  const previous = kind === "text" ? current.text : current.reasoning;
  const next = `${previous}${delta}`;
  if (kind === "text") current.text = next.length > PARTIAL_ASSISTANT_MAX ? next.slice(-PARTIAL_ASSISTANT_MAX) : next;
  else current.reasoning = next.length > PARTIAL_ASSISTANT_MAX ? next.slice(-PARTIAL_ASSISTANT_MAX) : next;
  state.partialAssistantMessages.set(key, current);
  while (state.partialAssistantMessages.size > PARTIAL_ASSISTANT_MESSAGE_LIMIT) {
    const oldest = state.partialAssistantMessages.keys().next().value;
    if (typeof oldest !== "string") break;
    state.partialAssistantMessages.delete(oldest);
  }
}

function completeAssistantText(
  state: SemanticToolState,
  kind: "text" | "reasoning",
  value: string,
  messageId?: string,
): string | undefined {
  if (!value) return undefined;
  const key = partialAssistantKeyForComplete(state, messageId);
  const partial = key ? state.partialAssistantMessages.get(key) : undefined;
  const streamed = partial ? (kind === "text" ? partial.text : partial.reasoning) : "";
  let unseen = value;
  if (streamed === value) unseen = "";
  else if (streamed && value.startsWith(streamed)) unseen = value.slice(streamed.length);
  return unseen || undefined;
}

function partialAssistantKeyForComplete(
  state: SemanticToolState,
  messageId?: string,
): string | undefined {
  if (messageId && state.partialAssistantMessages.has(messageId)) return messageId;
  if (state.currentPartialAssistantMessage && state.partialAssistantMessages.has(state.currentPartialAssistantMessage)) {
    return state.currentPartialAssistantMessage;
  }
  if (state.partialAssistantMessages.size === 1) return state.partialAssistantMessages.keys().next().value as string | undefined;
  return messageId || state.currentPartialAssistantMessage;
}

function partialAssistantMessagesDelete(state: SemanticToolState, key: string): void {
  state.partialAssistantMessages.delete(key);
  if (state.currentPartialAssistantMessage === key) state.currentPartialAssistantMessage = undefined;
}

function streamMessageId(
  state: SemanticToolState,
  value: unknown,
): string {
  if (typeof value === "string" && value) {
    state.currentPartialAssistantMessage = value;
    return value;
  }
  return partialAssistantKey(state);
}

const TOOL_DETAIL_MAX = 4000;
const SENSITIVE_TOOL_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|client[-_]?secret/i;

function redactSecretValues(value: string, secretValues: readonly string[]): string {
  let redacted = value;
  // Sort longest first so a token prefix cannot leave the secret suffix in
  // telemetry when a caller supplied both a token and a derived prefix.
  for (const secret of [...secretValues].filter((entry) => typeof entry === "string" && entry.length > 0).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export const RUNTIME_STDERR_EVIDENCE_MAX_BYTES = 1024 * 1024;

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return value.slice(0, end);
}

/**
 * Preserve the CLI stderr stream in normalized evidence without retaining an
 * unbounded in-memory copy. Exact runtime secrets are redacted across arbitrary
 * SDK chunk boundaries before the total UTF-8 byte budget is applied.
 */
export class BoundedRuntimeStderrEvidence {
  private readonly secrets: string[];
  private readonly maxSecretLength: number;
  private pending = "";
  private capturedBytes = 0;
  private truncated = false;

  constructor(
    secretValues: readonly string[],
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly maxBytes = RUNTIME_STDERR_EVIDENCE_MAX_BYTES,
  ) {
    this.secrets = [...new Set(secretValues.filter((entry) => entry.length > 0))]
      .sort((left, right) => right.length - left.length);
    this.maxSecretLength = this.secrets[0]?.length ?? 0;
  }

  push(chunk: string): void {
    if (!chunk || this.truncated) return;
    this.pending += chunk;
    this.flush(false);
  }

  finish(): void {
    if (this.truncated) return;
    this.flush(true);
  }

  private flush(final: boolean): void {
    let output = "";
    const requiredLookahead = Math.max(1, this.maxSecretLength);
    while (this.pending && (final || this.pending.length >= requiredLookahead)) {
      const secret = this.secrets.find((candidate) => this.pending.startsWith(candidate));
      if (secret) {
        output += "[REDACTED]";
        this.pending = this.pending.slice(secret.length);
        continue;
      }
      const codePoint = String.fromCodePoint(this.pending.codePointAt(0)!);
      output += codePoint;
      this.pending = this.pending.slice(codePoint.length);
    }
    this.emitBounded(output);
  }

  private emitBounded(value: string): void {
    if (!value || this.truncated) return;
    const remaining = Math.max(0, this.maxBytes - this.capturedBytes);
    const captured = utf8Prefix(value, remaining);
    if (captured) {
      const bytes = Buffer.byteLength(captured, "utf8");
      this.capturedBytes += bytes;
      this.emit({ type: "runtime.stderr", chunk: captured });
    }
    if (captured.length !== value.length) {
      this.truncated = true;
      this.pending = "";
      this.emit({
        type: "runtime.stderr.truncated",
        captured_bytes: this.capturedBytes,
        max_bytes: this.maxBytes,
      });
    }
  }
}

/** Exact-value redaction that preserves result/session object shape and size. */
function redactSecretsDeep(value: unknown, secretValues: readonly string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecretValues(value, secretValues);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSecretsDeep(entry, secretValues, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactSecretsDeep(entry, secretValues, seen)]),
  );
}

/** Exact secret redaction for result files and archived CLI session bundles. */
export function redactRuntimeSecrets(value: unknown, secretValues: readonly string[]): unknown {
  return redactSecretsDeep(value, secretValues);
}

/** Redact and bound ordinary tool telemetry before it crosses the runtime boundary. */
export function redactToolTelemetry(
  value: unknown,
  key?: string,
  depth = 0,
  secretValues: readonly string[] = [],
): unknown {
  if (key && SENSITIVE_TOOL_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") {
    return redactSecretValues(value, secretValues)
      .replace(/\b(?:deepsonar_(?:prod|dev|user|job)_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gi, "[REDACTED]")
      .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/((?:api[-_]?key|token|secret|password|authorization|cookie)\s*[:=]\s*)(?!Bearer\b|Basic\b)([^\s,;]+)/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactToolTelemetry(entry, undefined, depth + 1, secretValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([entryKey, entryValue]) => [entryKey, redactToolTelemetry(entryValue, entryKey, depth + 1, secretValues)]));
  }
  return value;
}

function boundedToolText(value: unknown, secretValues: readonly string[] = []): string | undefined {
  if (value === undefined || value === null) return undefined;
  const redacted = redactToolTelemetry(value, undefined, 0, secretValues);
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  return text && text.length > TOOL_DETAIL_MAX ? `${text.slice(0, TOOL_DETAIL_MAX)}...` : text;
}

function toolResultText(block: Record<string, unknown>, secretValues: readonly string[] = []): string | undefined {
  const value = block.result ?? block.output ?? block.content ?? block.stdout ?? block.text;
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string" ? (entry as Record<string, unknown>).text : entry)
      .filter((entry) => entry !== undefined && entry !== null);
    return boundedToolText(normalized, secretValues);
  }
  return boundedToolText(value, secretValues);
}

function toolExitCode(block: Record<string, unknown>): number | undefined {
  const value = block.exit ?? block.exit_code ?? block.exitCode ?? block.code;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -255 && value <= 255 ? value : undefined;
}

function runtimeContentBlocks(
  line: Record<string, unknown>,
  role: "assistant" | "user",
  warnings: Array<{ code: string; detail?: string }>,
): Array<Record<string, unknown>> {
  const message = line.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const messageRecord = message as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(messageRecord, "content")) return [];
  const content = messageRecord.content;
  if (!Array.isArray(content)) {
    warnings.push({ code: "malformed_runtime_block", detail: `${role}_content_type=${safeRuntimeValueKind(content)}` });
    return [];
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      warnings.push({ code: "malformed_runtime_block", detail: `${role}_content_block_type=${safeRuntimeValueKind(block)}` });
      continue;
    }
    blocks.push(block as Record<string, unknown>);
  }
  return blocks;
}

/** Parse one CLI stream line without letting malformed/legacy control-file
 * text poison the following structured line. */
export function parseRuntimeLine(line: string): {
  parsed?: Record<string, unknown>;
  warning?: { code: "malformed_runtime_line" | "forbidden_control_file"; detail: string };
} {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { warning: { code: "malformed_runtime_line", detail: `line_length=${line.length}` } };
    }
    return { parsed: parsed as Record<string, unknown> };
  } catch {
    const forbidden = /\.deepsonar[\\/]+control(?:-|\.)|control-events\.jsonl/i.test(line);
    return {
      warning: {
        code: forbidden ? "forbidden_control_file" : "malformed_runtime_line",
        detail: `line_length=${line.length}`,
      },
    };
  }
}

const CLAUDE_STREAM_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

function mapClaudeStreamEvent(
  line: Record<string, unknown>,
  emit: (e: Record<string, unknown>) => void,
  state: SemanticToolState,
  warnings: Array<{ code: string; detail?: string }>,
): boolean {
  const event = line.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    warnings.push({ code: "malformed_runtime_event", detail: "stream_event_payload" });
    return true;
  }
  const eventRecord = event as Record<string, unknown>;
  const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "";
  if (!CLAUDE_STREAM_EVENT_TYPES.has(eventType)) {
    warnings.push({ code: "unknown_runtime_event", detail: "stream_event_type" });
    return true;
  }
  if (eventType === "message_start") {
    const message = eventRecord.message;
    const messageId = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).id
      : undefined;
    streamMessageId(state, messageId);
    return true;
  }
  if (eventType !== "content_block_delta") return true;
  const delta = eventRecord.delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    warnings.push({ code: "malformed_runtime_event", detail: "content_block_delta_payload" });
    return true;
  }
  const deltaRecord = delta as Record<string, unknown>;
  const deltaType = typeof deltaRecord.type === "string" ? deltaRecord.type : "";
  if (deltaType === "thinking_delta") {
    if (typeof deltaRecord.thinking !== "string" || !deltaRecord.thinking) return true;
    const value = deltaRecord.thinking;
    rememberPartialAssistant(state, "reasoning", value);
    emit({ type: "reasoning.delta", delta: value });
    return true;
  }
  if (deltaType === "text_delta") {
    if (typeof deltaRecord.text !== "string" || !deltaRecord.text) return true;
    const value = deltaRecord.text;
    rememberPartialAssistant(state, "text", value);
    emit({ type: "text.delta", delta: value });
    return true;
  }
  // Future content block delta types are intentionally ignored. They must not
  // become fabricated text or control-MCP events.
  return true;
}

export function mapCliEvent(
  line: Record<string, unknown>,
  emit: (e: Record<string, unknown>) => void,
  semanticToolEvents: Record<string, string> = DEFAULT_SEMANTIC_TOOL_EVENTS,
  state: SemanticToolState = createSemanticToolState(),
  secretValues: readonly string[] = [],
): {
  finalText?: string;
  isError?: boolean;
  errorDetail?: string;
  sessionId?: string;
  sessionFile?: string;
  settled?: boolean;
  semanticEvents: Array<Record<string, unknown>>;
  warnings: Array<{ code: string; detail?: string }>;
} {
  const semanticEvents: Array<Record<string, unknown>> = [];
  const warnings: Array<{ code: string; detail?: string }> = [];
  const type = line.type as string;
  if (type === "stream_event") {
    mapClaudeStreamEvent(line, emit, state, warnings);
    return { semanticEvents, warnings };
  }
  if (type === "text.delta" || type === "reasoning.delta") {
    const delta = line.delta;
    if (typeof delta === "string" && delta) emit({ type, delta });
    return { semanticEvents, warnings };
  }
  if (type === "system" && line.subtype === "init") {
    emit({ type: "run.started", sessionId: line.session_id });
    return { sessionId: typeof line.session_id === "string" ? line.session_id : undefined, semanticEvents, warnings };
  }
  if (type === "assistant") {
    const message = line.message;
    const messageId = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).id
      : undefined;
    let completeAssistantMessage = false;
    for (const block of runtimeContentBlocks(line, "assistant", warnings)) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        const value = completeAssistantText(state, "text", block.text, typeof messageId === "string" ? messageId : undefined);
        if (value) emit({ type: "text.delta", delta: value });
        completeAssistantMessage = true;
      } else if (
        (block.type === "thinking" || block.type === "reasoning") &&
        typeof (block.thinking ?? block.reasoning ?? block.text) === "string" &&
        (block.thinking ?? block.reasoning ?? block.text)
      ) {
        const raw = (block.thinking ?? block.reasoning ?? block.text) as string;
        const value = completeAssistantText(state, "reasoning", raw, typeof messageId === "string" ? messageId : undefined);
        if (value) emit({ type: "reasoning.delta", delta: value });
        completeAssistantMessage = true;
      } else if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" ? block.name : "";
        const callId = typeof block.id === "string" ? block.id : "";
        const eventType = Object.prototype.hasOwnProperty.call(semanticToolEvents, toolName)
          ? semanticToolEvents[toolName]
          : undefined;
        const isControlNamespace = toolName.startsWith("mcp__deepsonar-control__");
        const controlEventType = isControlNamespace && typeof eventType === "string" ? eventType : undefined;
        const canTrackControl = Boolean(
          controlEventType &&
          validControlCallId(callId) &&
          !state.seenToolUseIds.has(callId) &&
          !state.settledToolUseIds.has(callId) &&
          !state.pendingToolUses.has(callId),
        );
        if (controlEventType) {
          if (!validControlCallId(callId)) {
            warnings.push({
              code: "malformed_control_tool_use",
              detail: callId ? `call_id_length=${callId.length}` : "call_id_missing",
            });
          } else if (canTrackControl) {
            rememberObservedToolUse(state, callId, "control");
            emit({ type: "tool.call.started", toolName, callId: controlTelemetryCallId(callId), inputShape: safeControlInputShape(block.input) });
          }
        } else if (isControlNamespace) {
          if (validControlCallId(callId)) rememberObservedToolUse(state, callId, "control");
          warnings.push({ code: "unknown_control_tool", detail: "control_namespace" });
        } else {
          emit({ type: "tool.call.started", toolName: block.name, callId: block.id, input: redactToolTelemetry(block.input, undefined, 0, secretValues) });
          if (callId) {
            rememberToolHash(state.observedNonControlToolUseHashes, callId);
            state.observedNonControlToolUseNames.set(telemetryToolHash(callId), toolName || "tool");
            if (state.observedNonControlToolUseNames.size > SETTLED_CONTROL_TOOL_LIMIT) {
              const oldest = state.observedNonControlToolUseNames.keys().next().value;
              if (typeof oldest === "string") state.observedNonControlToolUseNames.delete(oldest);
            }
          }
        }
        if (canTrackControl) {
          if (state.pendingToolUses.size >= state.maxPendingToolUses) {
            rememberToolId(state.settledToolUseIds, callId);
            warnings.push({ code: "control_tool_pending_limit", detail: `pending_count=${state.pendingToolUses.size}` });
            continue;
          }
          state.pendingToolUses.set(callId, {
            toolName,
            event: {
            v: 1,
            event_id: semanticEventId(callId),
            type: eventType,
            payload: block.input && typeof block.input === "object" ? block.input : {},
            },
          });
        }
      }
    }
    if (completeAssistantMessage) {
      const key = partialAssistantKeyForComplete(
        state,
        typeof messageId === "string" && messageId ? messageId : undefined,
      );
      if (key) partialAssistantMessagesDelete(state, key);
    }
    return { semanticEvents, warnings };
  }
  if (type === "user") {
    for (const block of runtimeContentBlocks(line, "user", warnings)) {
      if (block.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        if (!callId) continue;
        const isControlSizedId = validControlCallId(callId);
        if (isControlSizedId && state.settledToolUseIds.has(callId)) continue;
        const pending = isControlSizedId ? state.pendingToolUses.get(callId) : undefined;
        // A result without a matching control tool_use is not control telemetry.
        // Do not let out-of-order/unknown ids poison the bounded replay sets.
        if (!pending) {
          const observedKind = isControlSizedId ? state.observedToolUses.get(callId) : undefined;
          if (observedKind === "control") {
            state.observedToolUses.delete(callId);
            rememberToolId(state.settledToolUseIds, callId);
            continue;
          }
          const nonControlHash = telemetryToolHash(callId);
          if (!state.observedNonControlToolUseHashes.delete(nonControlHash)) continue;
          if (!state.settledNonControlToolUseHashes.has(nonControlHash)) {
            rememberToolHash(state.settledNonControlToolUseHashes, callId);
            const result = toolResultText(block, secretValues);
            const error = block.is_error === true ? result : boundedToolText(block.error, secretValues);
            emit({
              type: "tool.call.completed",
              callId,
              toolName: state.observedNonControlToolUseNames.get(nonControlHash),
              ...(result ? { result } : {}),
              ...(toolExitCode(block) !== undefined ? { exit: toolExitCode(block) } : {}),
              ...(error ? { error } : {}),
              isError: block.is_error === true,
            });
          }
          state.observedNonControlToolUseNames.delete(nonControlHash);
          continue;
        }
        state.pendingToolUses.delete(callId);
        state.observedToolUses.delete(callId);
        rememberToolId(state.settledToolUseIds, callId);
        const hasIsError = Object.prototype.hasOwnProperty.call(block, "is_error");
        const isErrorFlag = hasIsError ? block.is_error : undefined;
        const validIsErrorFlag = !hasIsError || typeof isErrorFlag === "boolean";
        const isError = !validIsErrorFlag || isErrorFlag === true;
        if (!validIsErrorFlag) {
          warnings.push({
            code: "malformed_control_tool_result",
            detail: hasIsError ? `is_error_type=${safeRuntimeValueKind(isErrorFlag)}` : "is_error_missing",
          });
        }
        emit({
          type: "tool.call.completed",
          callId: controlTelemetryCallId(callId),
          toolName: pending.toolName,
          isError,
        });
        if (!isError) {
          rememberToolId(state.seenToolUseIds, callId);
          semanticEvents.push(pending.event);
        }
      }
    }
    return { semanticEvents, warnings };
  }
  if (type === "result") {
    const text = typeof line.result === "string" ? line.result : "";
    const safeText = redactSecretValues(text, secretValues);
    const isError = line.is_error === true || (line.subtype as string) !== "success";
    emit({ type: "run.completed", text: safeText || (line.subtype as string) });
    return { finalText: safeText, isError, errorDetail: isError ? safeText || `agent result: ${String(line.subtype)}` : undefined, semanticEvents, warnings };
  }
  if (type === "agent_settled") {
    const text = typeof line.result === "string" ? redactSecretValues(line.result, secretValues) : "";
    emit({ type: "run.settled", sessionId: line.session_id, sessionFile: line.session_file });
    return {
      finalText: text,
      isError: false,
      sessionId: typeof line.session_id === "string" ? line.session_id : undefined,
      sessionFile: typeof line.session_file === "string" ? line.session_file : undefined,
      settled: true,
      semanticEvents,
      warnings,
    };
  }
  if (type === "agent_end") {
    emit({ type: "run.agent_end" });
    return { semanticEvents, warnings };
  }
  return { semanticEvents, warnings };
}

/** Host errors that the Worker can usually fix by changing tool arguments. */
const AGENT_CORRECTABLE_HOST_ERROR_RE =
  /^(?:asset_|invalid_asset_|immutable_asset_key_exists$|shared_asset_source_(?:path_forbidden|not_regular_file|changed)$)/u;

/** Host / infrastructure failures that must still fail the Job. */
const FATAL_HOST_ERROR_RE =
  /^(?:shared_asset_publish_job_not_running|shared_asset_container_unavailable)/u;

/** Duck-type host control errors that the Worker can fix without ending the Job. */
function isAgentCorrectableSemanticError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; retryable?: unknown; code?: unknown; message?: unknown };
  if (record.retryable === true) return true;
  if (record.retryable === false) return false;
  if (record.name === "ControlInputError") {
    // Prefer explicit retryable when present; otherwise treat ControlInputError as soft.
    return record.retryable !== false;
  }
  const message = typeof record.message === "string" ? record.message : "";
  if (FATAL_HOST_ERROR_RE.test(message)) return false;
  // Cross-package / stringified host validation (assets, Zod wrappers, rate limits).
  if (
    /^\[(?:invalid_|unknown_field|duplicate_tool_call|tool_limit)/u.test(message) ||
    message.includes("asset_content_type_not_allowed") ||
    message.includes("event_rate_limited") ||
    AGENT_CORRECTABLE_HOST_ERROR_RE.test(message)
  ) {
    return true;
  }
  return false;
}

function semanticToolNameForEvent(event: Record<string, unknown>): string {
  const type = String(event.type ?? "");
  const map: Record<string, string> = {
    progress: "emit_progress",
    fact: "emit_fact",
    finding: "emit_finding",
    hub_decision: "submit_hub_decision",
    done: "mark_job_done",
    human: "request_human",
    shared_asset_publish: "publish_shared_asset",
    human_message_ack: "ack_human_message",
  };
  return map[type] ?? (type ? `control:${type}` : "control_tool");
}

export async function runRealAgent(host: RuntimeHost, spec: RealAgentSpec): Promise<RealAgentResult> {
  const secretValues = [...new Set((spec.secretValues ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))];
  const adapter = requireAgentCliRuntimeAdapter(spec.provider, spec.runtimeImageKey);
  // 按键比较能力映射，不使用 JSON.stringify：Postgres JSONB 不保留对象键插入顺序，
  // 单纯字符串比较会误拒绝所有经过数据库往返的冻结 Job。
  const capabilityValues = (value: object | undefined): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    if (!value) return out;
    for (const [key, entry] of Object.entries(value)) out.set(key, entry);
    return out;
  };
  const capabilityMismatch = (left: object | undefined, right: object) => {
    const a = capabilityValues(left);
    const b = capabilityValues(right);
    if (a.size !== b.size) return true;
    for (const [key, entry] of a) {
      if (b.get(key) !== entry) return true;
    }
    return false;
  };
  if (spec.adapter && (
    spec.adapter.adapter_id !== adapter.id ||
    spec.adapter.adapter_version !== adapter.version ||
    capabilityMismatch(spec.adapter.capabilities, adapter.capabilities)
  )) {
    throw new Error(`AGENT_CLI_SNAPSHOT_MISMATCH: ${adapter.id}`);
  }
  // 1. 从冻结快照生成本 Job 的完整 /workspace。目标内容不由 Scheduler 预下载，
  // Worker 根据 Hub prompt 与网络策略自行决定如何取材。
  for (const [filePath, content] of Object.entries(spec.workspaceFiles ?? {})) {
    const normalized = assertWorkspaceWritePath(filePath);
    const dir = path.posix.dirname(normalized);
    if (dir !== "/workspace") await host.run(`mkdir -p -- ${shellQuote(dir)}`);
    await host.uploadFile(content, normalized);
  }

  // 2. 沙箱只当执行宿主：由 Runtime Adapter 直接驱动官方 CLI 协议，不走 SDK daemon/relay。
  //    控制 MCP 仍由宿主注册并捕获结构化 tool_use/tool_result，不经沙箱目标网络。
  const cliEnv = runtimeCliEnv(spec.env);
  await ensureRuntimeHome(host);
  await materializeAgentFiles(host, spec, cliEnv);
  const mcpConfigPath = `${RUNTIME_DIR}/mcp.json`;
  if (spec.provider !== "pi") {
    await host.uploadFile(buildMcpConfigJson(spec.mcps ?? []), mcpConfigPath);
  }
  let systemPromptPath: string | null = null;
  if (spec.systemPrompt) {
    systemPromptPath = `${RUNTIME_DIR}/system-prompt.txt`;
    await host.uploadFile(spec.systemPrompt, systemPromptPath);
  }
  await adapter.materialize?.({
    host,
    cwd: "/workspace",
    env: cliEnv,
    model: spec.model,
    reasoning: spec.reasoning,
    dshProvider: spec.dshProvider,
    dshTaskMode: spec.dshTaskMode,
    input: spec.input,
    mcpConfigPath,
    ...(systemPromptPath ? { systemPromptPath } : {}),
  });

  let expectedContextIdentity = spec.contextIdentity;
  let observedSessionIdentity: ObservedSessionIdentity | undefined;
  let persistedSessionIdentity: ObservedSessionIdentity | undefined;
  const assertResumeIdentity = async (): Promise<void> => {
    if (!expectedContextIdentity) return;
    if (!spec.getResumeContextIdentity) throw new Error("CONTEXT_RESUME_IDENTITY_SOURCE_MISSING");
    const actual = await spec.getResumeContextIdentity({ sessionId, ...(sessionFile ? { sessionFile } : {}) });
    assertContextResume(expectedContextIdentity, actual);
    if (spec.provider === "pi") {
      if (!sessionFile) throw new Error("CONTEXT_RESUME_SESSION_FILE_MISSING");
      if (actual.session_file !== sessionFile) throw new Error("CONTEXT_RESUME_SESSION_FILE_MISMATCH");
      expectedContextIdentity = { ...expectedContextIdentity, session_file: sessionFile };
    }
  };
  const adapterContext = {
    host,
    cwd: "/workspace",
    env: cliEnv,
    model: spec.model,
    reasoning: spec.reasoning,
    dshProvider: spec.dshProvider,
    dshTaskMode: spec.dshTaskMode,
    input: spec.input,
    mcpConfigPath,
    ...(systemPromptPath ? { systemPromptPath } : {}),
    ...(spec.contextIdentity ? { contextIdentity: spec.contextIdentity } : {}),
    ...(spec.piExtensions ? { piExtensions: spec.piExtensions } : {}),
  };
  let exec = await adapter.start(adapterContext);
  const adapterState = {
    sessionId: spec.contextIdentity?.session_id,
    sessionFile: spec.contextIdentity?.session_file,
    finalText: undefined as string | undefined,
    model: spec.dshProvider?.model ?? spec.model,
    modelProvider: spec.dshProvider?.provider,
    cwd: "/workspace",
    ...(spec.contextIdentity ? { contextIdentity: spec.contextIdentity } : {}),
  };
  // CLI stdin 在 result 后会 closeStdin()；画布增量仍可能异步 sendMessage。
  const writeEncoded = async (encoded: string) => {
    if (!encoded) return;
    await exec.write(encoded);
  };
  const writeInitialMessage = async (content: string) => writeEncoded(adapter.encodeInput(content, adapterState));
  const writeSteerMessage = async (content: string) => writeEncoded(
    adapter.encodeSteer ? adapter.encodeSteer(content, adapterState) : adapter.encodeInput(content, adapterState),
  );
  const writeFollowUpMessage = async (content: string) => writeEncoded(
    adapter.encodeFollowUp ? adapter.encodeFollowUp(content, adapterState) : adapter.encodeInput(content, adapterState),
  );
  if (adapter.encodeGetState) await writeEncoded(adapter.encodeGetState());
  const disposeMessageSource = await spec.onRunReady?.({
    sendMessage: writeSteerMessage,
    readWorkspaceFile: (filePath, maxBytes) => host.readWorkspaceFile(filePath, maxBytes),
    writeWorkspaceFile: (filePath, bytes) => host.writeHumanInboxFile(filePath, bytes),
  });
  try {
    // 在首条 prompt 写入 stdin 前注册 Job 级运行 handler，避免 CLI 的首次 API
    // 发现/调用与宿主注册发生竞态。
    await writeInitialMessage(spec.input);
  } catch (error) {
    if (typeof disposeMessageSource === "function") await disposeMessageSource();
    throw error;
  }
  let semanticError: string | undefined;
  const semanticToolState = createSemanticToolState();
  const semanticToolEvents = spec.semanticToolEvents ?? DEFAULT_SEMANTIC_TOOL_EVENTS;
  // 3. 事件流 → 全量事件回调（实时流）+ 节流进度回调（§6.2：原始流不进 events 表）
  let lastPush = 0;
  let progressBuffer = "";
  let stdoutBuffer = "";
  let finalText = "";
  let sessionId = "";
  let sessionFile = "";
  let runError: string | undefined;
  let terminalOutcome: RealAgentResult["terminalOutcome"];
  let semanticErrorDetails: RuntimeErrorDetails | undefined;
  let nudgesLeft = 3;
  let sessionResumeAttempts = 0;
  let resumeSkipNotice: string | undefined;
  const sessionResumeMessage = "上游请求暂时失败，请在当前会话中继续完成原任务，不要开启新会话；不要重复已成功的工具调用或副作用，只继续未完成的步骤。";
  const stderrEvidence = new BoundedRuntimeStderrEvidence(
    secretValues,
    (event) => spec.onEvent?.(event),
  );
  const bindObservedResumeIdentity = () => {
    if (!expectedContextIdentity || !sessionId) return;
    if (spec.provider === "pi" && !sessionFile) return;
    if (!expectedContextIdentity.session_id) {
      expectedContextIdentity = {
        ...expectedContextIdentity,
        session_id: sessionId,
        ...(spec.provider === "pi" ? { session_file: sessionFile } : {}),
      };
    }
  };
  const observeSessionIdentity = async (observed: { sessionId?: string; sessionFile?: string }) => {
    const next = mergeObservedSessionIdentity(observedSessionIdentity, observed);
    if (!next) return;
    observedSessionIdentity = next;
    if (spec.provider === "pi" && !next.sessionFile) return;
    if (persistedSessionIdentity?.sessionId === next.sessionId
      && persistedSessionIdentity.sessionFile === next.sessionFile) return;
    await spec.onSessionIdentity?.(next);
    persistedSessionIdentity = next;
    sessionId = next.sessionId;
    sessionFile = next.sessionFile ?? "";
  };
  // 这些值只描述当前消费的进程；每次完成门恢复前必须重置，避免旧进程的
  // final text/result 掩盖后续进程退出。
  let attemptFinalText = "";
  let attemptExitCode = 0;
  let attemptTerminalResult: TerminalProcessAttempt["terminalResult"];
  let attemptCloseReason: TerminalAttemptCloseReason | undefined;
  let attemptStderrTail = "";
  // result 到达后 CLI 在 stream-json 输入模式下驻留等 stdin：门禁未过则催促，否则关 stdin；
  // execd 没有 EOF 控制帧，terminal_result 后有界等待再 kill，避免成功路径挂到 Reaper。
  const stdinCloseKiller = createStdinCloseKiller({
    kill: () => { void exec.kill().catch(() => {}); },
    graceMs: spec.stdinCloseKillMs,
  });
  const closeStdin = (reason?: TerminalAttemptCloseReason) => {
    if (reason) attemptCloseReason = reason;
    void exec.closeStdin().catch(() => {});
    stdinCloseKiller.afterClose(reason);
  };
  if (!adapter.capabilities.incrementalMessages) closeStdin("initial_input");
  try {
    while (true) {
      let resumedExec: typeof exec | undefined;
      let resumedInput: string | undefined;
      let processError: unknown;
      const piFramer = spec.provider === "pi" ? new PiJsonlFramer() : undefined;
      try {
        for await (const chunk of exec) {
          if (chunk.type === "stderr") {
            const stderrChunk = chunk.chunk ?? "";
            attemptStderrTail = (attemptStderrTail + stderrChunk).slice(-2000);
            stderrEvidence.push(stderrChunk);
            continue;
          }
          if (chunk.type === "exit") {
            attemptExitCode = chunk.exitCode ?? 0;
            continue;
          }
          if (adapter.outputMode === "plain-final") {
            const next = `${stdoutBuffer}${chunk.chunk ?? ""}`;
            if (Buffer.byteLength(next, "utf8") > PLAIN_FINAL_MAX_BYTES) {
              throw new Error("AGENT_CLI_PLAIN_OUTPUT_TOO_LARGE");
            }
            stdoutBuffer = next;
            continue;
          }
          const lines: string[] = [];
          if (piFramer) {
            lines.push(...piFramer.push(chunk.chunk ?? ""));
          } else {
            stdoutBuffer += chunk.chunk ?? "";
            // 其他 CLI 按行解析，未完成的行留给下一个 chunk。
            let idx: number;
            while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
              lines.push(stdoutBuffer.slice(0, idx));
              stdoutBuffer = stdoutBuffer.slice(idx + 1);
            }
          }
          for (const rawLine of lines) {
            const line = piFramer ? rawLine : rawLine.trim();
            if (!line) continue;
            const parsedLine = piFramer ? { parsed: parsePiJsonlRecord(line) } : parseRuntimeLine(line);
            if (!parsedLine.parsed) {
              if (parsedLine.warning) spec.onWarning?.(parsedLine.warning);
              continue; // CLI 的非 JSON 噪音行；后续合法行继续处理
            }
            const rawParsed = parsedLine.parsed;
            const decodedEvents = applyRuntimeOutput(adapter, rawParsed, adapterState);
            await observeSessionIdentity({ sessionId: adapterState.sessionId, sessionFile: adapterState.sessionFile });
            bindObservedResumeIdentity();
            for (const parsed of decodedEvents) {
              if (parsed.type === "runtime_outbound" && typeof parsed.content === "string") {
                await writeEncoded(parsed.content);
                continue;
              }
              if (parsed.type === "runtime_shutdown_ack") {
                closeStdin("terminal_result");
                continue;
              }
              if (parsed.type === "context.compacted" || parsed.type === "context.compaction_unknown") {
                const safeContextEvent = redactToolTelemetry(parsed, undefined, 0, secretValues) as Record<string, unknown>;
                spec.onEvent?.(safeContextEvent);
                const updatedContextIdentity = await spec.onContextEvent?.(safeContextEvent);
                if (parsed.type === "context.compacted" && expectedContextIdentity && updatedContextIdentity) {
                  expectedContextIdentity = updatedContextIdentity;
                } else if (parsed.type === "context.compacted" && expectedContextIdentity) {
                  expectedContextIdentity = {
                    ...expectedContextIdentity,
                    context_id: String(parsed.context_id ?? expectedContextIdentity.context_id),
                    context_revision: Number(parsed.context_revision ?? expectedContextIdentity.context_revision),
                    adapter_id: String(parsed.adapter_id ?? expectedContextIdentity.adapter_id),
                    adapter_version: String(parsed.adapter_version ?? expectedContextIdentity.adapter_version),
                    runtime_identity: String(parsed.runtime_identity ?? expectedContextIdentity.runtime_identity),
                    transform_chain_digest: String(parsed.transform_chain_digest ?? expectedContextIdentity.transform_chain_digest),
                  };
                }
                if (parsed.type === "context.compacted") bindObservedResumeIdentity();
                continue;
              }
              const outcome = mapCliEvent(parsed, (e) => {
                const safeEvent = redactToolTelemetry(e, undefined, 0, secretValues) as Record<string, unknown>;
                spec.onEvent?.(safeEvent);
                if (safeEvent.type === "tool.call.started") {
                  const input = safeEvent.input && typeof safeEvent.input === "object" ? safeEvent.input as Record<string, unknown> : {};
                  const command = typeof input.command === "string" ? input.command : "";
                  if (/\.deepsonar[\\/]+control(?:-|\.)|control-events\.jsonl/i.test(command)) {
                    spec.onWarning?.({ code: "forbidden_control_file", detail: `command_length=${command.length}` });
                  }
                }
                if (safeEvent.type === "text.delta" && typeof safeEvent.delta === "string") {
                  progressBuffer += safeEvent.delta as string;
                }
              }, semanticToolEvents, semanticToolState, secretValues);
              for (const warning of outcome.warnings) spec.onWarning?.(warning);
              if (!["system", "assistant", "user", "result", "stream_event", "text.delta", "reasoning.delta", "agent_settled", "agent_end"].includes(String(parsed.type))) {
                spec.onWarning?.({ code: "unknown_runtime_event", detail: "unrecognized_stream_type" });
              }
              for (const event of outcome.semanticEvents) {
                const safeSemanticEvent = redactToolTelemetry(event, undefined, 0, secretValues) as Record<string, unknown>;
                try {
                  await spec.onSemanticEvent?.(safeSemanticEvent, {
                    readWorkspaceFile: (filePath, maxBytes) => host.readWorkspaceFile(filePath, maxBytes),
                  });
                } catch (error) {
                  // Host-side control validation runs after MCP returned
                  // schema_validated. Agent-correctable failures must return as
                  // tool/error feedback and keep the CLI session alive — never
                  // collapse into fatal "语义事件处理失败" Job exit.
                  if (isAgentCorrectableSemanticError(error)) {
                    const message = redactSecretValues(error instanceof Error ? error.message : String(error), secretValues);
                    const toolHint = semanticToolNameForEvent(safeSemanticEvent);
                    spec.onWarning?.({
                      code: "control_tool_host_rejected",
                      detail: message.length > 280 ? `${message.slice(0, 280)}…` : message,
                    });
                    // Surface on the process stream as a failed control tool so the
                    // live UI shows the rejection (MCP already answered success).
                    spec.onEvent?.(redactToolTelemetry({
                      type: "tool.call.completed",
                      toolName: toolHint,
                      isError: true,
                      error: message,
                      result: message,
                    }, undefined, 0, secretValues) as Record<string, unknown>);
                    const nudge =
                      `【控制工具被平台拒绝 — 请修正后重试，本 Job 未退出】\n` +
                      (toolHint ? `工具: ${toolHint}\n` : "") +
                      `错误: ${message}\n` +
                      "请根据错误修正参数并重新调用该工具（或改用 payload_file）；不要 mark_job_done，直到契约要求的提交成功。";
                    if (adapter.capabilities.incrementalMessages) {
                      await writeFollowUpMessage(nudge);
                    } else if (sessionId) {
                      // 非增量 CLI 在同一会话带错误恢复，使模型能修正而不是中途终止。
                      try {
                        await assertResumeIdentity();
                        resumedExec = await adapter.resume({ ...adapterContext, ...(expectedContextIdentity ? { contextIdentity: expectedContextIdentity } : {}), input: nudge, sessionId, ...(sessionFile ? { sessionFile } : {}) });
                        resumedInput = nudge;
                      } catch (resumeError) {
                        if (resumeError instanceof Error && resumeError.message.startsWith("CONTEXT_RESUME_")) throw resumeError;
                        spec.onWarning?.({
                          code: "control_tool_reject_resume_failed",
                          detail: resumeError instanceof Error ? resumeError.message : String(resumeError),
                        });
                      }
                    }
                    continue;
                  }
                  semanticError = error instanceof Error ? error.message : String(error);
                  semanticErrorDetails = normalizeRuntimeErrorDetails(error);
                  throw error;
                }
              }
              // 首次捕获后保持 session ID 不变；恢复进程只能继续原会话，不能把
              // 后续输出中的其他 ID 提升为新的恢复目标。
              await observeSessionIdentity({ sessionId: outcome.sessionId, sessionFile: outcome.sessionFile });
              bindObservedResumeIdentity();
              if (outcome.isError !== undefined) {
                attemptTerminalResult = {
                  isError: outcome.isError,
                  ...(outcome.errorDetail !== undefined ? { errorDetail: outcome.errorDetail } : {}),
                };
                terminalOutcome = outcome.isError ? "failure" : "success";
                // 即使 Provider 省略最终文本，只要发出终态成功/失败，也覆盖上一轮结果。
                runError = resolveTerminalRunError(outcome);
              }
              if (outcome.finalText !== undefined) {
                // 每次完成门尝试都有独立终态。后续成功清除临时 Provider 错误；
                // 重试耗尽时以最后一次失败为准。
                attemptFinalText = outcome.finalText;
                finalText = outcome.finalText;
                if (outcome.isError !== true && spec.completionGate && !spec.completionGate() && nudgesLeft > 0) {
                  nudgesLeft--;
                  const nudge = spec.nudgeMessage ??
                    "协议要求的系统工具调用还没有完成。请立即通过平台 MCP 工具提交（不要只用文本描述），然后结束本轮。";
                  if (adapter.capabilities.incrementalMessages) {
                    await writeFollowUpMessage(nudge);
                  } else {
                    if (!sessionId) throw new Error(`AGENT_CLI_COMPLETION_GATE_SESSION_MISSING: ${adapter.id}`);
                    await assertResumeIdentity();
                    resumedExec = await adapter.resume({ ...adapterContext, ...(expectedContextIdentity ? { contextIdentity: expectedContextIdentity } : {}), input: nudge, sessionId, ...(sessionFile ? { sessionFile } : {}) });
                    resumedInput = nudge;
                  }
                } else if (adapter.encodeShutdown) {
                  await writeEncoded(adapter.encodeShutdown(adapterState));
                } else {
                  closeStdin("terminal_result");
                }
              }
              const now = Date.now();
              if (progressBuffer.length > 0 && now - lastPush > 4000) {
                lastPush = now;
                spec.onProgress?.(progressBuffer.slice(-200));
                progressBuffer = "";
              }
            }
          }
        }
      } catch (error) {
        processError = error;
      } finally {
        stdinCloseKiller.cancel();
        if (piFramer) {
          try {
            piFramer.finish();
          } catch (error) {
            processError ??= error;
          }
        }
      }
      if (adapter.outputMode === "plain-final" && !processError) {
        const plainResult = normalizePlainFinalOutput(
          stdoutBuffer,
          attemptStderrTail,
          attemptExitCode,
          undefined,
          { adapterId: adapter.id, completionGate: spec.completionGate?.() ?? true },
        );
        for (const event of plainResult.events) spec.onEvent?.(event);
        attemptFinalText = plainResult.text;
        finalText = plainResult.text;
        attemptTerminalResult = {
          isError: plainResult.terminalOutcome !== "success",
          ...(plainResult.error ? { errorDetail: plainResult.error } : {}),
        };
      }
      const processErrorText = processError
        ? [runtimeErrorText(processError), attemptStderrTail].filter(Boolean).join(": ")
        : undefined;
      const attemptOutcome = semanticError
        ? { observed: false }
        : processError && !(attemptTerminalResult && attemptCloseReason === "terminal_result")
          ? {
              observed: true,
              error: processErrorText || "agent CLI 运行失败",
              terminalOutcome: "failure" as const,
            }
          : resolveTerminalProcessOutcome({
              finalText: attemptFinalText,
              exitCode: attemptExitCode,
              terminalResult: attemptTerminalResult,
              closeReason: attemptCloseReason,
              stderrTail: attemptStderrTail,
            });
      if (attemptOutcome.observed) {
        runError = attemptOutcome.error;
        terminalOutcome = attemptOutcome.terminalOutcome;
      }
      if (!resumedExec && !semanticError && attemptOutcome.error) {
        const reason = classifyCliSessionResumeError(attemptOutcome.error);
        if (reason) {
          const canResume = Boolean(sessionId && sessionResumeAttempts < CLI_SESSION_RESUME_MAX_ATTEMPTS);
          if (canResume) {
            sessionResumeAttempts++;
            const attempt = sessionResumeAttempts;
            const delayMs = cliSessionResumeDelayMs(attempt);
            spec.onEvent?.({ type: "run.retrying", reason, attempt, delayMs });
            await waitForCliSessionResume(attempt);
            try {
              await assertResumeIdentity();
              resumedExec = await adapter.resume({ ...adapterContext, ...(expectedContextIdentity ? { contextIdentity: expectedContextIdentity } : {}), input: sessionResumeMessage, sessionId, ...(sessionFile ? { sessionFile } : {}) });
              resumedInput = sessionResumeMessage;
            } catch (resumeError) {
              if (resumeError instanceof Error && resumeError.message.startsWith("CONTEXT_RESUME_")) throw resumeError;
              const detail = runtimeErrorText(resumeError).slice(0, 280) || "unknown_resume_error";
              spec.onWarning?.({ code: "cli_session_resume_failed", detail });
              runError = `AGENT_CLI_RESUME_FAILED: ${adapter.id}`;
              terminalOutcome = "failure";
            }
          } else {
            const cause = !sessionId
              ? "session_missing"
              : "attempts_exhausted";
            const notice = `${reason}:${cause}`;
            if (resumeSkipNotice !== notice) {
              resumeSkipNotice = notice;
              spec.onWarning?.({ code: "cli_session_resume_skipped", detail: notice });
              spec.onEvent?.({ type: "run.retry_skipped", reason, cause });
            }
          }
        }
      }
      if (!resumedExec) break;
      exec = resumedExec;
      // 只有增量 CLI 通过 stream-json stdin 注入恢复消息；Codex/OpenCode
      // 已把恢复消息作为固定命令参数传入，不能再重复写入 stdin。
      stdoutBuffer = "";
      attemptFinalText = "";
      attemptExitCode = 0;
      attemptTerminalResult = undefined;
      attemptCloseReason = undefined;
      attemptStderrTail = "";
      if (adapter.capabilities.incrementalMessages && resumedInput) {
        if (spec.provider === "dsh") await writeInitialMessage(resumedInput);
        else await writeFollowUpMessage(resumedInput);
      }
    }
  } catch (e) {
    // An exception while handling the current attempt is the latest runner
    // failure. Keep semanticError separate so host validation remains
    // fail-closed even if the session emitted ordinary text afterwards.
    // A stream error caused by the deliberate stdin close after a valid
    // terminal result is not a runner failure.  Preserve a terminal failure
    // result if that was what the provider reported.
    if (!semanticError && !(attemptTerminalResult && attemptCloseReason === "terminal_result")) {
      runError = e instanceof Error ? e.message : String(e);
      terminalOutcome = "failure";
    }
  } finally {
    stdinCloseKiller.cancel();
    discardPendingSemanticTools(semanticToolState, (warning) => spec.onWarning?.(warning));
    if (typeof disposeMessageSource === "function") await disposeMessageSource();
  }
  stderrEvidence.finish();

  // 4. 读回结果文件
  const files: Record<string, string> = {};
  for (const path of spec.resultFiles ?? []) {
    try {
      const text = await readSandboxFileText(host, path);
      if (text !== null) files[path] = redactSecretValues(text, secretValues);
    } catch {
      // 文件不存在 = agent 没写，容忍
    }
  }
  // 在沙箱销毁前按 CLI 专属规则归档原始 Session。捕获失败不覆盖 Agent 的主运行结果。
  const rawSession = sessionId
    ? await CLI_SESSION_ADAPTERS[spec.provider].exportSession(
        {
          run: (command) => host.run(command, { timeoutMs: 20_000, env: cliEnv }),
          readText: (filePath) => readSandboxFileText(host, filePath),
        },
        sessionId,
        sessionFile || undefined,
      ).catch((error) => ({
        cli: spec.provider,
        sessionId,
        artifacts: [],
        captureError: error instanceof Error ? error.message : String(error),
      }))
    : undefined;
  const session = rawSession
    ? redactRuntimeSecrets(rawSession, secretValues) as SessionBundle
    : undefined;
  await host.run(`rm -rf -- ${shellQuote(RUNTIME_HOME)}`).catch(() => {});
  // 结果已经进入调度器内存后立即从 Worker 工作区删除；即使后续解析失败也不遗留。
  // 每个 Job 随后还会由 dispatcher 销毁独立沙箱，这是显式清理之外的第二道保障。
  const cleanupPaths = [...(spec.resultFiles ?? [])]
    .filter((p) => p.startsWith("/workspace/"));
  if (cleanupPaths.length > 0) {
    await host.run(`rm -f -- ${cleanupPaths.map((p) => shellQuote(p)).join(" ")}`).catch(() => {});
  }

  return {
    text: redactSecretValues(finalText, secretValues),
    files,
    session,
    ...(semanticError
      ? { error: `语义事件处理失败: ${redactSecretValues(semanticError, secretValues)}` }
      : runError
        ? { error: redactSecretValues(runError, secretValues) }
        : {}),
    ...(semanticError
      ? { errorKind: "semantic" as const }
      : runError
        ? { errorKind: "runner" as const }
        : {}),
    ...(semanticErrorDetails ? { errorDetails: semanticErrorDetails } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

