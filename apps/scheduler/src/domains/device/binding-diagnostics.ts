import type { DeviceRequirement } from "@deepsonar/shared-types";
import {
  DEVICE_LEASE_ERROR_CODES,
  DeviceRequirement as DeviceRequirementSchema,
} from "@deepsonar/shared-types";

/** Dispatcher 只在真实设备失败路径写入这两个稳定失败码（见 classifyDispatcherFailure）。 */
const DEVICE_FAILURE_REASONS = new Set<string>(Object.values(DEVICE_LEASE_ERROR_CODES));

/**
 * #1211：设备绑定诊断。
 *
 * 现场一次「任务说没有可用模拟器」的排查里，真正的事实是 Job 快照与画布都没有
 * `device_requirement`，调度器因此从未申请租约；而 Agent 只能看到自己沙箱里
 * `127.0.0.1:5555` 探测失败，于是把「宿主模拟器可用」误报成「没有可用模拟器」。
 *
 * 这里只把平台已经记录下来的事实投影成分档，不新增探测、不推测连通性：
 * 没有连接结果记录时明确说「未记录」，绝不把「未记录」显示成「连接失败」。
 * 分档按 Attempt 独立给出，重试不会被历史合并；分类依据是按 Attempt 的租约计数，
 * 不依赖有界的显示窗口。
 */

export type DeviceBindingState =
  /** 快照与画布都没有声明设备需求：调度器不会为本 Job 申请租约。 */
  | "not_declared"
  /** 已声明需求，但 Job 还没有任何 Attempt：领取/准备尚未开始，租约申请未发生。 */
  | "not_attempted"
  /** 已声明需求但该 Attempt 的角色不命中 `roles`，不会为它申请租约。 */
  | "not_applying"
  /** Attempt 已存在（无错误记录）但没有租约：租约申请正在进行或尚未写结果。 */
  | "attempted_no_lease"
  /** Attempt 的终态原因就是设备失败码（device_not_available / device_not_authorized）且没有租约。 */
  | "acquire_failed"
  /** Attempt 已结束且没有租约，但平台没有记录它是否走到设备申请（共享资产/卷/凭据等 provision 步骤也可能在此失败）。 */
  | "lease_unrecorded"
  /** 有租约记录，但平台没有该 Job/Attempt 的连接结果记录。 */
  | "lease_recorded_unverified";

export const DEVICE_BINDING_LEASE_CAP = 32;
export const DEVICE_BINDING_ATTEMPT_CAP = 20;

export interface DeviceBindingLease {
  attempt_id: string | null;
  state: string;
  device_key: string | null;
  rig_id: string | null;
  granted_at: string | null;
  expires_at: string | null;
  released_at: string | null;
  release_reason: string | null;
}

export interface DeviceBindingAttempt {
  attempt_id: string;
  attempt_no: number | null;
  status: string;
  state: DeviceBindingState;
  reason: string;
  /** 该 Attempt 的租约显示行（有界窗口内的部分）；分档判定用计数，不用显示窗口。 */
  leases: DeviceBindingLease[];
}

export interface DeviceBindingDiagnostics {
  /** 最新 Attempt 的分档；没有 Attempt 记录时按整 Job 退化。 */
  state: DeviceBindingState;
  /** 人读原因：只陈述平台记录到的事实。 */
  reason: string;
  /** 冻结在 Job 快照里的需求（执行期唯一权威）；null 表示未声明或未冻结。 */
  snapshot_requirement: { roles: string[]; transport: string; rig_id: string | null } | null;
  /** 画布 target 上的需求；仅当快照没有时才参与说明。 */
  canvas_requirement: { roles: string[]; transport: string; rig_id: string | null } | null;
  /** Job 角色是否命中需求的 roles。 */
  role_matched: boolean;
  /** 有界租约显示行（最多 DEVICE_BINDING_LEASE_CAP 条），按 Attempt 归属。 */
  leases: DeviceBindingLease[];
  lease_count: number;
  leases_truncated: boolean;
  /** 最近 DEVICE_BINDING_ATTEMPT_CAP 个 Attempt 的独立分档，按 attempt_no 倒序。 */
  attempts: DeviceBindingAttempt[];
  attempts_truncated: boolean;
  /** 平台是否存在本 Job 的设备连接结果记录。当前没有该写入口，恒为 false。 */
  connection_result_recorded: boolean;
}

/** 与 `deviceRequirementFromSnapshot` 同一口径；这里不引 application，保持只读投影不加载 db/broker。 */
function readSnapshotRequirement(snapshot: unknown): DeviceRequirement | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const parsed = DeviceRequirementSchema.safeParse((snapshot as Record<string, unknown>).device_requirement);
  return parsed.success ? parsed.data : null;
}

export interface DeviceBindingAttemptRow {
  attempt_id: string;
  attempt_no: number | null;
  status: string;
  error: string | null;
  /** job_attempts.outcome_json.reason：调度器分类后的终态原因，设备失败码才代表真的调用过 broker。 */
  failure_reason: string | null;
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

interface DeviceBindingInputs {
  snapshot: unknown;
  canvasTarget: unknown;
  roleName: string;
  leases?: readonly DeviceBindingLease[];
  /** 已持久化的 Attempt（id/序号/状态/错误原文按现有路由投影传入，原因不在诊断里复读）。 */
  attempts?: readonly DeviceBindingAttemptRow[];
  /** 每个 Attempt 的租约条数（全量计数，不受显示窗口截断影响）。 */
  leaseCountsByAttempt?: Readonly<Record<string, number>>;
  leaseCountTotal?: number;
  attemptCount?: number;
}

function baseRequirementFacts(input: DeviceBindingInputs) {
  const snapshotRequirement = readSnapshotRequirement(input.snapshot);
  const canvasRequirement = readCanvasRequirement(input.canvasTarget);
  return {
    snapshotRequirement,
    canvasRequirement,
    roleMatched: Boolean(snapshotRequirement?.roles.includes(input.roleName)),
  };
}

/**
 * 单个 Attempt 的分档。`leaseCount` 是该 Attempt 的全量租约计数；不命中角色或未声明时
 * 不看租约（那几份租约属于别的角色/配置错误路径，仍会出现在显示列表里）。
 */
function classifyAttempt(
  facts: ReturnType<typeof baseRequirementFacts>,
  input: DeviceBindingInputs,
  attempt: DeviceBindingAttemptRow | null,
  leaseCount: number,
  displayLeases: readonly DeviceBindingLease[],
): { state: DeviceBindingState; reason: string } {
  if (!facts.snapshotRequirement) {
    return { state: "not_declared", reason: "Job 快照没有冻结设备需求，调度器不会申请租约。" };
  }
  if (!facts.roleMatched) {
    return {
      state: "not_applying",
      reason: `角色 ${input.roleName} 不在 ${facts.snapshotRequirement.roles.join("/")} 内，调度器不会为它申请租约。`,
    };
  }
  if (leaseCount > 0) {
    const latest = displayLeases[0];
    return {
      state: "lease_recorded_unverified",
      reason:
        `已记录 ${leaseCount} 条设备租约${latest?.device_key ? `，最新设备 ${latest.device_key}` : ""}` +
        `，租约状态 ${latest?.state ?? "未知"}；平台没有这个 Attempt 的设备连接结果，沙箱内探测失败不能证明宿主机设备不可用。`,
    };
  }
  if (attempt && attempt.failure_reason && DEVICE_FAILURE_REASONS.has(attempt.failure_reason)) {
    return {
      state: "acquire_failed",
      reason:
        `该 Attempt 的终态原因是设备失败码 ${attempt.failure_reason}，且没有租约行：` +
        "这是平台上已记录的租约申请失败；错误原文见本请求 attempts[].error，不在诊断里复读。",
    };
  }
  if (attempt && (attempt.error !== null || attempt.status === "failed" || attempt.status === "timeout")) {
    // 不能从「Attempt 失败」反推调用过 broker：共享资产、卷与凭据准备都发生在租约申请之前。
    return {
      state: "lease_unrecorded",
      reason:
        `该 Attempt 已结束（原因 ${attempt.failure_reason ?? "未记录"}）但没有租约行，平台也没有设备失败码；` +
        "无法判断它是否走到租约申请，provision 的共享资产/卷/凭据准备失败同样会停在这里。",
    };
  }
  if (attempt) {
    return {
      state: "attempted_no_lease",
      reason: "该 Attempt 已存在但还没有租约行：申请可能仍在进行、刚被取消，或 Attempt 记录与租约写入不在同一步。",
    };
  }
  return {
    state: "not_attempted",
    reason: "还没有 Attempt 记录：领取/准备尚未开始，租约申请未发生。",
  };
}

function topLevelVerdict(input: {
  facts: ReturnType<typeof baseRequirementFacts>;
  roleName: string;
  attempts: readonly DeviceBindingAttempt[];
  hasLeases: boolean;
  leaseCountTotal: number;
}): { state: DeviceBindingState; reason: string } {
  if (input.attempts.length > 0) {
    const latest = input.attempts[0];
    const suffix = input.attempts.length > 1 ? `（更早 ${input.attempts.length - 1} 个 Attempt 见 attempts 数组）` : "";
    return { state: latest.state, reason: `最新 Attempt #${latest.attempt_no ?? "?"}：${latest.reason}${suffix}` };
  }
  if (input.hasLeases) {
    return {
      state: "lease_recorded_unverified",
      reason: `已为该 Job 记录租约（总计 ${input.leaseCountTotal} 条，Attempt 归属未知），沙箱内探测失败不能证明宿主机设备不可用。`,
    };
  }
  if (input.facts.snapshotRequirement) {
    return {
      state: "not_attempted",
      reason: input.facts.roleMatched
        ? "快照已声明设备需求，但还没有 Attempt：领取/准备尚未开始，租约申请未发生。"
        : `快照已声明设备需求，但角色 ${input.roleName} 不在 ${input.facts.snapshotRequirement.roles.join("/")} 内，调度器不会申请租约。`,
    };
  }
  if (input.facts.canvasRequirement) {
    return {
      state: "not_attempted",
      reason: "画布声明了设备需求，但 Job 快照没有冻结该需求，调度器不会申请租约；设备不会自动绑定到该任务。",
    };
  }
  return {
    state: "not_declared",
    reason:
      "任务与画布都没有声明设备需求，调度器不会申请设备租约；设备列表中显示可用不代表本 Job 已绑定设备。",
  };
}

export function deriveDeviceBinding(input: DeviceBindingInputs): DeviceBindingDiagnostics {
  const facts = baseRequirementFacts(input);
  const allLeases = (input.leases ?? []).slice(0, DEVICE_BINDING_LEASE_CAP);
  const counts = input.leaseCountsByAttempt ?? {};
  const attemptRows = (input.attempts ?? []).slice(0, DEVICE_BINDING_ATTEMPT_CAP);
  const attempts: DeviceBindingAttempt[] = attemptRows.map((attempt) => {
    const display = allLeases.filter((lease) => lease.attempt_id === attempt.attempt_id);
    const verdict = classifyAttempt(facts, input, attempt, counts[attempt.attempt_id] ?? 0, display);
    return {
      attempt_id: attempt.attempt_id,
      attempt_no: attempt.attempt_no,
      status: attempt.status,
      ...verdict,
      leases: display,
    };
  });
  const leaseCountTotal = input.leaseCountTotal ?? allLeases.length;
  const attemptCount = input.attemptCount ?? attemptRows.length;
  const verdict = topLevelVerdict({
    facts,
    roleName: input.roleName,
    attempts,
    hasLeases: attempts.length === 0 && allLeases.length > 0,
    leaseCountTotal,
  });
  return {
    state: verdict.state,
    reason: verdict.reason,
    snapshot_requirement: facts.snapshotRequirement ? describeRequirement(facts.snapshotRequirement) : null,
    canvas_requirement: facts.canvasRequirement ? describeRequirement(facts.canvasRequirement) : null,
    role_matched: facts.roleMatched,
    leases: allLeases,
    lease_count: leaseCountTotal,
    leases_truncated: leaseCountTotal > allLeases.length,
    attempts,
    attempts_truncated: attemptCount > attemptRows.length,
    // 设备连接结果还没有受治理的写入口（#1211 只做读侧投影），因此永远不冒充已验证。
    connection_result_recorded: false,
  };
}

export interface DeviceBindingLeaseRow {
  attempt_id: string | null;
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
    attempt_id: row.attempt_id,
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
  input: {
    jobId: string;
    snapshot: unknown;
    canvasTarget: unknown;
    roleName: string;
    /** 会话里已加载的 Attempt（id/序号/状态/错误），避免重复查询并保证与 Job 详情同源。 */
    attempts: ReadonlyArray<{
      id: string;
      attempt_no: number | null;
      status: string;
      error: string | null;
      failure_reason: string | null;
    }>;
  },
): Promise<DeviceBindingDiagnostics> {
  const [rows, [counts]] = await Promise.all([
    db<DeviceBindingLeaseRow[]>`
      SELECT attempt_id, state, device_key, rig_id, granted_at, expires_at, released_at, release_reason
        FROM (
          SELECT l.attempt_id, l.state, d.key AS device_key, d.rig_id,
                 l.granted_at, l.expires_at, l.released_at, l.release_reason
            FROM device_leases l
            LEFT JOIN devices d ON d.id = l.device_id
           WHERE l.job_id = ${input.jobId}
           ORDER BY l.created_at DESC
           LIMIT ${DEVICE_BINDING_LEASE_CAP}
        ) leases`,
    db<Array<{ lease_count: number; attempt_count: number }>>`
      SELECT (SELECT count(*)::int FROM device_leases WHERE job_id = ${input.jobId}) AS lease_count,
             (SELECT count(*)::int FROM job_attempts WHERE job_id = ${input.jobId}) AS attempt_count`,
  ]);
  const attemptRows = input.attempts
    .map((attempt) => ({
      attempt_id: String(attempt.id),
      attempt_no: attempt.attempt_no,
      status: attempt.status,
      error: attempt.error,
      failure_reason: attempt.failure_reason,
    }))
    .slice(0, DEVICE_BINDING_ATTEMPT_CAP);
  // 分档判定按 Attempt 计数：全量 GROUP BY，不受 32 条显示窗口取舍影响。
  const countsByAttempt: Record<string, number> = {};
  if (rows.length > 0) {
    const counted = await db<Array<{ attempt_id: string | null; count: number }>>`
      SELECT attempt_id, count(*)::int AS count
        FROM device_leases
       WHERE job_id = ${input.jobId}
       GROUP BY attempt_id`;
    for (const row of counted) {
      if (row.attempt_id) countsByAttempt[row.attempt_id] = Number(row.count);
    }
  }
  return deriveDeviceBinding({
    snapshot: input.snapshot,
    canvasTarget: input.canvasTarget,
    roleName: input.roleName,
    leases: projectLeaseRows(rows),
    attempts: attemptRows,
    leaseCountsByAttempt: countsByAttempt,
    leaseCountTotal: Number(counts?.lease_count ?? rows.length),
    attemptCount: Number(counts?.attempt_count ?? attemptRows.length),
  });
}