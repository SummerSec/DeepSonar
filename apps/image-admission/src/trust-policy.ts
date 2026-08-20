export const ADMISSION_POLICY_FAILURE_PREFIX = "admission policy failed";

export function admissionPolicyFailureMessage(criticalCount: number, secretCount: number): string {
  return `${ADMISSION_POLICY_FAILURE_PREFIX}: critical=${criticalCount}, secrets=${secretCount}`;
}

export function isAdmissionPolicyFailure(errorMessage: string): boolean {
  return errorMessage.startsWith(ADMISSION_POLICY_FAILURE_PREFIX);
}

/** Third-party imports fail closed on CRITICAL CVEs or secrets. Official catalog images only record the counts. */
export function shouldRejectVulnerabilityFindings(input: {
  sourceKind: unknown;
  criticalCount: number;
  secretCount: number;
}): boolean {
  return input.sourceKind !== "official" && (input.criticalCount > 0 || input.secretCount > 0);
}

/**
 * Official catalog versions are trusted by Release digest, not by local Trivy.
 * Distro CRITICAL/secrets and infra/scanner failures must not auto-revoke them.
 * Third-party trusted versions still revoke on any scan failure.
 */
export function shouldRevokeOnScanFailure(input: {
  sourceKind: unknown;
  trustStatus: unknown;
  restoreOfficialTrust: boolean;
  errorMessage: string;
}): boolean {
  if (input.sourceKind === "official") return false;
  return input.trustStatus === "trusted";
}
