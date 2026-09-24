/**
 * #690: Resolve a kernel-held LLM credential for Job create from project-authorized
 * Provider plugins + Hub capability needs. Hub never submits credential/account IDs;
 * RoleConfig.role_credentials is gone — no dual-read / fallback.
 */
import { buildRepairFeedback, type RepairFeedback } from "@deepsonar/shared-types";
import { extractModelsFromSettings } from "../../provider-settings.js";
import type { ProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";

export type ResolveProviderCredentialInput = {
  db: RoleRuntimeSnapshotTransaction;
  projectId: string;
  agentCli: string;
  allowlist: ProjectAgentAllowlist;
  /** Hub-proposed Provider plugin id (credentials.provider); never a credential UUID. */
  provider?: string | null;
  modelRef?: string | null;
  allowPassthrough?: boolean;
};

export type ResolvedProviderCredential = {
  id: string;
  name: string;
  provider: string;
  status: string;
  project_id: string | null;
  agent_cli: string | null;
  settings_config_json: unknown;
  public_metadata_json: unknown;
  meta_json: unknown;
  model_catalog_json: unknown;
  model_catalog_fetched_at: unknown;
  health_status: string | null;
};

export class ProviderCredentialResolveError extends Error {
  readonly code: string;
  readonly repair: RepairFeedback;

  constructor(code: string, repair: RepairFeedback) {
    super(repair.message);
    this.name = "ProviderCredentialResolveError";
    this.code = code;
    this.repair = repair;
  }
}

function throwResolve(
  code: string,
  input: {
    message: string;
    path: string;
    expected: unknown;
    observed: unknown;
    next_action: string;
    category?: "model_correctable" | "permanent_failure";
  },
): never {
  const repair = buildRepairFeedback({
    category: input.category ?? "model_correctable",
    code,
    operation: "resolve_provider_credential",
    path: input.path,
    message: input.message,
    expected: input.expected,
    observed_shape: input.observed,
    next_action: input.next_action,
  });
  throw new ProviderCredentialResolveError(code, repair);
}

function modelMatches(
  settings: unknown,
  agentCli: string,
  modelRef: string | null | undefined,
  allowPassthrough: boolean,
): boolean {
  if (!modelRef) return true;
  if (allowPassthrough) return true;
  const ids = extractModelsFromSettings(settings, agentCli);
  if (ids.length === 0) return false;
  return ids.includes(modelRef);
}

/**
 * Pick exactly one active, project-authorized, CLI-compatible credential.
 * Fail closed on zero or ambiguous matches (unless project default uniquely wins).
 */
export async function resolveProviderCredentialForJob(
  input: ResolveProviderCredentialInput,
): Promise<ResolvedProviderCredential | null> {
  const providerNeed = typeof input.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : null;
  const modelNeed = typeof input.modelRef === "string" && input.modelRef.trim()
    ? input.modelRef.trim()
    : null;
  const allowPassthrough = input.allowPassthrough === true;

  const rows = await input.db`
    SELECT c.id, c.name, c.provider, c.status, c.project_id,
           c.agent_cli, c.settings_config_json, c.public_metadata_json, c.meta_json,
           c.model_catalog_json, c.model_catalog_fetched_at, c.health_status
    FROM credentials c
    WHERE c.kind = 'llm_provider'
      AND c.status = 'active'
      AND (c.project_id IS NULL OR c.project_id = ${input.projectId})
    ORDER BY c.name, c.id
    FOR SHARE OF c` as Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    project_id: string | null;
    agent_cli: string | null;
    settings_config_json: unknown;
    public_metadata_json: unknown;
    meta_json: unknown;
    model_catalog_json: unknown;
    model_catalog_fetched_at: unknown;
    health_status: string | null;
  }>;

  const candidates: ResolvedProviderCredential[] = [];
  for (const row of rows) {
    if (row.project_id && row.project_id !== input.projectId) continue;
    if (input.allowlist.configured && !input.allowlist.enabled_credential_ids.includes(row.id)) {
      continue;
    }
    if (providerNeed && row.provider !== providerNeed) continue;
    // Model compatibility is re-checked after credential selection (catalog admit / exclusive pin).
    candidates.push({
      id: row.id,
      name: row.name,
      provider: row.provider,
      status: row.status,
      project_id: row.project_id,
      agent_cli: row.agent_cli,
      settings_config_json: row.settings_config_json,
      public_metadata_json: row.public_metadata_json,
      meta_json: row.meta_json,
      model_catalog_json: row.model_catalog_json,
      model_catalog_fetched_at: row.model_catalog_fetched_at,
      health_status: row.health_status,
    });
  }

  if (candidates.length === 0) {
    // No LLM needed when Hub/project did not ask for provider/model and RoleConfig has no identity.
    if (!providerNeed && !modelNeed && !input.allowlist.default_credential_id) {
      return null;
    }
    throwResolve("provider_credential_no_match", {
      message: providerNeed
        ? `项目授权目录内没有可用的 Provider「${providerNeed}」凭据（CLI=${input.agentCli}${modelNeed ? ` model=${modelNeed}` : ""}）`
        : `项目授权目录内没有可用的 LLM Provider 凭据（CLI=${input.agentCli}${modelNeed ? ` model=${modelNeed}` : ""}）`,
      path: providerNeed ? "provider" : "credential",
      expected: {
        kind: "project_authorized_active_credential",
        provider: providerNeed,
        agent_cli: input.agentCli,
        model_ref: modelNeed,
        enabled_credential_ids: input.allowlist.enabled_credential_ids,
      },
      observed: { match_count: 0 },
      next_action: "enable_healthy_provider_credential_or_relax_model_requirements",
    });
  }

  const cliCompatible = candidates.filter((row) => {
    const pinned = typeof row.agent_cli === "string" && row.agent_cli.trim() ? row.agent_cli.trim() : null;
    return !pinned || pinned === input.agentCli;
  });
  let pool = cliCompatible.length > 0 ? cliCompatible : candidates;
  if (modelNeed) {
    const modelFit = pool.filter((row) => {
      const pinnedCli = typeof row.agent_cli === "string" && row.agent_cli.trim()
        ? row.agent_cli.trim()
        : input.agentCli;
      return modelMatches(row.settings_config_json, pinnedCli, modelNeed, allowPassthrough);
    });
    if (modelFit.length > 0) pool = modelFit;
  }

  const defaultId = input.allowlist.default_credential_id;
  if (defaultId) {
    const preferred = pool.find((row) => row.id === defaultId) ?? candidates.find((row) => row.id === defaultId);
    if (preferred) return preferred;
  }

  if (pool.length === 1) return pool[0]!;
  if (candidates.length === 1) return candidates[0]!;

  throwResolve("provider_credential_multi_match", {
    message: `项目授权目录内有 ${pool.length} 个匹配 Provider 凭据，无法唯一解析；请设置项目缺省凭据或收窄白名单`,
    path: "provider",
    expected: { kind: "unique_or_default_credential", match_count: 1 },
    observed: {
      match_count: pool.length,
      providers: candidates.map((row) => ({
        provider: row.provider,
        name: row.name,
        health_status: row.health_status,
      })),
      default_credential_configured: Boolean(defaultId),
    },
    next_action: "set_project_default_credential_or_narrow_enabled_credential_ids",
  });
}
