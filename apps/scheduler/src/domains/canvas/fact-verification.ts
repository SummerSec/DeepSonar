export const HUMAN_FACT_VERIFICATION_STATUSES = ["verified", "rejected", "needs_human"] as const;
export type HumanFactVerificationStatus = (typeof HUMAN_FACT_VERIFICATION_STATUSES)[number];

/** Report quantity gate only trusts closed `verified` Facts. Finding `confirmed` is not a Fact state. */
export function factQuantityParticipatesInGate(status: string | undefined): boolean {
  return status === "verified";
}

export type FactVerificationDecision =
  | { ok: true; idempotent: boolean }
  | { ok: false; error: string; error_code: "FACT_VERIFICATION_ILLEGAL_TRANSITION" };

/**
 * Fact 证据信任迁移。Owner 是人工（jobs:control），不是 Finding Verify。
 * Agent emit 只产生 unverified；verifying 仅导入/历史可读，人不能写入。
 * rejected → verified 必须先 reopen 到 needs_human，避免一次点击把已排除口径重新放进报告门禁。
 */
export function evaluateFactVerificationTransition(
  from: string,
  to: HumanFactVerificationStatus,
): FactVerificationDecision {
  if (from === to) return { ok: true, idempotent: true };
  if (from === "rejected" && to === "verified") {
    return {
      ok: false,
      error: "已排除的 Fact 不能直接标为 verified；请先收口为 needs_human 再确认。",
      error_code: "FACT_VERIFICATION_ILLEGAL_TRANSITION",
    };
  }
  if (
    from === "unverified"
    || from === "verifying"
    || from === "needs_human"
    || from === "verified"
    || from === "rejected"
  ) {
    return { ok: true, idempotent: false };
  }
  return {
    ok: false,
    error: `不允许将 Fact 验证态从 ${from} 迁到 ${to}`,
    error_code: "FACT_VERIFICATION_ILLEGAL_TRANSITION",
  };
}
