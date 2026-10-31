/**
 * Scheduler-owned Finding verify terminals (#537).
 * needs_human is a capability-boundary ask; budget / fact-first negatives
 * settle as refuted or inconclusive and must not create human nodes.
 */

export const VERIFY_AUTO_TERMINALS = ["refuted", "inconclusive"] as const;
export const VERIFY_SETTLE_TERMINALS = ["needs_human", "refuted", "inconclusive"] as const;
export const VERIFY_CONVERGED_STATUSES = [
  "confirmed",
  "needs_human",
  "refuted",
  "inconclusive",
] as const;

export type VerifyAutoTerminal = (typeof VERIFY_AUTO_TERMINALS)[number];
export type VerifySettleTerminal = (typeof VERIFY_SETTLE_TERMINALS)[number];
export type VerifyConvergedStatus = (typeof VERIFY_CONVERGED_STATUSES)[number];

const BUDGET_INCONCLUSIVE_REASONS = new Set([
  "max_followup_depth",
  "max_followups_per_job",
  "max_verification_rounds",
  "max_verification_rounds_no_new_evidence",
  "boot_stale_verify_success",
  "verification_limit",
]);

export function isVerifyConvergedStatus(status: string): status is VerifyConvergedStatus {
  return (VERIFY_CONVERGED_STATUSES as readonly string[]).includes(status);
}

export function isVerifySettleTerminal(status: string): status is VerifySettleTerminal {
  return (VERIFY_SETTLE_TERMINALS as readonly string[]).includes(status);
}

/**
 * Map a durable verify reason / round error to the Scheduler-owned terminal.
 * Unknown or capability-boundary reasons stay needs_human.
 */
export function classifyVerifyTerminalReason(reason: string | null | undefined): VerifySettleTerminal {
  const value = String(reason ?? "").trim();
  if (value === "fact_first_rejected") return "refuted";
  if (value === "fact_first_conflict") return "inconclusive";
  if (value.startsWith("no_progress:")) return "inconclusive";
  if (value.startsWith("max_hub_rounds")) return "inconclusive";
  if (value.startsWith("verify_failed") || value.startsWith("verify_timeout")
    || value.startsWith("verify_cancelled") || value.startsWith("verify_orphan")) {
    return "inconclusive";
  }
  if (BUDGET_INCONCLUSIVE_REASONS.has(value)) return "inconclusive";
  return "needs_human";
}

export function shouldCreateHumanBlocker(status: VerifySettleTerminal): boolean {
  return status === "needs_human";
}

/** Consecutive infrastructure failures, independent of business verification rounds. */
export async function verificationFailureRetriesExhausted(
  db: typeof import("./db.js").sql, findingId: string, attempt: number, maxRetries: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error("Invalid maxAutoRetries");
  if (maxRetries === 0) return true;
  const previous = await db`SELECT status FROM finding_verification_rounds
    WHERE finding_id=${findingId} AND attempt<${attempt} AND finished_at IS NOT NULL
    ORDER BY attempt DESC LIMIT ${maxRetries}`;
  return previous.length === maxRetries && previous.every(row => row.status === "failed");
}
