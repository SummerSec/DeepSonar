import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const CANONICAL_OM_ROOT = "/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory";
export const CANONICAL_WRAPPER = "/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts";
export const CANONICAL_MANIFEST = "/opt/deepsonar/tool-manifest.json";
export const CANONICAL_PACKAGE_ROOT = "/opt/deepsonar/pi-extensions";

function readJson(file) {
  assert.ok(existsSync(file), `required image file is missing: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`invalid image JSON metadata: ${file}`, { cause });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolvePiPackage(binary = "pi") {
  const command = path.isAbsolute(binary) ? binary : (process.env.PATH ?? "").split(path.delimiter)
    .map((directory) => path.join(directory, binary)).find((candidate) => existsSync(candidate));
  assert.ok(command, "Pi CLI is not installed");
  const executable = realpathSync(command);
  let directory = path.dirname(executable);
  let packageJson;
  let metadata;
  // The canonical npm bin lives under dist/bundle. Resolve its owning
  // manifest instead of assuming a fixed distance from the executable.
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(directory, "package.json");
    if (existsSync(candidate)) {
      const found = readJson(candidate);
      if (found.name === "@earendil-works/pi-coding-agent") {
        packageJson = candidate;
        metadata = found;
        break;
      }
    }
    directory = path.dirname(directory);
  }
  assert.ok(packageJson && metadata, "Pi executable has no canonical owning package");
  assert.equal(typeof metadata.bin?.pi, "string", "Pi package must declare its CLI entry");
  assert.equal(realpathSync(path.resolve(path.dirname(packageJson), metadata.bin.pi)), executable,
    "Pi executable must match its package's declared bin");
  const versionOutput = execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 5000 }).trim();
  return { executable, packageJson, metadata, versionOutput };
}

/**
 * Verify the immutable production installation before the real-RPC fixture can
 * create a loopback gateway. `sourceRoot` is test input only; it is never
 * copied into an image path or used as the extension import at runtime.
 */
export function assertInstalledPiImage({
  packageRoot = CANONICAL_PACKAGE_ROOT,
  omRoot = CANONICAL_OM_ROOT,
  wrapperPath = CANONICAL_WRAPPER,
  manifestPath = CANONICAL_MANIFEST,
  sourceRoot = "/tmp/deepsonar-tests",
  expectedWrapperSha256,
  resolvePi = resolvePiPackage,
} = {}) {
  const sourceRootValue = sourceRoot;
  assert.equal(process.env.DEEPSONAR_PI_OM_PACKAGE, undefined, "image proof forbids DEEPSONAR_PI_OM_PACKAGE overrides");

  const config = readJson(path.join(sourceRootValue, "runtime-images.json"));
  const manifest = readJson(manifestPath);
  assert.equal(manifest.contract, config.contract, "image manifest contract drift");
  assert.equal(manifest.image_key, config.toolsets[manifest.toolset]?.imageKey, "image manifest toolset drift");
  const { sha256: manifestHash, ...manifestWithoutHash } = manifest;
  assert.equal(manifestHash, sha256(JSON.stringify(manifestWithoutHash)), "image manifest sha256 mismatch");

  const expectedPackage = config.piExtensions?.["pi-observational-memory"];
  assert.ok(expectedPackage, "runtime-images.json has no canonical observational-memory package");
  assert.equal(expectedPackage.package, "pi-observational-memory");
  assert.equal(expectedPackage.version, "3.1.4");
  assert.equal(expectedPackage.license, "MIT");
  assert.equal(expectedPackage.entry, "src/index.ts");
  assert.match(expectedPackage.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u, "canonical package integrity is not SHA-512");

  const packageJsonPath = path.join(omRoot, "package.json");
  const packageJson = readJson(packageJsonPath);
  assert.equal(packageJson.name, expectedPackage.package, "installed OM package name mismatch");
  assert.equal(packageJson.version, expectedPackage.version, "installed OM package version mismatch");
  assert.equal(packageJson.license, expectedPackage.license, "installed OM package license mismatch");
  const declaredPiEntries = packageJson.pi?.extensions;
  assert.ok(Array.isArray(declaredPiEntries), "installed OM package has no pi.extensions declaration");
  const normalizePiEntry = (value) => typeof value === "string" ? value.replace(/^\.\//u, "") : value;
  assert.ok(declaredPiEntries.some((entry) => normalizePiEntry(entry) === expectedPackage.entry), "installed OM package pi.extensions does not declare src/index.ts");
  assert.ok(existsSync(path.join(omRoot, expectedPackage.entry)), "canonical OM source entry is missing");

  const lock = readJson(path.join(packageRoot, "package-lock.json"));
  const locked = lock.packages?.["node_modules/pi-observational-memory"];
  assert.ok(locked, "image package-lock has no canonical OM entry");
  assert.equal(locked.version, expectedPackage.version, "package-lock OM version mismatch");
  assert.equal(locked.integrity, expectedPackage.integrity, "package-lock OM integrity mismatch");
  assert.equal(
    locked.resolved,
    `https://registry.npmjs.org/pi-observational-memory/-/pi-observational-memory-${expectedPackage.version}.tgz`,
    "package-lock OM resolved URL mismatch",
  );

  const manifestPackage = manifest.tools?.find((tool) => tool.name === "pi-observational-memory");
  assert.ok(manifestPackage, "image manifest has no canonical OM package");
  assert.equal(manifestPackage.source, "npm", "manifest OM package source mismatch");
  assert.equal(manifestPackage.package, expectedPackage.package, "manifest OM package identity mismatch");
  assert.equal(manifestPackage.version, expectedPackage.version, "manifest OM version mismatch");
  assert.equal(manifestPackage.integrity, expectedPackage.integrity, "manifest OM integrity mismatch");
  assert.equal(manifestPackage.license, expectedPackage.license, "manifest OM license mismatch");
  assert.equal(manifestPackage.entry, expectedPackage.entry, "manifest OM entry mismatch");

  const wrapperBytes = readFileSync(wrapperPath);
  const wrapperEntry = manifest.tools?.find((tool) => tool.name === "pi-observational-memory-governed");
  assert.ok(wrapperEntry, "image manifest has no governed OM wrapper");
  assert.equal(wrapperEntry.source, "repository-wrapper", "manifest wrapper source is not canonical");
  assert.equal(wrapperEntry.wrapper_path, wrapperPath, "manifest wrapper path is not canonical");
  assert.equal(wrapperEntry.sha256, sha256(wrapperBytes), "installed wrapper hash differs from manifest");
  assert.match(expectedWrapperSha256 ?? "", /^[a-f0-9]{64}$/u, "root wrapper SHA-256 is required for image proof");
  assert.equal(wrapperEntry.sha256, expectedWrapperSha256, "installed wrapper hash differs from repository source");

  const pi = resolvePi();
  const expectedPi = config.npm?.["@earendil-works/pi-coding-agent"];
  assert.ok(expectedPi, "runtime-images.json has no canonical Pi CLI package");
  assert.equal(pi.metadata.name, "@earendil-works/pi-coding-agent", "installed Pi CLI package name mismatch");
  assert.equal(pi.metadata.version, expectedPi.version, "installed Pi CLI version mismatch");
  assert.match(pi.versionOutput, new RegExp(`(?:^|\\s)v?${expectedPi.version.replaceAll(".", "\\.")}(?:\\s|$)`), "pi --version does not match the declared version");

  return {
    package: { name: packageJson.name, version: packageJson.version, integrity: locked.integrity, entry: expectedPackage.entry },
    pi: { executable: pi.executable, version: pi.metadata.version },
    wrapper: { path: wrapperPath, sha256: wrapperEntry.sha256 },
    manifest: { path: manifestPath, sha256: manifestHash },
  };
}
