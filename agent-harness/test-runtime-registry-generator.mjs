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
  dockerhub: `docker.io/summersec/deepsonar-base@${digest}`,
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
    assert.equal(version.registry_refs.dockerhub, `docker.io/summersec/${image.image_key}@${digest}`);
    assert.match(version.registry_refs["aliyun-acr"], /^crpi-6s5wwv0nhl6dq1l0\.cn-hangzhou\.personal\.cr\.aliyuncs\.com\/summersec\//);
    assert.equal(version.image_ref, version.registry_refs.github);
    assert.equal(version.registry_evidence.github.inspect_digest, digest);
  }
  execFileSync(process.execPath, [generator, "--check", outputPath], { stdio: "pipe" });

  // Missing optional credentials are represented by omission, never by a
  // host plus the canonical digest.
  writeDescriptors({ optional: "none" });
  runGenerator();
  const ghcrOnly = JSON.parse(readFileSync(outputPath, "utf8"));
  for (const image of ghcrOnly.images) {
    assert.deepEqual(Object.keys(image.versions[0].registry_refs), ["github"]);
    assert.equal(image.versions[0].registry_evidence.dockerhub, undefined);
  }

  // Explicit unavailable records survive the release merge without refs.
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
      ref: `docker.io/summersec/${imageKey}@${"b".repeat(64)}`,
      inspect_digest: `sha256:${"b".repeat(64)}`,
      provenance: "cross-registry-copy+inspect",
    };
  });
  assertGenerationFails(/inspect|evidence|registry_records/i, (descriptor, imageKey) => {
    if (imageKey === "deepsonar-base") descriptor.registry_records.dockerhub = {
      available: true,
      ref: `docker.io/summersec/${imageKey}@${digest}`,
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

  // --check remains able to read a historical v1 catalog.
  const v1Path = path.join(tempRoot, "legacy-v1.json");
  writeFileSync(v1Path, JSON.stringify({
    schema: "deepsonar.registry/v1",
    images: [{
      image_key: "deepsonar-base",
      name: "DeepSonar Base",
      description: "base",
      publisher: "SummerSec",
      source_kind: "official",
      project_opt_in: false,
      versions: [{ version: "0.1.0-linux-amd64", image_ref: `ghcr.io/summersec/deepsonar-base@${digest}`, platforms: ["linux/amd64"], size_bytes: 42 }],
    }],
  }));
  execFileSync(process.execPath, [generator, "--check", v1Path], { stdio: "pipe" });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("runtime registry generator v2 descriptors, optional channels, strict evidence and v1 check passed");
