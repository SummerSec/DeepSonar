/** Shared credential-blind policy for configured HTTP headers. */
import { validateHeaderName, validateHeaderValue } from "node:http";

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
  const seen = new Set<string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    try {
      validateHeaderName(rawName);
      if (name.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxNameLength) throw new Error("name too long");
    } catch {
      rejected.push("invalid_name");
      continue;
    }
    if (seen.has(name)) {
      rejected.push(`duplicate_name:${name}`);
      continue;
    }
    seen.add(name);
    if (typeof rawValue === "string" && /[\r\n]/u.test(rawValue)) {
      rejected.push(`invalid_value:${name}`);
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

