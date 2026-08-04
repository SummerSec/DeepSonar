import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const parse = (path) => JSON.parse(readFileSync(path, "utf8"));

/** 版本号：semver 或 semver-linux-amd64（一平台一版本） */
const VERSION_RE = /^v?\d+\.\d+\.\d+(-[a-z0-9][a-z0-9.-]*)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REF_RE = /^.+@sha256:[0-9a-f]{64}$/;

const EXPECTED_KEYS = [
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
];

function platformVersionSuffix(platform) {
  return String(platform).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function repositoryFromRef(imageRef) {
  const at = imageRef.lastIndexOf("@");
  if (at < 0) throw new Error(`image_ref 缺少 digest: ${imageRef}`);
  return imageRef.slice(0, at);
}

function assertRegistry(registry) {
  if (registry.schema !== "deepsonar.registry/v1" || !Array.isArray(registry.images)) {
    throw new Error("runtime-image-registry.json schema 无效");
  }
  const images = new Map(registry.images.map((image) => [image.image_key, image]));
  if (images.size !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !images.has(key))) {
    throw new Error("runtime-image-registry.json 必须包含六项官方运行时镜像");
  }
  for (const key of EXPECTED_KEYS) {
    const versions = images.get(key).versions;
    // 允许 versions=[]：bundled 骨架里尚未发布的产品（如部分 OpenHarmony 专项）
    if (!Array.isArray(versions)) throw new Error(`${key} versions 必须是数组`);
    if (versions.length === 0) continue;
    const seenPlatforms = new Set();
    for (const version of versions) {
      if (!VERSION_RE.test(version.version)) throw new Error(`${key} 版本号无效: ${version.version}`);
      if (!IMAGE_REF_RE.test(version.image_ref)) {
        throw new Error(`${key} image_ref 必须是不可变 manifest digest`);
      }
      if (!Array.isArray(version.platforms) || version.platforms.length !== 1) {
        throw new Error(`${key} 每个 version 必须恰好包含一个 platform（一平台一版本）`);
      }
      const platform = version.platforms[0];
      if (typeof platform !== "string" || !platform.includes("/")) {
        throw new Error(`${key} platform 无效: ${platform}`);
      }
      if (seenPlatforms.has(platform)) throw new Error(`${key} 重复平台版本: ${platform}`);
      seenPlatforms.add(platform);
      if (!Number.isSafeInteger(version.size_bytes) || version.size_bytes <= 0) {
        throw new Error(`${key} size_bytes 无效`);
      }
    }
  }
}

/** 从 descriptor 展开为「一平台一版本」条目。 */
export function expandDescriptorVersions(descriptor, {
  version,
  imageRefBase,
} = {}) {
  if (!descriptor || typeof descriptor !== "object") throw new Error("descriptor 无效");
  if (!DIGEST_RE.test(descriptor.digest)) throw new Error(`${descriptor.image_key} digest 无效`);
  const platforms = Array.isArray(descriptor.platforms) ? descriptor.platforms : [];
  if (platforms.length === 0) throw new Error(`${descriptor.image_key} 缺少 platforms`);
  const baseVersion = version || descriptor.version;
  if (!baseVersion) throw new Error(`${descriptor.image_key} 缺少 version`);
  const refBase = imageRefBase
    || descriptor.acr_ref
    || descriptor.ghcr_ref
    || null;
  if (!refBase || !IMAGE_REF_RE.test(refBase)) {
    throw new Error(`${descriptor.image_key} 缺少目标 registry 引用`);
  }
  const repository = repositoryFromRef(refBase);
  const platformDigests = descriptor.platform_digests && typeof descriptor.platform_digests === "object"
    ? descriptor.platform_digests
    : {};
  const platformSizes = descriptor.platform_size_bytes && typeof descriptor.platform_size_bytes === "object"
    ? descriptor.platform_size_bytes
    : {};

  return platforms.map((platform) => {
    const platformDigest = platformDigests[platform];
    const digest = typeof platformDigest === "string" && DIGEST_RE.test(platformDigest)
      ? platformDigest
      : descriptor.digest;
    const size = platformSizes[platform];
    const sizeBytes = Number.isSafeInteger(size) && size > 0
      ? size
      : (Number.isSafeInteger(descriptor.size_bytes) && descriptor.size_bytes > 0 ? descriptor.size_bytes : null);
    if (sizeBytes === null) throw new Error(`${descriptor.image_key} ${platform} 缺少 size_bytes`);
    const suffix = platformVersionSuffix(platform);
    return {
      version: `${baseVersion}-${suffix}`,
      image_ref: `${repository}@${digest}`,
      platforms: [platform],
      size_bytes: sizeBytes,
    };
  });
}

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv[0] === "--check";
  const registryPath = checkOnly ? argv[1] : argv[1];
  if (!registryPath) throw new Error("用法：生成 <清单目录> <输出文件>；校验 --check <清单文件>");

  if (checkOnly) {
    assertRegistry(parse(registryPath));
    console.log(`发布清单校验通过：${registryPath}`);
    return;
  }

  const descriptorDir = argv[0];
  const outputPath = argv[1];
  const template = parse(new URL("../deploy/runtime-image-registry.json", import.meta.url));
  const descriptors = new Map();
  for (const key of EXPECTED_KEYS) {
    const descriptor = parse(`${descriptorDir}/${key.replace("deepsonar-", "")}.json`);
    if (descriptor.image_key !== key) throw new Error(`${key} digest 清单键不匹配`);
    if (!DIGEST_RE.test(descriptor.digest)) throw new Error(`${key} digest 无效`);
    descriptors.set(key, descriptor);
  }
  const acrConfigured = ["ALIYUN_REGISTRY", "ALIYUN_REGISTRY_NAMESPACE", "ALIYUN_REGISTRY_USERNAME", "ALIYUN_REGISTRY_PASSWORD"]
    .every((name) => Boolean(process.env[name]));
  const releaseVersion = process.env.VERSION;
  if (!releaseVersion) throw new Error("缺少环境变量 VERSION");
  const images = template.images.filter((image) => EXPECTED_KEYS.includes(image.image_key)).map((image) => {
    const descriptor = descriptors.get(image.image_key);
    const imageRefBase = acrConfigured ? descriptor.acr_ref : descriptor.ghcr_ref;
    if (!imageRefBase) throw new Error(`${image.image_key} 缺少目标 registry 引用`);
    return {
      ...image,
      versions: expandDescriptorVersions(descriptor, {
        version: releaseVersion,
        imageRefBase,
      }),
    };
  });
  const registry = { schema: "deepsonar.registry/v1", images };
  assertRegistry(registry);
  writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`已生成发布清单：${outputPath}（${acrConfigured ? "ACR" : "GHCR"}，一平台一版本）`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
