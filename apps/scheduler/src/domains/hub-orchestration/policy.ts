export type EvidenceHubWakeOpts = {
  lastGateFingerprint?: string | null;
  gateFingerprint?: string | null;
  /**
   * Finding has never had review/test evidence. Signature equality must not
   * suppress wakeup (#574); the signature gate only dedupes rounds that already
   * observed some independent evidence without net gate progress.
   */
  neverVerified?: boolean;
};

/**
 * #574: after this many Hub wake attempts on a stuck verify cluster
 * (never-verified pending and/or persistent inconclusive), escalate to
 * needs_human + human Action and stop self-driving with paused_reason.
 * Keep small: enough for one rework attempt, not a silent long wait.
 */
export const INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS = 2;

/**
 * Evidence-wait Hub wakeups are edge-triggered by the evidence snapshot (#519).
 * Signature growth alone is not progress: if a gate fingerprint is present and
 * unchanged, Hub must not wake on new review/test node ids — except never-verified
 * pending findings, which must remain wakeable until evidence appears or we
 * escalate (#574).
 */
export function shouldWakeEvidenceHub(
  lastSignature: string | null | undefined,
  currentSignature: string,
  opts?: EvidenceHubWakeOpts,
): boolean {
  if (currentSignature.trim().length === 0) return false;
  if (opts?.neverVerified) return true;
  if (lastSignature === currentSignature) return false;
  const lastFp = String(opts?.lastGateFingerprint ?? "").trim();
  const curFp = String(opts?.gateFingerprint ?? "").trim();
  if (lastFp && curFp && lastFp === curFp) return false;
  return true;
}

/** True when Hub wake attempts on a stuck waiting round have hit the escalate floor. */
export function shouldEscalateUnclosedVerify(hubWakeAttempts: number): boolean {
  return hubWakeAttempts >= INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS;
}

export type VerifyUnclosedCounts = {
  inconclusive: number;
  pending: number;
};

/** Stable paused_reason / UI label payload for verify-unclosed Hub stop (#574). */
export function formatVerifyUnclosedPausedReason(counts: VerifyUnclosedCounts): string {
  const total = counts.inconclusive + counts.pending;
  return `verify_unclosed:high=${total}(inconclusive=${counts.inconclusive},pending=${counts.pending})`;
}

/**
 * Hub round budget (#521).
 * `0` means unlimited (no round-count stop). Positive integers are an optional
 * runaway guardrail, not a normal completion criterion.
 */
export const UNLIMITED_HUB_ROUNDS = 0;
const MAX_FINITE_HUB_ROUNDS = 10_000;

export function isUnlimitedHubRounds(maxHubRounds: number): boolean {
  return maxHubRounds === UNLIMITED_HUB_ROUNDS;
}

export function hubRoundLimitLabel(maxHubRounds: number): string {
  return isUnlimitedHubRounds(maxHubRounds) ? "unlimited" : String(maxHubRounds);
}

/**
 * Parse env / persisted / PATCH values.
 * Accepts `unlimited` (any case) and `0` as unlimited; positive safe integers
 * as a finite cap. Invalid values return null so callers can fail closed or
 * keep the previous layer instead of silently substituting 20.
 */
export function parseHubMaxRounds(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (/^unlimited$/i.test(trimmed)) return UNLIMITED_HUB_ROUNDS;
    raw = trimmed;
  }
  if (typeof raw === "boolean" || typeof raw === "object") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_FINITE_HUB_ROUNDS) return null;
  return n;
}

export function parseHubMaxRoundsEnv(raw: string | undefined, fallback: number): {
  value: number;
  invalid: boolean;
} {
  if (raw === undefined) return { value: fallback, invalid: false };
  const parsed = parseHubMaxRounds(raw);
  if (parsed == null) return { value: fallback, invalid: true };
  return { value: parsed, invalid: false };
}

/** A Hub terminal row is the only input that consumes the decision budget. */
export function isHubRoundWithinBudget(succeededRounds: number, maxHubRounds: number): boolean {
  if (isUnlimitedHubRounds(maxHubRounds)) return true;
  return succeededRounds < maxHubRounds;
}

/** Hub itself must not recursively trigger a generic graph-progress wakeup. */
export function shouldConsiderHubTrigger(
  jobType: unknown,
  options: { idleWake?: boolean; manual?: boolean; force?: boolean },
): boolean {
  return !(jobType === "hub_reason" && !options.idleWake && !options.manual && !options.force);
}
