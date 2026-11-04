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

/**
 * Scheduler-side reasons that must converge truthfully instead of borrowing human
 * attention (#890). Every entry here is a fact about our own machinery — budget,
 * cancellation, a stalled wake, a stale round found at boot — never a decision a
 * person has to make. Production showed 35 of 37 `needs_human` findings came from
 * exactly these codes falling through to the capability bucket.
 */
const SYSTEM_INCONCLUSIVE_REASONS = new Set([
  "budget_exhausted",
  "cancelled",
  "boot_stale_open_verification_round",
  "pending_never_verified_stalled",
  "pending_waiting_evidence_stalled",
  "pending_waiting_evidence_signature_stale",
  "verification_stalled",
]);

/**
 * The only reasons allowed to park a Finding in `needs_human`: something outside the
 * system's reach (capability, credential, device) or a decision that is genuinely the
 * user's (business/scope). Everything else, including an unrecognised reason, is a
 * policy gap and must converge honestly.
 */
const CAPABILITY_BOUNDARY_REASONS = new Set([
  "verify_needs_human",
  "credential",
  "missing_device",
  "business_decision",
  "capability_limit",
  "external_authorization",
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
  if (value.startsWith("inconclusive_escalate_after_")) return "inconclusive";
  if (BUDGET_INCONCLUSIVE_REASONS.has(value)) return "inconclusive";
  if (SYSTEM_INCONCLUSIVE_REASONS.has(value)) return "inconclusive";
  if (CAPABILITY_BOUNDARY_REASONS.has(value)) return "needs_human";
  // An unrecognised reason is a policy gap, not a human task (#890). Converging as
  // inconclusive keeps the Finding honest ("we could not prove it") without spending
  // attention on a decision nobody is being asked to make.
  return "inconclusive";
}

/**
 * True when `reason` is not a reason the Scheduler knows how to classify. Callers use
 * this to count policy gaps so a missing rule is visible instead of silently becoming
 * (or silently not becoming) a human task.
 */
export function isVerifyPolicyGapReason(reason: string | null | undefined): boolean {
  const value = String(reason ?? "").trim();
  if (!value) return true;
  if (value === "fact_first_rejected" || value === "fact_first_conflict") return false;
  if (value.startsWith("no_progress:") || value.startsWith("max_hub_rounds")) return false;
  if (value.startsWith("verify_failed") || value.startsWith("verify_timeout")
    || value.startsWith("verify_cancelled") || value.startsWith("verify_orphan")) return false;
  if (value.startsWith("inconclusive_escalate_after_")) return false;
  if (BUDGET_INCONCLUSIVE_REASONS.has(value)) return false;
  if (SYSTEM_INCONCLUSIVE_REASONS.has(value)) return false;
  if (CAPABILITY_BOUNDARY_REASONS.has(value)) return false;
  return true;
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
