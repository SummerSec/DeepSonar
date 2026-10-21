import type { KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";
import { registerKnowledgeBlob } from "./blobs.js";
import type { KnowledgeActor } from "./inputs.js";

export async function enqueueKnowledgeWork(tx: KnowledgeDb, input: {
  actor: KnowledgeActor; governanceHash: string; trigger: unknown; manifest: KnowledgeInputManifestEntry[]; recipe?: KnowledgeInputManifestEntry; reason: string;
}): Promise<string> {
  const manifest = input.recipe ? [...input.manifest, input.recipe] : input.manifest;
  if (manifest.length > 20) return reject("KNOWLEDGE_BUDGET_EXHAUSTED", "Too many source and recipe inputs");
  if (input.recipe) {
    const versionId = input.recipe.input_ref.slice("governor:".length);
    const [version] = await tx`SELECT id FROM project_knowledge_versions WHERE id=${versionId}
      AND project_id=${input.actor.projectId} AND content_sha256=${input.recipe.content_hash} AND revoked_at IS NULL`;
    if (!version) return reject("KNOWLEDGE_REVOKED", "Governor recipe was revoked before work creation");
  }
  const triggerKey = `knowledge:${sha256(canonical({ job: input.actor.jobId, trigger: input.trigger }))}`;
  for (const entry of manifest) await registerKnowledgeBlob(tx, entry.blob_hash, entry.bytes);
  const [created] = await tx`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason)
    VALUES(${input.actor.projectId},${input.actor.jobId},${input.actor.canvasId},${triggerKey},${tx.json(manifest as never)},${input.governanceHash},${input.reason})
    ON CONFLICT(project_id,trigger_key) DO NOTHING RETURNING id`;
  if (created) return String(created.id);
  const [existing] = await tx`SELECT id FROM project_knowledge_work WHERE project_id=${input.actor.projectId} AND trigger_key=${triggerKey}`;
  if (!existing) return reject("KNOWLEDGE_CONFLICT", "Knowledge work trigger could not be resolved");
  return String(existing.id);
}
