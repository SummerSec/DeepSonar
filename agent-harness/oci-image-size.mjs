import { execFileSync } from "node:child_process";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

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

export async function maxCompressedPlatformSize(rootManifest, expectedPlatforms, loadManifest, rootDigest = null) {
  if (!Array.isArray(expectedPlatforms) || expectedPlatforms.length === 0) {
    throw new Error("必须提供至少一个目标平台");
  }
  if (Array.isArray(rootManifest?.layers)) {
    if (expectedPlatforms.length !== 1) throw new Error("单平台 manifest 不能满足多个目标平台");
    const size = compressedLayerSize(rootManifest);
    const platform = expectedPlatforms[0];
    const digest = typeof rootDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(rootDigest) ? rootDigest : null;
    return {
      size_bytes: size,
      platform_size_bytes: { [platform]: size },
      platform_digests: digest ? { [platform]: digest } : {},
    };
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
  const platformDigests = {};
  for (const platform of expectedPlatforms) {
    const descriptor = descriptors.get(platform);
    if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) {
      throw new Error(`OCI index 平台 ${platform} digest 无效: ${descriptor.digest}`);
    }
    platformDigests[platform] = descriptor.digest;
    const manifest = await loadManifest(descriptor.digest);
    platformSizeBytes[platform] = compressedLayerSize(manifest);
  }
  return {
    size_bytes: Math.max(...Object.values(platformSizeBytes)),
    platform_size_bytes: platformSizeBytes,
    platform_digests: platformDigests,
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
  const rootDigest = imageRef.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
  if (repository === imageRef && Array.isArray(root?.manifests)) {
    throw new Error("多平台镜像检查必须使用 @sha256 不可变引用");
  }
  return maxCompressedPlatformSize(
    root,
    platforms,
    async (digest) => inspectRaw(`${repository}@${digest}`),
    rootDigest,
  );
}

/**
 * Resolve the root manifest/index digest reported by buildx for an immutable
 * or tag reference.  The raw JSON representation is not itself a digest
 * proof: annotations and JSON serialization can change its byte hash.  Keep
 * this parser tied to the human-readable `Digest:` line emitted by
 * `imagetools inspect`, which is the registry's actual descriptor digest.
 */
export function parsePublishedImageDigest(output) {
  const match = String(output ?? "").match(/^\s*Digest:\s*(sha256:[0-9a-f]{64})\s*$/im);
  if (!match || !DIGEST_RE.test(match[1])) {
    throw new Error("docker buildx imagetools inspect 缺少实际 manifest/index Digest");
  }
  return match[1];
}

export async function inspectPublishedImageDigest(imageRef) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const output = execFileSync(
        "docker",
        ["buildx", "imagetools", "inspect", imageRef],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return parsePublishedImageDigest(output);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        const delayMs = attempt * 2_000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/** Return an immutable repository reference using the digest actually seen. */
export function immutablePublishedImageRef(imageRef, digest) {
  if (typeof imageRef !== "string" || !DIGEST_RE.test(digest)) {
    throw new Error("发布镜像引用或实际 digest 无效");
  }
  const value = imageRef.trim();
  if (!value || value !== imageRef || value.includes("@sha256:")) {
    // An existing digest is accepted only when it is the exact inspect input;
    // callers still compare the returned digest with their canonical value.
    if (!value || value !== imageRef) throw new Error("发布镜像引用包含空白");
    const at = value.lastIndexOf("@");
    if (at <= 0 || !DIGEST_RE.test(value.slice(at + 1))) throw new Error("发布镜像引用不是合法 OCI 引用");
    return `${value.slice(0, at)}@${digest}`;
  }
  const at = value.lastIndexOf("@");
  if (at >= 0) throw new Error("发布镜像引用只能包含一个 digest 分隔符");
  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  const repository = colon > slash ? value.slice(0, colon) : value;
  if (!repository || repository.includes("//") || repository.includes("://")) {
    throw new Error("发布镜像引用的 repository 无效");
  }
  return `${repository}@${digest}`;
}
