import { z } from "zod";

/** Model/provider-owned reasoning profile token (mirrors shared ReasoningValue). */
const ReasoningValue = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** Pluggable Provider Adapter + structured Model Descriptor contract (#614 phase 1). */
export const PROVIDER_ADAPTER_SCHEMA = "deepsonar.provider-adapter/v1" as const;
export const MODEL_DESCRIPTOR_SCHEMA = "deepsonar.model-descriptor/v1" as const;
export const FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA = "deepsonar.provider-model-snapshot/v1" as const;

/**
 * Model catalog health. Fail-closed default: unknown / empty catalogs must not
 * be treated as `passthrough_allowed` — that status is an explicit opt-in only.
 */
export const ModelCatalogHealthStatus = z.enum([
  "verified",
  "stale",
  "probe_failed",
  "unsupported",
  "passthrough_allowed",
]);
export type ModelCatalogHealthStatus = z.infer<typeof ModelCatalogHealthStatus>;

/** Default when a catalog row has no explicit health — never passthrough. */
export const DEFAULT_MODEL_CATALOG_HEALTH: ModelCatalogHealthStatus = "unsupported";

export const ModelModality = z.enum(["text", "image", "audio", "video", "file"]);
export type ModelModality = z.infer<typeof ModelModality>;

export const ModelCostDescriptor = z
  .object({
    input_per_1m_usd: z.number().finite().nonnegative().nullable(),
    output_per_1m_usd: z.number().finite().nonnegative().nullable(),
    currency: z.literal("USD").default("USD"),
  })
  .strict();
export type ModelCostDescriptor = z.infer<typeof ModelCostDescriptor>;

export const ModelRateLimits = z
  .object({
    requests_per_minute: z.number().int().positive().nullable(),
    tokens_per_minute: z.number().int().positive().nullable(),
    max_concurrent: z.number().int().positive().nullable(),
  })
  .strict();
export type ModelRateLimits = z.infer<typeof ModelRateLimits>;

const AgentCli = z.enum(["claude-code", "pi", "dsh"]);
const ModelId = z.string().trim().min(1).max(200);
const ProviderId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_-]{0,79}$/);
const CatalogRevision = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);

/**
 * Structured model capability row. Hub / Scheduler selection should prefer these
 * fields over bare string model IDs (#614).
 */
export const ModelDescriptor = z
  .object({
    schema: z.literal(MODEL_DESCRIPTOR_SCHEMA),
    provider: ProviderId,
    model_id: ModelId,
    display_name: z.string().trim().min(1).max(200),
    context_window: z.number().int().min(1024).max(10_000_000).nullable(),
    max_output_tokens: z.number().int().min(1).max(10_000_000).nullable(),
    supports_tools: z.boolean(),
    supports_streaming: z.boolean(),
    supports_structured_output: z.boolean(),
    reasoning_efforts: z.array(ReasoningValue).max(32),
    input_modalities: z.array(ModelModality).min(1).max(8),
    output_modalities: z.array(ModelModality).min(1).max(8),
    cost: ModelCostDescriptor.nullable(),
    rate_limits: ModelRateLimits.nullable(),
    compatible_agent_clis: z.array(AgentCli).max(8),
    health_status: ModelCatalogHealthStatus,
    catalog_revision: CatalogRevision,
  })
  .strict();
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/** Frozen Model Descriptor subset written into Job `agent_snapshot_json` (#614). */
export const FrozenModelDescriptor = z
  .object({
    schema: z.literal(MODEL_DESCRIPTOR_SCHEMA),
    provider: ProviderId,
    model_id: ModelId,
    display_name: z.string().trim().min(1).max(200),
    context_window: z.number().int().min(1024).max(10_000_000).nullable(),
    max_output_tokens: z.number().int().min(1).max(10_000_000).nullable(),
    supports_tools: z.boolean(),
    supports_streaming: z.boolean(),
    supports_structured_output: z.boolean(),
    reasoning_efforts: z.array(ReasoningValue).max(32),
    input_modalities: z.array(ModelModality).max(8),
    output_modalities: z.array(ModelModality).max(8),
    compatible_agent_clis: z.array(AgentCli).max(8),
    health_status: ModelCatalogHealthStatus,
    catalog_revision: CatalogRevision,
  })
  .strict();
export type FrozenModelDescriptor = z.infer<typeof FrozenModelDescriptor>;

/** Credential validate hook result shape (adapter-owned; Scheduler invokes). */
export const ProviderCredentialValidateResult = z
  .object({
    ok: z.boolean(),
    error_code: z.string().min(1).max(80).nullable(),
    message: z.string().min(1).max(400).nullable(),
  })
  .strict();
export type ProviderCredentialValidateResult = z.infer<typeof ProviderCredentialValidateResult>;

/** Catalog discovery shape returned by an adapter probe. */
export const ProviderCatalogDiscoveryResult = z
  .object({
    models: z.array(ModelDescriptor).max(500),
    catalog_revision: CatalogRevision,
    probed_at: z.string().datetime().nullable(),
    health_status: ModelCatalogHealthStatus,
  })
  .strict();
export type ProviderCatalogDiscoveryResult = z.infer<typeof ProviderCatalogDiscoveryResult>;

/** CLI compatibility declaration on an adapter. */
export const ProviderCliCompatibility = z
  .object({
    agent_cli: AgentCli,
    compatible: z.boolean(),
    notes: z.string().max(400).nullable(),
  })
  .strict();
export type ProviderCliCompatibility = z.infer<typeof ProviderCliCompatibility>;

/**
 * Gateway transform interface stub. Concrete transforms stay in Scheduler;
 * adapters declare route / model-id rewrite expectations.
 */
export const ProviderGatewayTransformSpec = z
  .object({
    route_style: z.enum(["anthropic_messages", "openai_chat_completions", "openai_responses", "passthrough"]),
    rewrite_cli_aliases: z.boolean(),
    /** When true, Gateway must reject request models outside the Job freeze. */
    enforce_frozen_model: z.boolean(),
  })
  .strict();
export type ProviderGatewayTransformSpec = z.infer<typeof ProviderGatewayTransformSpec>;

/**
 * Provider Adapter Registry row. New providers = register adapter; avoid
 * scattering provider switches across RoleConfig / Job / report code (#614).
 */
export const ProviderAdapterManifest = z
  .object({
    schema: z.literal(PROVIDER_ADAPTER_SCHEMA),
    adapter_id: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    provider: ProviderId,
    adapter_version: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    kind: z.enum(["llm_provider", "git", "oci_registry"]),
    auth_methods: z.array(z.enum(["api_key", "oauth", "cli_login"])).min(1).max(4),
    supports_base_url: z.boolean(),
    secret_env_keys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(8),
    base_url_env_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
    default_base_url: z.string().url().nullable(),
    cli_compatibility: z.array(ProviderCliCompatibility).max(8),
    gateway: ProviderGatewayTransformSpec,
    /** Whether model catalog probe is required for this provider. */
    model_catalog_capability: z.enum(["required", "unsupported"]),
    summary: z.string().min(8).max(400),
  })
  .strict();
export type ProviderAdapterManifest = z.infer<typeof ProviderAdapterManifest>;

/** Frozen adapter + model identity captured at Job create (#614). */
export const FrozenProviderModelSnapshot = z
  .object({
    schema: z.literal(FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA),
    adapter_id: z.string().min(3).max(80),
    adapter_version: z.string().min(1).max(40),
    provider: ProviderId,
    /** Provider route / wire protocol style frozen with the Job. */
    route_style: z.enum(["anthropic_messages", "openai_chat_completions", "openai_responses", "passthrough"]),
    /** CLI-facing model selector frozen at Job create (may be alias). */
    cli_model_id: ModelId.nullable(),
    /** Upstream / wire model ID after alias resolution. */
    upstream_model_id: ModelId.nullable(),
    model_descriptor: FrozenModelDescriptor.nullable(),
    catalog_revision: CatalogRevision.nullable(),
    /** Explicit passthrough marker; default false (fail-closed). */
    passthrough: z.boolean(),
  })
  .strict();
export type FrozenProviderModelSnapshot = z.infer<typeof FrozenProviderModelSnapshot>;

/** Hub / Scheduler model selection filter over descriptor fields. */
export const ModelSelectionRequirements = z
  .object({
    provider: ProviderId.optional(),
    agent_cli: AgentCli.optional(),
    min_context_window: z.number().int().min(1024).max(10_000_000).optional(),
    require_tools: z.boolean().optional(),
    require_streaming: z.boolean().optional(),
    require_structured_output: z.boolean().optional(),
    reasoning_effort: ReasoningValue.optional(),
    input_modality: ModelModality.optional(),
    output_modality: ModelModality.optional(),
    max_input_cost_per_1m_usd: z.number().finite().nonnegative().optional(),
    /** When false (default), exclude non-verified / passthrough rows. */
    allow_unverified: z.boolean().optional(),
    allow_passthrough: z.boolean().optional(),
  })
  .strict();
export type ModelSelectionRequirements = z.infer<typeof ModelSelectionRequirements>;

/**
 * Credential.agent_cli is the exclusive CLI pin for that saved account (#658).
 * A credential with agent_cli=X may only be bound/served by CLI X; do not expand
 * via provider protocol matrices. Missing/invalid agent_cli is fail-closed.
 * Saving one RoleConfig must not rewrite Credential.agent_cli for other roles.
 */
export const CREDENTIAL_AGENT_CLI_BINDING_NOTE =
  "Credential.agent_cli is the exclusive Agent CLI pin for that saved account. RoleConfig may bind the credential only when role agent_cli matches credential.agent_cli; provider protocol catalogs must not expand a saved credential to other CLIs. Missing or invalid credential.agent_cli is fail-closed. Saving one RoleConfig must not rewrite Credential.agent_cli for other roles." as const;

export function isSelectableModelHealth(
  status: ModelCatalogHealthStatus,
  opts?: { allowUnverified?: boolean; allowPassthrough?: boolean },
): boolean {
  if (status === "verified") return true;
  if (status === "passthrough_allowed") return opts?.allowPassthrough === true;
  if (opts?.allowUnverified) return status === "stale" || status === "probe_failed" || status === "unsupported";
  return false;
}

/**
 * Filter model descriptors by structured capability requirements.
 * Pure / browser-safe (no node:crypto).
 */
export function selectModelDescriptors(
  catalog: readonly ModelDescriptor[],
  requirements: ModelSelectionRequirements = {},
): ModelDescriptor[] {
  const allowUnverified = requirements.allow_unverified === true;
  const allowPassthrough = requirements.allow_passthrough === true;
  return catalog.filter((row) => {
    if (requirements.provider && row.provider !== requirements.provider) return false;
    if (requirements.agent_cli && !row.compatible_agent_clis.includes(requirements.agent_cli)) return false;
    if (
      requirements.min_context_window != null &&
      (row.context_window == null || row.context_window < requirements.min_context_window)
    ) {
      return false;
    }
    if (requirements.require_tools && !row.supports_tools) return false;
    if (requirements.require_streaming && !row.supports_streaming) return false;
    if (requirements.require_structured_output && !row.supports_structured_output) return false;
    if (
      requirements.reasoning_effort &&
      !row.reasoning_efforts.includes(requirements.reasoning_effort)
    ) {
      return false;
    }
    if (requirements.input_modality && !row.input_modalities.includes(requirements.input_modality)) {
      return false;
    }
    if (requirements.output_modality && !row.output_modalities.includes(requirements.output_modality)) {
      return false;
    }
    if (
      requirements.max_input_cost_per_1m_usd != null &&
      (row.cost?.input_per_1m_usd == null ||
        row.cost.input_per_1m_usd > requirements.max_input_cost_per_1m_usd)
    ) {
      return false;
    }
    if (!isSelectableModelHealth(row.health_status, { allowUnverified, allowPassthrough })) {
      return false;
    }
    return true;
  });
}

export function freezeModelDescriptor(row: ModelDescriptor): FrozenModelDescriptor {
  return FrozenModelDescriptor.parse({
    schema: MODEL_DESCRIPTOR_SCHEMA,
    provider: row.provider,
    model_id: row.model_id,
    display_name: row.display_name,
    context_window: row.context_window,
    max_output_tokens: row.max_output_tokens,
    supports_tools: row.supports_tools,
    supports_streaming: row.supports_streaming,
    supports_structured_output: row.supports_structured_output,
    reasoning_efforts: [...row.reasoning_efforts],
    input_modalities: [...row.input_modalities],
    output_modalities: [...row.output_modalities],
    compatible_agent_clis: [...row.compatible_agent_clis],
    health_status: row.health_status,
    catalog_revision: row.catalog_revision,
  });
}
