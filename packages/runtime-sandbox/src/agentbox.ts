/**
 * agentbox-sdk（TwillAI, MIT）真实实现 —— ARCHITECTURE §5/§8
 *
 * 要点：
 * - agentbox 只作沙箱（容器生命周期 + exec + 文件上下行）；Agent 由受治理的
 *   Runtime Adapter 通过官方结构化 CLI 协议直接在沙箱内驱动，不走 SDK daemon/relay。
 * - Gateway sidecar / Docker CLI 公共层在 runtime-gateway.ts 与 runtime-docker.ts。
 */
import { Sandbox } from "agentbox-sdk";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  HUMAN_INBOX_WRITER_SCRIPT,
  RuntimeImageContractError,
  SHARED_ASSETS_MOUNT_PATH,
  assertSharedAssetsVolumeOwnership,
  parseHumanInboxWorkspacePath,
  parseToolManifest,
} from "./runtime-shared.js";
import {
  docker,
  forceRemoveContainer,
  listDeepSonarContainers,
  readDockerWorkspaceFile,
  removeContainerWithRetry,
} from "./runtime-docker.js";
import {
  GATEWAY_NETWORK,
  GATEWAY_PROXY,
  RESTRICTED_NETWORK,
  cleanupUnhealthyManagedGateway,
  ensureGatewayProxy,
} from "./runtime-gateway.js";
import { type RuntimeHost, type RuntimeProcess, type RuntimeProcessChunk, type RuntimeResource } from "./runtime-host.js";
import type { ProvisionInput, RunHandle, SandboxRunner, SandboxTerminalSession, TerminalOpenInput } from "./index.js";

export {
  DEEPSONAR_GATEWAY_PROXY_HOST,
  HUMAN_INBOX_WRITER_SCRIPT,
  RuntimeImageContractError,
  SHARED_ASSETS_JOB_LABEL,
  SHARED_ASSETS_MOUNT_PATH,
  SHARED_ASSETS_VOLUME_LABEL,
  assertSharedAssetsVolumeOwnership,
  parseToolManifest,
} from "./runtime-shared.js";
export {
  CONTAINER_REMOVE_MAX_ATTEMPTS,
  CONTAINER_REMOVE_RETRY_BASE_DELAY_MS,
  CONTAINER_REMOVE_TIMEOUT_MS,
  dockerApiJson,
  dockerSocketPath,
  forceRemoveContainer,
  isDeepsonarGatewayNetwork,
  isDeepsonarRestrictedNetwork,
  listDeepSonarContainers,
  parseDeepSonarContainerRows,
  readDockerWorkspaceFile,
  removeContainerWithRetry,
} from "./runtime-docker.js";
export type { DeepSonarContainer } from "./runtime-docker.js";
export {
  DEFAULT_GATEWAY_CREATE_TIMEOUT_MS,
  GATEWAY_PROXY_REVISION,
  GATEWAY_PROXY_SCRIPT,
  bindGatewayProxyToOpenSandboxNetwork,
  cleanupUnhealthyManagedGateway,
  gatewayCreateTimeoutMs,
  gatewayLeftoverRemovalTarget,
  gatewayProxyReuseAction,
  preheatManagedGateway,
  resetManagedGatewayStateForTests,
  shouldRemoveGatewayLeftover,
} from "./runtime-gateway.js";

async function deleteSandboxBestEffort(sandbox: Sandbox, timeoutMs = 15_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sandbox.delete(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`agentbox delete timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// --- agentbox-sdk 0.1.501 Windows 宿主兼容性补丁 ---
// SDK 用宿主 path.join 拼沙箱内的 POSIX 路径，Windows 上产出反斜杠，传进容器后路径全毁。
// 运行时补丁：join 的首参数是 POSIX 绝对路径（"/" 开头）时改用 posix.join。
// Windows 宿主路径只会以盘符或 \\ 开头，不会误判；SDK 的路径拼接全部发生在运行时。
// TODO: 向上游提 issue，修复后移除此补丁。
const origJoin = path.join.bind(path);
if (process.platform === "win32") {
  path.join = ((...args: string[]) =>
    args[0]?.startsWith("/") ? path.posix.join(...args) : origJoin(...args)) as typeof path.join;
}

/** sandboxId → Sandbox 注册表（isAlive/destroy 用；进程重启即丢，靠 docker CLI 兜底） */
const sandboxes = new Map<string, Sandbox>();
const provisioningSandboxes = new Map<string, Sandbox>();
const terminalSessions = new Map<string, Set<SandboxTerminalSession>>();
const SHARED_ASSETS_VOLUME_RE = /^deepsonar-assets-[a-z0-9][a-z0-9_.-]{0,62}$/;
let restrictedNetworkReady: Promise<void> | null = null;
let gatewayNetworkReady: Promise<void> | null = null;
let gatewayProxyReady: Promise<{ containerId: string; createOwner: string | null }> | null = null;

type TerminalCommandProcess = {
  write?: (input: string) => Promise<void>;
};

/** Build one explicit interactive shell command for the terminal PTY. */
export function terminalShellCommand(shell: "bash" | "sh"): string {
  return shell === "bash" ? "exec bash -il" : "exec /bin/sh -i";
}

/**
 * Select Bash when the governed image provides it, otherwise use the required
 * POSIX /bin/sh contract.  Both branches stay interactive so readline/tab
 * completion and control characters are handled by the shell attached to the
 * SDK PTY rather than by a non-interactive command wrapper.
 */
export function buildTerminalShellCommand(): string {
  return [
    "if command -v bash >/dev/null 2>&1; then",
    `${terminalShellCommand("bash")};`,
    "else",
    `${terminalShellCommand("sh")};`,
    "fi",
  ].join(" ");
}

/** Write terminal input without interpreting or normalizing control bytes. */
export async function writeTerminalInput(process: TerminalCommandProcess, data: string): Promise<void> {
  if (!process.write) throw new Error("TERMINAL_SESSION_CLOSED");
  await process.write(data);
}

/** Build the only Docker bind accepted for shared assets; host paths are never allowed. */
export function sharedAssetsVolumeBinds(mount: ProvisionInput["sharedAssetsMount"]): string[] {
  if (!mount) return [];
  if (!SHARED_ASSETS_VOLUME_RE.test(mount.volumeName)) {
    throw new Error("shared assets volume must be a Scheduler-owned deepsonar-assets-* named volume");
  }
  return [`${mount.volumeName}:${SHARED_ASSETS_MOUNT_PATH}:ro`];
}

interface SharedAssetsVolumeInspection {
  Name?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Labels?: unknown;
}

interface SharedAssetsContainerInspection {
  Mounts?: unknown;
}

/** Validate the actual container after attach as well as after fresh provision. */
export function assertSharedAssetsContainerMount(
  inspected: SharedAssetsContainerInspection,
  volumeName: string,
): void {
  const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts : [];
  const targetMounts = mounts.filter((entry) => (
    entry && typeof entry === "object" &&
    (entry as Record<string, unknown>).Destination === SHARED_ASSETS_MOUNT_PATH
  ));
  const mount = targetMounts[0] as Record<string, unknown> | undefined;
  if (
    targetMounts.length !== 1 ||
    mount?.Type !== "volume" ||
    mount?.Name !== volumeName ||
    mount?.RW !== false
  ) {
    throw new Error("sandbox shared assets mount does not match the frozen read-only volume");
  }
}

async function validateSharedAssetsVolume(volumeName: string, jobId: string): Promise<void> {
  let output: string;
  try {
    output = await docker("volume", "inspect", volumeName, "--format", "{{json .}}");
  } catch {
    throw new Error("shared assets volume must exist before sandbox provisioning");
  }
  let inspected: SharedAssetsVolumeInspection;
  try {
    inspected = JSON.parse(output) as SharedAssetsVolumeInspection;
  } catch {
    throw new Error("shared assets volume inspection returned invalid JSON");
  }
  assertSharedAssetsVolumeOwnership(inspected, volumeName, jobId);
}

async function removeAttemptContainers(jobId: string, attemptId: string): Promise<void> {
  const raw = await docker(
    "ps", "-aq",
    "--filter", `label=deepsonar.job=${jobId}`,
    "--filter", `label=deepsonar.attempt=${attemptId}`,
  );
  for (const id of raw.split(/\s+/).filter(Boolean)) {
    await removeContainerWithRetry(id);
  }
}

async function validateSharedAssetsContainer(sandbox: Sandbox, volumeName: string): Promise<void> {
  const raw = sandbox.raw as { container?: { inspect?: () => Promise<SharedAssetsContainerInspection> } } | undefined;
  if (!raw?.container || typeof raw.container.inspect !== "function") {
    throw new Error("sandbox provider cannot verify the shared assets mount");
  }
  assertSharedAssetsContainerMount(await raw.container.inspect(), volumeName);
}
/** dockerode createContainer 调用签名（只需要我们注入 HostConfig 的部分） */
interface CreateContainerOptions {
  Labels?: Record<string, string>;
  HostConfig?: Record<string, unknown>;
}

/**
 * SEC-03 容器硬限制：agentbox-sdk 只透传 cpu/memory，PidsLimit/CapDrop/SecurityOpt
 * 需要包住 dockerode 的 createContainer 注入。按实例包装（不碰全局原型），
 * 只对带 deepsonar.job 标签的容器生效，SDK 升级也不影响其他调用方。
 * TODO(SEC-03 余项)：non-root 运行 + read_only_rootfs 需镜像侧配合（/workspace、/tmp 可写卷），留待 OPS。
 */
function hardenCreateContainer(
  sandbox: Sandbox,
  limits: ProvisionInput["limits"],
  extraHosts: string[] = [],
  readonlyBinds: string[] = [],
): void {
  const adapter = (sandbox as unknown as { adapter?: { client?: {
    createContainer: (opts: CreateContainerOptions) => Promise<unknown>;
  } } }).adapter;
  const client = adapter?.client;
  if (!client || typeof client.createContainer !== "function") return; // SDK 内部结构变化时静默跳过（不阻断）

  const orig = client.createContainer.bind(client);
  const pidsLimit = limits?.pidsLimit ?? 512;
  const capDropAll = limits?.capDropAll ?? true;
  const noNewPrivileges = limits?.noNewPrivileges ?? true;
  client.createContainer = (opts: CreateContainerOptions) => {
    if (opts.Labels?.["deepsonar.job"]) {
      const prevHosts = Array.isArray(opts.HostConfig?.ExtraHosts)
        ? (opts.HostConfig!.ExtraHosts as string[])
        : [];
      const prevBinds = Array.isArray(opts.HostConfig?.Binds)
        ? (opts.HostConfig!.Binds as string[])
        : [];
      opts.HostConfig = {
        ...opts.HostConfig,
        PidsLimit: pidsLimit,
        ...(capDropAll ? { CapDrop: ["ALL"] } : {}),
        ...(noNewPrivileges ? { SecurityOpt: ["no-new-privileges:true"] } : {}),
        ...(extraHosts.length > 0
          ? { ExtraHosts: [...new Set([...prevHosts, ...extraHosts])] }
          : {}),
        ...(readonlyBinds.length > 0
          ? { Binds: [...new Set([...prevBinds, ...readonlyBinds])] }
          : {}),
      };
    }
    return orig(opts);
  };
}

type AgentboxExecHandle = AsyncIterable<{ type?: string; chunk?: string; exitCode?: number }> & {
  id?: string;
  write?: (data: string) => Promise<void>;
  kill: () => Promise<void>;
  wait?: () => Promise<unknown>;
  raw?: {
    stream?: { destroyed?: boolean; writableEnded?: boolean; writable?: boolean; end?: () => void };
    exec?: { resize?: (size: { w: number; h: number }) => Promise<void> };
  };
};

export function wrapAgentboxProcess(handle: AgentboxExecHandle): RuntimeProcess {
  let closed = false;
  const process: RuntimeProcess = {
    id: handle.id,
    get stdinClosed() {
      const stream = handle.raw?.stream;
      return closed || stream?.destroyed === true || stream?.writableEnded === true || stream?.writable === false;
    },
    async write(data) {
      if (process.stdinClosed) throw new Error("agent stdin 已关闭，无法追加消息");
      if (!handle.write) throw new Error("沙箱 exec 不支持 stdin 写入");
      try {
        await handle.write(data);
      } catch (error) {
        closed = true;
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`agent stdin 写入失败: ${msg}`);
      }
    },
    async closeStdin() {
      closed = true;
      if (handle.raw?.stream?.end) {
        try {
          handle.raw.stream.end();
        } catch {
          /* already ended */
        }
        return;
      }
      await handle.kill().catch(() => {});
    },
    kill: () => handle.kill(),
    async resize(cols, rows) {
      const resize = handle.raw?.exec?.resize;
      if (!resize) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
      await resize({
        w: Math.max(20, Math.min(240, Math.trunc(cols))),
        h: Math.max(5, Math.min(100, Math.trunc(rows))),
      });
    },
    async *[Symbol.asyncIterator](): AsyncIterator<RuntimeProcessChunk> {
      for await (const event of handle) {
        if (event.type === "stderr") yield { type: "stderr", chunk: event.chunk ?? "" };
        else if (event.type === "exit") yield { type: "exit", exitCode: event.exitCode ?? 0 };
        else yield { type: "stdout", chunk: event.chunk ?? "" };
      }
    },
  };
  return process;
}

export function createAgentboxRuntimeHost(sandbox: Sandbox): RuntimeHost {
  return {
    async run(command, options) {
      const result = await sandbox.run(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs,
      });
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    async runAsync(command, options) {
      const handle = await sandbox.runAsync(command, {
        cwd: options?.cwd,
        env: options?.env,
        pty: options?.pty,
        timeoutMs: options?.timeoutMs ?? 0,
      });
      return wrapAgentboxProcess(handle as AgentboxExecHandle);
    },
    async uploadFile(content, destPath) {
      await sandbox.uploadFile(typeof content === "string" ? content : content.toString("utf8"), destPath);
    },
    readWorkspaceFile: async (filePath, maxBytes) => {
      const inspected = await (sandbox.raw as { container?: { inspect?: () => Promise<{ Id?: string }> } } | undefined)?.container?.inspect?.();
      const containerId = inspected?.Id;
      if (!containerId) throw new Error("shared_asset_container_unavailable");
      return readDockerWorkspaceFile(containerId, filePath, maxBytes);
    },
    writeHumanInboxFile: (filePath, bytes) => writeHumanInboxWorkspaceFile(sandbox, filePath, bytes),
  };
}

export function bindProvisionAbortSignal(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => {};
  let handled = false;
  const abort = () => {
    if (handled) return;
    handled = true;
    onAbort();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}

export class AgentboxRunner implements SandboxRunner {
  constructor(
    private readonly removeContainer: (containerId: string) => Promise<void> = forceRemoveContainer,
  ) {}

  async provision(input: ProvisionInput): Promise<RunHandle> {
    if (input.signal?.aborted) throw new Error("provision 已取消");
    const provisionKey = `${input.jobId}:${input.attemptId}`;
    const extraHosts: string[] = [];
    const readonlyBinds = sharedAssetsVolumeBinds(input.sharedAssetsMount);
    if (input.sharedAssetsMount) {
      await validateSharedAssetsVolume(input.sharedAssetsMount.volumeName, input.jobId);
    }
    let gatewayCreateOwner: string | null = null;
    if (input.network !== "none") {
      if (!input.gatewayUpstreamUrl) throw new Error("real sandbox missing Gateway upstream URL");
      const proxyIps = await ensureGatewayProxy(input.gatewayUpstreamUrl, input.image, { signal: input.signal });
      gatewayCreateOwner = proxyIps.createOwner;
      extraHosts.push(`${GATEWAY_PROXY}:${input.network === "restricted" ? proxyIps.restrictedIp : proxyIps.gatewayIp}`);
    }
    const sandbox = new Sandbox("local-docker", {
      image: input.image,
      workingDir: "/workspace",
      env: input.env,
      tags: {
        "deepsonar.job": input.jobId,
        "deepsonar.attempt": input.attemptId,
        ...(input.resourceLabels ?? {}),
      },
      // SEC-03：CPU/内存硬限制（SDK 原生透传 NanoCpus/Memory）
      resources: {
        cpu: input.limits?.cpu ?? 2,
        memoryMiB: input.limits?.memoryMiB ?? 2048,
      },
      provider: {
        name: `deepsonar-${input.jobId.slice(0, 8)}`,
        binds: readonlyBinds,
        // restricted=无外网 NAT 的内部 bridge（仅保留 host-gateway 模型通道）；
        // egress=普通 bridge，Worker 可按 prompt 自主取材。
        networkMode:
          input.network === "none" ? "none" : input.network === "restricted" ? RESTRICTED_NETWORK : GATEWAY_NETWORK,
        autoRemove: true,
      },
    });
    provisioningSandboxes.set(provisionKey, sandbox);
    let aborted = false;
    const unbindAbort = bindProvisionAbortSignal(input.signal, () => {
      aborted = true;
      void sandbox.delete().catch(() => {});
    });
    hardenCreateContainer(sandbox, input.limits, extraHosts, readonlyBinds);
    try {
      await sandbox.findOrProvision();
      if (aborted || input.signal?.aborted) throw new Error("provision 已取消");
    } catch (error) {
      // Abort may arrive before the engine assigns a container id. Repeat
      // cleanup after create settles, then sweep the immutable attempt labels.
      await sandbox.delete().catch(() => {});
      await removeAttemptContainers(input.jobId, input.attemptId).catch(() => {});
      await cleanupUnhealthyManagedGateway({ expectedCreateOwner: gatewayCreateOwner }).catch(() => {});
      throw error;
    } finally {
      provisioningSandboxes.delete(provisionKey);
      unbindAbort();
    }
    const id = sandbox.id ?? `unknown-${input.jobId}`;
    sandboxes.set(id, sandbox);
    try {
      if (input.sharedAssetsMount) {
        await validateSharedAssetsContainer(sandbox, input.sharedAssetsMount.volumeName);
      }
      const contractResult = await sandbox.run(
        `test -d /workspace && test -x /bin/sh${input.sharedAssetsMount ? ` && test -d ${SHARED_ASSETS_MOUNT_PATH}` : ""} && cat /opt/deepsonar/tool-manifest.json`,
        { timeoutMs: 15_000 },
      );
      if (contractResult.exitCode !== 0) {
        throw new RuntimeImageContractError("runtime image missing /workspace, /bin/sh, or tool manifest");
      }
      // 兼容历史 OH 镜像：Dockerfile 误写 +"\\n" 导致 manifest 末尾多字面量 \n，严格 JSON.parse 失败。
      const manifest = parseToolManifest(contractResult.stdout);
      if (input.expectedContract && manifest.contract !== input.expectedContract) {
        throw new RuntimeImageContractError(`runtime contract mismatch: expected ${input.expectedContract}, got ${manifest.contract ?? "missing"}`);
      }
      if (input.expectedToolsManifestSha256) {
        const hashResult = await sandbox.run("sha256sum /opt/deepsonar/tool-manifest.json | cut -d' ' -f1", { timeoutMs: 5_000 });
        if (hashResult.exitCode !== 0 || hashResult.stdout.trim() !== input.expectedToolsManifestSha256.replace(/^sha256:/, "")) {
          throw new RuntimeImageContractError("tool manifest sha256 mismatch");
        }
      }
    } catch (error) {
      sandboxes.delete(id);
      await sandbox.delete().catch(() => {});
      if (error instanceof RuntimeImageContractError) throw error;
      throw new RuntimeImageContractError(error instanceof Error ? error.message : String(error));
    }
    return { sandboxId: id };
  }

  async cancelProvision(input: { jobId: string; attemptId: string }): Promise<void> {
    const sandbox = provisioningSandboxes.get(`${input.jobId}:${input.attemptId}`);
    let sdkError: unknown;
    if (sandbox) {
      try {
        await deleteSandboxBestEffort(sandbox);
      } catch (error) {
        sdkError = error;
      }
    }
    try {
      await removeAttemptContainers(input.jobId, input.attemptId);
    } catch (error) {
      throw new AggregateError(
        [...(sdkError === undefined ? [] : [sdkError]), error],
        `provision cancellation cleanup failed: ${input.jobId}/${input.attemptId}`,
      );
    }
  }

  async destroy(handle: RunHandle): Promise<void> {
    const sessions = terminalSessions.get(handle.sandboxId);
    terminalSessions.delete(handle.sandboxId);
    const sessionFailures: unknown[] = [];
    if (sessions) {
      const closed = await Promise.allSettled([...sessions].map((session) => session.close()));
      sessionFailures.push(...closed.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
    }
    const s = sandboxes.get(handle.sandboxId);
    sandboxes.delete(handle.sandboxId);
    let sdkDeleteError: unknown;
    if (s) {
      try {
        await deleteSandboxBestEffort(s);
      } catch (error) {
        sdkDeleteError = error;
      }
    }
    // SDK delete/autoRemove 只是一条尝试；持久化 sandboxId 的引擎删除才是最终确认。
    try {
      await this.removeContainer(handle.sandboxId);
    } catch (error) {
      throw new AggregateError(
        [...sessionFailures, ...(sdkDeleteError === undefined ? [] : [sdkDeleteError]), error],
        `sandbox destroy failed: ${handle.sandboxId}`,
      );
    }
    if (sessionFailures.length > 0) {
      throw new AggregateError(sessionFailures, `sandbox session cleanup failed: ${handle.sandboxId}`);
    }
  }

  async isAlive(handle: RunHandle): Promise<boolean> {
    const s = sandboxes.get(handle.sandboxId);
    if (s) {
      try {
        await s.run("true", { timeoutMs: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    // 兜底：重启后按容器 id 直查引擎状态
    try {
      const out = await docker("inspect", "-f", "{{.State.Running}}", handle.sandboxId);
      return out === "true";
    } catch {
      return false;
    }
  }

  async openTerminal(handle: RunHandle, input: TerminalOpenInput): Promise<SandboxTerminalSession> {
    const sandbox = sandboxes.get(handle.sandboxId);
    if (!sandbox) throw new Error("TERMINAL_SANDBOX_NOT_OWNED");
    if (sandbox.provider !== "local-docker") throw new Error("TERMINAL_PROVIDER_UNSUPPORTED");
    const cols = Math.max(20, Math.min(240, Math.trunc(input.cols)));
    const rows = Math.max(5, Math.min(100, Math.trunc(input.rows)));
    const rawProcess = await sandbox.runAsync(buildTerminalShellCommand(), {
      cwd: "/workspace",
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      pty: true,
      timeoutMs: 0,
    }) as AgentboxExecHandle;
    const process = wrapAgentboxProcess(rawProcess);
    let closed = false;
    const output = (async function* () {
      for await (const event of process) {
        if (event.type === "stdout" || event.type === "stderr") yield event.chunk;
      }
    })();
    const session: SandboxTerminalSession = {
      id: process.id ?? `term-${handle.sandboxId}`,
      output,
      write: async (data) => {
        if (closed) throw new Error("TERMINAL_SESSION_CLOSED");
        await writeTerminalInput(process, data);
      },
      resize: async (nextCols, nextRows) => {
        if (closed) throw new Error("TERMINAL_SESSION_CLOSED");
        if (!process.resize) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
        await process.resize(nextCols, nextRows);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        terminalSessions.get(handle.sandboxId)?.delete(session);
        await process.kill().catch(() => undefined);
      },
    };
    const sessions = terminalSessions.get(handle.sandboxId) ?? new Set<SandboxTerminalSession>();
    if (sessions.size >= 4) {
      await session.close();
      throw new Error("TERMINAL_SESSION_LIMIT");
    }
    sessions.add(session);
    terminalSessions.set(handle.sandboxId, sessions);
    await session.resize(cols, rows);
    void rawProcess.wait?.().catch(() => undefined).finally(() => {
      closed = true;
      terminalSessions.get(handle.sandboxId)?.delete(session);
    });
    return session;
  }

  hostOf(handle: RunHandle): RuntimeHost | undefined {
    const sandbox = sandboxes.get(handle.sandboxId);
    return sandbox ? createAgentboxRuntimeHost(sandbox) : undefined;
  }

  async ensureHost(handle: RunHandle): Promise<RuntimeHost> {
    const host = this.hostOf(handle);
    if (!host) throw new Error(`沙箱 ${handle.sandboxId} 不在注册表（可能已被回收）`);
    return host;
  }

  async listResources(filter?: { jobId?: string; attemptId?: string }): Promise<RuntimeResource[]> {
    const rows = await listDeepSonarContainers();
    return rows
      .filter((row) => (!filter?.jobId || row.jobId === filter.jobId) && (!filter?.attemptId || row.attemptId === filter.attemptId))
      .map((row) => ({
        resourceId: row.containerId,
        jobId: row.jobId,
        attemptId: row.attemptId,
        state: row.state,
      }));
  }

  async destroyResource(resource: RuntimeResource): Promise<void> {
    await this.removeContainer(resource.resourceId);
  }
}

export {
  BoundedRuntimeStderrEvidence,
  CLI_SESSION_RESUME_BASE_DELAY_MS,
  CLI_SESSION_RESUME_MAX_ATTEMPTS,
  CLI_SESSION_RESUME_MAX_DELAY_MS,
  DEFAULT_PENDING_CONTROL_TOOL_LIMIT,
  DEFAULT_SEMANTIC_TOOL_EVENTS,
  RUNTIME_STDERR_EVIDENCE_MAX_BYTES,
  classifyCliSessionResumeError,
  cliSessionResumeDelayMs,
  createSemanticToolState,
  discardPendingSemanticTools,
  ensureRuntimeHome,
  mapCliEvent,
  materializationPathCollisions,
  mergeObservedSessionIdentity,
  normalizePlainFinalOutput,
  normalizeRuntimeErrorDetails,
  parseRuntimeLine,
  redactRuntimeSecrets,
  redactToolTelemetry,
  resolveTerminalProcessOutcome,
  resolveTerminalRunError,
  runRealAgent,
  runtimeCliEnv,
  skillMaterializationPath,
} from "./runtime-agent.js";
export type {
  CliSessionResumeReason,
  ObservedSessionIdentity,
  PlainFinalOutputOptions,
  PlainFinalOutputResult,
  RealAgentResult,
  RealAgentSpec,
  ReasoningEffort,
  RuntimeErrorDetails,
  SemanticToolState,
  TerminalAttemptCloseReason,
  TerminalProcessAttempt,
  TerminalProcessOutcome,
} from "./runtime-agent.js";

async function execFileWithInput(file: string, args: string[], bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(bytes);
  });
}

/** Scheduler-owned, descriptor-relative write boundary for human-message attachments. */
export async function writeHumanInboxWorkspaceFile(
  sandbox: Pick<Sandbox, "raw">,
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  const { messageId, filename } = parseHumanInboxWorkspacePath(filePath);
  const inspected = await (sandbox.raw as { container?: { inspect?: () => Promise<{ Id?: string }> } } | undefined)?.container?.inspect?.();
  const containerId = inspected?.Id;
  if (!containerId) throw new Error("human_message_container_unavailable");
  try {
    await execFileWithInput("docker", ["exec", "-i", containerId, "python3", "-c", HUMAN_INBOX_WRITER_SCRIPT, "/workspace", messageId, filename], bytes);
  } catch {
    throw new Error("human_message_workspace_write_rejected");
  }
}

