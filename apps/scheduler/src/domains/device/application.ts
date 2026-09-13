import { randomUUID } from "node:crypto";
import {
  DeviceRequirement,
  deviceSandboxEnv,
  isImplementedDeviceTransport,
} from "@deepsonar/shared-types";
import { config } from "../../config.js";
import { sql } from "../../db.js";
import { frozenSnapshotAllowEgress } from "../role-runtime-snapshot/index.js";
import {
  DeviceNotAuthorizedError,
  DeviceNotAvailableError,
  acquireDeviceOnBroker,
  deviceBrokerConfigured,
  releaseDeviceOnBroker,
} from "./broker-client.js";

/**
 * 设备租约应用层（#495）：授权 → 向 broker 申请 → 落库（DB 是独占性的最终仲裁者）→
 * 终态/过期释放。Phase 1 只支持 adb + 独占，且只在项目 opt-in 后可用。
 */

export type FrozenDeviceRequirement = DeviceRequirement;

/** 只认冻结在 Job 快照里的设备需求；执行期不回读可变项目配置。 */
export function deviceRequirementFromSnapshot(
  snapshot: unknown,
): FrozenDeviceRequirement | null {
  const value =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).device_requirement
      : undefined;
  if (value === undefined || value === null) return null;
  const parsed = DeviceRequirement.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Job 是否该占用设备：需求声明的角色名必须命中本 Job 的角色。 */
export function jobNeedsDevice(snapshot: unknown, roleName: string): boolean {
  const requirement = deviceRequirementFromSnapshot(snapshot);
  return Boolean(requirement && requirement.roles.includes(roleName));
}

/**
 * 设备数据面是沙箱直连 rig 端点（Phase 1 未实现固定目标转发），所以设备任务必须允许出网；
 * 否则授权能过、租约能发，但沙箱内 `adb`/`hdc` 必然连不上：只会晚失败并白占设备（#506）。
 * 缺失或非 true 一律视为不允许（fail closed）。
 */
export function assertDeviceEgressAllowed(
  requirement: FrozenDeviceRequirement | null,
  allowEgress: boolean | undefined,
): void {
  if (!requirement) return;
  if (allowEgress === true) return;
  throw new DeviceNotAuthorizedError(
    "设备任务必须允许出网（network_policy.allow_egress=true）：沙箱直连 rig 端点，未实现固定目标转发",
  );
}

async function projectDeviceAccessEnabled(
  db: typeof sql,
  projectId: string,
): Promise<boolean> {
  const [row] = await db<[{ config_json?: unknown }?]>`
    SELECT config_json FROM projects WHERE id = ${projectId}`;
  const config_json = row?.config_json;
  if (
    !config_json ||
    typeof config_json !== "object" ||
    Array.isArray(config_json)
  )
    return false;
  return (
    (config_json as Record<string, unknown>).device_access_enabled === true
  );
}

/**
 * 授权是租约的前置条件，且在申请时重新校验（发现接口不是授权）：
 * 功能未启用、Phase 1 之外的 transport、非独占、项目未 opt-in 都 fail closed。
 */
export async function assertDeviceAccessAuthorized(
  db: typeof sql,
  projectId: string,
  requirement: FrozenDeviceRequirement,
): Promise<void> {
  if (!deviceBrokerConfigured()) {
    throw new DeviceNotAuthorizedError(
      "平台未启用真实设备接入（DEEPSONAR_DEVICE_ENABLED / broker 未配置）",
    );
  }
  if (!isImplementedDeviceTransport(requirement.transport)) {
    throw new DeviceNotAuthorizedError(
      `平台尚未实现 ${requirement.transport} 设备接入（当前仅 adb / hdc）`,
    );
  }
  if (!config.device.transports.includes(requirement.transport)) {
    throw new DeviceNotAuthorizedError(
      `平台未启用 ${requirement.transport} 设备接入（DEEPSONAR_DEVICE_TRANSPORTS）`,
    );
  }
  if (!requirement.exclusive) {
    throw new DeviceNotAuthorizedError("Phase 1 只支持独占设备租约");
  }
  if (!(await projectDeviceAccessEnabled(db, projectId))) {
    throw new DeviceNotAuthorizedError(
      "项目未启用设备接入（device_access_enabled=false）",
    );
  }
}

export async function recordDeviceEvents(
  db: typeof sql,
  rows: Array<{
    device_id: string | null;
    lease_id: string | null;
    job_id: string | null;
    actor: string;
    action: string;
    payload?: Record<string, unknown>;
  }>,
): Promise<void> {
  for (const row of rows) {
    await db`
      INSERT INTO device_events (device_id, lease_id, job_id, actor, action, payload_json)
      VALUES (${row.device_id}, ${row.lease_id}, ${row.job_id}, ${row.actor}, ${row.action}, ${db.json((row.payload ?? {}) as never)})`;
  }
}

export type DeviceLeaseHandle = {
  leaseId: string;
  deviceKey: string;
  /** 沙箱环境变量投影（含短期租约 token；不落库、不写审计）。 */
  env: Record<string, string>;
  expiresAt: string;
};

/**
 * 为一个 Attempt 申请设备租约。
 *
 * 顺序固定为「先 broker 授权发放，再落库」：`device_leases_one_active` 部分唯一索引是
 * 独占性的最终仲裁者，落库冲突时立刻把 broker 侧租约还回去，避免泄漏设备。
 * 返回 null 表示该快照不需要设备。
 */
export async function acquireDeviceLeaseForJob(input: {
  jobId: string;
  attemptId: string;
  projectId: string;
  snapshot: unknown;
  roleName: string;
}): Promise<DeviceLeaseHandle | null> {
  if (!jobNeedsDevice(input.snapshot, input.roleName)) return null;
  const requirement = deviceRequirementFromSnapshot(input.snapshot);
  if (!requirement) {
    throw new DeviceNotAuthorizedError(
      "Job 快照里的 device_requirement 不合法",
    );
  }
  assertDeviceEgressAllowed(
    requirement,
    frozenSnapshotAllowEgress(input.snapshot),
  );
  await assertDeviceAccessAuthorized(sql, input.projectId, requirement);

  const leaseId = randomUUID();
  const grant = await acquireDeviceOnBroker({
    jobId: input.jobId,
    attemptId: input.attemptId,
    projectId: input.projectId,
    requirement,
  });
  // broker 是不可信外部进程：返回的 transport 必须与冻结需求一致，否则按契约不符 fail closed，
  // 并把 broker 侧刚发出的租约还回去（#504）。
  if (grant.transport !== requirement.transport) {
    await releaseDeviceOnBroker({
      leaseId,
      deviceKey: grant.device_key,
      reason: "transport_mismatch",
    }).catch(() => {});
    throw new DeviceNotAvailableError(
      `device broker 返回的 transport(${grant.transport}) 与需求(${requirement.transport}) 不一致`,
    );
  }

  try {
    await sql.begin(async (txRaw) => {
      // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
      const tx = txRaw as unknown as typeof sql;
      const [device] = await tx<[{ id: string; status: string }?]>`
        INSERT INTO devices (project_id, key, model, transport, broker_ref, status, capabilities_json, spec_json)
        VALUES (${null}, ${grant.device_key}, ${grant.model ?? null}, ${grant.transport},
                ${grant.device_key}, 'leased', ${tx.json([grant.transport] as never)}, ${tx.json({} as never)})
        ON CONFLICT (key) DO UPDATE SET
          model = COALESCE(EXCLUDED.model, devices.model),
          transport = EXCLUDED.transport,
          broker_ref = EXCLUDED.broker_ref,
          status = 'leased',
          updated_at = now()
        RETURNING id, status`;
      if (!device) throw new DeviceNotAvailableError("设备登记失败");
      await tx`
        INSERT INTO device_leases (
          id, device_id, job_id, attempt_id, project_id, state, endpoint_json,
          granted_by, granted_at, expires_at
        ) VALUES (
          ${leaseId}, ${device.id}, ${input.jobId}, ${input.attemptId}, ${input.projectId},
          'active', ${tx.json(grant.endpoint as never)}, ${"dispatcher"},
          now(), ${grant.expires_at}
        )`;
      await recordDeviceEvents(tx, [
        {
          device_id: device.id,
          lease_id: leaseId,
          job_id: input.jobId,
          actor: "dispatcher",
          action: "lease_acquire",
          payload: {
            device_key: grant.device_key,
            transport: grant.transport,
            expires_at: grant.expires_at,
            attempted: input.attemptId,
          },
        },
      ]);
    });
  } catch (error) {
    // 落库失败（含并发抢不到设备）必须把 broker 侧租约还回去。
    await releaseDeviceOnBroker({
      leaseId,
      deviceKey: grant.device_key,
      reason: "db_rollback",
    }).catch(() => {});
    if (
      error instanceof DeviceNotAvailableError ||
      error instanceof DeviceNotAuthorizedError
    )
      throw error;
    const code = (error as { code?: string })?.code;
    if (code === "23505")
      throw new DeviceNotAvailableError("设备已被其他 Job 占用");
    throw new DeviceNotAvailableError(
      `设备租约落库失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    leaseId,
    deviceKey: grant.device_key,
    env: deviceSandboxEnv(grant, grant.device_key),
    expiresAt: grant.expires_at,
  };
}

/**
 * 释放某个 Job 的全部未结束租约并把设备放回 idle。幂等；broker 侧失败只记录不抛出，
 * 因为 broker 自身租约 TTL 与 Reaper 会兜底回收。
 */
export async function releaseDeviceLeasesForJob(
  jobId: string,
  reason: string,
): Promise<number> {
  const leases = await sql.begin(async (txRaw) => {
    // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
    const tx = txRaw as unknown as typeof sql;
    const active = await tx<
      Array<{ id: string; device_id: string; key: string }>
    >`
      SELECT l.id, l.device_id, d.key
      FROM device_leases l
      JOIN devices d ON d.id = l.device_id
      WHERE l.job_id = ${jobId} AND l.state IN ('pending', 'active')
      FOR UPDATE OF l`;
    for (const lease of active) {
      await tx`
        UPDATE device_leases
        SET state = 'released', released_at = now(), release_reason = ${reason}, updated_at = now()
        WHERE id = ${lease.id}`;
      await tx`
        UPDATE devices SET status = 'idle', updated_at = now()
        WHERE id = ${lease.device_id} AND status = 'leased'`;
      await recordDeviceEvents(tx, [
        {
          device_id: lease.device_id,
          lease_id: lease.id,
          job_id: jobId,
          actor: "dispatcher",
          action: "lease_release",
          payload: { reason, device_key: lease.key },
        },
      ]);
    }
    return active;
  });

  for (const lease of leases) {
    await releaseDeviceOnBroker({
      leaseId: lease.id,
      deviceKey: lease.key,
      reason,
    }).catch((error: unknown) => {
      console.error(
        "[device] broker 释放租约失败:",
        lease.id,
        error instanceof Error ? error.message : error,
      );
    });
  }
  return leases.length;
}

/** Reaper 兜底：过期租约标记 expired 并把设备放回 idle。 */
export async function reapExpiredDeviceLeases(
  now: Date = new Date(),
): Promise<number> {
  const expired = await sql.begin(async (txRaw) => {
    // SAFETY: postgres.js transaction handle exposes the same tagged-template interface as sql.
    const tx = txRaw as unknown as typeof sql;
    const rows = await tx<
      Array<{ id: string; device_id: string; job_id: string; key: string }>
    >`
      SELECT l.id, l.device_id, l.job_id, d.key
      FROM device_leases l
      JOIN devices d ON d.id = l.device_id
      WHERE l.state IN ('pending', 'active')
        AND l.expires_at IS NOT NULL
        AND l.expires_at < ${now.toISOString()}
      FOR UPDATE OF l SKIP LOCKED`;
    for (const lease of rows) {
      await tx`
        UPDATE device_leases
        SET state = 'expired', released_at = now(), release_reason = 'expired', updated_at = now()
        WHERE id = ${lease.id}`;
      await tx`
        UPDATE devices SET status = 'idle', updated_at = now()
        WHERE id = ${lease.device_id} AND status = 'leased'`;
      await recordDeviceEvents(tx, [
        {
          device_id: lease.device_id,
          lease_id: lease.id,
          job_id: lease.job_id,
          actor: "reaper",
          action: "lease_expired",
          payload: { device_key: lease.key },
        },
      ]);
    }
    return rows;
  });

  for (const lease of expired) {
    await releaseDeviceOnBroker({
      leaseId: lease.id,
      deviceKey: lease.key,
      reason: "expired",
    }).catch(() => {});
  }
  return expired.length;
}

/** Job 终态的租约释放；dispatcher / job-control / reaper 共用同一入口。 */
export async function releaseDeviceLeasesForJobQuietly(
  jobId: string,
  reason: string,
): Promise<void> {
  if (!config.device.enabled) return;
  await releaseDeviceLeasesForJob(jobId, reason).catch((error: unknown) => {
    console.error(
      "[device] 释放设备租约失败:",
      jobId,
      error instanceof Error ? error.message : error,
    );
  });
}

/**
 * Job 创建时把画布上的设备需求冻结进快照（与 network_policy 同模式）。
 * 缺失则不附加；存在但非法/未授权则 fail closed，不让执行期去猜。
 */
export async function freezeSnapshotDeviceRequirement<T extends object>(
  db: typeof sql,
  projectId: string,
  canvasId: string | null | undefined,
  snapshot: T,
): Promise<T & { device_requirement?: FrozenDeviceRequirement }> {
  if (!canvasId) return snapshot;
  const [canvas] = await db<[{ target_json?: unknown }?]>`
    SELECT target_json FROM canvases WHERE id = ${canvasId} FOR SHARE`;
  const target = canvas?.target_json;
  const raw =
    target && typeof target === "object" && !Array.isArray(target)
      ? (target as Record<string, unknown>).device_requirement
      : undefined;
  if (raw === undefined || raw === null) return snapshot;
  const parsed = DeviceRequirement.safeParse(raw);
  if (!parsed.success) {
    throw new DeviceNotAuthorizedError("画布上的 device_requirement 不合法");
  }
  assertDeviceEgressAllowed(parsed.data, frozenSnapshotAllowEgress(snapshot));
  await assertDeviceAccessAuthorized(db, projectId, parsed.data);
  return { ...snapshot, device_requirement: parsed.data };
}
