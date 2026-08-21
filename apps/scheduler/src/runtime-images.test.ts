import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimeImageAvailable,
  canPreemptRuntimeImagePreparation,
  compareRuntimeImageVersionLabels,
  createServerOwnedRuntimeImageRegistryPolicy,
  ensureRuntimeImageAvailable,
  hostRuntimePlatform,
  isStartupRequiredRuntimeImage,
  legacyProjectedRegistryDigests,
  parseOciDigestRef,
  parseRuntimeImageRegistry,
  runtimeImageRefForChannel,
  runtimeImageVersionPin,
  classifyRuntimeImagePin,
  diagnoseRuntimeImageSelectionFailure,
  officialDefaultImageRevokedWarning,
  requestRuntimeImagePreparation,
  resetRuntimeImagePullTask,
  registryChannelPreparationBusyResult,
  runtimeImageHttpError,
  runtimeImagePreparationCovers,
  RuntimeImageNotReadyError,
  RuntimeImagePreparationBusyError,
  RuntimeImageNotTrustedError,
  RuntimeImagePinStaleError,
  RuntimeImagePlatformUnavailableError,
  RuntimeImageRevokedError,
  runtimeImageRegistryNextSyncDelayMs,
  selectLatestRuntimeImagePullItems,
  selectRuntimeImageRef,
  officialCatalogWriteMode,
  shouldReconcileRuntimeImagePromotions,
  validateRuntimeImageRegistryPolicy,
  verifiedSameDigestChannelRefs,
  runRuntimeImagePreparationTask,
  withSharedAssetsHelperRef,
  RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR,
  RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR,
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
  assert.equal(officialCatalogWriteMode(registry(true)), "insert-only");
  assert.equal(officialCatalogWriteMode(registry(false)), "authoritative");
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

const REGISTRY_CHANNELS = ["github", "dockerhub", "aliyun-acr"] as const;
function evidenceFor(refs: Record<string, string>) {
  return Object.fromEntries(REGISTRY_CHANNELS.map((channel) => refs[channel]
    ? [channel, { available: true, ref: refs[channel], inspect_digest: DIGEST, provenance: channel === "github" ? "build-push+inspect" : "cross-registry-copy+inspect" }]
    : [channel, { available: false, provenance: "unavailable", reason: "credentials_missing" }])) as Record<string, unknown>;
}

const acrPolicy = createServerOwnedRuntimeImageRegistryPolicy({
  "aliyun-acr": { hosts: ["registry.cn-hangzhou.aliyuncs.com"], namespaces: ["summersec"] },
});

test("legacy official env refs resolve only through their matching registry channel", () => {
  const githubRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const version = { version: "configured", image_ref: githubRef, digest: DIGEST };
  assert.equal(runtimeImageRefForChannel(version, "github"), githubRef);
  assert.equal(runtimeImageRefForChannel(version, "dockerhub"), null);
  assert.equal(runtimeImageRefForChannel(version, "aliyun-acr"), null);
});

test("omitted project version keeps track-latest semantics", () => {
  assert.equal(runtimeImageVersionPin(undefined), null);
  assert.equal(runtimeImageVersionPin(null), null);
  assert.equal(runtimeImageVersionPin("00000000-0000-0000-0000-000000000001"), "00000000-0000-0000-0000-000000000001");
});

test("async pull defaults to one latest channel ref per product", () => {
  const older = `sha256:${"b".repeat(64)}`;
  const newer = `sha256:${"c".repeat(64)}`;
  const armOnly = `sha256:${"d".repeat(64)}`;
  const items = selectLatestRuntimeImagePullItems([
    {
      image_key: "deepsonar-base",
      versions: [
        {
          version: "0.1.33",
          image_ref: `ghcr.io/summersec/deepsonar-base@${older}`,
          digest: older,
          registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${older}` },
          platforms: ["linux/amd64", "linux/arm64"],
        },
        {
          version: "0.1.34",
          image_ref: `ghcr.io/summersec/deepsonar-base@${newer}`,
          digest: newer,
          registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${newer}` },
          platforms: ["linux/amd64", "linux/arm64"],
        },
      ],
    },
    {
      image_key: "deepsonar-audit",
      versions: [
        {
          version: "0.1.34",
          image_ref: `ghcr.io/summersec/deepsonar-audit@${armOnly}`,
          digest: armOnly,
          registry_refs: { github: `ghcr.io/summersec/deepsonar-audit@${armOnly}` },
          platforms: ["linux/arm64"],
        },
        {
          version: "0.1.33",
          image_ref: `ghcr.io/summersec/deepsonar-audit@${older}`,
          digest: older,
          registry_refs: { github: `ghcr.io/summersec/deepsonar-audit@${older}` },
          platforms: ["linux/amd64"],
        },
      ],
    },
  ], "github", "linux/amd64");
  assert.deepEqual(items, [
    { image_key: "deepsonar-base", image_ref: `ghcr.io/summersec/deepsonar-base@${newer}` },
    // Prefer host platform over a newer arm-only label.
    { image_key: "deepsonar-audit", image_ref: `ghcr.io/summersec/deepsonar-audit@${older}` },
  ]);
  assert.ok(compareRuntimeImageVersionLabels("0.1.34", "0.1.33") > 0);
});

test("bulk selection is strict about host platform and selected channel", () => {
  const armRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  assert.deepEqual(selectLatestRuntimeImagePullItems([{
    image_key: "deepsonar-base",
    versions: [{
      version: "0.1.0",
      digest: DIGEST,
      image_ref: armRef,
      registry_refs: { github: armRef, "aliyun-acr": acrRef },
      platforms: ["linux/amd64"],
    }],
  }], "aliyun-acr", "linux/amd64"), [{ image_key: "deepsonar-base", image_ref: acrRef }]);

  assert.throws(() => selectLatestRuntimeImagePullItems([{
    image_key: "deepsonar-base",
    versions: [{
      version: "0.1.0",
      digest: DIGEST,
      image_ref: armRef,
      registry_refs: { github: armRef },
      platforms: ["linux/arm64"],
    }],
  }], "github", "linux/amd64"), RuntimeImagePlatformUnavailableError);

  assert.throws(() => selectLatestRuntimeImagePullItems([{
    image_key: "deepsonar-base",
    versions: [{
      version: "0.1.0",
      digest: DIGEST,
      image_ref: armRef,
      registry_refs: { github: armRef },
      platforms: ["linux/amd64"],
    }],
  }], "aliyun-acr", "linux/amd64"), /aliyun-acr/);

  assert.throws(() => selectLatestRuntimeImagePullItems([{
    image_key: "legacy-unknown-platform",
    versions: [{
      version: "legacy",
      digest: DIGEST,
      image_ref: armRef,
      registry_refs: { github: armRef },
      platforms: [],
    }],
  }], "github", "linux/amd64"), /platforms explicitly/);
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
    dockerhub: { hosts: ["docker.io", "docker.example.com"], namespaces: ["sumsec"] },
  } as never), /server-owned|overridden|fixed/i);
  assert.throws(() => validateRuntimeImageRegistryPolicy({
    ...builtin,
    ["aliyun-acr"]: { hosts: [BUILTIN_ACR_HOST, BUILTIN_ACR_HOST], namespaces: ["summersec"] },
  } as never), /duplicate|ambiguous|policy/i);
});

test("v2 keeps one canonical digest/platform/size and only emits available channel refs", () => {
  const refs = {
    github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
    dockerhub: `docker.io/sumsec/deepsonar-base@${DIGEST}`,
    "aliyun-acr": `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${DIGEST}`,
  };
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
        registry_refs: refs,
        registry_evidence: evidenceFor(refs),
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

test("v2 requires inspected GitHub evidence before a channel can be consumed", () => {
  assert.throws(() => parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    images: [{
      ...baseImage,
      versions: [{
        version: "0.1.0",
        digest: DIGEST,
        platforms: ["linux/amd64"],
        size_bytes: 42,
        registry_refs: { dockerhub: `docker.io/sumsec/deepsonar-base@${DIGEST}` },
      }],
    }],
  }), /registry_evidence|github/i);
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
      "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
    },
  };
  const normalized = parseRuntimeImageRegistry({ schema: "deepsonar.registry/v2", images: [{ ...baseImage, versions: [baseVersion] }] });
  assert.equal(normalized.images[0]!.versions[0]!.registry_evidence!.dockerhub!.available, false);
  assert.throws(() => parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    images: [{ ...baseImage, versions: [{ ...baseVersion, registry_evidence: {
      ...baseVersion.registry_evidence,
      dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing", ref: "docker.io/sumsec/invalid" },
    } }] }],
  }), /unavailable evidence|ref|inspect/i);
});

test("v2 catalog exact keys, project_opt_in types, and evidence/ref state fail closed", () => {
  const version = {
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
      "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
    },
  };
  const payload = () => ({ schema: "deepsonar.registry/v2", images: [{ ...baseImage, versions: [structuredClone(version)] }] });
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), untrusted_extra: true }), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, untrusted_extra: true, versions: [structuredClone(version)] }] }), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, versions: [{ ...structuredClone(version), untrusted_extra: true }] }] }), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, versions: [{ ...structuredClone(version), registry_evidence: { ...structuredClone(version.registry_evidence), github: { ...version.registry_evidence.github, untrusted_extra: true } } }] }] }), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, project_opt_in: "false", versions: [structuredClone(version)] }] }), /project_opt_in.*boolean/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), fallback: true }), /unknown fields/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, versions: [{ ...structuredClone(version), registry_evidence: { ...structuredClone(version.registry_evidence), github: { available: false, provenance: "unavailable", reason: "credentials_missing" } } }] }] }), /unavailable evidence|registry_refs/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, versions: [{ ...structuredClone(version), registry_evidence: { ...structuredClone(version.registry_evidence), github: { ...version.registry_evidence.github, provenance: "fixture+inspect" } } }] }] }), /provenance/i);
  assert.throws(() => parseRuntimeImageRegistry({ ...payload(), images: [{ ...baseImage, versions: [{ ...structuredClone(version), registry_evidence: { ...structuredClone(version.registry_evidence), dockerhub: { available: false, provenance: "unavailable", reason: "credentials missing" } } }] }] }), /reason/i);
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
        registry_refs: {
          github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
          "aliyun-acr": `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${DIGEST}`,
        },
        registry_evidence: evidenceFor({
          github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
          "aliyun-acr": `registry.cn-hangzhou.aliyuncs.com/summersec/deepsonar-base@${DIGEST}`,
        }),
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
      versions: [{ version: "0.1.0", digest, platforms: ["linux/amd64"], size_bytes: 42, registry_refs, registry_evidence: evidenceFor(registry_refs) }],
    }],
  });
  assert.throws(() => parseRuntimeImageRegistry(make({ dockerhub: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /policy|allowed/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${"b".repeat(64)}` })), /digest/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`, dockerhub: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /policy|allowed|duplicate/i);
  assert.throws(() => parseRuntimeImageRegistry(make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`, unknown: `ghcr.io/summersec/deepsonar-base@${DIGEST}` })), /unknown channel/i);
  assert.throws(() => parseRuntimeImageRegistry({
    ...make({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }),
    images: [{ ...baseImage, versions: [
      { version: "0.1.0", digest: DIGEST, platforms: ["linux/amd64"], size_bytes: 42, registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }, registry_evidence: evidenceFor({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }) },
      { version: "0.1.1", digest: DIGEST, platforms: ["linux/arm64"], size_bytes: 42, registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }, registry_evidence: evidenceFor({ github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` }) },
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
    registry_refs: { dockerhub: `docker.io/sumsec/deepsonar-base@${DIGEST}` },
    platforms: ["linux/amd64"],
    size_bytes: 42,
  };
  const github = {
    ...dockerOnly,
    image_ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
    registry_refs: {
      github: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
      dockerhub: `docker.io/sumsec/deepsonar-base@${DIGEST}`,
    },
  };
  assert.deepEqual(legacyProjectedRegistryDigests([dockerOnly]), []);
  assert.deepEqual(legacyProjectedRegistryDigests([dockerOnly, github]), [DIGEST]);
});

test("catalog admission ref follows the configured deployment registry", () => {
  const githubRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const acrRef = `crpi.example.com/summersec/deepsonar-base@${DIGEST}`;
  const version = {
    version: "0.1.0",
    image_ref: githubRef,
    digest: DIGEST,
    registry_refs: { github: githubRef, "aliyun-acr": acrRef },
  };
  assert.equal(selectRuntimeImageRef("deepsonar-base", version, "crpi.example.com/summersec"), acrRef);
  assert.equal(selectRuntimeImageRef("deepsonar-base", version, ""), githubRef);
  assert.throws(
    () => selectRuntimeImageRef("deepsonar-base", version, "registry.internal/summersec"),
    /没有匹配 DEEPSONAR_IMAGE_REGISTRY/,
  );
  assert.throws(
    () => selectRuntimeImageRef("deepsonar-base", version, "https://crpi.example.com/summersec"),
    /必须是 registry\/namespace 基址/,
  );
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

test("dispatcher availability assertion is inspect-only", async () => {
  const imageRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  await assertRuntimeImageAvailable(imageRef, async () => ({ exists: true, repo_digests: [imageRef] }));
  await assert.rejects(
    assertRuntimeImageAvailable(imageRef, async () => ({ exists: false })),
    (error: unknown) => error instanceof RuntimeImageNotReadyError && error.code === "runtime_image_not_ready",
  );
});

test("dispatcher inspect 以冻结 digest 为准，不要求 ACR RepoDigest", async () => {
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  const dockerhubRef = `docker.io/sumsec/deepsonar@${DIGEST}`;
  await assertRuntimeImageAvailable(acrRef, async (ref) => {
    if (ref === acrRef) return { exists: false };
    if (ref === dockerhubRef || ref === DIGEST) return { exists: true, repo_digests: [dockerhubRef] };
    return { exists: false };
  }, { sameDigestRefs: () => [dockerhubRef] });
});

test("本地已有准确 digest 时不拉取镜像", async () => {
  const imageRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  let pulls = 0;
  await ensureRuntimeImageAvailable(imageRef, {
    inspect: async () => ({ exists: true, image_id: DIGEST }),
    pull: async () => { pulls += 1; },
  });
  assert.equal(pulls, 0);
});

test("本地缺失时只拉取冻结的 digest 引用并复检", async () => {
  const imageRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const inspected: string[] = [];
  let pulled = false;
  await ensureRuntimeImageAvailable(imageRef, {
    inspect: async (ref) => {
      inspected.push(ref);
      if (pulled && (ref === imageRef || ref === DIGEST)) return { exists: true, repo_digests: [imageRef] };
      return { exists: false };
    },
    pull: async (ref) => {
      assert.equal(ref, imageRef);
      pulled = true;
    },
  });
  assert.equal(pulled, true);
  assert.ok(inspected.includes(imageRef));
  assert.ok(inspected.includes(DIGEST));
});

test("本地已有 dockerhub digest 时 aliyun-acr warmup 不再 pull", async () => {
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  const dockerhubRef = `docker.io/sumsec/deepsonar@${DIGEST}`;
  const pulled: string[] = [];
  await ensureRuntimeImageAvailable(acrRef, {
    inspect: async (ref) => {
      if (ref === acrRef) return { exists: false };
      if (ref === dockerhubRef || ref === DIGEST) {
        return {
          exists: true,
          image_id: `sha256:${"c".repeat(64)}`,
          repo_digests: [dockerhubRef],
        };
      }
      return { exists: false };
    },
    pull: async (ref) => { pulled.push(ref); },
    sameDigestRefs: () => [dockerhubRef],
  });
  assert.deepEqual(pulled, []);
});

test("ACR pull 超时后改拉同 digest 的 dockerhub 引用并标记 ready", async () => {
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  const dockerhubRef = `docker.io/sumsec/deepsonar@${DIGEST}`;
  const pulled: string[] = [];
  const present = new Set<string>();
  await ensureRuntimeImageAvailable(acrRef, {
    inspect: async (ref) => {
      if (present.has(dockerhubRef) && (ref === dockerhubRef || ref === DIGEST)) {
        return { exists: true, repo_digests: [dockerhubRef] };
      }
      return { exists: false };
    },
    pull: async (ref) => {
      pulled.push(ref);
      if (ref === acrRef) {
        throw new Error("failed to copy: httpReadSeeker: failed open: Get http://aliregistry.oss-cn-hangzhou.aliyuncs.com/docker/registry/v2/blobs/sha256/9d/9d25830889ce: net/http: timeout awaiting response headers");
      }
      if (ref === dockerhubRef) present.add(ref);
    },
    sameDigestRefs: () => [dockerhubRef],
  });
  assert.deepEqual(pulled, [acrRef, dockerhubRef]);
});

test("通道超时且同 digest 兜底失败时错误文案可与 digest not found 区分", async () => {
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  const dockerhubRef = `docker.io/sumsec/deepsonar@${DIGEST}`;
  await assert.rejects(
    ensureRuntimeImageAvailable(acrRef, {
      inspect: async () => ({ exists: false }),
      pull: async () => {
        throw new Error("failed to copy: httpReadSeeker: net/http: timeout awaiting response headers");
      },
      sameDigestRefs: () => [dockerhubRef],
    }),
    (error: unknown) => {
      assert.match(String(error), new RegExp(RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR));
      assert.doesNotMatch(String(error), new RegExp(`${RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR}:`));
      return true;
    },
  );
});

test("通道回报缺失时使用 digest not found 而不是超时兜底文案", async () => {
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  await assert.rejects(
    ensureRuntimeImageAvailable(acrRef, {
      inspect: async () => ({ exists: false }),
      pull: async () => { throw new Error("manifest unknown: digest not found"); },
    }),
    (error: unknown) => {
      assert.match(String(error), new RegExp(RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR));
      assert.doesNotMatch(String(error), new RegExp(RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR));
      return true;
    },
  );
});

test("清单证据只返回已核实的同 digest 其它通道引用", () => {
  const dockerhubRef = `docker.io/sumsec/deepsonar@${DIGEST}`;
  const githubRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  const acrRef = `${BUILTIN_ACR_HOST}/summersec/deepsonar-base@${DIGEST}`;
  const refs = verifiedSameDigestChannelRefs([{
    ...baseImage,
    versions: [{
      version: "0.1.40",
      digest: DIGEST,
      platforms: ["linux/amd64"],
      registry_refs: { github: githubRef, dockerhub: dockerhubRef, "aliyun-acr": acrRef },
      registry_evidence: evidenceFor({ github: githubRef, dockerhub: dockerhubRef, "aliyun-acr": acrRef }),
    }],
  }], DIGEST, acrRef);
  assert.deepEqual(refs, [dockerhubRef, githubRef]);
});

test("startup warmup 集合包含共享资产 helper", () => {
  const helper = `docker.io/library/busybox@sha256:${"f".repeat(64)}`;
  const refs = withSharedAssetsHelperRef(
    [{ image_ref: `registry.invalid/base@${DIGEST}`, image_key: "deepsonar-base" }],
    helper,
  );
  assert.deepEqual(refs.map((item) => item.image_key), ["deepsonar-base", "shared-assets-helper"]);
  assert.equal(refs.at(-1)?.image_ref, helper);
});

test("同一 digest 的并发确保请求共用一次拉取", async () => {
  const imageRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  let pulls = 0;
  let releasePull!: () => void;
  const pullBlocked = new Promise<void>((resolve) => { releasePull = resolve; });
  const options = {
    inspect: async () => ({ exists: false }),
    pull: async () => { pulls += 1; await pullBlocked; },
  };
  const first = ensureRuntimeImageAvailable(imageRef, options);
  const second = ensureRuntimeImageAvailable(imageRef, options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 1);
  releasePull();
  await assert.rejects(Promise.all([first, second]), /不可用/);
});

test("bootstrap warmup only requires official non-opt-in images", () => {
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: false, enabled: true }), true);
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: true, enabled: true }), false);
  assert.equal(isStartupRequiredRuntimeImage({ official: false, project_opt_in: false, enabled: true }), false);
  assert.equal(isStartupRequiredRuntimeImage(null), true);
});

test("拉取失败返回脱敏错误", async () => {
  const imageRef = `ghcr.io/summersec/deepsonar-base@${DIGEST}`;
  await assert.rejects(
    ensureRuntimeImageAvailable(imageRef, {
      inspect: async () => ({ exists: false }),
      pull: async () => { throw new Error("authorization=super-secret-token"); },
    }),
    (error: unknown) => {
      assert.match(String(error), /冻结 runtime image 拉取失败/);
      assert.doesNotMatch(String(error), /super-secret-token/);
      return true;
    },
  );
});

test("null pin follows latest trusted; explicit pin stays until it is no longer executable", () => {
  const latest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const pin = "99999999-9999-4999-8999-999999999999";
  assert.equal(classifyRuntimeImagePin({
    selectedVersionId: null,
    pinMatchesExecutableTrusted: false,
    latestTrustedVersionId: latest,
  }), "follow_latest");
  assert.equal(classifyRuntimeImagePin({
    selectedVersionId: pin,
    pinMatchesExecutableTrusted: true,
    latestTrustedVersionId: latest,
  }), "pin_ok");
  assert.equal(classifyRuntimeImagePin({
    selectedVersionId: pin,
    pinMatchesExecutableTrusted: false,
    latestTrustedVersionId: latest,
  }), "pin_stale");
  assert.equal(classifyRuntimeImagePin({
    selectedVersionId: pin,
    pinMatchesExecutableTrusted: false,
    latestTrustedVersionId: null,
  }), "unavailable");
  assert.equal(classifyRuntimeImagePin({
    selectedVersionId: null,
    pinMatchesExecutableTrusted: false,
    latestTrustedVersionId: null,
  }), "unavailable");
});

test("stale pin HTTP mapping is 409 with an upgrade action, not a generic 500", () => {
  const error = new RuntimeImagePinStaleError(
    "deepsonar-base",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "99999999-9999-4999-8999-999999999999",
    "0.1.38",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "0.1.39",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  );
  const mapped = runtimeImageHttpError(error);
  assert.equal(mapped?.statusCode, 409);
  assert.equal(mapped?.body.error_code, "RUNTIME_IMAGE_PIN_STALE");
  assert.equal(mapped?.body.image_key, "deepsonar-base");
  assert.equal(mapped?.body.selected_version, "0.1.38");
  assert.equal(mapped?.body.latest_version, "0.1.39");
  assert.match(String(mapped?.body.error), /0\.1\.38/);
  assert.match(String(mapped?.body.error), /0\.1\.39/);
  assert.deepEqual(mapped?.body.upgrade, {
    method: "PUT",
    path: "/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc/runtime-images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    body: { enabled: true, version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    follow_latest_body: { enabled: true, version_id: null },
  });
  assert.equal(runtimeImageHttpError(new Error("runtime image binding has no matching trusted version")), null);
});

test("selector diagnosis distinguishes revoked official versions from missing platforms", () => {
  const hostPlatform = "linux/amd64";
  const revoked = diagnoseRuntimeImageSelectionFailure({
    imageKey: "deepsonar-base",
    official: true,
    hostPlatform,
    channel: "aliyun-acr",
    hasTrustedHostPlatform: false,
    hasTrustedVersion: false,
    hasRevokedHostPlatform: true,
    hasRevokedVersion: true,
    hasSelectedRef: false,
  });
  assert.ok(revoked instanceof RuntimeImageRevokedError);
  assert.equal(revoked.code, "RUNTIME_IMAGE_REVOKED");
  const mappedRevoked = runtimeImageHttpError(revoked);
  assert.equal(mappedRevoked?.statusCode, 409);
  assert.equal(mappedRevoked?.body.error_code, "RUNTIME_IMAGE_REVOKED");
  assert.equal(mappedRevoked?.body.image_key, "deepsonar-base");
  assert.doesNotMatch(String(mappedRevoked?.body.error), /platforms explicitly/);

  const notTrusted = diagnoseRuntimeImageSelectionFailure({
    imageKey: "deepsonar-base",
    official: true,
    hostPlatform,
    channel: "aliyun-acr",
    hasTrustedHostPlatform: false,
    hasTrustedVersion: false,
    hasRevokedHostPlatform: false,
    hasRevokedVersion: false,
    hasSelectedRef: false,
  });
  assert.ok(notTrusted instanceof RuntimeImageNotTrustedError);
  assert.equal(runtimeImageHttpError(notTrusted)?.body.error_code, "RUNTIME_IMAGE_NOT_TRUSTED");

  const missingPlatform = diagnoseRuntimeImageSelectionFailure({
    imageKey: "deepsonar-base",
    official: true,
    hostPlatform,
    channel: "aliyun-acr",
    hasTrustedHostPlatform: false,
    hasTrustedVersion: true,
    hasRevokedHostPlatform: false,
    hasRevokedVersion: false,
    hasSelectedRef: true,
  });
  assert.ok(missingPlatform instanceof RuntimeImagePlatformUnavailableError);
  assert.equal(officialDefaultImageRevokedWarning("deepsonar-base"), "official default image deepsonar-base revoked");
});

test("preparation lock reuses same digest across registry hosts", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const task = {
    items: [{ image_key: "base", image_ref: `cr.example.invalid/base@${digest}`, status: "running" as const, error: null }],
  };
  assert.equal(runtimeImagePreparationCovers(task, [
    { image_ref: `ghcr.io/example/base@${digest}` },
  ]), true);
  assert.equal(runtimeImagePreparationCovers(task, [
    { image_ref: `ghcr.io/example/other@sha256:${"b".repeat(64)}` },
  ]), false);
  assert.equal(canPreemptRuntimeImagePreparation("admin_bulk", "registry_channel:github"), true);
  assert.equal(canPreemptRuntimeImagePreparation("project_binding:p:i", "registry_channel:github"), false);
});

test("channel switch busy payload stays 202 and does not persist", () => {
  const body = registryChannelPreparationBusyResult("aliyun-acr", "github", {
    task_id: "task",
    purpose: "admin_bulk",
    status: "running",
    started_at: null,
    finished_at: null,
    total: 1,
    completed: 0,
    items: [],
  });
  assert.equal(body.saved, false);
  assert.equal(body.status, "preparing");
  assert.equal(body.selected_channel, "aliyun-acr");
  assert.equal(body.proposed_channel, "github");
  assert.equal(body.task?.purpose, "admin_bulk");
});

test("abnormal preparation exit leaves queued/running", async () => {
  const items = [{
    image_key: "base",
    image_ref: `example.invalid/base@sha256:${"c".repeat(64)}`,
    status: "queued" as const,
    error: null,
  }];
  let reads = 0;
  const task = {
    task_id: "task",
    purpose: "admin_bulk",
    status: "queued" as const,
    started_at: null,
    finished_at: null,
    total: 1,
    completed: 0,
    get items() {
      reads += 1;
      if (reads > 1) throw new Error("iterator exploded");
      return items;
    },
  };
  await runRuntimeImagePreparationTask(task, async () => {});
  assert.equal(task.status, "failed");
  assert.ok(task.finished_at);
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("channel switch reuses an in-flight prep for the same digest on another host", async () => {
  resetRuntimeImagePullTask();
  const digest = `sha256:${"d".repeat(64)}`;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = await requestRuntimeImagePreparation(
      [{ image_key: "base", image_ref: `cr.example.invalid/base@${digest}` }],
      "admin_bulk",
      { inspect: async () => ({ exists: false }), prepare: async () => blocked },
    );
    assert.equal(first.ready, false);
    if (first.ready) return;
    const second = await requestRuntimeImagePreparation(
      [{ image_key: "base", image_ref: `ghcr.io/example/base@${digest}` }],
      "registry_channel:github",
      { inspect: async () => ({ exists: false }), prepare: async () => blocked },
    );
    assert.equal(second.ready, false);
    if (second.ready) return;
    assert.equal(second.task.task_id, first.task.task_id);
    assert.equal(second.task.purpose, "admin_bulk");
  } finally {
    release();
    await flush();
    resetRuntimeImagePullTask();
  }
});

test("channel switch preempts a current-channel admin_bulk with different digest", async () => {
  resetRuntimeImagePullTask();
  let releaseAdmin!: () => void;
  const adminBlocked = new Promise<void>((resolve) => { releaseAdmin = resolve; });
  let releaseChannel!: () => void;
  const channelBlocked = new Promise<void>((resolve) => { releaseChannel = resolve; });
  try {
    const admin = await requestRuntimeImagePreparation(
      [{ image_key: "base", image_ref: `cr.example.invalid/base@sha256:${"e".repeat(64)}` }],
      "admin_bulk",
      { inspect: async () => ({ exists: false }), prepare: async () => adminBlocked },
    );
    assert.equal(admin.ready, false);
    if (admin.ready) return;
    const channel = await requestRuntimeImagePreparation(
      [{ image_key: "base", image_ref: `ghcr.io/example/base@sha256:${"f".repeat(64)}` }],
      "registry_channel:github",
      { inspect: async () => ({ exists: false }), prepare: async () => channelBlocked },
    );
    assert.equal(channel.ready, false);
    if (channel.ready) return;
    assert.notEqual(channel.task.task_id, admin.task.task_id);
    assert.equal(channel.task.purpose, "registry_channel:github");
    assert.match(channel.task.status, /queued|running/);
  } finally {
    releaseAdmin();
    releaseChannel();
    await flush();
    resetRuntimeImagePullTask();
  }
});

test("channel switch observes a non-preemptable in-flight task instead of throwing 409", async () => {
  resetRuntimeImagePullTask();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const binding = await requestRuntimeImagePreparation(
      [{ image_key: "chrome", image_ref: `ghcr.io/example/chrome@sha256:${"1".repeat(64)}` }],
      "project_binding:p:i",
      { inspect: async () => ({ exists: false }), prepare: async () => blocked },
    );
    assert.equal(binding.ready, false);
    if (binding.ready) return;
    const channel = await requestRuntimeImagePreparation(
      [{ image_key: "base", image_ref: `ghcr.io/example/base@sha256:${"2".repeat(64)}` }],
      "registry_channel:github",
      { inspect: async () => ({ exists: false }), prepare: async () => blocked },
    );
    assert.equal(channel.ready, false);
    if (channel.ready) return;
    assert.equal(channel.task.task_id, binding.task.task_id);
    assert.equal(channel.task.purpose, "project_binding:p:i");
    await assert.rejects(
      () => requestRuntimeImagePreparation(
        [{ image_key: "audit", image_ref: `ghcr.io/example/audit@sha256:${"3".repeat(64)}` }],
        "project_binding:p:other",
        { inspect: async () => ({ exists: false }), prepare: async () => blocked },
      ),
      RuntimeImagePreparationBusyError,
    );
  } finally {
    release();
    await flush();
    resetRuntimeImagePullTask();
  }
});
