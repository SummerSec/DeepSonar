import { BlockList, isIP } from "node:net";
import { parseWorkerEndpoint, WorkerNodeError } from "./model.js";

export interface WorkerEndpointPolicy {
  /** When true, remote hosts must match allowCidrs / allowHosts after the deny list. */
  allowlistConfigured: boolean;
  allowCidrs: string[];
  allowHosts: string[];
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.internal",
]);

const denyList = new BlockList();
denyList.addSubnet("0.0.0.0", 8, "ipv4");
denyList.addSubnet("127.0.0.0", 8, "ipv4");
denyList.addSubnet("169.254.0.0", 16, "ipv4");
denyList.addSubnet("224.0.0.0", 4, "ipv4");
denyList.addSubnet("240.0.0.0", 4, "ipv4");
denyList.addAddress("::", "ipv6");
denyList.addAddress("::1", "ipv6");
denyList.addSubnet("fe80::", 10, "ipv6");
denyList.addSubnet("ff00::", 8, "ipv6");

export function splitWorkerEndpoint(endpoint: string): { host: string; port: number } {
  const value = endpoint.trim();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 2 || value[close + 1] !== ":") throw new WorkerNodeError("WORKER_ENDPOINT_INVALID", "invalid worker endpoint", 400);
    const host = value.slice(1, close);
    const port = parsePort(value.slice(close + 2));
    return { host, port };
  }
  const sep = value.lastIndexOf(":");
  if (sep <= 0 || sep === value.length - 1) throw new WorkerNodeError("WORKER_ENDPOINT_INVALID", "invalid worker endpoint", 400);
  return { host: value.slice(0, sep), port: parsePort(value.slice(sep + 1)) };
}

function parsePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new WorkerNodeError("WORKER_ENDPOINT_INVALID", "invalid worker endpoint", 400);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WorkerNodeError("WORKER_ENDPOINT_INVALID", "invalid worker endpoint", 400);
  }
  return port;
}

function mappedIPv4(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted && isIP(dotted[1]!) === 4) return dotted[1]!;
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

export function parseWorkerCidr(raw: string): { ip: string; bits: number; kind: "ipv4" | "ipv6" } {
  const value = raw.trim();
  const slash = value.indexOf("/");
  const ip = slash === -1 ? value : value.slice(0, slash);
  const kind = isIP(ip);
  if (kind !== 4 && kind !== 6) throw new WorkerNodeError("WORKER_ENDPOINT_POLICY_INVALID", `invalid worker endpoint CIDR: ${raw}`, 400);
  const max = kind === 4 ? 32 : 128;
  const bits = slash === -1 ? max : Number(value.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > max) {
    throw new WorkerNodeError("WORKER_ENDPOINT_POLICY_INVALID", `invalid worker endpoint CIDR: ${raw}`, 400);
  }
  return { ip, bits, kind: kind === 4 ? "ipv4" : "ipv6" };
}

function isDeniedIp(ip: string, kind: "ipv4" | "ipv6"): boolean {
  return denyList.check(ip, kind);
}

function matchesCidrs(ip: string, kind: "ipv4" | "ipv6", cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  const allow = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseWorkerCidr(cidr);
    if (parsed.kind !== kind) continue;
    allow.addSubnet(parsed.ip, parsed.bits, parsed.kind);
  }
  return allow.check(ip, kind);
}

function hostnameAllowed(host: string, policy: WorkerEndpointPolicy): boolean {
  const name = host.toLowerCase();
  if (!name || name.length > 253 || name.includes(":") || name.endsWith(".")) return false;
  if (BLOCKED_HOSTNAMES.has(name) || name.endsWith(".localhost") || name.endsWith(".local")) return false;
  if (!policy.allowlistConfigured) return true;
  return policy.allowHosts.some((allowed) => allowed.toLowerCase() === name);
}

export function assertRemoteWorkerHost(host: string, policy: WorkerEndpointPolicy = { allowlistConfigured: false, allowCidrs: [], allowHosts: [] }): void {
  const mapped = mappedIPv4(host);
  const ip = mapped ?? host;
  const version = isIP(ip);
  if (version === 4) {
    if (isDeniedIp(ip, "ipv4") || (policy.allowlistConfigured && !matchesCidrs(ip, "ipv4", policy.allowCidrs))) {
      throw new WorkerNodeError("WORKER_ENDPOINT_FORBIDDEN", "worker endpoint is not allowed", 400);
    }
    return;
  }
  if (version === 6) {
    if (isDeniedIp(ip, "ipv6") || (policy.allowlistConfigured && !matchesCidrs(ip, "ipv6", policy.allowCidrs))) {
      throw new WorkerNodeError("WORKER_ENDPOINT_FORBIDDEN", "worker endpoint is not allowed", 400);
    }
    return;
  }
  if (!hostnameAllowed(host, policy)) {
    throw new WorkerNodeError("WORKER_ENDPOINT_FORBIDDEN", "worker endpoint is not allowed", 400);
  }
}

/** Syntax + remote routing policy. Local seed still uses parseWorkerEndpoint only. */
export function parseRemoteWorkerEndpoint(
  raw: string,
  policy: WorkerEndpointPolicy = { allowlistConfigured: false, allowCidrs: [], allowHosts: [] },
): string {
  const endpoint = parseWorkerEndpoint(raw);
  const { host } = splitWorkerEndpoint(endpoint);
  assertRemoteWorkerHost(host, policy);
  return endpoint;
}
