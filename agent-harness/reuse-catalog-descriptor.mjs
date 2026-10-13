import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRuntimePlatformDigests,
  parsePlatformSources,
  resolveRuntimePlatformSources,
  samePlatformDigests,
} from "./runtime-platform-manifests.mjs";

export const CATALOG_REUSE_MISS_EXIT = 2;

export class CatalogReuseMiss extends Error {
  constructor(message) {
    super(`reuse-catalog-descriptor: ${message}`);
    this.name = "CatalogReuseMiss";
    this.exitCode = CATALOG_REUSE_MISS_EXIT;
  }
}

export function isCatalogReuseMiss(error) {
  return error instanceof CatalogReuseMiss || error?.name === "CatalogReuseMiss";
}

function fail(message) {
  throw new Error(`reuse-catalog-descriptor: ${message}`);
}

function miss(message) {
  throw new CatalogReuseMiss(message);
}

function arg(name, argv) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) fail(`missing ${name}`);
  return argv[index + 1];
}

function optionalArg(name, argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function descriptorFromCatalogVersion(imageKey, version) {
  if (!version || typeof version !== "object") fail(`${imageKey} catalog version is missing`);
  const evidence = version.registry_evidence;
  if (!evidence || typeof evidence !== "object") fail(`${imageKey} catalog version is missing registry_evidence`);
  return {
    image_key: imageKey,
    version: version.version,
    digest: version.digest,
    platforms: version.platforms,
    size_bytes: version.size_bytes,
    registry_records: evidence,
    registry_refs: version.registry_refs,
    ghcr_ref: version.image_ref ?? version.registry_refs?.github,
    ...(version.tools_manifest_sha256 ? { tools_manifest_sha256: version.tools_manifest_sha256 } : {}),
  };
}

export function reuseCatalogDescriptor({ catalog, imageKey, digest, platformSources, inspectManifest }) {
  if (Boolean(digest) === Boolean(platformSources)) fail("provide exactly one digest or platform sources identity");
  if (digest && !/^sha256:[0-9a-f]{64}$/.test(digest)) fail("invalid digest identity");
  const expected = platformSources
    ? resolveRuntimePlatformSources(platformSources, inspectManifest).platformDigests
    : null;
  const image = catalog?.images?.find((item) => item.image_key === imageKey);
  if (!image) miss(`${imageKey} is not in the previous catalog`);
  const versions = Array.isArray(image.versions) ? image.versions : [];
  const match = versions.find((version) => {
    if (digest) return version.digest === digest;
    const ref = version.image_ref ?? version.registry_refs?.github;
    if (!ref?.endsWith(`@${version.digest}`)) fail(`${imageKey} catalog reference/digest mismatch`);
    if (!Array.isArray(version.platforms) || version.platforms.length !== Object.keys(expected).length ||
        new Set(version.platforms).size !== version.platforms.length ||
        version.platforms.some((platform) => !Object.hasOwn(expected, platform))) {
      fail(`${imageKey} catalog platforms do not match tested platforms`);
    }
    const actual = inspectRuntimePlatformDigests(ref, version.platforms, inspectManifest);
    return samePlatformDigests(actual, expected);
  });
  if (!match) {
    miss(digest
      ? `${imageKey} previous catalog has no version with digest ${digest}`
      : `${imageKey} previous catalog has no version with matching tested platform manifests`);
  }
  if (digest && match.digest !== digest) fail(`${imageKey} reused digest mismatch`);
  return descriptorFromCatalogVersion(imageKey, match);
}

function main(argv = process.argv.slice(2)) {
  try {
    const probe = argv.includes("--probe");
    const imageKey = arg("--image-key", argv);
    const output = probe ? optionalArg("--out", argv) : arg("--out", argv);
    const catalogPath = optionalArg("--catalog", argv)
      ?? fileURLToPath(new URL("../deploy/runtime-image-registry.json", import.meta.url));
    const digest = optionalArg("--digest", argv);
    const platformSources = parsePlatformSources(argv);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const descriptor = reuseCatalogDescriptor({ catalog, imageKey, digest, platformSources });
    if (probe && !output) {
      console.log(`reusable: ${imageKey} ${descriptor.version}`);
      return;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(descriptor, null, 2)}\n`);
    console.log(`image build unchanged; version kept: ${imageKey} ${descriptor.version}`);
  } catch (error) {
    if (isCatalogReuseMiss(error)) {
      console.error(error.message);
      process.exitCode = CATALOG_REUSE_MISS_EXIT;
      return;
    }
    throw error;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
