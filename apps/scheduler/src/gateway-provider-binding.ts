import { createHash } from "node:crypto";
import { PROVIDER_ENV_MAP } from "./credentials.js";
import { providerCustomHeadersFromSettings } from "./provider-custom-headers.js";
import { extractBaseUrlFromSettings, providerSettingsForJobSnapshot } from "./provider-settings.js";

export type GatewayProviderBinding = {
  version: 1;
  credential_id: string;
  fingerprint: string;
};

export interface GatewayProviderCredential {
  id: unknown;
  provider: unknown;
  agent_cli?: unknown;
  settings_config_json?: unknown;
  public_metadata_json?: unknown;
}

export class GatewayProviderBindingError extends Error {
  constructor(readonly code: "GATEWAY_PROVIDER_BINDING_MISSING" | "GATEWAY_PROVIDER_BINDING_INVALID"
    | "GATEWAY_PROVIDER_BINDING_CHANGED" | "GATEWAY_PROVIDER_ENDPOINT_MISMATCH") {
    super(`${code}: regenerate the Job configuration from the current provider configuration`);
    this.name = "GatewayProviderBindingError";
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, sorted(child)]));
  }
  return value;
}

/** Bind routing and nonsecret business configuration, independently of key rotation and catalog refresh. */
export function freezeGatewayProviderBinding(credential: GatewayProviderCredential): GatewayProviderBinding {
  if (typeof credential.id !== "string" || !credential.id || typeof credential.provider !== "string" || !credential.provider) {
    throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_INVALID");
  }
  const metadata = credential.public_metadata_json;
  const metadataBaseUrl = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).base_url : undefined;
  if (metadataBaseUrl != null && typeof metadataBaseUrl !== "string") {
    throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_INVALID");
  }
  const baseUrl = (metadataBaseUrl as string | null | undefined)
    ?? extractBaseUrlFromSettings(credential.settings_config_json)
    ?? PROVIDER_ENV_MAP[credential.provider]?.defaultBaseUrl ?? "https://api.anthropic.com";
  // A metadata override cannot silently send the selected profile's headers elsewhere.
  if (providerCustomHeadersFromSettings(credential.settings_config_json, baseUrl).rejected.includes("upstream_endpoint_mismatch")) {
    throw new GatewayProviderBindingError("GATEWAY_PROVIDER_ENDPOINT_MISMATCH");
  }
  const cli = typeof credential.agent_cli === "string" ? credential.agent_cli : null;
  const envelope = {
    credential_id: credential.id,
    provider: credential.provider,
    agent_cli: cli,
    effective_base_url: baseUrl,
    public_metadata: { base_url: metadataBaseUrl ?? null },
    settings: providerSettingsForJobSnapshot(credential.settings_config_json, cli),
  };
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(sorted(envelope))).digest("hex")}`;
  return { version: 1, credential_id: credential.id, fingerprint };
}

/** Old Jobs must be explicitly regenerated; never establish trust from today's mutable configuration. */
export function assertGatewayProviderBinding(binding: unknown, credential: GatewayProviderCredential): void {
  if (binding == null) throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_MISSING");
  if (typeof binding !== "object" || Array.isArray(binding)) throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_INVALID");
  const stored = binding as Record<string, unknown>;
  if (stored.version !== 1 || typeof stored.credential_id !== "string" || typeof stored.fingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(stored.fingerprint)) throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_INVALID");
  const current = freezeGatewayProviderBinding(credential);
  if (stored.credential_id !== current.credential_id || stored.fingerprint !== current.fingerprint) {
    throw new GatewayProviderBindingError("GATEWAY_PROVIDER_BINDING_CHANGED");
  }
}
