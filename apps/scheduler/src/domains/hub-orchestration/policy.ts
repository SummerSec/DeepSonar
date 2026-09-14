export type EvidenceHubWakeOpts = {
  lastGateFingerprint?: string | null;
  gateFingerprint?: string | null;
};

/**
 * Evidence-wait Hub wakeups are edge-triggered by the evidence snapshot (#519).
 * Signature growth alone is not progress: if a gate fingerprint is present and
 * unchanged, Hub must not wake on new review/test node ids.
 */
export function shouldWakeEvidenceHub(
  lastSignature: string | null | undefined,
  currentSignature: string,
  opts?: EvidenceHubWakeOpts,
): boolean {
  if (currentSignature.trim().length === 0 || lastSignature === currentSignature) return false;
  const lastFp = String(opts?.lastGateFingerprint ?? "").trim();
  const curFp = String(opts?.gateFingerprint ?? "").trim();
  if (lastFp && curFp && lastFp === curFp) return false;
  return true;
}

/** A Hub terminal row is the only input that consumes the decision budget. */
export function isHubRoundWithinBudget(succeededRounds: number, maxHubRounds: number): boolean {
  return succeededRounds < maxHubRounds;
}

/** Hub itself must not recursively trigger a generic graph-progress wakeup. */
export function shouldConsiderHubTrigger(
  jobType: unknown,
  options: { idleWake?: boolean; manual?: boolean; force?: boolean },
): boolean {
  return !(jobType === "hub_reason" && !options.idleWake && !options.manual && !options.force);
}
