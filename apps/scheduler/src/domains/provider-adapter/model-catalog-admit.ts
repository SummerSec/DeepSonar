import {
  buildRepairFeedback,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import { normalizeModelCatalog } from "../../credentials.js";

/** Stable codes for model-catalog SSOT failures (#632). */
/** Local normalize: cli-default: + trailing [Nm] (keep free of gateway-guard import cycle). */
function bareUpstreamModelId(upstreamModel: string | null | undefined): string | null {
  const raw = typeof upstreamModel === "string" ? upstreamModel.trim() : "";
  if (!raw) return null;
  let id = raw;
  if (id.startsWith("cli-default:")) id = id.slice("cli-default:".length).trim();
  id = id.replace(/\[[0-9]+m\]$/i, "").trim();
  return id || null;
}

export const MODEL_NOT_IN_CATALOG = "model_not_in_catalog" as const;
export const MODEL_PASSTHROUGH_DISABLED = "model_passthrough_disabled" as const;
export const MODEL_ALLOWLIST_UNCONFIGURED = "model_allowlist_unconfigured" as const;

export type ModelCatalogAdmitCode =
  | typeof MODEL_NOT_IN_CATALOG
  | typeof MODEL_PASSTHROUGH_DISABLED
  | typeof MODEL_ALLOWLIST_UNCONFIGURED;

export type ModelCatalogAdmitResult =
  | { ok: true; resolved: string; catalog: string[] }
  | {
      ok: false;
      code: ModelCatalogAdmitCode;
      resolved: string;
      catalog: string[];
      repair: RepairFeedback;
    };

function catalogPreview(catalog: readonly string[]): { options: string; more: string } {
  const options = catalog.slice(0, 30).join("、");
  const more = catalog.length > 30 ? ` 等 ${catalog.length} 个` : "";
  return { options, more };
}

/**
 * Admit a resolved model id against the account-configured model allowlist
 * (settings_config_json / extractModelsFromSettings), NOT probed model_catalog_json (#656).
 * Empty allowlist: soft-degrade only when no explicit RoleConfig/requested model was set;
 * an explicit model with empty account models fail-fasts (#679).
 * Passthrough skips the configured-allowlist gate for emergency alias gateways only.
 */
export function admitModelAgainstCatalog(input: {
  resolvedModel: string | null | undefined;
  catalogJson: unknown;
  allowPassthrough: boolean;
  operation?: string;
  /** When true, prefer model_passthrough_disabled (explicit non-catalog request). */
  emphasizePassthrough?: boolean;
  modelSourceHint?: "cli_default" | "role" | "settings" | "project" | "hub" | "unknown";
}): ModelCatalogAdmitResult {
  const operation = input.operation ?? "admit_model_against_catalog";
  const catalog = normalizeModelCatalog(input.catalogJson);
  const resolved =
    bareUpstreamModelId(input.resolvedModel)
    ?? (typeof input.resolvedModel === "string" ? input.resolvedModel.trim() : "");
  const source = input.modelSourceHint ?? "unknown";
  const explicitRequested = Boolean(resolved)
    && (source === "role" || source === "settings" || source === "project" || source === "hub"
      || input.emphasizePassthrough === true);

  if (input.allowPassthrough) {
    return { ok: true, resolved, catalog };
  }
  if (catalog.length === 0) {
    if (!explicitRequested) {
      return { ok: true, resolved, catalog };
    }
    const message = resolved
      ? `角色/请求已指定模型 ${resolved}，但 Provider 账号尚未配置 models[].id（或该 Agent CLI 方言对应的模型字段）；请先在凭据 settings 填写模型名单，或仅在 alias 网关应急时开启 allow_model_catalog_passthrough`
      : "角色/请求已指定模型，但 Provider 账号尚未配置 models[].id；请先在凭据 settings 填写模型名单";
    return {
      ok: false,
      code: MODEL_ALLOWLIST_UNCONFIGURED,
      resolved,
      catalog,
      repair: buildRepairFeedback({
        category: "model_correctable",
        code: MODEL_ALLOWLIST_UNCONFIGURED,
        operation,
        path: "model_ref",
        message,
        expected: {
          kind: "account_configured_model_id",
          catalog_size: 0,
          sample: [],
          allow_model_catalog_passthrough: false,
        },
        observed_shape: {
          resolved_model: resolved || null,
          model_source: source,
          in_configured_allowlist: false,
          passthrough: false,
          account_models_empty: true,
        },
        next_action: "fill_provider_account_models_then_retry",
      }),
    };
  }
  if (resolved && catalog.includes(resolved)) {
    return { ok: true, resolved, catalog };
  }

  const { options, more } = catalogPreview(catalog);
  const code: ModelCatalogAdmitCode = input.emphasizePassthrough === true
    ? MODEL_PASSTHROUGH_DISABLED
    : MODEL_NOT_IN_CATALOG;

  let message: string;
  if (!resolved) {
    message = `角色未指定 model，且无法解析 CLI/配置默认模型；账号已配置模型名单非空，可选项：${options}${more}。请在 Provider 账号填写 provider 模型 id`;
  } else if (source === "cli_default") {
    message = `角色未指定 model，CLI 默认 ${resolved} 不在账号已配置模型名单，可选项：${options}${more}。请在账号 settings 填写该模型 id，或开启已配置名单应急直通`;
  } else {
    message = `解析模型 ${resolved} 不在账号已配置的 provider 模型名单（选模 SSOT；应急直通已关闭），可选项：${options}${more}`;
  }

  return {
    ok: false,
    code,
    resolved,
    catalog,
    repair: buildRepairFeedback({
      category: "model_correctable",
      code,
      operation,
      path: "model_ref",
      message,
      expected: {
        kind: "account_configured_model_id",
        catalog_size: catalog.length,
        sample: catalog.slice(0, 12),
        allow_model_catalog_passthrough: false,
      },
      observed_shape: {
        resolved_model: resolved || null,
        model_source: source,
        in_configured_allowlist: false,
        passthrough: false,
      },
      next_action: resolved
        ? "select_account_configured_model_id_or_enable_emergency_passthrough"
        : "set_role_or_project_default_model_from_account_configured_ids",
    }),
  };
}



/** Build RepairFeedback for Gateway frozen-model reject (adapter-layer contract). */
export function gatewayFrozenModelRepair(input: {
  requestModel: string;
  allowed: readonly string[];
}): RepairFeedback {
  return buildRepairFeedback({
    category: "permanent_failure",
    code: MODEL_NOT_IN_CATALOG,
    operation: "gateway.assert_frozen_model",
    path: "request.model",
    message: `Gateway 拒绝未冻结模型 ${input.requestModel}；Job 仅允许：${input.allowed.slice(0, 12).join("、")}`,
    expected: {
      kind: "frozen_provider_model_contract",
      allowed: input.allowed.slice(0, 24),
    },
    observed_shape: { request_model: input.requestModel },
    next_action: "use_job_frozen_model_or_recreate_job_with_catalog_model",
  });
}
