import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reuseCatalogDescriptor } from "./reuse-catalog-descriptor.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const catalog = {
  schema: "deepsonar.registry/v2",
  schema_version: 2,
  images: [{
    image_key: "deepsonar-base",
    versions: [{
      version: "0.1.8",
      digest,
      platforms: ["linux/amd64"],
      size_bytes: 12,
      registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${digest}` },
      image_ref: `ghcr.io/summersec/deepsonar-base@${digest}`,
      registry_evidence: {
        github: {
          available: true,
          ref: `ghcr.io/summersec/deepsonar-base@${digest}`,
          inspect_digest: digest,
          provenance: "build-push+inspect",
        },
        dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing" },
        "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
      },
    }],
  }],
};

const descriptor = reuseCatalogDescriptor({ catalog, imageKey: "deepsonar-base", digest });
assert.equal(descriptor.version, "0.1.8");
assert.equal(descriptor.digest, digest);
assert.equal(descriptor.ghcr_ref, `ghcr.io/summersec/deepsonar-base@${digest}`);

assert.throws(() => reuseCatalogDescriptor({
  catalog,
  imageKey: "deepsonar-base",
  digest: `sha256:${"b".repeat(64)}`,
}), /no version with digest/i);

const temp = mkdtempSync(path.join(os.tmpdir(), "deepsonar-reuse-descriptor-"));
try {
  const catalogPath = path.join(temp, "catalog.json");
  const out = path.join(temp, "base.json");
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  execFileSync(process.execPath, [
    fileURLToPath(new URL("./reuse-catalog-descriptor.mjs", import.meta.url)),
    "--image-key", "deepsonar-base",
    "--digest", digest,
    "--catalog", catalogPath,
    "--out", out,
  ], { encoding: "utf8" });
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.version, "0.1.8");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("reuse-catalog-descriptor keeps the previous version record");
