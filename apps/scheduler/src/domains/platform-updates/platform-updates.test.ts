import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import { requiredScopeForRoute } from "../../auth.js";
import { compareSemverCore, parseRuntimeImageRegistry } from "../../runtime-image-registry-contract.js";
import { discoverPlatformUpdateFromRegistry } from "./discovery.js";
import {
  decidePlatformUpdateCheck,
  normalizePlatformVersionLabel,
  PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN,
  readPlatformUpdateCheckRow,
} from "./model.js";
import { registerPlatformUpdateRoutes } from "./routes.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const CHILD_AMD = `sha256:${"c".repeat(64)}`;
const CHILD_ARM = `sha256:${"d".repeat(64)}`;

const OFFICIAL_MANUAL = {
  contract: "deepsonar.runtime.manuals/v1" as const,
  path: "/opt/deepsonar/manuals/index.json" as const,
  version: "2026.10.15",
  sha256: "e".repeat(64),
  count: 1,
};

function platformImage(repo: string) {
  const ref = `ghcr.io/summersec/${repo}@${DIGEST}`;
  return {
    digest: DIGEST,
    platforms: ["linux/amd64", "linux/arm64"],
    child_digests: { "linux/amd64": CHILD_AMD, "linux/arm64": CHILD_ARM },
    registry_refs: { github: ref },
    registry_evidence: {
      github: {
        available: true as const,
        ref,
        inspect_digest: DIGEST,
        provenance: "build-push+inspect" as const,
      },
      dockerhub: { available: false as const, provenance: "unavailable" as const, reason: "credentials_missing" },
      "aliyun-acr": { available: false as const, provenance: "unavailable" as const, reason: "credentials_missing" },
    },
  };
}

function sampleRegistry(overrides: Record<string, unknown> = {}) {
  return {
    schema: "deepsonar.registry/v2" as const,
    schema_version: 2 as const,
    platform_version: "0.5.7",
    platform: {
      version: "0.5.7",
      commit_sha: "abcdef0123456789",
      schema_version: 58,
      changelog_url: "https://github.com/SummerSec/DeepSonar/releases/tag/v0.5.7",
      images: {
        scheduler: platformImage("deepsonar-scheduler"),
        web: platformImage("deepsonar-web"),
        "image-admission": platformImage("deepsonar-image-admission"),
      },
    },
    min_runtime_image: { version: "0.2.7" },
    images: [{
      image_key: "deepsonar-base",
      name: "Base",
      description: "base",
      publisher: "SummerSec",
      source_kind: "official" as const,
      project_opt_in: false,
      versions: [{
        version: "0.5.7",
        digest: DIGEST,
        platforms: ["linux/amd64"],
        size_bytes: 1,
        manual: OFFICIAL_MANUAL,
        registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` },
        registry_evidence: {
          github: {
            available: true as const,
            ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
            inspect_digest: DIGEST,
            provenance: "build-push+inspect" as const,
          },
          dockerhub: { available: false as const, provenance: "unavailable" as const, reason: "credentials_missing" },
          "aliyun-acr": { available: false as const, provenance: "unavailable" as const, reason: "credentials_missing" },
        },
      }],
    }],
    source: "remote" as const,
    ...overrides,
  };
}

test("normalizePlatformVersionLabel strips v and keeps X.Y.Z core", () => {
  assert.equal(normalizePlatformVersionLabel("v0.5.6"), "0.5.6");
  assert.equal(normalizePlatformVersionLabel("0.5.6"), "0.5.6");
  assert.equal(normalizePlatformVersionLabel("  "), null);
  assert.equal(normalizePlatformVersionLabel("latest"), null);
});

test("decidePlatformUpdateCheck only advances when available > current", () => {
  const newer = decidePlatformUpdateCheck({
    currentVersionRaw: "0.5.6",
    deployedSchemaVersion: 57,
    platform: { version: "0.5.7", commit_sha: "abc", schema_version: 58, changelog_url: "https://github.com/SummerSec/DeepSonar/releases/tag/v0.5.7" },
    platformVersionFallback: "0.5.7",
    registrySource: "remote",
    fallback: false,
    fetchError: null,
    compareSemver: compareSemverCore,
  });
  assert.equal(newer.update_available, true);
  assert.equal(newer.schema_rebuild_needed, true);
  assert.equal(newer.available_version, "0.5.7");

  const same = decidePlatformUpdateCheck({
    currentVersionRaw: "v0.5.7",
    deployedSchemaVersion: 58,
    platform: { version: "0.5.7", commit_sha: "abc", schema_version: 58 },
    platformVersionFallback: "0.5.7",
    registrySource: "remote",
    fallback: false,
    fetchError: null,
    compareSemver: compareSemverCore,
  });
  assert.equal(same.update_available, false);
  assert.equal(same.schema_rebuild_needed, false);

  const older = decidePlatformUpdateCheck({
    currentVersionRaw: "0.5.8",
    deployedSchemaVersion: 58,
    platform: { version: "0.5.7", commit_sha: "abc", schema_version: 58 },
    platformVersionFallback: "0.5.7",
    registrySource: "remote",
    fallback: false,
    fetchError: null,
    compareSemver: compareSemverCore,
  });
  assert.equal(older.update_available, false);
});

test("GitHub unreachable records check_error and never invents an update", () => {
  const decision = decidePlatformUpdateCheck({
    currentVersionRaw: "0.5.6",
    deployedSchemaVersion: 57,
    platform: { version: "0.5.7", commit_sha: "abc", schema_version: 58 },
    platformVersionFallback: "0.5.7",
    registrySource: "bundled",
    fallback: true,
    fetchError: "remote registry unavailable",
    compareSemver: compareSemverCore,
  });
  assert.equal(decision.update_available, false);
  assert.equal(decision.check_error, "remote registry unavailable");
  assert.equal(decision.available_version, null);
});

test("parseRuntimeImageRegistry accepts platform digests and rejects unknown keys", () => {
  const parsed = parseRuntimeImageRegistry(sampleRegistry());
  assert.equal(parsed.platform?.version, "0.5.7");
  assert.equal(parsed.platform?.schema_version, 58);
  assert.equal(parsed.platform?.images.scheduler.digest, DIGEST);
  assert.equal(parsed.platform?.images.scheduler.child_digests["linux/amd64"], CHILD_AMD);
  assert.throws(() => parseRuntimeImageRegistry(sampleRegistry({
    platform: { ...sampleRegistry().platform, extra: true },
  })), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry(sampleRegistry({
    platform: {
      ...sampleRegistry().platform!,
      version: "0.5.8",
    },
  })), /platform\.version must equal platform_version/i);
  assert.throws(() => parseRuntimeImageRegistry(sampleRegistry({
    platform: {
      ...sampleRegistry().platform!,
      images: {
        ...sampleRegistry().platform!.images,
        scheduler: {
          ...platformImage("deepsonar-scheduler"),
          registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` },
          registry_evidence: {
            github: {
              available: true,
              ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
              inspect_digest: DIGEST,
              provenance: "build-push+inspect",
            },
            dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing" },
            "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
          },
        },
      },
    },
  })), /deepsonar-scheduler/i);
});

test("discoverPlatformUpdateFromRegistry wires catalog → decision", () => {
  const decision = discoverPlatformUpdateFromRegistry(parseRuntimeImageRegistry(sampleRegistry()), {
    currentVersionRaw: "0.5.6",
    deployedSchemaVersion: 57,
  });
  assert.equal(decision.update_available, true);
  assert.equal(decision.schema_rebuild_needed, true);
  assert.equal(decision.available_commit_sha, "abcdef0123456789");
});

test("legacy catalogs without platform still compare platform_version", () => {
  const registry = parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    schema_version: 2,
    platform_version: "0.5.7",
    min_runtime_image: { version: "0.2.7" },
    images: sampleRegistry().images,
    source: "bundled",
  });
  const decision = discoverPlatformUpdateFromRegistry(registry, {
    currentVersionRaw: "0.5.6",
    deployedSchemaVersion: 57,
  });
  assert.equal(decision.update_available, true);
  assert.equal(decision.schema_rebuild_needed, false);
  assert.equal(decision.available_commit_sha, null);
  assert.match(decision.changelog_url ?? "", /releases\/tag\/v0\.5\.7/);
});

test("missing check row projects as missing=true", () => {
  const status = readPlatformUpdateCheckRow(undefined);
  assert.equal(status.missing, true);
  assert.equal(status.update_available, false);
});

test("GET /platform/updates requires admin and rejects project tokens", async () => {
  assert.equal(requiredScopeForRoute("GET", "/platform/updates"), "admin");
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as { actor?: { projectId?: string; type?: string } }).actor = {
      type: "api_token",
      projectId: "00000000-0000-4000-8000-000000000001",
    };
  });
  registerPlatformUpdateRoutes(app, { begin() { throw new Error("db should not run"); } } as never);
  await app.ready();
  const forbidden = await app.inject({ method: "GET", url: "/platform/updates" });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error_code, PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN);
  await app.close();
});

test("route surface and auth table mention /platform/updates", () => {
  const manifest = readFileSync(new URL("../../route-surface.manifest.ts", import.meta.url), "utf8");
  assert.match(manifest, /GET \/platform\/updates/);
  const auth = readFileSync(new URL("../../auth.ts", import.meta.url), "utf8");
  assert.match(auth, /GET \/platform\/updates.*admin/);
});
