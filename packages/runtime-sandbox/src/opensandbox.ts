/**
 * OpenSandbox adapter (#162 Phase 2). Scheduler still owns Job/Attempt state.
 * Provider SDK types stay in this module; callers only see RuntimeHost / SandboxRunner.
 */
import path from "node:path";
import {
  DEEPSONAR_GATEWAY_PROXY_HOST,
  HUMAN_INBOX_WRITER_SCRIPT,
  RuntimeImageContractError,
  SHARED_ASSETS_MOUNT_PATH,
  assertReadableWorkspacePath,
  assertSharedAssetsGuestMount,
  assertSharedAssetsVolumeOwnership,
  parseHumanInboxWorkspacePath,
  parseToolManifest,
} from "./runtime-shared.js";
import { docker } from "./runtime-docker.js";
import type { ProvisionInput, RunHandle, SandboxLimits, SandboxRunner, SandboxTerminalSession, TerminalOpenInput } from "./index.js";
import { isManagedRuntimeResource, OPENSANDBOX_ATTEMPT_META, OPENSANDBOX_JOB_META, type OpenSandboxPin } from "./opensandbox-version.js";
import {
  assertWorkspaceWritePath,
  shellQuote,
  type RuntimeHost,
  type RuntimeProcess,
  type RuntimeProcessChunk,
  type RuntimeResource,
} from "./runtime-host.js";

export { OPENSANDBOX_ATTEMPT_META, OPENSANDBOX_JOB_META } from "./opensandbox-version.js";

export interface OpenSandboxConnection {
  domain: string;
  apiKey: string;
  protocol?: "http" | "https";
  useServerProxy?: boolean;
  pin?: OpenSandboxPin;
}

export interface OpenSandboxCreateInput {
  image: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  resource: { cpu: string; memory: string; pids?: string };
  timeoutSeconds: null;
  networkPolicy: { defaultAction: "deny" | "allow"; egress: Array<{ action: "allow" | "deny"; target: string }> };
  volumes: Array<{
    name: string;
    mountPath: string;
    readOnly: true;
    pvc: { claimName: string; createIfNotExists: false };
  }>;
  /** Scheduler/PoC only. Agent and Hub cannot choose the sandbox architecture. */
  platform?: { os: "linux"; arch: "amd64" | "arm64" };
  signal?: AbortSignal;
}

export interface OpenSandboxExecHandle {
  id?: string;
  write(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  kill(): Promise<void>;
  resize?(cols: number, rows: number): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<RuntimeProcessChunk>;
}

export interface OpenSandboxSession {
  id: string;
  run(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: Buffer }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutBytes?: Buffer;
  }>;
  runAsync(command: string, options?: { cwd?: string; env?: Record<string, string>; pty?: boolean }): Promise<OpenSandboxExecHandle>;
  writeFile(destPath: string, content: string | Buffer): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  getState(): Promise<string>;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSandboxClient {
  create(input: OpenSandboxCreateInput): Promise<OpenSandboxSession>;
  connect(id: string): Promise<OpenSandboxSession | undefined>;
  list(filter?: { jobId?: string; attemptId?: string }): Promise<RuntimeResource[]>;
  destroy?(id: string): Promise<void>;
}

export const OPENSANDBOX_ALIVE_PROBE_ATTEMPTS = 3;

export async function evaluateOpenSandboxAlive(input: {
  getState: () => Promise<string>;
  probe: () => Promise<{ exitCode: number }>;
}): Promise<boolean> {
  let state: string;
  try {
    state = await input.getState();
  } catch {
    return false;
  }
  if (!/^running$/i.test(state)) return false;
  for (let attempt = 0; attempt < OPENSANDBOX_ALIVE_PROBE_ATTEMPTS; attempt++) {
    try {
      const probe = await input.probe();
      if (probe.exitCode === 0) return true;
    } catch {
      /* 单次 execd 失败不是唯一真相，继续对照 lifecycle 重试 */
    }
  }
  return false;
}

export function requireOpenSandboxLimits(limits: SandboxLimits | undefined): Required<Pick<SandboxLimits, "cpu" | "memoryMiB" | "pidsLimit">> {
  if (limits?.cpu == null || limits.cpu <= 0) throw new Error("SANDBOX_LIMITS_MISSING: cpu");
  if (limits.memoryMiB == null || limits.memoryMiB <= 0) throw new Error("SANDBOX_LIMITS_MISSING: memoryMiB");
  if (limits.pidsLimit == null || limits.pidsLimit <= 0) throw new Error("SANDBOX_LIMITS_MISSING: pidsLimit");
  if (limits.capDropAll === false) throw new Error("SANDBOX_LIMITS_INSECURE: capDropAll");
  if (limits.noNewPrivileges === false) throw new Error("SANDBOX_LIMITS_INSECURE: noNewPrivileges");
  return { cpu: limits.cpu, memoryMiB: limits.memoryMiB, pidsLimit: limits.pidsLimit };
}

export function mapOpenSandboxNetworkPolicy(
  network: ProvisionInput["network"],
  gatewayUpstreamUrl?: string,
): OpenSandboxCreateInput["networkPolicy"] {
  if (network === "none") return { defaultAction: "deny", egress: [] };
  if (network === "egress") return { defaultAction: "allow", egress: [] };
  if (!gatewayUpstreamUrl) throw new Error("real sandbox missing Gateway upstream URL");
  try {
    if (!new URL(gatewayUpstreamUrl).hostname) throw new Error("invalid Gateway upstream URL");
  } catch {
    throw new Error("invalid Gateway upstream URL");
  }
  return {
    defaultAction: "deny",
    egress: [{ action: "allow", target: DEEPSONAR_GATEWAY_PROXY_HOST }],
  };
}

export function mapOpenSandboxCreateInput(input: ProvisionInput): OpenSandboxCreateInput {
  const limits = requireOpenSandboxLimits(input.limits);
  return {
    image: input.image,
    env: input.env ?? {},
    metadata: {
      [OPENSANDBOX_JOB_META]: input.jobId,
      [OPENSANDBOX_ATTEMPT_META]: input.attemptId,
      ...(input.resourceLabels ?? {}),
    },
    resource: {
      cpu: input.kubernetesResources && !Number.isInteger(limits.cpu)
        ? `${Math.max(1, Math.round(limits.cpu * 1000))}m`
        : String(limits.cpu),
      memory: `${limits.memoryMiB}Mi`,
      ...(input.kubernetesResources ? {} : { pids: String(limits.pidsLimit) }),
    },
    timeoutSeconds: null,
    networkPolicy: mapOpenSandboxNetworkPolicy(input.network, input.gatewayUpstreamUrl),
    volumes: input.sharedAssetsMount
      ? [{
          name: input.sharedAssetsMount.volumeName,
          mountPath: SHARED_ASSETS_MOUNT_PATH,
          readOnly: true,
          pvc: { claimName: input.sharedAssetsMount.volumeName, createIfNotExists: false },
        }]
      : [],
    signal: input.signal,
  };
}

function wrapOpenSandboxProcess(handle: OpenSandboxExecHandle): RuntimeProcess {
  let closed = false;
  const process: RuntimeProcess = {
    id: handle.id,
    get stdinClosed() {
      return closed;
    },
    async write(data) {
      if (closed) throw new Error("agent stdin 已关闭，无法追加消息");
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
      await handle.closeStdin();
    },
    kill: () => handle.kill(),
    resize: handle.resize ? (cols, rows) => handle.resize!(cols, rows) : undefined,
    async *[Symbol.asyncIterator](): AsyncIterator<RuntimeProcessChunk> {
      for await (const event of { [Symbol.asyncIterator]: () => handle[Symbol.asyncIterator]() }) {
        yield event;
      }
    },
  };
  return process;
}

export function awaitProvisionSession<T>(created: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return created;
  if (signal.aborted) return Promise.reject(new Error("provision 已取消"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("provision 已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    created.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createOpenSandboxRuntimeHost(session: OpenSandboxSession): RuntimeHost {
  return {
    run: (command, options) => session.run(command, options),
    async runAsync(command, options) {
      return wrapOpenSandboxProcess(await session.runAsync(command, options));
    },
    async uploadFile(content, destPath) {
      const normalized = assertWorkspaceWritePath(destPath);
      const dir = path.posix.dirname(normalized);
      if (dir !== "/" && dir !== ".") {
        await session.run(`mkdir -p -- ${shellQuote(dir)}`);
      }
      await session.writeFile(normalized, content);
    },
    async readWorkspaceFile(filePath, maxBytes) {
      assertReadableWorkspacePath(filePath);
      const quoted = shellQuote(filePath);
      const inspect = await session.run([
        "set -eu",
        `test ! -L ${quoted} || exit 44`,
        `exec 3<${quoted}`,
        "resolved=$(readlink -f /proc/self/fd/3)",
        'case "$resolved" in /workspace/*) ;; *) exit 45 ;; esac',
        'case "$resolved" in /workspace/.deepsonar/*|/workspace/.deepsonar-home/*|/workspace/.claude/*|/workspace/.codex/*|/workspace/.opencode/*) exit 46 ;; esac',
        "test -f /proc/self/fd/3 || exit 47",
        "size=$(stat -Lc %s /proc/self/fd/3)",
        `test "$size" -le ${maxBytes} || exit 48`,
      ].join("; "));
      if (inspect.exitCode === 48) throw new Error("asset_file_too_large");
      if (inspect.exitCode === 45 || inspect.exitCode === 46) throw new Error("shared_asset_source_path_forbidden");
      if (inspect.exitCode === 44 || inspect.exitCode === 47) throw new Error("shared_asset_source_not_regular_file");
      if (inspect.exitCode !== 0) throw new Error("shared_asset_source_changed");
      const bytes = await session.readFile(filePath);
      if (bytes.byteLength > maxBytes) throw new Error("asset_file_too_large");
      return bytes;
    },
    async writeHumanInboxFile(filePath, bytes) {
      const { messageId, filename } = parseHumanInboxWorkspacePath(filePath);
      const result = await session.run(
        `python3 -c ${shellQuote(HUMAN_INBOX_WRITER_SCRIPT)} /workspace ${messageId} ${filename}`,
        { stdin: bytes, timeoutMs: 15_000 },
      );
      if (result.exitCode !== 0) throw new Error("human_message_workspace_write_rejected");
    },
  };
}

export type OpenSandboxGatewayBinder = (input: {
  sandboxId: string;
  upstreamUrl: string;
  image: string;
  signal?: AbortSignal;
}) => Promise<{ hostname: string; ip: string }>;

export interface OpenSandboxRunnerOptions {
  /**
   * Kubernetes ResourceName 不接受 Docker 专有的 `pids`。
   * 仍要求冻结 pidsLimit；只是不要写进 Pod resources。
   * Per-call `ProvisionInput.kubernetesResources` 优先。
   */
  kubernetesResources?: boolean;
  /** Docker 路径：create 前校验 Scheduler 已准备的 labeled volume，避免引擎自动建空卷。 */
  inspectSharedAssetsVolume?: (volumeName: string, jobId: string) => Promise<void>;
}

export async function inspectPreparedSharedAssetsVolume(volumeName: string, jobId: string): Promise<void> {
  const raw = await docker("volume", "inspect", volumeName, "--format", "{{json .}}");
  let inspected: unknown;
  try {
    inspected = JSON.parse(raw);
  } catch {
    throw new Error("shared assets volume inspect is not JSON");
  }
  if (!inspected || typeof inspected !== "object") {
    throw new Error("shared assets volume inspect is not JSON");
  }
  assertSharedAssetsVolumeOwnership(inspected, volumeName, jobId);
}

export class OpenSandboxRunner implements SandboxRunner {
  private readonly sessions = new Map<string, OpenSandboxSession>();
  private readonly provisioning = new Map<string, Promise<OpenSandboxSession>>();
  private readonly terminals = new Map<string, Set<SandboxTerminalSession>>();

  constructor(
    private readonly client: OpenSandboxClient,
    private readonly gateway?: { bind: OpenSandboxGatewayBinder },
    private readonly options: OpenSandboxRunnerOptions = {},
  ) {}

  async provision(input: ProvisionInput): Promise<RunHandle> {
    if (input.signal?.aborted) throw new Error("provision 已取消");
    const kubernetes = input.kubernetesResources ?? this.options.kubernetesResources;
    if (input.sharedAssetsMount && !kubernetes) {
      const inspect = this.options.inspectSharedAssetsVolume ?? inspectPreparedSharedAssetsVolume;
      await inspect(input.sharedAssetsMount.volumeName, input.jobId);
    }
    const key = `${input.jobId}:${input.attemptId}`;
    const created = this.client.create(mapOpenSandboxCreateInput({
      ...input,
      kubernetesResources: input.kubernetesResources ?? this.options.kubernetesResources,
    }));
    this.provisioning.set(key, created);
    let session: OpenSandboxSession | undefined;
    try {
      session = await awaitProvisionSession(created, input.signal);
      if (input.signal?.aborted) throw new Error("provision 已取消");
      this.sessions.set(session.id, session);
      const host = createOpenSandboxRuntimeHost(session);
      const contractResult = await host.run(
        `test -d /workspace && test -x /bin/sh${input.sharedAssetsMount ? ` && test -d ${SHARED_ASSETS_MOUNT_PATH}` : ""} && cat /opt/deepsonar/tool-manifest.json`,
        { timeoutMs: 15_000 },
      );
      if (contractResult.exitCode !== 0) {
        throw new RuntimeImageContractError("runtime image missing /workspace, /bin/sh, or tool manifest");
      }
      if (input.sharedAssetsMount) {
        const mounts = await host.run("cat /proc/mounts", { timeoutMs: 5_000 });
        if (mounts.exitCode !== 0) throw new RuntimeImageContractError("shared assets mount probe failed");
        assertSharedAssetsGuestMount(mounts.stdout);
      }
      const manifest = parseToolManifest(contractResult.stdout);
      if (input.expectedContract && manifest.contract !== input.expectedContract) {
        throw new RuntimeImageContractError(`runtime contract mismatch: expected ${input.expectedContract}, got ${manifest.contract ?? "missing"}`);
      }
      if (input.expectedToolsManifestSha256) {
        const hashResult = await host.run("sha256sum /opt/deepsonar/tool-manifest.json | cut -d' ' -f1", { timeoutMs: 5_000 });
        if (hashResult.exitCode !== 0 || hashResult.stdout.trim() !== input.expectedToolsManifestSha256.replace(/^sha256:/, "")) {
          throw new RuntimeImageContractError("tool manifest sha256 mismatch");
        }
      }
      if ((input.network === "restricted" || input.network === "egress") && this.gateway && input.gatewayUpstreamUrl) {
        const bind = await this.gateway.bind({
          sandboxId: session.id,
          upstreamUrl: input.gatewayUpstreamUrl,
          image: input.image,
          signal: input.signal,
        });
        const hosts = await host.run(
          `grep -F ${shellQuote(bind.hostname)} /etc/hosts >/dev/null || printf '%s %s\\n' ${shellQuote(bind.ip)} ${shellQuote(bind.hostname)} >> /etc/hosts`,
          { timeoutMs: 5_000 },
        );
        if (hosts.exitCode !== 0) throw new Error("failed to bind deepsonar-gateway-proxy in sandbox hosts");
      }
      return { sandboxId: session.id };
    } catch (error) {
      if (session) {
        this.sessions.delete(session.id);
        await session.kill().catch(() => {});
        await session.close().catch(() => {});
      }
      await this.destroyByLabels(input.jobId, input.attemptId).catch(() => {});
      void created.then(async (late) => {
        this.sessions.delete(late.id);
        await late.kill().catch(() => {});
        await late.close().catch(() => {});
      }).catch(() => {});
      throw error;
    } finally {
      this.provisioning.delete(key);
    }
  }

  async cancelProvision(input: { jobId: string; attemptId: string }): Promise<void> {
    const pending = this.provisioning.get(`${input.jobId}:${input.attemptId}`);
    if (pending) {
      const session = await pending.catch(() => undefined);
      if (session) {
        this.sessions.delete(session.id);
        await session.kill().catch(() => {});
        await session.close().catch(() => {});
      }
    }
    await this.destroyByLabels(input.jobId, input.attemptId);
  }

  async destroy(handle: RunHandle): Promise<void> {
    const sessions = this.terminals.get(handle.sandboxId);
    this.terminals.delete(handle.sandboxId);
    if (sessions) {
      await Promise.allSettled([...sessions].map((session) => session.close()));
    }
    await this.destroyResource({ resourceId: handle.sandboxId, jobId: "", attemptId: "" });
    await this.waitUntilGone(handle.sandboxId);
  }

  async isAlive(handle: RunHandle): Promise<boolean> {
    const session = await this.sessionOf(handle.sandboxId);
    if (!session) return false;
    return evaluateOpenSandboxAlive({
      getState: () => session.getState(),
      probe: () => session.run("true", { timeoutMs: 5_000 }),
    });
  }

  async openTerminal(handle: RunHandle, input: TerminalOpenInput): Promise<SandboxTerminalSession> {
    const host = await this.ensureHost(handle);
    const cols = Math.max(20, Math.min(240, Math.trunc(input.cols)));
    const rows = Math.max(5, Math.min(100, Math.trunc(input.rows)));
    const process = await host.runAsync(
      `sh -c ${shellQuote("if command -v bash >/dev/null 2>&1; then exec bash -il; else exec /bin/sh -i; fi")}`,
      {
        cwd: "/workspace",
        env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
        pty: true,
      },
    );
    if (!process.resize) throw new Error("TERMINAL_RESIZE_UNSUPPORTED");
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
        await process.write(data);
      },
      resize: async (nextCols, nextRows) => {
        if (closed) throw new Error("TERMINAL_SESSION_CLOSED");
        await process.resize?.(nextCols, nextRows);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.terminals.get(handle.sandboxId)?.delete(session);
        await process.kill().catch(() => undefined);
      },
    };
    const sessions = this.terminals.get(handle.sandboxId) ?? new Set<SandboxTerminalSession>();
    if (sessions.size >= 4) {
      await session.close();
      throw new Error("TERMINAL_SESSION_LIMIT");
    }
    sessions.add(session);
    this.terminals.set(handle.sandboxId, sessions);
    await session.resize(cols, rows);
    return session;
  }

  hostOf(handle: RunHandle): RuntimeHost | undefined {
    const session = this.sessions.get(handle.sandboxId);
    return session ? createOpenSandboxRuntimeHost(session) : undefined;
  }

  async ensureHost(handle: RunHandle): Promise<RuntimeHost> {
    const session = await this.sessionOf(handle.sandboxId);
    if (!session) throw new Error(`沙箱 ${handle.sandboxId} 不在注册表（可能已被回收）`);
    return createOpenSandboxRuntimeHost(session);
  }

  async listResources(filter?: { jobId?: string; attemptId?: string }): Promise<RuntimeResource[]> {
    return (await this.client.list(filter)).filter(isManagedRuntimeResource);
  }

  async destroyResource(resource: RuntimeResource): Promise<void> {
    const cached = this.sessions.get(resource.resourceId);
    this.sessions.delete(resource.resourceId);
    if (cached) {
      await cached.kill().catch(() => {});
      await cached.close().catch(() => {});
      return;
    }
    if (this.client.destroy) {
      await this.client.destroy(resource.resourceId);
      return;
    }
    if (cached) return;
    const session = await this.client.connect(resource.resourceId);
    if (!session) return;
    await session.kill();
    await session.close();
  }

  private async sessionOf(id: string): Promise<OpenSandboxSession | undefined> {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const session = await this.client.connect(id);
    if (session) this.sessions.set(id, session);
    return session;
  }

  private async destroyByLabels(jobId: string, attemptId: string): Promise<void> {
    const leftovers = await this.client.list({ jobId, attemptId });
    for (const resource of leftovers) {
      await this.destroyResource(resource);
    }
  }

  private async waitUntilGone(resourceId: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const items = await this.client.list();
      if (!items.some((item) => item.resourceId === resourceId)) return;
      await this.destroyResource({ resourceId, jobId: "", attemptId: "" }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`OPENSANDBOX_DESTROY_LEFTOVER: ${resourceId}`);
  }
}

export { createSdkOpenSandboxClient } from "./opensandbox-sdk-client.js";
