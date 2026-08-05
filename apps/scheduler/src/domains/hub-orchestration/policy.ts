/** Evidence-wait Hub wakeups are edge-triggered by the evidence snapshot. */
export function shouldWakeEvidenceHub(lastSignature: string | null | undefined, currentSignature: string): boolean {
  return currentSignature.trim().length > 0 && lastSignature !== currentSignature;
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
