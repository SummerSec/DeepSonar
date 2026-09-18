import type { CurrentAgentCli } from "@deepsonar/shared-types";
import { CREDENTIAL_MODEL_ID_MAX_LENGTH, normalizeModelCatalog } from "../../credentials.js";
import {
  compatibleAgentClisForProvider,
  type ProjectAgentAllowlist,
} from "../project-agent-allowlist/policy.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Strip `cli-default:` for allowlist compare (mirrors provider-effective-model.bareUpstreamModelId). */
function bareModelId(modelId: string | null | undefined): string {
  const raw = typeof modelId === "string" ? modelId.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("cli-default:")) return raw.slice("cli-default:".length).trim();
  return raw;
}

export interface ProjectModelPolicy {
  /** true once enabled_model_ids 已显式落库（含首次 PATCH）。未配置前不按项目模型白名单 fail-closed。 */
  configured: boolean;
  enabled_model_ids: string[];
  /** Hub / Role 省略 model 时的软缺省；必须 ∈ 白名单。 */
  default_model_id: string | null;
  /** 缺省不可用时的有序回退；各项必须 ∈ 白名单。 */
  fallback_model_ids: string[];
}

export interface HubModelCatalogEntry {
  model_id: string;
  display_name: string;
  provider: string;
  credential_id: string;
  credential_name: string;
  compatible_agent_clis: CurrentAgentCli[];
  is_default: boolean;
  is_fallback: boolean;
  fallback_rank: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || model.length > CREDENTIAL_MODEL_ID_MAX_LENGTH || CONTROL_CHARACTER.test(model)) return null;
  return model;
}

function parseModelIdList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const model = normalizeModelId(item);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function parseOptionalModelId(value: unknown): string | null {
  return normalizeModelId(value);
}

/**
 * 读取项目 config_json 中的模型白名单 / 缺省 / fallback。
 * 缺键 = 尚未配置（configured=false）；显式保存后才 fail-closed。
 */
export function parseProjectModelPolicy(value: unknown): ProjectModelPolicy {
  const cfg = asRecord(value);
  const models = parseModelIdList(cfg.enabled_model_ids);
  const configured = models !== null;
  const enabled_model_ids = models ?? [];
  let default_model_id = parseOptionalModelId(cfg.default_model_id);
  let fallback_model_ids = parseModelIdList(cfg.fallback_model_ids) ?? [];
  if (default_model_id && enabled_model_ids.length > 0 && !enabled_model_ids.includes(default_model_id)) {
    default_model_id = null;
  }
  if (enabled_model_ids.length > 0) {
    fallback_model_ids = fallback_model_ids.filter((id) => enabled_model_ids.includes(id));
  }
  return { configured, enabled_model_ids, default_model_id, fallback_model_ids };
}

export interface ModelPolicyBindingSeed {
  model_ids: string[];
}

/**
 * 可选迁移：从未配置迁到 RoleConfig / 凭据目录已见模型集合。
 * 仅在尚未 configured 时落库；已显式配置则不改写。
 * 默认 GET 不自动调用，避免把大目录静默标为 configured；显式种子路径可调用。
 */
export function seedProjectModelPolicy(
  cfg: Record<string, unknown>,
  seed: ModelPolicyBindingSeed,
): { changed: boolean; policy: ProjectModelPolicy } {
  const current = parseProjectModelPolicy(cfg);
  if (current.configured) return { changed: false, policy: current };

  const seen = new Set<string>();
  const models: string[] = [];
  for (const raw of seed.model_ids) {
    const model = normalizeModelId(raw);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  if (models.length === 0) return { changed: false, policy: current };

  cfg.enabled_model_ids = models;
  if (models.length === 1) cfg.default_model_id = models[0];
  else delete cfg.default_model_id;
  delete cfg.fallback_model_ids;
  return { changed: true, policy: parseProjectModelPolicy(cfg) };
}

/** PATCH 校验并写回；缺省 / fallback 必须来自白名单。 */
export function applyProjectModelPolicyPatch(
  cfg: Record<string, unknown>,
  patch: {
    enabled_model_ids?: string[];
    default_model_id?: string | null;
    fallback_model_ids?: string[];
  },
): ProjectModelPolicy {
  if (patch.enabled_model_ids !== undefined) {
    const models = parseModelIdList(patch.enabled_model_ids) ?? [];
    if (models.length === 0) throw new Error("至少启用一个模型（enabled_model_ids 不能为空）");
    cfg.enabled_model_ids = models;
  }
  if (patch.default_model_id !== undefined) {
    if (patch.default_model_id === null) delete cfg.default_model_id;
    else {
      const model = normalizeModelId(patch.default_model_id);
      if (!model) throw new Error(`缺省模型非法: ${String(patch.default_model_id)}`);
      cfg.default_model_id = model;
    }
  }
  if (patch.fallback_model_ids !== undefined) {
    cfg.fallback_model_ids = parseModelIdList(patch.fallback_model_ids) ?? [];
  }

  if (!Object.prototype.hasOwnProperty.call(cfg, "enabled_model_ids")) {
    throw new Error("请先设置 enabled_model_ids 以启用项目模型策略");
  }

  const enabled = parseModelIdList(cfg.enabled_model_ids) ?? [];
  if (enabled.length === 0) throw new Error("至少启用一个模型（enabled_model_ids 不能为空）");

  const requestedDefault = parseOptionalModelId(cfg.default_model_id);
  const requestedFallback = parseModelIdList(cfg.fallback_model_ids) ?? [];

  if (patch.default_model_id !== undefined && patch.default_model_id !== null) {
    if (!requestedDefault || !enabled.includes(requestedDefault)) {
      throw new Error("缺省模型必须属于已启用白名单");
    }
  }
  if (patch.fallback_model_ids !== undefined) {
    for (const id of requestedFallback) {
      if (!enabled.includes(id)) throw new Error(`fallback 模型必须属于已启用白名单: ${id}`);
    }
  }

  if (requestedDefault && !enabled.includes(requestedDefault)) delete cfg.default_model_id;
  cfg.fallback_model_ids = requestedFallback.filter((id) => enabled.includes(id));
  if ((cfg.fallback_model_ids as string[]).length === 0) delete cfg.fallback_model_ids;

  return parseProjectModelPolicy(cfg);
}

export function assertModelAllowlisted(
  policy: ProjectModelPolicy,
  modelId: string | null | undefined,
): void {
  if (!policy.configured) return;
  const bare = bareModelId(modelId);
  if (!bare) {
    throw new Error("项目已配置模型白名单，但未能解析到模型；请指定 model 或设置项目缺省模型");
  }
  if (!policy.enabled_model_ids.includes(bare)) {
    const options = policy.enabled_model_ids.slice(0, 30).join("、");
    const more = policy.enabled_model_ids.length > 30 ? ` 等 ${policy.enabled_model_ids.length} 个` : "";
    throw new Error(`model=${bare} 不在本项目已启用模型白名单内，可选项：${options}${more}`);
  }
}

/**
 * 软缺省选择：prefer 显式提案 → 项目 default → fallback 有序列表中第一个可用。
 * available 为当前凭据目录 ∩ 兼容集合；未配置策略时返回 prefer 原值。
 */
export function resolveSoftDefaultModel(input: {
  policy: ProjectModelPolicy;
  prefer?: string | null;
  available?: readonly string[] | null;
}): string | null {
  const prefer = typeof input.prefer === "string" ? input.prefer.trim() : "";
  if (prefer) return prefer;
  if (!input.policy.configured) return null;

  const available = input.available && input.available.length > 0
    ? new Set(input.available)
    : null;

  const candidates = [
    input.policy.default_model_id,
    ...input.policy.fallback_model_ids,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);

  for (const id of candidates) {
    if (available && !available.has(id)) continue;
    if (!input.policy.enabled_model_ids.includes(id)) continue;
    return id;
  }
  if (!available && input.policy.default_model_id) return input.policy.default_model_id;
  return null;
}

export function toHubModelCatalogEntries(input: {
  policy: ProjectModelPolicy;
  agentAllowlist: ProjectAgentAllowlist;
  credentials: Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    model_catalog_json?: unknown;
  }>;
}): HubModelCatalogEntry[] {
  const entries: HubModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const row of input.credentials) {
    if (row.status !== "active") continue;
    if (input.agentAllowlist.configured && !input.agentAllowlist.enabled_credential_ids.includes(row.id)) {
      continue;
    }
    const compatible = compatibleAgentClisForProvider(row.provider)
      .filter((cli) => !input.agentAllowlist.configured || input.agentAllowlist.enabled_agent_clis.includes(cli));
    if (compatible.length === 0) continue;

    const catalog = normalizeModelCatalog(row.model_catalog_json);
    for (const modelId of catalog) {
      if (input.policy.configured && !input.policy.enabled_model_ids.includes(modelId)) continue;
      const dedupeKey = `${row.id}:${modelId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const fallbackIdx = input.policy.fallback_model_ids.indexOf(modelId);
      entries.push({
        model_id: modelId,
        display_name: modelId,
        provider: row.provider,
        credential_id: row.id,
        credential_name: row.name,
        compatible_agent_clis: compatible,
        is_default: input.policy.default_model_id === modelId,
        is_fallback: fallbackIdx >= 0,
        fallback_rank: fallbackIdx >= 0 ? fallbackIdx : null,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    if (a.is_fallback !== b.is_fallback) return a.is_fallback ? -1 : 1;
    if (a.fallback_rank != null && b.fallback_rank != null && a.fallback_rank !== b.fallback_rank) {
      return a.fallback_rank - b.fallback_rank;
    }
    return a.model_id.localeCompare(b.model_id) || a.credential_id.localeCompare(b.credential_id);
  });
  return entries;
}
