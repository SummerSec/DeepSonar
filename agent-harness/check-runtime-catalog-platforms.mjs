import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRuntimePlatformDigests,
  resolveRuntimePlatformSources,
  samePlatformDigests,
} from "./runtime-platform-manifests.mjs";

const IMAGE_KEYS = [
  ...["chrome", "clickhouse"].flatMap((family) =>
    ["audit", "test", "fuzz"].map((role) => `deepsonar-${family}-${role}`)),
  "deepsonar-reverse",
];
const PLATFORMS = ["linux/amd64", "linux/arm64"];
const CHANNELS = ["github", "dockerhub", "aliyun-acr"];

function fail(message) {
  throw new Error(`check-runtime-catalog-platforms: ${message}`);
}

// Keep release selection aligned with compareRuntimeImageVersionLabels and
// selectLatestRuntimeImagePullItems in apps/scheduler/src/runtime-images.ts.
export function compareCatalogVersionLabels(left, right) {
  const tokenize = (value) => value.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const a = tokenize(left);
  const b = tokenize(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index];
    const bv = b[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av < bv ? -1 : 1;
      continue;
    }
    if (typeof av === "number") return 1;
    if (typeof bv === "number") return -1;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function selectedVersion(versions, channel, platform) {
  return versions.filter((version) => version.platforms?.includes(platform) &&
    typeof version.registry_refs?.[channel] === "string").sort((left, right) =>
    compareCatalogVersionLabels(right.version, left.version) || right.digest.localeCompare(left.digest))[0];
}

// Native-smoke artifacts are the identity evidence. Check the catalog's latest
// bulk-pull selection, not historical/frozen Jobs. Do not trust cache-hit flags,
// a catalog version label, or descriptor-provided platform_digests.
export function assertCatalogMatchesRuntimeSources({ catalog, builds, repositoryPrefix, inspectManifest }) {
  if (!repositoryPrefix || /[\s@]/.test(repositoryPrefix)) fail("repository prefix is required");
  if (!Array.isArray(builds) || builds.length !== IMAGE_KEYS.length * PLATFORMS.length) {
    fail("expected all fourteen native-smoke build artifacts");
  }
  const sourcesByImage = new Map(IMAGE_KEYS.map((key) => [key, {}]));
  for (const build of builds) {
    const sources = sourcesByImage.get(build.image_key);
    if (!sources || !PLATFORMS.includes(build.platform) || !/^sha256:[0-9a-f]{64}$/.test(build.digest)) {
      fail("invalid native-smoke build artifact");
    }
    if (Object.hasOwn(sources, build.platform)) fail(`duplicate ${build.image_key} ${build.platform} artifact`);
    sources[build.platform] = `${repositoryPrefix}/${build.image_key}@${build.digest}`;
  }
  for (const [imageKey, sources] of sourcesByImage) {
    if (Object.keys(sources).length !== PLATFORMS.length) fail(`missing ${imageKey} native-smoke platform`);
    const images = catalog?.images?.filter((image) => image.image_key === imageKey) ?? [];
    if (images.length !== 1 || !Array.isArray(images[0].versions) || images[0].versions.length === 0) {
      fail(`missing or ambiguous ${imageKey} catalog versions`);
    }
    const versions = images[0].versions;
    if (new Set(versions.map((version) => version.version)).size !== versions.length) fail(`${imageKey} duplicate catalog version`);
    const expected = resolveRuntimePlatformSources(sources, inspectManifest).platformDigests;
    for (const channel of CHANNELS) {
      if (channel !== "github" && !versions.some((version) => version.registry_refs?.[channel])) continue;
      const version = selectedVersion(versions, channel, PLATFORMS[0]);
      if (!version || version !== selectedVersion(versions, channel, PLATFORMS[1])) {
        fail(`${imageKey} ${channel} must select one canonical version for both tested platforms`);
      }
      if (version.platforms.length !== PLATFORMS.length || new Set(version.platforms).size !== PLATFORMS.length) {
        fail(`${imageKey} catalog platform mismatch`);
      }
      if (version.registry_evidence?.github?.available !== true ||
          version.image_ref !== version.registry_refs?.github) fail(`${imageKey} missing canonical GitHub evidence`);
      const evidence = version.registry_evidence?.[channel];
      const ref = version.registry_refs?.[channel];
      if (evidence?.available !== true || ref !== evidence.ref ||
          !ref?.endsWith(`@${version.digest}`) || evidence.inspect_digest !== version.digest) {
        fail(`${imageKey} ${channel} canonical digest/evidence mismatch`);
      }
      const actual = inspectRuntimePlatformDigests(ref, PLATFORMS, inspectManifest);
      if (!samePlatformDigests(actual, expected)) fail(`${imageKey} ${channel} catalog does not match tested platform manifests`);
    }
  }
  return IMAGE_KEYS.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const option = (name) => argv[argv.indexOf(name) + 1];
  if (!argv.includes("--catalog") || !argv.includes("--repository-prefix")) fail("--catalog and --repository-prefix are required");
  const builds = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--artifacts") continue;
    const directory = argv[++index];
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
      builds.push(JSON.parse(readFileSync(join(directory, file), "utf8")));
    }
  }
  const count = assertCatalogMatchesRuntimeSources({
    catalog: JSON.parse(readFileSync(option("--catalog"), "utf8")),
    builds,
    repositoryPrefix: option("--repository-prefix"),
  });
  console.log(`Verified ${count} catalog products against all fourteen native-smoke platform manifests`);
}
