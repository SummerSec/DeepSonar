import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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

async function liveHeaderProxy(t: test.TestContext, handler: http.RequestListener) {
  const upstream = http.createServer(handler);
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", proxyScriptOnPort(port)], {
    env: { ...process.env, DEEPSONAR_GATEWAY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/gateway`,
      DEEPSONAR_GATEWAY_UPSTREAM_SOCKET: "" }, stdio: "ignore",
  });
  t.after(async () => {
    child.kill("SIGKILL");
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await proxyRequest(port, "GET", "/_deepsonar_health").then(r => r.status === 200, () => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, "real managed proxy script must start");
  return port;
}

async function headerProxyExchange(port: number, options: {
  method?: string; headers?: http.OutgoingHttpHeaders | string[]; body?: Buffer;
  trailers?: Array<[string, string]>; onData?: (chunk: Buffer) => void;
} = {}) {
  return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; trailers: string[] }>((resolve, reject) => {
    const requestHeaders = Array.isArray(options.headers)
      ? ["Host", "127.0.0.1:" + port, ...options.headers] : options.headers;
    const req = http.request({ host: "127.0.0.1", port, path: "/gateway/responses",
      method: options.method ?? "POST", headers: requestHeaders, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); options.onData?.(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers,
        body: Buffer.concat(chunks), trailers: res.rawTrailers }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    if (options.trailers) req.addTrailers(options.trailers);
    req.end();
  });
}

test("#1097 proxy advertises its own connection lifetime, never the upstream hop", { timeout: 10000 }, async t => {
  const port = await liveHeaderProxy(t, (_req, res) => {
    res.writeHead(200, { connection: "keep-alive, X-Reply-Hop", "keep-alive": "timeout=73, max=19",
      "x-reply-hop": "must-stay-upstream", "x-reply-hop-safe": "end-to-end",
      "proxy-authenticate": "Basic realm=local-hop", "www-authenticate": "Bearer realm=job",
      "set-cookie": ["a=1", "b=2"] }).end("same body");
  });
  const reply = await headerProxyExchange(port, { headers: { connection: "keep-alive" } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString(), "same body");
  assert.doesNotMatch(String(reply.headers["keep-alive"]), /73|max=19/);
  assert.equal(reply.headers["x-reply-hop"], undefined);
  assert.equal(reply.headers["x-reply-hop-safe"], "end-to-end");
  assert.equal(reply.headers["proxy-authenticate"], undefined);
  assert.equal(reply.headers["www-authenticate"], "Bearer realm=job");
  assert.deepEqual(reply.headers["set-cookie"], ["a=1", "b=2"]);
});

test("#1097 proxy consumes all Connection tokens while retaining Scheduler authentication", { timeout: 10000 }, async t => {
  let seen: http.IncomingHttpHeaders | undefined;
  const port = await liveHeaderProxy(t, (req, res) => { seen = req.headers; req.resume(); req.on("end", () => res.end("ok")); });
  await headerProxyExchange(port, { headers: ["Connection", "keep-alive, X-First-Hop", "cOnNeCtIoN", "X-Second-Hop",
    "X-First-Hop", "first", "X-Second-Hop", "second", "Keep-Alive", "timeout=91", "Proxy-Authorization", "local-only",
    "Authorization", "Bearer synthetic-job-token", "X-DeepSonar-Request-Id", "00000000-0000-4000-8000-000000000001",
    "X-First-Hop-Safe", "preserved", "Content-Length", "0"] });
  assert.ok(seen);
  assert.equal(seen["x-first-hop"], undefined);
  assert.equal(seen["x-second-hop"], undefined);
  assert.equal(seen["keep-alive"], undefined);
  assert.equal(seen["proxy-authorization"], undefined);
  assert.equal(seen.authorization, "Bearer synthetic-job-token");
  assert.equal(seen["x-deepsonar-request-id"], "00000000-0000-4000-8000-000000000001");
  assert.equal(seen["x-first-hop-safe"], "preserved");
  await headerProxyExchange(port, { headers: { connection: "authorization, x-deepsonar-request-id",
    authorization: "must-not-forward", "x-deepsonar-request-id": "nominated-hop" } });
  assert.equal(seen.authorization, undefined);
  assert.equal(seen["x-deepsonar-request-id"], undefined);
});

test("#1097 hop filtering preserves content bytes and framing for every supported method", { timeout: 20000 }, async t => {
  const observed: Array<{ method: string; headers: http.IncomingHttpHeaders; bytes: Buffer }> = [];
  const port = await liveHeaderProxy(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      observed.push({ method: req.method!, headers: req.headers, bytes });
      if (req.headers["content-encoding"]) res.setHeader("content-encoding", req.headers["content-encoding"]);
      res.end(bytes);
    });
  });
  const binary = Buffer.from([0, 255, 13, 10, 65, 0, 66]);
  const cases = [
    { method: "POST", body: binary, headers: { "content-length": String(binary.length) } },
    { method: "GET", body: binary, headers: { "transfer-encoding": "chunked" } },
    { method: "HEAD", body: binary, headers: { "transfer-encoding": "chunked" } },
    { method: "POST", body: gzipSync(binary), headers: { "transfer-encoding": "chunked", "content-encoding": "gzip" } },
  ];
  for (const value of cases) {
    const reply = await headerProxyExchange(port, value);
    const incoming = observed.at(-1)!;
    assert.equal(reply.status, 200);
    assert.equal(incoming.method, value.method);
    assert.deepEqual(incoming.bytes, value.body);
    assert.deepEqual(reply.body, value.method === "HEAD" ? Buffer.alloc(0) : value.body);
    assert.equal(incoming.headers["content-encoding"], value.headers["content-encoding"]);
    assert.equal(reply.headers["content-encoding"], value.headers["content-encoding"]);
  }
});

test("#1097 declared trailers preserve duplicates and consume dynamic hop and forbidden fields", { timeout: 10000 }, async t => {
  let seen: string[] = [];
  let declaration: string | undefined;
  const port = await liveHeaderProxy(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      seen = req.rawTrailers;
      declaration = req.headers.trailer;
      res.writeHead(200, { "transfer-encoding": "chunked", connection: "keep-alive, X-Reply-Hop",
        trailer: "X-Response-Digest, X-Reply-Hop, Authorization" });
      res.write("first-");
      res.addTrailers([["X-Response-Digest", "first"], ["X-Response-Digest", "second"],
        ["X-Reply-Hop", "private-hop"], ["Authorization", "private-trailer"]]);
      res.end("last");
    });
  });
  const reply = await headerProxyExchange(port, { headers: { "transfer-encoding": "chunked",
    connection: "keep-alive, X-Request-Hop", trailer: "X-Request-Digest, X-Request-Hop, Authorization" },
    body: Buffer.from("request"), trailers: [["X-Request-Digest", "first"], ["X-Request-Digest", "second"],
      ["X-Request-Hop", "private-hop"], ["Authorization", "private-trailer"]] });
  const lowerNames = (raw: string[]) => raw.map((value, i) => i % 2 === 0 ? value.toLowerCase() : value);
  assert.deepEqual(lowerNames(seen), ["x-request-digest", "first", "x-request-digest", "second"]);
  assert.equal(declaration?.toLowerCase(), "x-request-digest");
  assert.deepEqual(lowerNames(reply.trailers), ["x-response-digest", "first", "x-response-digest", "second"]);
  assert.equal(reply.headers.trailer?.toLowerCase(), "x-response-digest");
  assert.equal(reply.body.toString(), "first-last");
});

test("#1097 proxy streams the first bytes before upstream finishes", { timeout: 10000 }, async t => {
  let release!: () => void;
  const clientSawFirst = new Promise<void>(resolve => { release = resolve; });
  const port = await liveHeaderProxy(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    void clientSawFirst.then(() => res.end("data: last\n\n"));
  });
  const reply = await headerProxyExchange(port, { onData: () => release() });
  assert.equal(reply.body.toString(), "data: first\n\ndata: last\n\n");
});

test("#1097 unsupported transfer coding fails closed without killing the proxy", { timeout: 10000 }, async t => {
  const port = await liveHeaderProxy(t, (_req, res) => {
    res.writeHead(200, { "transfer-encoding": "gzip, chunked" }).end("not ordinary content bytes");
  });
  const rejected = await headerProxyExchange(port, { method: "GET", headers: { "transfer-encoding": "gzip, chunked" } });
  assert.equal(rejected.status, 400);
  assert.equal((await headerProxyExchange(port)).status, 502);
  assert.equal((await proxyRequest(port, "GET", "/_deepsonar_health")).status, 200);
});
