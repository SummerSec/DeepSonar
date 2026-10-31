import type { KnowledgeDb } from "./types.js";

/** Authorization cannot turn a draft into a published version. */
export async function approvedKnowledgeVersion(db: KnowledgeDb, ownerProjectId: string, versionId: string): Promise<boolean> {
  const [row] = await db`SELECT v.id FROM project_knowledge_versions v
    JOIN project_knowledge_items i ON i.project_id=v.project_id AND i.id=v.item_id
    WHERE v.id=${versionId} AND v.project_id=${ownerProjectId} AND v.revoked_at IS NULL
      AND (i.active_version_id=v.id OR EXISTS (
        SELECT 1 FROM project_knowledge_proposals p WHERE p.project_id=v.project_id
          AND p.candidate_version_id=v.id AND p.state='active'
      ))`;
  return Boolean(row);
}
