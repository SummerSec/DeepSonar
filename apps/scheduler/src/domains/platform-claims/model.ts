import { z } from "zod";

/**
 * #740 平台级全局暂停领取（Slice 1）。
 *
 * 暂停是管理员显式控制的内核准入门：只阻止新的 `pending → claimed`，不取消、
 * 不杀、不重放在途 Job。状态持久化在 `global_settings` 单例行，所有 Scheduler
 * 副本在 dispatch claim advisory lock 内读取，重启后保持。
 */
export const PLATFORM_CLAIMS_PAUSE_REASONS = ["platform_upgrade", "maintenance"] as const;
export type PlatformClaimsPauseReason = (typeof PLATFORM_CLAIMS_PAUSE_REASONS)[number];

export const PLATFORM_CLAIMS_NOTE_MAX_CHARS = 500;
export const PLATFORM_CLAIMS_ACTOR_MAX_CHARS = 200;

export const PLATFORM_CLAIMS_ALREADY_PAUSED = "PLATFORM_CLAIMS_ALREADY_PAUSED";
export const PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH = "PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH";
export const PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN = "PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN";
export const PLATFORM_CLAIMS_INVALID_BODY = "PLATFORM_CLAIMS_INVALID_BODY";
export const PLATFORM_CLAIMS_STATE_MISSING = "PLATFORM_CLAIMS_STATE_MISSING";

export const PlatformClaimsPauseBody = z.object({
  reason: z.enum(PLATFORM_CLAIMS_PAUSE_REASONS),
  note: z.string().trim().min(1).max(PLATFORM_CLAIMS_NOTE_MAX_CHARS).optional(),
}).strict();

export const PlatformClaimsResumeBody = z.object({
  /** 只解除指定原因的暂停；升级程序用它避免误解除运维手工维护暂停。 */
  reason: z.enum(PLATFORM_CLAIMS_PAUSE_REASONS).optional(),
}).strict();

export type PlatformClaimsControl = {
  paused: boolean;
  reason: PlatformClaimsPauseReason | null;
  note: string | null;
  paused_by: string | null;
  paused_at: string | null;
  /** 单例行缺失：调用方必须 fail closed（视为暂停）。 */
  missing: boolean;
};

export type PlatformClaimsInFlight = {
  claimed: number;
  provisioning: number;
  running: number;
  total: number;
};

export type PlatformClaimsWorkload = {
  in_flight: PlatformClaimsInFlight;
  pending: number;
  waiting_human: number;
  /** 所有 Attempt（含终态）中仍有 `effect_pending` 外部效果的数量。 */
  effect_pending_attempts: number;
  /** 所有 Attempt（含终态）中有 `unknown` 外部效果的数量；不得在此状态下继续升级。 */
  unknown_effect_attempts: number;
};

export type PlatformClaimsState = "running" | "pausing" | "paused";

export type PlatformClaimsStatus = {
  claims_paused: boolean;
  reason: PlatformClaimsPauseReason | null;
  note: string | null;
  paused_by: string | null;
  paused_at: string | null;
  state: PlatformClaimsState;
  drained: boolean;
} & PlatformClaimsWorkload;

function isReason(value: unknown): value is PlatformClaimsPauseReason {
  return typeof value === "string" && (PLATFORM_CLAIMS_PAUSE_REASONS as readonly string[]).includes(value);
}

function timestampText(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/** Parse the singleton row. A missing row or an unknown stored reason fails closed as paused. */
export function readPlatformClaimsControlRow(row: Record<string, unknown> | null | undefined): PlatformClaimsControl {
  if (!row) {
    return { paused: true, reason: null, note: null, paused_by: null, paused_at: null, missing: true };
  }
  const paused = row.claims_paused !== false;
  if (!paused) {
    return { paused: false, reason: null, note: null, paused_by: null, paused_at: null, missing: false };
  }
  return {
    paused: true,
    reason: isReason(row.claims_pause_reason) ? row.claims_pause_reason : null,
    note: typeof row.claims_pause_note === "string" ? row.claims_pause_note : null,
    paused_by: typeof row.claims_paused_by === "string" ? row.claims_paused_by : null,
    paused_at: timestampText(row.claims_paused_at),
    missing: false,
  };
}

/** Stable, bounded operator label recorded on the pause row (no secrets: type + name/id only). */
export function platformClaimsActorLabel(actor: { type?: string; id?: string | null; name?: string | null } | undefined): string {
  const type = actor?.type?.trim() || "internal";
  const who = actor?.name?.trim() || actor?.id?.trim() || type;
  return `${type}:${who}`.slice(0, PLATFORM_CLAIMS_ACTOR_MAX_CHARS);
}

export function platformClaimsDrained(workload: PlatformClaimsWorkload): boolean {
  return workload.in_flight.total === 0
    && workload.effect_pending_attempts === 0
    && workload.unknown_effect_attempts === 0;
}

export function projectPlatformClaimsStatus(
  control: PlatformClaimsControl,
  workload: PlatformClaimsWorkload,
): PlatformClaimsStatus {
  const drained = platformClaimsDrained(workload);
  return {
    claims_paused: control.paused,
    reason: control.reason,
    note: control.note,
    paused_by: control.paused_by,
    paused_at: control.paused_at,
    state: control.paused ? (drained ? "paused" : "pausing") : "running",
    drained,
    ...workload,
  };
}

export type PauseDecision =
  | { kind: "apply" }
  | { kind: "noop" }
  | { kind: "conflict"; current: PlatformClaimsPauseReason | null };

/** Pausing is idempotent for the same reason; a different active reason must be resolved explicitly. */
export function decidePause(current: PlatformClaimsControl, reason: PlatformClaimsPauseReason): PauseDecision {
  if (!current.paused) return { kind: "apply" };
  if (current.reason === reason) return { kind: "noop" };
  return { kind: "conflict", current: current.reason };
}

export type ResumeDecision =
  | { kind: "apply" }
  | { kind: "noop" }
  | { kind: "mismatch"; current: PlatformClaimsPauseReason | null };

export function decideResume(
  current: PlatformClaimsControl,
  expectedReason: PlatformClaimsPauseReason | undefined,
): ResumeDecision {
  if (!current.paused) return { kind: "noop" };
  if (expectedReason && current.reason !== expectedReason) return { kind: "mismatch", current: current.reason };
  return { kind: "apply" };
}
