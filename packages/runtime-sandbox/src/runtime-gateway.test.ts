import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isNoSuchContainerError } from "./runtime-docker.js";
import {
  GATEWAY_NETWORK,
  GATEWAY_PROXY,
  GATEWAY_PROXY_REVISION,
  GATEWAY_PROXY_SCRIPT,
  RESTRICTED_NETWORK,
  gatewayUpstreamHash,
  gatewayUpstreamSocketFromEnv,
  bindGatewayProxyToOpenSandboxNetwork,
  ensureGatewayProxy,
  resetManagedGatewayStateForTests,
  setGatewayDockerForTests,
} from "./runtime-gateway.js";

const UPSTREAM = "http://127.0.0.1:3100/gateway";
const IMAGE = `img@sha256:${"a".repeat(64)}`;
const UPSTREAM_HASH = createHash("sha256").update(UPSTREAM).digest("hex").slice(0, 16);
const MANAGED_NETS = {
  [GATEWAY_NETWORK]: { Internal: false, Driver: "bridge", Labels: { "deepsonar.managed": "true" } },
  [RESTRICTED_NETWORK]: { Internal: true, Driver: "bridge", Labels: { "deepsonar.managed": "true" } },
} as const;

type LiveGateway = {
  id: string;
  managed?: string;
  upstreamHash?: string;
  revision?: string;
  createOwner?: string;
  running?: string;
  status?: string;
  networks?: Record<string, { IPAddress?: string }>;
};

function defaultNetworks(): Record<string, { IPAddress?: string }> {
  return {
    [GATEWAY_NETWORK]: { IPAddress: "172.18.0.2" },
    [RESTRICTED_NETWORK]: { IPAddress: "172.19.0.2" },
  };
}

function createGatewayDockerFake(input: {
  live: () => LiveGateway | null;
  onCreate?: () => string;
  inspectError?: (id: string) => Error | null;
}) {
  const calls: string[][] = [];
  const docker = async (...args: string[]) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "ps") return input.live()?.id ?? "";
    if (cmd === "inspect") {
      const format = args[2] ?? "";
      const target = args.at(-1) ?? "";
      if (target.startsWith("sandbox-egress-")) {
        if (format.includes("json .NetworkSettings.Networks")) {
          return JSON.stringify({ "sandbox-egress-net": { IPAddress: "172.20.0.5" } });
        }
        return target;
      }
      if (target.startsWith("sandbox-")) {
        if (format.includes("NetworkMode")) return "bridge";
        if (format.includes("json .NetworkSettings.Networks")) {
          return JSON.stringify({ "sandbox-egress-net": { IPAddress: "172.20.0.5" } });
        }
        return target;
      }
      const injected = input.inspectError?.(target);
      if (injected) throw injected;
      const live = input.live();
      if (!live || (target !== live.id && target !== GATEWAY_PROXY)) {
        throw new Error(`Error: No such object: ${target}`);
      }
      if (format.includes("json .NetworkSettings.Networks")) return JSON.stringify(live.networks ?? defaultNetworks());
      if (format.includes("deepsonar.managed")) {
        return [
          live.managed ?? "true",
          live.upstreamHash ?? UPSTREAM_HASH,
          live.revision ?? GATEWAY_PROXY_REVISION,
          live.createOwner ?? "owner",
          live.running ?? "true",
          live.status ?? "running",
        ].join("|");
      }
      if (format === "{{.Id}}") return live.id;
      throw new Error(`unexpected inspect format ${format}`);
    }
    if (cmd === "exec" || cmd === "start" || cmd === "rm") return "";
    if (cmd === "network" && args[1] === "connect") {
      const networkName = args[2] === "--alias" ? args[4] : args[2];
      const live = input.live();
      if (live && networkName) {
        live.networks = { ...(live.networks ?? defaultNetworks()), [networkName]: { IPAddress: "172.20.0.8" } };
      }
      return "";
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  const dockerTimed = async (_timeoutMs: number, args: string[]) => {
    calls.push(["run", ...args]);
    const created = input.onCreate?.();
    if (!created) throw new Error("unexpected docker run");
    return created;
  };
  const dockerApiJson = async (pathname: string) => {
    const name = decodeURIComponent(pathname.replace(/^\/networks\//, ""));
    const net = MANAGED_NETS[name as keyof typeof MANAGED_NETS];
    if (net) return net;
    throw new Error(`unexpected docker API ${pathname}`);
  };
  return { docker, dockerTimed, dockerApiJson, calls };
}

function countPs(calls: string[][]): number {
  return calls.filter((args) => args[0] === "ps").length;
}

function countCreates(calls: string[][]): number {
  return calls.filter((args) => args[0] === "run" && args[1] === "run").length;
}

test("Docker missing-container matcher accepts no such object", () => {
  assert.equal(isNoSuchContainerError(new Error("Error: No such object: abc")), true);
  assert.equal(isNoSuchContainerError(new Error("Error response from daemon: No such container: abc")), true);
  assert.equal(isNoSuchContainerError(new Error("permission denied")), false);
});

test.describe("managed gateway stale cache rediscovery", { concurrency: 1 }, () => {
  test.afterEach(() => {
    resetManagedGatewayStateForTests();
  });

  test("ensureGatewayProxy rediscovers a rebuilt sidecar with the same revision", async () => {
    let live: LiveGateway = { id: "old-gateway" };
    const fake = createGatewayDockerFake({ live: () => live });
    setGatewayDockerForTests(fake);
    const first = await ensureGatewayProxy(UPSTREAM, IMAGE);
    assert.equal(first.restrictedIp, "172.19.0.2");
    assert.equal(countCreates(fake.calls), 0);
    live = { id: "new-gateway", networks: {
      [GATEWAY_NETWORK]: { IPAddress: "172.18.0.9" },
      [RESTRICTED_NETWORK]: { IPAddress: "172.19.0.9" },
    } };
    const second = await ensureGatewayProxy(UPSTREAM, IMAGE);
    assert.equal(second.restrictedIp, "172.19.0.9");
    assert.equal(second.gatewayIp, "172.18.0.9");
    assert.ok(countPs(fake.calls) >= 2);
    assert.equal(countCreates(fake.calls), 0);
  });

  test("ensureGatewayProxy replaces a rebuilt sidecar whose revision is stale", async () => {
    let live: LiveGateway | null = { id: "old-gateway" };
    const fake = createGatewayDockerFake({
      live: () => live,
      onCreate: () => {
        live = {
          id: "created-gateway",
          revision: GATEWAY_PROXY_REVISION,
          upstreamHash: UPSTREAM_HASH,
          networks: {
            [GATEWAY_NETWORK]: { IPAddress: "172.18.0.11" },
            [RESTRICTED_NETWORK]: { IPAddress: "172.19.0.11" },
          },
        };
        return "created-gateway";
      },
    });
    setGatewayDockerForTests(fake);
    await ensureGatewayProxy(UPSTREAM, IMAGE);
    live = { id: "rebuilt-legacy", revision: "legacy", upstreamHash: UPSTREAM_HASH };
    const second = await ensureGatewayProxy(UPSTREAM, IMAGE);
    assert.equal(second.restrictedIp, "172.19.0.11");
    assert.equal(countCreates(fake.calls), 1);
    assert.ok(fake.calls.some((args) => args[0] === "rm" && args.includes("rebuilt-legacy")));
  });

  test("concurrent stale-cache callers share one rediscovery", async () => {
    let live: LiveGateway = { id: "old-gateway" };
    const fake = createGatewayDockerFake({ live: () => live });
    setGatewayDockerForTests(fake);
    await ensureGatewayProxy(UPSTREAM, IMAGE);
    const psBeforeRebuild = countPs(fake.calls);
    live = { id: "new-gateway" };
    const [a, b] = await Promise.all([
      ensureGatewayProxy(UPSTREAM, IMAGE),
      ensureGatewayProxy(UPSTREAM, IMAGE),
    ]);
    assert.equal(a.restrictedIp, b.restrictedIp);
    assert.equal(countPs(fake.calls) - psBeforeRebuild, 1);
    assert.equal(countCreates(fake.calls), 0);
  });

  test("ensureGatewayProxy does not rediscover on unrelated inspect errors", async () => {
    const live: LiveGateway = { id: "old-gateway" };
    let failCached = false;
    const fake = createGatewayDockerFake({
      live: () => live,
      inspectError: (id) => (failCached && id === "old-gateway" ? new Error("permission denied") : null),
    });
    setGatewayDockerForTests(fake);
    await ensureGatewayProxy(UPSTREAM, IMAGE);
    const psAfterFirst = countPs(fake.calls);
    failCached = true;
    await assert.rejects(() => ensureGatewayProxy(UPSTREAM, IMAGE), /permission denied/);
    assert.equal(countPs(fake.calls), psAfterFirst);
  });

  test("bind after gateway rebuild attaches the rediscovered sidecar", async () => {
    let live: LiveGateway = { id: "old-gateway" };
    const fake = createGatewayDockerFake({ live: () => live });
    setGatewayDockerForTests(fake);
    await bindGatewayProxyToOpenSandboxNetwork({
      sandboxId: "sbx-1",
      upstreamUrl: UPSTREAM,
      image: IMAGE,
    });
    live = { id: "new-gateway" };
    const bind = await bindGatewayProxyToOpenSandboxNetwork({
      sandboxId: "sbx-2",
      upstreamUrl: UPSTREAM,
      image: IMAGE,
    });
    assert.deepEqual(bind, { hostname: GATEWAY_PROXY, ip: "172.20.0.8" });
    assert.equal(countCreates(fake.calls), 0);
  });
});

test("#685 upstream socket env parsing keeps URL mode by default and validates input", () => {
  assert.equal(gatewayUpstreamSocketFromEnv({}), null);
  assert.equal(gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "  " }), null);
  assert.deepEqual(
    gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "deepsonar-gateway-upstream" }),
    { volume: "deepsonar-gateway-upstream", dir: "/run/deepsonar-gateway" },
  );
  assert.deepEqual(
    gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "v1", DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_DIR: "/run/x/" }),
    { volume: "v1", dir: "/run/x" },
  );
  assert.throws(() => gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "/host/path" }), /合法卷名/);
  assert.throws(() => gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "v:ro" }), /合法卷名/);
  assert.throws(
    () => gatewayUpstreamSocketFromEnv({ DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME: "v", DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_DIR: "/run/../etc" }),
    /绝对路径/,
  );
  // URL-only hash is unchanged so host-mode proxies are not churned by the upgrade.
  assert.equal(gatewayUpstreamHash(UPSTREAM, null), UPSTREAM_HASH);
  assert.notEqual(gatewayUpstreamHash(UPSTREAM, { volume: "v", dir: "/run/deepsonar-gateway" }), UPSTREAM_HASH);
});

test.describe("#685 socket upstream proxy creation", { concurrency: 1 }, () => {
  test.afterEach(() => {
    resetManagedGatewayStateForTests();
  });

  test("socket mode mounts the upstream volume read-only and joins no business network", async () => {
    const socket = { volume: "deepsonar-gateway-upstream", dir: "/run/deepsonar-gateway" };
    // An existing URL-mode proxy (pre-#685 label) must be replaced, not reused.
    let live: LiveGateway | null = { id: "url-mode-gateway" };
    const fake = createGatewayDockerFake({
      live: () => live,
      onCreate: () => {
        live = { id: "socket-gateway", upstreamHash: gatewayUpstreamHash("http://scheduler:3100/gateway", socket) };
        return "socket-gateway";
      },
    });
    setGatewayDockerForTests(fake);
    await ensureGatewayProxy("http://scheduler:3100/gateway", IMAGE, { upstreamSocket: socket });
    assert.ok(fake.calls.some((args) => args[0] === "rm" && args.includes("url-mode-gateway")));
    const run = fake.calls.find((args) => args[0] === "run" && args[1] === "run");
    assert.ok(run, "proxy must be recreated");
    assert.ok(run!.includes("deepsonar-gateway-upstream:/run/deepsonar-gateway:ro"));
    assert.ok(run!.includes("DEEPSONAR_GATEWAY_UPSTREAM_SOCKET=/run/deepsonar-gateway/scheduler.sock"));
    const networks = run!.flatMap((arg, i) => (arg === "--network" ? [run![i + 1]] : []));
    assert.deepEqual(networks, [GATEWAY_NETWORK]);
    const connected = fake.calls.filter((args) => args[0] === "network" && args[1] === "connect").map((args) => args.at(-2));
    assert.ok(connected.every((name) => name === RESTRICTED_NETWORK || name === GATEWAY_NETWORK), connected.join(","));
  });

  test("socket mode rejects https upstream URLs", async () => {
    const fake = createGatewayDockerFake({ live: () => null });
    setGatewayDockerForTests(fake);
    await assert.rejects(
      ensureGatewayProxy("https://scheduler:3100/gateway", IMAGE, { upstreamSocket: { volume: "v", dir: "/run/deepsonar-gateway" } }),
      /只支持 http:/,
    );
  });
});

/** Bind the fixed-port proxy script to a test port (mirrors runtime-behavior.test.ts). */
function proxyScriptOnPort(port: number): string {
  const script = GATEWAY_PROXY_SCRIPT.replace('server.listen(3100, "0.0.0.0");', `server.listen(${port}, "127.0.0.1");`);
  if (script === GATEWAY_PROXY_SCRIPT) throw new Error("failed to rebind Gateway proxy test port");
  return script;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function proxyRequest(port: number, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("#685 proxy script forwards only /gateway and /control/v1 over the Unix socket without DNS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ds-gw-proxy-"));
  const socketPath = join(dir, "scheduler.sock");
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.writeHead(200).end(`upstream ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", proxyScriptOnPort(port)], {
    env: {
      ...process.env,
      // .invalid never resolves: success proves the socket path bypasses DNS.
      DEEPSONAR_GATEWAY_UPSTREAM: "http://scheduler.invalid:3100/gateway",
      DEEPSONAR_GATEWAY_UPSTREAM_SOCKET: socketPath,
    },
    stdio: "ignore",
  });
  t.after(() => {
    child.kill("SIGKILL");
    upstream.closeAllConnections();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await proxyRequest(port, "GET", "/_deepsonar_health").then((r) => r.status === 200, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "proxy did not start");

  assert.deepEqual(await proxyRequest(port, "POST", "/gateway/v1/messages"), { status: 200, body: "upstream /gateway/v1/messages" });
  assert.deepEqual(await proxyRequest(port, "GET", "/control/v1/jobs/j1"), { status: 200, body: "upstream /control/v1/jobs/j1" });
  // Management API and arbitrary paths never reach Scheduler.
  assert.equal((await proxyRequest(port, "GET", "/api/v1/settings")).status, 404);
  assert.equal((await proxyRequest(port, "GET", "/health")).status, 404);
  assert.equal((await proxyRequest(port, "GET", "/gatewayx")).status, 404);
  assert.deepEqual(seen, [
    "POST /gateway/v1/messages host=scheduler.invalid:3100",
    "GET /control/v1/jobs/j1 host=scheduler.invalid:3100",
  ]);
  // CONNECT tunnels are refused outright.
  const connectOutcome = await new Promise<string>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "postgres:5432", agent: false });
    req.on("connect", () => resolve("tunnel"));
    req.on("response", (res) => resolve(`status ${res.statusCode}`));
    req.on("error", () => resolve("refused"));
    req.end();
  });
  assert.equal(connectOutcome, "refused");
  // Scheduler gone (socket closed): fail closed with 502, no fallback route.
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  assert.equal((await proxyRequest(port, "POST", "/gateway/v1/messages")).status, 502);
});
