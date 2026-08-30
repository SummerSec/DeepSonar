import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const parse = (path) => JSON.parse(readFileSync(path, "utf8"));

const VERSION_RE = /^v?\d+\.\d+\.\d+(-[a-z0-9][a-z0-9.-]*)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9][a-z0-9._-]*$/;
const IMAGE_KEY_RE = /^[a-z][a-z0-9-]{1,62}$/;
const CHANNELS = ["github", "dockerhub", "aliyun-acr"];
const AVAILABLE_PROVENANCE = {
  github: "build-push+inspect",
  dockerhub: "cross-registry-copy+inspect",
  "aliyun-acr": "cross-registry-copy+inspect",
};
const UNAVAILABLE_REASON_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REF_POLICIES = {
  github: { host: "ghcr.io", namespace: "summersec" },
  dockerhub: { host: "docker.io", namespace: "sumsec" },
  "aliyun-acr": { host: "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com", namespace: "summersec" },
};
const EXPECTED_KEYS = [
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-test",
  "deepsonar-chrome-fuzz",
  "deepsonar-mobile",
];

// v2 consolidates all platforms into one version; the legacy v1 compatibility
// path intentionally remains the only place where platforms.length !== 1 is
// accepted for the historical one-platform-per-version alias.

function fail(message) {
  throw new Error(`runtime registry: ${message}`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail(`${label} digest 无效`);
  return value;
}

function assertVersion(value, label) {
  if (typeof value !== "string" || !VERSION_RE.test(value)) fail(`${label} version 无效: ${value}`);
  return value;
}

function assertPlatforms(value, label, required = true) {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((platform) => typeof platform !== "string" || !PLATFORM_RE.test(platform))) {
    fail(`${label} platforms 无效`);
  }
  if (new Set(value).size !== value.length) fail(`${label} platforms 重复`);
  return [...value];
}

function assertSize(value, label, required = true) {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} size_bytes 无效`);
  return value;
}

function parseImmutableRef(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.includes("?") || value.includes("#") || value.includes("\\") || value.includes("%")) {
    fail(`${label} ref 不是严格 OCI digest 引用`);
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) fail(`${label} ref 缺少唯一 digest 分隔符`);
  const name = value.slice(0, at);
  const digest = value.slice(at + 1);
  assertDigest(digest, label);
  if (name.includes("://") || name.includes(":") || name.includes("//") || name.startsWith("/") || name.endsWith("/")) {
    fail(`${label} ref 含 URL、端口、tag 或空路径段`);
  }
  const segments = name.split("/");
  if (segments.length < 3 || segments.some((segment) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment))) {
    fail(`${label} ref repository 路径无效`);
  }
  return { normalized: `${name}@${digest}`, host: segments[0], namespace: segments[1], digest };
}

function assertChannelRef(channel, value, digest, label) {
  const parsed = parseImmutableRef(value, label);
  const policy = REF_POLICIES[channel];
  if (!policy || parsed.host !== policy.host || parsed.namespace !== policy.namespace) {
    fail(`${label} ref 不属于 server-owned ${channel} host/namespace`);
  }
  if (parsed.digest !== digest) fail(`${label} ref digest 与 canonical digest 不一致`);
  return parsed.normalized;
}

function assertEvidenceRecord(channel, record, digest, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} evidence 无效`);
  const keys = Object.keys(record);
  const unknownKeys = keys.filter((key) => !["available", "ref", "inspect_digest", "provenance", "reason"].includes(key));
  if (unknownKeys.length > 0) fail(`${label} evidence 含未知字段`);
  const available = record.available;
  if (available === false) {
    if ("ref" in record || "inspect_digest" in record) fail(`${label} unavailable 不得声明 ref/inspect_digest`);
    if (typeof record.reason !== "string" || !UNAVAILABLE_REASON_RE.test(record.reason) || record.reason.trim() !== record.reason) fail(`${label} unavailable reason is invalid`);
    if (typeof record.provenance !== "string" || record.provenance !== "unavailable") fail(`${label} unavailable provenance 必须为 unavailable`);
    return { available: false, reason: record.reason, provenance: "unavailable" };
  }
  if (available !== true) fail(`${label} 必须显式声明 available=true/false`);
  if (typeof record.ref !== "string" || typeof record.inspect_digest !== "string") fail(`${label} available 缺少 ref/inspect_digest`);
  assertDigest(record.inspect_digest, `${label}.inspect_digest`);
  if (record.inspect_digest !== digest) fail(`${label} inspect_digest 与 canonical digest 不一致`);
  const normalized = assertChannelRef(channel, record.ref, digest, `${label}.ref`);
  if (record.provenance !== AVAILABLE_PROVENANCE[channel]) fail(`${label} available provenance is invalid for ${channel}`);
  if (keys.includes("reason")) {
    fail(`${label} evidence 含未知字段`);
  }
  return { available: true, ref: normalized, inspect_digest: record.inspect_digest, provenance: record.provenance };
}

function recordsForDescriptor(descriptor) {
  if (descriptor.registry_records !== undefined && descriptor.registry_evidence !== undefined) {
    fail(`${descriptor.image_key} must provide only one of registry_records or registry_evidence`);
  }
  const records = descriptor.registry_records ?? descriptor.registry_evidence;
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    fail(`${descriptor.image_key} 缺少 registry_records（每个 channel 必须有 inspect/availability 证据）`);
  }
  const unknown = Object.keys(records).filter((channel) => !CHANNELS.includes(channel));
  if (unknown.length > 0) fail(`${descriptor.image_key} registry_records 含未知 channel: ${unknown.join(", ")}`);
  const normalized = {};
  for (const channel of CHANNELS) {
    if (records[channel] === undefined) fail(`${descriptor.image_key} registry_records must include ${channel} evidence`);
    normalized[channel] = assertEvidenceRecord(channel, records[channel], descriptor.digest, `${descriptor.image_key}.${channel}`);
  }
  if (!normalized.github?.available) fail(`${descriptor.image_key} github evidence must be available and inspected`);

  if (descriptor.registry_refs !== undefined) {
    if (!descriptor.registry_refs || typeof descriptor.registry_refs !== "object" || Array.isArray(descriptor.registry_refs)) fail(`${descriptor.image_key} registry_refs 无效`);
    for (const channel of Object.keys(descriptor.registry_refs)) {
      if (!CHANNELS.includes(channel)) fail(`${descriptor.image_key} registry_refs 含未知 channel`);
      if (!normalized[channel]?.available || descriptor.registry_refs[channel] !== normalized[channel].ref) {
        fail(`${descriptor.image_key}.${channel} registry_refs 必须等于实际 inspect ref`);
      }
    }
    for (const channel of CHANNELS) {
      const present = descriptor.registry_refs[channel] !== undefined;
      if (present !== normalized[channel].available) fail(`${descriptor.image_key}.${channel} registry_refs must omit only unavailable channels`);
    }
  }
  return normalized;
}

function assertDescriptor(descriptor, expectedKey) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) fail(`${expectedKey} descriptor 无效`);
  assertKnownKeys(descriptor, [
    "image_key", "version", "digest", "platforms", "size_bytes", "platform_size_bytes", "platform_digests",
    "registry_records", "registry_evidence", "registry_refs", "ghcr_ref", "acr_ref", "tools_manifest_sha256",
  ], `${expectedKey} descriptor`);
  if (descriptor.image_key !== expectedKey) fail(`${expectedKey} descriptor image_key 不匹配`);
  assertDigest(descriptor.digest, `${expectedKey}`);
  assertPlatforms(descriptor.platforms, expectedKey, true);
  assertSize(descriptor.size_bytes, expectedKey, true);
  if (descriptor.platform_size_bytes !== undefined) {
    if (!descriptor.platform_size_bytes || typeof descriptor.platform_size_bytes !== "object" || Array.isArray(descriptor.platform_size_bytes)) fail(`${expectedKey} platform_size_bytes 无效`);
    for (const platform of Object.keys(descriptor.platform_size_bytes)) {
      if (!descriptor.platforms.includes(platform)) fail(`${expectedKey} platform_size_bytes contains unknown platform ${platform}`);
    }
    for (const platform of descriptor.platforms) {
      if (descriptor.platform_size_bytes[platform] !== undefined) assertSize(descriptor.platform_size_bytes[platform], `${expectedKey}.${platform}`, true);
    }
  }
  if (descriptor.platform_digests !== undefined) {
    if (!descriptor.platform_digests || typeof descriptor.platform_digests !== "object" || Array.isArray(descriptor.platform_digests)) fail(`${expectedKey} platform_digests 无效`);
    for (const platform of Object.keys(descriptor.platform_digests)) {
      if (!descriptor.platforms.includes(platform)) fail(`${expectedKey} platform_digests contains unknown platform ${platform}`);
      assertDigest(descriptor.platform_digests[platform], `${expectedKey}.${platform}`);
    }
  }
  if (descriptor.version !== undefined) assertVersion(descriptor.version, expectedKey);
  if (descriptor.tools_manifest_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(descriptor.tools_manifest_sha256)) fail(`${expectedKey} tools_manifest_sha256 无效`);
  const records = recordsForDescriptor(descriptor);
  return { descriptor, records };
}

function repositoryFromRef(imageRef) {
  const at = imageRef.lastIndexOf("@");
  if (at < 0) fail(`image_ref 缺少 digest: ${imageRef}`);
  return imageRef.slice(0, at);
}

function platformVersionSuffix(platform) {
  return String(platform).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Legacy v1 expansion retained for old release descriptor consumers/tests. */
export function expandDescriptorVersions(descriptor, { version, imageRefBase } = {}) {
  if (!descriptor || typeof descriptor !== "object") fail("descriptor 无效");
  assertDigest(descriptor.digest, `${descriptor.image_key}`);
  const platforms = assertPlatforms(descriptor.platforms, `${descriptor.image_key}`, true);
  const baseVersion = version || descriptor.version;
  assertVersion(baseVersion, `${descriptor.image_key}`);
  const refBase = descriptor.ghcr_ref || null;
  if (!refBase) fail(`${descriptor.image_key} 缺少 GHCR 目标引用`);
  const normalizedRef = assertChannelRef("github", refBase, descriptor.digest, `${descriptor.image_key}.ghcr_ref`);
  if (imageRefBase !== undefined && imageRefBase !== refBase) fail(`${descriptor.image_key} v1 requires the fixed GHCR reference`);
  const repository = repositoryFromRef(normalizedRef);
  const platformDigests = descriptor.platform_digests && typeof descriptor.platform_digests === "object" ? descriptor.platform_digests : {};
  const platformSizes = descriptor.platform_size_bytes && typeof descriptor.platform_size_bytes === "object" ? descriptor.platform_size_bytes : {};
  return platforms.map((platform) => {
    const platformDigest = platformDigests[platform];
    const digest = typeof platformDigest === "string" && DIGEST_RE.test(platformDigest) ? platformDigest : descriptor.digest;
    const size = platformSizes[platform];
    const sizeBytes = Number.isSafeInteger(size) && size > 0 ? size : descriptor.size_bytes;
    assertSize(sizeBytes, `${descriptor.image_key}.${platform}`, true);
    return {
      version: `${baseVersion}-${platformVersionSuffix(platform)}`,
      image_ref: `${repository}@${digest}`,
      platforms: [platform],
      size_bytes: sizeBytes,
    };
  });
}

function buildV2Version(descriptor, records, releaseVersion) {
  const registryRefs = {};
  const registryEvidence = {};
  for (const channel of CHANNELS) {
    const record = records[channel];
    if (!record) continue;
    if (record.available) {
      registryRefs[channel] = record.ref;
      registryEvidence[channel] = {
        available: true,
        ref: record.ref,
        inspect_digest: record.inspect_digest,
        provenance: record.provenance,
      };
    } else {
      // Keep optional-channel absence auditable without inventing an OCI ref.
      registryEvidence[channel] = {
        available: false,
        provenance: "unavailable",
        reason: record.reason,
      };
    }
  }
  const githubRef = registryRefs.github;
  return {
    version: releaseVersion,
    digest: descriptor.digest,
    platforms: [...descriptor.platforms],
    size_bytes: descriptor.size_bytes,
    registry_refs: registryRefs,
    ...(githubRef ? { image_ref: githubRef } : {}),
    registry_evidence: registryEvidence,
    ...(descriptor.tools_manifest_sha256 ? { tools_manifest_sha256: descriptor.tools_manifest_sha256 } : {}),
  };
}

function assertImageBase(image, index) {
  if (!image || typeof image !== "object" || Array.isArray(image)) fail(`images[${index}] 无效`);
  assertKnownKeys(image, ["image_key", "name", "description", "publisher", "source_kind", "source_url", "project_opt_in", "default_role", "versions"], `images[${index}]`);
  if (typeof image.project_opt_in !== "boolean") fail(`images[${index}] project_opt_in must be boolean`);
  if (image.source_url !== undefined && typeof image.source_url !== "string") fail(`images[${index}] source_url must be a string`);
  if (image.default_role !== undefined && typeof image.default_role !== "string") fail(`images[${index}] default_role must be a string`);
  if (!IMAGE_KEY_RE.test(image.image_key) || typeof image.name !== "string" || typeof image.description !== "string" || typeof image.publisher !== "string" || image.source_kind !== "official") {
    fail(`images[${index}] fields 无效`);
  }
  if (!Array.isArray(image.versions)) fail(`${image.image_key} versions 必须是数组`);
}

function assertV1Registry(registry) {
  if (!Array.isArray(registry.images)) fail("v1 registry images 必须是数组");
  if (registry.images.length !== EXPECTED_KEYS.length) fail("v1 registry must contain exactly the ten official image keys");
  const seenImages = new Set();
  const seenRefs = new Map();
  for (const [index, image] of registry.images.entries()) {
    assertImageBase(image, index);
    if (seenImages.has(image.image_key)) fail(`重复 image_key ${image.image_key}`);
    seenImages.add(image.image_key);
    const seenVersions = new Set();
    for (const [versionIndex, version] of image.versions.entries()) {
      assertKnownKeys(version, ["version", "image_ref", "platforms", "size_bytes", "tools_manifest_sha256"], `${image.image_key}.versions[${versionIndex}]`);
      assertVersion(version.version, `${image.image_key}.versions[${versionIndex}]`);
      if (seenVersions.has(version.version)) fail(`${image.image_key} 重复 version ${version.version}`);
      seenVersions.add(version.version);
      const parsed = parseImmutableRef(version.image_ref, `${image.image_key}.versions[${versionIndex}].image_ref`);
      if (parsed.host !== "ghcr.io" || parsed.namespace !== "summersec") fail(`${image.image_key} v1 image_ref 必须是固定 GHCR 引用`);
      const platforms = assertPlatforms(version.platforms, `${image.image_key}.${version.version}`, false);
      if (platforms && platforms.length !== 1) fail(`${image.image_key} v1 每个 version 只能有一个 platform`);
      assertSize(version.size_bytes, `${image.image_key}.${version.version}`, false);
      const existing = seenRefs.get(parsed.normalized);
      if (!existing) {
        seenRefs.set(parsed.normalized, { imageKey: image.image_key, platforms: platforms ? new Set(platforms) : null });
      } else if (existing.imageKey !== image.image_key || !existing.platforms || !platforms || platforms.some((platform) => existing.platforms.has(platform))) {
        fail(`${image.image_key} contains duplicate normalized registry ref (${parsed.normalized})`);
      } else {
        for (const platform of platforms) existing.platforms.add(platform);
      }
    }
  }
  if (EXPECTED_KEYS.some((key) => !seenImages.has(key))) fail("v1 registry must contain exactly the ten official image keys");
}

function assertV2Registry(registry) {
  if (!Array.isArray(registry.images)) fail("v2 registry images 必须是数组");
  if (registry.images.length !== EXPECTED_KEYS.length) fail("v2 registry must contain exactly the ten official image keys");
  const seenImages = new Set();
  const seenRefs = new Set();
  for (const [index, image] of registry.images.entries()) {
    assertImageBase(image, index);
    if (seenImages.has(image.image_key)) fail(`重复 image_key ${image.image_key}`);
    seenImages.add(image.image_key);
    const seenVersions = new Set();
    for (const [versionIndex, version] of image.versions.entries()) {
      const label = `${image.image_key}.versions[${versionIndex}]`;
      assertKnownKeys(version, ["version", "digest", "platforms", "size_bytes", "registry_refs", "image_ref", "registry_evidence", "tools_manifest_sha256"], label);
      assertVersion(version.version, label);
      if (seenVersions.has(version.version)) fail(`${image.image_key} 重复 version ${version.version}`);
      seenVersions.add(version.version);
      assertDigest(version.digest, label);
      assertPlatforms(version.platforms, label, true);
      assertSize(version.size_bytes, label, true);
      if (!version.registry_refs || typeof version.registry_refs !== "object" || Array.isArray(version.registry_refs)) fail(`${label} registry_refs 无效`);
      const channels = Object.keys(version.registry_refs);
      if (channels.length === 0 || channels.some((channel) => !CHANNELS.includes(channel))) fail(`${label} registry_refs 含未知或空 channel`);
      for (const channel of channels) {
        const ref = assertChannelRef(channel, version.registry_refs[channel], version.digest, `${label}.${channel}`);
        if (seenRefs.has(ref)) fail(`${label} registry_refs 重复 normalized ref`);
        seenRefs.add(ref);
      }
      if (version.image_ref !== undefined) {
        if (!version.registry_refs.github || version.image_ref !== version.registry_refs.github) fail(`${label} image_ref 必须等于 registry_refs.github`);
      }
      if (!version.registry_evidence || typeof version.registry_evidence !== "object" || Array.isArray(version.registry_evidence)) fail(`${label} registry_evidence is required`);
      if (Object.keys(version.registry_evidence).length !== CHANNELS.length || CHANNELS.some((channel) => version.registry_evidence[channel] === undefined)) {
        fail(`${label} registry_evidence must contain exactly all three channels`);
      }
      if (version.registry_evidence.github?.available !== true) fail(`${label} github registry_evidence must be available and inspected`);
      {
        if (!version.registry_evidence || typeof version.registry_evidence !== "object" || Array.isArray(version.registry_evidence)) fail(`${label} registry_evidence 无效`);
        for (const channel of Object.keys(version.registry_evidence)) {
          if (!CHANNELS.includes(channel)) fail(`${label} registry_evidence 含未知 channel`);
          const evidence = version.registry_evidence[channel];
          if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) fail(`${label}.${channel} registry_evidence is invalid`);
          assertKnownKeys(evidence, ["available", "ref", "inspect_digest", "provenance", "reason"], `${label}.${channel} registry_evidence`);
          if (evidence?.available === false) {
            if (evidence.ref !== undefined || evidence.inspect_digest !== undefined
              || evidence.provenance !== "unavailable" || typeof evidence.reason !== "string" || !UNAVAILABLE_REASON_RE.test(evidence.reason) || evidence.reason.trim() !== evidence.reason) {
              fail(`${label}.${channel} unavailable registry_evidence is invalid`);
            }
            if (version.registry_refs[channel] !== undefined) fail(`${label}.${channel} unavailable evidence cannot coexist with registry_refs`);
            continue;
          }
          if (evidence.available !== true || evidence.ref !== version.registry_refs[channel] || evidence.inspect_digest !== version.digest
            || evidence.provenance !== AVAILABLE_PROVENANCE[channel] || evidence.reason !== undefined) {
            fail(`${label}.${channel} registry_evidence 未通过实际 digest 证明`);
          }
        }
      }
    }
  }
  if (EXPECTED_KEYS.some((key) => !seenImages.has(key))) fail("v2 registry must contain exactly the ten official image keys");
}

export function assertRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) fail("registry 必须是对象");
  assertKnownKeys(registry, ["schema", "schema_version", "images", "source"], "registry");
  const schema = registry.schema;
  const schemaVersion = registry.schema_version;
  const isV1 = schema === "deepsonar.registry/v1" || schemaVersion === 1;
  const isV2 = schema === "deepsonar.registry/v2" || schemaVersion === 2;
  if ((isV1 && isV2) || (!isV1 && !isV2)) fail("registry schema 未知或 schema/schema_version 冲突");
  if (isV1) assertV1Registry(registry);
  else assertV2Registry(registry);
  return true;
}

function expectedImagesFromTemplate(template) {
  if (!Array.isArray(template.images)) fail("bundled template images 无效");
  const images = new Map(template.images.map((image) => [image.image_key, image]));
  if (images.size !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !images.has(key))) fail("bundled template 必须包含十项官方运行时镜像");
  return images;
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--check") {
    const registryPath = argv[1];
    if (!registryPath) fail("用法：--check <清单文件>");
    assertRegistry(parse(registryPath));
    console.log(`发布清单校验通过：${registryPath}`);
    return;
  }
  const descriptorDir = argv[0];
  const outputPath = argv[1];
  if (!descriptorDir || !outputPath) fail("用法：<清单目录> <输出文件>；校验用 --check <清单文件>");
  const template = parse(new URL("../deploy/runtime-image-registry.json", import.meta.url));
  const templateImages = expectedImagesFromTemplate(template);
  const descriptors = new Map();
  for (const key of EXPECTED_KEYS) {
    const descriptor = parse(`${descriptorDir}/${key.replace("deepsonar-", "")}.json`);
    descriptors.set(key, assertDescriptor(descriptor, key));
  }
  const releaseVersionRaw = process.env.VERSION;
  if (!releaseVersionRaw) fail("缺少环境变量 VERSION");
  const releaseVersion = releaseVersionRaw.replace(/^v/, "");
  assertVersion(releaseVersion, "VERSION");
  const images = EXPECTED_KEYS.map((key) => {
    const templateImage = templateImages.get(key);
    const { descriptor, records } = descriptors.get(key);
    const version = buildV2Version(descriptor, records, releaseVersion);
    return { ...templateImage, versions: [version] };
  });
  const registry = {
    schema: "deepsonar.registry/v2",
    schema_version: 2,
    images,
    source: "remote",
  };
  assertRegistry(registry);
  writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`已生成发布清单：${outputPath}（v2 canonical multi-channel refs）`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
