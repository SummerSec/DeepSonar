/** #740 平台级全局暂停领取：Web 全局横幅的纯展示逻辑（GET /platform/claims）。 */
export type PlatformClaimsPauseReason = "platform_upgrade" | "maintenance";

export type PlatformClaimsStatus = {
  claims_paused: boolean;
  reason: PlatformClaimsPauseReason | null;
  note: string | null;
  paused_by: string | null;
  paused_at: string | null;
  state: "running" | "pausing" | "paused";
  drained: boolean;
  in_flight: { claimed: number; provisioning: number; running: number; total: number };
  pending: number;
  waiting_human: number;
  effect_pending_attempts: number;
  unknown_effect_attempts: number;
};

export type PlatformClaimsBanner = {
  title: string;
  detail: string;
  note: string | null;
};

const REASON_LABEL: Record<PlatformClaimsPauseReason, string> = {
  platform_upgrade: "平台升级",
  maintenance: "平台维护",
};

/** Returns null when claims are running; otherwise a bounded, operator-facing banner. */
export function platformClaimsBanner(status: PlatformClaimsStatus | null | undefined): PlatformClaimsBanner | null {
  if (!status?.claims_paused) return null;
  const reason = status.reason ? REASON_LABEL[status.reason] : "原因未知";
  const parts: string[] = [];
  if (status.state === "paused") {
    parts.push("在途 Job 已全部收尾");
  } else {
    parts.push(`在途 ${status.in_flight.total} 个 Job 收尾中`);
    const effects = status.effect_pending_attempts + status.unknown_effect_attempts;
    if (effects > 0) parts.push(`${effects} 个 Attempt 有未结算外部效果`);
  }
  if (status.pending > 0) parts.push(`${status.pending} 个已入队等待恢复`);
  return {
    title: `平台已暂停领取新任务（${reason}）`,
    detail: `新任务仍可创建并入队，但不会被领取 · ${parts.join(" · ")}`,
    note: status.note?.trim() ? status.note.trim() : null,
  };
}
