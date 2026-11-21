import { randomUUID } from "node:crypto";
import {
  KNOWLEDGE_LIMITS, SubmitTaskKnowledgeSuggestionPayload, TASK_KNOWLEDGE_SUGGESTION_OPERATION,
  type SubmitTaskKnowledgeSuggestionPayload as Suggestion,
} from "@deepsonar/shared-types";
import { collectSecretValues } from "../../credential-secret-projection.js";
import { controlInputDigest, readControlReceiptByKey } from "../event-ingestion/control-receipt.js";
import { consumeEventRateLimit } from "../event-ingestion/rate-limit.js";
import type { PlatformRuntimeHandlerContext } from "../platform-api/registry.js";
import { hashJobSnapshot } from "../platform-api/tokens.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, knowledgeEventId, reject, sha256, type KnowledgeDb } from "./types.js";

export type SuggestionOwner = { projectId: string; canvasId: string; jobId: string; attemptId: string };
type SuggestionItem = Suggestion["items"][number];
type Source = SuggestionItem["evidence_refs"][number];
const operation = TASK_KNOWLEDGE_SUGGESTION_OPERATION;
const credentialPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]{12,}|\b(?:gh[opsur]_|github_pat_|sk-|xox[baprs]-)[\w-]{12,}|\bAKIA[A-Z0-9]{16}\b|[a-z][a-z0-9+.-]*:\/\/[^\s:/]+:[^\s/@]+@/iu;

export function checkSuggestionSecrets(input: Suggestion, secrets: readonly string[]): void {
  for (const [i, item] of input.items.entries()) {
    for (const field of ["title", "scope", "content"] as const) {
      const text = item[field];
      if (secrets.some(secret => secret && text.includes(secret)) || credentialPattern.test(text)
        || collectSecretValues(text, "config").length > 0) {
        reject("KNOWLEDGE_SUGGESTION_SECRET", "Suggestion contains credential material", `items.${i}.${field}`);
      }
    }
  }
}

/** Recheck both provenance and bytes before admitting or returning a reference. */
export async function suggestionSourceHashes(db: KnowledgeDb, owner: SuggestionOwner, ref: Source) {
  if (ref.kind === "fact") {
    const [row] = await db`SELECT n.id,n.body_json,n.verification_status FROM canvas_nodes n
      JOIN artifacts a ON a.node_id=n.id AND a.job_id=n.job_id AND a.canvas_id=n.canvas_id
      JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id AND e.type='fact'
      WHERE n.id=${ref.ref} AND n.node_type='fact' AND n.job_id=${owner.jobId} AND n.canvas_id=${owner.canvasId}
        AND a.project_id=${owner.projectId} AND a.status='submitted' AND e.attempt_id=${owner.attemptId}
        AND octet_length(n.body_json::text)<=${KNOWLEDGE_LIMITS.readBytes} LIMIT 1`;
    if (!row) return undefined;
    const content = { kind: "fact", body: row.body_json, verification_status: row.verification_status };
    return { integrity: sha256(canonical({ ...content, id: row.id })), content: sha256(canonical(content)), knowledge: sha256(canonical({ ...content, id: row.id })) };
  }
  const [row] = await db`SELECT e.id,e.kind,e.statement,e.polarity,e.uri,e.payload_json,e.sha256 FROM artifact_evidence e
    JOIN artifacts a ON a.id=e.artifact_id
    JOIN events ev ON ev.job_id=a.job_id AND ev.event_id=a.source_event_id
    WHERE e.id=${ref.ref} AND a.project_id=${owner.projectId} AND a.canvas_id=${owner.canvasId} AND a.job_id=${owner.jobId}
      AND a.status='submitted' AND ev.attempt_id=${owner.attemptId}
      AND octet_length(e.statement)+octet_length(e.payload_json::text)<=${KNOWLEDGE_LIMITS.readBytes}`;
  if (!row) return undefined;
  const content = { kind: "evidence", evidenceKind: row.kind, statement: row.statement, polarity: row.polarity,
    uri: row.uri, payload: row.payload_json, sha256: row.sha256 };
  return { integrity: sha256(canonical({ ...content, id: row.id })), content: sha256(canonical(content)),
    knowledge: sha256(canonical({ kind: "evidence", id: row.id, statement: row.statement, payload: row.payload_json, sha256: row.sha256 })) };
}

export async function resolveSuggestionTarget(db: KnowledgeDb, owner: SuggestionOwner, item: SuggestionItem) {
  if (!item.target) return undefined;
  const [row] = await db<{ item_ref: string; version_ref: string; logical_key: string; generation: string; content_hash: string }[]>`SELECT i.id AS item_ref,v.id AS version_ref,i.logical_key,i.generation,v.content_sha256 AS content_hash
    FROM project_knowledge_usages u JOIN project_knowledge_versions v
      ON v.project_id=u.owner_project_id AND v.id=u.version_id AND v.content_sha256=u.content_sha256
    JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
    WHERE u.id=${item.target.usage_ref} AND u.project_id=${owner.projectId} AND u.owner_project_id=${owner.projectId}
      AND u.job_id=${owner.jobId} AND u.attempt_id=${owner.attemptId} AND v.revoked_at IS NULL
      AND i.status='active' AND i.active_version_id=v.id AND i.kind=${item.kind}`;
  return row;
}

export async function submitTaskKnowledgeSuggestion(context: PlatformRuntimeHandlerContext, db: KnowledgeDb,
  runtime: { attemptId: string | null | undefined; secrets: readonly string[] }): Promise<Record<string, unknown>> {
  const input = SubmitTaskKnowledgeSuggestionPayload.parse(context.input);
  const { jobId, projectId, canvasId, idempotencyKey: key, tokenId } = context;
  if (!key || !canvasId || !runtime.attemptId || runtime.secrets.length === 0)
    return reject("KNOWLEDGE_SCOPE_DENIED", "Suggestion requires an active authorized runtime");
  checkSuggestionSecrets(input, runtime.secrets);
  const digest = controlInputDigest(input);
  const owner = { jobId, projectId, canvasId, attemptId: runtime.attemptId };
  return await db.begin(async raw => {
    const tx = raw as unknown as KnowledgeDb;
    const [canvas] = await tx`SELECT id FROM canvases WHERE id=${canvasId} AND project_id=${projectId} AND status='active' FOR UPDATE`;
    const [job] = await tx`SELECT j.id,j.agent_snapshot_json FROM jobs j WHERE j.id=${jobId} AND j.project_id=${projectId}
      AND j.canvas_id=${canvasId} AND j.status='running' AND j.lease_expires_at>statement_timestamp()
      AND j.type NOT IN ('hub_reason','report') AND NOT EXISTS(SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id=j.id)
      FOR UPDATE`;
    if (!canvas || !job) return reject("KNOWLEDGE_JOB_INACTIVE", "Suggestion Job or Canvas is unavailable");
    const [token] = await tx`SELECT id FROM job_capability_tokens WHERE id=${tokenId} AND job_id=${jobId}
      AND project_id=${projectId} AND canvas_id=${canvasId} AND revoked_at IS NULL AND expires_at>statement_timestamp()
      AND ${operation}=ANY(operation_ids) AND snapshot_sha256=${hashJobSnapshot(job.agent_snapshot_json)} FOR UPDATE`;
    const [attempt] = await tx`SELECT id,session_id,status,cancel_requested FROM job_attempts
      WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
    const [root] = await tx`SELECT id FROM canvas_nodes WHERE canvas_id=${canvasId} AND node_type='root'`;
    const [project] = await tx`SELECT id FROM projects WHERE id=${projectId} AND status='active'`;
    const snapshot = job.agent_snapshot_json as { platform_tools?: string[] };
    if (!attempt || attempt.id !== owner.attemptId || attempt.status !== "active" || attempt.cancel_requested || !root || !project
      || !token || !snapshot?.platform_tools?.includes(operation))
      return reject("KNOWLEDGE_SCOPE_DENIED", "Suggestion authorization or Attempt changed");
    const [prior] = await tx`SELECT operation,input_digest,attempt_id,result_json FROM project_knowledge_receipts
      WHERE job_id=${jobId} AND idempotency_key=${key}`;
    if (prior) {
      if (prior.operation !== operation || prior.input_digest !== digest || prior.attempt_id !== owner.attemptId)
        return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another submission");
      const { receipt_ref, receipt_status } = prior.result_json as Record<string, unknown>;
      return { accepted: true, operation, receipt_ref, receipt_status };
    }
    const [used] = await tx`SELECT event_id FROM event_dedup WHERE event_id=${key}`;
    if (used || await readControlReceiptByKey(tx, jobId, key)) return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Idempotency key belongs to another operation");
    const [existing] = await tx`SELECT id FROM project_knowledge_receipts WHERE job_id=${jobId}
      AND attempt_id=${owner.attemptId} AND operation=${operation} LIMIT 1`;
    if (existing) return reject("KNOWLEDGE_SUGGESTION_ALREADY_ACCEPTED", "This Attempt has accepted a suggestion submission");
    const sourceHashes: string[][] = [];
    const fingerprints: string[] = [];
    for (const [i, item] of input.items.entries()) {
      const hashes: string[] = [];
      const contentHashes: string[] = [];
      for (const ref of item.evidence_refs) {
        const hash = await suggestionSourceHashes(tx, owner, ref);
        if (!hash)
          return reject("KNOWLEDGE_SCOPE_DENIED", "Suggestion source is unavailable in this Attempt", `items.${i}.evidence_refs`);
        hashes.push(hash.integrity);
        contentHashes.push(hash.content);
      }
      const target = await resolveSuggestionTarget(tx, owner, item);
      if (item.target && !target)
        return reject("KNOWLEDGE_REVOKED", "Suggestion target version is unavailable", `items.${i}.target`);
      sourceHashes.push(hashes);
      fingerprints.push(sha256(canonical({ ...item, target: target ? { item_ref: target.item_ref, version_ref: target.version_ref } : null, evidence_refs: [...new Set(contentHashes)].sort() })));
    }
    await consumeEventRateLimit(tx, jobId, "control_receipt", new Date());
    const blob = input.items.length ? await writeKnowledgeBlob(tx, { input, source_hashes: sourceHashes }) : undefined;
    if (blob) await registerKnowledgeBlob(tx, blob.hash, blob.bytes);
    const receiptRef = randomUUID(), eventId = knowledgeEventId(jobId, key);
    const response = { accepted: true, operation, receipt_ref: receiptRef, receipt_status: "settled" };
    const metadata = { ...response, result: input.result, count: input.items.length, root_node_id: root.id,
      session_id: attempt.session_id, ...(blob ? { blob_hash: blob.hash, fingerprints } : {}) };
    const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${jobId}`;
    await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${jobId})`;
    await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      VALUES(${jobId},${eventId},${next},${owner.attemptId},'control_receipt',${tx.json({ ...response, idempotency_key: key, status: "settled" })})`;
    await tx`INSERT INTO project_knowledge_receipts(id,project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
      VALUES(${receiptRef},${projectId},${jobId},${owner.attemptId},${operation},${key},${digest},${eventId},${tx.json(metadata as never)})`;
    return response;
  }) as Record<string, unknown>;
}
