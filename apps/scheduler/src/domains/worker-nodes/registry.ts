import { config } from "../../config.js";
import { sql } from "../../db.js";
import {
  fingerprintApiKey,
  generateWorkerNodeToken,
  hashWorkerToken,
  localWorkerFromEnv,
  parseWorkerCapacity,
  parseWorkerEndpoint,
  parseWorkerLabels,
  parseWorkerNodeId,
  pickRoundRobinWorker,
  workerTokensEqual,
  type DispatchableWorker,
  type WorkerCapacity,
  type WorkerKind,
  type WorkerNodeRecord,
  type WorkerProtocol,
  type WorkerStatus,
} from "./model.js";

const apiKeys = new Map<string, string>();

type WorkerRow = {
  id: string;
  endpoint: string;
  protocol: WorkerProtocol;
  kind: WorkerKind;
  status: WorkerStatus;
  api_key_fingerprint: string;
  node_token_hash: string;
  node_token_prefix: string;
  capacity_json: { max_sandboxes?: number; memory_mib?: number; cpu?: number };
  labels_json: Record<string, string>;
  last_heartbeat_at: Date | string;
  last_dispatch_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  active_sandboxes?: number | string;
};

function at(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function fromRow(row: WorkerRow, activeSandboxes = 0): DispatchableWorker {
  return {
    id: row.id,
    endpoint: row.endpoint,
    protocol: row.protocol,
    kind: row.kind,
    status: row.status,
    apiKeyFingerprint: row.api_key_fingerprint,
    nodeTokenHash: row.node_token_hash,
    nodeTokenPrefix: row.node_token_prefix,
    capacity: parseWorkerCapacity({
      maxSandboxes: row.capacity_json?.max_sandboxes,
      memoryMib: row.capacity_json?.memory_mib,
      cpu: row.capacity_json?.cpu,
    }),
    labels: row.labels_json ?? {},
    lastHeartbeatAt: at(row.last_heartbeat_at) ?? Date.now(),
    lastDispatchAt: at(row.last_dispatch_at),
    createdAt: at(row.created_at) ?? Date.now(),
    updatedAt: at(row.updated_at) ?? Date.now(),
    activeSandboxes: Number(row.active_sandboxes ?? activeSandboxes) || 0,
    hasApiKey: apiKeys.has(row.id),
  };
}

export function rememberWorkerApiKey(nodeId: string, apiKey: string): void {
  apiKeys.set(nodeId, apiKey);
}

export function workerApiKey(nodeId: string): string | undefined {
  return apiKeys.get(nodeId);
}

export function clearWorkerApiKeysForTests(): void {
  apiKeys.clear();
}

export function workerStaleAfterMs(): number {
  return config.runtime.workerNodes.staleAfterSec * 1000;
}

export function bootstrapTokenConfigured(): boolean {
  return config.runtime.workerNodes.bootstrapToken.trim().length > 0;
}

export function bootstrapTokenMatches(token: string): boolean {
  const expected = config.runtime.workerNodes.bootstrapToken;
  if (!expected) return false;
  return workerTokensEqual(hashWorkerToken(token), hashWorkerToken(expected));
}

async function leaseCounts(): Promise<Map<string, number>> {
  const rows = await sql<{ worker_id: string; n: number }[]>`
    SELECT worker_id, count(*)::int AS n FROM worker_sandbox_leases GROUP BY worker_id`;
  return new Map(rows.map((row) => [row.worker_id, Number(row.n)]));
}

export async function listWorkerNodes(): Promise<DispatchableWorker[]> {
  const rows = await sql<WorkerRow[]>`
    SELECT w.*, coalesce(l.n, 0)::int AS active_sandboxes
      FROM worker_nodes w
      LEFT JOIN (
        SELECT worker_id, count(*)::int AS n FROM worker_sandbox_leases GROUP BY worker_id
      ) l ON l.worker_id = w.id
     ORDER BY w.id`;
  return rows.map((row) => fromRow(row, Number(row.active_sandboxes ?? 0)));
}

export async function getWorkerNode(id: string): Promise<DispatchableWorker | null> {
  const [row] = await sql<WorkerRow[]>`
    SELECT w.*, coalesce(l.n, 0)::int AS active_sandboxes
      FROM worker_nodes w
      LEFT JOIN (
        SELECT worker_id, count(*)::int AS n FROM worker_sandbox_leases GROUP BY worker_id
      ) l ON l.worker_id = w.id
     WHERE w.id = ${id}`;
  return row ? fromRow(row, Number(row.active_sandboxes ?? 0)) : null;
}

async function upsertNode(input: {
  id: string;
  endpoint: string;
  protocol: WorkerProtocol;
  kind: WorkerKind;
  apiKey: string;
  capacity: WorkerCapacity;
  labels: Record<string, string>;
  token: { hash: string; prefix: string };
}): Promise<DispatchableWorker> {
  rememberWorkerApiKey(input.id, input.apiKey);
  const capacityJson = {
    max_sandboxes: input.capacity.maxSandboxes,
    memory_mib: input.capacity.memoryMib,
    cpu: input.capacity.cpu,
  };
  const [row] = await sql<WorkerRow[]>`
    INSERT INTO worker_nodes (
      id, endpoint, protocol, kind, status, api_key_fingerprint,
      node_token_hash, node_token_prefix, capacity_json, labels_json,
      last_heartbeat_at, updated_at
    ) VALUES (
      ${input.id}, ${input.endpoint}, ${input.protocol}, ${input.kind}, 'online',
      ${fingerprintApiKey(input.apiKey)}, ${input.token.hash}, ${input.token.prefix},
      ${sql.json(capacityJson)}, ${sql.json(input.labels)}, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      endpoint = excluded.endpoint,
      protocol = excluded.protocol,
      kind = excluded.kind,
      status = 'online',
      api_key_fingerprint = excluded.api_key_fingerprint,
      node_token_hash = excluded.node_token_hash,
      node_token_prefix = excluded.node_token_prefix,
      capacity_json = excluded.capacity_json,
      labels_json = excluded.labels_json,
      last_heartbeat_at = now(),
      updated_at = now()
    RETURNING *`;
  const counts = await leaseCounts();
  return fromRow(row, counts.get(row.id) ?? 0);
}

export async function registerRemoteWorker(input: {
  nodeId: string;
  endpoint: string;
  protocol?: WorkerProtocol;
  apiKey: string;
  capacity: WorkerCapacity;
  labels?: Record<string, string>;
}): Promise<{ node: DispatchableWorker; nodeToken: string }> {
  const token = generateWorkerNodeToken();
  const node = await upsertNode({
    id: parseWorkerNodeId(input.nodeId),
    endpoint: parseWorkerEndpoint(input.endpoint),
    protocol: input.protocol ?? "http",
    kind: "remote",
    apiKey: input.apiKey,
    capacity: input.capacity,
    labels: parseWorkerLabels(input.labels),
    token,
  });
  return { node, nodeToken: token.plaintext };
}

export async function heartbeatWorker(input: {
  token: string;
  nodeId?: string;
  endpoint?: string;
  protocol?: WorkerProtocol;
  apiKey?: string;
  capacity?: WorkerCapacity;
  labels?: Record<string, string>;
}): Promise<DispatchableWorker | null> {
  const hash = hashWorkerToken(input.token);
  const [row] = await sql<WorkerRow[]>`SELECT * FROM worker_nodes WHERE node_token_hash = ${hash}`;
  if (!row) return null;
  if (input.nodeId && input.nodeId !== row.id) return null;
  if (input.apiKey) rememberWorkerApiKey(row.id, input.apiKey);
  const endpoint = input.endpoint ? parseWorkerEndpoint(input.endpoint) : row.endpoint;
  const protocol = input.protocol ?? row.protocol;
  const capacity = input.capacity ?? parseWorkerCapacity({
    maxSandboxes: row.capacity_json?.max_sandboxes,
    memoryMib: row.capacity_json?.memory_mib,
    cpu: row.capacity_json?.cpu,
  });
  const labels = input.labels ? parseWorkerLabels(input.labels) : (row.labels_json ?? {});
  const [updated] = await sql<WorkerRow[]>`
    UPDATE worker_nodes SET
      endpoint = ${endpoint},
      protocol = ${protocol},
      status = 'online',
      api_key_fingerprint = ${input.apiKey ? fingerprintApiKey(input.apiKey) : row.api_key_fingerprint},
      capacity_json = ${sql.json({
        max_sandboxes: capacity.maxSandboxes,
        memory_mib: capacity.memoryMib,
        cpu: capacity.cpu,
      })},
      labels_json = ${sql.json(labels)},
      last_heartbeat_at = now(),
      updated_at = now()
     WHERE id = ${row.id}
     RETURNING *`;
  const counts = await leaseCounts();
  return fromRow(updated, counts.get(updated.id) ?? 0);
}

export async function seedLocalWorkerNode(now = Date.now()): Promise<WorkerNodeRecord | null> {
  const runtime = config.runtime;
  if (runtime.agentMode !== "real" || runtime.provider !== "opensandbox") return null;
  if (runtime.openSandbox.kubernetes) return null;
  if (!runtime.workerNodes.seedLocal) return null;
  const apiKey = runtime.openSandbox.apiKey.trim();
  if (!apiKey) return null;
  const spec = localWorkerFromEnv({
    nodeId: runtime.workerNodes.localNodeId,
    endpoint: runtime.openSandbox.domain,
    protocol: runtime.openSandbox.protocol,
    apiKey,
    maxSandboxes: runtime.workerNodes.maxSandboxes,
    memoryMib: runtime.workerNodes.memoryMib,
    cpu: runtime.workerNodes.cpu,
    now,
  });
  const existing = await getWorkerNode(spec.id);
  const token = existing
    ? { hash: existing.nodeTokenHash, prefix: existing.nodeTokenPrefix }
    : generateWorkerNodeToken();
  return upsertNode({
    id: spec.id,
    endpoint: spec.endpoint,
    protocol: spec.protocol,
    kind: "local",
    apiKey: spec.apiKey,
    capacity: spec.capacity,
    labels: spec.labels,
    token,
  });
}

export async function claimWorkerForDispatch(options: {
  requireLocal?: boolean;
  now?: number;
} = {}): Promise<DispatchableWorker | null> {
  const now = options.now ?? Date.now();
  const node = pickRoundRobinWorker(await listWorkerNodes(), now, workerStaleAfterMs(), {
    requireLocal: options.requireLocal,
  });
  if (!node) return null;
  await sql`UPDATE worker_nodes SET last_dispatch_at = now(), updated_at = now() WHERE id = ${node.id}`;
  return { ...node, lastDispatchAt: now };
}

export async function recordSandboxLease(input: {
  sandboxId: string;
  workerId: string;
  jobId?: string;
  attemptId?: string;
}): Promise<void> {
  await sql`
    INSERT INTO worker_sandbox_leases (sandbox_id, worker_id, job_id, attempt_id)
    VALUES (${input.sandboxId}, ${input.workerId}, ${input.jobId ?? null}, ${input.attemptId ?? null})
    ON CONFLICT (sandbox_id) DO UPDATE SET worker_id = excluded.worker_id`;
}

export async function lookupSandboxLease(sandboxId: string): Promise<string | null> {
  const [row] = await sql<{ worker_id: string }[]>`
    SELECT worker_id FROM worker_sandbox_leases WHERE sandbox_id = ${sandboxId}`;
  return row?.worker_id ?? null;
}

export async function releaseSandboxLease(sandboxId: string): Promise<void> {
  await sql`DELETE FROM worker_sandbox_leases WHERE sandbox_id = ${sandboxId}`;
}

/** Job statuses that may still hold a live sandbox and therefore a lease. */
export const SANDBOX_LEASE_HOLDING_JOB_STATUSES = [
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
] as const;

/**
 * Drop leases whose Job is gone or no longer holding a sandbox.
 * Desired state is the jobs table; leftover rows after a successful destroy
 * (or a pre-#431 leak) permanently pin worker capacity.
 */
export async function releaseOrphanSandboxLeases(): Promise<number> {
  const rows = await sql<{ sandbox_id: string }[]>`
    DELETE FROM worker_sandbox_leases l
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs j
        WHERE j.status = ANY(${SANDBOX_LEASE_HOLDING_JOB_STATUSES as unknown as string[]})
          AND (
            (l.job_id IS NOT NULL AND j.id::text = l.job_id)
            OR (j.sandbox_id IS NOT NULL AND j.sandbox_id = l.sandbox_id)
          )
     )
    RETURNING sandbox_id`;
  return rows.length;
}
