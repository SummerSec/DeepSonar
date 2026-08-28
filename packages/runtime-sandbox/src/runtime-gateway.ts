/**
 * Scheduler-owned Model Gateway sidecar (#162).
 * OpenSandbox attaches to this proxy.
 */
import { createHash, randomUUID } from "node:crypto";
import { DEEPSONAR_GATEWAY_PROXY_HOST } from "./runtime-shared.js";
import {
  docker,
  dockerApiJson,
  dockerTimed,
  isDeepsonarGatewayNetwork,
  isDeepsonarRestrictedNetwork,
} from "./runtime-docker.js";

export const DEEPSONAR_RESTRICTED_NETWORK = "deepsonar-restricted";
export const DEEPSONAR_GATEWAY_NETWORK = "deepsonar-sandbox-gateway";
export const RESTRICTED_NETWORK = DEEPSONAR_RESTRICTED_NETWORK;
export const GATEWAY_NETWORK = DEEPSONAR_GATEWAY_NETWORK;
export const GATEWAY_PROXY = DEEPSONAR_GATEWAY_PROXY_HOST;
let restrictedNetworkReady: Promise<void> | null = null;
let gatewayNetworkReady: Promise<void> | null = null;
let gatewayProxyReady: Promise<{ containerId: string; createOwner: string | null }> | null = null;
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

export async function ensureGatewayProxy(
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
