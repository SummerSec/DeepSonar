import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { sql } from "../../db.js";

export type SharedAssetScope = "platform" | "project" | "finding";
export type SharedAssetOrigin = "human" | "agent" | "system";

export interface SharedAssetSelection {
  asset_id: string;
  version_id: string;
  version: number;
  scope: SharedAssetScope;
  project_id: string | null;
  finding_id: string | null;
  key: string;
  sha256: string;
  bytes: number;
  content_type: string;
  origin: SharedAssetOrigin;
  labels: Record<string, string>;
  blob_uri: string;
  mount_path: string;
}

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  "text/plain": new Set([".txt", ".md", ".csv", ".sh", ".py", ".js", ".ts", ".yaml", ".yml", ".xml"]),
  "text/markdown": new Set([".md"]),
  "text/csv": new Set([".csv"]),
  "text/yaml": new Set([".yaml", ".yml"]),
  "text/xml": new Set([".xml"]),
  "text/javascript": new Set([".js", ".mjs", ".cjs"]),
  "text/x-python": new Set([".py"]),
  "application/json": new Set([".json"]),
  "application/yaml": new Set([".yaml", ".yml"]),
  "application/xml": new Set([".xml"]),
  "application/javascript": new Set([".js", ".mjs", ".cjs"]),
  "application/x-sh": new Set([".sh"]),
  "application/zip": new Set([".zip"]),
  "application/gzip": new Set([".gz", ".tgz"]),
  "application/x-gzip": new Set([".gz", ".tgz"]),
  "application/x-tar": new Set([".tar"]),
  "application/java-archive": new Set([".jar", ".war"]),
  "application/octet-stream": new Set([
    ".jar", ".war", ".zip", ".gz", ".tgz", ".tar",
    ".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".md", ".txt", ".yaml", ".yml", ".json", ".csv", ".xml",
  ]),
};

export function normalizeAssetKey(input: string): string {
  const key = input.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!key || key.length > 240 || key.includes("\0") || key.includes(":")) throw new Error("invalid_asset_key");
  const segments = key.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error("invalid_asset_key");
  return segments.join("/");
}

export function validateAssetContentType(contentType: string, key: string): string {
  const normalized = contentType.split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
  const extension = path.extname(key).toLowerCase();
  if (CONTENT_TYPE_EXTENSIONS[normalized]?.has(extension)) return normalized;
  throw new Error("asset_content_type_not_allowed");
}

function blobPath(sha256: string): { uri: string; absolute: string } {
  const uri = path.posix.join("shared-assets", "sha256", sha256.slice(0, 2), sha256);
  return { uri, absolute: path.join(config.storage.blobDir, ...uri.split("/")) };
}

export function mountPathFor(scope: SharedAssetScope, findingId: string | null, key: string): string {
  const prefix = scope === "finding" ? `finding/${findingId}` : scope;
  return `/workspace/.deepsonar/shared/${prefix}/${normalizeAssetKey(key)}`;
}

export async function createSharedAsset(input: {
  scope: SharedAssetScope;
  projectId?: string | null;
  findingId?: string | null;
  key: string;
  contentType: string;
  bytes: Buffer;
  origin: SharedAssetOrigin;
  actor: string;
  jobId?: string | null;
  labels?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const key = normalizeAssetKey(input.key);
  const contentType = validateAssetContentType(input.contentType, key);
  if (input.bytes.byteLength > config.sharedAssets.maxFileBytes) throw new Error("asset_file_too_large");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const blob = blobPath(sha256);
  const temp = `${blob.absolute}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(blob.absolute), { recursive: true });
  await writeFile(temp, input.bytes, { flag: "wx" });
  try {
    const result = await sql.begin(async (tx) => {
      if (input.scope === "platform") {
        if (input.projectId || input.findingId || input.origin === "agent") throw new Error("asset_scope_forbidden");
      } else if (!input.projectId) throw new Error("asset_project_required");
      if (input.scope === "finding") {
        if (!input.findingId) throw new Error("asset_finding_required");
        const [finding] = await tx`SELECT id FROM findings WHERE id = ${input.findingId} AND project_id = ${input.projectId!}`;
        if (!finding) throw new Error("asset_finding_not_in_project");
      } else if (input.findingId) throw new Error("asset_scope_forbidden");

      const quotaScopeKey = input.scope === "platform" ? "platform" : input.scope === "finding" ? `finding:${input.findingId}` : `project:${input.projectId}`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`shared-assets:${quotaScopeKey}`}, 0))`;

      const quota = input.scope === "finding" ? config.sharedAssets.findingQuotaBytes
        : input.scope === "platform" ? config.sharedAssets.platformQuotaBytes
          : config.sharedAssets.projectQuotaBytes;
      const [usage] = input.scope === "platform"
        ? await tx`SELECT COALESCE(sum(v.bytes),0)::bigint AS bytes FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id WHERE a.scope_type='platform'`
        : input.scope === "finding"
          ? await tx`SELECT COALESCE(sum(v.bytes),0)::bigint AS bytes FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id WHERE a.finding_id=${input.findingId!}`
          : await tx`SELECT COALESCE(sum(v.bytes),0)::bigint AS bytes FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id WHERE a.project_id=${input.projectId!} AND a.scope_type='project'`;
      if (Number(usage?.bytes ?? 0) + input.bytes.byteLength > quota) throw new Error("asset_quota_exceeded");

      const [existing] = input.scope === "platform"
        ? await tx`SELECT * FROM shared_assets WHERE scope_type='platform' AND logical_key=${key} AND status='active' FOR UPDATE`
        : input.scope === "finding"
          ? await tx`SELECT * FROM shared_assets WHERE scope_type='finding' AND finding_id=${input.findingId!} AND logical_key=${key} AND status='active' FOR UPDATE`
          : await tx`SELECT * FROM shared_assets WHERE scope_type='project' AND project_id=${input.projectId!} AND logical_key=${key} AND status='active' FOR UPDATE`;
      if (existing && (input.origin !== "agent" || existing.origin !== "agent")) throw new Error("immutable_asset_key_exists");

      const insertedBlob = await tx`INSERT INTO shared_asset_blobs (content_sha256,bytes,content_type,blob_uri) VALUES (${sha256},${input.bytes.byteLength},${contentType},${blob.uri}) ON CONFLICT (content_sha256) DO NOTHING RETURNING content_sha256`;
      if (insertedBlob.length > 0) {
        try { await rename(temp, blob.absolute); } catch (error) {
          if (!(await stat(blob.absolute).catch(() => null))) throw error;
          await rm(temp, { force: true });
        }
      } else {
        await rm(temp, { force: true });
      }
      let asset = existing;
      if (!asset) {
        [asset] = await tx`INSERT INTO shared_assets ${tx({
          scope_type: input.scope, project_id: input.projectId ?? null, finding_id: input.findingId ?? null,
          logical_key: key, origin: input.origin, immutable: true, labels_json: input.labels ?? {},
          created_by: input.actor, created_by_job_id: input.jobId ?? null, current_version: 1,
        })} RETURNING *`;
      }
      const version = existing ? Number(existing.current_version) + 1 : 1;
      const [createdVersion] = await tx`INSERT INTO shared_asset_versions ${tx({
        asset_id: asset.id, version, content_sha256: sha256, bytes: input.bytes.byteLength,
        content_type: contentType, origin: input.origin, created_by: input.actor,
        created_by_job_id: input.jobId ?? null,
      })} RETURNING *`;
      if (existing) await tx`UPDATE shared_assets SET current_version=${version}, labels_json=${tx.json(input.labels ?? existing.labels_json ?? {})} WHERE id=${asset.id}`;
      return { ...asset, current_version: version, version_id: createdVersion.id, content_sha256: sha256, bytes: input.bytes.byteLength, content_type: contentType };
    });
    const output = result as Record<string, unknown>;
    if (input.origin === "agent" && input.jobId) {
      await sql`INSERT INTO audit_logs (actor_type,actor_id,action,project_id,resource_type,resource_id,after_json,result) VALUES ('internal',${`job:${input.jobId}`},'shared_asset.publish',${input.projectId ?? null},'shared_asset',${String(output.id)},${sql.json({ scope: input.scope, key, sha256, bytes: input.bytes.byteLength } as never)},'ok')`.catch((error) => console.error("[shared-assets] publish audit failed", error));
    }
    return output;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (input.origin === "agent" && input.jobId) {
      await sql`INSERT INTO audit_logs (actor_type,actor_id,action,project_id,resource_type,after_json,result,error_code) VALUES ('internal',${`job:${input.jobId}`},'shared_asset.publish',${input.projectId ?? null},'shared_asset',${sql.json({ scope: input.scope, key } as never)},'denied',${error instanceof Error ? error.message.slice(0, 120) : "shared_asset_error"})`.catch(() => undefined);
    }
    throw error;
  }
}

export async function listSharedAssets(input: { scope: SharedAssetScope; projectId?: string; findingId?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = input.scope === "platform"
    ? await sql`SELECT a.*,v.id AS version_id,v.version,v.content_sha256,v.bytes,v.content_type,v.created_by_job_id FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version WHERE a.scope_type='platform' AND a.status<>'archived' ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit} OFFSET ${offset}`
    : input.scope === "finding"
      ? await sql`SELECT a.*,v.id AS version_id,v.version,v.content_sha256,v.bytes,v.content_type,v.created_by_job_id FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version WHERE a.scope_type='finding' AND a.project_id=${input.projectId!} AND a.finding_id=${input.findingId!} AND a.status<>'archived' ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit} OFFSET ${offset}`
      : await sql`SELECT a.*,v.id AS version_id,v.version,v.content_sha256,v.bytes,v.content_type,v.created_by_job_id FROM shared_assets a JOIN shared_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version WHERE a.scope_type='project' AND a.project_id=${input.projectId!} AND a.status<>'archived' ORDER BY a.created_at DESC,a.id DESC LIMIT ${limit} OFFSET ${offset}`;
  return { items: rows, limit, offset };
}

export async function resolveSharedAssetSelection(db: typeof sql, projectId: string, findingIds: string[] = []): Promise<{ revision: string; assets: SharedAssetSelection[] }> {
  const ids = [...new Set(findingIds)].sort();
  if (ids.length) {
    const valid = await db`SELECT id FROM findings WHERE project_id=${projectId} AND id=ANY(${ids}::uuid[])`;
    if (valid.length !== ids.length) throw new Error("asset_finding_not_in_project");
  }
  const rows = await db`
    SELECT a.id AS asset_id,v.id AS version_id,v.version,a.scope_type AS scope,a.project_id,a.finding_id,
           a.logical_key AS key,v.content_sha256 AS sha256,v.bytes,v.content_type,v.origin,a.labels_json AS labels,b.blob_uri
    FROM shared_assets a
    JOIN shared_asset_versions v ON v.asset_id=a.id AND v.version=a.current_version
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    LEFT JOIN shared_asset_project_policies p ON p.project_id=${projectId}
    WHERE a.status='active' AND (
      (a.scope_type='project' AND a.project_id=${projectId})
      OR (a.scope_type='platform' AND COALESCE(p.platform_enabled,false))
      OR (a.scope_type='finding' AND a.project_id=${projectId} AND a.finding_id=ANY(${ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]}::uuid[]))
    ) ORDER BY a.scope_type,a.finding_id NULLS FIRST,a.logical_key,v.version`;
  const assets = rows.map((row) => ({
    ...row,
    version: Number(row.version), bytes: Number(row.bytes),
    mount_path: mountPathFor(row.scope as SharedAssetScope, row.finding_id as string | null, row.key as string),
  })) as unknown as SharedAssetSelection[];
  const revision = createHash("sha256").update(JSON.stringify(assets.map(({ version_id, sha256, mount_path }) => ({ version_id, sha256, mount_path })))).digest("hex");
  return { revision, assets };
}

export async function recordJobSharedAssets(db: typeof sql, jobId: string, assets: SharedAssetSelection[]): Promise<void> {
  for (const asset of assets) {
    await db`INSERT INTO job_shared_asset_versions (job_id,version_id,mount_path,content_sha256) VALUES (${jobId},${asset.version_id},${asset.mount_path},${asset.sha256}) ON CONFLICT DO NOTHING`;
  }
}

export async function readSharedAssetBlob(blobUri: string): Promise<Buffer> {
  const absolute = path.resolve(config.storage.blobDir, ...blobUri.split("/"));
  const root = path.resolve(config.storage.blobDir, "shared-assets") + path.sep;
  if (!absolute.startsWith(root)) throw new Error("invalid_asset_blob_uri");
  return readFile(absolute);
}
