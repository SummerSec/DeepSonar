import { createHash } from "node:crypto";
import { getSharedAssetBlobStore, sharedAssetBlobUri } from "./blob-store/index.js";
import type { RoleRuntimeSnapshotTransaction } from "./domains/role-runtime-snapshot/ports.js";
import { canonical } from "./domains/project-knowledge/types.js";
import { contentHashOf, pullSkillFromCatalog, type PullSkillResult, type SkillSourceCatalogView, type SourceModule } from "./skill-sources.js";

type CatalogDb = RoleRuntimeSnapshotTransaction;
const SCHEMA = "deepsonar.job-skill-catalog/v1";
const MANIFEST_SCHEMA = "deepsonar.skill-source-manifest/v1";
const HASH_RE = /^[0-9a-f]{64}$/;

export interface FrozenJobSkillSource {
  source_instance_id: string;
  source_id: string;
  name: string;
  manifest_hash: string | null;
  module_count: number;
  commit_sha: string | null;
  content_hash: string | null;
  source_revocation_epoch: string;
  project_revocation_epoch: string;
}

export interface FrozenJobSkillCatalog {
  schema: typeof SCHEMA;
  project_id: string;
  catalog_hash: string;
  sources: FrozenJobSkillSource[];
  /** Reserved injection boundary for future authorized project-owned sources. */
  extensions: FrozenJobSkillSource[];
}

interface SourceRow {
  source_instance_id: string;
  id: string;
  name: string;
  enabled: boolean;
  trust_status: string;
  last_commit_sha: string | null;
  last_content_hash: string | null;
  module_count: number | string;
  catalog_snapshot_hash: string | null;
  revocation_epoch: string | number | bigint;
  project_revocation_epoch: string | number | bigint;
  project_enabled?: boolean;
}

export class JobSkillCatalogError extends Error {
  constructor(public readonly error_code: "JOB_SKILL_CATALOG_MISSING" | "JOB_SKILL_SCOPE_MISMATCH" | "JOB_SKILL_CATALOG_INTEGRITY", message: string) {
    super(message);
    this.name = "JobSkillCatalogError";
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function epoch(value: string | number | bigint): string {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error("invalid skill source revocation epoch");
  return parsed.toString();
}

function isModule(value: unknown): value is SourceModule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && (item.kind === "skill" || item.kind === "command")
    && typeof item.plugin === "string" && typeof item.name === "string"
    && typeof item.description === "string" && Boolean(item.files)
    && typeof item.files === "object" && !Array.isArray(item.files)
    && Object.entries(item.files as Record<string, unknown>).every(([key, content]) => key.length > 0 && typeof content === "string");
}

/** Stable JSON bytes are the CAS authority for all files pulled by old Jobs. */
export function encodeSkillSourceManifest(input: {
  sourceId: string;
  commitSha: string | null;
  catalog: readonly SourceModule[];
}): Buffer {
  return Buffer.from(JSON.stringify({
    schema: MANIFEST_SCHEMA,
    source_id: input.sourceId,
    commit_sha: input.commitSha,
    catalog: input.catalog,
  }), "utf8");
}

/** Called during source sync, before publishing the new live catalog pointer. */
export async function persistSkillSourceManifest(
  db: CatalogDb,
  input: { sourceId: string; commitSha: string | null; catalog: readonly SourceModule[] },
): Promise<string> {
  const bytes = encodeSkillSourceManifest(input);
  const hash = sha256(bytes);
  const uri = sharedAssetBlobUri(hash);
  const store = getSharedAssetBlobStore();
  if (!(await store.exists(uri))) await store.put(uri, bytes, { contentType: "application/json" });
  // Indexing is idempotent. The caller publishes the pointer only after CAS is durable.
  await db`
    INSERT INTO shared_asset_blobs (content_sha256, bytes, content_type, blob_uri)
    VALUES (${hash}, ${bytes.byteLength}, ${"application/json"}, ${uri})
    ON CONFLICT (content_sha256) DO NOTHING`;
  return hash;
}

function frozenEntry(row: SourceRow): FrozenJobSkillSource {
  if (typeof row.source_instance_id !== "string") throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source instance identity is missing");
  const moduleCount = Number(row.module_count);
  if (!Number.isSafeInteger(moduleCount) || moduleCount < 0) throw new Error(`invalid skill source module count: ${row.id}`);
  const hash = row.catalog_snapshot_hash;
  if (moduleCount && (!hash || !HASH_RE.test(hash))) {
    throw new Error(`skill source catalog snapshot missing: ${row.id}; sync the source again`);
  }
  return {
    source_instance_id: row.source_instance_id,
    source_id: row.id,
    name: row.name,
    manifest_hash: hash ?? null,
    module_count: moduleCount,
    commit_sha: row.last_commit_sha,
    content_hash: row.last_content_hash,
    source_revocation_epoch: epoch(row.revocation_epoch),
    project_revocation_epoch: epoch(row.project_revocation_epoch),
  };
}

/** Job creation reads metadata only; it never performs blob or network I/O. */
export async function freezeJobSkillCatalog(db: CatalogDb, projectId: string): Promise<FrozenJobSkillCatalog> {
  const rows = await db`
    SELECT ss.id, ss.source_instance_id, ss.name, ss.enabled, ss.trust_status, ss.last_commit_sha,
           ss.last_content_hash, jsonb_array_length(ss.catalog_json) AS module_count, ss.catalog_snapshot_hash,
           ss.revocation_epoch, COALESCE(ps.revocation_epoch, 0) AS project_revocation_epoch
      FROM skill_sources ss
      LEFT JOIN project_skill_sources ps
        ON ps.skill_source_id = ss.id AND ps.project_id = ${projectId}
     WHERE ss.enabled = true AND ss.trust_status = 'trusted'
       AND COALESCE(ps.enabled, true) = true
     ORDER BY ss.created_at ASC, ss.id ASC` as SourceRow[];
  if (rows.length > 1024) throw new Error("too many skill sources for a bounded Job snapshot");
  const sources = rows.map(frozenEntry);
  const extensions: FrozenJobSkillSource[] = [];
  return { schema: SCHEMA, project_id: projectId, sources, extensions,
    catalog_hash: sha256(canonical({ project_id: projectId, sources, extensions })) };
}

/** Only a dedicated future project-source admission path may inject extensions. */
export function injectFrozenJobSkillExtensions(
  frozen: FrozenJobSkillCatalog,
  extensions: readonly FrozenJobSkillSource[],
): FrozenJobSkillCatalog {
  if (extensions.length) throw new Error("project skill extensions are not admitted yet");
  return frozen;
}

function assertFrozen(frozen: FrozenJobSkillCatalog | undefined, projectId: string): asserts frozen is FrozenJobSkillCatalog {
  if (!frozen || frozen.schema !== SCHEMA || !Array.isArray(frozen.sources) || !Array.isArray(frozen.extensions)) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_MISSING", "job skill catalog snapshot missing or invalid");
  }
  if (frozen.project_id !== projectId) throw new JobSkillCatalogError("JOB_SKILL_SCOPE_MISMATCH", "job skill catalog project scope mismatch");
  if (frozen.extensions.length) throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "project skill extensions are not admitted yet");
  if (frozen.catalog_hash !== sha256(canonical({ project_id: projectId, sources: frozen.sources, extensions: frozen.extensions }))) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "job skill catalog snapshot integrity mismatch");
  }
}

async function sourceStillValid(db: CatalogDb, projectId: string, source: FrozenJobSkillSource): Promise<boolean> {
  const [current] = await db`
    SELECT ss.id, ss.source_instance_id, ss.enabled, ss.trust_status, ss.revocation_epoch,
           COALESCE(ps.enabled, true) AS project_enabled,
           COALESCE(ps.revocation_epoch, 0) AS project_revocation_epoch
      FROM skill_sources ss
      LEFT JOIN project_skill_sources ps
        ON ps.skill_source_id = ss.id AND ps.project_id = ${projectId}
     WHERE ss.id = ${source.source_id}` as SourceRow[];
  return Boolean(current && current.source_instance_id === source.source_instance_id && current.enabled && current.trust_status === "trusted" && current.project_enabled
    && epoch(current.revocation_epoch) === source.source_revocation_epoch
    && epoch(current.project_revocation_epoch) === source.project_revocation_epoch);
}

/** Resolve only frozen bytes, intersected with the current irreversible revocation epochs. */
export async function loadJobSkillCatalog(
  db: CatalogDb,
  projectId: string,
  frozen: FrozenJobSkillCatalog | undefined,
): Promise<SkillSourceCatalogView[]> {
  assertFrozen(frozen, projectId);
  const output: SkillSourceCatalogView[] = [];
  for (const source of frozen.sources) {
    if (!(await sourceStillValid(db, projectId, source))) continue;
    if (source.module_count === 0) {
      output.push({ id: source.source_id, last_commit_sha: source.commit_sha, catalog: [] });
      continue;
    }
    if (!source.manifest_hash || !HASH_RE.test(source.manifest_hash)) {
      throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "job skill catalog manifest hash missing");
    }
    let bytes: Buffer;
    try { bytes = await getSharedAssetBlobStore().get(sharedAssetBlobUri(source.manifest_hash)); }
    catch { throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Job Skill catalog bytes are unavailable"); }
    if (sha256(bytes) !== source.manifest_hash) {
      throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "job skill catalog manifest hash mismatch");
    }
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
    catch { throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "job skill catalog manifest invalid"); }
    if (manifest.schema !== MANIFEST_SCHEMA || manifest.source_id !== source.source_id
      || manifest.commit_sha !== source.commit_sha || !Array.isArray(manifest.catalog)
      || manifest.catalog.length !== source.module_count || !manifest.catalog.every(isModule)
      || (source.content_hash && contentHashOf(manifest.catalog) !== source.content_hash)) {
      throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "job skill catalog manifest integrity mismatch");
    }
    if (!(await sourceStillValid(db, projectId, source))) continue;
    output.push({ id: source.source_id, last_commit_sha: source.commit_sha, catalog: manifest.catalog });
  }
  // A later CAS read may yield while an earlier source is revoked.
  const valid = await Promise.all(output.map(async (entry) =>
    sourceStillValid(db, projectId, frozen.sources.find((source) => source.source_id === entry.id)!)));
  return output.filter((_entry, index) => valid[index]);
}

/** Distinguish an unavailable frozen source from an unknown module/selector. */
export function pullFrozenJobSkill(
  frozen: FrozenJobSkillCatalog,
  sources: readonly SkillSourceCatalogView[],
  selector: string,
  expectedContentHash: string,
): PullSkillResult | { ok: false; error_code: "KNOWLEDGE_REVOKED"; message: string } {
  const result = pullSkillFromCatalog(sources, selector, expectedContentHash);
  if (!result.ok && result.error_code === "SKILL_NOT_FOUND") {
    const sourceId = selector.slice(0, 36).toLowerCase();
    if (frozen.sources.some((source) => source.source_id.toLowerCase() === sourceId)
      && !sources.some((source) => source.id.toLowerCase() === sourceId)) {
      return { ok: false, error_code: "KNOWLEDGE_REVOKED", message: "Skill 源已撤销，当前 Job 不可继续读取。" };
    }
  }
  return result;
}
