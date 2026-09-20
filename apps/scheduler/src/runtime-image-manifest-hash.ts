import { inc } from "./metrics.js";
/**
 * Tool-manifest sha256 helpers shared by OpenSandbox dual-hash accept (#633)
 * and registry sync observability (#636).
 */

/** Normalize catalog / probe digests to bare lowercase hex (no sha256: prefix). */
export function normalizeToolsManifestSha256(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^sha256:/i, "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

/**
 * Dual-hash accept rule (#633): catalog matches if it equals either file-bytes
 * sha256sum or the embedded manifest.sha256 field.
 */
export function catalogMatchesDualHash(
  catalogSha256: string | null | undefined,
  fileBytesSha256: string | null | undefined,
  embeddedSha256: string | null | undefined,
): boolean {
  const expected = normalizeToolsManifestSha256(catalogSha256);
  if (!expected) return false;
  const fileHash = normalizeToolsManifestSha256(fileBytesSha256);
  const embedded = normalizeToolsManifestSha256(embeddedSha256);
  return (fileHash !== null && fileHash === expected) || (embedded !== null && embedded === expected);
}

/**
 * COALESCE(EXCLUDED.tools_manifest_sha256, existing) semantics used by sync upsert.
 * When EXCLUDED is null/empty, a non-null existing value must be preserved.
 */
export function coalesceToolsManifestSha256(
  excluded: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const next = typeof excluded === "string" && excluded.trim() !== "" ? excluded : null;
  const prev = typeof existing === "string" && existing.trim() !== "" ? existing : null;
  return next ?? prev;
}

/**
 * Detect whether a sync would overwrite a non-empty catalog hash with a different
 * non-null EXCLUDED value. Official catalog remains authoritative; callers warn
 * loudly but still apply the catalog value (#636 C).
 */
export function toolsManifestSha256SyncChange(
  previous: string | null | undefined,
  next: string | null | undefined,
): "preserve" | "fill" | "noop" | "overwrite" {
  const prev = normalizeToolsManifestSha256(previous)
    ?? (typeof previous === "string" && previous.trim() ? previous.trim().toLowerCase() : null);
  const nxt = normalizeToolsManifestSha256(next)
    ?? (typeof next === "string" && next.trim() ? next.trim().toLowerCase() : null);
  if (!nxt) return "preserve";
  if (!prev) return "fill";
  if (prev === nxt) return "noop";
  return "overwrite";
}

export function warnToolsManifestSha256Overwrite(input: {
  image_key: string;
  digest: string;
  old: string;
  new: string;
  insert_only?: boolean;
}): void {
  console.warn("[runtime-images] tools_manifest_sha256 overwrite on sync", {
    image_key: input.image_key,
    digest: input.digest,
    old: input.old,
    new: input.new,
    insert_only: input.insert_only === true,
  });
  inc("deepsonar_runtime_image_tools_manifest_overwrite_total", {
    image_key: input.image_key,
    source: input.insert_only ? "registry-sync-fallback" : "registry-sync",
  });
}
