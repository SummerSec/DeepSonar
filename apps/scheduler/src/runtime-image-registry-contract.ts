/**
 * Pure contract and trust-boundary helpers for the official runtime-image
 * catalog.  This module deliberately has no database/config dependencies so
 * callers can validate release, bundled, and uploaded catalog payloads in the
 * same way.
 */

export const RUNTIME_IMAGE_REGISTRY_SCHEMA_V1 = "deepsonar.registry/v1" as const;
export const RUNTIME_IMAGE_REGISTRY_SCHEMA_V2 = "deepsonar.registry/v2" as const;

export type RuntimeImageRegistrySchema =
  | typeof RUNTIME_IMAGE_REGISTRY_SCHEMA_V1
  | typeof RUNTIME_IMAGE_REGISTRY_SCHEMA_V2;

export const RUNTIME_IMAGE_REGISTRY_CHANNELS = ["github", "dockerhub", "aliyun-acr"] as const;
export type RuntimeImageRegistryChannel = typeof RUNTIME_IMAGE_REGISTRY_CHANNELS[number];

export const RUNTIME_IMAGE_REGISTRY_METADATA_SOURCES = ["remote", "bundled", "upload"] as const;
export type RuntimeImageRegistryMetadataSource = typeof RUNTIME_IMAGE_REGISTRY_METADATA_SOURCES[number];

export interface RuntimeImageRegistryChannelPolicy {
  /** Exact, lower-case registry hostnames. Ports and aliases are not allowed. */
  hosts: readonly string[];
  /** Exact first path components (repository namespaces). */
  namespaces: readonly string[];
}

export type RuntimeImageRegistryPolicy = Readonly<Record<RuntimeImageRegistryChannel, RuntimeImageRegistryChannelPolicy>>;

/**
 * The only built-in official policy.  ACR is pinned to the exact currently
 * published official endpoint; accepting another ACR hostname requires the
 * server to construct/pass an explicit policy.
 * `registry-1.docker.io` is not an official channel alias; Docker Hub uses
 * the canonical `docker.io` host here.  The ACR endpoint is the exact
 * currently published official endpoint; it is not a wildcard.
 */
export const SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY: RuntimeImageRegistryPolicy = Object.freeze({
  github: Object.freeze({ hosts: Object.freeze(["ghcr.io"]), namespaces: Object.freeze(["summersec"]) }),
  dockerhub: Object.freeze({ hosts: Object.freeze(["docker.io"]), namespaces: Object.freeze(["summersec"]) }),
  "aliyun-acr": Object.freeze({
    hosts: Object.freeze(["crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com"]),
    namespaces: Object.freeze(["summersec"]),
  }),
});

export interface ParsedOciDigestRef {
  normalized: string;
  host: string;
  path: string;
  digest: string;
}

export interface RuntimeImageRegistryVersion {
  version: string;
  /** Legacy/current consumer reference. For v2 this is the GitHub ref only. */
  image_ref?: string;
  /** One canonical manifest digest shared by every channel ref. Always present on parser output. */
  digest?: string;
  /** OCI platforms described by this canonical version. */
  platforms?: string[];
  /** One canonical size for the version (when supplied by the catalog). */
  size_bytes?: number;
  /** Available channel references; an omitted key means that channel is unavailable. */
  registry_refs?: Partial<Record<RuntimeImageRegistryChannel, string>>;
  tools_manifest_sha256?: string;
}

export interface RuntimeImageRegistryImage {
  image_key: string;
  name: string;
  description: string;
  publisher: string;
  source_kind: "official";
  source_url?: string;
  project_opt_in: boolean;
  default_role?: string;
  versions: RuntimeImageRegistryVersion[];
}

export interface RuntimeImageRegistry {
  schema: RuntimeImageRegistrySchema;
  /** Present for v2 payloads and for callers that use numeric schema versions. */
  schema_version?: 1 | 2;
  images: RuntimeImageRegistryImage[];
  /** Scheduler-owned provenance metadata; never an OCI channel selector. */
  source?: RuntimeImageRegistryMetadataSource;
  fallback?: boolean;
  error?: string | null;
  checked_at?: string;
}

export interface RuntimeImageRegistryPolicyInput {
  "aliyun-acr"?: RuntimeImageRegistryChannelPolicy;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_SEGMENT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9][a-z0-9._-]*$/;
const IMAGE_KEY_RE = /^[a-z][a-z0-9-]{1,62}$/;

function invalid(message: string): never {
  throw new Error(`runtime image registry contract: ${message}`);
}

function copyPolicyEntry(channel: RuntimeImageRegistryChannel, entry: RuntimeImageRegistryChannelPolicy | undefined): RuntimeImageRegistryChannelPolicy {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hosts) || !Array.isArray(entry.namespaces)) {
    invalid(`${channel} policy must explicitly provide hosts and namespaces`);
  }
  const entryKeys = Reflect.ownKeys(entry);
  if (entryKeys.length !== 2 || !entryKeys.every((key) => key === "hosts" || key === "namespaces")) {
    invalid(`${channel} policy contains unknown fields`);
  }
  const hosts = entry.hosts.map((host) => {
    if (typeof host !== "string" || !isCanonicalHost(host)) invalid(`${channel} policy host is not canonical`);
    return host;
  });
  const namespaces = entry.namespaces.map((namespace) => {
    if (typeof namespace !== "string" || !isNamespace(namespace)) invalid(`${channel} policy namespace is not canonical`);
    return namespace;
  });
  if (new Set(hosts).size !== hosts.length || new Set(namespaces).size !== namespaces.length) {
    invalid(`${channel} policy contains duplicate hosts or namespaces`);
  }
  return Object.freeze({ hosts: Object.freeze([...hosts]), namespaces: Object.freeze([...namespaces]) });
}

function assertPolicyOwnership(policy: RuntimeImageRegistryPolicy): void {
  const ownership = new Map<string, RuntimeImageRegistryChannel>();
  for (const channel of RUNTIME_IMAGE_REGISTRY_CHANNELS) {
    const entry = policy[channel];
    if ((entry.hosts.length === 0) !== (entry.namespaces.length === 0)) {
      invalid(`${channel} policy must provide both hosts and namespaces, or leave both empty`);
    }
    for (const host of entry.hosts) {
      for (const namespace of entry.namespaces) {
        const key = `${host}/${namespace}`;
        const previous = ownership.get(key);
        if (previous && previous !== channel) invalid(`policy host/namespace is ambiguous between ${previous} and ${channel}`);
        ownership.set(key, channel);
      }
    }
  }
}

/**
 * Validate and deep-freeze a complete server-owned policy before it reaches
 * any catalog parser.  GitHub and Docker Hub are fixed authorities; only ACR
 * may be supplied by a server-side caller.
 */
export function validateRuntimeImageRegistryPolicy(policy: RuntimeImageRegistryPolicy): RuntimeImageRegistryPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) invalid("policy must be an object");
  const policyKeys = Reflect.ownKeys(policy);
  if (policyKeys.length !== RUNTIME_IMAGE_REGISTRY_CHANNELS.length
    || !RUNTIME_IMAGE_REGISTRY_CHANNELS.every((channel) => policyKeys.includes(channel))) {
    invalid("policy must contain exactly github, dockerhub, and aliyun-acr channels");
  }
  const normalized = {
    github: copyPolicyEntry("github", policy.github),
    dockerhub: copyPolicyEntry("dockerhub", policy.dockerhub),
    "aliyun-acr": copyPolicyEntry("aliyun-acr", policy["aliyun-acr"]),
  } satisfies RuntimeImageRegistryPolicy;
  const builtinGithub = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY.github;
  const builtinDockerhub = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY.dockerhub;
  if (normalized.github.hosts.join("\u0000") !== builtinGithub.hosts.join("\u0000")
    || normalized.github.namespaces.join("\u0000") !== builtinGithub.namespaces.join("\u0000")) {
    invalid("github policy is server-owned and cannot be overridden");
  }
  if (normalized.dockerhub.hosts.join("\u0000") !== builtinDockerhub.hosts.join("\u0000")
    || normalized.dockerhub.namespaces.join("\u0000") !== builtinDockerhub.namespaces.join("\u0000")) {
    invalid("dockerhub policy is server-owned and cannot be overridden");
  }
  assertPolicyOwnership(normalized);
  return Object.freeze(normalized);
}

/**
 * Construct a server-owned policy.  The built-in GitHub/Docker Hub policy is
 * fixed; callers may explicitly replace the built-in ACR endpoint with another
 * server-approved policy.  This function does not read Agent/Hub/task input.
 */
export function createServerOwnedRuntimeImageRegistryPolicy(input: RuntimeImageRegistryPolicyInput = {}): RuntimeImageRegistryPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("policy input must be an object");
  const inputKeys = Reflect.ownKeys(input);
  if (inputKeys.some((key) => key !== "aliyun-acr")) {
    invalid("github and dockerhub policies are server-owned and cannot be overridden");
  }
  return validateRuntimeImageRegistryPolicy({
    github: SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY.github,
    dockerhub: SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY.dockerhub,
    "aliyun-acr": input["aliyun-acr"] ?? SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY["aliyun-acr"],
  });
}

function isCanonicalHost(value: string): boolean {
  if (!value || value !== value.toLowerCase() || value.length > 253 || value.includes(":")) return false;
  const labels = value.split(".");
  // Bare hosts (localhost, docker) are ambiguous and not accepted as an
  // official registry endpoint.  Explicit IP literals are also not policy
  // hosts; policy entries must be DNS names owned by the server.
  if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label)) || labels.some((label) => !HOST_LABEL_RE.test(label))) return false;
  return true;
}

function isNamespace(value: string): boolean {
  return value.length > 0 && value === value.toLowerCase() && PATH_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

function validPlatform(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && PLATFORM_RE.test(value);
}

/**
 * Parse the small OCI digest-reference subset used by the catalog.  It is not
 * a general OCI client: only lower-case DNS host + repository path + a
 * lower-case sha256 digest are accepted.  URL syntax, credentials, ports,
 * tags, traversal, and ambiguous spellings fail closed.
 */
export function parseOciDigestRef(value: unknown): ParsedOciDigestRef {
  if (typeof value !== "string") invalid("OCI reference must be a string");
  const ref = value.trim();
  if (!ref || ref !== value) invalid("OCI reference must not contain surrounding whitespace");
  if (ref.includes("?") || ref.includes("#") || ref.includes("\\") || ref.includes("%")) {
    invalid("OCI reference contains URL or path escape syntax");
  }
  if (ref.includes("://")) invalid("OCI reference must not be a URL");
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at !== ref.indexOf("@")) invalid("OCI reference must contain exactly one digest separator");
  const name = ref.slice(0, at);
  const digest = ref.slice(at + 1);
  if (!DIGEST_RE.test(digest)) invalid("OCI reference must use a lower-case sha256 digest");
  if (name.includes(":") || name.includes("@")) invalid("OCI reference must not contain a port or tag");
  if (name.includes("//") || name.startsWith("/") || name.endsWith("/")) invalid("OCI repository path contains an empty segment");
  const segments = name.split("/");
  if (segments.length < 2) invalid("OCI repository path must include a namespace");
  const host = segments.shift()!;
  const repositoryPath = segments.join("/");
  if (!isCanonicalHost(host)) invalid("OCI registry host is not canonical");
  if (segments.some((segment) => segment === "." || segment === ".." || !PATH_SEGMENT_RE.test(segment))) {
    invalid("OCI repository path contains an invalid or traversal segment");
  }
  return { normalized: `${host}/${repositoryPath}@${digest}`, host, path: repositoryPath, digest };
}

function policyMatches(channel: RuntimeImageRegistryChannel, parsed: ParsedOciDigestRef, policy: RuntimeImageRegistryPolicy): boolean {
  const entry = policy[channel];
  if (!entry || entry.hosts.length === 0 || entry.namespaces.length === 0) return false;
  const namespace = parsed.path.split("/")[0];
  return entry.hosts.includes(parsed.host) && entry.namespaces.includes(namespace);
}

function channelForRef(parsed: ParsedOciDigestRef, policy: RuntimeImageRegistryPolicy): RuntimeImageRegistryChannel {
  const matches = RUNTIME_IMAGE_REGISTRY_CHANNELS.filter((channel) => policyMatches(channel, parsed, policy));
  if (matches.length !== 1) invalid(`OCI reference host/namespace is not allowed or is ambiguous (${parsed.normalized})`);
  return matches[0]!;
}

function parseMetadataSource(value: unknown): RuntimeImageRegistryMetadataSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !RUNTIME_IMAGE_REGISTRY_METADATA_SOURCES.includes(value as RuntimeImageRegistryMetadataSource)) {
    invalid("metadata source must be remote, bundled, or upload (OCI channel is separate)");
  }
  return value as RuntimeImageRegistryMetadataSource;
}

function parseImageBase(image: Record<string, unknown>, imageIndex: number): Omit<RuntimeImageRegistryImage, "versions"> {
  const key = typeof image.image_key === "string" ? image.image_key : "";
  if (!IMAGE_KEY_RE.test(key) || typeof image.name !== "string" || typeof image.description !== "string"
    || typeof image.publisher !== "string" || image.source_kind !== "official") {
    invalid(`images[${imageIndex}] fields are invalid`);
  }
  return {
    image_key: key,
    name: image.name,
    description: image.description,
    publisher: image.publisher,
    source_kind: "official",
    ...(typeof image.source_url === "string" ? { source_url: image.source_url } : {}),
    project_opt_in: image.project_opt_in === true,
    ...(typeof image.default_role === "string" ? { default_role: image.default_role } : {}),
  };
}

function parsePlatforms(value: unknown, required: boolean, imageKey: string, version: string): string[] | undefined {
  if (value === undefined) {
    if (required) invalid(`${imageKey} ${version} must declare platforms`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((platform) => !validPlatform(platform))) {
    invalid(`${imageKey} ${version} platforms are invalid`);
  }
  const platforms = value as string[];
  if (new Set(platforms).size !== platforms.length) invalid(`${imageKey} ${version} contains duplicate platforms`);
  return [...platforms];
}

function parseSize(value: unknown, required: boolean, imageKey: string, version: string): number | undefined {
  if (value === undefined) {
    if (required) invalid(`${imageKey} ${version} must declare size_bytes`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${imageKey} ${version} size_bytes is invalid`);
  return value as number;
}

function parseToolsManifest(value: unknown, imageKey: string, version: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(`${imageKey} ${version} tools_manifest_sha256 is invalid`);
  return value;
}

function parseV1Version(item: Record<string, unknown>, imageKey: string, index: number, policy: RuntimeImageRegistryPolicy): RuntimeImageRegistryVersion {
  const version = typeof item.version === "string" && item.version.length > 0 ? item.version : "";
  if (!version) invalid(`${imageKey} versions[${index}] version is invalid`);
  // The v1 loader historically trimmed image_ref before checking the digest;
  // retain that narrow compatibility while the standalone OCI parser remains
  // strict about ambiguous surrounding whitespace.
  const parsed = parseOciDigestRef(typeof item.image_ref === "string" ? item.image_ref.trim() : item.image_ref);
  const channel = channelForRef(parsed, policy);
  const platforms = parsePlatforms(item.platforms, false, imageKey, version);
  const sizeBytes = parseSize(item.size_bytes, false, imageKey, version);
  const toolsManifest = parseToolsManifest(item.tools_manifest_sha256, imageKey, version);
  return {
    version,
    image_ref: parsed.normalized,
    digest: parsed.digest,
    registry_refs: { [channel]: parsed.normalized },
    ...(platforms ? { platforms } : {}),
    ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
    ...(toolsManifest ? { tools_manifest_sha256: toolsManifest } : {}),
  };
}

function parseV2Version(item: Record<string, unknown>, imageKey: string, index: number, policy: RuntimeImageRegistryPolicy): RuntimeImageRegistryVersion {
  const version = typeof item.version === "string" && item.version.length > 0 ? item.version : "";
  if (!version) invalid(`${imageKey} versions[${index}] version is invalid`);
  const digest = typeof item.digest === "string" && DIGEST_RE.test(item.digest) ? item.digest : "";
  if (!digest) invalid(`${imageKey} ${version} digest is invalid`);
  const platforms = parsePlatforms(item.platforms, true, imageKey, version)!;
  const sizeBytes = parseSize(item.size_bytes, true, imageKey, version)!;
  const refsRaw = item.registry_refs;
  if (!refsRaw || typeof refsRaw !== "object" || Array.isArray(refsRaw)) invalid(`${imageKey} ${version} registry_refs must be an object`);
  const refs: Partial<Record<RuntimeImageRegistryChannel, string>> = {};
  const seen = new Set<string>();
  for (const [rawChannel, rawRef] of Object.entries(refsRaw as Record<string, unknown>)) {
    if (!RUNTIME_IMAGE_REGISTRY_CHANNELS.includes(rawChannel as RuntimeImageRegistryChannel)) invalid(`${imageKey} ${version} has an unknown channel`);
    const channel = rawChannel as RuntimeImageRegistryChannel;
    if (typeof rawRef !== "string") invalid(`${imageKey} ${version} ${channel} ref must be a string`);
    const parsed = parseOciDigestRef(rawRef);
    if (!policyMatches(channel, parsed, policy)) {
      invalid(`${imageKey} ${version} ${channel} ref is outside the server-owned host/namespace policy`);
    }
    if (parsed.digest !== digest) invalid(`${imageKey} ${version} ${channel} digest does not match canonical digest`);
    if (seen.has(parsed.normalized)) invalid(`${imageKey} ${version} contains duplicate normalized registry refs`);
    seen.add(parsed.normalized);
    refs[channel] = parsed.normalized;
  }
  if (Object.keys(refs).length === 0) invalid(`${imageKey} ${version} must provide at least one available registry channel`);
  const githubRef = refs.github;
  if (item.image_ref !== undefined) {
    // image_ref is a legacy compatibility projection only; it may not create
    // a second source or disagree with the GitHub channel.
    if (typeof item.image_ref !== "string" || !githubRef || parseOciDigestRef(item.image_ref).normalized !== githubRef) {
      invalid(`${imageKey} ${version} image_ref must equal registry_refs.github when present`);
    }
  }
  const toolsManifest = parseToolsManifest(item.tools_manifest_sha256, imageKey, version);
  return {
    version,
    ...(githubRef ? { image_ref: githubRef } : {}),
    digest,
    platforms,
    size_bytes: sizeBytes,
    registry_refs: refs,
    ...(toolsManifest ? { tools_manifest_sha256: toolsManifest } : {}),
  };
}

function detectSchema(value: Record<string, unknown>): 1 | 2 {
  const schema = value.schema;
  const numeric = value.schema_version;
  let detected: 1 | 2 | undefined;
  if (schema === RUNTIME_IMAGE_REGISTRY_SCHEMA_V1) detected = 1;
  else if (schema === RUNTIME_IMAGE_REGISTRY_SCHEMA_V2) detected = 2;
  else if (schema !== undefined) invalid("unknown registry schema");
  if (numeric !== undefined) {
    if (numeric !== 1 && numeric !== 2) invalid("unknown registry schema_version");
    if (detected !== undefined && detected !== numeric) invalid("schema and schema_version disagree");
    detected = numeric;
  }
  if (detected === undefined) invalid("registry schema is required");
  return detected;
}

/** Normalize v1/v2 payloads into one in-memory shape used by Scheduler. */
export function parseRuntimeImageRegistry(
  raw: unknown,
  policy: RuntimeImageRegistryPolicy = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
): RuntimeImageRegistry {
  const validatedPolicy = validateRuntimeImageRegistryPolicy(policy);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("registry must be an object");
  const value = raw as Record<string, unknown>;
  const schemaVersion = detectSchema(value);
  if (!Array.isArray(value.images)) invalid("registry images must be an array");
  const source = parseMetadataSource(value.source);
  const seenImages = new Set<string>();
  const seenNormalizedRefs = new Map<string, {
    schemaVersion: 1 | 2;
    imageKey: string;
    platforms: Set<string> | null;
  }>();
  const images = value.images.map((entry, imageIndex): RuntimeImageRegistryImage => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`images[${imageIndex}] is invalid`);
    const image = entry as Record<string, unknown>;
    const base = parseImageBase(image, imageIndex);
    if (seenImages.has(base.image_key)) invalid(`duplicate image_key ${base.image_key}`);
    seenImages.add(base.image_key);
    if (!Array.isArray(image.versions)) invalid(`${base.image_key} versions must be an array`);
    const seenVersions = new Set<string>();
    const versions = image.versions.map((entryVersion, versionIndex): RuntimeImageRegistryVersion => {
      if (!entryVersion || typeof entryVersion !== "object" || Array.isArray(entryVersion)) invalid(`${base.image_key} versions[${versionIndex}] is invalid`);
      const parsed = schemaVersion === 1
        ? parseV1Version(entryVersion as Record<string, unknown>, base.image_key, versionIndex, validatedPolicy)
        : parseV2Version(entryVersion as Record<string, unknown>, base.image_key, versionIndex, validatedPolicy);
      if (seenVersions.has(parsed.version)) invalid(`${base.image_key} contains duplicate version ${parsed.version}`);
      seenVersions.add(parsed.version);
      for (const ref of Object.values(parsed.registry_refs ?? {})) {
        const existing = seenNormalizedRefs.get(ref);
        if (!existing) {
          seenNormalizedRefs.set(ref, {
            schemaVersion,
            imageKey: base.image_key,
            platforms: parsed.platforms ? new Set(parsed.platforms) : null,
          });
          continue;
        }
        // The legacy v1 generator historically emitted one version per
        // platform while both entries pointed at the same multi-platform
        // manifest digest. Preserve exactly that compatibility alias, but
        // reject every other duplicate spelling or ownership boundary.
        const currentPlatforms = parsed.platforms;
        if (schemaVersion !== 1 || existing.schemaVersion !== 1 || existing.imageKey !== base.image_key
          || !existing.platforms || !currentPlatforms || currentPlatforms.length === 0
          || currentPlatforms.some((platform) => existing.platforms!.has(platform))) {
          invalid(`${base.image_key} contains duplicate normalized registry ref (${ref})`);
        }
        for (const platform of currentPlatforms) existing.platforms.add(platform);
      }
      return parsed;
    });
    return { ...base, versions };
  });
  return {
    schema: schemaVersion === 1 ? RUNTIME_IMAGE_REGISTRY_SCHEMA_V1 : RUNTIME_IMAGE_REGISTRY_SCHEMA_V2,
    ...(schemaVersion === 2 ? { schema_version: 2 as const } : {}),
    images,
    ...(source ? { source } : {}),
  };
}

/** Return the legacy/current projection without inventing another channel. */
export function legacyRuntimeImageRef(version: RuntimeImageRegistryVersion): string | null {
  return version.image_ref ?? null;
}
