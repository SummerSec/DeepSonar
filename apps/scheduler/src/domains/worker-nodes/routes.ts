import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bootstrapTokenConfigured,
  bootstrapTokenMatches,
  heartbeatWorker,
  listWorkerNodes,
  registerRemoteWorker,
  workerStaleAfterMs,
} from "./registry.js";
import { parseWorkerCapacity, publicWorkerView } from "./model.js";

const CapacityBody = z.object({
  max_sandboxes: z.number().int().min(1).max(1_000),
  memory_mib: z.number().int().min(256).max(1_000_000),
  cpu: z.number().int().min(1).max(512),
}).strict();

const RegisterBody = z.object({
  node_id: z.string().trim().min(1).max(64),
  endpoint: z.string().trim().min(1).max(256),
  protocol: z.enum(["http", "https"]).optional(),
  opensandbox_api_key: z.string().min(1).max(512),
  capacity: CapacityBody,
  labels: z.record(z.string().min(1).max(64), z.string().max(128)).optional(),
}).strict();

const HeartbeatBody = z.object({
  node_id: z.string().trim().min(1).max(64).optional(),
  endpoint: z.string().trim().min(1).max(256).optional(),
  protocol: z.enum(["http", "https"]).optional(),
  opensandbox_api_key: z.string().min(1).max(512).optional(),
  capacity: CapacityBody.optional(),
  labels: z.record(z.string().min(1).max(64), z.string().max(128)).optional(),
}).strict();

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function capacityFromBody(body: z.infer<typeof CapacityBody>) {
  return parseWorkerCapacity({
    maxSandboxes: body.max_sandboxes,
    memoryMib: body.memory_mib,
    cpu: body.cpu,
  });
}

export function registerWorkerNodeRoutes(app: FastifyInstance): void {
  app.get("/workers", async () => {
    const now = Date.now();
    const staleAfterMs = workerStaleAfterMs();
    const workers = await listWorkerNodes();
    return {
      workers: workers.map((node) => publicWorkerView(node, now, staleAfterMs)),
    };
  });

  app.post("/workers/register", async (req, reply) => {
    if (!bootstrapTokenConfigured()) {
      return reply.code(403).send({ error: "worker bootstrap token is not configured", error_code: "WORKER_BOOTSTRAP_DISABLED" });
    }
    const token = bearerToken(req.headers.authorization);
    if (!token || !bootstrapTokenMatches(token)) {
      return reply.code(401).send({ error: "invalid worker bootstrap token", error_code: "WORKER_BOOTSTRAP_INVALID" });
    }
    const body = RegisterBody.parse(req.body);
    const { node, nodeToken } = await registerRemoteWorker({
      nodeId: body.node_id,
      endpoint: body.endpoint,
      protocol: body.protocol,
      apiKey: body.opensandbox_api_key,
      capacity: capacityFromBody(body.capacity),
      labels: body.labels,
    });
    return reply.code(201).send({
      node_id: node.id,
      node_token: nodeToken,
      heartbeat_interval_sec: 15,
    });
  });

  app.post("/workers/heartbeat", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "missing worker node token", error_code: "WORKER_NODE_TOKEN_MISSING" });
    }
    const body = HeartbeatBody.parse(req.body ?? {});
    const node = await heartbeatWorker({
      token,
      nodeId: body.node_id,
      endpoint: body.endpoint,
      protocol: body.protocol,
      apiKey: body.opensandbox_api_key,
      capacity: body.capacity ? capacityFromBody(body.capacity) : undefined,
      labels: body.labels,
    });
    if (!node) {
      return reply.code(401).send({ error: "invalid worker node token", error_code: "WORKER_NODE_TOKEN_INVALID" });
    }
    return { node_id: node.id, status: "online" };
  });
}
