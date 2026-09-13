import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceSandboxEnv } from "@deepsonar/shared-types";
import { adbDevices, adbRunner, type AdbRunner, type BrokerAdbDevice } from "./adb.js";
import { appendBrokerEvent } from "./audit-log.js";
import type { BrokerDependencies } from "./config.js";
import { LeaseStore } from "./leases.js";

/**
 * Device broker HTTP 面（#495 Phase 1）。路径与 DeviceLeaseGrant 契约由 shared-types 单源定义：
 *  - GET  /health          （无鉴权；只报可用设备数）
 *  - GET  /devices         （Scheduler 入站 token）
 *  - POST /lease/acquire   （Scheduler 入站 token）
 *  - POST /lease/release   （Scheduler 入站 token 或租约 token）
 *  - GET  /session         （租约 token；沙箱侧短时端点查询）
 */

const AcquireBody = z
  .object({
    job_id: z.string().min(1).max(200),
    attempt_id: z.string().min(1).max(200),
    project_id: z.string().min(1).max(200),
    transport: z.string().min(1).max(32),
    device_key: z.string().min(1).max(200).nullish(),
    model: z.string().min(1).max(120).nullish(),
    exclusive: z.boolean().default(true),
    ttl_sec: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

const ReleaseBody = z
  .object({
    lease_id: z.string().min(1).max(200),
    device_key: z.string().min(1).max(200).optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export type BrokerServerOptions = {
  config: BrokerDependencies;
  /** 允许测试注入 stub adb；默认执行真实 adb。 */
  run?: AdbRunner;
  store?: LeaseStore;
  /** 设备枚举结果缓存，避免每个请求都 shell 出去。 */
  enumerate?: () => Promise<BrokerAdbDevice[]>;
};

function bearer(request: FastifyRequest): string {
  const header = String(request.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function buildBrokerServer(options: BrokerServerOptions): FastifyInstance {
  const { config } = options;
  const run = options.run ?? adbRunner(config.adbBin);
  const store =
    options.store ??
    new LeaseStore({
      allowedKeys: config.allowedKeys,
      leaseSecret: config.leaseSecret,
      ttlDefaultSec: config.leaseTtlSecDefault,
      ttlMaxSec: config.leaseTtlSecMax,
    });
  const enumerate = options.enumerate ?? (() => adbDevices(run));
  const app = Fastify({ logger: false });

  const audit = async (
    event: Parameters<typeof appendBrokerEvent>[1],
  ): Promise<void> => {
    await appendBrokerEvent(config.auditLogPath, event).catch(() => {});
  };

  const denyInbound = (reply: FastifyReply, status: number, errorCode: string, message: string) =>
    reply.code(status).send({ error: message, error_code: errorCode });

  /** Scheduler 入站鉴权（broker 自己的凭据，不是模型/Provider 密钥）。 */
  const inboundAllowed = (request: FastifyRequest): boolean =>
    Boolean(config.inboundToken) && bearer(request) === config.inboundToken;

  app.get("/health", async () => {
    const devices = await enumerate().catch(() => []);
    return { ok: true, devices: devices.length, leases: store.list().filter((l) => l.releasedAt === null).length };
  });

  app.get("/devices", async (request, reply) => {
    if (!inboundAllowed(request)) return denyInbound(reply, 401, "unauthorized", "invalid broker token");
    const devices = await enumerate();
    return {
      devices: devices.map((device) => ({
        key: device.key,
        model: device.model,
        state: device.state,
        transport: device.transport,
        whitelisted: config.allowedKeys.includes(device.key),
      })),
    };
  });

  app.post("/lease/acquire", async (request, reply) => {
    if (!inboundAllowed(request)) return denyInbound(reply, 401, "unauthorized", "invalid broker token");
    const parsed = AcquireBody.safeParse(request.body ?? {});
    if (!parsed.success) return denyInbound(reply, 400, "invalid_payload", "invalid acquire body");
    const body = parsed.data;
    if (!config.adbEndpointHost) {
      await audit({
        action: "lease_acquire",
        job_id: body.job_id,
        actor: "scheduler",
        outcome: "rig_endpoint_unconfigured",
      });
      return denyInbound(reply, 409, "device_not_available", "broker 未配置可被沙箱访问的设备端点主机");
    }
    const devices = await enumerate();
    const outcome = await store.acquire(
      {
        jobId: body.job_id,
        attemptId: body.attempt_id,
        projectId: body.project_id,
        transport: body.transport,
        deviceKey: body.device_key ?? null,
        model: body.model ?? null,
        exclusive: body.exclusive,
        ttlSec: body.ttl_sec ?? config.leaseTtlSecDefault,
      },
      devices,
    );
    if (!outcome.ok) {
      await audit({
        action: "lease_acquire",
        job_id: body.job_id,
        actor: "scheduler",
        outcome: outcome.reason,
        detail: { transport: body.transport, requested_key: body.device_key ?? null },
      });
      // 未实现/未授权与「暂时拿不到设备」必须分开，Scheduler 才不会盲目重试。
      const status = outcome.reason === "unsupported_transport" ? 403 : 409;
      const errorCode =
        outcome.reason === "unsupported_transport" ? "device_not_authorized" : "device_not_available";
      return denyInbound(reply, status, errorCode, `broker 拒绝了租约请求：${outcome.reason}`);
    }
    const { lease } = outcome;
    const endpoint = {
      transport: "adb" as const,
      host: config.adbEndpointHost,
      port: config.adbServerPort,
      env: {},
    };
    const grant = {
      lease_id: lease.leaseId,
      device_key: lease.deviceKey,
      model: devices.find((device) => device.key === lease.deviceKey)?.model ?? null,
      transport: "adb" as const,
      endpoint,
      token: lease.token,
      expires_at: new Date(lease.expiresAt).toISOString(),
    };
    await audit({
      action: "lease_acquire",
      device_key: lease.deviceKey,
      lease_id: lease.leaseId,
      job_id: lease.jobId,
      actor: "scheduler",
      outcome: "granted",
      detail: { transport: endpoint.transport, expires_at: grant.expires_at },
    });
    // 沙箱环境变量由 shared-types 的同一投影函数推导，避免两端各写一套。
    void deviceSandboxEnv(grant, grant.device_key);
    return reply.code(201).send(grant);
  });

  app.post("/lease/release", async (request, reply) => {
    const parsed = ReleaseBody.safeParse(request.body ?? {});
    if (!parsed.success) return denyInbound(reply, 400, "invalid_payload", "invalid release body");
    const token = bearer(request);
    const inbound = inboundAllowed(request);
    const session = inbound ? null : await store.session(token);
    if (!inbound && !session) {
      await audit({
        action: "lease_release",
        lease_id: parsed.data.lease_id,
        actor: "unknown",
        outcome: "denied",
      });
      return denyInbound(reply, 401, "unauthorized", "invalid broker or lease token");
    }
    if (!inbound && session && session.leaseId !== parsed.data.lease_id) {
      return denyInbound(reply, 403, "device_not_authorized", "lease token does not match lease_id");
    }
    const result = store.release(parsed.data.lease_id, parsed.data.reason ?? "released");
    await audit({
      action: "lease_release",
      device_key: result.lease?.deviceKey ?? null,
      lease_id: parsed.data.lease_id,
      job_id: result.lease?.jobId ?? null,
      actor: inbound ? "scheduler" : "sandbox",
      outcome: result.lease ? (result.lease.releaseReason ?? "released") : "unknown_lease",
    });
    return reply.code(200).send({ ok: true, released: Boolean(result.lease) });
  });

  app.get("/session", async (request, reply) => {
    const token = bearer(request);
    const session = await store.session(token);
    if (!session) return denyInbound(reply, 401, "unauthorized", "invalid or expired lease token");
    if (!config.adbEndpointHost) {
      return denyInbound(reply, 409, "device_not_available", "broker 未配置设备端点主机");
    }
    return {
      lease_id: session.leaseId,
      device_key: session.deviceKey,
      transport: "adb",
      expires_at: new Date(session.expiresAt).toISOString(),
      endpoint: {
        transport: "adb",
        host: config.adbEndpointHost,
        port: config.adbServerPort,
        env: {},
      },
    };
  });

  return app;
}
