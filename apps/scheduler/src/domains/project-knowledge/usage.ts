import { reject, type KnowledgeDb } from "./types.js";
import { approvedKnowledgeVersion } from "./grant-policy.js";

export async function recordKnowledgeUsage(tx: KnowledgeDb, input: {
  projectId: string; jobId: string; attemptId: string; selector: string; contentHash: string;
  ownerProjectId?: string; versionId?: string;
}): Promise<string> {
  const [job] = await tx`SELECT j.id FROM jobs j JOIN job_attempts a ON a.job_id=j.id
    WHERE j.id=${input.jobId} AND j.project_id=${input.projectId} AND j.status='running'
      AND j.lease_expires_at>now() AND a.id=${input.attemptId} AND a.status='active' AND NOT a.cancel_requested`;
  if (!job) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage must belong to the active Job and Attempt");
  if (input.versionId) {
    const [version] = await tx`SELECT id FROM project_knowledge_versions WHERE id=${input.versionId}
      AND project_id=${input.ownerProjectId ?? null} AND content_sha256=${input.contentHash} AND revoked_at IS NULL`;
    if (!version) return reject("KNOWLEDGE_REVOKED", "Version hash or ownership does not match usage");
    if (input.ownerProjectId !== input.projectId) {
      if (!(await approvedKnowledgeVersion(tx, input.ownerProjectId!, input.versionId)))
        return reject("KNOWLEDGE_SCOPE_DENIED", "Cross-project knowledge version is not approved");
      const [grant] = await tx`SELECT id FROM project_knowledge_grants WHERE owner_project_id=${input.ownerProjectId ?? null}
        AND version_id=${input.versionId} AND grantee_project_id=${input.projectId} AND revoked_at IS NULL`;
      if (!grant) return reject("KNOWLEDGE_SCOPE_DENIED", "Cross-project version grant is unavailable");
    }
  }
  const [created] = await tx`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id)
    VALUES(${input.projectId},${input.jobId},${input.attemptId},${input.selector},${input.contentHash},${input.ownerProjectId ?? null},${input.versionId ?? null})
    ON CONFLICT(job_id,attempt_id,selector,content_sha256) DO NOTHING RETURNING id`;
  if (created) return String(created.id);
  const [existing] = await tx`SELECT id,owner_project_id,version_id FROM project_knowledge_usages WHERE job_id=${input.jobId}
    AND attempt_id=${input.attemptId} AND selector=${input.selector} AND content_sha256=${input.contentHash}`;
  if (!existing || existing.owner_project_id !== (input.ownerProjectId ?? null) || existing.version_id !== (input.versionId ?? null))
    return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Usage identity changed for same pull");
  return String(existing.id);
}
