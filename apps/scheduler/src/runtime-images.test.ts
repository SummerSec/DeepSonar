import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerOwnedRuntimeImageRegistryPolicy,
  hostRuntimePlatform,
  legacyProjectedRegistryDigests,
  parseOciDigestRef,
  parseRuntimeImageRegistry,
  runtimeImageRegistryNextSyncDelayMs,
  shouldReconcileRuntimeImagePromotions,
  validateRuntimeImageRegistryPolicy,
  type RuntimeImageRegistry,
} from "./runtime-images.js";

const registry = (fallback: boolean): RuntimeImageRegistry => ({
  schema: "deepsonar.registry/v1",
  images: [],
  source: fallback ? "bundled" : "remote",
  fallback,
});

test("bundled fallback 不是可覆盖数据库状态的权威清单", () => {
  assert.equal(shouldReconcileRuntimeImagePromotions(registry(true)), false);
  assert.equal(shouldReconcileRuntimeImagePromotions(registry(false)), true);
});

test("远端同步失败后缩短下一次重试等待", () => {
  assert.equal(runtimeImageRegistryNextSyncDelayMs(3_600_000, true), 60_000);
  assert.equal(runtimeImageRegistryNextSyncDelayMs(3_600_000, false), 3_600_000);
  assert.equal(runtimeImageRegistryNextSyncDelayMs(30_000, true), 30_000);
});

test("宿主架构映射为运行时镜像平台", () => {
  assert.equal(hostRuntimePlatform("x64"), "linux/amd64");
  assert.equal(hostRuntimePlatform("arm64"), "linux/arm64");
  assert.throws(() => hostRuntimePlatform("s390x"), /不支持的 Scheduler 宿主架构/);
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILTIN_ACR_HOST = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com";
const baseImage = {
  image_key: "deepsonar-base",
  name: "DeepSonar Base",
  description: "base",
  publisher: "SummerSec",
  source_kind: "official" as const,
  project_opt_in: false,
};

const acrPolicy = createServerOwnedRuntimeImageRegistryPolicy({
  "aliyun-acr": { hosts: ["registry.cn-hangzhou.aliyuncs.com"], namespaces: ["summersec"] },
});

test("v1 single image_ref is normalized to a known channel without changing the legacy projection", () => {
  const normalized = parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v1",
    images: [{
      ...baseImage,
      versions: [{ version: "0.1.0-linux-amd64", image_ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`, platforms: ["linux/amd64"], size_bytes: 42 }],
    }],
  });
  const version = normalized.images[0]!.versions[0]!;
  assert.equal(version.image_ref, `ghcr.io/summersec/deepsonar-base@${DIGEST}`);
  assert.equal(version.digest, DIGEST);
  assert.deepEqual(version.registry_refs!, { github: version.image_ref });
  assert.equal(parseRuntimeImageRegistry({ schema_version: 1, images: [] }).schema, "deepsonar.registry/v1");
});

test("the current official ACR-only v1 endpoint is accepted, while arbitrary ACR hosts stay rejected", () => {
  const make = (host: string) => ({
    schema: "deepsonar.registry/v1",
    images: [{
      ...baseImage,
      versions: [{ version: "0.1.0-linux-amd64", image_ref: `${host}/summersec/deepsonar-base@${DIGEST}`, platforms: ["linux/amd64"], size_bytes: 42 }],
    }],
  });
  const normalized = parseRuntimeImageRegistry(make(BUILTIN_ACR_HOST));
  assert.deepEqual(normalized.images[0]!.versions[0]!.registry_refs, {
    "aliyun-acr": `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`,
  });
  assert.throws(() => parseRuntimeImageRegistry(make("crpi-other.cn-hangzhou.personal.cr.aliyuncs.com")), /policy|allowed/i);
  assert.throws(() => parseRuntimeImageRegistry(make("registry.cn-hangzhou.aliyuncs.com")), /policy|allowed/i);
});

test("GitHub and Docker Hub policy authority cannot be overridden or smuggled through a direct parser policy", () => {
  assert.throws(() => createServerOwnedRuntimeImageRegistryPolicy({
    github: { hosts: ["evil.example.com"], namespaces: ["summersec"] },
  } as never), /server-owned|overridden|fixed/i);
  const builtin = createServerOwnedRuntimeImageRegistryPolicy();
  assert.ok(Object.isFrozen(builtin));
  assert.ok(Object.isFrozen(builtin.github));
  assert.throws(() => validateRuntimeImageRegistryPolicy({
    ...builtin,
    github: { hosts: ["evil.example.com"], namespaces: ["summersec"] },
  } as never), /server-owned|overridden|fixed/i);
  assert.throws(() => parseRuntimeImageRegistry({ schema: "deepsonar.registry/v1", images: [] }, {
    ...builtin,
    dockerhub: { hosts: ["docker.io", "docker.example.com"], namespaces: ["summersec"] },
  } as never), /server-owned|overridden|fixed/i);
  assert.throws(() => validateRuntimeImageRegistryPolicy({
    ...builtin,
    ["aliyun-acr"]: { hosts: [BUILTIN_ACR_HOST, BUILTIN_ACR_HOST], namespaces: ["summersec"] },
  } as never), /duplicate|ambiguous|policy/i);
});

test("v2 keeps one canonical digest/platform/size and only emits available channel refs", () => {
  const normalized = parseRuntimeImageRegistry({
    schema_version: 2,
    schema: "deepsonar.registry/v2",
    source: "remote",
    images: [{
      ...baseImage,
      versions: [{
        version: "0.1.0",
        digest: DIGEST,
        platforms: ["linux/amd64", "linux/arm64"],
        size_bytes: 42,
        registry_refs: {
          github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
          dockerhub: `docker.io/summersec/deepsonar-base@${DIGEST}`,
          "aliyun-acr": `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${DIGEST}`,
        },
      }],
    }],
  }, acrPolicy);
  const version = normalized.images[0]!.versions[0]!;
  assert.equal(version.digest, DIGEST);
  assert.deepEqual(version.platforms, ["linux/amd64", "linux/arm64"]);
  assert.equal(version.size_bytes, 42);
  assert.equal(version.image_ref, version.registry_refs!.github);
  assert.equal(normalized.source, "remote");
});

test("missing v2 GitHub channel stays unavailable instead of falling back to Docker Hub", () => {
  const normalized = parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    images: [{
      ...baseImage,
      versions: [{
        version: "0.1.0",
        digest: DIGEST,
        platforms: ["linux/amd64"],
        size_bytes: 42,
        registry_refs: { dockerhub: `docker.io/summersec/deepsonar-base@${DIGEST}` },
      }],
    }],
  });
  const version = normalized.images[0]!.versions[0]!;
  assert.equal(version.image_ref, undefined);
  assert.equal(version.registry_refs!.github, undefined);
  assert.equal(version.registry_refs!.dockerhub, `docker.io/summersec/deepsonar-base@${DIGEST}`);
});

test("v2 unavailable channel evidence is explicit and cannot smuggle a ref", () => {
  const baseVersion = {
    version: "0.1.0",
    digest: DIGEST,
    platforms: ["linux/amd64"],
    size_bytes: 42,
    registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` },
    registry_evidence: {
      github: {
        available: true,
        ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
        inspect_digest: DIGEST,
        provenance: "build-push+inspect",
      },
      dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing" },
    },
  };
  const normalized = parseRuntimeImageRegistry({ schema: "deepsonar.registry/v2", images: [{ ...baseImage, versions: [baseVersion] }] });
  assert.equal(normalized.images[0]!.versions[0]!.registry_evidence!.dockerhub!.available, false);
  assert.throws(() => parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    images: [{ ...baseImage, versions: [{ ...baseVersion, registry_evidence: {
      ...baseVersion.registry_evidence,
      dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing", ref: "docker.io/summersec/invalid" },
    } }] }],
  }), /unavailable evidence|ref|inspect/i);
});

test("non-builtin ACR requires an explicit server-owned host and namespace policy", () => {
  const payload = {
    schema: "deepsonar.registry/v2",
    images: [{
      ...baseImage,
      versions: [{
        version: "0.1.0",
        digest: DIGEST,
        platforms: ["linux/amd64"],
        size_bytes: 42,
        registry_refs: { "aliyun-acr": `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${DIGEST}` },
      }],
    }],
  };
  assert.throws(() => parseRuntimeImageRegistry(payload), /policy|allowed|host/i);
  assert.doesNotThrow(() => parseRuntimeImageRegistry(payload, acrPolicy));
});

test("v2 rejects channel/host mismatch, digest mismatch, duplicate refs, and unknown channels", () => {
  const make = (registry_refs: Record<string, string>, digest = DIGEST) => ({
    schema: "deepsonar.registry/v2",
    images: [{
      ...baseImage,
      versions: [{ version: "0.1.0", digest, platforms: ["linux/amd64"], size_bytes: 42, registry_refs }],
    }],
  });
  assert.throws(() => parseRuntimeImageRegistry(make({ dockerhub: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /policy|allowed/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${"b".repeat(64)}` })), /digest/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`, dockerhub: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /policy|allowed|duplicate/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`, unknown: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /unknown channel/i);
  assert.throws(() => parseRuntimeImageRegistry({
    ...make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }),
    images: [{ ...baseImage, versions: [
      { version: "0.1.0", digest: DIGEST, platforms: ["linux/amd64"], size_bytes: 42, registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` } },
      { version: "0.1.1", digest: DIGEST, platforms: ["linux/arm64"], size_bytes: 42, registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` } },
    ] }],
  }), /duplicate/i);
});

test("registry references are globally unique except the proven v1 disjoint-platform alias", () => {
  const ref = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const makeV1 = (images: unknown[]) => ({ schema: "deepsonar.registry/v1", images });
  const image = (imageKey: string, versions: unknown[]) => ({ ...baseImage, image_key: imageKey, versions });
  const version = (platforms?: string[]) => ({ version: `0.1.0-${platforms?.[0] ?? "unknown"}`, image_ref: ref, ...(platforms ? { platforms } : {}) });

  const compatible = parseRuntimeImageRegistry(makeV1([image("deepsonar-base", [
    version(["linux/amd64"]),
    version(["linux/arm64"]),
  ])]));
  assert.equal(compatible.images[0]!.versions.length, 2);
  assert.throws(() => parseRuntimeImageRegistry(makeV1([image("deepsonar-base", [
    version(["linux/amd64"]),
    { ...version(["linux/amd64"]), version: "0.1.0-linux-amd64-duplicate" },
  ])])), /duplicate/i);
  assert.throws(() => parseRuntimeImageRegistry(makeV1([image("deepsonar-base", [
    { version: "0.1.0-a", image_ref: ref },
    { version: "0.1.0-b", image_ref: ref },
  ])])), /duplicate/i);
  assert.throws(() => parseRuntimeImageRegistry(makeV1([
    image("deepsonar-base", [version(["linux/amd64"])]),
    image("deepsonar-audit", [version(["linux/arm64"]) ]),
  ])), /duplicate/i);
});

test("promotion digest projection excludes Docker Hub-only versions", () => {
  const dockerOnly = {
    version: "0.1.0",
    digest: DIGEST,
    registry_refs: { dockerhub: `docker.io/summersec/deepsonar-base@${DIGEST}` },
    platforms: ["linux/amd64"],
    size_bytes: 42,
  };
  const github = {
    ...dockerOnly,
    image_ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
    registry_refs: {
      github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
      dockerhub: `docker.io/summersec/deepsonar-base@${DIGEST}`,
    },
  };
  assert.deepEqual(legacyProjectedRegistryDigests([dockerOnly]), []);
  assert.deepEqual(legacyProjectedRegistryDigests([dockerOnly, github]), [DIGEST]);
});

test("OCI digest parser rejects URL/userinfo/port/tag/query/traversal/uppercase ambiguity", () => {
  const valid = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  assert.deepEqual(parseOciDigestRef(valid), {
    normalized: valid,
    host: "ghcr.io",
    path: "summersec/deepsonar-base",
    digest: DIGEST,
  });
  const invalidRefs = [
    `https://ghcr.io/summersec/deepsonar-base@${DIGEST}`,
    `ghcr.io/user:pass@summersec/deepsonar-base@${DIGEST}`,
    `ghcr.io:443/summersec/deepsonar-base@${DIGEST}`,
    `ghcr.io/summersec/deepsonar-base:latest@${DIGEST}`,
    `ghcr.io/summersec/deepsonar-base?x=1@${DIGEST}`,
    `ghcr.io/summersec/../deepsonar-base@${DIGEST}`,
    `GHCR.IO/summersec/deepsonar-base@${DIGEST}`,
    `ghcr.io//summersec/deepsonar-base@${DIGEST}`,
    `192.0.2.1/summersec/deepsonar-base@${DIGEST}`,
    "ghcr.io/summersec/deepsonar-base:latest",
    `ghcr.io/summersec/deepsonar-base@sha256:${"A".repeat(64)}`,
  ];
  for (const ref of invalidRefs) assert.throws(() => parseOciDigestRef(ref), ref);
});

test("unknown schema and metadata/channel confusion fail closed", () => {
  assert.throws(() => parseRuntimeImageRegistry({ schema: "deepsonar.registry/v3", images: [] }), /schema/i);
  assert.throws(() => parseRuntimeImageRegistry({ schema: "deepsonar.registry/v2", schema_version: 1, images: [] }), /disagree/i);
  assert.throws(() => parseRuntimeImageRegistry({ schema: "deepsonar.registry/v1", source: "github", images: [] }), /source|channel/i);
});
