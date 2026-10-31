import {
  PROVIDER_ADAPTER_SCHEMA,
  ProviderAdapterManifest,
  type ProviderAdapterManifest as Manifest,
  type ProviderCredentialValidateResult,
  type ProviderCatalogDiscoveryResult,
} from "@deepsonar/shared-types";
import { PROVIDER_ENV_MAP, credentialModelCatalogCapability } from "../../credentials.js";

function manifest(input: Omit<Manifest, "schema">): Manifest {
  return ProviderAdapterManifest.parse({
    schema: PROVIDER_ADAPTER_SCHEMA,
    ...input,
  });
}

/**
 * Phase-1 Provider Adapter Registry (#614).
 * Seeds from existing PROVIDER_ENV_MAP / account catalog so callers extend
 * rather than invent a parallel provider matrix.
 */
const PROVIDER_ADAPTER_SEED: readonly Manifest[] = [
  manifest({
    adapter_id: "provider.anthropic",
    provider: "anthropic",
    adapter_version: "1.0.0",
    label: "Anthropic Messages",
    kind: "llm_provider",
    auth_methods: ["api_key"],
    supports_base_url: true,
    secret_env_keys: [...PROVIDER_ENV_MAP.anthropic.secretKeys],
    base_url_env_key: PROVIDER_ENV_MAP.anthropic.baseUrlKey ?? null,
    default_base_url: PROVIDER_ENV_MAP.anthropic.defaultBaseUrl ?? null,
    cli_compatibility: [
      { agent_cli: "claude-code", compatible: true, notes: null },
      { agent_cli: "pi", compatible: true, notes: null },
      { agent_cli: "dsh", compatible: true, notes: null },
    ],
    gateway: {
      route_style: "anthropic_messages",
      rewrite_cli_aliases: true,
      enforce_frozen_model: true,
    },
    model_catalog_capability: credentialModelCatalogCapability("llm_provider", "anthropic"),
    summary:
      "Anthropic Messages adapter: credential validate, catalog discovery, Gateway rewrite of Claude CLI aliases, concurrent model quotas.",
  }),
  manifest({
    adapter_id: "provider.openai",
    provider: "openai",
    adapter_version: "1.0.0",
    label: "OpenAI-compatible",
    kind: "llm_provider",
    auth_methods: ["api_key"],
    supports_base_url: true,
    secret_env_keys: [...PROVIDER_ENV_MAP.openai.secretKeys],
    base_url_env_key: PROVIDER_ENV_MAP.openai.baseUrlKey ?? null,
    default_base_url: PROVIDER_ENV_MAP.openai.defaultBaseUrl ?? null,
    cli_compatibility: [
      { agent_cli: "claude-code", compatible: false, notes: "claude-code requires anthropic" },
      { agent_cli: "pi", compatible: true, notes: null },
      { agent_cli: "dsh", compatible: true, notes: null },
    ],
    gateway: {
      route_style: "openai_chat_completions",
      rewrite_cli_aliases: false,
      enforce_frozen_model: true,
    },
    model_catalog_capability: credentialModelCatalogCapability("llm_provider", "openai"),
    summary:
      "OpenAI-compatible adapter: credential validate, catalog discovery, chat-completions Gateway route, concurrent model quotas.",
  }),
  manifest({
    adapter_id: "provider.git",
    provider: "git",
    adapter_version: "1.0.0",
    label: "Git repository",
    kind: "git",
    auth_methods: ["api_key"],
    supports_base_url: false,
    secret_env_keys: [...PROVIDER_ENV_MAP.git.secretKeys],
    base_url_env_key: null,
    default_base_url: null,
    cli_compatibility: [],
    gateway: {
      route_style: "passthrough",
      rewrite_cli_aliases: false,
      enforce_frozen_model: false,
    },
    model_catalog_capability: "unsupported",
    summary: "Git credential adapter (no LLM catalog / Gateway model route).",
  }),
];

/** Runtime extras from registerProviderAdapter (tests / future dynamic adapters). */
let providerAdapterExtras: Manifest[] = [];

export const PROVIDER_ADAPTER_MANIFESTS: readonly Manifest[] = PROVIDER_ADAPTER_SEED;

function allAdapters(): Manifest[] {
  return [...PROVIDER_ADAPTER_SEED, ...providerAdapterExtras];
}

export function listProviderAdapters(): readonly Manifest[] {
  return allAdapters();
}

export function findProviderAdapter(provider: string): Manifest | null {
  return allAdapters().find((row) => row.provider === provider) ?? null;
}

export function findProviderAdapterById(adapterId: string): Manifest | null {
  return allAdapters().find((row) => row.adapter_id === adapterId) ?? null;
}

export function registerProviderAdapter(input: unknown): Manifest {
  const parsed = ProviderAdapterManifest.parse(input);
  if (findProviderAdapterById(parsed.adapter_id) || findProviderAdapter(parsed.provider)) {
    throw new Error(
      `Provider adapter already registered: adapter_id=${parsed.adapter_id} provider=${parsed.provider}`,
    );
  }
  providerAdapterExtras.push(parsed);
  return parsed;
}

/** Test helper — clears dynamically registered adapters. */
export function resetProviderAdapterRegistryForTests(): void {
  providerAdapterExtras = [];
}

export function validateProviderAdapterManifest(value: unknown): Manifest {
  return ProviderAdapterManifest.parse(value);
}

/** Stub credential validate hook — phase 1 shape only; probes stay in credential-test. */
export function adapterValidateCredentialShape(input: {
  provider: string;
  secrets: Record<string, string>;
}): ProviderCredentialValidateResult {
  const adapter = findProviderAdapter(input.provider);
  if (!adapter) {
    return { ok: false, error_code: "ADAPTER_NOT_REGISTERED", message: `未知 Provider: ${input.provider}` };
  }
  if (adapter.kind !== "llm_provider" && adapter.kind !== "git") {
    return { ok: false, error_code: "ADAPTER_KIND_UNSUPPORTED", message: `Adapter kind ${adapter.kind} 未在 phase 1 校验` };
  }
  for (const key of adapter.secret_env_keys) {
    const value = input.secrets[key];
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, error_code: "CREDENTIAL_SECRET_MISSING", message: `缺少密钥字段 ${key}` };
    }
  }
  return { ok: true, error_code: null, message: null };
}

/** Stub catalog discovery shape — real probes remain in credential-test (#570). */
export function adapterEmptyCatalogDiscovery(provider: string): ProviderCatalogDiscoveryResult {
  const adapter = findProviderAdapter(provider);
  return {
    models: [],
    catalog_revision: `empty:${provider}:v0`,
    probed_at: null,
    health_status: adapter?.model_catalog_capability === "unsupported" ? "unsupported" : "probe_failed",
  };
}

export function adapterDeclaresCliCompatible(
  provider: string,
  agentCli: "claude-code" | "pi" | "dsh",
): boolean {
  const adapter = findProviderAdapter(provider);
  if (!adapter) return false;
  const row = adapter.cli_compatibility.find((item) => item.agent_cli === agentCli);
  return row?.compatible === true;
}
