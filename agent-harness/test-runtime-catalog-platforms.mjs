import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveRuntimePlatformSources,
  runnablePlatformDigests,
  samePlatformDigests,
} from "./runtime-platform-manifests.mjs";
import {
  CATALOG_REUSE_MISS_EXIT,
  descriptorFromCatalogVersion,
  isCatalogReuseMiss,
  reuseCatalogDescriptor,
} from "./reuse-catalog-descriptor.mjs";
import { assertCatalogMatchesRuntimeSources, compareCatalogVersionLabels } from "./check-runtime-catalog-platforms.mjs";

const platforms = ["linux/amd64", "linux/arm64"];
const imageKeys = [
  ...["chrome", "clickhouse"].flatMap((family) =>
    ["audit", "test", "fuzz"].map((role) => `deepsonar-${family}-${role}`)),
  "deepsonar-reverse",
];
const repositoryPrefix = "ghcr.io/summersec";
const imageMediaType = "application/vnd.oci.image.manifest.v1+json";
const indexMediaType = "application/vnd.oci.image.index.v1+json";
const digest = (value) => `sha256:${value.toString(16).padStart(64, "0")}`;
const ref = (imageKey, value, prefix = repositoryPrefix) => `${prefix}/${imageKey}@${value}`;
const clone = (value) => structuredClone(value);

function runnable(platform, value) {
  const [os, architecture] = platform.split("/");
  return { mediaType: imageMediaType, size: 100, digest: value, platform: { os, architecture } };
}

function attestation(value, artifact = false) {
  return {
    mediaType: imageMediaType,
    size: 100,
    digest: value,
    platform: { os: "unknown", architecture: "unknown" },
    ...(artifact
      ? { artifactType: "application/vnd.in-toto+json" }
      : { annotations: { "vnd.docker.reference.type": "attestation-manifest" } }),
  };
}

function index(platformDigests, attestations = true) {
  return {
    schemaVersion: 2,
    mediaType: indexMediaType,
    manifests: [
      ...Object.entries(platformDigests).map(([platform, value]) => runnable(platform, value)),
      ...(attestations ? [attestation(digest(900)), attestation(digest(901), true)] : []),
    ],
  };
}

function inspector(manifests) {
  const calls = [];
  const inspectManifest = (imageRef) => {
    calls.push(imageRef);
    assert.ok(manifests.has(imageRef), `unexpected immutable inspection: ${imageRef}`);
    const result = manifests.get(imageRef);
    if (result instanceof Error) throw result;
    return clone(result);
  };
  return { calls, inspectManifest };
}

function version(imageKey, rootDigest, optionalChannels = false) {
  const github = ref(imageKey, rootDigest);
  const channels = { github };
  if (optionalChannels) {
    channels.dockerhub = ref(imageKey, rootDigest, "docker.io/sumsec");
    channels["aliyun-acr"] = ref(imageKey, rootDigest, "registry.example.invalid/summersec");
  }
  return {
    version: "0.4.17",
    digest: rootDigest,
    platforms: [...platforms],
    size_bytes: 12345,
    image_ref: github,
    registry_refs: channels,
    tools_manifest_sha256: "a".repeat(64),
    registry_evidence: Object.fromEntries(["github", "dockerhub", "aliyun-acr"].map((channel) => [
      channel,
      channels[channel]
        ? {
          available: true,
          ref: channels[channel],
          inspect_digest: rootDigest,
          provenance: channel === "github" ? "build-push+inspect" : "cross-registry-copy+inspect",
        }
        : { available: false, provenance: "unavailable", reason: "credentials_missing" },
    ])),
  };
}

function reuseFixture(imageKey = "deepsonar-chrome-test") {
  const platformDigests = { "linux/amd64": digest(1), "linux/arm64": digest(2) };
  const platformSources = { "linux/amd64": ref(imageKey, digest(11)), "linux/arm64": ref(imageKey, digest(12)) };
  const catalogVersion = version(imageKey, digest(20));
  const catalog = { schema: "deepsonar.registry/v2", schema_version: 2, images: [{ image_key: imageKey, versions: [catalogVersion] }] };
  const manifests = new Map([
    [platformSources["linux/amd64"], index({ "linux/amd64": platformDigests["linux/amd64"] })],
    [platformSources["linux/arm64"], index({ "linux/arm64": platformDigests["linux/arm64"] })],
    [catalogVersion.image_ref, index(platformDigests)],
  ]);
  return { imageKey, platformDigests, platformSources, catalogVersion, catalog, manifests };
}

function assertFailClosed(callback, message) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(isCatalogReuseMiss(error), false, "invalid evidence must not become a publishable reuse miss");
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("runnable identity excludes both attestation annotation and artifact descriptors", () => {
  const expected = { "linux/amd64": digest(1), "linux/arm64": digest(2) };
  assert.deepEqual(runnablePlatformDigests(index(expected), platforms), expected);
  const reordered = index({ "linux/arm64": digest(2), "linux/amd64": digest(1) });
  reordered.annotations = { "org.opencontainers.image.description": "A different wrapper" };
  assert.ok(samePlatformDigests(expected, runnablePlatformDigests(reordered, platforms)));
  assert.equal(samePlatformDigests(expected, { "linux/amd64": digest(1) }), false);
  assert.equal(samePlatformDigests(expected, { ...expected, "linux/arm64": digest(3) }), false);
});

test("Docker v2 runnable descriptors are supported", () => {
  const manifest = index({ "linux/amd64": digest(1) });
  manifest.manifests[0].mediaType = "application/vnd.docker.distribution.manifest.v2+json";
  assert.deepEqual(runnablePlatformDigests(manifest, ["linux/amd64"]), { "linux/amd64": digest(1) });
});

for (const [name, manifest] of [
  ["missing platform", index({ "linux/amd64": digest(1) })],
  ["duplicate platform with a different digest", { manifests: [runnable("linux/amd64", digest(1)), runnable("linux/amd64", digest(3)), runnable("linux/arm64", digest(2))] }],
  ["duplicate platform with the same digest", { manifests: [runnable("linux/amd64", digest(1)), runnable("linux/amd64", digest(1)), runnable("linux/arm64", digest(2))] }],
  ["unexpected runnable platform", index({ "linux/amd64": digest(1), "linux/arm64": digest(2), "linux/s390x": digest(3) })],
  ["single image manifest", { schemaVersion: 2, mediaType: imageMediaType, layers: [] }],
  ["malformed index", { manifests: "invalid" }],
  ["descriptor missing platform", { manifests: [{ mediaType: imageMediaType, digest: digest(1) }] }],
  ["descriptor invalid digest", index({ "linux/amd64": "sha256:invalid", "linux/arm64": digest(2) })],
  ["nested index descriptor", { manifests: [{ ...runnable("linux/amd64", digest(1)), mediaType: indexMediaType }, runnable("linux/arm64", digest(2))] }],
  ["unmarked unknown descriptor", { manifests: [...index({ "linux/amd64": digest(1), "linux/arm64": digest(2) }, false).manifests, { digest: digest(3), platform: { os: "unknown", architecture: "unknown" } }] }],
]) {
  test(`runnable identity rejects ${name}`, () => {
    assertFailClosed(() => runnablePlatformDigests(manifest, platforms));
  });
}

test("runnable identity rejects empty, duplicate, or invalid expected platforms", () => {
  for (const expected of [[], ["linux/amd64", "linux/amd64"], ["invalid"]]) {
    assertFailClosed(() => runnablePlatformDigests(index({ "linux/amd64": digest(1) }), expected));
  }
});

test("source wrappers resolve to immutable runnable children rather than wrapper digests", () => {
  const fixture = reuseFixture();
  const mock = inspector(fixture.manifests);
  assert.deepEqual(resolveRuntimePlatformSources(fixture.platformSources, mock.inspectManifest), {
    platformDigests: fixture.platformDigests,
    sourceRefs: platforms.map((platform) => ref(fixture.imageKey, fixture.platformDigests[platform])),
  });
  assert.deepEqual(mock.calls, Object.values(fixture.platformSources));
});

test("source resolution rejects mutable refs before inspection", () => {
  for (const source of ["ghcr.io/summersec/deepsonar-chrome-test:src-cache", "ghcr.io/summersec/deepsonar-chrome-test", "ghcr.io/summersec/deepsonar-chrome-test@sha256:invalid"]) {
    let calls = 0;
    assertFailClosed(() => resolveRuntimePlatformSources({ "linux/amd64": source }, () => { calls += 1; }));
    assert.equal(calls, 0);
  }
});

test("source resolution rejects a wrapper for the wrong architecture", () => {
  assertFailClosed(() => resolveRuntimePlatformSources(
    { "linux/arm64": ref("deepsonar-chrome-test", digest(11)) },
    () => index({ "linux/amd64": digest(1) }),
  ));
});

test("source resolution requires a nonempty platform-source map", () => {
  for (const sources of [undefined, null, [], {}]) {
    assertFailClosed(() => resolveRuntimePlatformSources(sources, () => assert.fail("invalid sources must not inspect")));
  }
});

test("reuse keeps the original descriptor and version when tested children match", () => {
  const fixture = reuseFixture();
  const mock = inspector(fixture.manifests);
  const reused = reuseCatalogDescriptor({ ...fixture, inspectManifest: mock.inspectManifest });
  assert.deepEqual(reused, descriptorFromCatalogVersion(fixture.imageKey, fixture.catalogVersion));
  assert.notEqual(fixture.catalogVersion.digest, fixture.platformSources["linux/amd64"].split("@")[1]);
  assert.deepEqual(mock.calls, [...Object.values(fixture.platformSources), fixture.catalogVersion.image_ref]);
});

test("both source-cache hits cannot reuse a stale catalog payload", () => {
  const fixture = reuseFixture();
  fixture.manifests.set(fixture.catalogVersion.image_ref, index({ "linux/amd64": digest(51), "linux/arm64": digest(52) }));
  assert.throws(() => reuseCatalogDescriptor({ ...fixture, inspectManifest: inspector(fixture.manifests).inspectManifest }), (error) => (
    isCatalogReuseMiss(error) && error.exitCode === CATALOG_REUSE_MISS_EXIT
  ));
});

test("one changed platform is a distinguishable catalog reuse miss", () => {
  const fixture = reuseFixture();
  fixture.manifests.set(fixture.catalogVersion.image_ref, index({ ...fixture.platformDigests, "linux/arm64": digest(52) }));
  assert.throws(() => reuseCatalogDescriptor({ ...fixture, inspectManifest: inspector(fixture.manifests).inspectManifest }), (error) => (
    isCatalogReuseMiss(error) && error.exitCode === 2
  ));
});

test("digest identity still reuses a catalog descriptor", () => {
  const fixture = reuseFixture();
  assert.deepEqual(reuseCatalogDescriptor({ catalog: fixture.catalog, imageKey: fixture.imageKey, digest: fixture.catalogVersion.digest }),
    descriptorFromCatalogVersion(fixture.imageKey, fixture.catalogVersion));
});

test("reuse never blindly selects the latest row without one explicit identity", () => {
  const fixture = reuseFixture();
  for (const identity of [{}, { digest: fixture.catalogVersion.digest, platformSources: fixture.platformSources }]) {
    assertFailClosed(() => reuseCatalogDescriptor({ catalog: fixture.catalog, imageKey: fixture.imageKey, ...identity }), /exactly one/i);
  }
});

for (const target of ["source", "catalog"]) {
  test(`reuse fails closed when ${target} inspection fails`, () => {
    const fixture = reuseFixture();
    const imageRef = target === "source" ? fixture.platformSources["linux/amd64"] : fixture.catalogVersion.image_ref;
    fixture.manifests.set(imageRef, new Error(`${target} registry inspection failed`));
    assertFailClosed(() => reuseCatalogDescriptor({ ...fixture, inspectManifest: inspector(fixture.manifests).inspectManifest }), /registry inspection failed/);
  });
  for (const malformed of ["missing", "duplicate", "invalid"]) {
    test(`reuse fails closed on ${malformed} ${target} platform evidence`, () => {
      const fixture = reuseFixture();
      const imageRef = target === "source" ? fixture.platformSources["linux/amd64"] : fixture.catalogVersion.image_ref;
      const manifest = fixture.manifests.get(imageRef);
      if (malformed === "missing") manifest.manifests.shift();
      if (malformed === "duplicate") manifest.manifests.unshift(clone(manifest.manifests[0]));
      if (malformed === "invalid") manifest.manifests[0].digest = "sha256:invalid";
      assertFailClosed(() => reuseCatalogDescriptor({ ...fixture, inspectManifest: inspector(fixture.manifests).inspectManifest }));
    });
  }
}

test("reuse fails closed on inconsistent catalog ref or platform metadata", () => {
  for (const mutate of [
    (row) => { row.image_ref = `${repositoryPrefix}/deepsonar-chrome-test:0.4.17`; },
    (row) => { row.image_ref = ref("deepsonar-chrome-test", digest(21)); },
    (row) => { row.platforms = ["linux/amd64"]; },
    (row) => { row.platforms = ["linux/amd64", "linux/amd64"]; },
  ]) {
    const fixture = reuseFixture();
    mutate(fixture.catalogVersion);
    assertFailClosed(() => reuseCatalogDescriptor({ ...fixture, inspectManifest: inspector(fixture.manifests).inspectManifest }));
  }
});

function finalCatalogFixture() {
  const catalog = { schema: "deepsonar.registry/v2", schema_version: 2, images: [] };
  const builds = [];
  const manifests = new Map();
  imageKeys.forEach((imageKey, offset) => {
    const children = { "linux/amd64": digest(100 + offset * 2), "linux/arm64": digest(101 + offset * 2) };
    const catalogVersion = version(imageKey, digest(200 + offset), true);
    catalog.images.push({ image_key: imageKey, versions: [catalogVersion] });
    for (const [platformOffset, platform] of platforms.entries()) {
      const sourceDigest = digest(300 + offset * 2 + platformOffset);
      builds.push({ image_key: imageKey, platform, digest: sourceDigest, unchanged: true });
      manifests.set(ref(imageKey, sourceDigest), index({ [platform]: children[platform] }));
    }
    for (const imageRef of Object.values(catalogVersion.registry_refs)) manifests.set(imageRef, index(children));
  });
  return { catalog, builds, manifests, repositoryPrefix };
}

function checkFinal(fixture, inspectManifest = inspector(fixture.manifests).inspectManifest) {
  return assertCatalogMatchesRuntimeSources({ ...fixture, inspectManifest });
}

test("final catalog proves all seven products and all fourteen tested platform children", () => {
  const fixture = finalCatalogFixture();
  const mock = inspector(fixture.manifests);
  assert.equal(fixture.builds.length, 14);
  assert.equal(checkFinal(fixture, mock.inspectManifest), 7);
  assert.deepEqual(new Set(mock.calls), new Set(fixture.manifests.keys()), "every source and every available channel must be inspected");
});

function differentCatalogVersion(fixture, label, root = 800) {
  const image = fixture.catalog.images[0];
  const row = version(image.image_key, digest(root), true);
  row.version = label;
  image.versions.unshift(row);
  for (const imageRef of Object.values(row.registry_refs)) {
    fixture.manifests.set(imageRef, index({ "linux/amd64": digest(51), "linux/arm64": digest(52) }));
  }
  return row;
}

test("final catalog accepts differing older history without inspecting unselected payloads", () => {
  const fixture = finalCatalogFixture();
  const historical = differentCatalogVersion(fixture, "0.4.16");
  const mock = inspector(fixture.manifests);
  assert.equal(checkFinal(fixture, mock.inspectManifest), 7);
  assert.ok(Object.values(historical.registry_refs).every((imageRef) => !mock.calls.includes(imageRef)));
});

test("a newer stale row cannot be bypassed by an older matching row", () => {
  const fixture = finalCatalogFixture();
  differentCatalogVersion(fixture, "0.4.18");
  assertFailClosed(() => checkFinal(fixture), /does not match tested platform manifests/);
});

for (const matches of [true, false]) {
  test(`optional-channel fallback to history ${matches ? "accepts matching" : "rejects stale"} tested payloads`, () => {
    const fixture = finalCatalogFixture();
    const current = fixture.catalog.images[0].versions[0];
    const historical = differentCatalogVersion(fixture, "0.4.16");
    delete current.registry_refs.dockerhub;
    current.registry_evidence.dockerhub = { available: false, provenance: "unavailable", reason: "credentials_missing" };
    if (matches) fixture.manifests.set(historical.registry_refs.dockerhub, index({ "linux/amd64": digest(100), "linux/arm64": digest(101) }));
    if (matches) assert.equal(checkFinal(fixture), 7);
    else assertFailClosed(() => checkFinal(fixture), /dockerhub.*does not match tested platform manifests/);
  });
}

for (const staleLatest of [false, true]) {
  test(`numeric version selection chooses 0.5.10 over 0.5.9 (${staleLatest ? "stale" : "matching"} latest)`, () => {
    const fixture = finalCatalogFixture();
    fixture.catalog.images[0].versions[0].version = staleLatest ? "0.5.9" : "0.5.10";
    differentCatalogVersion(fixture, staleLatest ? "0.5.10" : "0.5.9");
    if (staleLatest) assertFailClosed(() => checkFinal(fixture), /does not match tested platform manifests/);
    else assert.equal(checkFinal(fixture), 7);
  });
}

for (const root of [190, 800]) {
  test(`normalized version ties select descending digest (${root < 200 ? "matching" : "stale"} winner)`, () => {
    const fixture = finalCatalogFixture();
    fixture.catalog.images[0].versions[0].version = "0.5.10";
    differentCatalogVersion(fixture, "0.05.010", root);
    assert.equal(compareCatalogVersionLabels("0.5.10", "0.05.010"), 0);
    if (root < 200) assert.equal(checkFinal(fixture), 7);
    else assertFailClosed(() => checkFinal(fixture), /does not match tested platform manifests/);
  });
}

test("latest selection filters out rows for unrelated platforms before ordering", () => {
  const fixture = finalCatalogFixture();
  const otherPlatform = differentCatalogVersion(fixture, "0.6.0");
  otherPlatform.platforms = ["linux/s390x"];
  const mock = inspector(fixture.manifests);
  assert.equal(checkFinal(fixture, mock.inspectManifest), 7);
  assert.ok(Object.values(otherPlatform.registry_refs).every((imageRef) => !mock.calls.includes(imageRef)));
});

test("different latest rows per architecture cannot satisfy one canonical release row", () => {
  const fixture = finalCatalogFixture();
  differentCatalogVersion(fixture, "0.6.0").platforms = ["linux/amd64"];
  assertFailClosed(() => checkFinal(fixture), /must select one canonical version for both tested platforms/);
});

test("release version ordering stays aligned with the actual Scheduler comparator and selection", () => {
  const source = readFileSync(new URL("../apps/scheduler/src/runtime-images.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function compareRuntimeImageVersionLabels(");
  const end = source.indexOf("\n/**\n * Default async pull", start);
  assert.ok(start >= 0 && end > start, "bounded Scheduler comparator source must be present");
  const javascript = source.slice(start, end).replace("export function", "function")
    .replace("(left: string, right: string): number", "(left, right)")
    .replace("(value: string): Array<number | string>", "(value)");
  const compareScheduler = new Function(`${javascript}\nreturn compareRuntimeImageVersionLabels;`)();
  const labels = ["0.5.9", "0.5.10", "0.05.010", "0.5.10-rc.2", "0.5.10-rc.10", " V0.5.10 ", "v0.5.10", "configured-main", "configured-11", "configured-a"];
  for (const left of labels) {
    for (const right of labels) {
      assert.equal(compareCatalogVersionLabels(left, right), compareScheduler(left, right), `${left} versus ${right}`);
    }
  }
  const selectorStart = source.indexOf("export function selectLatestRuntimeImagePullItems(");
  const selectorEnd = source.indexOf("\nfunction immutableImageRepository", selectorStart);
  assert.ok(selectorStart >= 0 && selectorEnd > selectorStart, "bounded Scheduler selector source must be present");
  const selector = source.slice(selectorStart, selectorEnd);
  assert.match(selector, /versions\.filter\(\(version\) => version\.platforms\?\.includes\(hostPlatform\)\)/);
  assert.match(selector, /runtimeImageRefForChannel\(version, channel\)/);
  assert.match(selector, /compareRuntimeImageVersionLabels\(right\.version\.version, left\.version\.version\)/);
  assert.match(selector, /return rightDigest\.localeCompare\(leftDigest\)/);
});

test("final equality remains mandatory when one build is fresh", () => {
  const fixture = finalCatalogFixture();
  fixture.builds[1].unchanged = false;
  assert.doesNotThrow(() => checkFinal(fixture));
  const row = fixture.catalog.images[0].versions[0];
  fixture.manifests.set(row.image_ref, index({ "linux/amd64": digest(100), "linux/arm64": digest(999) }));
  assertFailClosed(() => checkFinal(fixture));
});

for (const channel of ["github", "dockerhub", "aliyun-acr"]) {
  test(`final catalog rejects a ${channel} child-payload mismatch`, () => {
    const fixture = finalCatalogFixture();
    const row = fixture.catalog.images[5].versions[0];
    fixture.manifests.set(row.registry_refs[channel], index({ "linux/amd64": digest(110), "linux/arm64": digest(999) }));
    assertFailClosed(() => checkFinal(fixture));
  });
  test(`final catalog rejects failed ${channel} inspection`, () => {
    const fixture = finalCatalogFixture();
    fixture.manifests.set(fixture.catalog.images[0].versions[0].registry_refs[channel], new Error("registry inspection failed"));
    assertFailClosed(() => checkFinal(fixture), /registry inspection failed/);
  });
}

test("final catalog rejects failed source inspection", () => {
  const fixture = finalCatalogFixture();
  const build = fixture.builds[0];
  fixture.manifests.set(ref(build.image_key, build.digest), new Error("source inspection failed"));
  assertFailClosed(() => checkFinal(fixture), /source inspection failed/);
});

for (const [name, mutate] of [
  ["missing build platform", (fixture) => { fixture.builds.pop(); }],
  ["missing product builds", (fixture) => { fixture.builds.splice(0, 2); }],
  ["duplicate build platform", (fixture) => { fixture.builds.push(clone(fixture.builds[0])); }],
  ["unsupported build platform", (fixture) => { fixture.builds[0].platform = "linux/s390x"; }],
  ["missing catalog product", (fixture) => { fixture.catalog.images.pop(); }],
  ["duplicate catalog product", (fixture) => { fixture.catalog.images.push(clone(fixture.catalog.images[0])); }],
  ["empty catalog product version", (fixture) => { fixture.catalog.images[0].versions = []; }],
  ["duplicate catalog version labels", (fixture) => { fixture.catalog.images[0].versions.push(clone(fixture.catalog.images[0].versions[0])); }],
  ["missing catalog platform", (fixture) => { fixture.catalog.images[0].versions[0].platforms.pop(); }],
  ["unavailable canonical channel", (fixture) => { fixture.catalog.images[0].versions[0].registry_evidence.github.available = false; }],
  ["canonical ref disagreement", (fixture) => { fixture.catalog.images[0].versions[0].registry_refs.github = ref(imageKeys[0], digest(999)); }],
  ["channel evidence ref disagreement", (fixture) => { fixture.catalog.images[0].versions[0].registry_evidence.dockerhub.ref = ref(imageKeys[0], digest(999)); }],
  ["channel inspect digest disagreement", (fixture) => { fixture.catalog.images[0].versions[0].registry_evidence.dockerhub.inspect_digest = digest(999); }],
  ["canonical root digest disagreement", (fixture) => { fixture.catalog.images[0].versions[0].digest = digest(999); }],
]) {
  test(`final catalog rejects ${name}`, () => {
    const fixture = finalCatalogFixture();
    mutate(fixture);
    assertFailClosed(() => checkFinal(fixture));
  });
}

// These process-level checks use a local executable stub only. No registry
// credentials, Docker daemon, registry writes, or network access are involved.
function withMockDocker(fixture, callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deepsonar-catalog-platforms-"));
  const log = path.join(directory, "docker-calls.jsonl");
  const fixturePath = path.join(directory, "manifests.json");
  const catalogPath = path.join(directory, "catalog.json");
  const outputPath = path.join(directory, "descriptor.json");
  const values = Object.fromEntries([...fixture.manifests].map(([key, value]) => (
    [key, value instanceof Error ? { failure: value.message } : value]
  )));
  writeFileSync(fixturePath, JSON.stringify(values));
  writeFileSync(catalogPath, JSON.stringify(fixture.catalog));
  writeFileSync(path.join(directory, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "buildx" || args[1] !== "imagetools") process.exit(24);
if (args[2] === "create") process.exit(0);
if (args[2] !== "inspect" || args[3] !== "--raw" || args.length !== 5) process.exit(25);
const value = JSON.parse(fs.readFileSync(process.env.MOCK_MANIFESTS, "utf8"))[args[4]];
if (!value || value.failure) { console.error(value?.failure || "unexpected inspect ref"); process.exit(23); }
process.stdout.write(JSON.stringify(value));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, MOCK_DOCKER_LOG: log, MOCK_MANIFESTS: fixturePath };
  try {
    callback({
      directory, catalogPath, outputPath, env,
      calls: () => {
        try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const posixMockOptions = { skip: process.platform === "win32" ? "Mock Docker executable and release Bash run on POSIX" : false };
for (const outcome of ["match", "stale", "source failure", "catalog failure", "missing identity"]) {
  test(`reuse CLI preserves exit classification for ${outcome}`, posixMockOptions, () => {
    const fixture = reuseFixture();
    if (outcome === "stale") fixture.manifests.set(fixture.catalogVersion.image_ref, index({ "linux/amd64": digest(51), "linux/arm64": digest(52) }));
    if (outcome === "source failure") fixture.manifests.set(fixture.platformSources["linux/amd64"], new Error("source inspection failed"));
    if (outcome === "catalog failure") fixture.manifests.set(fixture.catalogVersion.image_ref, new Error("catalog inspection failed"));
    withMockDocker(fixture, (mock) => {
      const args = [fileURLToPath(new URL("./reuse-catalog-descriptor.mjs", import.meta.url)), "--catalog", mock.catalogPath,
        "--image-key", fixture.imageKey, "--out", mock.outputPath];
      if (outcome !== "missing identity") {
        for (const [platform, imageRef] of Object.entries(fixture.platformSources)) args.push("--source", `${platform}=${imageRef}`);
      }
      const result = spawnSync(process.execPath, args, { env: mock.env, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, outcome === "match" ? 0 : outcome === "stale" ? 2 : 1, result.stderr);
      assert.equal(mock.calls().some((args) => args[2] === "create"), false);
      if (outcome === "match") assert.equal(JSON.parse(readFileSync(mock.outputPath, "utf8")).version, fixture.catalogVersion.version);
      else assert.throws(() => readFileSync(mock.outputPath), { code: "ENOENT" });
    });
  });
}

for (const family of ["Chrome", "ClickHouse"]) {
  for (const outcome of ["match", "stale", "source failure", "catalog failure"]) {
    test(`${family} cache-hit workflow ${outcome} reaches only its authorized assembly branch`, posixMockOptions, () => {
      const name = family === "Reverse" ? "reverse" : `${family.toLowerCase()}-test`;
      const fixture = reuseFixture(`deepsonar-${name}`);
      if (outcome === "stale") fixture.manifests.set(fixture.catalogVersion.image_ref, index({ "linux/amd64": digest(51), "linux/arm64": digest(52) }));
      if (outcome === "source failure") fixture.manifests.set(fixture.platformSources["linux/amd64"], new Error("source inspection failed"));
      if (outcome === "catalog failure") fixture.manifests.set(fixture.catalogVersion.image_ref, new Error("catalog inspection failed"));
      withMockDocker(fixture, (mock) => {
        const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
        const step = workflow.slice(workflow.indexOf(`name: Assemble and publish ${family} multi-arch index`));
        const match = step.match(/run: \|\n([\s\S]*?)\n          primary=/);
        assert.ok(match, `${family} runnable assembly prefix must be present`);
        const script = match[1].replace(/^          /gm, "").replaceAll("${{ matrix.name }}", name)
          .replaceAll("${{ matrix.title }}", "Fixture title").replaceAll("${{ matrix.description }}", "Fixture description");
        assert.ok(!script.includes("${{"), "executed fixture prefix must contain no unresolved workflow expressions");
        for (const directory of ["agent-harness", "deploy", `${family.toLowerCase()}-arch`]) mkdirSync(path.join(mock.directory, directory));
        for (const file of ["reuse-catalog-descriptor.mjs", "runtime-platform-manifests.mjs"]) {
          writeFileSync(path.join(mock.directory, "agent-harness", file), readFileSync(new URL(`./${file}`, import.meta.url)));
        }
        writeFileSync(path.join(mock.directory, "deploy/runtime-image-registry.json"), JSON.stringify(fixture.catalog));
        for (const platform of platforms) {
          writeFileSync(path.join(mock.directory, `${family.toLowerCase()}-arch`, `${name}-${platform.split("/")[1]}.json`),
            JSON.stringify({ digest: fixture.platformSources[platform].split("@")[1], unchanged: true }));
        }
        const result = spawnSync("bash", ["-c", script], { cwd: mock.directory, encoding: "utf8", timeout: 15_000,
          env: { ...mock.env, IMAGE_NAME: `${repositoryPrefix}/${fixture.imageKey}`, GHCR_TAGS: `${repositoryPrefix}/${fixture.imageKey}:0.4.18`,
            GITHUB_STEP_SUMMARY: path.join(mock.directory, "summary"), GITHUB_OUTPUT: path.join(mock.directory, "output") } });
        assert.equal(result.status, outcome.endsWith("failure") ? 1 : 0, result.stderr);
        const creates = mock.calls().filter((args) => args[2] === "create");
        assert.equal(creates.length, outcome === "stale" ? 1 : 0, "only a proven stale reuse miss may assemble an index");
        if (outcome === "stale") {
          assert.deepEqual(creates[0].slice(-2), platforms.map((platform) => ref(fixture.imageKey, fixture.platformDigests[platform])));
          assert.match(readFileSync(path.join(mock.directory, "summary"), "utf8"), /assembling tested platform manifests/);
        }
        if (outcome === "match") assert.match(readFileSync(path.join(mock.directory, "output"), "utf8"), /unchanged=true/);
      });
    });
  }
}
