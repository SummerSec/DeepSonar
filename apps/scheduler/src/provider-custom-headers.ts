/** Shared server-bound endpoint/header resolution for Gateway and credential probes.
 * #923: unknown end-to-end headers are business data, not an allowlist. Authentication,
 * transport framing and exact platform control fields are consumed at this boundary.
 */
import { hasInvalidProviderHeaders, sanitizeProviderCustomHeaders, readOfficialLlmPiAiSettings,
  type ProviderCustomHeaderResolution, type ProviderCustomHeaders } from "@deepsonar/runtime-sandbox";
export { hasInvalidProviderHeaders, sanitizeProviderCustomHeaders, isForbiddenProviderHeader,
  PROVIDER_CUSTOM_HEADER_LIMITS, type ProviderCustomHeaderResolution, type ProviderCustomHeaders } from "@deepsonar/runtime-sandbox";

import { resolveProviderUpstreamFromSettings } from "./provider-settings.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Compare targets as URLs, not spelling: URL transport normalizes host/scheme and
// default ports. Keep path, query, fragment and userinfo so real target changes differ.
function canonicalEndpoint(value: string): string | null {
  try {
    const endpoint = new URL(value.trim());
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
    return endpoint.href;
  } catch {
    return null;
  }
}

export type ProviderHeaderPurpose = { purpose: "catalog" } | { purpose: "inference"; model: string; provider?: string };

/** Pi 1.4.0 provider-composer rawModelHeaders: overrides precede model definitions. */
function profileHeaders(profile: Record<string, unknown>, selection: ProviderHeaderPurpose,
  endpoint?: string): ProviderCustomHeaderResolution {
  const provider = sanitizeProviderCustomHeaders(profile.headers);
  if (selection.purpose === "catalog") return provider;
  const invalid = (reason: string): ProviderCustomHeaderResolution => ({ headers: {}, rejected: [`invalid_model:${reason}`] });
  const model = selection.model;
  if (!model || model.trim() !== model) return invalid("missing_or_noncanonical");
  // Profiles without a local model catalog can use a server-discovered model. Never
  // infer a local definition from another provider, a display name, or a suffix.
  if (profile.models == null && profile.modelOverrides == null) return provider;
  const overrides = asRecord(profile.modelOverrides);
  const models = profile.models;
  const matches = Array.isArray(models)
    ? models.map(asRecord).filter((entry) => entry.id === model)
    : Object.hasOwn(asRecord(models), model) ? [asRecord(asRecord(models)[model])] : [];
  if (matches.length > 1) return invalid("duplicate_definition");
  // Pi keeps built-in models alongside these partial overrides/definitions.
  // A missing entry means provider defaults, not a failed model authorization.
  // Gateway independently enforces the frozen model permission.
  const definition = matches[0] ?? {};
  const modelEndpoint = definition.baseUrl ?? definition.baseURL ?? definition.base_url;
  if (typeof modelEndpoint === "string" && (!endpoint || canonicalEndpoint(modelEndpoint) !== canonicalEndpoint(endpoint))) {
    return invalid("endpoint_mismatch");
  }
  const layers = [provider, sanitizeProviderCustomHeaders(asRecord(overrides[model]).headers),
    sanitizeProviderCustomHeaders(definition.headers)];
  const rejected = layers.flatMap((layer) => layer.rejected);
  const result = { headers: Object.assign({}, ...layers.map((layer) => layer.headers)) as ProviderCustomHeaders, rejected };
  return hasInvalidProviderHeaders(result) ? { headers: {}, rejected } : result;
}

/**
 * Resolve headers from the same server-owned profile that selects the upstream endpoint.
 * Official Pi top-level/config object/config YAML documents use the runtime's official
 * parser through `resolveProviderUpstreamFromSettings`. An effective endpoint override
 * must still match the selected profile's declared URL before its headers can be applied.
 * With no selected endpoint profile, all provider header sets (including empty sets) must
 * agree; never mix route attributes.
 */
export function providerCustomHeadersFromSettings(
  settingsConfig: unknown,
  upstreamBaseUrl?: string,
  selection: ProviderHeaderPurpose = { purpose: "catalog" },
): ProviderCustomHeaderResolution {
  // Only a caller holding the frozen server-side binding may supply provider.
  // Exact route lookup precedes default-profile resolution; it never changes target.
  if (selection.purpose === "inference" && selection.provider !== undefined) {
    const invalid = (reason: string): ProviderCustomHeaderResolution => ({ headers: {}, rejected: [`invalid_model:${reason}`] });
    const provider = selection.provider;
    const official = readOfficialLlmPiAiSettings(settingsConfig);
    const providers = official?.providers ?? asRecord(asRecord(settingsConfig).providers);
    if (!provider || provider.trim() !== provider) return invalid("provider_not_found");
    const hasConfiguredProviders = Object.keys(providers).length > 0;
    if (hasConfiguredProviders && !Object.hasOwn(providers, provider)) return invalid("provider_not_found");
    // A built-in SDK provider can be frozen without any models.json providers.
    // Use only the top-level bound profile, never another configured provider.
    const inherited = hasConfiguredProviders ? null : resolveProviderUpstreamFromSettings(settingsConfig);
    const profile = hasConfiguredProviders ? asRecord(providers[provider]) : inherited?.profile ?? {};
    const declared = profile.baseUrl ?? profile.baseURL ?? profile.base_url ?? inherited?.baseUrl ?? undefined;
    const endpoint = typeof declared === "string" ? canonicalEndpoint(declared) : null;
    const bound = upstreamBaseUrl ? canonicalEndpoint(upstreamBaseUrl) : null;
    // An omitted endpoint inherits the credential-bound target. A declared one
    // must match it; neither case may borrow another provider's headers.
    if (!bound || (declared !== undefined && (!endpoint || endpoint !== bound))) return invalid("provider_endpoint_mismatch");
    return profileHeaders(profile, selection, upstreamBaseUrl);
  }
  const upstream = resolveProviderUpstreamFromSettings(settingsConfig);
  if (upstreamBaseUrl && upstream.baseUrl) {
    const configured = canonicalEndpoint(upstream.baseUrl);
    const effective = canonicalEndpoint(upstreamBaseUrl);
    if (!configured || !effective || configured !== effective) {
      return { headers: {}, rejected: ["upstream_endpoint_mismatch"] };
    }
  }
  if (upstream.profile) return profileHeaders(upstream.profile, selection, upstreamBaseUrl ?? upstream.baseUrl ?? undefined);
  if (selection.purpose === "inference") {
    return { headers: {}, rejected: ["invalid_model:ambiguous_provider"] };
  }

  const providers = asRecord(asRecord(settingsConfig).providers);
  const configured = Object.values(providers)
    .map((raw) => sanitizeProviderCustomHeaders(asRecord(raw).headers));
  if (configured.length === 0) return { headers: {}, rejected: [] };
  const distinct = new Set(configured.map((resolution) => JSON.stringify(resolution.headers)));
  if (distinct.size > 1) {
    return { headers: {}, rejected: ["ambiguous_multi_provider_headers"] };
  }
  const first = configured[0]!;
  const rejected = configured.flatMap((resolution) => resolution.rejected);
  return { headers: { ...first.headers }, rejected: [...new Set(rejected)] };
}

/**
 * Compose the final upstream header set from server-owned layers. Precedence, lowest to
 * highest: request defaults → protocol defaults → configured credential headers → incoming
 * end-to-end request headers → authentication from the bound credential. Configuration is
 * bound to the selected endpoint before composition.
 */
export function composeUpstreamRequestHeaders(input: {
  configured?: ProviderCustomHeaders;
  protocol?: Record<string, string>;
  inboundProtocol?: Record<string, string>;
  auth: Record<string, string>;
  base?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(input.base ?? {}),
    ...(input.protocol ?? {}),
    ...(input.configured ?? {}),
    ...(input.inboundProtocol ?? {}),
    ...input.auth,
  };
}
