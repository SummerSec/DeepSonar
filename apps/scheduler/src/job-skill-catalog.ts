import { createHash } from "node:crypto";
import { getSharedAssetBlobStore, sharedAssetBlobUri } from "./blob-store/index.js";
import type { RoleRuntimeSnapshotTransaction } from "./domains/role-runtime-snapshot/ports.js";
import { canonical } from "./domains/project-knowledge/types.js";
import { config } from "./config.js";
import {
  isSkillCatalogStale,
  skillSourceAgeSeconds,
  staleSkillCatalogMessage,
} from "./skill-freshness.js";
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
  /** #954: 冻结时的同步时间与年龄。老快照没这两个字段，不能把它们当成新鲜。 */
  source_synced_at?: string | null;
  age_seconds?: number | null;
  /** Observation only: a saved different candidate is not an approved Job grant. */
  source_update_pending?: boolean;
}

export interface FrozenJobSkillCatalog {
  schema: typeof SCHEMA;
  project_id: string;
  catalog_hash: string;
  sources: FrozenJobSkillSource[];
  /** Reserved injection boundary for future authorized project-owned sources. */
  extensions: FrozenJobSkillSource[];
  /** #954: 创建期的陈旧阈值与判定；只读证据，不参与任何准入决策。 */
  stale_after_days?: number;
  max_age_seconds?: number | null;
  stale?: boolean;
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
  synced_at?: string | Date | null;
  source_update_pending?: boolean;
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
  // Existence is not integrity. Repair only with the exact original CAS bytes;
  // never rebind an old Job to a newly encoded/different manifest.
  let healthy = false;
  try { healthy = sha256(await store.get(uri)) === hash; } catch { /* missing cache */ }
  if (!healthy) await store.put(uri, bytes, { contentType: "application/json" });
  if (sha256(await store.get(uri)) !== hash) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest persistence failed");
  }
  // Indexing is idempotent. The caller publishes the pointer only after CAS is durable.
  await db`
    INSERT INTO shared_asset_blobs (content_sha256, bytes, content_type, blob_uri)
    VALUES (${hash}, ${bytes.byteLength}, ${"application/json"}, ${uri})
    ON CONFLICT (content_sha256) DO NOTHING`;
  return hash;
}

/** Validate the original CAS bytes, not a JSONB re-encoding of the manifest. */
export async function readSkillSourceManifest(input: {
  hash: string;
  sourceId: string;
  commitSha: string | null;
  moduleCount: number;
  contentHash: string;
}): Promise<SourceModule[]> {
  if (!HASH_RE.test(input.hash) || !HASH_RE.test(input.contentHash)
    || !Number.isSafeInteger(input.moduleCount) || input.moduleCount < 0) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest metadata invalid");
  }
  let bytes: Buffer;
  try { bytes = await getSharedAssetBlobStore().get(sharedAssetBlobUri(input.hash)); }
  catch { throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest unavailable"); }
  if (sha256(bytes) !== input.hash) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest hash mismatch");
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest invalid"); }
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || manifest.source_id !== input.sourceId
    || manifest.commit_sha !== input.commitSha || !Array.isArray(manifest.catalog)
    || manifest.catalog.length !== input.moduleCount || !manifest.catalog.every(isModule)
    || contentHashOf(manifest.catalog) !== input.contentHash) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source manifest integrity mismatch");
  }
  return manifest.catalog;
}

/** DB 时间列 → ISO 串；缺值返回 null（= 从未成功同步）。 */
function syncedAtIso(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function frozenEntry(row: SourceRow, nowMs: number): FrozenJobSkillSource {
  if (typeof row.source_instance_id !== "string") throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "Skill source instance identity is missing");
  const moduleCount = Number(row.module_count);
  if (!Number.isSafeInteger(moduleCount) || moduleCount < 0) throw new Error(`invalid skill source module count: ${row.id}`);
  const hash = row.catalog_snapshot_hash;
  if (moduleCount && (!hash || !HASH_RE.test(hash))) {
    throw new Error(`skill source catalog snapshot missing: ${row.id}; sync the source again`);
  }
  const syncedAt = syncedAtIso(row.synced_at);
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
    source_synced_at: syncedAt,
    age_seconds: skillSourceAgeSeconds(syncedAt, nowMs),
    source_update_pending: row.source_update_pending === true,
  };
}

/** Job creation reads metadata only; it never performs blob or network I/O. */
export async function freezeJobSkillCatalog(
  db: CatalogDb,
  projectId: string,
  options: { staleAfterDays?: number; nowMs?: number } = {},
): Promise<FrozenJobSkillCatalog> {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterDays = options.staleAfterDays ?? config.skillSources.staleAfterDays;
  const rows = await db`
    SELECT ss.id, ss.source_instance_id, ss.name, ss.enabled, ss.trust_status, ss.last_commit_sha,
           ss.last_content_hash, jsonb_array_length(ss.catalog_json) AS module_count, ss.catalog_snapshot_hash,
           ss.revocation_epoch, COALESCE(ps.revocation_epoch, 0) AS project_revocation_epoch,
           ss.synced_at,
            (ss.candidate_hash IS NOT NULL AND ss.candidate_hash IS DISTINCT FROM ss.catalog_snapshot_hash) AS source_update_pending
      FROM skill_sources ss
      LEFT JOIN project_skill_sources ps
        ON ps.skill_source_id = ss.id AND ps.project_id = ${projectId}
     WHERE ss.enabled = true AND ss.trust_status = 'trusted'
       AND COALESCE(ps.enabled, true) = true
     ORDER BY ss.created_at ASC, ss.id ASC` as SourceRow[];
  if (rows.length > 1024) throw new Error("too many skill sources for a bounded Job snapshot");
  const sources = rows.map((row) => frozenEntry(row, nowMs));
  const extensions: FrozenJobSkillSource[] = [];
  const ages = sources
    .map((source) => source.age_seconds)
    .filter((age): age is number => typeof age === "number");
  const maxAgeSeconds = ages.length > 0 ? Math.max(...ages) : null;
  // 从未成功同步的源（age_seconds = null）一律算陈旧；单源陈旧即整体 stale。
  const stale = sources.some((source) => isSkillCatalogStale(source.age_seconds ?? null, staleAfterDays));
  return {
    schema: SCHEMA,
    project_id: projectId,
    sources,
    extensions,
    stale_after_days: staleAfterDays,
    max_age_seconds: maxAgeSeconds,
    stale,
    catalog_hash: sha256(canonical(frozenCatalogHashInput({ sources, extensions }, projectId))),
  };
}

/**
 * Canvas warning for stale approved bytes or a saved pending candidate; otherwise null.
 * 只读快照证据，不参与任何准入或状态迁移。
 */
export function jobSkillCatalogStaleNotice(frozen: FrozenJobSkillCatalog | undefined): string | null {
  if (!frozen) return null;
  const notices: string[] = [];
  if (frozen.stale) {
    // Missing success evidence must not be diluted by a younger source.
    const ages = frozen.sources.map((source) => source.age_seconds);
    notices.push(staleSkillCatalogMessage(ages.length === 0 || ages.some((age) => age == null)
      ? null : Math.max(...ages.filter((age): age is number => typeof age === "number"))));
  }
  if (frozen.sources.some((source) => source.source_update_pending)) {
    notices.push("Skill 源有待审批候选；当前 Job 仍使用创建时冻结的已批准目录，不自动切换候选内容。");
  }
  return notices.length > 0 ? notices.join(" ") : null;
}

/** Only a dedicated future project-source admission path may inject extensions. */
export function injectFrozenJobSkillExtensions(
  frozen: FrozenJobSkillCatalog,
  extensions: readonly FrozenJobSkillSource[],
): FrozenJobSkillCatalog {
  if (extensions.length) throw new Error("project skill extensions are not admitted yet");
  return frozen;
}

/**
 * catalog_hash 只覆盖**身份**（源实例、commit、内容 hash、撤销纪元、扩展边界）。
 * 新鲜度与候选观测（source_synced_at / age_seconds / stale / source_update_pending）是给人和画布看的
 * 证据，不参与准入；把它们写进 hash 会让同一份冻结输入因墙上时钟不同而得到不同
 * hash，破坏「相同输入幂等」。老快照没有这些字段时 hash 保持一致。
 */
function frozenCatalogHashInput(
  frozen: Pick<FrozenJobSkillCatalog, "sources" | "extensions">,
  projectId: string,
): Record<string, unknown> {
  return {
    project_id: projectId,
    sources: frozen.sources.map(({ source_synced_at: _syncedAt, age_seconds: _age, source_update_pending: _pending, ...identity }) => identity),
    extensions: frozen.extensions.map(({ source_synced_at: _syncedAt, age_seconds: _age, source_update_pending: _pending, ...identity }) => identity),
  };
}

function assertFrozen(frozen: FrozenJobSkillCatalog | undefined, projectId: string): asserts frozen is FrozenJobSkillCatalog {
  if (!frozen || frozen.schema !== SCHEMA || !Array.isArray(frozen.sources) || !Array.isArray(frozen.extensions)) {
    throw new JobSkillCatalogError("JOB_SKILL_CATALOG_MISSING", "job skill catalog snapshot missing or invalid");
  }
  if (frozen.project_id !== projectId) throw new JobSkillCatalogError("JOB_SKILL_SCOPE_MISMATCH", "job skill catalog project scope mismatch");
  if (frozen.extensions.length) throw new JobSkillCatalogError("JOB_SKILL_CATALOG_INTEGRITY", "project skill extensions are not admitted yet");
  if (frozen.catalog_hash !== sha256(canonical(frozenCatalogHashInput(frozen, projectId)))) {
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
