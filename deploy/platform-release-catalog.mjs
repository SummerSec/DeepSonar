// Single authoritative definition of the published platform-image registry
// channels and of how a deployment resolves them to concrete digest refs.
//
// #842: deploy CLIs must never hard-code a channel. A host that deployed from
// Aliyun ACR has to keep pulling from ACR after an upgrade; switching channels
// is an explicit operator decision, not an upgrade side effect.
//
// Imported by agent-harness/generate-runtime-image-registry.mjs (release side)
// and by deploy/platform-upgrade-*.mjs (host side). Depends on nothing.

export const PLATFORM_IMAGE_CHANNELS = Object.freeze({
  github: Object.freeze({ host: "ghcr.io", namespace: "summersec" }),
  dockerhub: Object.freeze({ host: "docker.io", namespace: "sumsec" }),
  "aliyun-acr": Object.freeze({
    host: "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com",
    namespace: "summersec",
  }),
});

/** Channel names in their canonical (stable) order. */
export const PLATFORM_IMAGE_CHANNEL_NAMES = Object.freeze(Object.keys(PLATFORM_IMAGE_CHANNELS));

export const PLATFORM_IMAGE_KEYS = Object.freeze(["scheduler", "web", "image-admission"]);

const PLATFORM_SERVICE_SET = new Set(PLATFORM_IMAGE_KEYS);
const CHANNEL_SET = new Set(PLATFORM_IMAGE_CHANNEL_NAMES);

/** Deployment env variable that selects one platform service image. */
export const platformImageKey = (service) =>
  `DEEPSONAR_${service.replaceAll("-", "_").toUpperCase()}_IMAGE`;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Repository (everything before `@`) of a digest reference; empty when unusable. */
export function repositoryOf(ref) {
  if (typeof ref !== "string") {
    return "";
  }
  const at = ref.indexOf("@");
  return at <= 0 ? "" : ref.slice(0, at);
}

/**
 * Accept only official immutable references for the given platform service:
 * `<official-host>/<official-namespace>/deepsonar-<service>@sha256:<64 hex>`.
 */
export function platformImageRefPattern(service) {
  // Only the fixed platform services reach the RegExp constructor; the service
  // list is a closed constant, never operator input.
  if (!PLATFORM_SERVICE_SET.has(service)) {
    throw resolutionError("UPGRADE_REGISTRY_REF_INVALID", `unknown platform service ${String(service)}`);
  }
  const repositories = PLATFORM_IMAGE_CHANNEL_NAMES.map((channel) => {
    const { host, namespace } = PLATFORM_IMAGE_CHANNELS[channel];
    return `${escapeRegExp(host)}/${escapeRegExp(namespace)}`;
  });
  return new RegExp(
    `^(?:${repositories.join("|")})/deepsonar-${escapeRegExp(service)}@sha256:[a-f0-9]{64}$`,
  );
}

export const isPlatformImageRef = (service, ref) => {
  if (typeof ref !== "string" || !PLATFORM_SERVICE_SET.has(service)) {
    return false;
  }
  return platformImageRefPattern(service).test(ref);
};

/** Comma-joined channel list for operator-facing error messages. */
export const describePlatformImageChannels = () => PLATFORM_IMAGE_CHANNEL_NAMES.join(", ");

function resolutionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertResolvableTarget(target, channel) {
  if (!target || typeof target !== "object") {
    throw resolutionError("UPGRADE_TARGET_INVALID", "upgrade target is missing");
  }
  if (typeof target.version !== "string" || !/^\d+\.\d+\.\d+$/.test(target.version)) {
    throw resolutionError("UPGRADE_TARGET_INVALID", "upgrade target version is invalid");
  }
  if (channel !== undefined && !CHANNEL_SET.has(channel)) {
    throw resolutionError(
      "UPGRADE_REGISTRY_CHANNEL_INVALID",
      `unsupported registry channel ${String(channel)}; expected one of ${describePlatformImageChannels()}`,
    );
  }
}

function channelRefsFor(target, service) {
  const refs = target.images?.[service]?.registry_refs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    throw resolutionError(
      "UPGRADE_TARGET_IMAGES_INVALID",
      `release catalog has no registry references for ${service}`,
    );
  }
  return refs;
}

/**
 * Describe the current deployment's channel as a repository, failing closed
 * when `.env` holds something that is not an official digest reference.
 */
function currentRepositoryFor(currentValues, key) {
  const repository = repositoryOf(currentValues?.[key]);
  if (!repository) {
    throw resolutionError(
      "UPGRADE_REGISTRY_CHANNEL_UNRESOLVED",
      `cannot resolve the registry channel of ${key}: it is not an official immutable digest reference`,
    );
  }
  return repository;
}

function unresolvedMessage(service, channel, repository) {
  if (channel) {
    return `release catalog does not publish ${service} on the ${channel} channel`;
  }
  return `release catalog has no unique channel for ${service} at ${repository}`;
}

/**
 * Resolve target platform image values from a release catalog platform object.
 *
 * Default policy (#842): keep the registry channel the deployment already uses.
 * The current value's repository selects exactly one published channel; zero or
 * multiple matches fail closed instead of silently falling back to GitHub.
 *
 * An explicit `channel` is the only way to change registry, and it must be
 * published for every platform service — partial channel switches are refused.
 *
 * @param {{version: string, images: Record<string, {registry_refs: Record<string, string>}>}} target
 * @param {Record<string, string>} currentValues validated values of the current deployment `.env`
 * @param {{channel?: string}} [options]
 * @returns {{DEEPSONAR_VERSION: string} & Record<string, string>}
 */
export function resolvePlatformImageValues(target, currentValues, { channel } = {}) {
  assertResolvableTarget(target, channel);
  const values = { DEEPSONAR_VERSION: target.version };
  for (const service of PLATFORM_IMAGE_KEYS) {
    const key = platformImageKey(service);
    const refs = channelRefsFor(target, service);
    const repository = channel ? undefined : currentRepositoryFor(currentValues, key);
    const candidates = channel
      ? [refs[channel]].filter((ref) => ref !== undefined)
      : Object.values(refs).filter((ref) => repositoryOf(ref) === repository);
    if (candidates.length !== 1) {
      throw resolutionError(
        "UPGRADE_REGISTRY_CHANNEL_UNRESOLVED",
        unresolvedMessage(service, channel, repository),
      );
    }
    if (!isPlatformImageRef(service, candidates[0])) {
      throw resolutionError(
        "UPGRADE_REGISTRY_REF_INVALID",
        `release catalog ${service} reference is not an official immutable digest reference`,
      );
    }
    values[key] = candidates[0];
  }
  return values;
}
// probe(#836): sample 1 — measures the draft fast path only.

// probe(#836): sample 2

// probe(#836): sample 3
