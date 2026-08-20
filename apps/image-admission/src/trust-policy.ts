/** Official catalog trust is release-list based, not a 0-CRITICAL/0-secret gate. */

export function isOfficialSource(sourceKind: unknown): boolean {
  return sourceKind === "official";
}

/** Third-party imports stay 0 CRITICAL / 0 secret. Official distro findings are recorded, not a gate. */
export function evaluateVulnerabilityAdmissionPolicy(input: {
  sourceKind: unknown;
  criticalCount: number;
  secretCount: number;
}): { ok: true } | { ok: false; message: string } {
  if (input.criticalCount <= 0 && input.secretCount <= 0) return { ok: true };
  if (isOfficialSource(input.sourceKind)) return { ok: true };
  return {
    ok: false,
    message: `admission policy failed: critical=${input.criticalCount}, secrets=${input.secretCount}`,
  };
}

/**
 * Official catalog versions are never auto-revoked by periodic rescan.
 * Distro CRITICAL/secrets, Cosign/network/pull, and restore-scan failures stay trusted
 * (scan is recorded failed + alert). Third-party trusted versions still revoke on any failure.
 */
export function shouldRevokeOnScanFailure(input: {
  sourceKind: unknown;
  trustStatus: unknown;
  restoreOfficialTrust: boolean;
  errorMessage: string;
}): boolean {
  if (isOfficialSource(input.sourceKind)) return false;
  return input.trustStatus === "trusted";
}
