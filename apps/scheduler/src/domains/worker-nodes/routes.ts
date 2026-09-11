import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import {
  bootstrapTokenConfigured,
  bootstrapTokenMatches,
  forgetWorkerNode,
  heartbeatWorker,
  listWorkerNodes,
  registerRemoteWorker,
  workerStaleAfterMs,
} from "./registry.js";
import { parseWorkerCapacity, publicWorkerView, WorkerNodeError } from "./model.js";
import { consumeWorkerRateLimit, WorkerRateLimitError } from "./rate-limit.js";

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

function clientKey(req: FastifyRequest): string {
  return req.ip?.trim() || "unknown";
}

function consumePlaneRateLimit(req: FastifyRequest, scope: "register" | "heartbeat"): void {
  const knobs = config.runtime.workerNodes;
  consumeWorkerRateLimit({
    scope,
    key: clientKey(req),
    windowMs: knobs.rateLimitWindowSec * 1000,
    limit: scope === "register" ? knobs.registerLimitPerWindow : knobs.heartbeatLimitPerWindow,
  });
}

export function workerNodeHttpError(error: unknown): { statusCode: number; body: Record<string, unknown> } | null {
  if (error instanceof WorkerRateLimitError) {
    return {
      statusCode: 429,
      body: { error: error.message, error_code: error.code, retry_after_sec: error.retryAfterSec },
    };
  }
  if (error instanceof WorkerNodeError) {
    return { statusCode: error.statusCode, body: { error: error.message, error_code: error.code } };
  }
  if (error instanceof z.ZodError) {
    return { statusCode: 400, body: { error: "invalid worker request", error_code: "WORKER_REQUEST_INVALID" } };
  }
  return null;
}

function sendWorkerError(reply: FastifyReply, error: unknown) {
  const mapped = workerNodeHttpError(error);
  if (!mapped) throw error;
  if (error instanceof WorkerRateLimitError) reply.header("Retry-After", String(error.retryAfterSec));
  return reply.code(mapped.statusCode).send(mapped.body);
}

function auditWorker(
  req: FastifyRequest,
  entry: {
    action: string;
    resourceId?: string | null;
    result?: "ok" | "denied" | "error";
    errorCode?: string | null;
    after?: unknown;
  },
): Promise<void> {
  return audit(req, {
    action: entry.action,
    resourceType: "worker_node",
    resourceId: entry.resourceId ?? null,
    result: entry.result ?? "ok",
    errorCode: entry.errorCode ?? null,
    after: entry.after,
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
    try {
      consumePlaneRateLimit(req, "register");
    } catch (error) {
      await auditWorker(req, { action: "worker.register", result: "denied", errorCode: "WORKER_RATE_LIMITED" });
      return sendWorkerError(reply, error);
    }
    if (!bootstrapTokenConfigured()) {
      await auditWorker(req, { action: "worker.register", result: "denied", errorCode: "WORKER_BOOTSTRAP_DISABLED" });
      return reply.code(403).send({ error: "worker bootstrap token is not configured", error_code: "WORKER_BOOTSTRAP_DISABLED" });
    }
    const token = bearerToken(req.headers.authorization);
    if (!token || !bootstrapTokenMatches(token)) {
      await auditWorker(req, { action: "worker.register", result: "denied", errorCode: "WORKER_BOOTSTRAP_INVALID" });
      return reply.code(401).send({ error: "invalid worker bootstrap token", error_code: "WORKER_BOOTSTRAP_INVALID" });
    }
    let nodeId: string | undefined;
    try {
      const body = RegisterBody.parse(req.body);
      nodeId = body.node_id;
      const { node, nodeToken } = await registerRemoteWorker({
        nodeId: body.node_id,
        endpoint: body.endpoint,
        protocol: body.protocol,
        apiKey: body.opensandbox_api_key,
        capacity: capacityFromBody(body.capacity),
        labels: body.labels,
      });
      await auditWorker(req, {
        action: "worker.register",
        resourceId: node.id,
        after: { endpoint: node.endpoint, protocol: node.protocol, kind: node.kind, node_token_prefix: node.nodeTokenPrefix },
      });
      return reply.code(201).send({
        node_id: node.id,
        node_token: nodeToken,
        heartbeat_interval_sec: 15,
      });
    } catch (error) {
      const mapped = workerNodeHttpError(error);
      await auditWorker(req, {
        action: "worker.register",
        resourceId: nodeId ?? null,
        result: "denied",
        errorCode: mapped ? String(mapped.body.error_code) : "WORKER_REGISTER_FAILED",
      });
      return sendWorkerError(reply, error);
    }
  });

  app.post("/workers/heartbeat", async (req, reply) => {
    try {
      consumePlaneRateLimit(req, "heartbeat");
    } catch (error) {
      await auditWorker(req, { action: "worker.heartbeat", result: "denied", errorCode: "WORKER_RATE_LIMITED" });
      return sendWorkerError(reply, error);
    }
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      await auditWorker(req, { action: "worker.heartbeat", result: "denied", errorCode: "WORKER_NODE_TOKEN_MISSING" });
      return reply.code(401).send({ error: "missing worker node token", error_code: "WORKER_NODE_TOKEN_MISSING" });
    }
    let nodeId: string | undefined;
    try {
      const body = HeartbeatBody.parse(req.body ?? {});
      nodeId = body.node_id;
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
        await auditWorker(req, {
          action: "worker.heartbeat",
          resourceId: nodeId ?? null,
          result: "denied",
          errorCode: "WORKER_NODE_TOKEN_INVALID",
        });
        return reply.code(401).send({ error: "invalid worker node token", error_code: "WORKER_NODE_TOKEN_INVALID" });
      }
      return { node_id: node.id, status: "online" };
    } catch (error) {
      const mapped = workerNodeHttpError(error);
      await auditWorker(req, {
        action: "worker.heartbeat",
        resourceId: nodeId ?? null,
        result: "denied",
        errorCode: mapped ? String(mapped.body.error_code) : "WORKER_HEARTBEAT_FAILED",
      });
      return sendWorkerError(reply, error);
    }
  });

  app.delete("/workers/:id", async (req, reply) => {
    try {
      const id = z.string().trim().min(1).max(64).parse((req.params as { id: string }).id);
      const node = await forgetWorkerNode(id);
      if (!node) {
        await auditWorker(req, { action: "worker.forget", resourceId: id, result: "denied", errorCode: "WORKER_NODE_NOT_FOUND" });
        return reply.code(404).send({ error: "worker node not found", error_code: "WORKER_NODE_NOT_FOUND" });
      }
      await auditWorker(req, {
        action: "worker.forget",
        resourceId: node.id,
        after: { endpoint: node.endpoint, protocol: node.protocol, kind: node.kind },
      });
      return { forgotten: true, node_id: node.id };
    } catch (error) {
      return sendWorkerError(reply, error);
    }
  });
}
