/**
 * Static deploy self-check for #685: service discovery must be unambiguous.
 *
 * On rootless Podman every DNS-enabled network a container joins adds its own
 * aardvark nameserver, and musl queries them in parallel. A name that exists
 * on only some of those networks therefore resolves intermittently. This test
 * renders the official compose stacks (approximating compose merge rules) and
 * fails if any multi-homed service resolves a service name that is not
 * attached to every one of its networks, and pins the business/sandbox split.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_GATEWAY_UPSTREAM_SOCKET_DIR } from "./runtime-gateway.js";
import { DEEPSONAR_GATEWAY_NETWORK, DEEPSONAR_RESTRICTED_NETWORK } from "./runtime-gateway.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Service = Record<string, unknown>;
type Stack = { services: Record<string, Service>; volumes: Record<string, Record<string, unknown> | null>; networks: Record<string, Record<string, unknown> | null> };

/** Names a service resolves without them appearing in its own config. */
function implicitReferences(name: string, env: Record<string, string>): string[] {
  // deploy/web-server.mjs defaults SCHEDULER_URL to http://scheduler:3100.
  if (name === "web" && env.SCHEDULER_URL === undefined) return ["scheduler"];
  return [];
}

const BUSINESS_DATA_SERVICES = ["postgres", "backup", "silo", "silo-init"];

function load(file: string): Record<string, unknown> {
  return (parse(readFileSync(join(root, "deploy", file), "utf8")) ?? {}) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function networkNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (isRecord(value)) return Object.keys(value);
  return [];
}

function envMap(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(String).map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at), line.slice(at + 1)];
    }));
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v == null ? "" : String(v)]));
  return {};
}

function volumeTarget(entry: unknown): string {
  if (isRecord(entry)) return String(entry.target ?? "");
  const parts = String(entry).split(":");
  return parts.length >= 2 ? parts[1]! : parts[0]!;
}

function mergeService(base: Service, overlay: Service): Service {
  const merged: Service = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prev = merged[key];
    if (key === "networks") {
      merged[key] = [...new Set([...networkNames(prev), ...networkNames(value)])];
    } else if (key === "environment") {
      merged[key] = { ...envMap(prev), ...envMap(value) };
    } else if (key === "volumes") {
      const byTarget = new Map<string, unknown>();
      for (const entry of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(value) ? value : [])]) {
        byTarget.set(volumeTarget(entry), entry);
      }
      merged[key] = [...byTarget.values()];
    } else if (isRecord(prev) && isRecord(value)) {
      merged[key] = { ...prev, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function render(...files: string[]): Stack {
  const stack: Stack = { services: {}, volumes: {}, networks: {} };
  for (const file of files) {
    const doc = load(file);
    for (const [name, svc] of Object.entries((doc.services ?? {}) as Record<string, Service>)) {
      stack.services[name] = mergeService(stack.services[name] ?? {}, svc ?? {});
    }
    for (const [name, vol] of Object.entries((doc.volumes ?? {}) as Stack["volumes"])) {
      stack.volumes[name] = { ...(stack.volumes[name] ?? {}), ...(vol ?? {}) };
    }
    for (const [name, net] of Object.entries((doc.networks ?? {}) as Stack["networks"])) {
      stack.networks[name] = { ...(stack.networks[name] ?? {}), ...(net ?? {}) };
    }
  }
  return stack;
}

/** Resolve compose interpolation using defaults only (innermost first). */
function interpolate(value: string): string {
  let out = value.replace(/\$\$/g, "\u0000");
  const pattern = /\$\{([A-Za-z0-9_]+)(?:(:?[-?])([^${}]*))?\}/;
  for (let guard = 0; guard < 50 && pattern.test(out); guard++) {
    out = out.replace(pattern, (_m, _name, op: string | undefined, rest: string | undefined) => (op && op.endsWith("-") ? rest ?? "" : ""));
  }
  return out.replace(/\u0000/g, "$");
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  if (value == null) return [];
  return [String(value)];
}

function servicesOf(svc: Service): string[] {
  if (svc.network_mode) return [];
  const nets = networkNames(svc.networks);
  return nets.length > 0 ? nets : ["default"];
}

/** Every compose service name / container_name / alias the service text references. */
function referencedServices(stack: Stack, self: string): string[] {
  const svc = stack.services[self]!;
  const known = new Map<string, string>();
  for (const [name, other] of Object.entries(stack.services)) {
    known.set(name, name);
    if (typeof other.container_name === "string") known.set(interpolate(other.container_name), name);
    if (isRecord(other.networks)) {
      for (const cfg of Object.values(other.networks)) {
        if (isRecord(cfg) && Array.isArray(cfg.aliases)) for (const alias of cfg.aliases) known.set(String(alias), name);
      }
    }
  }
  const text = [
    ...Object.values(envMap(svc.environment)),
    ...strings(svc.command),
    ...strings(svc.entrypoint),
    ...strings(isRecord(svc.healthcheck) ? svc.healthcheck.test : undefined),
  ].map(interpolate);
  const found = new Set<string>(implicitReferences(self, envMap(svc.environment)));
  // host in "scheme://host", "user@host", "-h host" or a bare "host:port"; a URL scheme is not a host.
  const hostPattern = /(?:\/\/|@|(?:^|\s)-h\s+|^)([a-z][a-z0-9_.-]*)(?=:(?!\/\/)|\/|\s|$)/gm;
  for (const value of text) {
    for (const match of value.matchAll(hostPattern)) {
      const target = known.get(match[1]!);
      if (target && target !== self) found.add(target);
    }
  }
  return [...found].filter((name) => stack.services[name]);
}

function assertUnambiguousDiscovery(label: string, stack: Stack): void {
  for (const [name, svc] of Object.entries(stack.services)) {
    const own = servicesOf(svc);
    for (const target of referencedServices(stack, name)) {
      const targetSvc = stack.services[target]!;
      if (svc.network_mode === "host" || targetSvc.network_mode === "host") {
        assert.fail(`${label}: ${name} resolves host-network service ${target} by name; use loopback/host ingress`);
      }
      const theirs = servicesOf(targetSvc);
      const missing = own.filter((net) => !theirs.includes(net));
      // A single-homed container only needs to share its one network. A
      // multi-homed one gets one nameserver per network, so the target must
      // be answerable by all of them.
      assert.deepEqual(
        missing,
        [],
        `${label}: ${name} joins [${own.join(", ")}] and resolves ${target}, but ${target} is missing from [${missing.join(", ")}] (#685 DNS ambiguity)`,
      );
    }
  }
}

function assertBridgeTopology(label: string, stack: Stack): void {
  const scheduler = stack.services.scheduler!;
  assert.deepEqual(servicesOf(scheduler), ["deepsonar"], `${label}: scheduler must join only the business network`);
  for (const name of BUSINESS_DATA_SERVICES) {
    if (!stack.services[name]) continue;
    assert.deepEqual(servicesOf(stack.services[name]!), ["deepsonar"], `${label}: ${name} must stay on the business network only`);
  }
  if (stack.services.opensandbox) {
    assert.deepEqual(servicesOf(stack.services.opensandbox), ["deepsonar"], `${label}: opensandbox management API stays on the business network`);
  }
  for (const [key, net] of Object.entries(stack.networks)) {
    const name = interpolate(String(net?.name ?? key));
    assert.notEqual(name, DEEPSONAR_GATEWAY_NETWORK, `${label}: compose must not declare the sandbox gateway network (${key})`);
    assert.notEqual(name, DEEPSONAR_RESTRICTED_NETWORK, `${label}: compose must not declare the restricted network (${key})`);
  }
  // Scheduler's proxy upstream is the socket volume, mounted where the proxy expects it.
  const env = envMap(scheduler.environment);
  const socketVolume = interpolate(env.DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME ?? "");
  assert.ok(socketVolume, `${label}: scheduler must set DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME`);
  assert.equal(interpolate(env.DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_DIR ?? DEFAULT_GATEWAY_UPSTREAM_SOCKET_DIR), DEFAULT_GATEWAY_UPSTREAM_SOCKET_DIR);
  const mount = (scheduler.volumes as unknown[]).map(String).find((entry) => volumeTarget(entry) === DEFAULT_GATEWAY_UPSTREAM_SOCKET_DIR);
  assert.ok(mount, `${label}: scheduler must mount the gateway upstream volume at ${DEFAULT_GATEWAY_UPSTREAM_SOCKET_DIR}`);
  const volumeKey = mount!.split(":")[0]!;
  const declared = stack.volumes[volumeKey];
  assert.ok(declared, `${label}: ${volumeKey} must be a named volume`);
  assert.equal(interpolate(String(declared!.name ?? "")), socketVolume, `${label}: volume name must equal DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME so the proxy mounts the same volume`);
  // Data services never share a network with sandboxes or the proxy.
  for (const svc of Object.values(stack.services)) {
    for (const net of servicesOf(svc)) {
      assert.ok(stack.networks[net] !== undefined || net === "default", `${label}: undeclared network ${net}`);
    }
  }
}

const BRIDGE_STACKS: Array<[string, string[]]> = [
  ["prod", ["docker-compose.prod.yml"]],
  ["prod+opensandbox", ["docker-compose.prod.yml", "docker-compose.opensandbox.prod.yml"]],
  ["prod+real+opensandbox", ["docker-compose.prod.yml", "docker-compose.real.yml", "docker-compose.opensandbox.prod.yml"]],
  ["prod+real+opensandbox+isolated", [
    "docker-compose.prod.yml",
    "docker-compose.real.yml",
    "docker-compose.opensandbox.prod.yml",
    "docker-compose.opensandbox.prod-isolated.yml",
  ]],
];

for (const [label, files] of BRIDGE_STACKS) {
  test(`#685 bridge stack ${label}: one DNS view per container and business-only Scheduler`, () => {
    const stack = render(...files);
    assertUnambiguousDiscovery(label, stack);
    assertBridgeTopology(label, stack);
  });
}

test("#685 isolated smoke overlay never reuses the production upstream socket volume", () => {
  const prod = render("docker-compose.prod.yml", "docker-compose.real.yml", "docker-compose.opensandbox.prod.yml");
  const isolated = render(
    "docker-compose.prod.yml",
    "docker-compose.real.yml",
    "docker-compose.opensandbox.prod.yml",
    "docker-compose.opensandbox.prod-isolated.yml",
  );
  const prodName = interpolate(String(prod.volumes.gateway_upstream?.name));
  const isolatedName = interpolate(String(isolated.volumes.gateway_upstream?.name));
  assert.equal(prodName, "deepsonar-gateway-upstream");
  assert.notEqual(isolatedName, prodName);
  assert.equal(interpolate(envMap(isolated.services.scheduler!.environment).DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME ?? ""), isolatedName);
});

test("#685 host stack: loopback data plane and host-ingress proxy upstream without DNS", () => {
  const stack = render("docker-compose.opensandbox.host.yml");
  assertUnambiguousDiscovery("host", stack);
  for (const name of ["postgres", "silo", "silo-init", "scheduler"]) {
    assert.equal(stack.services[name]!.network_mode, "host", `host: ${name} uses host networking`);
  }
  const env = envMap(stack.services.scheduler!.environment);
  assert.match(interpolate(env.DATABASE_URL ?? ""), /@127\.0\.0\.1:15432\//);
  assert.match(interpolate(env.BLOB_S3_ENDPOINT ?? ""), /^http:\/\/127\.0\.0\.1:19000$/);
  // The proxy reaches back through host-gateway, injected into /etc/hosts by
  // --add-host, so the hop never depends on any network's DNS server.
  assert.equal(new URL(interpolate(env.DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL ?? "")).hostname, "host.docker.internal");
  assert.equal(env.DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME, undefined, "host: URL upstream, not the bridge socket volume");
});

test("#685 self-check catches a multi-homed service resolving a single-network name", () => {
  const stack: Stack = {
    services: {
      scheduler: { networks: ["deepsonar", "sandbox_gateway"], environment: { DATABASE_URL: "postgres://u:p@postgres:5432/db" } },
      postgres: { networks: ["deepsonar"] },
    },
    volumes: {},
    networks: { deepsonar: {}, sandbox_gateway: {} },
  };
  assert.throws(() => assertUnambiguousDiscovery("fixture", stack), /postgres is missing from \[sandbox_gateway\]/);
});
