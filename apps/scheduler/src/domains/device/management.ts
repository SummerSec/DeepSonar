import { deviceStatusForAction, type DeviceRegistration, type DeviceStatusAction } from "@deepsonar/shared-types";
import { desiredRigDevices, type DesiredRigDevice } from "./rig-registry.js";

/**
 * 设备准入的规则层（#505 阶段 1）。这里只做纯计算：管理面路由负责校验、事务与审计，
 * broker 侧负责按推送后的准入集合发租约，两侧共用同一套状态含义。
 */

export type DeviceRegistrationRow = {
  key: string;
  transport: "adb" | "hdc";
  model: string | null;
  /** null = 平台共享池（`devices.project_id` 为空）。 */
  project_id: string | null;
  status: "idle" | "maintenance" | "revoked";
};

/** 登记入参 → devices 行字段；`enabled=false` 记成 maintenance（已登记但暂不参与调度）。 */
export function registrationRow(registration: DeviceRegistration): DeviceRegistrationRow {
  return {
    key: registration.key,
    transport: registration.transport,
    model: registration.model ?? null,
    project_id: registration.project_id ?? null,
    status: registration.enabled ? "idle" : "maintenance",
  };
}

/** 管理动作 → devices.status；状态机只在 shared-types 里定义一处。 */
export function statusAfterAction(action: DeviceStatusAction): DeviceRegistrationRow["status"] {
  const status = deviceStatusForAction(action);
  if (status === "idle" || status === "maintenance" || status === "revoked") return status;
  // 契约新增状态时这里编译期就会报错，避免静默落一个 broker 不认的值。
  throw new Error(`device_status_action_unsupported:${action}`);
}

/** 有在途租约时不允许删除登记项（先强制释放或等终态）。 */
export function deviceDeleteBlocked(activeLeaseCount: number): boolean {
  return activeLeaseCount > 0;
}

/** 该 rig 的推送目标集合；同一 rig 只收自己的设备，下架/维护中的条目不下发。 */
export function desiredForRig(
  rows: Array<{
    key: string;
    transport: string;
    model?: string | null;
    status?: string;
    broker_ref?: string | null;
    updated_at?: unknown;
  }>,
  brokerRef: string,
): DesiredRigDevice[] {
  return desiredRigDevices(rows.filter((row) => row.broker_ref === brokerRef));
}

/**
 * 按 rig（`devices.broker_ref`）把登记项分组成各自的期望集合。
 * 没有 broker_ref 的登记项不参与任何推送（没有可推送的目标，保持 fail closed）。
 */
export function groupDesiredByRig(
  rows: Array<{
    key: string;
    transport: string;
    model?: string | null;
    status?: string;
    broker_ref?: string | null;
    updated_at?: unknown;
  }>,
): Map<string, DesiredRigDevice[]> {
  const rigs = new Set(
    rows
      .map((row) => row.broker_ref)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0),
  );
  return new Map([...rigs].sort().map((rig) => [rig, desiredForRig(rows, rig)]));
}
