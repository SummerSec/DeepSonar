/** Build only the credential edits explicitly made in project settings. */
export function credentialSelectionPatch(input: {
  credentialSelectionChanged: boolean;
  credIds: string[];
  defaultCredentialId: string | null;
  selectedDefaultCredentialId: string | null;
  credentialListLoaded: boolean;
}): { enabled_credential_ids?: string[]; default_credential_id?: string | null; default_model_ref?: null; fallback_model_refs?: string[] } {
  if (!input.credentialListLoaded) return {};
  return {
    ...(input.credentialSelectionChanged ? { enabled_credential_ids: input.credIds } : {}),
    ...(input.selectedDefaultCredentialId !== input.defaultCredentialId
      ? { default_credential_id: input.selectedDefaultCredentialId, default_model_ref: null, fallback_model_refs: [] } : {}),
  };
}

/** Missing allowlist is unrestricted; an explicit empty allowlist permits nothing. */
export function defaultCredentialCandidates<T extends { id: string; status: string; kind: string; project_id: string | null }>(
  credentials: readonly T[], projectId: string, enabledCredentialIds: readonly string[] | undefined,
): T[] {
  return credentials.filter((credential) => credential.kind === "llm_provider" && credential.status === "active"
    && (credential.project_id === null || credential.project_id === projectId)
    && (enabledCredentialIds === undefined || enabledCredentialIds.includes(credential.id)));
}

export function defaultCredentialUnavailable(
  defaultCredentialId: string | null,
  credentials: readonly { id: string; status: string }[],
): boolean {
  return Boolean(defaultCredentialId && !credentials.some((credential) => credential.id === defaultCredentialId && credential.status === "active"));
}
