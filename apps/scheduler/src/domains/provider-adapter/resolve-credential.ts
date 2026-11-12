/**
 * #690: Resolve a kernel-held LLM credential for Job create from project-authorized
 * Provider plugins + Hub capability needs. Hub never submits credential/account IDs;
 * RoleConfig.role_credentials is gone — no dual-read / fallback.
 */
import { buildRepairFeedback, isCurrentAgentCli, type RepairFeedback } from "@deepsonar/shared-types";
import { credentialConcurrencyPolicy, validateCredentialCompatibility } from "../../credentials.js";
import { extractModelsFromSettings, resolveEffectiveModel, resolvePiCliModelSelection } from "../../provider-settings.js";
import type { ProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";

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

  // #707/#1078: default_credential_id 只在 pool 内查找，不再侧路回退到 candidates；
  // 它是同条件下的优先项，不是一票决定 —— 达到自身并发上限时让位给仍有余量的同身份候选。
  const defaultId = input.allowlist.default_credential_id;
  const preferred = defaultId ? pool.find((row) => row.id === defaultId) : undefined;

  if (pool.length === 1) return pool[0]!;

  // Recovery does not rotate keys because another Job changed the load. The
  // old identity is only a preference within current authorization/model/CLI
  // constraints; an explicit configured default still takes precedence.
  const existing = input.existingCredentialId ? pool.find(row => row.id === input.existingCredentialId) : undefined;

  const identities = pool.map(row => {
    const models = extractModelsFromSettings(row.settings_config_json, row.agent_cli!);
    const model = modelNeed ? resolveCredentialModelRef(row.settings_config_json, row.agent_cli!, modelNeed)
      : models.length === 1 ? models[0] : null;
    return model ? JSON.stringify([row.provider, row.agent_cli, model]) : null;
  });
  if (input.projectId && input.allowlist.credential_ids_configured && identities.every(identity => identity !== null)
    && new Set(identities).size === 1) {
    // Readiness does not consume a turn or mutate an allocation ledger. Each
    // creation freezes its selected identity; load is a projection of the
    // existing same-project Jobs, not credential quota or a retry permission.
    const loads = await input.db`SELECT agent_snapshot_json->>'credential_id' AS credential_id,
      count(*) FILTER (WHERE status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_jobs,
      count(*) AS total_jobs FROM jobs WHERE project_id=${input.projectId}
      AND agent_snapshot_json->>'credential_id'=ANY(${pool.map(row => row.id)}::text[])
      GROUP BY agent_snapshot_json->>'credential_id'` as Array<{ credential_id: string; active_jobs: unknown; total_jobs: unknown }>;
    const counts = new Map<string, { active: number; total: number }>();
    for (const load of loads) {
      const active = Number(load.active_jobs), total = Number(load.total_jobs);
      if (!Number.isSafeInteger(active) || !Number.isSafeInteger(total) || active < 0 || total < active) {
        throwResolve("provider_credential_load_unknown", { message: "凭据 Job 负载无法确认；请重试或核对当前账本",
          path: "credential", expected: { kind: "known_same_project_job_counts" }, observed: { kind: "invalid_counts" },
          next_action: "inspect_current_job_history", category: "permanent_failure" });
      }
      counts.set(load.credential_id, { active, total });
    }
    // #1078 切片 1：并发余量来自 metadata.max_concurrent 与同一负载投影，
    // 只用于偏好排序：先余量比例、后在途数、再历史总量，缺省与凭据 ID 只作并列裁决；
    // 不占位、不放宽授权，也不改变准入判定（未设置视为不限）。
    const score = (row: (typeof pool)[number]): { room: number; active: number; total: number } => {
      const limit = credentialConcurrencyPolicy(row.meta_json).maxConcurrent;
      const active = counts.get(row.id)?.active ?? 0;
      const total = counts.get(row.id)?.total ?? 0;
      const room = limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - active);
      return { room, active, total };
    };
    const ratio = (row: (typeof pool)[number]): number => {
      const limit = credentialConcurrencyPolicy(row.meta_json).maxConcurrent;
      const { room } = score(row);
      if (limit === null) return 1;
      return limit === 0 ? 0 : room / limit;
    };
    // 并列裁决顺序：#707/#1002 的显式缺省先于 #1002 的恢复身份，再退回 ID 稳定序。
    const tieBreak = (a: (typeof pool)[number], b: (typeof pool)[number]): number =>
      Number(b.id === preferred?.id) - Number(a.id === preferred?.id)
        || Number(b.id === existing?.id) - Number(a.id === existing?.id);
    const byCapacity = (a: (typeof pool)[number], b: (typeof pool)[number]): number =>
      ratio(b) - ratio(a) || tieBreak(a, b)
        || score(a).active - score(b).active || score(a).total - score(b).total || a.id.localeCompare(b.id);
    const withRoom = pool.filter((row) => score(row).room > 0);
    const best = [...withRoom].sort(byCapacity)[0];
    if (best) return best;
    // 全部满额时保持既有行为：缺省优先，其次恢复身份，最后沿用容量排序，不新增失败码。
    if (preferred) return preferred;
    if (existing) return existing;
    return [...pool].sort(byCapacity)[0];
  }

  // 非单一身份（含跨 provider）与未显式授权白名单的场景保持原语义；跨 provider 候选等价
  // 判据仍待 #1078 的明确决策，不在本切片内放开。
  if (preferred) return preferred;
  if (existing) return existing;

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
