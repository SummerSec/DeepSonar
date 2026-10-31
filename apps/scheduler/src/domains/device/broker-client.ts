import { DeviceLeaseGrant, type DeviceRequirement } from "@deepsonar/shared-types";
import { config } from "../../config.js";
import { rigForId, type DeviceRig } from "../../device-rigs.js";

/**
 * Device broker 客户端（#495 / 多 rig）。调度器是唯一有副作用的执行者：broker 是不可信外部进程，
 * 响应必须按共享契约解析后才能落库，且调度器持有的是短期租约而不是设备控制权。
 *
 * 多 rig（#505 后续）：所有调用都必须显式带上目标 rig —— 端点与入站凭据来自平台配置，
 * 由调用方先用 `rigForId()` 解析；解析不到就 fail closed，绝不回落到"随便找个 broker"。
 */

/** 未授权：不可重试（项目未 opt-in、传输未实现、功能未启用、rig 未配置）。 */
export class DeviceNotAuthorizedError extends Error {
  readonly code = "device_not_authorized";
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotAuthorizedError";
  }
}

/** 设备/ broker 暂不可用：可重试（走 provision 重试路径）。 */
export class DeviceNotAvailableError extends Error {
  readonly code = "device_not_available";
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotAvailableError";
  }
}

/**
 * 是否存在可用 rig：不带参数表示"至少配置了一个 rig"；带 rigId 表示该 rig 是否已配置
 * （`null` → 默认 rig）。
 */
export function deviceBrokerConfigured(rigId?: string | null): boolean {
  if (!config.device.enabled) return false;
  if (rigId === undefined) return config.device.rigs.length > 0;
  return rigForId(config.device.rigs, rigId) !== null;
}

async function brokerFetch(
  rig: DeviceRig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(`${rig.brokerUrl.replace(/\/+$/u, "")}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rig.brokerToken}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeviceNotAvailableError(
      `device broker 不可达（rig ${rig.id}）：${detail}`,
    );
  }
}

/**
 * 申请设备租约。broker 侧返回 403 → 未授权；404/409/5xx/网络/非法响应 → 暂不可用。
 * 任何分支都不回显 broker 响应正文（可能是未受控文本）。
 */
export async function acquireDeviceOnBroker(input: {
  jobId: string;
  attemptId: string;
  projectId: string;
  requirement: DeviceRequirement;
  rig: DeviceRig;
}): Promise<DeviceLeaseGrant> {
  const response = await brokerFetch(
    input.rig,
    "/lease/acquire",
    {
      method: "POST",
      body: JSON.stringify({
        job_id: input.jobId,
        attempt_id: input.attemptId,
        project_id: input.projectId,
        transport: input.requirement.transport,
        device_key: input.requirement.key ?? null,
        model: input.requirement.model ?? null,
        exclusive: input.requirement.exclusive,
        ttl_sec: input.requirement.ttl_sec,
      }),
    },
    config.device.acquireTimeoutMs,
  );
  if (response.status === 403) {
    throw new DeviceNotAuthorizedError("device broker 拒绝了租约请求（未授权）");
  }
  if (!response.ok) {
    throw new DeviceNotAvailableError(
      `device broker 租约失败（rig ${input.rig.id}，HTTP ${response.status}）`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DeviceNotAvailableError("device broker 返回了无法解析的租约响应");
  }
  const parsed = DeviceLeaseGrant.safeParse(payload);
  if (!parsed.success) {
    throw new DeviceNotAvailableError("device broker 租约响应不符合共享契约");
  }
  return parsed.data;
}

/** 释放租约。幂等：broker 对未知/已释放租约返回 200 或 404 都算成功。 */
export async function releaseDeviceOnBroker(input: {
  leaseId: string;
  deviceKey: string;
  reason?: string;
  rig: DeviceRig;
}): Promise<void> {
  const response = await brokerFetch(
    input.rig,
    "/lease/release",
    {
      method: "POST",
      body: JSON.stringify({
        lease_id: input.leaseId,
        device_key: input.deviceKey,
        reason: input.reason ?? "released",
      }),
    },
    config.device.releaseTimeoutMs,
  );
  if (response.ok || response.status === 404) return;
  throw new DeviceNotAvailableError(
    `device broker 释放租约失败（rig ${input.rig.id}，HTTP ${response.status}）`,
  );
}
