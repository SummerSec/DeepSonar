/**
 * #690: Resolve a kernel-held LLM credential for Job create from project-authorized
 * Provider plugins + Hub capability needs. Hub never submits credential/account IDs;
 * RoleConfig.role_credentials is gone — no dual-read / fallback.
 */
import { buildRepairFeedback, isCurrentAgentCli, type RepairFeedback } from "@deepsonar/shared-types";
import { validateCredentialCompatibility } from "../../credentials.js";
import { extractModelsFromSettings, resolveEffectiveModel, resolvePiCliModelSelection, resolveRequestedModel } from "../../provider-settings.js";
import type { ProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";
import { readCredentialCapacities, type CredentialCapacity } from "./credential-capacity.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";
import { bareUpstreamModelId, ModelCatalogMismatchError } from "../../provider-effective-model.js";

export type ResolveProviderCredentialInput = {
  db: RoleRuntimeSnapshotTransaction;
  projectId: string | null;
  /** Explicit Hub constraint; never pass a platform seed here. */
  agentCli?: string | null;
  /** Explicit project/global preference, used only to break cross-CLI ties. */
  preferredAgentCli?: string | null;
  allowlist: ProjectAgentAllowlist;
  /** Hub-proposed Provider plugin id (credentials.provider); never a credential UUID. */
  provider?: string | null;
  modelRef?: string | null;
  allowPassthrough?: boolean;
  /** Kernel-only existing Job identity; never an Agent account selector. */
  existingCredentialId?: string | null;
  /** Kernel-only current Job, excluded only from its own recovery capacity read. */
  existingJobId?: string | null;
  /** Snapshot creation may persist a waiting decision; strict/readiness callers receive the capacity error. */
  allowCapacityWait?: boolean;
  /** Snapshot-owned model selection, including governed fallback/capability rules. */
  selectModel?: (credential: ResolvedProviderCredential) => string | null;
};

export type CredentialSelection = {
  schema: "deepsonar.credential-selection/v1";
  observed_at: string;
  selected_credential_id: string;
  /** A creation-time observation, not a waiting clock or execution budget. */
  reason: "existing" | "default" | "capacity" | "single" | "capacity_wait";
  error_code: "provider_credential_all_at_capacity" | null;
  candidates: Array<{
    credential_id: string;
    health: string | null;
    health_error_category: string | null;
    skipped: "health_error" | "model_incompatible" | "identity_not_selected" | "at_capacity" | null;
    capacity: CredentialCapacity | null;
  }>;
};

export type ResolvedProviderCredential = {
  selection?: CredentialSelection;
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
  health_error_category?: string | null;
};

/** A catalog/probe limitation (unknown) does not prove inference is unavailable (#491). */
export function credentialHealthUnavailable(row: { health_status?: unknown; health_error_category?: unknown }): boolean {
  return row.health_status === "error" && row.health_error_category !== "unknown";
}

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
    category?: "model_correctable" | "permanent_failure" | "transient_retryable";
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

/** Shared candidate/capability-gate normalization; preserves each runtime dialect. */
export function resolveCredentialModelRef(
  settings: unknown,
  agentCli: string,
  modelRef: string,
): string | null {
  if (agentCli === "pi") {
    try {
      return resolvePiCliModelSelection({ model: modelRef, settingsConfig: settings }).cliModel;
    } catch {
      return null;
    }
  }
  return resolveEffectiveModel({ roleModel: modelRef, agentCli, settingsConfig: settings });
}

function modelMatches(
  settings: unknown,
  agentCli: string,
  modelRef: string | null | undefined,
  allowPassthrough: boolean,
): boolean {
  if (!modelRef || allowPassthrough) return true;
  const ids = extractModelsFromSettings(settings, agentCli);
  const resolved = resolveCredentialModelRef(settings, agentCli, modelRef);
  return resolved !== null && ids.includes(resolved);
}

/**
 * Resolve provider/model/project authorization before choosing a CLI.
 * A Hub CLI is a hard constraint; configuration preferences only break ties.
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
           c.model_catalog_json, c.model_catalog_fetched_at, c.health_status, c.health_error_category
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
    health_error_category: string | null;
  }>;

  // A stale explicit restriction must be repaired by an administrator, never widened.
  const visibleRows = rows.filter((row) => row.status === "active"
    && (!row.project_id || row.project_id === input.projectId));
  const referencedIds = input.allowlist.credential_ids_configured
    ? input.allowlist.enabled_credential_ids
    : input.allowlist.default_credential_id ? [input.allowlist.default_credential_id] : [];
  const missingIds = referencedIds.filter((id) => !visibleRows.some((row) => row.id === id));
  if (missingIds.length > 0) {
    throwResolve("provider_credential_allowlist_stale", {
      message: "项目凭据白名单包含不存在、停用或不可访问的凭据；请管理员修复白名单",
      path: input.allowlist.credential_ids_configured ? "enabled_credential_ids" : "default_credential_id",
      expected: { kind: "active_project_authorized_credentials" },
      observed: { unavailable_count: missingIds.length },
      next_action: "repair_project_credential_allowlist",
      category: "permanent_failure",
    });
  }
  const candidates = visibleRows.filter((row) => {
    if (input.allowlist.credential_ids_configured && !input.allowlist.enabled_credential_ids.includes(row.id)) return false;
    if (providerNeed && row.provider !== providerNeed) return false;
    return true;
  });

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
        agent_cli: input.agentCli ?? null,
        model_ref: modelNeed,
        enabled_credential_ids: input.allowlist.enabled_credential_ids,
      },
      observed: { match_count: 0 },
      next_action: "enable_healthy_provider_credential_or_relax_model_requirements",
    });
  }

  // Validate each account’s exclusive CLI pin and project authorization before preference.
  // A missing or retired pin is never treated as compatible with every CLI.
  const cliCompatible = candidates.filter((row) => isCurrentAgentCli(row.agent_cli)
    && input.allowlist.enabled_agent_clis.includes(row.agent_cli));
  if (cliCompatible.length === 0 && candidates.length > 0) {
    throwResolve("provider_credential_cli_mismatch", {
      message: "项目授权目录内没有绑定当前已启用 Agent CLI 的凭据",
      path: "agent_cli",
      expected: { agent_cli: input.agentCli ?? null, kind: "credential_pinned_to_this_cli" },
      observed: {
        candidates: candidates.map((row) => ({
          credential_id: row.id,
          agent_cli: typeof row.agent_cli === "string" && row.agent_cli.trim() ? row.agent_cli.trim() : null,
        })),
      },
      next_action: "enable_credential_pinned_to_role_cli_or_change_project_default_credential",
      category: "permanent_failure",
    });
  }

  // 协议级不兼容（如 claude-code × openai）在候选层挡掉，category=model_correctable。
  const protocolCompatible = cliCompatible.filter((row) => {
    return validateCredentialCompatibility(row.agent_cli!, row.provider) === null;
  });
  if (protocolCompatible.length === 0 && cliCompatible.length > 0) {
    throwResolve("provider_credential_protocol_incompatible", {
      message: "项目授权目录内的凭据与其绑定 CLI 的 Provider 协议不兼容",
      path: "provider",
      expected: { agent_cli: input.agentCli ?? null, kind: "cli_provider_protocol_compatible" },
      observed: {
        candidates: cliCompatible.map((row) => ({
          credential_id: row.id,
          agent_cli: row.agent_cli,
          provider: row.provider,
        })),
      },
      next_action: "change_hub_provider_proposal_or_fix_credential_provider",
      category: "model_correctable",
    });
  }

  let pool = protocolCompatible.filter((row) => modelMatches(
    row.settings_config_json, row.agent_cli!, modelNeed, allowPassthrough,
  ));
  if (pool.length === 0) {
    throwResolve("provider_credential_no_match", {
      message: "项目授权目录内没有满足模型要求的 Provider 凭据",
      path: "model_ref",
      expected: {
        kind: "project_authorized_model",
        model_ref: modelNeed,
        sample: [...new Set(protocolCompatible.flatMap((row) =>
          extractModelsFromSettings(row.settings_config_json, row.agent_cli)))].slice(0, 12),
      },
      observed: { match_count: 0 },
      next_action: "enable_healthy_provider_credential_or_relax_model_requirements",
    });
  }
  const explicitCli = input.agentCli?.trim() || null;
  if (explicitCli) {
    const constrained = pool.filter((row) => row.agent_cli === explicitCli);
    if (constrained.length === 0) {
      throwResolve("provider_credential_cli_mismatch", {
        message: `项目授权目录内的 Provider 凭据均未独占绑定到角色 agent_cli=${explicitCli}`,
        path: "agent_cli",
        expected: { agent_cli: explicitCli, kind: "credential_pinned_to_this_cli" },
        observed: { candidates: pool.map((row) => ({ credential_id: row.id, agent_cli: row.agent_cli })) },
        next_action: "enable_credential_pinned_to_role_cli_or_change_project_default_credential",
        category: "permanent_failure",
      });
    }
    pool = constrained;
  } else if (new Set(pool.map((row) => row.agent_cli)).size > 1) {
    const preference = input.allowlist.default_agent_cli ?? (input.preferredAgentCli?.trim() || null);
    const preferred = preference ? pool.filter((row) => row.agent_cli === preference) : [];
    if (preferred.length > 0) pool = preferred;
  }

  const beforeHealth = pool;
  // An unprobed account remains usable under the existing configuration contract.
  // A completed failed probe is a temporary candidate exclusion, never permission repair.
  pool = pool.filter(row => !credentialHealthUnavailable(row));
  const frozenUnhealthy = beforeHealth.some(row => row.id === input.existingCredentialId && credentialHealthUnavailable(row));
  if (pool.length === 0 || frozenUnhealthy) throwResolve("provider_credential_health_unavailable", {
    message: frozenUnhealthy ? "原冻结账号的健康检查失败；请修复连接后重试" : "当前授权候选的健康检查均失败；请检查连接后重试",
    path: "credential", expected: { kind: "credential_without_failed_health_probe" },
    observed: { unavailable_count: beforeHealth.filter(credentialHealthUnavailable).length }, next_action: "check_provider_health_and_retry",
    category: "transient_retryable",
  });
  const selectedModels = new Map<string, string | null>();
  const modelErrors = new Map<string, ModelCatalogMismatchError>();
  if (input.selectModel) {
    for (const row of pool) {
      try {
        selectedModels.set(row.id, input.selectModel(row));
      } catch (error) {
        if (!(error instanceof ModelCatalogMismatchError)) throw error;
        modelErrors.set(row.id, error);
      }
    }
    const frozenModelError = modelErrors.get(input.existingCredentialId ?? "");
    if (frozenModelError) throw frozenModelError;
    pool = pool.filter(row => !modelErrors.has(row.id));
    if (pool.length === 0) throw modelErrors.values().next().value!;
  }
  const defaultId = input.allowlist.default_credential_id;
  const preferred = pool.find(row => row.id === defaultId);
  const existing = pool.find(row => row.id === input.existingCredentialId);
  const models = new Map(pool.map(row => {
    const selectedModel = input.selectModel ? selectedModels.get(row.id) : modelNeed;
    const requested = resolveRequestedModel({ roleModel: selectedModel, agentCli: row.agent_cli!,
      settingsConfig: row.settings_config_json, includeCliDefault: true });
    const cliModel = requested && row.agent_cli === "pi"
      ? resolveCredentialModelRef(row.settings_config_json, row.agent_cli, requested) : requested;
    return [row.id, cliModel ? bareUpstreamModelId(resolveEffectiveModel({
      roleModel: cliModel, agentCli: row.agent_cli!, settingsConfig: row.settings_config_json,
    })) : null];
  }));
  const identities = pool.map(row => models.get(row.id)
    ? JSON.stringify([row.provider, row.agent_cli, models.get(row.id)]) : null);
  const homogeneous = input.projectId && input.allowlist.credential_ids_configured
    && identities.every(identity => identity !== null) && new Set(identities).size === 1;
  if (pool.length > 1 && !homogeneous && !preferred && !existing) {
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

  let capacities: Map<string, CredentialCapacity>;
  try {
    capacities = await readCredentialCapacities(input.db, pool.map(row => ({ ...row, model: models.get(row.id) ?? null })), input.existingJobId);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "provider_credential_occupancy_unknown") throw error;
    throwResolve("provider_credential_load_unknown", { message: "凭据运行占用无法确认；请核对当前账本",
      path: "credential", expected: { kind: "known_running_occupancy" }, observed: { kind: "invalid_counts" },
      next_action: "inspect_current_job_history", category: "permanent_failure" });
  }
  // Recovery must wait for its own identity. Only an explicit homogeneous pool rotates new Jobs.
  let selectable = pool;
  if (existing) selectable = [existing];
  else if (!homogeneous && preferred) selectable = [preferred];
  const select = (row: ResolvedProviderCredential, reason: CredentialSelection["reason"]): ResolvedProviderCredential => ({
    ...row, selection: { schema: "deepsonar.credential-selection/v1", observed_at: new Date().toISOString(),
      selected_credential_id: row.id, reason,
      error_code: reason === "capacity_wait" ? "provider_credential_all_at_capacity" : null,
      candidates: beforeHealth.map(candidate => ({ credential_id: candidate.id, health: candidate.health_status,
        health_error_category: candidate.health_error_category ?? null,
        skipped: credentialHealthUnavailable(candidate) ? "health_error"
          : modelErrors.has(candidate.id) ? "model_incompatible"
          : !selectable.some(allowed => allowed.id === candidate.id) ? "identity_not_selected"
          : capacities.get(candidate.id)?.blocked_by.length ? "at_capacity" : null,
        capacity: capacities.get(candidate.id) ?? null })),
    },
  });
  const withRoom = selectable.filter(row => capacities.get(row.id)!.blocked_by.length === 0);
  if (existing && withRoom.includes(existing)) return select(existing, "existing");
  if (withRoom.length === 1) {
    const chosen = withRoom[0]!;
    return select(chosen, chosen.id === preferred?.id ? "default" : pool.length === 1 ? "single" : "capacity");
  }
  const loads = withRoom.length > 1 ? await input.db`SELECT agent_snapshot_json->>'credential_id' AS credential_id,
    count(*) FILTER (WHERE status IN ('pending','claimed','provisioning','running','waiting_human')) AS assigned_jobs,
    count(*) AS total_jobs FROM jobs WHERE project_id=${input.projectId}
    AND agent_snapshot_json->>'credential_id'=ANY(${pool.map(row => row.id)}::text[])
    GROUP BY agent_snapshot_json->>'credential_id'` as Array<{ credential_id: string; assigned_jobs: unknown; total_jobs: unknown }> : [];
  const counts = new Map<string, { assigned: number; total: number }>();
  for (const load of loads) {
    const assigned = Number(load.assigned_jobs), total = Number(load.total_jobs);
    if (![assigned, total].every(value => Number.isSafeInteger(value) && value >= 0) || total < assigned) {
      throwResolve("provider_credential_load_unknown", { message: "凭据分配负载无法确认；请重试或核对当前账本",
        path: "credential", expected: { kind: "known_project_job_counts" }, observed: { kind: "invalid_counts" },
        next_action: "inspect_current_job_history", category: "permanent_failure" });
    }
    counts.set(load.credential_id, { assigned, total });
  }
  const ranked = [...withRoom].sort((a, b) => capacities.get(b.id)!.room_ratio - capacities.get(a.id)!.room_ratio
    || capacities.get(a.id)!.credential.in_use - capacities.get(b.id)!.credential.in_use
    || (counts.get(a.id)?.total ?? 0) - (counts.get(b.id)?.total ?? 0)
    || (counts.get(a.id)?.assigned ?? 0) - (counts.get(b.id)?.assigned ?? 0)
    || Number(b.id === defaultId) - Number(a.id === defaultId)
    || a.id.localeCompare(b.id));
  if (ranked[0]) return select(ranked[0], ranked[0].id === defaultId ? "default" : "capacity");
  if (input.allowCapacityWait) {
    const waiting = existing ?? preferred ?? [...selectable].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    return select(waiting, "capacity_wait");
  }
  throwResolve("provider_credential_all_at_capacity", {
    message: "所有符合当前要求的授权凭据都已达到并发上限；请等待运行名额释放",
    path: "credential", expected: { kind: "available_provider_credential_model_capacity" },
    observed: { candidate_count: selectable.length }, next_action: "wait_for_provider_capacity",
    category: "transient_retryable",
  });
}
