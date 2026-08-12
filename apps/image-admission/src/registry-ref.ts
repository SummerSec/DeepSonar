const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function normalizePreferredRegistry(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.includes("://") || normalized.includes("@") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error("DEEPSONAR_IMAGE_REGISTRY 必须是 registry/namespace 基址");
  }
  return normalized;
}

function immutableDigest(imageRef: string): string | null {
  return imageRef.match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
}

function immutableRepository(imageRef: string): string {
  const at = imageRef.lastIndexOf("@");
  return (at >= 0 ? imageRef.slice(0, at) : imageRef).trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * 选择准入 Worker 实际拉取的官方镜像引用。
 * 只消费已登记的 channel ref；不根据 image_key 或 digest 猜测镜像地址。
 */
export function selectAdmissionImageRef(input: {
  sourceKind: "official" | "third_party" | string;
  imageKey: string;
  imageRef: string;
  digest?: string | null;
  preferredRegistry?: string;
  registryRefs?: readonly string[];
}): string {
  if (input.sourceKind !== "official") return input.imageRef;
  const preferred = normalizePreferredRegistry(input.preferredRegistry ?? "");
  if (!preferred) return input.imageRef;

  const expectedDigest = input.digest ?? immutableDigest(input.imageRef);
  if (!expectedDigest || !DIGEST_RE.test(expectedDigest)) {
    throw new Error(`官方镜像 ${input.imageKey} 缺少可用于准入校验的不可变 digest`);
  }
  const candidates = [input.imageRef, ...(input.registryRefs ?? [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
  const matches = [...new Set(candidates)]
    .filter((ref) => immutableRepository(ref).startsWith(`${preferred}/`));
  if (matches.some((ref) => immutableDigest(ref) !== expectedDigest)) {
    throw new Error(`官方镜像 ${input.imageKey} 的部署 registry 引用 digest 与版本不一致`);
  }
  if (matches.length > 1) {
    throw new Error(`官方镜像 ${input.imageKey} 的部署 registry 引用不唯一: ${preferred}`);
  }
  if (matches.length === 1) return matches[0]!;
  throw new Error(`官方镜像 ${input.imageKey} 没有匹配 DEEPSONAR_IMAGE_REGISTRY=${preferred} 的已核验 registry_ref`);
}
