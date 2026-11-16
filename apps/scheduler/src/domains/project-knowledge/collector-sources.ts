import { RecordKnowledgeFeedbackPayload, type KnowledgeInputManifestEntry, type KnowledgeSourceRef } from "@deepsonar/shared-types";
import { inspectAutomaticKnowledgeJob } from "./automatic.js";
import { resolveKnowledgeSource, type KnowledgeActor } from "./inputs.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";
import { prepareKnowledgeFeedback, validatePreparedKnowledgeFeedback, type PreparedKnowledgeFeedback } from "./feedback.js";

export const SOURCE_COLLECTED_ACTION = "project_knowledge.source_collected";
export const SOURCE_SKIPPED_ACTION = "project_knowledge.source_collection_skipped";
export const PROJECT_COLLECTION_PREFIX = "knowledge:project:";
export const COLLECTION_MAX_INPUTS = 19; // Leave room for the frozen project governor.
export interface PreparedKnowledgeSource {
  registrationId: string;
  actor: KnowledgeActor;
  refs: KnowledgeSourceRef[];
  manifest: KnowledgeInputManifestEntry[];
  feedbacks: Array<{ input: RecordKnowledgeFeedbackPayload; prepared: PreparedKnowledgeFeedback }>;
}

async function acceptedFeedback(db: KnowledgeDb, actor: KnowledgeActor): Promise<RecordKnowledgeFeedbackPayload[]> {
  const usages = await db`SELECT id,feedback_json FROM project_knowledge_usages WHERE project_id=${actor.projectId}
    AND job_id=${actor.jobId} AND attempt_id=${actor.attemptId} AND feedback_json IS NOT NULL ORDER BY id LIMIT 21`;
  if (usages.length > 20) throw new SourceCollectionError("source_input_limit");
  return usages.map(usage => {
    const parsed = RecordKnowledgeFeedbackPayload.omit({ usage_ref: true }).safeParse(usage.feedback_json);
    if (!parsed.success) return reject("KNOWLEDGE_SNAPSHOT_INVALID", "Accepted feedback has an invalid payload");
    return { usage_ref: String(usage.id), ...parsed.data };
  });
}

/** Transaction-only proof recheck; all source resolution and CAS IO happened during preparation. */
export async function recheckKnowledgeSourceFeedback(tx: KnowledgeDb, source: PreparedKnowledgeSource): Promise<void> {
  const current = await acceptedFeedback(tx, source.actor);
  if (canonical(current) !== canonical(source.feedbacks.map(feedback => feedback.input)))
    return reject("KNOWLEDGE_BASE_CONFLICT", "Accepted feedback set changed before collection");
  for (const feedback of source.feedbacks)
    await validatePreparedKnowledgeFeedback(tx, source.actor, feedback.input, feedback.prepared, true);
}

export class SourceCollectionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Terminated origin Jobs authorize only the bounded read/copy; they are never revived. */
export async function prepareKnowledgeSource(db: KnowledgeDb, projectId: string, jobId: string,
  registrationId: string): Promise<PreparedKnowledgeSource> {
  const inspected = await inspectAutomaticKnowledgeJob(db, projectId, jobId);
  if (inspected.status !== "eligible") throw new SourceCollectionError(inspected.reason ?? "source_ineligible");
  if (inspected.existing_work) throw new SourceCollectionError("existing_knowledge_work");
  const [job] = await db`SELECT canvas_id,agent_snapshot_json FROM jobs WHERE id=${jobId} AND project_id=${projectId}`;
  if (!job) throw new SourceCollectionError("job_not_found");
  const actor: KnowledgeActor = { jobId, projectId, canvasId: String(job.canvas_id),
    attemptId: String(inspected.attempt_id), snapshot: job.agent_snapshot_json as Record<string, unknown> };
  const feedbackInputs = await acceptedFeedback(db, actor);
  const facts = await db`SELECT id,body_json,verification_status FROM canvas_nodes
    WHERE job_id=${jobId} AND canvas_id=${actor.canvasId} AND node_type='fact' ORDER BY id LIMIT 20`;
  const evidence = await db`SELECT e.id,e.statement,e.payload_json,e.sha256,e.uri FROM artifact_evidence e
    JOIN artifacts a ON a.id=e.artifact_id WHERE a.job_id=${jobId} AND a.project_id=${projectId}
    ORDER BY e.id LIMIT 20`;
  if (facts.length + evidence.length > COLLECTION_MAX_INPUTS) throw new SourceCollectionError("source_input_limit");
  const refs: KnowledgeSourceRef[] = [
    ...facts.map(row => ({ kind: "fact" as const, ref: String(row.id), content_hash: sha256(canonical({
      kind: "fact", id: row.id, body: row.body_json, verification_status: row.verification_status,
    })) })),
    ...evidence.map(row => ({ kind: "evidence" as const, ref: String(row.id), content_hash: sha256(canonical({
      kind: "evidence", id: row.id, statement: row.statement, payload: row.payload_json, sha256: row.sha256,
    })) })),
  ];
  // Evidence may only describe an asset; freeze its actual authorized bytes as a separate exact input.
  for (const row of evidence) {
    if (typeof row.uri !== "string" || !row.uri.startsWith("asset:")) continue;
    const match = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(row.uri);
    if (!match || typeof row.sha256 !== "string") throw new SourceCollectionError("source_asset_unavailable");
    const ref = { kind: "asset" as const, ref: match[1]!, content_hash: String(row.sha256) };
    if (!refs.some(existing => existing.kind === "asset" && existing.ref === ref.ref)) refs.push(ref);
  }
  for (const input of feedbackInputs) for (const ref of input.evidence_refs) {
    const existing = refs.find(item => item.kind === ref.kind && item.ref === ref.ref);
    if (existing && existing.content_hash !== ref.content_hash)
      return reject("KNOWLEDGE_HASH_MISMATCH", "Feedback evidence conflicts with the source hash");
    if (!existing) refs.push(ref);
  }
  if (refs.length > COLLECTION_MAX_INPUTS) throw new SourceCollectionError("source_input_limit");
  if (!refs.length) throw new SourceCollectionError("no_sources");
  const feedbacks: PreparedKnowledgeSource["feedbacks"] = [];
  const feedbackEntries = new Map<string, KnowledgeInputManifestEntry>();
  for (const input of feedbackInputs) {
    const prepared = await prepareKnowledgeFeedback(db, actor, input);
    feedbacks.push({ input, prepared });
    for (const entry of prepared.entries) feedbackEntries.set(entry.input_ref, entry);
    if (refs.length + feedbackEntries.size > COLLECTION_MAX_INPUTS) throw new SourceCollectionError("source_input_limit");
  }
  const manifest: KnowledgeInputManifestEntry[] = [];
  for (const ref of refs) manifest.push(await resolveKnowledgeSource(db, actor, ref));
  manifest.push(...feedbackEntries.values());
  return { registrationId, actor, refs, manifest, feedbacks };
}
