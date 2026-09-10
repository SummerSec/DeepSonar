import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { isNoSuchContainerError } from "./runtime-docker.js";
import {
  GATEWAY_NETWORK,
  GATEWAY_PROXY,
  GATEWAY_PROXY_REVISION,
  RESTRICTED_NETWORK,
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
