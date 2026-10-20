import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPlatformManifest } from "./generate-runtime-image-registry.mjs";
import { inspectRuntimePlatformDigests, samePlatformDigests } from "./runtime-platform-manifests.mjs";

export function verifyPlatformRelease(catalog, inspectManifest) {
  const platform = assertPlatformManifest(catalog.platform, catalog.platform_version);
  for (const [key, image] of Object.entries(platform.images)) {
    for (const [channel, ref] of Object.entries(image.registry_refs)) {
      const actual = inspectRuntimePlatformDigests(ref, image.platforms, inspectManifest);
      if (!samePlatformDigests(actual, image.child_digests)) throw new Error(`${key} ${channel} platform payload mismatch`);
    }
  }
}

export function platformEnvExample(catalog, contents) {
  const platform = assertPlatformManifest(catalog.platform, catalog.platform_version);
  const assignmentPattern = (name) => new RegExp(`^[ \t]*(?:export[ \t]+)?${name}(?:[ \t]*[=:]|[ \t]*$)`, "gm");
  if (assignmentPattern("DEEPSONAR_IMAGE_TAG").test(contents)) throw new Error("obsolete image tag variable in deployment example");
  const values = { DEEPSONAR_VERSION: platform.version };
  for (const key of Object.keys(platform.images)) values[`DEEPSONAR_${key.replaceAll("-", "_").toUpperCase()}_IMAGE`] = undefined;
  for (const name of Object.keys(values)) {
    const pattern = new RegExp(`^${name}=([^\\r\\n]*)$`, "gm");
    const declarations = [...contents.matchAll(assignmentPattern(name))];
    const canonical = [...contents.matchAll(pattern)];
    if (declarations.length !== 1 || canonical.length !== 1) throw new Error(`expected exactly one canonical ${name} assignment`);
    if (name !== "DEEPSONAR_VERSION") {
      const key = name.slice("DEEPSONAR_".length, -"_IMAGE".length).toLowerCase().replaceAll("_", "-");
      const current = canonical[0][1];
      if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(current)) throw new Error(`${name} must contain an immutable image reference`);
      const repository = current.slice(0, current.indexOf("@"));
      const matches = Object.values(platform.images[key].registry_refs).filter(ref => ref.slice(0, ref.indexOf("@")) === repository);
      if (matches.length !== 1) throw new Error(`${name} current registry channel is unavailable or does not match the release`);
      values[name] = matches[0];
    }
    contents = contents.replace(pattern, `${name}=${values[name]}`);
  }
  return contents;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, catalogPath, envPath] = process.argv.slice(2);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (mode === "--check") verifyPlatformRelease(catalog);
  else if (mode === "--write-env" && envPath) writeFileSync(envPath, platformEnvExample(catalog, readFileSync(envPath, "utf8")));
  else throw new Error("usage: --check <catalog> | --write-env <catalog> <env-example>");
}
