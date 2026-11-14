import { KNOWLEDGE_LIMITS, type KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import { writeKnowledgeBlob } from "./blobs.js";
import { canonical, reject, type KnowledgeDb } from "./types.js";

/** Prepare outside the Canvas/work transaction. The caller rechecks proposal/version
 * identity and registers this blob inside the transaction creating the next maker. */
export async function prepareKnowledgeRevisionFeedback(db: KnowledgeDb,
  workId: string): Promise<KnowledgeInputManifestEntry | undefined> {
  // One statement binds the work, latest proposal and immutable evaluations to one snapshot.
  const [row] = await db`SELECT w.project_id,w.reason AS work_reason,p.id AS proposal_id,p.revision,p.input_digest,
      p.action,p.reason AS proposal_reason,p.evaluation_plan_json,p.base_refs_json,p.candidate_version_id,
      v.id AS candidate_id,v.content_sha256 AS candidate_hash,v.sources_json,
      COALESCE((SELECT json_agg(e ORDER BY e.created_at,e.id) FROM (
        SELECT id,kind,actor_job_id,actor_attempt_id,result_json,created_at FROM project_knowledge_evaluations
        WHERE project_id=w.project_id AND proposal_id=p.id AND proposal_revision=p.revision
          AND input_digest=p.input_digest AND kind IN ('behavior','review')
        ORDER BY created_at DESC,id DESC LIMIT 33
      ) e),'[]'::json) AS evaluations
    FROM project_knowledge_work w
    JOIN LATERAL (SELECT * FROM project_knowledge_proposals WHERE project_id=w.project_id AND work_id=w.id
      ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1) p ON true
    LEFT JOIN project_knowledge_versions v ON v.project_id=w.project_id AND v.id=p.candidate_version_id AND v.revoked_at IS NULL
    WHERE w.id=${workId} AND w.state IN ('pending','running') AND w.stage='maker' AND p.state='needs_eval'`;
  if (!row) return undefined;
  if (row.candidate_version_id && !row.candidate_id)
    return reject("KNOWLEDGE_REVOKED", "Revision candidate is unavailable in this project");
  const evaluations = row.evaluations as unknown[];
  const payload = { schema: "deepsonar.knowledge-revision-feedback/v1", work_id: workId,
    proposal_id: row.proposal_id, revision: Number(row.revision), input_digest: row.input_digest,
    candidate_version_ref: row.candidate_version_id, candidate_content_hash: row.candidate_hash,
    action: row.action, proposal_reason: row.proposal_reason, work_reason: row.work_reason,
    evaluation_plan: row.evaluation_plan_json, base_refs: row.base_refs_json, source_refs: row.sources_json ?? [], evaluations };
  if (evaluations.length > 32 || Buffer.byteLength(canonical(payload), "utf8") > KNOWLEDGE_LIMITS.bundleBytes)
    return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Revision feedback exceeds the bounded input budget");
  const blob = await writeKnowledgeBlob(db, payload);
  return { input_ref: `revision-feedback:${row.proposal_id}:${row.revision}:${row.input_digest}`, kind: "evaluation",
    project_id: String(row.project_id), content_hash: blob.hash, blob_hash: blob.hash, bytes: blob.bytes, audience: ["maker"] };
}
