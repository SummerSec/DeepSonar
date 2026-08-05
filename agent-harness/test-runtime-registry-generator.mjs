import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "agent-harness", "generate-runtime-image-registry.mjs");
const template = JSON.parse(readFileSync(path.join(root, "deploy", "runtime-image-registry.json"), "utf8"));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "deepsonar-runtime-registry-"));
const descriptorDir = path.join(tempRoot, "descriptors");
const outputPath = path.join(tempRoot, "runtime-image-registry.json");

try {
  mkdirSync(descriptorDir);
  for (const [index, image] of template.images.entries()) {
    const byte = (index + 1).toString(16).padStart(2, "0");
    const digest = `sha256:${byte.repeat(32)}`;
    const descriptor = {
      image_key: image.image_key,
      digest,
      platforms: ["linux/amd64", "linux/arm64"],
      size_bytes: 100 + index,
      ghcr_ref: `ghcr.io/summersec/${image.image_key}@${digest}`,
      // v1 must not switch to this reference just because ACR credentials are set.
      acr_ref: `registry.cn-hangzhou.aliyuncs.com/summersec/${image.image_key}@${digest}`,
    };
    writeFileSync(path.join(descriptorDir, `${image.image_key.replace("deepsonar-", "")}.json`), `${JSON.stringify(descriptor)}\n`);
  }

  const env = {
    ...process.env,
    VERSION: "0.1.0",
    ALIYUN_REGISTRY: "registry.cn-hangzhou.aliyuncs.com",
    ALIYUN_REGISTRY_NAMESPACE: "summersec",
    ALIYUN_REGISTRY_USERNAME: "configured-for-test",
    ALIYUN_REGISTRY_PASSWORD: "configured-for-test",
  };
  execFileSync(process.execPath, [generator, descriptorDir, outputPath], { env, stdio: "pipe" });
  const generated = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(generated.schema, "deepsonar.registry/v1");
  for (const image of generated.images) {
    for (const version of image.versions) {
      assert.match(version.image_ref, /^ghcr\.io\/summersec\//);
      assert.doesNotMatch(version.image_ref, /aliyuncs\.com/);
    }
  }
  execFileSync(process.execPath, [generator, "--check", outputPath], { env, stdio: "pipe" });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("runtime registry generator GHCR v1 compatibility passed");
