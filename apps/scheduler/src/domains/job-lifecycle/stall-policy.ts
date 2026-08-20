/** Chrome 长工具镜像的 stall 下限；不抬高全局 DEEPSONAR_JOB_STALL_SEC。 */
export const CHROME_JOB_STALL_SEC = Object.freeze({
  "deepsonar-chrome-audit": 5_400,
  "deepsonar-chrome-test": 5_400,
  "deepsonar-chrome-fuzz": 10_800,
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

export function resolveJobStallSec(imageKey: unknown, defaultStallSec: number): number {
  if (!Number.isSafeInteger(defaultStallSec) || defaultStallSec <= 0) return 0;
  const key = typeof imageKey === "string" ? imageKey : "";
  const override = CHROME_JOB_STALL_SEC[key as keyof typeof CHROME_JOB_STALL_SEC];
  return override ? Math.max(defaultStallSec, override) : defaultStallSec;
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
  leaseExpiresAt?: Date | null;
  inflightTool?: string | null;
  latestToolCallPhase?: ToolCallPhase | null;
}): boolean {
  const stallSec = resolveJobStallSec(input.imageKey, input.stallSec);
  if (stallSec <= 0) return false;
  const lastActivity = input.lastEventAt && input.lastEventAt > input.startedAt
    ? input.lastEventAt
    : input.startedAt;
  if (lastActivity.getTime() + stallSec * 1000 >= input.now.getTime()) return false;
  const leaseLive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > input.now.getTime());
  if (leaseLive && (Boolean(input.inflightTool) || input.latestToolCallPhase === "started")) {
    return false;
  }
  return true;
}
