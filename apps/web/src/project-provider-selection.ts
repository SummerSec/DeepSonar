/** Build only the credential edits explicitly made in project settings. */
export function credentialSelectionPatch(input: {
  credentialSelectionChanged: boolean;
  credIds: string[];
  defaultCredentialId: string | null;
  clearDefaultCredential: boolean;
}): { enabled_credential_ids?: string[]; default_credential_id?: null } {
  return {
    ...(input.credentialSelectionChanged ? { enabled_credential_ids: input.credIds } : {}),
    ...(input.clearDefaultCredential || (input.credentialSelectionChanged && input.defaultCredentialId && !input.credIds.includes(input.defaultCredentialId))
      ? { default_credential_id: null } : {}),
  };
}

export function defaultCredentialUnavailable(
  defaultCredentialId: string | null,
  credentials: readonly { id: string; status: string }[],
): boolean {
  return Boolean(defaultCredentialId && !credentials.some((credential) => credential.id === defaultCredentialId && credential.status === "active"));
}
