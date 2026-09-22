/**
 * Model catalog health_status labels and UI helpers (#614 Web acceptance).
 *
 * Distinguish from credential connection probe health (`ok` / `error` /
 * `unknown` via `provider-health-dot`): catalog rows use ModelCatalogHealthStatus
 * from shared-types (verified | stale | probe_failed | unsupported | passthrough_allowed).
 */
import { isCurrentAgentCli } from "@deepsonar/shared-types";
import type { ModelCapabilityDescriptor, ProviderCredential } from "./api";

export const MODEL_CATALOG_HEALTH_LABEL: Record<string, string> = {
  verified: "已验证",
  stale: "目录过期",
  probe_failed: "探测失败",
  unsupported: "不支持",
  passthrough: "应急透传",
  passthrough_allowed: "应急透传",
};

export type ModelCatalogHealthTone = "ok" | "warn" | "danger" | "muted" | "passthrough";

/** Chinese label for ModelCatalogHealthStatus (and legacy aliases). */
export function modelCatalogHealthLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return MODEL_CATALOG_HEALTH_LABEL[status] ?? status;
}

/** Visual tone for badges — passthrough must never look like verified. */
export function modelCatalogHealthTone(status: string | null | undefined): ModelCatalogHealthTone {
  switch (status) {
    case "verified":
      return "ok";
    case "stale":
    case "unsupported":
      return "warn";
    case "probe_failed":
      return "danger";
    case "passthrough":
    case "passthrough_allowed":
      return "passthrough";
    default:
      return "muted";
  }
}

export function modelCatalogHealthBadgeClass(status: string | null | undefined): string {
  return `model-catalog-health-badge is-${modelCatalogHealthTone(status)}`;
}

/**
 * Prefer structured descriptors; fall back to legacy string catalog as stale rows
 * so operators still see something while structured catalog warms up.
 */
export function modelDescriptorsForCredential(
  credential: ProviderCredential | null | undefined,
): ModelCapabilityDescriptor[] {
  if (!credential) return [];
  const descriptors = credential.model_descriptors ?? credential.health?.model_descriptors ?? [];
  if (descriptors.length > 0) return descriptors;
  const legacy = [
    ...(credential.health?.model_catalog ?? []),
    ...(credential.model_catalog_json ?? []),
  ].filter((model): model is string => typeof model === "string" && model.trim().length > 0);
  return [...new Set(legacy.map((model) => model.trim()))].map((model) => ({
    schema: "deepsonar.model-descriptor/v1" as const,
    provider: credential.provider,
    model_id: model,
    display_name: model,
    context_window: null,
    max_output_tokens: null,
    supports_tools: true,
    supports_streaming: true,
    supports_structured_output: false,
    reasoning_efforts: [],
    input_modalities: ["text" as const],
    output_modalities: ["text" as const],
    cost: null,
    rate_limits: null,
    compatible_agent_clis: isCurrentAgentCli(credential.agent_cli) ? [credential.agent_cli] : [],
    health_status: "stale" as const,
    catalog_revision: credential.health?.model_catalog_fetched_at ?? "legacy",
  }));
}

/** One-line catalog health summary for credential list / detail. */
export function credentialCatalogHealthSummary(credential: ProviderCredential | null | undefined): string {
  if (!credential) return "探测目录未加载";
  const health = credential.health;
  if (health?.status === "error") {
    const category = health.error_category ? ` · ${health.error_category}` : "";
    return `上游目录探测失败${category}（仅诊断，不作为选模依据）`;
  }
  if (health?.status === "unknown" && !health.last_tested_at) return "尚未测试 / 未探测上游目录（选模以账号已填模型 id 为准）";
  const descriptors = modelDescriptorsForCredential(credential);
  if (descriptors.length === 0) return "上游目录为空（仅诊断；选模以账号已填模型 id 为准）";
  const statuses = [...new Set(descriptors.map((model) => model.health_status))].map(modelCatalogHealthLabel);
  const revision = descriptors.find((model) => model.catalog_revision)?.catalog_revision;
  const passthrough = descriptors.some((model) => model.health_status === "passthrough_allowed");
  return `上游探测 ${descriptors.length} 个 · ${statuses.join(" / ")}${passthrough ? " · 含应急透传" : ""}${revision ? ` · rev ${String(revision).slice(0, 12)}` : ""}（仅诊断，非选模 SSOT）`;
}

export function catalogHasPassthrough(credential: ProviderCredential | null | undefined): boolean {
  return modelDescriptorsForCredential(credential).some((model) => model.health_status === "passthrough_allowed");
}

export function catalogHasUnhealthy(credential: ProviderCredential | null | undefined): boolean {
  return modelDescriptorsForCredential(credential).some(
    (model) => model.health_status !== "verified",
  );
}

/** Frozen Job provider_model subset used by Job detail. */
export type FrozenProviderModelView = {
  passthrough?: boolean;
  catalog_revision?: string | null;
  cli_model_id?: string | null;
  upstream_model_id?: string | null;
  provider?: string | null;
  route_style?: string | null;
  adapter_id?: string | null;
  adapter_version?: string | null;
  model_descriptor?: {
    health_status?: string | null;
    display_name?: string | null;
    model_id?: string | null;
    catalog_revision?: string | null;
  } | null;
};

export function readFrozenProviderModel(snapshot: Record<string, unknown> | null | undefined): FrozenProviderModelView | null {
  if (!snapshot) return null;
  const raw = snapshot.provider_model;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as FrozenProviderModelView;
}

/** Operator-facing lines for Job 运行配置. */
export function formatFrozenProviderModelHealth(pm: FrozenProviderModelView | null | undefined): {
  healthLabel: string;
  healthStatus: string | null;
  passthrough: boolean;
  revision: string | null;
  warning: string | null;
} {
  if (!pm) {
    return {
      healthLabel: "未冻结 provider_model（旧 Job 或无 LLM）",
      healthStatus: null,
      passthrough: false,
      revision: null,
      warning: null,
    };
  }
  const healthStatus = pm.model_descriptor?.health_status ?? (pm.passthrough ? "passthrough_allowed" : null);
  const passthrough = pm.passthrough === true;
  const revision = pm.model_descriptor?.catalog_revision ?? pm.catalog_revision ?? null;
  let warning: string | null = null;
  if (passthrough) {
    warning = "本 Job 启用了已配置模型名单应急透传：未校验账号已填模型 id，请核对上游与权限。";
  } else if (healthStatus && healthStatus !== "verified") {
    warning = `冻结上游探测健康为「${modelCatalogHealthLabel(healthStatus)}」（仅观测，非选模依据）。`;
  }
  return {
    healthLabel: healthStatus ? modelCatalogHealthLabel(healthStatus) : "未标注",
    healthStatus,
    passthrough,
    revision: typeof revision === "string" ? revision : null,
    warning,
  };
}
