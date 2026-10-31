import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertInstalledPiImage, resolvePiPackage } from "./pi-image-packaging.mjs";

const repo = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const sourceRoot = path.join(repo, "agent-harness");
let sourceConfig;
try {
  sourceConfig = JSON.parse(readFileSync(path.join(sourceRoot, "runtime-images.json"), "utf8"));
} catch (cause) {
  throw new Error("Pi image packaging tests require a valid runtime-images catalog", { cause });
}
const sourceWrapper = readFileSync(path.join(sourceRoot, "pi-observational-memory-governed.ts"));
const sourcePackage = sourceConfig.piExtensions["pi-observational-memory"];
const fakePi = () => ({
  executable: "/usr/local/bin/pi",
  metadata: { name: "@earendil-works/pi-coding-agent", version: sourceConfig.npm["@earendil-works/pi-coding-agent"].version },
  versionOutput: "pi 1.4.0",
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rewriteManifest(paths, mutate) {
  const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  mutate(manifest);
  const { sha256: _ignored, ...body } = manifest;
  manifest.sha256 = hash(JSON.stringify(body));
  writeFileSync(paths.manifestPath, JSON.stringify(manifest));
}

function rewritePackage(paths, mutate) {
  const packagePath = path.join(paths.omRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  mutate(packageJson);
  writeFileSync(packagePath, JSON.stringify(packageJson));
}

function rewriteLock(paths, mutate) {
  const lockPath = path.join(paths.packageRoot, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  mutate(lock.packages["node_modules/pi-observational-memory"]);
  writeFileSync(lockPath, JSON.stringify(lock));
}

function expectReject(paths, expected, resolvePi = fakePi) {
  assert.throws(
    () => assertInstalledPiImage({ ...paths, sourceRoot, expectedWrapperSha256: hash(sourceWrapper), resolvePi }),
    expected,
  );
}

function fixture({ missingPackage = false, missingWrapper = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-packaging-"));
  const packageRoot = path.join(root, "pi-extensions");
  const omRoot = path.join(packageRoot, "node_modules", "pi-observational-memory");
  const wrapperPath = path.join(packageRoot, "deepsonar-observational-memory.ts");
  const manifestPath = path.join(root, "tool-manifest.json");
  mkdirSync(path.join(omRoot, "src"), { recursive: true });
  if (!missingPackage) {
    writeFileSync(path.join(omRoot, "package.json"), JSON.stringify({
      name: sourcePackage.package,
      version: sourcePackage.version,
      license: sourcePackage.license,
      pi: { extensions: [`./${sourcePackage.entry}`] },
    }));
    writeFileSync(path.join(omRoot, sourcePackage.entry), "export {};");
  }
  writeFileSync(path.join(packageRoot, "package-lock.json"), JSON.stringify({
    packages: {
      "node_modules/pi-observational-memory": {
        version: sourcePackage.version,
        resolved: `https://registry.npmjs.org/pi-observational-memory/-/pi-observational-memory-${sourcePackage.version}.tgz`,
        integrity: sourcePackage.integrity,
      },
    },
  }));
  if (!missingWrapper) writeFileSync(wrapperPath, sourceWrapper);
  const manifest = {
    contract: sourceConfig.contract,
    image_key: "deepsonar-base",
    toolset: "base",
    platforms: sourceConfig.platforms,
    base_image: sourceConfig.baseImage,
    tools: [
      { name: "pi-observational-memory", source: "npm", package: sourcePackage.package, version: sourcePackage.version, integrity: sourcePackage.integrity, entry: sourcePackage.entry, license: sourcePackage.license },
      { name: "pi-observational-memory-governed", source: "repository-wrapper", wrapper_path: wrapperPath, sha256: hash(sourceWrapper) },
    ],
  };
  manifest.sha256 = hash(JSON.stringify(manifest));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, packageRoot, omRoot, wrapperPath, manifestPath };
}

test("resolves the manifest-declared bundled Pi executable and rejects another entry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-cli-identity-"));
  try {
    const bin = path.join(root, "dist/bundle/cli.js");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'console.log("1.4.0");');
    const metadata = { name: "@earendil-works/pi-coding-agent", version: "1.4.0", type: "module", bin: { pi: "dist/bundle/cli.js" } };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(metadata));
    const found = resolvePiPackage(bin);
    assert.equal(found.metadata.version, "1.4.0");
    assert.equal(found.versionOutput, "1.4.0");
    assert.equal(found.packageJson, path.join(root, "package.json"));
    writeFileSync(path.join(root, "dist/bundle/other.js"), 'console.log("1.4.0");');
    assert.throws(() => resolvePiPackage(path.join(root, "dist/bundle/other.js")), /declared bin/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts only the canonical installed OM package, wrapper, manifest and Pi identity", () => {
  const paths = fixture();
  try {
    const identity = assertInstalledPiImage({ ...paths, sourceRoot, expectedWrapperSha256: hash(sourceWrapper), resolvePi: fakePi });
    assert.equal(identity.package.version, "3.1.4");
    assert.equal(identity.pi.version, "1.4.0");
    assert.equal(identity.wrapper.sha256, hash(sourceWrapper));
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("refuses before Pi resolution when the canonical package is absent", () => {
  const paths = fixture({ missingPackage: true });
  try {
    assert.throws(() => assertInstalledPiImage({ ...paths, sourceRoot, resolvePi: () => { throw new Error("Pi must not start"); } }), /required image file is missing/);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("refuses before Pi resolution when the installed wrapper is absent", () => {
  const paths = fixture({ missingWrapper: true });
  try {
    assert.throws(() => assertInstalledPiImage({ ...paths, sourceRoot, resolvePi: () => { throw new Error("Pi must not start"); } }), /ENOENT|no such file/u);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("rejects tampered package-lock integrity and resolved URL", () => {
  for (const [field, expected] of [
    ["integrity", /package-lock OM integrity mismatch/u],
    ["resolved", /package-lock OM resolved URL mismatch/u],
  ]) {
    const paths = fixture();
    try {
      rewriteLock(paths, (locked) => { locked[field] = "tampered"; });
      expectReject(paths, expected);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }
});

test("rejects package entry, license, and manifest package identity drift", () => {
  const cases = [
    [(paths) => rewritePackage(paths, (pkg) => { pkg.pi.extensions = ["./src/other.ts"]; }), /pi\.extensions does not declare/u],
    [(paths) => rewritePackage(paths, (pkg) => { pkg.license = "Unknown"; }), /installed OM package license mismatch/u],
    [(paths) => rewriteManifest(paths, (manifest) => { manifest.tools.find((tool) => tool.name === "pi-observational-memory").package = "untrusted-package"; }), /manifest OM package identity mismatch/u],
    [(paths) => rewriteManifest(paths, (manifest) => { manifest.tools.find((tool) => tool.name === "pi-observational-memory").license = "Unknown"; }), /manifest OM license mismatch/u],
    [(paths) => rewriteManifest(paths, (manifest) => { manifest.tools.find((tool) => tool.name === "pi-observational-memory").entry = "src/other.ts"; }), /manifest OM entry mismatch/u],
  ];
  for (const [mutate, expected] of cases) {
    const paths = fixture();
    try {
      mutate(paths);
      expectReject(paths, expected);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }
});

test("rejects wrapper digest and Pi executable identity drift", () => {
  const wrapperPaths = fixture();
  try {
    rewriteManifest(wrapperPaths, (manifest) => { manifest.tools.find((tool) => tool.name === "pi-observational-memory-governed").sha256 = "0".repeat(64); });
    expectReject(wrapperPaths, /installed wrapper hash differs from manifest/u);
  } finally {
    rmSync(wrapperPaths.root, { recursive: true, force: true });
  }

  const metadataPaths = fixture();
  try {
    expectReject(metadataPaths, /installed Pi CLI package name mismatch/u, () => ({
      executable: "/usr/local/bin/pi",
      metadata: { name: "untrusted-pi", version: "1.4.0" },
      versionOutput: "pi 1.4.0",
    }));
  } finally {
    rmSync(metadataPaths.root, { recursive: true, force: true });
  }

  const versionPaths = fixture();
  try {
    expectReject(versionPaths, /pi --version does not match/u, () => ({
      executable: "/usr/local/bin/pi",
      metadata: { name: "@earendil-works/pi-coding-agent", version: "1.4.0" },
      versionOutput: "pi 1.3.9",
    }));
  } finally {
    rmSync(versionPaths.root, { recursive: true, force: true });
  }
});

test("the Docker smoke mounts harness code only and never replaces the installed wrapper", () => {
  const source = readFileSync(path.join(sourceRoot, "test-pi-rpc.mjs"), "utf8");
  const imageBranchStart = source.indexOf('if (process.argv.includes("--inside"))');
  const hostBranchStart = source.indexOf('} else if (process.env.DEEPSONAR_PI_BINARY)');
  const imageBranch = source.slice(imageBranchStart, hostBranchStart);
  assert.match(source, /import \* as piFixture from/u);
  assert.match(imageBranch, /await piFixture\.runRealPiRpc\(\)/u);
  assert.doesNotMatch(imageBranch, /tested-wrapper|DEEPSONAR_PI_OM_PACKAGE/u);
  assert.match(source, /--packaging-only/u);
  assert.match(source, /pi_image_packaging: "passed"/u);
  assert.match(source, /--network.*none/);
  assert.match(source, /--read-only/);
  assert.match(source, /--name/);
  assert.match(source, /DEEPSONAR_PI_RPC_TIMEOUT_MS/);
  assert.match(source, /DEEPSONAR_PI_IMAGE_PROOF=1/);
  assert.match(source, /HOST-ONLY Pi 1\.4\.0/);
  assert.match(source, /image proof forbids a host Pi binary override/);
  assert.match(source, /DEEPSONAR_PI_WRAPPER_SHA256/);
  assert.doesNotMatch(source, /path\.join\(repo, "agent-harness"\)/u);
  assert.doesNotMatch(source, /pi-observational-memory-governed\.ts.*\/opt\/deepsonar\/pi-extensions/u);
});
