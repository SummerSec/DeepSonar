import { parseDshPiAiSettings, readOfficialLlmPiAiSettings } from "@deepsonar/runtime-sandbox";
import { normalizeModelCatalog } from "./credentials.js";
import {
  admitModelAgainstCatalog,
  type ModelCatalogAdmitCode,
} from "./domains/provider-adapter/model-catalog-admit.js";
import type { RepairFeedback } from "@deepsonar/shared-types";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Snapshot marker when RoleConfig/settings leave model empty and the CLI builtin is used. */
export const CLI_DEFAULT_MODEL_PREFIX = "cli-default:" as const;

/**
 * Built-in model each Agent CLI uses when RoleConfig and settings leave model empty.
 * Keep in sync with the governed CLI pin (Claude Code 2.1.258 → claude-opus-5).
 */
export const AGENT_CLI_BUILTIN_DEFAULT_MODELS: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "claude-opus-5",
});

export function agentCliBuiltinDefaultModel(agentCli: string): string | null {
  const model = AGENT_CLI_BUILTIN_DEFAULT_MODELS[agentCli];
  return model?.trim() || null;
}

export function formatCliDefaultUpstreamModel(cliDefaultName: string): string {
  const name = cliDefaultName.trim();
  if (!name) return `${CLI_DEFAULT_MODEL_PREFIX}unknown`;
  if (name.startsWith(CLI_DEFAULT_MODEL_PREFIX)) return name;
  return `${CLI_DEFAULT_MODEL_PREFIX}${name}`;
}

/** Strip `cli-default:` for wire/auth/concurrency; leave other IDs unchanged. */
export function bareUpstreamModelId(upstreamModel: string | null | undefined): string | null {
  const raw = typeof upstreamModel === "string" ? upstreamModel.trim() : "";
  if (!raw) return null;
  if (raw.startsWith(CLI_DEFAULT_MODEL_PREFIX)) {
    const bare = raw.slice(CLI_DEFAULT_MODEL_PREFIX.length).trim();
    return bare || null;
  }
  return raw;
}

export function isCliDefaultUpstreamModel(upstreamModel: string | null | undefined): boolean {
  const raw = typeof upstreamModel === "string" ? upstreamModel.trim() : "";
  return raw.startsWith(CLI_DEFAULT_MODEL_PREFIX);
}

export function extractModelFromSettings(agentCli: string, settingsConfig: unknown): string | null {
  const settings = asObject(settingsConfig);
  if (agentCli === "claude-code") {
    const env = asObject(settings.env);
    for (const model of [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_SMALL_FAST_MODEL,
    ]) {
      if (typeof model === "string" && model.trim()) return model.trim();
    }
    return null;
  }
  if (agentCli === "codex") {
    const config = typeof settings.config === "string" ? settings.config : "";
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(config);
    return match?.[1] || match?.[2] || null;
  }
  if (agentCli === "pi") {
    const official = readOfficialLlmPiAiSettings(settingsConfig);
    if (official?.defaultModel) return official.defaultModel;
    const providers = asObject(settings.providers);
    const providerEntries = Object.keys(providers).length > 0
      ? Object.values(providers)
      : [settings];
    for (const rawProvider of providerEntries) {
      const provider = asObject(rawProvider);
      const models = provider.models;
      if (Array.isArray(models)) {
        const model = models.find((item) => {
          const id = asObject(item).id;
          return typeof id === "string" && id.trim();
        });
        const id = asObject(model).id;
        if (typeof id === "string" && id.trim()) return id.trim();
      } else {
        const modelId = Object.keys(asObject(models)).find((id) => id.trim());
        if (modelId) return modelId.trim();
      }
    }
    return null;
  }
  if (agentCli === "dsh") return parseDshPiAiSettings(settingsConfig).modelIds[0] ?? null;
  const modelIds = Object.keys(asObject(settings.models));
  return modelIds.find((model) => model.trim())?.trim() ?? null;
}

export type ModelResolutionSource = "role" | "settings" | "cli_default" | "none";

export function resolveRequestedModel(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
  /** When true, fall back to the Agent CLI builtin default after settings. */
  includeCliDefault?: boolean;
}): string | null {
  const override = input.roleModel?.trim();
  if (override) return override;
  const fromSettings = extractModelFromSettings(input.agentCli, input.settingsConfig);
  if (fromSettings) return fromSettings;
  if (input.includeCliDefault) return agentCliBuiltinDefaultModel(input.agentCli);
  return null;
}

export function resolveModelSource(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
}): ModelResolutionSource {
  if (input.roleModel?.trim()) return "role";
  if (extractModelFromSettings(input.agentCli, input.settingsConfig)) return "settings";
  if (agentCliBuiltinDefaultModel(input.agentCli)) return "cli_default";
  return "none";
}

/** Resolve the model ID that the upstream gateway will actually receive. */
export function resolveEffectiveModel(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
  includeCliDefault?: boolean;
}): string | null {
  const requested = resolveRequestedModel(input);
  if (!requested || input.agentCli !== "claude-code") return requested;

  const env = asObject(asObject(input.settingsConfig).env);
  const aliasKey = ({
    fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
    sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  } as const)[requested.toLowerCase() as "fable" | "sonnet" | "opus" | "haiku"];
  if (!aliasKey) return requested;
  const mapped = env[aliasKey];
  if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  const main = env.ANTHROPIC_MODEL;
  return typeof main === "string" && main.trim() ? main.trim() : requested;
}

/**
 * Runtime wire ID from a frozen snapshot.
 * Strips `cli-default:` so concurrency gates and Gateway outbound rewrite get a real model id.
 */
export function snapshotUpstreamModel(snapshot: { model?: unknown; upstream_model?: unknown }): string | null {
  const upstream = typeof snapshot.upstream_model === "string" ? snapshot.upstream_model.trim() : "";
  if (upstream) return bareUpstreamModelId(upstream);
  const requested = typeof snapshot.model === "string" ? snapshot.model.trim() : "";
  return requested || null;
}

export class ModelCatalogMismatchError extends Error {
  /** Prefer #632 codes; MODEL_CATALOG_MISMATCH kept as legacy alias for older catches. */
  readonly code: ModelCatalogAdmitCode | "MODEL_CATALOG_MISMATCH";
  readonly resolvedModel: string;
  readonly catalog: string[];
  readonly repair: RepairFeedback;
  constructor(
    message: string,
    resolvedModel: string,
    catalog: string[],
    repair: RepairFeedback,
    code: ModelCatalogAdmitCode | "MODEL_CATALOG_MISMATCH" = "MODEL_CATALOG_MISMATCH",
  ) {
    super(message);
    this.name = "ModelCatalogMismatchError";
    this.code = code;
    this.resolvedModel = resolvedModel;
    this.catalog = catalog;
    this.repair = repair;
  }
}

/** True when the model (or its bare cli-default form) appears in the credential catalog. */
export function modelMatchesCredentialCatalog(
  model: string | null | undefined,
  catalogJson: unknown,
): boolean {
  const catalog = normalizeModelCatalog(catalogJson);
  if (catalog.length === 0) return false;
  const bare = bareUpstreamModelId(model) ?? (typeof model === "string" ? model.trim() : "");
  if (!bare) return false;
  return catalog.includes(bare);
}

/**
 * Fail-closed when a non-empty account-configured model allowlist does not contain the resolved model (#656).
 * Empty allowlist soft-degrades (no configured provider model ids yet) and skips the gate.
 * `allowPassthrough` opts out of the configured allowlist for explicit alias-gateway deployments.
 */
export function assertResolvedModelInCredentialCatalog(input: {
  resolvedModel: string | null;
  catalogJson: unknown;
  allowPassthrough: boolean;
  modelSource: ModelResolutionSource;
}): void {
  const admitted = admitModelAgainstCatalog({
    resolvedModel: input.resolvedModel,
    catalogJson: input.catalogJson,
    allowPassthrough: input.allowPassthrough,
    operation: "assert_resolved_model_in_credential_catalog",
    modelSourceHint: input.modelSource === "none" ? "unknown" : input.modelSource,
    // Explicit RoleConfig/settings model outside configured allowlist → passthrough-disabled framing.
    emphasizePassthrough: input.modelSource === "role" || input.modelSource === "settings",
  });
  if (admitted.ok) return;
  throw new ModelCatalogMismatchError(
    admitted.repair.message,
    admitted.resolved,
    admitted.catalog,
    admitted.repair,
    admitted.code,
  );
}

/** null = catalog empty/unknown; boolean = explicit match against non-empty catalog. */
export function modelCatalogMatchForRequest(model: string | null | undefined, catalogJson: unknown): boolean | null {
  const catalog = normalizeModelCatalog(catalogJson);
  if (catalog.length === 0) return null;
  return modelMatchesCredentialCatalog(model, catalog);
}

