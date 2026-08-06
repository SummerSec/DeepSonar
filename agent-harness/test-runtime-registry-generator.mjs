import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "agent-harness", "generate-runtime-image-registry.mjs");
const template = JSON.parse(readFileSync(path.join(root, "deploy", "runtime-image-registry.json"), "utf8"));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "deepsonar-runtime-registry-v2-"));
const descriptorDir = path.join(tempRoot, "descriptors");
const outputPath = path.join(tempRoot, "runtime-image-registry.json");
const digest = `sha256:${"a".repeat(64)}`;
const channels = {
  github: `ghcr.io/summersec/deepsonar-base@${digest}`,
  dockerhub: `docker.io/sumsec/deepsonar-base@${digest}`,
  "aliyun-acr": `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/deepsonar-base@${digest}`,
};

function recordFor(imageKey, channel, available = true) {
  if (!available) return { available: false, provenance: "unavailable", reason: "credentials_missing" };
  const ref = channels[channel].replace("deepsonar-base", imageKey);
  return { available: true, ref, inspect_digest: digest, provenance: channel === "github" ? "build-push+inspect" : "cross-registry-copy+inspect" };
}

function writeDescriptors({ optional = "all", mutate } = {}) {
  mkdirSync(descriptorDir, { recursive: true });
  for (const [index, image] of template.images.entries()) {
    const imageKey = image.image_key;
    const records = { github: recordFor(imageKey, "github") };
    if (optional === "all") {
      records.dockerhub = recordFor(imageKey, "dockerhub");
      records["aliyun-acr"] = recordFor(imageKey, "aliyun-acr");
    } else if (optional === "unavailable") {
      records.dockerhub = recordFor(imageKey, "dockerhub", false);
      records["aliyun-acr"] = recordFor(imageKey, "aliyun-acr", false);
    }
    const descriptor = {
      image_key: imageKey,
      version: "0.1.0",
      digest,
      platforms: ["linux/amd64", "linux/arm64"],
      size_bytes: 100 + index,
      platform_size_bytes: { "linux/amd64": 100 + index, "linux/arm64": 120 + index },
      registry_records: records,
    };
    mutate?.(descriptor, imageKey);
    writeFileSync(path.join(descriptorDir, `${imageKey.replace("deepsonar-", "")}.json`), `${JSON.stringify(descriptor)}\n`);
  }
}

function runGenerator(env = {}) {
  return execFileSync(process.execPath, [generator, descriptorDir, outputPath], {
    env: { ...process.env, VERSION: "0.1.0", ...env },
    stdio: "pipe",
  });
}

try {
  // All three destinations are actual inspected refs and are consolidated
  // into one canonical multi-platform v2 version.
  writeDescriptors();
  runGenerator();
  const generated = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(generated.schema, "deepsonar.registry/v2");
  assert.equal(generated.schema_version, 2);
  for (const image of generated.images) {
    assert.equal(image.versions.length, 1);
    const version = image.versions[0];
    assert.deepEqual(version.platforms, ["linux/amd64", "linux/arm64"]);
    assert.equal(version.digest, digest);
    assert.equal(version.registry_refs.github, `ghcr.io/summersec/${image.image_key}@${digest}`);
    assert.equal(version.registry_refs.dockerhub, `docker.io/sumsec/${image.image_key}@${digest}`);
    assert.match(version.registry_refs["aliyun-acr"], /^crpi-6s5wwv0nhl6dq1l0\.cn-hangzhou\.personal\.cr\.aliyuncs\.com\/summersec\//);
    assert.equal(version.image_ref, version.registry_refs.github);
    assert.equal(version.registry_evidence.github.inspect_digest, digest);
  }
  execFileSync(process.execPath, [generator, "--check", outputPath], { stdio: "pipe" });

  // Every descriptor carries all three channel outcomes. Missing optional
  // credentials are explicit unavailable records, never silent omission.
  writeDescriptors({ optional: "unavailable" });
  runGenerator();
  const unavailable = JSON.parse(readFileSync(outputPath, "utf8"));
  for (const image of unavailable.images) {
    const version = image.versions[0];
    assert.equal(version.registry_evidence.dockerhub.available, false);
    assert.equal(version.registry_evidence.dockerhub.provenance, "unavailable");
    assert.equal(version.registry_evidence["aliyun-acr"].available, false);
    assert.equal(version.registry_refs.dockerhub, undefined);
  }

  const assertGenerationFails = (message, mutate) => {
    writeDescriptors({ mutate });
    assert.throws(() => runGenerator(), message);
  };
  assertGenerationFails(/inspect_digest.*canonical|digest/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.dockerhub = {
      available: true,
      ref: `docker.io/sumsec/${imageKey}@${"b".repeat(64)}`,
      inspect_digest: `sha256:${"b".repeat(64)}`,
      provenance: "cross-registry-copy+inspect",
    };
  });
  assertGenerationFails(/inspect|evidence|registry_records/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.dockerhub = {
      available: true,
      ref: `docker.io/sumsec/${imageKey}@${digest}`,
      provenance: "cross-registry-copy",
    };
  });
  assertGenerationFails(/unknown channel|未知 channel/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.evil = {
      available: true,
      ref: `docker.io/summersec/${imageKey}@${digest}`,
      inspect_digest: digest,
      provenance: "cross-registry-copy+inspect",
    };
  });
  assertGenerationFails(/server-owned dockerhub host\/namespace/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") {
      descriptor.registry_records.dockerhub.ref = `docker.io/summersec/${imageKey}@${digest}`;
    }
  });

  assertGenerationFails(/provenance/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.dockerhub.provenance = "build-push+inspect";
  });
  assertGenerationFails(/reason/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.dockerhub = { available: false, provenance: "unavailable", reason: "credentials missing" };
  });
  assertGenerationFails(/must include.*evidence|registry_records/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") delete descriptor.registry_records.dockerhub;
  });
  assertGenerationFails(/unknown fields/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.untrusted_extra = true;
  });

  const assertRegistryCheckFails = (message, mutate) => {
    writeDescriptors();
    runGenerator();
    const candidate = JSON.parse(readFileSync(outputPath, "utf8"));
    mutate(candidate);
    writeFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
    assert.throws(() => execFileSync(process.execPath, [generator, "--check", outputPath], { stdio: "pipe" }), message);
  };
  assertRegistryCheckFails(/unknown fields/i, (candidate) => { candidate.untrusted_extra = true; });
  assertRegistryCheckFails(/unknown fields/i, (candidate) => { candidate.images[0].untrusted_extra = true; });
  assertRegistryCheckFails(/unknown fields/i, (candidate) => { candidate.images[0].versions[0].untrusted_extra = true; });
  assertRegistryCheckFails(/unknown fields/i, (candidate) => { candidate.images[0].versions[0].registry_evidence.github.untrusted_extra = true; });
  assertRegistryCheckFails(/registry_evidence|provenance/i, (candidate) => { candidate.images[0].versions[0].registry_evidence.github.provenance = "cross-registry-copy+inspect"; });
  assertRegistryCheckFails(/registry_evidence|unavailable|reason/i, (candidate) => { candidate.images[0].versions[0].registry_evidence.dockerhub.reason = "credentials missing"; });
  assertRegistryCheckFails(/exactly the six official image keys/i, (candidate) => { candidate.images.pop(); });
  assertRegistryCheckFails(/unavailable evidence cannot coexist|registry_evidence/i, (candidate) => {
    const version = candidate.images[0].versions[0];
    version.registry_evidence.dockerhub = { available: false, provenance: "unavailable", reason: "credentials_missing" };
  });

  // --check remains able to read a historical v1 catalog.
  const v1Path = path.join(tempRoot, "legacy-v1.json");
  writeFileSync(v1Path, JSON.stringify({
    schema: "deepsonar.registry/v1",
    images: template.images.map((image) => ({
      ...image,
      versions: [{ version: "0.1.0-linux-amd64", image_ref: `ghcr.io/summersec/${image.image_key}@${digest}`, platforms: ["linux/amd64"], size_bytes: 42 }],
    })),
  }));
  execFileSync(process.execPath, [generator, "--check", v1Path], { stdio: "pipe" });

  const duplicateV1Path = path.join(tempRoot, "legacy-v1-duplicate.json");
  const duplicateImages = JSON.parse(readFileSync(v1Path, "utf8"));
  duplicateImages.images[1].versions[0].image_ref = duplicateImages.images[0].versions[0].image_ref;
  writeFileSync(duplicateV1Path, JSON.stringify(duplicateImages));
  assert.throws(() => execFileSync(process.execPath, [generator, "--check", duplicateV1Path], { stdio: "pipe" }), /duplicate/i);
  const duplicateAliasPath = path.join(tempRoot, "legacy-v1-overlap.json");
  const duplicateAlias = JSON.parse(readFileSync(v1Path, "utf8"));
  duplicateAlias.images[0].versions.push({ version: "0.1.1-linux-amd64", image_ref: duplicateAlias.images[0].versions[0].image_ref, platforms: ["linux/amd64"], size_bytes: 42 });
  writeFileSync(duplicateAliasPath, JSON.stringify(duplicateAlias));
  assert.throws(() => execFileSync(process.execPath, [generator, "--check", duplicateAliasPath], { stdio: "pipe" }), /duplicate/i);
  const duplicateMissingPlatformPath = path.join(tempRoot, "legacy-v1-missing-platform.json");
  const duplicateMissingPlatform = JSON.parse(readFileSync(v1Path, "utf8"));
  duplicateMissingPlatform.images[0].versions.push({ version: "0.1.1", image_ref: duplicateMissingPlatform.images[0].versions[0].image_ref });
  writeFileSync(duplicateMissingPlatformPath, JSON.stringify(duplicateMissingPlatform));
  assert.throws(() => execFileSync(process.execPath, [generator, "--check", duplicateMissingPlatformPath], { stdio: "pipe" }), /duplicate/i);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("runtime registry generator v2 descriptors, optional channels, strict evidence and v1 check passed");
