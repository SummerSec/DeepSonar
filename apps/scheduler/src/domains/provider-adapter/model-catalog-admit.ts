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
export const CREDENTIAL_BINDING_DEPRECATED = "credential_binding_deprecated" as const;

export type ModelCatalogAdmitCode =
  | typeof MODEL_NOT_IN_CATALOG
  | typeof MODEL_PASSTHROUGH_DISABLED;

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
 * Admit a resolved model id against a non-empty credential/provider catalog.
 * Empty catalog soft-degrades (probe may have failed). Passthrough skips the gate
 * for emergency alias gateways only.
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

  if (input.allowPassthrough) {
    return { ok: true, resolved, catalog };
  }
  if (catalog.length === 0) {
    return { ok: true, resolved, catalog };
  }
  if (resolved && catalog.includes(resolved)) {
    return { ok: true, resolved, catalog };
  }

  const { options, more } = catalogPreview(catalog);
  const source = input.modelSourceHint ?? "unknown";
  const code: ModelCatalogAdmitCode = input.emphasizePassthrough === true
    ? MODEL_PASSTHROUGH_DISABLED
    : MODEL_NOT_IN_CATALOG;

  let message: string;
  if (!resolved) {
    message = `角色未指定 model，且无法解析 CLI/配置默认模型；凭据模型目录非空，可选项：${options}${more}`;
  } else if (source === "cli_default") {
    message = `角色未指定 model，CLI 默认 ${resolved} 不在凭据模型目录，可选项：${options}${more}`;
  } else {
    message = `解析模型 ${resolved} 不在凭据模型目录（catalog SSOT；passthrough 已关闭），可选项：${options}${more}`;
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
        kind: "catalog_model_id",
        catalog_size: catalog.length,
        sample: catalog.slice(0, 12),
        allow_model_catalog_passthrough: false,
      },
      observed_shape: {
        resolved_model: resolved || null,
        model_source: source,
        in_catalog: false,
        passthrough: false,
      },
      next_action: resolved
        ? "select_catalog_model_id_or_enable_emergency_passthrough"
        : "set_role_or_project_default_model_from_catalog",
    }),
  };
}

/** Warning-only RepairFeedback when RoleConfig.credentials is still supplied (#632). */
export function credentialBindingDeprecatedWarning(input?: {
  operation?: string;
  bindingCount?: number;
}): RepairFeedback {
  return buildRepairFeedback({
    category: "model_correctable",
    code: CREDENTIAL_BINDING_DEPRECATED,
    operation: input?.operation ?? "role_config.upsert",
    path: "credentials",
    message:
      "RoleConfig.credentials 绑定已弃用：请改用平台凭据资源 + 项目 Agent/Provider 白名单（default_credential_id）；现有 role_credentials 行仍会被运行时尊重。",
    expected: {
      primary_surface: "project_agent_allowlist.default_credential_id",
      role_config_credentials: "deprecated",
    },
    observed_shape: {
      credentials_provided: true,
      binding_count: input?.bindingCount ?? null,
    },
    next_action: "prefer_project_allowlist_credential_and_omit_role_config_credentials",
  });
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
