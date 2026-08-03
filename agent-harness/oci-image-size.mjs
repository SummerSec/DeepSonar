import { execFileSync } from "node:child_process";

function positiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} size 无效: ${value}`);
  }
  return value;
}

function platformKey(platform) {
  if (!platform || typeof platform.os !== "string" || typeof platform.architecture !== "string") return null;
  const base = `${platform.os}/${platform.architecture}`;
  return typeof platform.variant === "string" && platform.variant ? `${base}/${platform.variant}` : base;
}

function platformBaseKey(platform) {
  if (!platform || typeof platform.os !== "string" || typeof platform.architecture !== "string") return null;
  return `${platform.os}/${platform.architecture}`;
}

export function compressedLayerSize(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.layers)) {
    throw new Error("OCI image manifest 缺少 layers");
  }
  return manifest.layers.reduce((total, layer, index) => (
    total + positiveSize(layer?.size, `layer[${index}]`)
  ), 0);
}

export async function maxCompressedPlatformSize(rootManifest, expectedPlatforms, loadManifest) {
  if (!Array.isArray(expectedPlatforms) || expectedPlatforms.length === 0) {
    throw new Error("必须提供至少一个目标平台");
  }
  if (Array.isArray(rootManifest?.layers)) {
    if (expectedPlatforms.length !== 1) throw new Error("单平台 manifest 不能满足多个目标平台");
    return { size_bytes: compressedLayerSize(rootManifest), platform_size_bytes: { [expectedPlatforms[0]]: compressedLayerSize(rootManifest) } };
  }
  if (!Array.isArray(rootManifest?.manifests)) {
    throw new Error("OCI manifest 既不是单平台镜像，也不是多平台 index");
  }

  const expected = new Set(expectedPlatforms);
  const descriptors = new Map();
  for (const descriptor of rootManifest.manifests) {
    const exactKey = platformKey(descriptor?.platform);
    const baseKey = platformBaseKey(descriptor?.platform);
    const key = exactKey && expected.has(exactKey) ? exactKey : baseKey && expected.has(baseKey) ? baseKey : null;
    if (key && expected.has(key) && typeof descriptor.digest === "string") descriptors.set(key, descriptor);
  }
  const missing = expectedPlatforms.filter((platform) => !descriptors.has(platform));
  if (missing.length > 0) throw new Error(`OCI index 缺少目标平台: ${missing.join(", ")}`);

  const platformSizeBytes = {};
  for (const platform of expectedPlatforms) {
    const descriptor = descriptors.get(platform);
    const manifest = await loadManifest(descriptor.digest);
    platformSizeBytes[platform] = compressedLayerSize(manifest);
  }
  return {
    size_bytes: Math.max(...Object.values(platformSizeBytes)),
    platform_size_bytes: platformSizeBytes,
  };
}

export async function inspectPublishedImageSize(imageRef, platforms) {
  const inspectRaw = async (ref) => {
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return JSON.parse(execFileSync(
          "docker",
          ["buildx", "imagetools", "inspect", "--raw", ref],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        ));
      } catch (error) {
        lastError = error;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
    throw lastError;
  };
  const root = await inspectRaw(imageRef);
  const repository = imageRef.replace(/@sha256:[0-9a-f]{64}$/, "");
  if (repository === imageRef && Array.isArray(root?.manifests)) {
    throw new Error("多平台镜像检查必须使用 @sha256 不可变引用");
  }
  return maxCompressedPlatformSize(root, platforms, async (digest) => inspectRaw(`${repository}@${digest}`));
}
