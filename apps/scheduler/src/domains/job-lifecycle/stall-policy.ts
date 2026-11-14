/** Chrome 长工具镜像的 stall 下限；不抬高全局 DEEPSONAR_JOB_STALL_SEC。 */
export const CHROME_JOB_STALL_SEC = Object.freeze({
  "deepsonar-chrome-audit": 5_400,
  "deepsonar-chrome-test": 5_400,
  "deepsonar-chrome-fuzz": 10_800,
});

/** Hub 读大图时常 15 分钟内发不出 tool.call；心跳不算进度。 */
export const HUB_JOB_STALL_SEC = 5_400;

/**
 * #1086：in-flight tool 不再无条件豁免。per-image stall 下限只描述「事件静默」，
 * 而挂死的 bash（`python3 -` 等 stdin、`tee` 管道往死进程）在租约健康时能一直占槽。
 * 该豁免按同一 floor 派生的 in-flight 预算封顶：max(floor × 2, 3600)，既保留 chrome
 * 家族 1–3h 的合法长工具空间，又让基础镜像在 1h 内收口挂死工具。
 */
export const INFLIGHT_TOOL_BUDGET_MULTIPLIER = 2;
export const INFLIGHT_TOOL_BUDGET_MIN_SEC = 3_600;
/** 结算与审计可追溯的稳定原因码：in-flight tool 超出预算。 */
export const INFLIGHT_TOOL_STALL_REASON = "reaper_inflight_tool_stalled";
export const INFLIGHT_TOOL_STALL_ERROR = "产出停滞（Reaper 判定：in-flight tool 超出预算）";

const SPECIALIST_JOB_STALL_SEC = Object.freeze({
  ...CHROME_JOB_STALL_SEC,
});

export const TOOL_CALL_STARTED_PREFIX = "tool.call.started";
export const TOOL_CALL_COMPLETED_PREFIX = "tool.call.completed";

export type ToolCallPhase = "started" | "completed";

export function runtimeImageKeyFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = snapshot as Record<string, unknown>;
  const runtimeImage = value.runtime_image;
  if (runtimeImage && typeof runtimeImage === "object" && !Array.isArray(runtimeImage)) {
    const key = (runtimeImage as Record<string, unknown>).image_key;
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  return typeof value.runtime_image_key === "string" && value.runtime_image_key.trim()
    ? value.runtime_image_key.trim()
    : null;
}

export function resolveJobStallSec(imageKey: unknown, defaultStallSec: number, jobType?: unknown): number {
  if (!Number.isSafeInteger(defaultStallSec) || defaultStallSec <= 0) return 0;
  const key = typeof imageKey === "string" ? imageKey : "";
  const override = SPECIALIST_JOB_STALL_SEC[key as keyof typeof SPECIALIST_JOB_STALL_SEC] ?? 0;
  const typeFloor = jobType === "hub_reason" ? HUB_JOB_STALL_SEC : 0;
  return Math.max(defaultStallSec, override, typeFloor);
}

/** 同一 floor 派生出的 in-flight tool 时长预算（秒），与 stall 下限共用单一实现。 */
export function inflightToolBudgetSec(imageKey: unknown, defaultStallSec: number, jobType?: unknown): number {
  const floor = resolveJobStallSec(imageKey, defaultStallSec, jobType);
  if (floor <= 0) return 0;
  return Math.max(floor * INFLIGHT_TOOL_BUDGET_MULTIPLIER, INFLIGHT_TOOL_BUDGET_MIN_SEC);
}

export function toolCallProgressMessage(phase: ToolCallPhase, toolName: string): string {
  const prefix = phase === "started" ? TOOL_CALL_STARTED_PREFIX : TOOL_CALL_COMPLETED_PREFIX;
  const name = toolName.trim() || "tool";
  return `${prefix} ${name}`.slice(0, 2000);
}

export function toolCallActivityPatch(phase: ToolCallPhase, toolName: string, at = new Date()) {
  const name = (toolName.trim() || "tool").slice(0, 80);
  return {
    runtime_activity: {
      inflight_tool: phase === "started" ? name : null,
      phase,
      at: at.toISOString(),
    },
  };
}

export function inflightToolFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const activity = (payload as Record<string, unknown>).runtime_activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null;
  const tool = (activity as Record<string, unknown>).inflight_tool;
  return typeof tool === "string" && tool.trim() ? tool.trim() : null;
}

export function toolCallPhaseFromProgressMessage(message: unknown): ToolCallPhase | null {
  if (typeof message !== "string") return null;
  if (message.startsWith(TOOL_CALL_STARTED_PREFIX)) return "started";
  if (message.startsWith(TOOL_CALL_COMPLETED_PREFIX)) return "completed";
  return null;
}

export function shouldReapStalledJob(input: {
  now: Date;
  startedAt: Date;
  lastEventAt?: Date | null;
  stallSec: number;
  imageKey?: unknown;
  jobType?: unknown;
  leaseExpiresAt?: Date | null;
  inflightTool?: string | null;
  latestToolCallPhase?: ToolCallPhase | null;
}): boolean {
  const stallSec = resolveJobStallSec(input.imageKey, input.stallSec, input.jobType);
  if (stallSec <= 0) return false;
  const lastActivity = input.lastEventAt && input.lastEventAt > input.startedAt
    ? input.lastEventAt
    : input.startedAt;
  if (lastActivity.getTime() + stallSec * 1000 >= input.now.getTime()) return false;
  const leaseLive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > input.now.getTime());
  if (leaseLive && (Boolean(input.inflightTool) || input.latestToolCallPhase === "started")) {
    // #1086：在飞 tool 的豁免有上限；超龄的挂死工具按停滞收口。
    const budgetSec = inflightToolBudgetSec(input.imageKey, input.stallSec, input.jobType);
    return lastActivity.getTime() + budgetSec * 1000 < input.now.getTime();
  }
  return true;
}
