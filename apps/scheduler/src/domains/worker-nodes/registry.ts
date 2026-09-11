import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import { parseRemoteWorkerEndpoint, type WorkerEndpointPolicy } from "./endpoint.js";
import {
  fingerprintApiKey,
  generateWorkerNodeToken,
  hashWorkerToken,
  isReservedWorkerNodeId,
  localWorkerFromEnv,
  parseWorkerCapacity,
  parseWorkerEndpoint,
  parseWorkerLabels,
  parseWorkerNodeId,
  shouldReuseLocalWorkerToken,
  WorkerNodeError,
  workerTokensEqual,
  type DispatchableWorker,
  type WorkerCapacity,
  type WorkerKind,
  type WorkerNodeRecord,
  type WorkerProtocol,
  type WorkerStatus,
} from "./model.js";

export type WorkerDispatchClaim = DispatchableWorker & { reservationId: string };

export type ClaimWorkerOptions = {
  requireLocal?: boolean;
  now?: number;
  jobId?: string;
  attemptId?: string;
};

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

export function configuredWorkerBootstrapToken(): string {
  return (process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN ?? "").trim()
    || config.runtime.workerNodes.bootstrapToken.trim();
}

export function bootstrapTokenConfigured(): boolean {
  return configuredWorkerBootstrapToken().length > 0;
}

export function bootstrapTokenMatches(token: string): boolean {
  const expected = configuredWorkerBootstrapToken();
  if (!expected) return false;
  return workerTokensEqual(hashWorkerToken(token), hashWorkerToken(expected));
}

export function remoteWorkerEndpointPolicy(): WorkerEndpointPolicy {
  const cidrs = config.runtime.workerNodes.endpointAllowCidrs;
  const hosts = config.runtime.workerNodes.endpointAllowHosts;
  return {
    allowlistConfigured: cidrs.configured || hosts.configured,
    allowCidrs: cidrs.values,
    allowHosts: hosts.values,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505");
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

type PersistNodeInput = {
  id: string;
  endpoint: string;
  protocol: WorkerProtocol;
  kind: WorkerKind;
  apiKey: string;
  capacity: WorkerCapacity;
  labels: Record<string, string>;
  token: { hash: string; prefix: string };
};

function capacityJson(capacity: WorkerCapacity) {
  return {
    max_sandboxes: capacity.maxSandboxes,
    memory_mib: capacity.memoryMib,
    cpu: capacity.cpu,
  };
}

async function insertNode(input: PersistNodeInput): Promise<DispatchableWorker> {
  rememberWorkerApiKey(input.id, input.apiKey);
  const [row] = await sql<WorkerRow[]>`
    INSERT INTO worker_nodes (
      id, endpoint, protocol, kind, status, api_key_fingerprint,
      node_token_hash, node_token_prefix, capacity_json, labels_json,
      last_heartbeat_at, updated_at
    ) VALUES (
      ${input.id}, ${input.endpoint}, ${input.protocol}, ${input.kind}, 'online',
      ${fingerprintApiKey(input.apiKey)}, ${input.token.hash}, ${input.token.prefix},
      ${sql.json(capacityJson(input.capacity))}, ${sql.json(input.labels)}, now(), now()
    )
    RETURNING *`;
  const counts = await leaseCounts();
  return fromRow(row, counts.get(row.id) ?? 0);
}

/** Scheduler-owned local seed only. Remote register must not take this path. */
async function upsertLocalNode(input: PersistNodeInput): Promise<DispatchableWorker> {
  rememberWorkerApiKey(input.id, input.apiKey);
  const [row] = await sql<WorkerRow[]>`
    INSERT INTO worker_nodes (
      id, endpoint, protocol, kind, status, api_key_fingerprint,
      node_token_hash, node_token_prefix, capacity_json, labels_json,
      last_heartbeat_at, updated_at
    ) VALUES (
      ${input.id}, ${input.endpoint}, ${input.protocol}, ${input.kind}, 'online',
      ${fingerprintApiKey(input.apiKey)}, ${input.token.hash}, ${input.token.prefix},
      ${sql.json(capacityJson(input.capacity))}, ${sql.json(input.labels)}, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      endpoint = excluded.endpoint,
      protocol = excluded.protocol,
      kind = 'local',
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
  const id = parseWorkerNodeId(input.nodeId);
  if (isReservedWorkerNodeId(id, [config.runtime.workerNodes.localNodeId])) {
    throw new WorkerNodeError("WORKER_NODE_RESERVED", "reserved worker node id cannot be registered remotely", 403);
  }
  const existing = await getWorkerNode(id);
  if (existing) {
    throw new WorkerNodeError("WORKER_NODE_EXISTS", "worker node already exists; forget it before reclaiming", 409);
  }
  const token = generateWorkerNodeToken();
  try {
    const node = await insertNode({
      id,
      endpoint: parseRemoteWorkerEndpoint(input.endpoint, remoteWorkerEndpointPolicy()),
      protocol: input.protocol ?? "http",
      kind: "remote",
      apiKey: input.apiKey,
      capacity: input.capacity,
      labels: parseWorkerLabels(input.labels),
      token,
    });
    return { node, nodeToken: token.plaintext };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkerNodeError("WORKER_NODE_EXISTS", "worker node already exists; forget it before reclaiming", 409);
    }
    throw error;
  }
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
  if (input.endpoint) {
    const endpoint = row.kind === "remote"
      ? parseRemoteWorkerEndpoint(input.endpoint, remoteWorkerEndpointPolicy())
      : parseWorkerEndpoint(input.endpoint);
    if (endpoint !== row.endpoint) {
      throw new WorkerNodeError("WORKER_HEARTBEAT_OWNERSHIP", "heartbeat cannot change worker endpoint or ownership", 409);
    }
  }
  if (input.protocol && input.protocol !== row.protocol) {
    throw new WorkerNodeError("WORKER_HEARTBEAT_OWNERSHIP", "heartbeat cannot change worker endpoint or ownership", 409);
  }
  const capacity = input.capacity ?? parseWorkerCapacity({
    maxSandboxes: row.capacity_json?.max_sandboxes,
    memoryMib: row.capacity_json?.memory_mib,
    cpu: row.capacity_json?.cpu,
  });
  const labels = input.labels ? parseWorkerLabels(input.labels) : (row.labels_json ?? {});
  const [updated] = await sql<WorkerRow[]>`
    UPDATE worker_nodes SET
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
     WHERE id = ${row.id} AND kind = ${row.kind}
     RETURNING *`;
  if (!updated) {
    throw new WorkerNodeError("WORKER_HEARTBEAT_OWNERSHIP", "heartbeat cannot change worker endpoint or ownership", 409);
  }
  const counts = await leaseCounts();
  return fromRow(updated, counts.get(updated.id) ?? 0);
}

export async function applyLocalWorkerSeed(
  spec: ReturnType<typeof localWorkerFromEnv> & { apiKey: string },
): Promise<DispatchableWorker> {
  const existing = await getWorkerNode(spec.id);
  const token = shouldReuseLocalWorkerToken(existing, spec.endpoint) && existing
    ? { hash: existing.nodeTokenHash, prefix: existing.nodeTokenPrefix }
    : generateWorkerNodeToken();
  return upsertLocalNode({
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

export async function seedLocalWorkerNode(now = Date.now()): Promise<WorkerNodeRecord | null> {
  const runtime = config.runtime;
  if (runtime.agentMode !== "real" || runtime.provider !== "opensandbox") return null;
  if (runtime.openSandbox.kubernetes) return null;
  if (!runtime.workerNodes.seedLocal) return null;
  const apiKey = runtime.openSandbox.apiKey.trim();
  if (!apiKey) return null;
  return applyLocalWorkerSeed(localWorkerFromEnv({
    nodeId: runtime.workerNodes.localNodeId,
    endpoint: runtime.openSandbox.domain,
    protocol: runtime.openSandbox.protocol,
    apiKey,
    maxSandboxes: runtime.workerNodes.maxSandboxes,
    memoryMib: runtime.workerNodes.memoryMib,
    cpu: runtime.workerNodes.cpu,
    now,
  }));
}

export async function forgetWorkerNode(id: string): Promise<DispatchableWorker | null> {
  const node = await getWorkerNode(id);
  if (!node) return null;
  await sql`DELETE FROM worker_nodes WHERE id = ${id}`;
  apiKeys.delete(id);
  return node;
}

export async function claimWorkerForDispatch(
  options: ClaimWorkerOptions = {},
): Promise<WorkerDispatchClaim | null> {
  const knownIds = [...apiKeys.keys()];
  if (knownIds.length === 0) return null;

  const now = options.now ?? Date.now();
  const staleCutoff = new Date(now - workerStaleAfterMs());
  const requireLocal = options.requireLocal === true;
  const reservationId = `reserve:${randomUUID()}`;
  const jobId = options.jobId ?? null;
  const attemptId = options.attemptId ?? null;

  return sql.begin(async (tx) => {
    const skipped: string[] = [];
    for (;;) {
      const [row] = await tx<WorkerRow[]>`
        SELECT w.*, (
          SELECT count(*)::int FROM worker_sandbox_leases l WHERE l.worker_id = w.id
        ) AS active_sandboxes
          FROM worker_nodes w
         WHERE w.status <> 'unavailable'
           AND w.id = ANY(${knownIds})
           AND (${requireLocal} = false OR w.kind = 'local')
           AND (w.kind = 'local' OR w.last_heartbeat_at > ${staleCutoff})
           AND (${skipped.length} = 0 OR NOT (w.id = ANY(${skipped})))
           AND (
             SELECT count(*) FROM worker_sandbox_leases l WHERE l.worker_id = w.id
           ) < coalesce((w.capacity_json->>'max_sandboxes')::int, 8)
         ORDER BY w.last_dispatch_at NULLS FIRST, w.id
         FOR UPDATE OF w
         LIMIT 1`;
      if (!row) return null;

      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM worker_sandbox_leases WHERE worker_id = ${row.id}`;
      const occupied = Number(n ?? 0);
      const maxSandboxes = parseWorkerCapacity({
        maxSandboxes: row.capacity_json?.max_sandboxes,
      }).maxSandboxes;
      if (occupied >= maxSandboxes) {
        skipped.push(row.id);
        continue;
      }

      await tx`
        INSERT INTO worker_sandbox_leases (sandbox_id, worker_id, job_id, attempt_id)
        VALUES (${reservationId}, ${row.id}, ${jobId}, ${attemptId})`;
      const [updated] = await tx<WorkerRow[]>`
        UPDATE worker_nodes
           SET last_dispatch_at = now(), updated_at = now()
         WHERE id = ${row.id}
        RETURNING *`;
      return {
        ...fromRow(updated ?? row, occupied + 1),
        lastDispatchAt: now,
        reservationId,
      };
    }
  });
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

export async function finalizeSandboxLease(input: {
  reservationId: string;
  sandboxId: string;
  workerId: string;
  jobId?: string;
  attemptId?: string;
}): Promise<void> {
  const rows = await sql`
    UPDATE worker_sandbox_leases
       SET sandbox_id = ${input.sandboxId},
           job_id = ${input.jobId ?? null},
           attempt_id = ${input.attemptId ?? null}
     WHERE sandbox_id = ${input.reservationId} AND worker_id = ${input.workerId}
    RETURNING sandbox_id`;
  if (rows.length === 0) {
    throw new Error(`WORKER_PLANE_LEASE_MISSING: ${input.reservationId}`);
  }
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
