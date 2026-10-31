/** OCI digest helpers and sanitized pull error text shared by ensure/pull modules. */
export const RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES = 8 * 1024;
export const SAME_DIGEST_REF_CACHE_MS = 60_000;
export const SAME_DIGEST_FALLBACK_CHANNELS = ["dockerhub", "github", "aliyun-acr"] as const;
export const RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR = "channel timed out, same-digest fallback attempted";
export const RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR = "digest not found";

export function immutableDigest(imageRef: string): string | null {
  const match = imageRef.trim().match(/@(sha256:[0-9a-f]{64})$/);
  return match?.[1] ?? null;
}

export function localImageDigest(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  const withPrefix = trimmed.match(/^sha256:[0-9a-f]{64}$/);
  if (withPrefix) return withPrefix[0];
  // podman `docker image inspect --format {{.Id}}` 常返回无 sha256: 前缀的 64 hex
  const bare = trimmed.match(/^[0-9a-f]{64}$/);
  return bare ? `sha256:${bare[0]}` : null;
}

/**
 * Docker/registry errors are operator diagnostics, not an opportunity to echo
 * credentials or unbounded command output back through the API.
 */
export function sanitizeRuntimeImageError(value: unknown, maxBytes = RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1<redacted>@");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  text = text.replace(/\b(authorization|password|passwd|token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let end = Math.max(0, Math.floor(maxBytes * 0.9));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 16) end -= 1;
  return `${text.slice(0, end)} …[truncated]`;
}

