/**
 * agentbox-sdk（TwillAI, MIT）真实实现 —— ARCHITECTURE §5/§8
 *
 * 要点：
 * - agentbox 只作沙箱（容器生命周期 + exec + 文件上下行）；Agent 由受治理的
 *   Runtime Adapter 通过官方结构化 CLI 协议直接在沙箱内驱动，不走 SDK daemon/relay。
 * - assistant tool_use 先只进入宿主 bounded pending 表；对应的合法非错误 tool_result
 *   （is_error 省略或为 false）后才释放语义事件，不经过沙箱目标网络，也不依赖 Agent 可写文件。
 */
import { Sandbox } from "agentbox-sdk";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEEPSONAR_GATEWAY_PROXY_HOST,
  HUMAN_INBOX_WRITER_SCRIPT,
  RuntimeImageContractError,
  SHARED_ASSETS_MOUNT_PATH,
  assertSharedAssetsVolumeOwnership,
  parseToolManifest,
} from "./runtime-shared.js";
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

const execFileP = promisify(execFile);
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONTAINER_REMOVE_MAX_ATTEMPTS = 5;
export const CONTAINER_REMOVE_RETRY_BASE_DELAY_MS = 500;
export const CONTAINER_REMOVE_TIMEOUT_MS = 120_000;

/** docker CLI 兜底（进程重启后内存注册表丢失，按持久化 sandboxId 直查引擎） */
async function docker(...args: string[]): Promise<string> {
  return dockerTimed(15_000, args);
}

type DockerCommand = (...args: string[]) => Promise<string>;
type Sleep = (delayMs: number) => Promise<void>;

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

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

function isNoSuchContainerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such container|no container with name or id .* found|container .* (?:not found|does not exist)/i.test(message);
}

export async function removeContainerWithRetry(
  containerId: string,
  executeDocker: DockerCommand = (...args) => dockerTimed(CONTAINER_REMOVE_TIMEOUT_MS, args),
  wait: Sleep = sleep,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONTAINER_REMOVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await executeDocker("rm", "-f", containerId);
      return;
    } catch (error) {
      if (isNoSuchContainerError(error)) return;
      lastError = error;
      if (attempt < CONTAINER_REMOVE_MAX_ATTEMPTS) {
        await wait(CONTAINER_REMOVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

async function dockerTimed(timeoutMs: number, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileP("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = [err.stderr, err.stdout, err.message]
      .map((part) => (typeof part === "string" ? part : part?.toString?.() ?? ""))
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(detail || `docker ${args.join(" ")} failed`);
  }
}

const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";
/** Same default dockerode / Docker Desktop use on Windows. */
const DEFAULT_WINDOWS_PIPE = "//./pipe/docker_engine";

/** Resolve the Engine socket used by the scheduler host (unix socket or Windows named pipe). */
export function dockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const host = env.DOCKER_HOST?.trim();
  if (host?.startsWith("unix://")) return host.slice("unix://".length) || DEFAULT_UNIX_SOCKET;
  if (host?.startsWith("npipe://")) return host.slice("npipe://".length) || DEFAULT_WINDOWS_PIPE;
  if (!host || host.startsWith("tcp://") || host.startsWith("http://") || host.startsWith("https://")) {
    return platform === "win32" ? DEFAULT_WINDOWS_PIPE : DEFAULT_UNIX_SOCKET;
  }
  return host;
}

/**
 * Docker Engine / Podman compatibility API over the unix socket.
 *
 * Prefer this for network inspect/create: recent docker CLI fails on Podman
 * networks whose IPAM Gateway is the literal string "<nil>" with
 * `ParseAddr("<nil>"): unable to parse IP`. The HTTP API returns usable JSON.
 */
export async function dockerApiJson(
  pathname: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
  const timeoutMs = init?.timeoutMs ?? 15_000;
  const socketPath = dockerSocketPath();
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: pathname,
        method,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            reject(new Error(`docker API ${method} ${pathname} -> ${status}: ${text.slice(0, 400)}`));
            return;
          }
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`docker API ${method} ${pathname} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** True when a network inspect payload is our managed internal bridge. */
export function isDeepsonarRestrictedNetwork(net: Record<string, unknown> | null | undefined): boolean {
  if (!net || typeof net !== "object") return false;
  const internal = net.Internal ?? net.internal;
  const driver = String(net.Driver ?? net.driver ?? "");
  const labelsRaw = net.Labels ?? net.labels;
  const labels = labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
    ? labelsRaw as Record<string, unknown>
    : {};
  return internal === true && driver === "bridge" && String(labels["deepsonar.managed"] ?? "") === "true";
}

/** True when a network is the Scheduler-owned NAT bridge for real sandboxes. */
export function isDeepsonarGatewayNetwork(net: Record<string, unknown> | null | undefined): boolean {
  if (!net || typeof net !== "object") return false;
  const internal = net.Internal ?? net.internal;
  const driver = String(net.Driver ?? net.driver ?? "");
  const labelsRaw = net.Labels ?? net.labels;
  const labels = labelsRaw && typeof labelsRaw === "object" && !Array.isArray(labelsRaw)
    ? labelsRaw as Record<string, unknown>
    : {};
  return internal !== true && driver === "bridge" && String(labels["deepsonar.managed"] ?? "") === "true";
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
const RESTRICTED_NETWORK = "deepsonar-restricted";
const GATEWAY_NETWORK = "deepsonar-sandbox-gateway";
const GATEWAY_PROXY = DEEPSONAR_GATEWAY_PROXY_HOST;
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

export const GATEWAY_PROXY_SCRIPT = String.raw`
const http = require("node:http");
const https = require("node:https");
const upstream = new URL(process.env.DEEPSONAR_GATEWAY_UPSTREAM);
const prefix = upstream.pathname.replace(/\/$/, "");
const controlPrefix = "/control/v1";
const client = upstream.protocol === "https:" ? https : http;
const server = http.createServer((req, res) => {
  const incoming = new URL(req.url || "/", "http://proxy.local");
  if (incoming.pathname === "/_deepsonar_health") {
    res.writeHead(200).end("ok");
    return;
  }
  const isGatewayPath = incoming.pathname === prefix || incoming.pathname.startsWith(prefix + "/");
  const isControlPath = incoming.pathname === controlPrefix || incoming.pathname.startsWith(controlPrefix + "/");
  // The sidecar is intentionally a fixed-path forwarder. It exposes the
  // existing model Gateway and the Job-scoped control API only; arbitrary
  // proxying, CONNECT, and other Scheduler routes remain unavailable.
  if (!isGatewayPath && !isControlPath) {
    res.writeHead(404).end("not found");
    return;
  }
  const headers = { ...req.headers, host: upstream.host };
  delete headers.connection;
  delete headers["proxy-authorization"];
  const fail = () => {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(502).end("gateway unavailable");
  };
  const target = client.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: incoming.pathname + incoming.search,
    headers,
  }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.on("error", fail);
    reply.pipe(res);
  });
  target.on("error", fail);
  const abort = () => {
    target.destroy();
    res.destroy();
  };
  req.on("error", abort);
  req.on("aborted", abort);
  req.pipe(target);
});
server.on("connect", (_req, socket) => socket.destroy());
server.listen(3100, "0.0.0.0");
`;

export const GATEWAY_PROXY_REVISION = createHash("sha256")
  .update(GATEWAY_PROXY_SCRIPT)
  .digest("hex")
  .slice(0, 16);

export const DEFAULT_GATEWAY_CREATE_TIMEOUT_MS = 600_000;

export function gatewayCreateTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = DEFAULT_GATEWAY_CREATE_TIMEOUT_MS,
): number {
  const raw = Number(env.DEEPSONAR_GATEWAY_CREATE_TIMEOUT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : fallbackMs;
}

export function gatewayProxyReuseAction(input: {
  managed: string;
  upstreamHash: string;
  revision: string;
  running: string;
  status?: string;
}, expectedUpstreamHash: string): "reuse" | "start" | "replace" | "reject" {
  if (input.managed !== "true") return "reject";
  if (input.upstreamHash !== expectedUpstreamHash || input.revision !== GATEWAY_PROXY_REVISION) return "replace";
  if (input.status === "created") return "replace";
  return input.running === "true" ? "reuse" : "start";
}

export type GatewayLeftoverStatus = "created" | "running" | "exited" | "missing";

export function shouldRemoveGatewayLeftover(input: {
  managed: string;
  createOwner: string;
  expectedCreateOwner: string | null;
  status: GatewayLeftoverStatus;
  healthy: boolean;
}): boolean {
  if (input.managed !== "true" || !input.expectedCreateOwner || input.createOwner !== input.expectedCreateOwner) return false;
  if (input.status === "missing") return false;
  if (input.healthy && input.status === "running") return false;
  return true;
}

export function gatewayLeftoverRemovalTarget(
  input: Parameters<typeof shouldRemoveGatewayLeftover>[0] & { id: string },
): string | null {
  return input.id && shouldRemoveGatewayLeftover(input) ? input.id : null;
}

/**
 * Docker internal bridge 不做外网 NAT；模型请求由另一个固定目标 sidecar 转发。
 * 网络是宿主级共享资源，创建操作幂等，并发首次 provision 共用同一 Promise。
 *
 * Inspect/create go through the Engine HTTP API so Podman rootless works:
 * `docker network inspect --format …` dies on IPAM Gateway="<nil>" (ParseAddr).
 */
async function ensureRestrictedNetwork(): Promise<void> {
  restrictedNetworkReady ??= (async () => {
    const validate = async () => {
      const net = await dockerApiJson(`/networks/${encodeURIComponent(RESTRICTED_NETWORK)}`) as Record<string, unknown>;
      if (!isDeepsonarRestrictedNetwork(net)) {
        throw new Error(`Docker 网络 ${RESTRICTED_NETWORK} 存在但不是 DEEPSONAR 管理的 internal bridge`);
      }
    };
    try {
      await validate();
      return;
    } catch {
      try {
        await dockerApiJson("/networks/create", {
          method: "POST",
          body: {
            Name: RESTRICTED_NETWORK,
            Driver: "bridge",
            Internal: true,
            Labels: { "deepsonar.managed": "true" },
          },
        });
      } catch (createError) {
        const msg = createError instanceof Error ? createError.message : String(createError);
        // Already exists (409) — re-validate below. Other errors: try CLI create once.
        if (!/\b409\b|already exists|Conflict/i.test(msg)) {
          await docker(
            "network", "create", "--driver", "bridge", "--internal",
            "--label", "deepsonar.managed=true", RESTRICTED_NETWORK,
          ).catch(async (cliError) => {
            await validate().catch(() => {
              throw cliError instanceof Error ? cliError : createError;
            });
          });
        }
      }
      await validate();
    }
  })();
  return restrictedNetworkReady;
}

/** Create/validate the shared non-internal bridge used by egress sandboxes. */
async function ensureGatewayNetwork(): Promise<void> {
  gatewayNetworkReady ??= (async () => {
    const validate = async () => {
      const net = await dockerApiJson(`/networks/${encodeURIComponent(GATEWAY_NETWORK)}`) as Record<string, unknown>;
      if (!isDeepsonarGatewayNetwork(net)) throw new Error(`Docker network ${GATEWAY_NETWORK} is not a managed NAT bridge`);
    };
    try {
      await validate();
      return;
    } catch {
      try {
        await dockerApiJson("/networks/create", {
          method: "POST",
          body: { Name: GATEWAY_NETWORK, Driver: "bridge", Internal: false, Labels: { "deepsonar.managed": "true" } },
        });
      } catch (createError) {
        const msg = createError instanceof Error ? createError.message : String(createError);
        if (!/\b409\b|already exists|Conflict/i.test(msg)) {
          await docker("network", "create", "--driver", "bridge", "--label", "deepsonar.managed=true", GATEWAY_NETWORK)
            .catch(async (cliError) => {
              await validate().catch(() => { throw cliError instanceof Error ? cliError : createError; });
            });
        }
      }
      await validate();
    }
  })();
  return gatewayNetworkReady;
}

/**
 * internal bridge 不能直达 Docker Desktop 宿主。共享 sidecar 同时连普通 bridge 和
 * internal bridge，但代码只允许把 /gateway 路径转发到唯一上游，不提供 CONNECT 或任意目标代理。
 *
 * 返回 sidecar 在 restricted 网上的 IPv4，供沙箱 ExtraHosts 注入：rootless Podman 的
 * internal bridge 常无嵌入式 DNS，容器名 `deepsonar-gateway-proxy` 解析失败会表现为
 * Claude Code `Unable to connect to API (ENOTIMP)` / curl Could not resolve host。
 */
async function inspectGatewayProxy(): Promise<{
  exists: boolean;
  id: string;
  managed: string;
  upstreamHash: string;
  revision: string;
  createOwner: string;
  running: string;
  status: string;
}> {
  const id = await docker("ps", "-a", "--filter", `name=^/${GATEWAY_PROXY}$`, "--format", "{{.ID}}");
  if (!id) {
    return { exists: false, id: "", managed: "", upstreamHash: "", revision: "", createOwner: "", running: "false", status: "missing" };
  }
  const state = await docker(
    "inspect", "--format",
    "{{index .Config.Labels \"deepsonar.managed\"}}|{{index .Config.Labels \"deepsonar.gateway-upstream\"}}|{{index .Config.Labels \"deepsonar.gateway-revision\"}}|{{index .Config.Labels \"deepsonar.gateway-create-owner\"}}|{{.State.Running}}|{{.State.Status}}",
    id,
  );
  const [managed, configuredHash, revision, createOwner, running, status] = state.split("|");
  return {
    exists: true,
    id,
    managed: managed ?? "",
    upstreamHash: configuredHash ?? "",
    revision: revision ?? "",
    createOwner: createOwner ?? "",
    running: running ?? "false",
    status: status ?? "",
  };
}

function leftoverStatusOf(inspected: { exists: boolean; running: string; status: string }): GatewayLeftoverStatus {
  if (!inspected.exists || inspected.status === "missing") return "missing";
  if (inspected.status === "created") return "created";
  if (inspected.running === "true" || inspected.status === "running") return "running";
  return "exited";
}

export async function cleanupUnhealthyManagedGateway(input: { expectedCreateOwner: string | null }): Promise<void> {
  const inspected = await inspectGatewayProxy().catch(() => ({
    exists: false, id: "", managed: "", upstreamHash: "", revision: "", createOwner: "", running: "false", status: "missing",
  }));
  const removalTarget = gatewayLeftoverRemovalTarget({
    id: inspected.id,
    managed: inspected.managed,
    createOwner: inspected.createOwner,
    expectedCreateOwner: input.expectedCreateOwner,
    status: leftoverStatusOf(inspected),
    healthy: inspected.running === "true" && inspected.status === "running",
  });
  if (!removalTarget) return;
  try {
    await docker("rm", "-f", removalTarget);
    gatewayProxyReady = null;
  } catch {
    // 下一次 ensure 会重新 inspect；删除失败时保留当前状态，避免并发重复创建。
  }
}

async function ensureGatewayProxy(
  upstreamUrl: string,
  image: string,
  options: { createTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ gatewayIp: string; restrictedIp: string; createOwner: string | null }> {
  const run = async () => {
    await ensureGatewayNetwork();
    await ensureRestrictedNetwork();
    const parsed = new URL(upstreamUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Gateway sidecar 不支持上游协议: ${parsed.protocol}`);
    }
    if (!parsed.pathname.startsWith("/gateway")) {
      throw new Error("Gateway sidecar 上游 URL 必须以 /gateway 为路径");
    }
    const upstreamHash = createHash("sha256").update(upstreamUrl).digest("hex").slice(0, 16);
    const inspected = await inspectGatewayProxy();
    let exists = inspected.exists;
    let containerId = inspected.id;
    let createOwner: string | null = null;
    if (exists) {
      const action = gatewayProxyReuseAction({
        managed: inspected.managed,
        upstreamHash: inspected.upstreamHash,
        revision: inspected.revision,
        running: inspected.running,
        status: inspected.status,
      }, upstreamHash);
      if (action === "reject") throw new Error(`${GATEWAY_PROXY} 不是 DeepSonar 受管容器，拒绝接管`);
      if (action === "replace") {
        await docker("rm", "-f", inspected.id);
        exists = false;
        containerId = "";
      } else if (action === "start") {
        await docker("start", inspected.id);
      }
    }
    if (!exists) {
      createOwner = randomUUID();
      try {
        containerId = await dockerTimed(options.createTimeoutMs ?? gatewayCreateTimeoutMs(), [
          "run", "-d", "--name", GATEWAY_PROXY, "--restart", "unless-stopped",
          "--network", GATEWAY_NETWORK, "--add-host", "host.docker.internal:host-gateway",
          "--label", "deepsonar.managed=true",
          "--label", `deepsonar.gateway-upstream=${upstreamHash}`,
          "--label", `deepsonar.gateway-revision=${GATEWAY_PROXY_REVISION}`,
          "--label", `deepsonar.gateway-create-owner=${createOwner}`,
          "-e", `DEEPSONAR_GATEWAY_UPSTREAM=${upstreamUrl}`,
          "--entrypoint", "node", image, "-e", GATEWAY_PROXY_SCRIPT,
        ], options.signal);
      } catch (error) {
        await cleanupUnhealthyManagedGateway({ expectedCreateOwner: createOwner });
        throw error;
      }
    }
    const inspect = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId)) as Record<string, unknown>;
    if (!(GATEWAY_NETWORK in inspect)) {
      await docker("network", "connect", "--alias", GATEWAY_PROXY, GATEWAY_NETWORK, containerId).catch(async () => {
        await docker("network", "connect", GATEWAY_NETWORK, containerId).catch(() => {});
        const refreshed = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId)) as Record<string, unknown>;
        if (!(GATEWAY_NETWORK in refreshed)) throw new Error(`${GATEWAY_PROXY} could not join ${GATEWAY_NETWORK}`);
      });
    }
    if (!(RESTRICTED_NETWORK in inspect)) {
      try {
        await docker("network", "connect", "--alias", GATEWAY_PROXY, RESTRICTED_NETWORK, containerId);
      } catch {
        await docker("network", "connect", RESTRICTED_NETWORK, containerId);
      }
    }
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        await docker(
          "exec", containerId, "node", "-e",
          "fetch('http://127.0.0.1:3100/_deepsonar_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) {
      await cleanupUnhealthyManagedGateway({ expectedCreateOwner: createOwner });
      throw new Error(`${GATEWAY_PROXY} 启动后未通过健康检查`);
    }
    return { containerId, createOwner };
  };
  if (!gatewayProxyReady) {
    gatewayProxyReady = run().catch((error) => {
      gatewayProxyReady = null;
      throw error;
    });
  }
  const readyGateway = await gatewayProxyReady;
  const nets = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", readyGateway.containerId)) as Record<
    string,
    { IPAddress?: string }
  >;
  const gatewayIp = nets[GATEWAY_NETWORK]?.IPAddress?.trim();
  const ip = nets[RESTRICTED_NETWORK]?.IPAddress?.trim();
  if (!gatewayIp) throw new Error(`${GATEWAY_PROXY} is not attached to ${GATEWAY_NETWORK}`);
  if (!ip) throw new Error(`${GATEWAY_PROXY} 未接入 ${RESTRICTED_NETWORK} 或缺少 IPv4`);
  return { gatewayIp, restrictedIp: ip, createOwner: readyGateway.createOwner };
}

export async function preheatManagedGateway(input: {
  upstreamUrl: string;
  image: string;
  createTimeoutMs?: number;
}): Promise<void> {
  await ensureGatewayProxy(input.upstreamUrl, input.image, { createTimeoutMs: input.createTimeoutMs });
}

/** Attach the path-filtering sidecar to an OpenSandbox egress network and return its IPv4. */
export async function bindGatewayProxyToOpenSandboxNetwork(input: {
  sandboxId: string;
  upstreamUrl: string;
  image: string;
  signal?: AbortSignal;
}): Promise<{ hostname: string; ip: string }> {
  await ensureGatewayProxy(input.upstreamUrl, input.image, { signal: input.signal });
  const sandboxName = `sandbox-${input.sandboxId}`;
  const egressName = `sandbox-egress-${input.sandboxId}`;
  let peer = egressName;
  try {
    await docker("inspect", "--format", "{{.Id}}", egressName);
  } catch {
    const mode = (await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", sandboxName)).trim();
    peer = mode.startsWith("container:") ? mode.slice("container:".length) : sandboxName;
  }
  const peerNets = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", peer)) as Record<
    string,
    { IPAddress?: string }
  >;
  const networkName = Object.keys(peerNets).find((name) => peerNets[name]?.IPAddress?.trim());
  if (!networkName) throw new Error("OpenSandbox sandbox has no IPv4 network for Gateway proxy");
  const proxyId = (await docker("inspect", "--format", "{{.Id}}", GATEWAY_PROXY)).trim();
  const proxyNets = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", proxyId)) as Record<
    string,
    { IPAddress?: string }
  >;
  if (!(networkName in proxyNets)) {
    try {
      await docker("network", "connect", "--alias", GATEWAY_PROXY, networkName, proxyId);
    } catch {
      await docker("network", "connect", networkName, proxyId);
    }
  }
  const refreshed = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", proxyId)) as Record<
    string,
    { IPAddress?: string }
  >;
  const ip = refreshed[networkName]?.IPAddress?.trim();
  if (!ip) throw new Error(`${GATEWAY_PROXY} missing IPv4 on ${networkName}`);
  return { hostname: GATEWAY_PROXY, ip };
}

export function resetManagedGatewayStateForTests(): void {
  gatewayProxyReady = null;
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
    readWorkspaceFile: (filePath, maxBytes) => readSandboxWorkspaceFile(sandbox, filePath, maxBytes),
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


// ---------- 重启 reconcile 用的引擎直查（JOB-04） ----------

export interface DeepSonarContainer {
  containerId: string;
  jobId: string;
  attemptId: string;
  state: string;
}

export function parseDeepSonarContainerRows(out: string): DeepSonarContainer[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [containerId = "", labels = "", state = ""] = line.split("\t");
      const jobId = labels
        .split(",")
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith("deepsonar.job="))
        ?.slice("deepsonar.job=".length);
      const attemptId = labels
        .split(",")
        .map((pair) => pair.trim())
        .find((pair) => pair.startsWith("deepsonar.attempt="))
        ?.slice("deepsonar.attempt=".length);
      return {
        containerId,
        jobId: CANONICAL_UUID_RE.test(jobId ?? "") ? jobId!.toLowerCase() : "",
        attemptId: CANONICAL_UUID_RE.test(attemptId ?? "") ? attemptId!.toLowerCase() : "",
        state,
      };
    })
    .filter((container) => container.containerId && container.jobId && container.attemptId);
}

/** 只枚举同时带 canonical Job/Attempt 双标签的容器（含已退出）。 */
export async function listDeepSonarContainers(): Promise<DeepSonarContainer[]> {
  // 注意：docker ps 的 .Labels 是字符串（非 map），不能直接 index，取回后自行解析。
  const out = await docker(
    "ps", "-a",
    "--filter", "label=deepsonar.job",
    "--filter", "label=deepsonar.attempt",
    "--format", "{{.ID}}\t{{.Labels}}\t{{.State}}",
  );
  return parseDeepSonarContainerRows(out);
}

/** 强删容器（孤儿回收） */
export async function forceRemoveContainer(containerId: string): Promise<void> {
  await removeContainerWithRetry(containerId);
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

export async function readSandboxWorkspaceFile(sandbox: Sandbox, filePath: string, maxBytes: number): Promise<Buffer> {
  const reservedRoots = [
    "/workspace/.deepsonar",
    "/workspace/.deepsonar-home",
    SHARED_ASSETS_MOUNT_PATH,
    "/workspace/.claude",
    "/workspace/.codex",
    "/workspace/.opencode",
  ];
  if (
    !filePath.startsWith("/workspace/") ||
    reservedRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`))
  ) {
    throw new Error("shared_asset_source_path_forbidden");
  }
  const inspected = await (sandbox.raw as { container?: { inspect?: () => Promise<{ Id?: string }> } } | undefined)?.container?.inspect?.();
  const containerId = inspected?.Id;
  if (!containerId) throw new Error("shared_asset_container_unavailable");
  const quoted = shellQuote(filePath);
  const command = [
    "set -eu",
    `test ! -L ${quoted} || exit 44`,
    `exec 3<${quoted}`,
    "resolved=$(readlink -f /proc/self/fd/3)",
    'case "$resolved" in /workspace/*) ;; *) exit 45 ;; esac',
    'case "$resolved" in /workspace/.deepsonar/*|/workspace/.deepsonar-home/*|/workspace/.claude/*|/workspace/.codex/*|/workspace/.opencode/*) exit 46 ;; esac',
    "test -f /proc/self/fd/3 || exit 47",
    "size=$(stat -Lc %s /proc/self/fd/3)",
    `test "$size" -le ${maxBytes} || exit 48`,
    "cat <&3",
  ].join("; ");
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "docker",
      ["exec", containerId, "/bin/sh", "-c", command],
      { timeout: 15_000, encoding: "buffer", maxBuffer: maxBytes + 1 },
      (error, stdout) => {
        if (error) {
          const code = (error as unknown as { code?: string | number }).code;
          if (code === 48 || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("asset_file_too_large"));
          if (code === 45 || code === 46) return reject(new Error("shared_asset_source_path_forbidden"));
          if (code === 44 || code === 47) return reject(new Error("shared_asset_source_not_regular_file"));
          return reject(new Error("shared_asset_source_changed"));
        }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (bytes.byteLength > maxBytes) return reject(new Error("asset_file_too_large"));
        resolve(bytes);
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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
  const normalized = path.posix.normalize(filePath);
  const match = /^\/workspace\/\.deepsonar\/inbox\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]{1,240})$/iu.exec(filePath);
  if (normalized !== filePath || !match) throw new Error("human_message_workspace_path_forbidden");
  const inspected = await (sandbox.raw as { container?: { inspect?: () => Promise<{ Id?: string }> } } | undefined)?.container?.inspect?.();
  const containerId = inspected?.Id;
  if (!containerId) throw new Error("human_message_container_unavailable");
  try {
    await execFileWithInput("docker", ["exec", "-i", containerId, "python3", "-c", HUMAN_INBOX_WRITER_SCRIPT, "/workspace", match[1], match[2]], bytes);
  } catch {
    throw new Error("human_message_workspace_write_rejected");
  }
}

