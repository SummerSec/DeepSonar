import type { DeviceRequirement } from "@deepsonar/shared-types";
import { DeviceRequirement as DeviceRequirementSchema } from "@deepsonar/shared-types";

/**
 * #1211：设备绑定诊断。
 *
 * 现场一次「任务说没有可用模拟器」的排查里，真正的事实是 Job 快照与画布都没有
 * `device_requirement`，调度器因此从未申请租约；而 Agent 只能看到自己沙箱里
 * `127.0.0.1:5555` 探测失败，于是把「宿主模拟器可用」误报成「没有可用模拟器」。
 *
 * 这里只把平台已经记录下来的事实投影成分档，不新增探测、不推测连通性：
 * 没有连接结果记录时明确说「未记录」，绝不把「未记录」显示成「连接失败」。
 */

export type DeviceBindingState =
  /** 快照与画布都没有声明设备需求：调度器不会为本 Job 申请租约。 */
  | "not_declared"
  /** 已声明需求但没有租约记录：申请未发生，或申请被拒绝/失败。 */
  | "declared_no_lease"
  /** 有租约记录，但平台没有该 Job 的连接结果记录。 */
  | "lease_recorded_unverified";

export interface DeviceBindingLease {
  state: string;
  device_key: string | null;
  rig_id: string | null;
  granted_at: string | null;
  expires_at: string | null;
  released_at: string | null;
  release_reason: string | null;
}

export interface DeviceBindingDiagnostics {
  state: DeviceBindingState;
  /** 人读原因：只陈述平台记录到的事实。 */
  reason: string;
  /** 冻结在 Job 快照里的需求（执行期唯一权威）；null 表示未声明或未冻结。 */
  snapshot_requirement: { roles: string[]; transport: string; rig_id: string | null } | null;
  /** 画布 target 上的需求；仅当快照没有时才参与说明。 */
  canvas_requirement: { roles: string[]; transport: string; rig_id: string | null } | null;
  /** Job 角色是否命中需求的 roles。 */
  role_matched: boolean;
  leases: DeviceBindingLease[];
  /** 平台是否存在本 Job 的设备连接结果记录。当前没有该写入口，恒为 false。 */
  connection_result_recorded: boolean;
}

/** 与 `deviceRequirementFromSnapshot` 同一口径；这里不引 application，保持只读投影不加载 db/broker。 */
function readSnapshotRequirement(snapshot: unknown): DeviceRequirement | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const parsed = DeviceRequirementSchema.safeParse((snapshot as Record<string, unknown>).device_requirement);
  return parsed.success ? parsed.data : null;
}

function readCanvasRequirement(target: unknown): DeviceRequirement | null {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const parsed = DeviceRequirementSchema.safeParse((target as Record<string, unknown>).device_requirement);
  return parsed.success ? parsed.data : null;
}

function describeRequirement(requirement: DeviceRequirement) {
  return {
    roles: [...requirement.roles],
    transport: requirement.transport,
    rig_id: requirement.rig_id ?? null,
  };
}

/** 纯函数：把已读到的事实分档，便于单测覆盖每个分支。 */
export function deriveDeviceBinding(input: {
  snapshot: unknown;
  canvasTarget: unknown;
  roleName: string;
  leases: readonly DeviceBindingLease[];
}): DeviceBindingDiagnostics {
  const snapshotRequirement = readSnapshotRequirement(input.snapshot);
  const canvasRequirement = readCanvasRequirement(input.canvasTarget);
  const roleMatched = Boolean(snapshotRequirement?.roles.includes(input.roleName));
  const base = {
    snapshot_requirement: snapshotRequirement ? describeRequirement(snapshotRequirement) : null,
    canvas_requirement: canvasRequirement ? describeRequirement(canvasRequirement) : null,
    role_matched: roleMatched,
    leases: [...input.leases],
    // 设备连接结果还没有受治理的写入口（#1211 只做读侧投影），因此永远不冒充已验证。
    connection_result_recorded: false,
  };
  if (input.leases.length > 0) {
    const latest = input.leases[0];
    return {
      ...base,
      state: "lease_recorded_unverified",
      reason:
        `已为该 Job 记录 ${input.leases.length} 条设备租约，最新状态 ${latest?.state ?? "unknown"}` +
        `${latest?.device_key ? `，设备 ${latest.device_key}` : ""}；平台没有这个 Job 的设备连接结果，` +
        "沙箱内探测失败不能证明宿主机设备不可用。",
    };
  }
  if (snapshotRequirement) {
    return {
      ...base,
      state: "declared_no_lease",
      reason: roleMatched
        ? "Job 快照声明了设备需求，但没有租约记录：租约申请未发生或被拒绝，请查看 Attempt 错误与设备代理状态。"
        : `Job 快照声明了设备需求，但角色 ${input.roleName} 不在 ${snapshotRequirement.roles.join("/")} 内，调度器不会为它申请租约。`,
    };
  }
  if (canvasRequirement) {
    return {
      ...base,
      state: "declared_no_lease",
      reason: "画布声明了设备需求，但 Job 快照没有冻结该需求，调度器不会申请租约；设备不会自动绑定到该任务。",
    };
  }
  return {
    ...base,
    state: "not_declared",
    reason: "任务与画布都没有声明设备需求，调度器不会申请设备租约；设备列表中显示可用不代表本 Job 已绑定设备。",
  };
}

export interface DeviceBindingLeaseRow {
  state: string;
  device_key: string | null;
  rig_id: string | null;
  granted_at: unknown;
  expires_at: unknown;
  released_at: unknown;
  release_reason: string | null;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

export function projectLeaseRows(rows: readonly DeviceBindingLeaseRow[]): DeviceBindingLease[] {
  return rows.map((row) => ({
    state: row.state,
    device_key: row.device_key,
    rig_id: row.rig_id,
    granted_at: toIso(row.granted_at),
    expires_at: toIso(row.expires_at),
    released_at: toIso(row.released_at),
    release_reason: row.release_reason,
  }));
}

export async function readDeviceBindingDiagnostics(
  db: typeof import("../../db.js").sql,
  input: { jobId: string; snapshot: unknown; canvasTarget: unknown; roleName: string },
): Promise<DeviceBindingDiagnostics> {
  const rows = await db<DeviceBindingLeaseRow[]>`
    SELECT l.state, d.key AS device_key, d.rig_id,
           l.granted_at, l.expires_at, l.released_at, l.release_reason
      FROM device_leases l
      LEFT JOIN devices d ON d.id = l.device_id
     WHERE l.job_id = ${input.jobId}
     ORDER BY l.created_at DESC`;
  return deriveDeviceBinding({
    snapshot: input.snapshot,
    canvasTarget: input.canvasTarget,
    roleName: input.roleName,
    leases: projectLeaseRows(rows),
  });
}