import type { KnowledgeInputManifestEntry, KnowledgeSourceRef } from "@deepsonar/shared-types";
import { inspectAutomaticKnowledgeJob } from "./automatic.js";
import { resolveKnowledgeSource, type KnowledgeActor } from "./inputs.js";
import { canonical, sha256, type KnowledgeDb } from "./types.js";

export const SOURCE_COLLECTED_ACTION = "project_knowledge.source_collected";
export const SOURCE_SKIPPED_ACTION = "project_knowledge.source_collection_skipped";
export const PROJECT_COLLECTION_PREFIX = "knowledge:project:";
export const COLLECTION_MAX_INPUTS = 19; // Leave room for the frozen project governor.
export interface PreparedKnowledgeSource {
  registrationId: string;
  actor: KnowledgeActor;
  refs: KnowledgeSourceRef[];
  manifest: KnowledgeInputManifestEntry[];
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
  const facts = await db`SELECT id,body_json,verification_status FROM canvas_nodes
    WHERE job_id=${jobId} AND canvas_id=${actor.canvasId} AND node_type='fact' ORDER BY id LIMIT 20`;
  const evidence = await db`SELECT e.id,e.statement,e.payload_json,e.sha256 FROM artifact_evidence e
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
  if (!refs.length) throw new SourceCollectionError("no_sources");
  const manifest: KnowledgeInputManifestEntry[] = [];
  for (const ref of refs) manifest.push(await resolveKnowledgeSource(db, actor, ref));
  return { registrationId, actor, refs, manifest };
}
