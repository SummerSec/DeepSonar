/** Official trusted images stay trusted unless the scanner found a policy violation. */
export function shouldRevokeOnScanFailure(input: {
  sourceKind: unknown;
  trustStatus: unknown;
  restoreOfficialTrust: boolean;
  errorMessage: string;
}): boolean {
  const official = input.sourceKind === "official";
  const policyFail = input.errorMessage.startsWith("admission policy failed");
  if (official && !policyFail) return false;
  return input.trustStatus === "trusted"
    || (official && input.restoreOfficialTrust && policyFail);
}
