import { KNOWLEDGE_LIMITS, type RecordKnowledgeFeedbackPayload, type KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { canonical, KnowledgeOperationError, reject, sha256, type KnowledgeDb } from "./types.js";
import { readKnowledgeVersionContent, writeKnowledgeBlob } from "./blobs.js";
import { knowledgeEntryAvailable, type FrozenKnowledgeCatalog } from "./catalog-snapshot.js";

async function feedbackUsage(db: KnowledgeDb, actor: KnowledgeActor, usageRef: string) {
  const [usage] = await db`SELECT u.id,u.selector,u.version_id,u.owner_project_id,u.content_sha256,
      v.revoked_at,v.content_sha256 AS version_hash,i.kind,i.status,b.bytes AS version_bytes
    FROM project_knowledge_usages u
    LEFT JOIN project_knowledge_versions v ON v.id=u.version_id AND v.project_id=u.owner_project_id
    LEFT JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
    LEFT JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE u.id=${usageRef} AND u.project_id=${actor.projectId} AND u.job_id=${actor.jobId} AND u.attempt_id=${actor.attemptId}`;
  if (!usage) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage is not owned by this Job and Attempt");
  if (usage.version_id && (!usage.version_hash || usage.version_hash !== usage.content_sha256 || usage.revoked_at || usage.status === "revoked"))
    return reject("KNOWLEDGE_REVOKED", "Used version hash or permission is no longer valid");
  if (usage.owner_project_id && usage.owner_project_id !== actor.projectId) {
    const catalog = actor.snapshot.project_knowledge_catalog as FrozenKnowledgeCatalog | undefined;
    if (!catalog || !Array.isArray(catalog.entries) || catalog.hash !== sha256(canonical(catalog.entries)))
      return reject("KNOWLEDGE_SCOPE_DENIED", "Feedback requires the original frozen cross-project Skill grant");
    const entry = catalog.entries.find(entry => entry.version_id === usage.version_id
      && entry.owner_project_id === usage.owner_project_id && entry.hash === usage.content_sha256);
    if (usage.kind !== "skill" || !entry || !(await knowledgeEntryAvailable(db, actor.projectId, entry)))
      return reject("KNOWLEDGE_SCOPE_DENIED", "Feedback cannot expand the original cross-project Skill grant");
  }
  return usage;
}

export interface PreparedKnowledgeFeedback {
  entries: KnowledgeInputManifestEntry[];
  usage_identity: string;
  feedback_digest: string;
}

function usageIdentity(usage: Awaited<ReturnType<typeof feedbackUsage>>): string {
  return sha256(canonical({ usage_ref: usage.id, selector: usage.selector, content_hash: usage.content_sha256,
    owner_project_id: usage.owner_project_id, version_ref: usage.version_id }));
}

/** External CAS IO belongs to invoke's preparation phase, never the ingestion transaction. */
export async function prepareKnowledgeFeedback(db: KnowledgeDb, actor: KnowledgeActor,
  input: RecordKnowledgeFeedbackPayload): Promise<PreparedKnowledgeFeedback> {
  await validateFeedbackUsage(db, actor, input.usage_ref);
  const usage = await feedbackUsage(db, actor, input.usage_ref);
  const target: KnowledgeInputManifestEntry[] = [];
  // A separate baseline reference preserves readManifestInput's live revocation checks.
  // Foreign source content is deliberately never copied, including granted Skills.
  if (usage.version_id && usage.owner_project_id === actor.projectId) {
    await readKnowledgeVersionContent(db, String(usage.version_id));
    target.push({ input_ref: `baseline:${usage.version_id}`, kind: "evaluation", project_id: actor.projectId,
      content_hash: String(usage.content_sha256), blob_hash: String(usage.content_sha256),
      bytes: Number(usage.version_bytes), audience: ["maker", "evaluator", "reviewer"] });
  }
  const payload = { schema: "deepsonar.knowledge-feedback/v1", usage_ref: input.usage_ref,
    selector: usage.selector, content_hash: usage.content_sha256, version_ref: usage.version_id,
    owner_project_id: usage.owner_project_id, target_input_ref: target[0]?.input_ref ?? null,
    outcome: input.outcome, next_action: input.next_action, reason: input.reason, evidence_refs: input.evidence_refs };
  if (Buffer.byteLength(canonical(payload), "utf8") > KNOWLEDGE_LIMITS.bundleBytes)
    return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Feedback exceeds the bounded input budget");
  const blob = await writeKnowledgeBlob(db, payload);
  return { entries: [{ input_ref: `feedback:${input.usage_ref}`, kind: "evaluation", project_id: actor.projectId,
    content_hash: blob.hash, blob_hash: blob.hash, bytes: blob.bytes, audience: ["maker", "evaluator", "reviewer"] }, ...target],
    usage_identity: usageIdentity(usage), feedback_digest: sha256(canonical(input)) };
}

export async function validateFeedbackUsage(db: KnowledgeDb, actor: KnowledgeActor, usageRef: string): Promise<void> {
  await feedbackUsage(db, actor, usageRef);
  const [assignment] = await db`SELECT job_id FROM project_knowledge_job_assignments WHERE job_id=${actor.jobId}`;
  if (assignment) return reject("KNOWLEDGE_SCOPE_DENIED", "Governance Job cannot create a feedback root chain");
}

const feedbackValue = (input: RecordKnowledgeFeedbackPayload) => ({ outcome: input.outcome, evidence_refs: input.evidence_refs,
  next_action: input.next_action, reason: input.reason });

/** SQL-only settlement validation. Locks keep usage identity and live grants stable until commit. */
export async function validatePreparedKnowledgeFeedback(tx: KnowledgeDb, actor: KnowledgeActor,
  input: RecordKnowledgeFeedbackPayload, prepared: PreparedKnowledgeFeedback | undefined, requireAccepted = false): Promise<void> {
  const [owned] = await tx`SELECT id,version_id,owner_project_id,content_sha256 FROM project_knowledge_usages
    WHERE id=${input.usage_ref} AND project_id=${actor.projectId} AND job_id=${actor.jobId} AND attempt_id=${actor.attemptId} FOR UPDATE`;
  if (!owned) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage is not owned by this Job and Attempt");
  if (owned.version_id) {
    await tx`SELECT v.id FROM project_knowledge_versions v JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
      WHERE v.id=${owned.version_id} AND v.project_id=${owned.owner_project_id} FOR SHARE OF v,i`;
    if (owned.owner_project_id !== actor.projectId) {
      const catalog = actor.snapshot.project_knowledge_catalog as FrozenKnowledgeCatalog | undefined;
      const entries = catalog?.entries;
      const entry = Array.isArray(entries) ? entries.find(item => item.version_id === owned.version_id
        && item.owner_project_id === owned.owner_project_id && item.hash === owned.content_sha256) : undefined;
      if (entry?.grant_id) await tx`SELECT id FROM project_knowledge_grants WHERE id=${entry.grant_id} FOR SHARE`;
    }
  }
  await validateFeedbackUsage(tx, actor, input.usage_ref);
  const current = await feedbackUsage(tx, actor, input.usage_ref);
  if (!prepared || prepared.usage_identity !== usageIdentity(current) || prepared.feedback_digest !== sha256(canonical(input)))
    return reject("KNOWLEDGE_BASE_CONFLICT", "Feedback preparation no longer matches this usage and request");
  const feedback = feedbackValue(input);
  const [usage] = await tx`SELECT feedback_json FROM project_knowledge_usages WHERE id=${input.usage_ref} FOR UPDATE`;
  if (!usage) return reject("KNOWLEDGE_SCOPE_DENIED", "Usage is unavailable");
  if (requireAccepted && (!usage.feedback_json || canonical(usage.feedback_json) !== canonical(feedback)))
    return reject("KNOWLEDGE_BASE_CONFLICT", "Accepted feedback changed before collection");
  if (usage.feedback_json && canonical(usage.feedback_json) !== canonical(feedback))
    throw new KnowledgeOperationError("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Usage already has different feedback", "permanent_failure", "Stop this feedback submission; this usage already has accepted feedback that cannot be overwritten. Preserve the original feedback and its request; this rejected request need not have a receipt. Do not change keys to replay or replace accepted feedback.");
}

export async function recordKnowledgeFeedback(tx: KnowledgeDb, actor: KnowledgeActor, input: RecordKnowledgeFeedbackPayload,
  prepared?: PreparedKnowledgeFeedback): Promise<Record<string, unknown>> {
  await validatePreparedKnowledgeFeedback(tx, actor, input, prepared);
  await tx`UPDATE project_knowledge_usages SET feedback_json=${tx.json(feedbackValue(input))}
    WHERE id=${input.usage_ref} AND feedback_json IS NULL`;
  return { usage_ref: input.usage_ref, state: "recorded" };
}
