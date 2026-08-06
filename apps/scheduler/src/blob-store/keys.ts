/**
 * Shared-asset blob keys are logical CAS paths, independent of the backend.
 * DB `blob_uri` uses the same form for fs and S3-compatible stores.
 */

const SHARED_ASSET_BLOB_URI_RE = /^shared-assets\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function sharedAssetBlobUri(sha256: string): string {
  const hex = sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("invalid_asset_blob_sha256");
  return `shared-assets/sha256/${hex.slice(0, 2)}/${hex}`;
}

export function assertSharedAssetBlobUri(blobUri: string): string {
  const normalized = blobUri.replaceAll("\\", "/").replace(/^\/+/, "");
  const match = SHARED_ASSET_BLOB_URI_RE.exec(normalized);
  if (!match) throw new Error("invalid_asset_blob_uri");
  if (match[1] !== match[2]!.slice(0, 2)) throw new Error("invalid_asset_blob_uri");
  return normalized;
}

export function objectKeyFor(prefix: string, blobUri: string): string {
  const key = assertSharedAssetBlobUri(blobUri);
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/${key}` : key;
}
