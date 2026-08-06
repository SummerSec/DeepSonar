/**
 * Job-facing shared-asset catalog (mounted + workspace fallback copy).
 * Bytes are never embedded: Agent reads mount_path with normal file tools.
 * Scheduler materializes CAS blobs (local BlobStore or S3-compatible) before mount.
 */

export const SHARED_ASSETS_READONLY_ROOT = "/workspace/.deepsonar/shared";
export const SHARED_ASSETS_WORKSPACE_CATALOG = "/workspace/.deepsonar/shared-assets-catalog.json";
export const SHARED_ASSETS_MOUNT_CATALOG = `${SHARED_ASSETS_READONLY_ROOT}/catalog.json`;

export const SHARED_ASSET_ACCESS_GUIDE = {
  mode: "readonly_mount" as const,
  how: "read_mount_path",
  note:
    "There is no separate download tool. Each asset is pre-materialized by the Scheduler into the read-only mount (from local disk or any S3-compatible BlobStore). Open mount_path / read_path with normal Read/cat tools, or copy into /workspace for edits.",
  copy_hint: "cp <mount_path> /workspace/<name>",
  forbid: [
    "Do not modify files under /workspace/.deepsonar/shared",
    "Do not publish_shared_asset from paths under .deepsonar/shared",
    "Do not call HTTP/S3/curl to fetch assets — Agent has no blob credentials",
  ],
};

export interface JobSharedAssetCatalogEntry {
  asset_id?: string;
  version_id?: string;
  version?: number;
  scope?: string;
  project_id?: string | null;
  finding_id?: string | null;
  key: string;
  sha256?: string;
  bytes?: number;
  content_type?: string;
  origin?: string;
  labels?: Record<string, string>;
  mount_path: string;
  /** Alias of mount_path for agents that look for a "read" path. */
  read_path: string;
  [key: string]: unknown;
}

export interface JobSharedAssetCatalog {
  version: 1;
  revision: string | null;
  readonly: true;
  readonly_root: string;
  access: typeof SHARED_ASSET_ACCESS_GUIDE;
  assets: JobSharedAssetCatalogEntry[];
}

/** Strip host-only fields (blob_uri) and attach agent-facing read paths. */
export function buildJobSharedAssetCatalog(input: {
  revision?: string | null;
  assets: Array<Record<string, unknown>>;
}): JobSharedAssetCatalog {
  const assets: JobSharedAssetCatalogEntry[] = input.assets.map((raw) => {
    const { blob_uri: _blobUri, ...rest } = raw;
    const mountPath = typeof rest.mount_path === "string" && rest.mount_path
      ? rest.mount_path
      : `${SHARED_ASSETS_READONLY_ROOT}/unknown`;
    return {
      ...rest,
      key: typeof rest.key === "string" ? rest.key : "unknown",
      mount_path: mountPath,
      read_path: mountPath,
    } as JobSharedAssetCatalogEntry;
  });
  return {
    version: 1,
    revision: input.revision ?? null,
    readonly: true,
    readonly_root: SHARED_ASSETS_READONLY_ROOT,
    access: SHARED_ASSET_ACCESS_GUIDE,
    assets,
  };
}
