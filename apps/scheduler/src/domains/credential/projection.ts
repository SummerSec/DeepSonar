import { projectCredentialProvider, projectCredentialProviderError } from "../../credentials.js";

export function projectJobProviderFields(row: Record<string, unknown>): Record<string, unknown> {
  const projected = {
    ...row,
    error: projectCredentialProviderError(row.error),
  };
  if (row.credential_provider === null || row.credential_provider === undefined || row.credential_provider === "") {
    return projected;
  }
  const projection = projectCredentialProvider("llm_provider", row.credential_provider);
  return {
    ...projected,
    credential_provider: projection.provider,
    credential_provider_valid: projection.provider_valid,
  };
}

export function projectJobSnapshot(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = { ...(value as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(snapshot, "credential_provider")) return snapshot;
  const raw = snapshot.credential_provider;
  if (raw === null || raw === undefined || raw === "") return snapshot;
  const projection = projectCredentialProvider("llm_provider", raw);
  return {
    ...snapshot,
    credential_provider: projection.provider,
    credential_provider_valid: projection.provider_valid,
  };
}
