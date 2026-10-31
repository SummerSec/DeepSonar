import { projectCredentialProvider, projectCredentialProviderError } from "../../credentials.js";
import { redactSecretProjection } from "../../credential-secret-projection.js";

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
  const source = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = { ...source };
  for (const key of ["settings_config_json", "settings_config"]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      snapshot[key] = redactSecretProjection(snapshot[key]);
    }
  }
  if (Array.isArray(snapshot.config_files)) {
    snapshot.config_files = snapshot.config_files.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const file = { ...(entry as Record<string, unknown>) };
      if (typeof file.content === "string") {
        try {
          const parsed = JSON.parse(file.content) as unknown;
          file.content = `${JSON.stringify(redactSecretProjection(parsed), null, 2)}\n`;
        } catch {
          file.content = redactSecretProjection(file.content);
        }
      } else if (Object.prototype.hasOwnProperty.call(file, "content")) {
        file.content = redactSecretProjection(file.content);
      }
      return file;
    });
  }
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
