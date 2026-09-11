import type { OpenSandboxClient, OpenSandboxConnection, OpenSandboxCreateInput } from "@deepsonar/runtime-sandbox";
import type { DispatchableWorker } from "./model.js";
import {
  claimWorkerForDispatch,
  finalizeSandboxLease,
  listWorkerNodes,
  lookupSandboxLease,
  recordSandboxLease,
  releaseSandboxLease,
  workerApiKey,
  type ClaimWorkerOptions,
  type WorkerDispatchClaim,
} from "./registry.js";

export type WorkerClientFactory = (connection: OpenSandboxConnection) => OpenSandboxClient;

export type WorkerPlaneDeps = {
  createClient: WorkerClientFactory;
  now?: () => number;
  listWorkers?: () => Promise<DispatchableWorker[]>;
  claimWorker?: (options?: ClaimWorkerOptions) => Promise<WorkerDispatchClaim | null>;
  finalizeLease?: (input: {
    reservationId: string;
    sandboxId: string;
    workerId: string;
    jobId?: string;
    attemptId?: string;
  }) => Promise<void>;
  recordLease?: (input: { sandboxId: string; workerId: string; jobId?: string; attemptId?: string }) => Promise<void>;
  lookupLease?: (sandboxId: string) => Promise<string | null>;
  releaseLease?: (sandboxId: string) => Promise<void>;
  apiKeyOf?: (workerId: string) => string | undefined;
};

function connectionOf(
  node: DispatchableWorker,
  apiKeyOf: (workerId: string) => string | undefined,
): OpenSandboxConnection | null {
  const apiKey = apiKeyOf(node.id);
  if (!apiKey) return null;
  return {
    domain: node.endpoint,
    apiKey,
    protocol: node.protocol,
    useServerProxy: true,
  };
}

export function createNeedsLocalWorker(input: Pick<OpenSandboxCreateInput, "volumes" | "networkPolicy">): boolean {
  return input.volumes.length > 0
    || input.networkPolicy.defaultAction === "allow"
    || input.networkPolicy.egress.length > 0;
}

export function createWorkerPlaneOpenSandboxClient(options: WorkerPlaneDeps): OpenSandboxClient {
  const clients = new Map<string, OpenSandboxClient>();
  const listWorkers = options.listWorkers ?? listWorkerNodes;
  const claimWorker = options.claimWorker ?? claimWorkerForDispatch;
  const finalizeLease = options.finalizeLease ?? finalizeSandboxLease;
  const recordLease = options.recordLease ?? recordSandboxLease;
  const lookupLease = options.lookupLease ?? lookupSandboxLease;
  const releaseLease = options.releaseLease ?? releaseSandboxLease;
  const apiKeyOf = options.apiKeyOf ?? workerApiKey;

  function clientFor(node: DispatchableWorker): OpenSandboxClient | null {
    const connection = connectionOf(node, apiKeyOf);
    if (!connection) return null;
    const cached = clients.get(node.id);
    if (cached) return cached;
    const created = options.createClient(connection);
    clients.set(node.id, created);
    return created;
  }

  return {
    async create(input) {
      const requireLocal = createNeedsLocalWorker(input);
      const jobId = input.metadata["deepsonar.job"];
      const attemptId = input.metadata["deepsonar.attempt"];
      const claimed = await claimWorker({ requireLocal, now: options.now?.(), jobId, attemptId });
      if (!claimed) throw new Error("WORKER_PLANE_NO_CAPACITY");
      let reserved: string | undefined = claimed.reservationId;
      try {
        const client = clientFor(claimed);
        if (!client) throw new Error(`WORKER_PLANE_API_KEY_MISSING: ${claimed.id}`);
        const session = await client.create(input);
        try {
          await finalizeLease({
            reservationId: claimed.reservationId,
            sandboxId: session.id,
            workerId: claimed.id,
            jobId,
            attemptId,
          });
          reserved = undefined;
        } catch (error) {
          await session.kill().catch(() => {});
          await session.close().catch(() => {});
          throw error;
        }
        return session;
      } finally {
        if (reserved) await releaseLease(reserved).catch(() => {});
      }
    },
    async connect(id) {
      const workerId = await lookupLease(id);
      const nodes = await listWorkers();
      const ordered = workerId ? nodes.filter((node) => node.id === workerId) : nodes;
      for (const node of ordered) {
        const client = clientFor(node);
        if (!client) continue;
        const session = await client.connect(id);
        if (session) {
          if (!workerId) await recordLease({ sandboxId: id, workerId: node.id }).catch(() => {});
          return session;
        }
      }
      return undefined;
    },
    async destroy(id) {
      try {
        const workerId = await lookupLease(id);
        const nodes = await listWorkers();
        const node = workerId ? nodes.find((item) => item.id === workerId) : undefined;
        const client = node ? clientFor(node) : null;
        if (client?.destroy) await client.destroy(id);
        else {
          for (const candidate of nodes) {
            const next = clientFor(candidate);
            if (next?.destroy) await next.destroy(id).catch(() => {});
          }
        }
      } finally {
        await releaseLease(id);
      }
    },
    async list(filter) {
      const items = [];
      for (const node of await listWorkers()) {
        const client = clientFor(node);
        if (!client) continue;
        items.push(...await client.list(filter));
      }
      return items;
    },
  };
}
