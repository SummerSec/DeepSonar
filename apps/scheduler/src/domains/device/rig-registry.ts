import { deviceIsRigEligible, isImplementedDeviceTransport } from "@deepsonar/shared-types";
import { config } from "../../config.js";
import { DeviceNotAvailableError } from "./broker-client.js";

/**
 * 平台 → rig 的准入推送（#505 阶段 1 / a-lite）。平台是权威：把某个 rig 的期望设备集合整集替换给 broker。
 *
 * 协议要点（对 broker 这个不可信外部进程）：
 *  - **revision 必须单调**：先 `GET /rig/devices` 读回 broker 当前 revision，再取
 *    `max(brokerRevision + 1, 集合内最新 updated_at 毫秒)`，既不会回退也不会与旧集合同号被当成重放；
 *  - **未知结果不自动重放**：push 超时/失败后只允许重新读回（`readRigAdmission`）再决定，避免盲目重推；
 *  - **不回显响应正文**：broker 响应按共享契约解析，错误只映射成稳定代号。
 */

export type DesiredRigDevice = {
  key: string;
  transport: "adb" | "hdc";
  model: string | null;
  updatedAtMs: number;
};

export type RigAdmissionState = {
  revision: number;
  reconciled: boolean;
  mode: string;
  usable: string[];
};

export type PushOutcome =
  | { ok: true; revision: number; mode: string }
  | {
      ok: false;
      reason:
        | "stale_revision"
        | "unauthorized"
        | "unavailable"
        | "not_configured";
    };

export function rigRegistryConfigured(): boolean {
  return (
    config.device.enabled &&
    Boolean(config.device.brokerUrl) &&
    Boolean(config.device.brokerToken)
  );
}

function brokerBaseUrl(): string {
  return config.device.brokerUrl.replace(/\/+$/u, "");
}

/** 下一个 revision：严格大于 broker 当前值，且不小于集合内最新的 updated_at（毫秒）。 */
export function nextRigRevision(
  currentRevision: number,
  devices: Array<Pick<DesiredRigDevice, "updatedAtMs">>,
): number {
  const current = Number.isFinite(currentRevision)
    ? Math.max(0, Math.floor(currentRevision))
    : 0;
  const newest = devices.reduce(
    (max, device) =>
      Number.isFinite(device.updatedAtMs)
        ? Math.max(max, Math.floor(device.updatedAtMs))
        : max,
    0,
  );
  return Math.max(current + 1, newest);
}

/**
 * 由 `devices` 行计算期望集合：只保留已实现的 transport，`revoked` / `maintenance` 的登记项不下发
 * （等于平台侧下架），其余状态（idle / leased / offline）都保持登记。
 */
export function desiredRigDevices(
  rows: Array<{
    key: string;
    transport: string;
    model?: string | null;
    status?: string;
    updated_at?: unknown;
  }>,
): DesiredRigDevice[] {
  const desired = new Map<string, DesiredRigDevice>();
  for (const row of rows) {
    if (!isImplementedDeviceTransport(row.transport)) continue;
    const status = typeof row.status === "string" ? row.status : "idle";
    if (!deviceIsRigEligible(status)) continue;
    const parsed =
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : Date.parse(String(row.updated_at ?? ""));
    desired.set(row.key, {
      key: row.key,
      transport: row.transport,
      model: row.model ?? null,
      updatedAtMs: Number.isFinite(parsed) ? parsed : 0,
    });
  }
  return [...desired.values()];
}

async function brokerFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(`${brokerBaseUrl()}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.device.brokerToken}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeviceNotAvailableError(`device broker 不可达：${detail}`);
  }
}

/** 读回 broker 当前准入状态；失败返回 null（调用方按"不可用"处理，不猜）。 */
export async function readRigAdmission(): Promise<RigAdmissionState | null> {
  if (!rigRegistryConfigured()) return null;
  const response = await brokerFetch(
    "/rig/devices",
    { method: "GET" },
    config.device.acquireTimeoutMs,
  ).catch(() => null);
  if (!response || !response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    revision?: unknown;
    reconciled?: unknown;
    mode?: unknown;
    usable?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.revision !== "number" ||
    !Number.isFinite(payload.revision)
  )
    return null;
  return {
    revision: Math.max(0, Math.floor(payload.revision)),
    reconciled: payload.reconciled === true,
    mode: typeof payload.mode === "string" ? payload.mode : "unknown",
    usable: Array.isArray(payload.usable)
      ? payload.usable.filter((key): key is string => typeof key === "string")
      : [],
  };
}

/**
 * 把期望集合整集替换到 broker。先读回 revision 再 push；409（回退）/401（凭据）分别映射稳定代号，
 * 网络与契约不符一律 `unavailable`，由调用方在下一轮通过 `readRigAdmission` 确认后再决定。
 */
export async function pushRigAdmission(
  devices: DesiredRigDevice[],
): Promise<PushOutcome> {
  if (!rigRegistryConfigured()) return { ok: false, reason: "not_configured" };
  const current = await readRigAdmission();
  if (!current) return { ok: false, reason: "unavailable" };
  const revision = nextRigRevision(current.revision, devices);
  const response = await brokerFetch(
    "/rig/devices",
    {
      method: "PUT",
      body: JSON.stringify({
        revision,
        devices: devices.map((device) => ({
          key: device.key,
          transport: device.transport,
          model: device.model,
        })),
      }),
    },
    config.device.acquireTimeoutMs,
  ).catch(() => null);
  if (!response) return { ok: false, reason: "unavailable" };
  if (response.status === 409) return { ok: false, reason: "stale_revision" };
  if (response.status === 401 || response.status === 403)
    return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "unavailable" };
  const payload = (await response.json().catch(() => null)) as {
    revision?: unknown;
    mode?: unknown;
  } | null;
  if (!payload || typeof payload.revision !== "number")
    return { ok: false, reason: "unavailable" };
  return {
    ok: true,
    revision: Math.floor(payload.revision),
    mode: typeof payload.mode === "string" ? payload.mode : "unknown",
  };
}
