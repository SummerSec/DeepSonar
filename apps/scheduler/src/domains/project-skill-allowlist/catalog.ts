import { safeSkillSourceCandidate } from "../skill-source/metadata.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";
import { loadJobSkillCatalog, type FrozenJobSkillCatalog } from "../../job-skill-catalog.js";
import {
  assertSkillSourcesProjectEnabled,
  isSkillSourceUuid,
  markSkillAllowlistConfigured,
  parseSkillAllowlistConfiguredFlag,
  skillSourceIdsFromModuleSelectors,
  toHubSkillSourceCatalogEntry,
  type HubSkillSourceCatalogEntry,
  type ProjectSkillAllowlist,
} from "./policy.js";

type SqlLike = RoleRuntimeSnapshotTransaction;

function jsonParam(db: SqlLike, value: unknown): unknown {
  return typeof db.json === "function" ? db.json(value) : value;
}

/** Collect skill_source IDs historically bound via RoleConfig modules_json. */
export async function collectProjectSkillSourceBindings(
  db: SqlLike,
  projectId: string,
): Promise<string[]> {
  const projectRows = await db`
    SELECT modules_json FROM role_configs
    WHERE project_id = ${projectId}` as Array<{ modules_json: unknown }>;
  const globalRows = await db`
    SELECT modules_json FROM role_configs
    WHERE project_id IS NULL` as Array<{ modules_json: unknown }>;
  const ids = new Set<string>();
  for (const row of [...projectRows, ...globalRows]) {
    for (const id of skillSourceIdsFromModuleSelectors(row.modules_json)) ids.add(id);
  }
  return [...ids];
}

/** Platform trusted+enabled skill_source ids (stable order). */
async function listTrustedEnabledSourceIds(db: SqlLike): Promise<string[]> {
  const rows = await db`
    SELECT id FROM skill_sources
    WHERE enabled = true AND trust_status = 'trusted'
    ORDER BY created_at ASC, id ASC` as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * #691 trust baseline: available = platform trusted+enabled minus explicit
 * project disables (`project_skill_sources.enabled = false`). No opt-in seed
 * required; missing rows mean available for trusted sources.
 */
async function loadAvailableIds(db: SqlLike, projectId: string): Promise<string[]> {
  const trusted = await listTrustedEnabledSourceIds(db);
  if (trusted.length === 0) return [];
  const disabledRows = await db`
    SELECT skill_source_id
    FROM project_skill_sources
    WHERE project_id = ${projectId} AND enabled = false` as Array<{ skill_source_id: string }>;
  const disabled = new Set(disabledRows.map((row) => row.skill_source_id.toLowerCase()));
  return trusted.filter((id) => !disabled.has(id.toLowerCase()));
}

async function hasAnyBindingRow(db: SqlLike, projectId: string): Promise<boolean> {
  const [row] = await db`
    SELECT 1 AS ok FROM project_skill_sources
    WHERE project_id = ${projectId}
    LIMIT 1` as Array<{ ok: number }>;
  return Boolean(row);
}

/**
 * Load project skill-source availability. #691: trust baseline is always live;
 * `configured` only reflects whether the project has ever written a row / flag
 * (for settings UX), and no longer gates availability behind opt-in seeding.
 */
export async function ensureProjectSkillAllowlist(
  db: SqlLike,
  projectId: string,
  options?: { persist?: boolean },
): Promise<{ allowlist: ProjectSkillAllowlist; persisted: boolean }> {
  const [project] = await db`SELECT config_json FROM projects WHERE id = ${projectId}` as Array<{
    config_json: unknown;
  }>;
  if (!project) throw new Error(`project not found: ${projectId}`);
  const cfg = { ...((project.config_json ?? {}) as Record<string, unknown>) };
  const flagged = parseSkillAllowlistConfiguredFlag(cfg);
  const hasRows = await hasAnyBindingRow(db, projectId);
  const configured = flagged || hasRows;
  // Optionally stamp the configured flag once a project has rows, without
  // seeding opt-in enables (legacy seed path removed in #691).
  if (hasRows && !flagged && options?.persist !== false) {
    const flag: Record<string, unknown> = {};
    markSkillAllowlistConfigured(flag);
    await db`UPDATE projects SET config_json = config_json || ${jsonParam(db, flag) as never} WHERE id = ${projectId}`;
    return {
      allowlist: { configured: true, enabled_skill_source_ids: await loadAvailableIds(db, projectId) },
      persisted: true,
    };
  }
  return {
    allowlist: { configured, enabled_skill_source_ids: await loadAvailableIds(db, projectId) },
    persisted: false,
  };
}

export async function loadProjectSkillAllowlist(
  db: SqlLike,
  projectId: string,
): Promise<ProjectSkillAllowlist> {
  const { allowlist } = await ensureProjectSkillAllowlist(db, projectId, { persist: false });
  return allowlist;
}

export interface ProjectSkillSourceBindingView {
  skill_source_id: string;
  name: string;
  repo_url: string;
  branch: string;
  trust_status: string;
  source_enabled: boolean;
  project_enabled: boolean;
  module_count: number;
  last_commit_sha: string | null;
  last_content_hash: string | null;
  synced_at: string | null;
  source_instance_id?: string;
  revocation_epoch?: string;
  catalog_snapshot_hash?: string | null;
  candidate_hash?: string | null;
  candidate_json?: unknown;
  last_checked_at?: string | null;
  last_sync_error?: string | null;
}

/** List platform skill sources with project enablement (trust baseline). */
export async function listProjectSkillSourceBindings(
  db: SqlLike,
  projectId: string,
): Promise<{ configured: boolean; sources: ProjectSkillSourceBindingView[] }> {
  const { allowlist } = await ensureProjectSkillAllowlist(db, projectId, { persist: true });

  const rows = await db`
    SELECT ss.id, ss.name, ss.repo_url, ss.branch, ss.trust_status, ss.enabled,
           ss.last_commit_sha, ss.last_content_hash, ss.synced_at,
            ss.source_instance_id, ss.revocation_epoch::text, ss.catalog_snapshot_hash,
            ss.candidate_hash, ss.candidate_json, ss.last_checked_at, ss.last_sync_error,
            (pss.enabled IS DISTINCT FROM false) AS project_selected,
           jsonb_array_length(ss.catalog_json) AS module_count
    FROM skill_sources ss
     LEFT JOIN project_skill_sources pss ON pss.skill_source_id = ss.id AND pss.project_id = ${projectId}
    ORDER BY ss.name, ss.id` as Array<{
    id: string;
    name: string;
    repo_url: string;
    branch: string;
    trust_status: string;
    enabled: boolean;
    last_commit_sha: string | null;
    last_content_hash: string | null;
    synced_at: string | Date | null;
    module_count: number | string | null;
    source_instance_id?: string; revocation_epoch?: string; catalog_snapshot_hash?: string | null;
    candidate_hash?: string | null; candidate_json?: unknown;
    last_checked_at?: string | Date | null; last_sync_error?: string | null;
    project_selected?: boolean;
  }>;
  return {
    configured: allowlist.configured,
    sources: rows.map((row) => ({
      skill_source_id: row.id,
      name: row.name,
      repo_url: row.repo_url,
      branch: row.branch,
      trust_status: row.trust_status,
      source_enabled: row.enabled === true,
      // This is the persisted project choice; trust/enabled/catalog remain independent runtime gates.
      project_enabled: row.project_selected === true,
      source_instance_id: row.source_instance_id, revocation_epoch: row.revocation_epoch,
      catalog_snapshot_hash: row.catalog_snapshot_hash, candidate_hash: row.candidate_hash,
      candidate_json: safeSkillSourceCandidate(row.candidate_json),
      last_checked_at: row.last_checked_at instanceof Date ? row.last_checked_at.toISOString() : row.last_checked_at,
      last_sync_error: row.last_sync_error,
      module_count: Number(row.module_count ?? 0),
      last_commit_sha: row.last_commit_sha,
      last_content_hash: row.last_content_hash,
      synced_at: row.synced_at instanceof Date ? row.synced_at.toISOString() : row.synced_at,
    })),
  };
}

export async function setProjectSkillSourceEnabled(
  db: SqlLike,
  projectId: string,
  skillSourceId: string,
  enabled: boolean,
): Promise<ProjectSkillSourceBindingView> {
  if (!isSkillSourceUuid(skillSourceId)) throw new Error("skill_source_id 必须是 UUID");
  const [src] = await db`
    SELECT id, name, repo_url, branch, trust_status, enabled,
           last_commit_sha, last_content_hash, synced_at,
            source_instance_id, revocation_epoch::text, catalog_snapshot_hash,
            candidate_hash, candidate_json, last_checked_at, last_sync_error,
           jsonb_array_length(catalog_json) AS module_count
    FROM skill_sources WHERE id = ${skillSourceId}` as Array<{
    id: string;
    name: string;
    repo_url: string;
    branch: string;
    trust_status: string;
    enabled: boolean;
    last_commit_sha: string | null;
    last_content_hash: string | null;
    synced_at: string | Date | null;
    module_count: number | string | null;
    source_instance_id?: string; revocation_epoch?: string; catalog_snapshot_hash?: string | null;
    candidate_hash?: string | null; candidate_json?: unknown;
    last_checked_at?: string | Date | null; last_sync_error?: string | null;
    project_selected?: boolean;
  }>;
  if (!src) throw new Error("skill source not found");

  // #691: writing a row is the only project action — enable restores trust default
  // (or records an explicit enable for non-trusted sources); disable tightens.
  await db`
    INSERT INTO project_skill_sources ${db({
      project_id: projectId,
      skill_source_id: skillSourceId,
      enabled,
    } as never)}
    ON CONFLICT (project_id, skill_source_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      updated_at = now()`;

  const [project] = await db`SELECT config_json FROM projects WHERE id = ${projectId}` as Array<{
    config_json: unknown;
  }>;
  if (project) {
    const flag: Record<string, unknown> = {};
    markSkillAllowlistConfigured(flag);
    await db`UPDATE projects SET config_json = config_json || ${jsonParam(db, flag) as never} WHERE id = ${projectId}`;
  }

  // Confirm the persisted choice, not whether the platform currently grants this source.
  return {
    skill_source_id: src.id,
    name: src.name,
    repo_url: src.repo_url,
    branch: src.branch,
    trust_status: src.trust_status,
    source_enabled: src.enabled === true,
    project_enabled: enabled,
    source_instance_id: src.source_instance_id, revocation_epoch: src.revocation_epoch,
    catalog_snapshot_hash: src.catalog_snapshot_hash, candidate_hash: src.candidate_hash,
    candidate_json: safeSkillSourceCandidate(src.candidate_json),
    last_checked_at: src.last_checked_at instanceof Date ? src.last_checked_at.toISOString() : src.last_checked_at,
    last_sync_error: src.last_sync_error,
    module_count: Number(src.module_count ?? 0),
    last_commit_sha: src.last_commit_sha,
    last_content_hash: src.last_content_hash,
    synced_at: src.synced_at instanceof Date ? src.synced_at.toISOString() : src.synced_at,
  };
}

/** Hub sees the same frozen, currently unrevoked source set as Agent pull. */
export async function listHubSkillSourceCatalog(
  db: SqlLike,
  projectId: string,
  frozen: FrozenJobSkillCatalog | undefined,
): Promise<HubSkillSourceCatalogEntry[]> {
  const available = new Set((await loadJobSkillCatalog(db, projectId, frozen)).map((source) => source.id));
  return frozen!.sources.filter((source) => available.has(source.source_id)).map((source) => toHubSkillSourceCatalogEntry({
    id: source.source_id,
    name: source.name,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: source.commit_sha,
    last_content_hash: source.content_hash,
    module_count: source.module_count,
  }));
}

export async function assertProjectModulesAllowlisted(
  db: SqlLike,
  projectId: string,
  moduleSelectors: string[],
): Promise<ProjectSkillAllowlist> {
  const { allowlist } = await ensureProjectSkillAllowlist(db, projectId, { persist: false });
  const sourceIds = skillSourceIdsFromModuleSelectors(moduleSelectors);
  assertSkillSourcesProjectEnabled(allowlist, sourceIds);
  return allowlist;
}
