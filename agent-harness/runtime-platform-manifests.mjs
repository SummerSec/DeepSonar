import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?$/;
const IMAGE_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function fail(message) {
  throw new Error(`runtime-platform-manifests: ${message}`);
}

export function immutableImageRepository(ref) {
  if (typeof ref !== "string" || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(ref) || ref.includes("://")) {
    fail("an immutable image reference is required");
  }
  return ref.slice(0, ref.lastIndexOf("@"));
}

export function inspectRuntimeManifest(ref) {
  immutableImageRepository(ref);
  return JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", ref], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, windowsHide: true,
  }));
}

// A wrapper/index digest includes attestations and annotations. Only runnable
// platform manifest digests identify the exact image payloads native smoke ran.
export function runnablePlatformDigests(manifest, expectedPlatforms) {
  if (!Array.isArray(expectedPlatforms) || expectedPlatforms.length === 0 ||
      expectedPlatforms.some((platform) => !PLATFORM_RE.test(platform)) ||
      new Set(expectedPlatforms).size !== expectedPlatforms.length) fail("invalid expected platforms");
  if (!Array.isArray(manifest?.manifests)) fail("expected an OCI index with platform descriptors");
  const digests = {};
  for (const descriptor of manifest.manifests) {
    if (descriptor?.artifactType || descriptor?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") continue;
    const { os, architecture, variant } = descriptor?.platform ?? {};
    const platform = `${os}/${architecture}${variant ? `/${variant}` : ""}`;
    if (!expectedPlatforms.includes(platform)) fail(`unexpected runnable platform ${platform}`);
    if (Object.hasOwn(digests, platform)) fail(`ambiguous runnable descriptors for ${platform}`);
    if (!DIGEST_RE.test(descriptor.digest) || !IMAGE_MEDIA_TYPES.has(descriptor.mediaType)) {
      fail(`invalid runnable manifest descriptor for ${platform}`);
    }
    digests[platform] = descriptor.digest;
  }
  for (const platform of expectedPlatforms) {
    if (!Object.hasOwn(digests, platform)) fail(`missing runnable descriptor for ${platform}`);
  }
  return digests;
}

export function inspectRuntimePlatformDigests(ref, platforms, inspectManifest = inspectRuntimeManifest) {
  immutableImageRepository(ref);
  return runnablePlatformDigests(inspectManifest(ref), platforms);
}

export function resolveRuntimePlatformSources(platformSources, inspectManifest = inspectRuntimeManifest) {
  if (!platformSources || typeof platformSources !== "object" || Array.isArray(platformSources) ||
      Object.keys(platformSources).length === 0) fail("platform sources are required");
  const platformDigests = {};
  const sourceRefs = [];
  for (const [platform, ref] of Object.entries(platformSources)) {
    const repository = immutableImageRepository(ref);
    const digest = inspectRuntimePlatformDigests(ref, [platform], inspectManifest)[platform];
    platformDigests[platform] = digest;
    sourceRefs.push(`${repository}@${digest}`);
  }
  return { platformDigests, sourceRefs };
}

export function samePlatformDigests(left, right) {
  const platforms = Object.keys(left).sort();
  return platforms.length === Object.keys(right).length &&
    platforms.every((platform) => left[platform] === right[platform]);
}

export function parsePlatformSources(argv) {
  const sources = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--source") continue;
    const value = argv[++index] ?? "";
    const separator = value.indexOf("=");
    const platform = value.slice(0, separator);
    if (separator < 0 || !PLATFORM_RE.test(platform) || Object.hasOwn(sources, platform)) {
      fail("each --source must be a unique platform=immutable-reference");
    }
    const ref = value.slice(separator + 1);
    immutableImageRepository(ref);
    sources[platform] = ref;
  }
  return Object.keys(sources).length ? sources : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { sourceRefs } = resolveRuntimePlatformSources(parsePlatformSources(process.argv.slice(2)));
  console.log(sourceRefs.join("\n"));
}
