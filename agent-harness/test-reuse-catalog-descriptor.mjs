import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  CATALOG_REUSE_MISS_EXIT,
  isCatalogReuseMiss,
  reuseCatalogDescriptor,
} from "./reuse-catalog-descriptor.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reuseScript = fileURLToPath(new URL("./reuse-catalog-descriptor.mjs", import.meta.url));
const writeScript = fileURLToPath(new URL("./write-release-runtime-descriptor.sh", import.meta.url));
const maybeSkipScript = fileURLToPath(new URL("./maybe-skip-runtime-version-tags.sh", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;
const missingDigest = `sha256:${"b".repeat(64)}`;
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

let reuseMiss;
try {
  reuseCatalogDescriptor({ catalog, imageKey: "deepsonar-base", digest: missingDigest });
} catch (error) {
  reuseMiss = error;
}
assert.ok(isCatalogReuseMiss(reuseMiss), "digest miss must be a CatalogReuseMiss");
assert.equal(reuseMiss.exitCode, CATALOG_REUSE_MISS_EXIT);
assert.match(reuseMiss.message, /no version with digest/i);

const temp = mkdtempSync(path.join(os.tmpdir(), "deepsonar-reuse-descriptor-"));
try {
  const catalogPath = path.join(temp, "catalog.json");
  const out = path.join(temp, "base.json");
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  execFileSync(process.execPath, [
    reuseScript,
    "--image-key", "deepsonar-base",
    "--digest", digest,
    "--catalog", catalogPath,
    "--out", out,
  ], { encoding: "utf8" });
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.version, "0.1.8");

  const probe = execFileSync(process.execPath, [
    reuseScript,
    "--probe",
    "--image-key", "deepsonar-base",
    "--digest", digest,
    "--catalog", catalogPath,
  ], { encoding: "utf8" });
  assert.match(probe, /reusable: deepsonar-base 0\.1\.8/);

  try {
    execFileSync(process.execPath, [
      reuseScript,
      "--probe",
      "--image-key", "deepsonar-base",
      "--digest", missingDigest,
      "--catalog", catalogPath,
    ], { encoding: "utf8" });
    assert.fail("probe must fail closed when the digest is absent");
  } catch (error) {
    assert.equal(error.status, CATALOG_REUSE_MISS_EXIT);
    assert.match(String(error.stderr), /no version with digest/i);
  }

  const reusedOut = path.join(temp, "reused.json");
  execFileSync("bash", [writeScript, reusedOut], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SKIP: "true",
      IMAGE_KEY: "deepsonar-base",
      DIGEST: digest,
      PREVIOUS_REGISTRY: catalogPath,
    },
  });
  assert.equal(JSON.parse(readFileSync(reusedOut, "utf8")).version, "0.1.8");

  const fallbackOut = path.join(temp, "fallback.json");
  try {
    execFileSync("bash", [writeScript, fallbackOut], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SKIP: "true",
        IMAGE_KEY: "deepsonar-base",
        DIGEST: missingDigest,
        PREVIOUS_REGISTRY: catalogPath,
      },
    });
    assert.fail("write script must reach record-runtime-image-digest when reuse misses");
  } catch (error) {
    assert.notEqual(error.status, CATALOG_REUSE_MISS_EXIT);
    const logs = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    assert.match(logs, /inspecting published channels/i);
    assert.match(logs, /Missing environment variable/i);
    assert.equal(existsSync(fallbackOut), false);
  }

  const githubOutputHit = path.join(temp, "github-output-hit");
  const summaryHit = path.join(temp, "summary-hit");
  execFileSync("bash", [maybeSkipScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SKIP: "true",
      SOURCE_DIGEST: digest,
      IMAGE_KEY: "deepsonar-base",
      PREVIOUS_REGISTRY: catalogPath,
      GITHUB_OUTPUT: githubOutputHit,
      GITHUB_STEP_SUMMARY: summaryHit,
    },
  });
  assert.match(readFileSync(summaryHit, "utf8"), /version kept/);
  assert.match(readFileSync(githubOutputHit, "utf8"), new RegExp(`digest=${digest}`));

  try {
    execFileSync("bash", [maybeSkipScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SKIP: "true",
        SOURCE_DIGEST: missingDigest,
        IMAGE_NAME: "ghcr.io/summersec/deepsonar-base",
        PREVIOUS_REGISTRY: catalogPath,
        GITHUB_OUTPUT: path.join(temp, "github-output-miss"),
      },
    });
    assert.fail("maybe-skip must publish tags when the catalog lacks the digest");
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /publishing version tags/i);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("reuse-catalog-descriptor keeps the previous version record and falls back on catalog miss");
