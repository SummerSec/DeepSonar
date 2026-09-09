import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const WORKER_NODE_STALE_DEFAULT_SEC = 45;
export const LOCAL_WORKER_ID = "local";

export type WorkerKind = "local" | "remote";
export type WorkerStatus = "online" | "stale" | "unavailable";
export type WorkerProtocol = "http" | "https";

export interface WorkerCapacity {
  maxSandboxes: number;
  memoryMib: number;
  cpu: number;
}

export interface WorkerNodeRecord {
  id: string;
  endpoint: string;
  protocol: WorkerProtocol;
  kind: WorkerKind;
  status: WorkerStatus;
  apiKeyFingerprint: string;
  nodeTokenHash: string;
  nodeTokenPrefix: string;
  capacity: WorkerCapacity;
  labels: Record<string, string>;
  lastHeartbeatAt: number;
  lastDispatchAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DispatchableWorker extends WorkerNodeRecord {
  activeSandboxes: number;
  hasApiKey: boolean;
}

const NODE_ID_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

export function parseWorkerNodeId(raw: string): string {
  const id = raw.trim();
  if (!NODE_ID_RE.test(id)) throw new Error("invalid worker node id");
  return id;
}

export function parseWorkerEndpoint(raw: string): string {
  const endpoint = raw.trim();
  if (!endpoint || endpoint.length > 256 || endpoint.includes("://") || endpoint.includes("/") || endpoint.includes("?")) {
    throw new Error("invalid worker endpoint");
  }
  return endpoint;
}

export function parseWorkerCapacity(input: {
  maxSandboxes?: number;
  memoryMib?: number;
  cpu?: number;
}): WorkerCapacity {
  const maxSandboxes = Math.trunc(input.maxSandboxes ?? 8);
  const memoryMib = Math.trunc(input.memoryMib ?? 16_384);
  const cpu = Math.trunc(input.cpu ?? 8);
  if (maxSandboxes < 1 || maxSandboxes > 1_000) throw new Error("invalid worker max_sandboxes");
  if (memoryMib < 256 || memoryMib > 1_000_000) throw new Error("invalid worker memory_mib");
  if (cpu < 1 || cpu > 512) throw new Error("invalid worker cpu");
  return { maxSandboxes, memoryMib, cpu };
}

export function parseWorkerLabels(input: Record<string, string> | undefined): Record<string, string> {
  const labels = input ?? {};
  const entries = Object.entries(labels);
  if (entries.length > 16) throw new Error("invalid worker labels");
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!key || key.length > 64 || value.length > 128) throw new Error("invalid worker labels");
    out[key] = value;
  }
  return out;
}

export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateWorkerNodeToken(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `deepsonar_wnode_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashWorkerToken(plaintext) };
}

export function workerTokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function effectiveWorkerStatus(
  node: Pick<WorkerNodeRecord, "kind" | "status" | "lastHeartbeatAt">,
  now: number,
  staleAfterMs: number,
): WorkerStatus {
  if (node.status === "unavailable") return "unavailable";
  if (node.kind === "local") return "online";
  if (now - node.lastHeartbeatAt > staleAfterMs) return "stale";
  return "online";
}

export function workerIsDispatchable(
  node: DispatchableWorker,
  now: number,
  staleAfterMs: number,
  options: { requireLocal?: boolean } = {},
): boolean {
  if (options.requireLocal && node.kind !== "local") return false;
  if (!node.hasApiKey) return false;
  if (effectiveWorkerStatus(node, now, staleAfterMs) !== "online") return false;
  return node.activeSandboxes < node.capacity.maxSandboxes;
}

/** Oldest last_dispatch_at first; ties break on node id. Local-only when requireLocal. */
export function pickRoundRobinWorker(
  nodes: DispatchableWorker[],
  now: number,
  staleAfterMs: number,
  options: { requireLocal?: boolean } = {},
): DispatchableWorker | null {
  const ready = nodes.filter((node) => workerIsDispatchable(node, now, staleAfterMs, options));
  if (ready.length === 0) return null;
  ready.sort((a, b) => {
    const left = a.lastDispatchAt ?? 0;
    const right = b.lastDispatchAt ?? 0;
    if (left !== right) return left - right;
    return a.id.localeCompare(b.id);
  });
  return ready[0] ?? null;
}

export function localWorkerFromEnv(input: {
  nodeId?: string;
  endpoint: string;
  protocol: WorkerProtocol;
  apiKey: string;
  maxSandboxes?: number;
  memoryMib?: number;
  cpu?: number;
  now?: number;
}): Omit<WorkerNodeRecord, "nodeTokenHash" | "nodeTokenPrefix"> & { apiKey: string } {
  const now = input.now ?? Date.now();
  return {
    id: parseWorkerNodeId(input.nodeId?.trim() || LOCAL_WORKER_ID),
    endpoint: parseWorkerEndpoint(input.endpoint),
    protocol: input.protocol,
    kind: "local",
    status: "online",
    apiKeyFingerprint: fingerprintApiKey(input.apiKey),
    capacity: parseWorkerCapacity({
      maxSandboxes: input.maxSandboxes,
      memoryMib: input.memoryMib,
      cpu: input.cpu,
    }),
    labels: { kind: "local" },
    lastHeartbeatAt: now,
    lastDispatchAt: null,
    createdAt: now,
    updatedAt: now,
    apiKey: input.apiKey,
  };
}

export function publicWorkerView(node: DispatchableWorker, now: number, staleAfterMs: number) {
  return {
    id: node.id,
    endpoint: node.endpoint,
    protocol: node.protocol,
    kind: node.kind,
    status: effectiveWorkerStatus(node, now, staleAfterMs),
    capacity: {
      max_sandboxes: node.capacity.maxSandboxes,
      memory_mib: node.capacity.memoryMib,
      cpu: node.capacity.cpu,
    },
    labels: node.labels,
    active_sandboxes: node.activeSandboxes,
    last_heartbeat_at: new Date(node.lastHeartbeatAt).toISOString(),
    last_dispatch_at: node.lastDispatchAt ? new Date(node.lastDispatchAt).toISOString() : null,
  };
}
