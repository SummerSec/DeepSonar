import type { AvailableSkill } from "../../skill-sources.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";
import { readKnowledgeVersionContent } from "./blobs.js";
import { approvedKnowledgeVersion } from "./grant-policy.js";

export interface KnowledgeCatalogEntry {
  item_id: string; owner_project_id: string; version_id: string; version: number;
  kind: "memory" | "skill"; hash: string; grant_id?: string;
  title: string; logical_key: string; keywords: string[];
}
export interface FrozenKnowledgeCatalog { entries: KnowledgeCatalogEntry[]; hash: string }

/** Metadata only. Exact grants never include source-project Memory or future versions. */
export async function freezeProjectKnowledgeCatalog(db: KnowledgeDb, projectId: string): Promise<FrozenKnowledgeCatalog> {
  const rows = await db`
    SELECT i.id AS item_id,i.project_id AS owner_project_id,v.id AS version_id,v.version,
      i.kind,v.content_sha256 AS hash,i.title,i.logical_key,i.keywords_json,NULL::uuid AS grant_id
    FROM project_knowledge_items i JOIN project_knowledge_versions v ON v.id=i.active_version_id
    WHERE i.project_id=${projectId} AND i.status='active' AND v.revoked_at IS NULL
    UNION ALL
    SELECT i.id,i.project_id,v.id,v.version,i.kind,v.content_sha256,i.title,i.logical_key,i.keywords_json,g.id
    FROM project_knowledge_grants g JOIN project_knowledge_items i ON i.id=g.item_id
      JOIN project_knowledge_versions v ON v.id=g.version_id
    WHERE g.grantee_project_id=${projectId} AND g.revoked_at IS NULL AND v.revoked_at IS NULL
      AND i.kind='skill' AND i.status='active'
      AND (i.active_version_id=v.id OR EXISTS (
        SELECT 1 FROM project_knowledge_proposals p WHERE p.project_id=v.project_id
          AND p.candidate_version_id=v.id AND p.state='active'
      ))
    ORDER BY item_id,version_id LIMIT 1001`;
  if (rows.length > 1000) return reject("KNOWLEDGE_CATALOG_LIMIT", "Project knowledge catalog exceeds the Job snapshot budget");
  const entries: KnowledgeCatalogEntry[] = rows.map((row) => ({
    item_id: String(row.item_id), owner_project_id: String(row.owner_project_id),
    version_id: String(row.version_id), version: Number(row.version),
    kind: row.kind as "skill" | "memory", hash: String(row.hash), title: String(row.title),
    logical_key: String(row.logical_key), keywords: row.keywords_json as string[],
    ...(row.grant_id ? { grant_id: String(row.grant_id) } : {}),
  }));
  return { entries, hash: sha256(canonical(entries)) };
}

export async function knowledgeEntryAvailable(db: KnowledgeDb, projectId: string, entry: KnowledgeCatalogEntry): Promise<boolean> {
  if (entry.owner_project_id !== projectId && (entry.kind !== "skill" || !entry.grant_id)) return false;
  const [version] = await db`SELECT id FROM project_knowledge_versions WHERE id=${entry.version_id}
    AND project_id=${entry.owner_project_id} AND item_id=${entry.item_id} AND version=${entry.version}
    AND content_sha256=${entry.hash} AND revoked_at IS NULL`;
  if (!version) return false;
  if (entry.owner_project_id === projectId) return true;
  if (!(await approvedKnowledgeVersion(db, entry.owner_project_id, entry.version_id))) return false;
  const [grant] = await db`SELECT id FROM project_knowledge_grants WHERE id=${entry.grant_id!}
    AND owner_project_id=${entry.owner_project_id} AND grantee_project_id=${projectId}
    AND item_id=${entry.item_id} AND version_id=${entry.version_id} AND revoked_at IS NULL`;
  return Boolean(grant);
}

export async function visibleKnowledgeEntries(db: KnowledgeDb, projectId: string, catalog?: FrozenKnowledgeCatalog): Promise<KnowledgeCatalogEntry[]> {
  if (!catalog || !Array.isArray(catalog.entries) || catalog.hash !== sha256(canonical(catalog.entries)))
    return reject("KNOWLEDGE_SNAPSHOT_INVALID", "Project knowledge snapshot is missing or invalid");
  const available = await Promise.all(catalog.entries.map((entry) => knowledgeEntryAvailable(db, projectId, entry)));
  return catalog.entries.filter((_entry, index) => available[index]);
}
export const projectSkillSelector = (entry: KnowledgeCatalogEntry): string => `project:${entry.item_id}@${entry.version}`;
export function projectSkillMetadata(entry: KnowledgeCatalogEntry): AvailableSkill {
  return { selector: projectSkillSelector(entry), source_id: entry.owner_project_id,
    module_id: entry.logical_key, plugin: "project", name: entry.title,
    description: entry.keywords.join(" "), content_hash: entry.hash, commit_sha: null };
}

export async function pullProjectSkill(db: KnowledgeDb, projectId: string, catalog: FrozenKnowledgeCatalog | undefined, selector: string, hash: string) {
  const entries = await visibleKnowledgeEntries(db, projectId, catalog);
  const entry = entries.find((item) => item.kind === "skill" && projectSkillSelector(item) === selector);
  if (!entry) return reject("KNOWLEDGE_REVOKED", "Skill is absent from the authorized Job snapshot or revoked");
  if (entry.hash !== hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Use the exact hash returned by Skill discovery");
  const content = await readKnowledgeVersionContent(db, entry.version_id);
  if (!content.files || !(await knowledgeEntryAvailable(db, projectId, entry))) return reject("KNOWLEDGE_REVOKED", "Skill authorization was revoked");
  return { entry, skill: { ...projectSkillMetadata(entry), files: content.files } };
}
