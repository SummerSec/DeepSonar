/**
 * #918: Provider credentials may need extra upstream request headers (traffic labels,
 * relay routing keys, tenant tags). The Gateway used to drop everything that was not a
 * protocol header the CLI happened to send, so `X-Traffic-Type: eval` configured on the
 * credential never reached the upstream, while catalog discovery and the inference probe
 * did not even try — three paths, three different upstream routes.
 *
 * This module is the single resolver/sanitizer they all share. It reads only
 * server-controlled configuration (the credential row's `settings_config_json`), never
 * sandbox input, and refuses anything that could replace authentication, framing,
 * hop-by-hop transport or DeepSonar's own control/protocol headers.
 */

/** Hard caps: a credential cannot turn itself into an arbitrary request-header console. */
export const PROVIDER_CUSTOM_HEADER_LIMITS = {
  maxHeaders: 16,
  maxNameLength: 128,
  maxValueLength: 1024,
} as const;

/**
 * Headers configuration may never set. Three groups:
 * - authentication carriers: the server decides them from the bound credential (and the
 *   inbound Job token must never be forwarded upstream, see `GATEWAY_PASSTHROUGH_HEADERS`);
 * - framing / hop-by-hop: `content-length` must match the body the Gateway wrote, and
 *   connection management belongs to the transport;
 * - protocol/CLI identity and internal control: `user-agent`/`x-app`/`anthropic-*` carry
 *   the CLI fingerprint (#736) and wire protocol version, `x-deepsonar-*` is ours.
 */
const FORBIDDEN_EXACT = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "x-api-key",
  "api-key",
  "anthropic-api-key",
  "anthropic-version",
  "anthropic-beta",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "content-type",
  "accept",
  "accept-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "user-agent",
  "x-app",
]);

const FORBIDDEN_PREFIXES = ["x-deepsonar-", "proxy-", "anthropic-"];

/** RFC 7230 token characters; anything else is a header-injection attempt. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u;

export type ProviderCustomHeaders = Record<string, string>;

export interface ProviderCustomHeaderResolution {
  headers: ProviderCustomHeaders;
  /** Diagnosable reasons a configured entry was not applied (names only, never values). */
  rejected: string[];
}

export function isForbiddenProviderHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (FORBIDDEN_EXACT.has(lower)) return true;
  return FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Normalize one configured header set. Names are lower-cased so `X-Traffic-Type` and
 * `x-traffic-type` cannot both reach the upstream; invalid names, CR/LF, NUL and
 * forbidden names/values are dropped and reported.
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
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!name || name.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxNameLength || !HEADER_NAME_RE.test(name)) {
      rejected.push(`invalid_name:${rawName.slice(0, 32)}`);
      continue;
    }
    if (isForbiddenProviderHeader(name)) {
      rejected.push(`forbidden:${name}`);
      continue;
    }
    if (typeof rawValue !== "string") {
      rejected.push(`invalid_value:${name}`);
      continue;
    }
    const value = rawValue.trim();
    if (
      !value
      || value.length > PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength
      || /[\u0000\r\n]/u.test(value)
    ) {
      rejected.push(`invalid_value:${name}`);
      continue;
    }
    headers[name] = value;
  }
  return { headers, rejected };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the configured header set for the credential's current route.
 *
 * Supported shapes, mirroring what `extractBaseUrlFromSettings` already understands:
 * - `{"llm-pi-ai": {"providers": {<route>: {"headers": {...}}}}}` (official DSH settings)
 * - `{"headers": {...}}` (flat route)
 * - `{"providers": {<id>: {"headers": {...}}}}` (Pi models.json shape)
 *
 * Several providers may carry *different* header sets for one credential; that is
 * ambiguous, so nothing is applied (fail closed, no mixing across providers/routes).
 */
export function providerCustomHeadersFromSettings(settingsConfig: unknown): ProviderCustomHeaderResolution {
  const settings = asRecord(settingsConfig);

  const official = asRecord(asRecord(settings["llm-pi-ai"])?.providers);
  if (Object.keys(official).length > 0) {
    const defaultModel = asRecord(settings["agent-default-model"]);
    const selected = trimText(defaultModel?.provider) ?? "";
    const route = selected && official[selected] ? selected : Object.keys(official)[0]!;
    const profile = asRecord(official[route]);
    const resolution = sanitizeProviderCustomHeaders(profile.headers);
    return { headers: resolution.headers, rejected: resolution.rejected };
  }

  if (settings.headers != null) return sanitizeProviderCustomHeaders(settings.headers);

  const providers = asRecord(settings.providers);
  const configured = Object.values(providers)
    .map((raw) => sanitizeProviderCustomHeaders(asRecord(raw).headers))
    .filter((resolution) => Object.keys(resolution.headers).length > 0);
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
 * highest: body framing → trusted protocol defaults → configured credential headers → CLI
 * protocol headers the Gateway allowlists → final authentication from the bound credential.
 * Configured headers are already sanitized, so they can never occupy the last two layers.
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