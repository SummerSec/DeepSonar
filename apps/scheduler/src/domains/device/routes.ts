import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DeviceRegistration, DeviceStatusAction } from "@deepsonar/shared-types";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import { validationHttpError } from "../../http-validation-error.js";
import { parseBoundedLimit } from "../../pagination.js";
import { isUuid } from "../../project-scope.js";
import {
  recordDeviceEvents,
  releaseDeviceLeasesForJob,
} from "./application.js";
import { deviceBrokerConfigured } from "./broker-client.js";
import {
  deviceDeleteBlocked,
  registrationRow,
  statusAfterAction,
} from "./management.js";
import {
  desiredRigDevices,
  pushRigAdmission,
  readRigAdmission,
  rigRegistryConfigured,
  type PushOutcome,
} from "./rig-registry.js";

/**
 * 设备准入与管理面（#505 阶段 1）：平台是权威。
 *
 * - 登记项以 `key`（= broker 侧设备句柄，通常是序列号）为身份；写操作后把当前期望集合整集推给 rig 的
 *   broker（未配置 broker 时跳过，不假装成功）；
 * - 推送结果不参与事务：DB 写入是平台侧真相，broker 同步失败只作为 `rig_push` 上报，由操作者重试；
 * - 项目主体（`actor.projectId`）只能管理本项目设备；`project_id` 为空的平台共享池仅平台主体可改；
 * - 有在途租约时不下架、不删除（避免"已下架但还租着"的中间态），必须先强制释放。
 */

const PROJECT_MISMATCH = "PROJECT_MISMATCH";

type DeviceListRow = {
  id: string;
  project_id: string | null;
  key: string;
  model: string | null;
  transport: string;
  broker_ref: string | null;
  status: string;
  capabilities_json: unknown;
  spec_json: unknown;
  created_at: string;
  updated_at: string;
  lease_id: string | null;
  lease_job_id: string | null;
  lease_state: string | null;
  lease_expires_at: string | null;
};

function badRequest(
  reply: FastifyReply,
  error: unknown,
  fallback: string,
): FastifyReply {
  const mapped = validationHttpError(error);
  return reply
    .code(mapped?.statusCode ?? 400)
    .send(mapped?.body ?? { error: fallback, error_code: "INVALID_BODY" });
}

/** 路径参数必须是 UUID：形状不对一律 400，不把任意字符串带进 SQL。 */
function uuidParam(value: string | undefined): string | null {
  return value !== undefined && isUuid(value) ? value : null;
}

/** 项目主体只能碰本项目设备；平台主体（无 projectId）可管共享池。 */
function projectAllowed(
  req: FastifyRequest,
  deviceProjectId: string | null,
): boolean {
  const actorProjectId = req.actor?.projectId ?? null;
  if (!actorProjectId) return true;
  return deviceProjectId === actorProjectId;
}

function forbidden(reply: FastifyReply, req: FastifyRequest): FastifyReply {
  return reply.code(403).send({
    error: `token 仅限项目 ${req.actor?.projectId ?? ""}`,
    error_code: PROJECT_MISMATCH,
  });
}

/**
 * 把当前期望集合整集推给该 rig 的 broker。`devices.broker_ref` 是 broker 侧设备句柄，
 * 不是 rig 标识：本阶段一个 Scheduler 只对单一 broker URL 推送（多 rig 需要按 rig 配置端点）。
 */
async function pushDesiredDevices(): Promise<PushOutcome | null> {
  if (!rigRegistryConfigured()) return null;
  const rows = await sql<
    Array<{
      key: string;
      transport: string;
      model: string | null;
      status: string;
      updated_at: unknown;
    }>
  >`SELECT key, transport, model, status, updated_at FROM devices ORDER BY key`;
  return pushRigAdmission(desiredRigDevices(rows));
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  app.get("/devices", async (req) => {
    const query = req.query as {
      status?: string;
      project_id?: string;
      limit?: string;
    };
    const limit = parseBoundedLimit(query.limit, { max: 500, fallback: 200 });
    const actorProjectId = req.actor?.projectId ?? null;
    const devices = await sql<DeviceListRow[]>`
      SELECT d.id, d.project_id, d.key, d.model, d.transport, d.broker_ref, d.status,
             d.capabilities_json, d.spec_json, d.created_at, d.updated_at,
             l.id AS lease_id, l.job_id AS lease_job_id, l.state AS lease_state,
             l.expires_at AS lease_expires_at
      FROM devices d
      LEFT JOIN device_leases l
        ON l.device_id = d.id AND l.state IN ('pending', 'active')
      WHERE (${query.status ?? null}::text IS NULL OR d.status = ${query.status ?? null})
        AND (${query.project_id ?? null}::uuid IS NULL OR d.project_id = ${query.project_id ?? null}::uuid)
        AND (${actorProjectId}::uuid IS NULL OR d.project_id = ${actorProjectId}::uuid)
      ORDER BY d.key ASC
      LIMIT ${limit}`;
    return {
      devices,
      rig: {
        enabled: config.device.enabled,
        broker_configured: deviceBrokerConfigured(),
        transports: config.device.transports,
        admission: await readRigAdmission(),
      },
    };
  });

  app.post("/devices", async (req, reply) => {
    const parsed = DeviceRegistration.safeParse(req.body);
    if (!parsed.success)
      return badRequest(reply, parsed.error, "invalid device registration");
    const row = registrationRow(parsed.data);
    if (!projectAllowed(req, row.project_id)) return forbidden(reply, req);
    if (row.project_id) {
      const [project] = await sql<[{ id: string }?]>`
        SELECT id FROM projects WHERE id = ${row.project_id}`;
      if (!project)
        return reply
          .code(400)
          .send({ error: "project not found", error_code: "INVALID_PROJECT" });
    }
    const [device] = await sql<
      Array<{ id: string; status: string; created_at: string }>
    >`
      INSERT INTO devices (
        project_id, key, model, transport, broker_ref, status, capabilities_json, spec_json
      ) VALUES (
        ${row.project_id}, ${row.key}, ${row.model}, ${row.transport}, ${row.key},
        ${row.status}, ${sql.json([row.transport] as never)}, ${sql.json({} as never)}
      )
      ON CONFLICT (key) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        model = COALESCE(EXCLUDED.model, devices.model),
        transport = EXCLUDED.transport,
        status = EXCLUDED.status,
        updated_at = now()
      RETURNING id, status, created_at`;
    if (!device)
      return reply
        .code(500)
        .send({ error: "device write failed", error_code: "DEVICE_WRITE_FAILED" });
    const actor = req.actor?.name ?? "anonymous";
    await recordDeviceEvents(sql, [
      {
        device_id: device.id,
        lease_id: null,
        job_id: null,
        actor,
        action: "device_register",
        payload: {
          device_key: row.key,
          transport: row.transport,
          project_id: row.project_id,
          status: device.status,
        },
      },
    ]);
    await audit(req, {
      action: "device.register",
      resourceType: "device",
      resourceId: device.id,
      after: {
        device_key: row.key,
        transport: row.transport,
        project_id: row.project_id,
        status: device.status,
      },
    });
    return reply.code(201).send({
      device: {
        id: device.id,
        project_id: row.project_id,
        key: row.key,
        model: row.model,
        transport: row.transport,
        status: device.status,
        created_at: device.created_at,
      },
      rig_push: await pushDesiredDevices(),
    });
  });

  app.patch("/devices/:id", async (req, reply) => {
    const deviceId = uuidParam((req.params as { id?: string }).id);
    if (!deviceId)
      return reply
        .code(400)
        .send({ error: "invalid device id", error_code: "INVALID_ID" });
    const parsed = DeviceStatusAction.safeParse(
      (req.body as { action?: unknown } | undefined)?.action,
    );
    if (!parsed.success)
      return badRequest(reply, parsed.error, "invalid device status action");
    const [current] = await sql<
      [{ id: string; project_id: string | null; key: string; status: string }?]
    >`SELECT id, project_id, key, status FROM devices WHERE id = ${deviceId}`;
    if (!current)
      return reply
        .code(404)
        .send({ error: "device not found", error_code: "DEVICE_NOT_FOUND" });
    if (!projectAllowed(req, current.project_id)) return forbidden(reply, req);
    const [active] = await sql<[{ id: string; job_id: string }?]>`
      SELECT id, job_id FROM device_leases
      WHERE device_id = ${deviceId} AND state IN ('pending', 'active')`;
    // 下架会把设备从 broker 准入集合里摘掉；设备还在租用中时先让操作者强制释放，
    // 否则运行中的 Job 会突然失去设备端点。
    if (active && parsed.data === "revoke")
      return reply.code(409).send({
        error: "设备仍有在途租约，请先强制释放",
        error_code: "DEVICE_HAS_ACTIVE_LEASE",
        lease_id: active.id,
        job_id: active.job_id,
      });
    const status = statusAfterAction(parsed.data);
    await sql`UPDATE devices SET status = ${status}, updated_at = now() WHERE id = ${deviceId}`;
    const actor = req.actor?.name ?? "anonymous";
    await recordDeviceEvents(sql, [
      {
        device_id: deviceId,
        lease_id: null,
        job_id: null,
        actor,
        action: "device_status",
        payload: {
          device_key: current.key,
          from: current.status,
          to: status,
          action: parsed.data,
        },
      },
    ]);
    await audit(req, {
      action: "device.status",
      resourceType: "device",
      resourceId: deviceId,
      before: { status: current.status },
      after: { status, action: parsed.data },
    });
    return reply.send({
      device: { id: deviceId, key: current.key, status },
      rig_push: await pushDesiredDevices(),
    });
  });

  app.delete("/devices/:id", async (req, reply) => {
    const deviceId = uuidParam((req.params as { id?: string }).id);
    if (!deviceId)
      return reply
        .code(400)
        .send({ error: "invalid device id", error_code: "INVALID_ID" });
    const actor = req.actor?.name ?? "anonymous";
    const outcome = await sql.begin(async (txRaw) => {
      // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
      const tx = txRaw as unknown as typeof sql;
      const [device] = await tx<
        [{ id: string; project_id: string | null; key: string }?]
      >`SELECT id, project_id, key FROM devices WHERE id = ${deviceId} FOR UPDATE`;
      if (!device) return { kind: "not_found" };
      if (!projectAllowed(req, device.project_id)) return { kind: "forbidden" };
      const active = await tx<Array<{ id: string }>>`
        SELECT id FROM device_leases
        WHERE device_id = ${deviceId} AND state IN ('pending', 'active')`;
      if (deviceDeleteBlocked(active.length))
        return { kind: "has_lease", leaseId: active[0]?.id ?? null };
      // 租约历史（含已释放）是 append-only 审计，且 device_leases.device_id 有外键：
      // 有过租约的登记项只能下架（revoke）把它摘出 rig 准入集合，不能删除。
      const [history] = await tx<[{ count: number }?]>`
        SELECT count(*)::int AS count FROM device_leases WHERE device_id = ${deviceId}`;
      if ((history?.count ?? 0) > 0) return { kind: "has_history" };
      await tx`DELETE FROM devices WHERE id = ${deviceId}`;
      await recordDeviceEvents(tx, [
        {
          device_id: deviceId,
          lease_id: null,
          job_id: null,
          actor,
          action: "device_delete",
          payload: { device_key: device.key },
        },
      ]);
      return { kind: "deleted", key: device.key };
    });
    if (outcome.kind === "not_found")
      return reply
        .code(404)
        .send({ error: "device not found", error_code: "DEVICE_NOT_FOUND" });
    if (outcome.kind === "forbidden") return forbidden(reply, req);
    if (outcome.kind === "has_lease")
      return reply.code(409).send({
        error: "设备仍有在途租约，请先强制释放",
        error_code: "DEVICE_HAS_ACTIVE_LEASE",
        lease_id: outcome.leaseId,
      });
    if (outcome.kind === "has_history")
      return reply.code(409).send({
        error: "设备有租约历史（审计不可删），请改用 PATCH action=revoke 下架",
        error_code: "DEVICE_HAS_LEASE_HISTORY",
      });
    await audit(req, {
      action: "device.delete",
      resourceType: "device",
      resourceId: deviceId,
      before: { device_key: outcome.key },
    });
    return reply.send({
      deleted: true,
      device_key: outcome.key,
      rig_push: await pushDesiredDevices(),
    });
  });

  app.get("/device-leases", async (req) => {
    const query = req.query as {
      state?: string;
      job_id?: string;
      device_id?: string;
      project_id?: string;
      limit?: string;
    };
    const limit = parseBoundedLimit(query.limit, { max: 500, fallback: 200 });
    const actorProjectId = req.actor?.projectId ?? null;
    const leases = await sql`
      SELECT l.id, l.device_id, l.job_id, l.attempt_id, l.project_id, l.state,
             l.granted_by, l.granted_at, l.expires_at, l.released_at, l.release_reason,
             l.created_at, l.updated_at,
             d.key AS device_key, d.transport AS device_transport
      FROM device_leases l
      JOIN devices d ON d.id = l.device_id
      WHERE (${query.state ?? null}::text IS NULL OR l.state = ${query.state ?? null})
        AND (${query.job_id ?? null}::uuid IS NULL OR l.job_id = ${query.job_id ?? null}::uuid)
        AND (${query.device_id ?? null}::uuid IS NULL OR l.device_id = ${query.device_id ?? null}::uuid)
        AND (${query.project_id ?? null}::uuid IS NULL OR l.project_id = ${query.project_id ?? null}::uuid)
        AND (${actorProjectId}::uuid IS NULL OR l.project_id = ${actorProjectId}::uuid)
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${limit}`;
    return { leases };
  });

  app.post("/device-leases/:id/release", async (req, reply) => {
    const leaseId = uuidParam((req.params as { id?: string }).id);
    if (!leaseId)
      return reply
        .code(400)
        .send({ error: "invalid lease id", error_code: "INVALID_ID" });
    const [lease] = await sql<
      [
        {
          id: string;
          device_id: string;
          job_id: string;
          project_id: string | null;
          state: string;
        }?,
      ]
    >`SELECT id, device_id, job_id, project_id, state FROM device_leases WHERE id = ${leaseId}`;
    if (!lease)
      return reply.code(404).send({
        error: "device lease not found",
        error_code: "DEVICE_LEASE_NOT_FOUND",
      });
    if (!projectAllowed(req, lease.project_id)) return forbidden(reply, req);
    if (lease.state !== "pending" && lease.state !== "active")
      return reply.code(409).send({
        error: "租约已结束",
        error_code: "DEVICE_LEASE_NOT_ACTIVE",
        state: lease.state,
      });
    await recordDeviceEvents(sql, [
      {
        device_id: lease.device_id,
        lease_id: lease.id,
        job_id: lease.job_id,
        actor: req.actor?.name ?? "anonymous",
        action: "lease_force_release",
        payload: { reason: "manual_release" },
      },
    ]);
    await audit(req, {
      action: "device.lease_force_release",
      resourceType: "device_lease",
      resourceId: lease.id,
      before: { state: lease.state },
      after: { reason: "manual_release" },
    });
    // 复用 Job 终态释放路径：置 released + 设备回 idle + 通知 broker（broker 失败只记录，
    // 其自身租约 TTL 与 Reaper 兜底回收）。
    const released = await releaseDeviceLeasesForJob(lease.job_id, "manual_release");
    return reply.send({ released, rig_push: await pushDesiredDevices() });
  });

  app.get("/devices/:id/events", async (req, reply) => {
    const deviceId = uuidParam((req.params as { id?: string }).id);
    if (!deviceId)
      return reply
        .code(400)
        .send({ error: "invalid device id", error_code: "INVALID_ID" });
    const [device] = await sql<
      [{ id: string; project_id: string | null; key: string }?]
    >`SELECT id, project_id, key FROM devices WHERE id = ${deviceId}`;
    if (!device)
      return reply
        .code(404)
        .send({ error: "device not found", error_code: "DEVICE_NOT_FOUND" });
    if (!projectAllowed(req, device.project_id)) return forbidden(reply, req);
    const query = req.query as { limit?: string };
    const limit = parseBoundedLimit(query.limit, { max: 500, fallback: 200 });
    const events = await sql`
      SELECT id::text AS id, device_id, lease_id, job_id, actor, action, payload_json, created_at
      FROM device_events
      WHERE device_id = ${deviceId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}`;
    return { device: { id: device.id, key: device.key }, events };
  });
}
