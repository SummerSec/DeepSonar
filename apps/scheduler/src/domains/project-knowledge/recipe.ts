import type { KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { readKnowledgeVersionContent } from "./blobs.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";

export const GOVERNOR_LOGICAL_KEY = "deepsonar/project-knowledge-governor";

/** Freeze the exact project governor Skill already visible to the origin Job. */
export async function frozenGovernorRecipe(db: KnowledgeDb, actor: KnowledgeActor): Promise<KnowledgeInputManifestEntry | undefined> {
  const catalog = actor.snapshot.project_knowledge_catalog as { entries?: Array<Record<string, unknown>>; hash?: string } | undefined;
  if (!catalog) return undefined; // Platform-governed bootstrap recipe is used when the project has none.
  if (!Array.isArray(catalog.entries) || catalog.hash !== sha256(canonical(catalog.entries)))
    return reject("KNOWLEDGE_SCOPE_DENIED", "Origin Job knowledge catalog is invalid");
  const entry = catalog.entries.find((item) => item.owner_project_id === actor.projectId && item.kind === "skill"
    && item.logical_key === GOVERNOR_LOGICAL_KEY);
  if (!entry) return undefined;
  const [row] = await db`SELECT v.content_sha256,b.bytes FROM project_knowledge_versions v
    JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE v.id=${String(entry.version_id)} AND v.item_id=${String(entry.item_id)} AND v.project_id=${actor.projectId}
      AND v.content_sha256=${String(entry.hash)} AND v.revoked_at IS NULL AND i.status<>'revoked' AND i.kind='skill'
      AND i.logical_key=${GOVERNOR_LOGICAL_KEY}`;
  if (!row) return reject("KNOWLEDGE_REVOKED", "Frozen project governor recipe is revoked");
  const candidate = await readKnowledgeVersionContent(db, String(entry.version_id));
  if (candidate.kind !== "skill" || candidate.logical_key !== GOVERNOR_LOGICAL_KEY)
    return reject("KNOWLEDGE_HASH_MISMATCH", "Governor recipe identity differs from frozen entry");
  return { input_ref: `governor:${entry.version_id}`, kind: "candidate", project_id: actor.projectId,
    content_hash: String(entry.hash), blob_hash: String(entry.hash), bytes: Number(row.bytes),
    audience: ["maker", "evaluator", "reviewer"] };
}
