import type { sql } from "./db.js";
import type { ReadinessCredentialRow, ReadinessRoleRow } from "./readiness.js";
import { parseProjectAgentAllowlist } from "./domains/project-agent-allowlist/policy.js";
import { ProviderCredentialResolveError, resolveProviderCredentialForJob } from "./domains/provider-adapter/resolve-credential.js";
import type { RoleRuntimeSnapshotTransaction } from "./domains/role-runtime-snapshot/ports.js";

export interface ReadinessCredentialResolution {
  roleId: string;
  code: string;
  error?: ProviderCredentialResolveError;
}

/** Readiness uses the Job credential resolver, including its scoped candidate and error rules. */
export async function resolveReadinessCredentials(
  db: RoleRuntimeSnapshotTransaction | typeof sql,
  projectId: string | null,
  projectConfig: unknown,
  roles: ReadinessRoleRow[],
  allowPassthrough: boolean,
): Promise<{ credentials: ReadinessCredentialRow[]; resolutions: ReadinessCredentialResolution[] }> {
  const allowlist = parseProjectAgentAllowlist(projectConfig);
  const credentials: ReadinessCredentialRow[] = [];
  const resolutions: ReadinessCredentialResolution[] = [];
  for (const role of roles) {
    const configId = role.project_config_id ?? role.global_config_id;
    if (!configId) continue;
    const preferredAgentCli = allowlist.default_agent_cli ?? role.global_agent_cli;
    const modelRef = allowlist.default_model_ref ?? role.global_model;
    role.resolved_agent_cli = preferredAgentCli ?? "claude-code";
    role.resolved_model = modelRef;
    try {
      const chosen = await resolveProviderCredentialForJob({
        // Both clients execute this fixed parameterized query; postgres also has helper overloads.
        db: db as RoleRuntimeSnapshotTransaction, projectId, allowlist, preferredAgentCli, modelRef,
        allowPassthrough: allowPassthrough || allowlist.allow_model_catalog_passthrough,
      });
      if (chosen) {
        role.resolved_agent_cli = chosen.agent_cli;
        credentials.push({
          role_config_id: configId, purpose: "llm", credential_id: chosen.id,
          name: chosen.name, kind: "llm_provider", provider: chosen.provider,
          project_id: chosen.project_id,
          status: chosen.status as ReadinessCredentialRow["status"],
          public_metadata_json: chosen.public_metadata_json, agent_cli: chosen.agent_cli,
          settings_config_json: chosen.settings_config_json,
        });
      }
    } catch (error) {
      if (!(error instanceof ProviderCredentialResolveError)) throw error;
      const code = error.code === "provider_credential_multi_match"
        ? "CREDENTIAL_BINDING_AMBIGUOUS"
        : error.code === "provider_credential_cli_mismatch" || error.code === "provider_credential_protocol_incompatible"
          ? "CREDENTIAL_CLI_INCOMPATIBLE"
          : error.code === "provider_credential_allowlist_stale"
            ? "CREDENTIAL_ALLOWLIST_STALE"
            : "CREDENTIAL_MISSING";
      resolutions.push({ roleId: role.role_id, code, error });
    }
  }
  return { credentials, resolutions };
}
