import type { RecordKnowledgeFeedbackPayload, KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { enqueueKnowledgeWork } from "./requests.js";
import { canonical, reject, type KnowledgeDb } from "./types.js";

export async function validateFeedbackUsage(db: KnowledgeDb, actor: KnowledgeActor, usageRef: string): Promise<void> {
  const [usage] = await db`SELECT u.id,u.version_id,u.owner_project_id,u.content_sha256,v.revoked_at,v.content_sha256 AS version_hash
    FROM project_knowledge_usages u LEFT JOIN project_knowledge_versions v ON v.id=u.version_id AND v.project_id=u.owner_project_id
    WHERE u.id=${usageRef} AND u.project_id=${actor.projectId} AND u.job_id=${actor.jobId} AND u.attempt_id=${actor.attemptId}`;
  if (!usage) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage is not owned by this Job and Attempt");
  if (usage.version_id && (!usage.version_hash || usage.version_hash !== usage.content_sha256 || usage.revoked_at))
    return reject("KNOWLEDGE_REVOKED", "Used version hash or permission is no longer valid");
  const [assignment] = await db`SELECT job_id FROM project_knowledge_job_assignments WHERE job_id=${actor.jobId}`;
  if (assignment) return reject("KNOWLEDGE_SCOPE_DENIED", "Governance Job cannot create a feedback root chain");
}

export async function recordKnowledgeFeedback(tx: KnowledgeDb, actor: KnowledgeActor, input: RecordKnowledgeFeedbackPayload,
  manifest: KnowledgeInputManifestEntry[], governanceHash: string, recipe?: KnowledgeInputManifestEntry): Promise<Record<string, unknown>> {
  await validateFeedbackUsage(tx, actor, input.usage_ref);
  const feedback = { outcome: input.outcome, evidence_refs: input.evidence_refs, next_action: input.next_action, reason: input.reason };
  const [usage] = await tx`SELECT feedback_json FROM project_knowledge_usages WHERE id=${input.usage_ref} FOR UPDATE`;
  if (!usage) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage is unavailable");
  if (usage.feedback_json && canonical(usage.feedback_json) !== canonical(feedback))
    return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Usage already has different feedback");
  if (!usage.feedback_json) await tx`UPDATE project_knowledge_usages SET feedback_json=${tx.json(feedback)} WHERE id=${input.usage_ref}`;
  const workRef = await enqueueKnowledgeWork(tx, { actor, governanceHash,
    trigger: { usage_ref: input.usage_ref, feedback }, manifest, recipe, reason: input.reason });
  return { usage_ref: input.usage_ref, work_ref: workRef, state: "pending" };
}
