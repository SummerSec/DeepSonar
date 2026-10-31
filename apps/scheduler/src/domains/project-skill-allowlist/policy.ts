import { parseModuleSelector } from "@deepsonar/shared-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectSkillAllowlist {
  /**
   * #691: trusted+enabled platform sources are the default baseline.
   * `configured` remains for UI/audit of whether the project has ever written
   * an explicit disable/enable row; availability no longer requires opt-in seeding.
   */
  configured: boolean;
  /** Skill source IDs currently available to this project (trust baseline minus explicit disables). */
  enabled_skill_source_ids: string[];
}

export interface HubSkillSourceCatalogEntry {
  skill_source_id: string;
  name: string;
  trust_status: string;
  enabled: boolean;
  module_count: number;
  last_commit_sha: string | null;
  last_content_hash: string | null;
}

export function isSkillSourceUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Collect unique skill_source IDs referenced by RoleConfig modules_json selectors. */
export function skillSourceIdsFromModuleSelectors(selectors: unknown): string[] {
  if (!Array.isArray(selectors)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of selectors) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      const parsed = parseModuleSelector(item);
      const id = parsed.source_id.toLowerCase();
      if (!isSkillSourceUuid(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    } catch {
      // Malformed historical selectors are skipped for seeding; expandModules still fails closed later.
    }
  }
  return out;
}

export function parseSkillAllowlistConfiguredFlag(configJson: unknown): boolean {
  const cfg = configJson && typeof configJson === "object" && !Array.isArray(configJson)
    ? configJson as Record<string, unknown>
    : {};
  return cfg.skill_source_allowlist_configured === true;
}

export function markSkillAllowlistConfigured(configJson: Record<string, unknown>): void {
  configJson.skill_source_allowlist_configured = true;
}

/**
 * Fail-closed gate (#691): every selector source_id must be in the project
 * available set (platform trusted+enabled minus explicit project disables).
 * Clear error — never silently drop. Platform skill deepsonar-control is not a
 * Git skill_source and is unaffected.
 */
export function assertSkillSourcesProjectEnabled(
  allowlist: ProjectSkillAllowlist,
  sourceIds: Iterable<string>,
): void {
  const enabled = new Set(allowlist.enabled_skill_source_ids.map((id) => id.toLowerCase()));
  for (const sourceId of sourceIds) {
    if (!enabled.has(sourceId.toLowerCase())) {
      throw new Error(
        `skill_source=${sourceId} 不在本项目可用 Skill 源集合内（#691：trust 源默认可用，项目仅可显式停用；RoleConfig modules_json 仅过渡绑定）`,
      );
    }
  }
}

export function toHubSkillSourceCatalogEntry(row: {
  id: string;
  name: string;
  trust_status: string;
  enabled: boolean;
  module_count: number | string | null;
  last_commit_sha: string | null;
  last_content_hash: string | null;
}): HubSkillSourceCatalogEntry {
  return {
    skill_source_id: row.id,
    name: row.name,
    trust_status: row.trust_status,
    enabled: row.enabled === true,
    module_count: Number(row.module_count ?? 0),
    last_commit_sha: row.last_commit_sha,
    last_content_hash: row.last_content_hash,
  };
}
