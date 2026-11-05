/** Shared server-bound endpoint/header resolution for Gateway and credential probes.
 * #923: unknown end-to-end headers are business data, not an allowlist. Authentication,
 * transport framing and exact platform control fields are consumed at this boundary.
 */
import { validateHeaderName, validateHeaderValue } from "node:http";

import { resolveProviderUpstreamFromSettings } from "./provider-settings.js";

/** Configuration resource limits; exceeding them is an explicit configuration error. */
export const PROVIDER_CUSTOM_HEADER_LIMITS = {
  maxHeaders: 16,
  maxNameLength: 128,
  maxValueLength: 1024,
} as const;

/** Only authentication, HTTP transport ownership and named platform controls. */
const FORBIDDEN_EXACT = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate",
  "x-api-key", "api-key", "anthropic-api-key",
  "host", "content-length", "transfer-encoding", "connection", "proxy-connection",
  "keep-alive", "upgrade", "te", "trailer", "expect",
  "x-deepsonar-job", "x-deepsonar-workload", "x-deepsonar-effect-status",
  "x-deepsonar-proposal-revision", "x-deepsonar-request-id",
]);

export type ProviderCustomHeaders = Record<string, string>;

export interface ProviderCustomHeaderResolution {
  headers: ProviderCustomHeaders;
  /** Diagnosable reasons a configured entry was not applied (names only, never values). */
  rejected: string[];
}

export function isForbiddenProviderHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return FORBIDDEN_EXACT.has(lower);
}

/**
 * Normalize names only. Preserve legal empty values and whitespace; reject ambiguous
 * case-insensitive duplicate configuration names. Callers must reject invalid configuration
 * before sending anything upstream; consumed authentication/transport fields are reported
 * separately as forbidden entries. Never report header values.
 */
export function sanitizeProviderCustomHeaders(raw: unknown): ProviderCustomHeaderResolution {
  const rejected: string[] = [];
  const headers: ProviderCustomHeaders = {};
  if (raw == null) return { headers, rejected };
  if (typeof raw !== "object" || Array.isArray(raw)) return { headers, rejected: ["headers_not_an_object"] };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxHeaders) {
    return { headers, rejected: ["too_many_headers"] };
  }
  const connectionFields = new Set(entries
    .filter(([name, value]) => name.toLowerCase() === "connection" && typeof value === "string")
    .flatMap(([, value]) => (value as string).split(",").map((name) => name.trim().toLowerCase())));
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    try {
      validateHeaderName(rawName);
      if (name.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxNameLength) throw new Error("name too long");
    } catch {
      rejected.push("invalid_name");
      continue;
    }
    if (Object.hasOwn(headers, name)) {
      rejected.push(`duplicate_name:${name}`);
      continue;
    }
    if (isForbiddenProviderHeader(name) || connectionFields.has(name)) {
      rejected.push(`forbidden:${name}`);
      continue;
    }
    if (typeof rawValue !== "string") {
      rejected.push(`invalid_value:${name}`);
      continue;
    }
    const value = rawValue;
    try {
      validateHeaderValue(name, value);
      if (value.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength) throw new Error("value too long");
    } catch {
      rejected.push(`invalid_value:${name}`);
      continue;
    }
    headers[name] = value;
  }
  return { headers, rejected };
}

/** Invalid HTTP configuration is a request failure, never a partial header set. */
export function hasInvalidProviderHeaders(resolution: ProviderCustomHeaderResolution): boolean {
  return resolution.rejected.some((reason) => reason === "headers_not_an_object"
    || reason === "too_many_headers" || reason.startsWith("invalid_") || reason.startsWith("duplicate_name:"));
}

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
): ProviderCustomHeaderResolution {
  const upstream = resolveProviderUpstreamFromSettings(settingsConfig);
  if (upstreamBaseUrl && upstream.baseUrl) {
    const configured = canonicalEndpoint(upstream.baseUrl);
    const effective = canonicalEndpoint(upstreamBaseUrl);
    if (!configured || !effective || configured !== effective) {
      return { headers: {}, rejected: ["upstream_endpoint_mismatch"] };
    }
  }
  if (upstream.profile) return sanitizeProviderCustomHeaders(upstream.profile.headers);

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
