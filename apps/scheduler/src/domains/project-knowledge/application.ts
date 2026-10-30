import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  KnowledgeControlPayloadSchemas, KNOWLEDGE_MUTATION_IDS,
  type KnowledgeOperation, type KnowledgeInputManifestEntry,
} from "@deepsonar/shared-types";
import type { PlatformRuntimeHandlerContext } from "../platform-api/registry.js";
import { createEventIngestionApplication } from "../event-ingestion/application.js";
import { readControlReceiptByKey } from "../event-ingestion/control-receipt.js";
import { canonical, KnowledgeOperationError, knowledgeEventId, reject, sha256, type KnowledgeDb } from "./types.js";
import { resolveKnowledgeSource, recheckKnowledgeSources, readManifestInput, type KnowledgeActor } from "./inputs.js";
import { enqueueKnowledgeWork } from "./requests.js";
import { readKnowledgeVersionContent } from "./blobs.js";
import { writeKnowledgeBlob } from "./blobs.js";
import { proposeKnowledge, type PreparedCandidate } from "./proposals.js";
import { evaluateKnowledge, prepareTrialEvidence } from "./evaluation.js";
import { reviewKnowledge } from "./settlement.js";
import { recordKnowledgeFeedback, validateFeedbackUsage } from "./feedback.js";
import { frozenGovernorRecipe } from "./recipe.js";
import { approvedKnowledgeVersion } from "./grant-policy.js";
import { recordKnowledgeUsage } from "./usage.js";

export { KnowledgeOperationError, readKnowledgeVersionContent };
export { recordKnowledgeUsage } from "./usage.js";

export interface KnowledgeApplicationInput { db: KnowledgeDb; governanceHash: string; now?: () => Date }
type CatalogEntry = { item_id: string; owner_project_id: string; version_id: string; version: number; kind: "memory" | "skill"; hash: string; grant_id?: string; title?: string; logical_key?: string; keywords?: string[] };

async function actorFor(db: KnowledgeDb, context: PlatformRuntimeHandlerContext, mutation: boolean): Promise<KnowledgeActor> {
  const [row] = await db`SELECT j.project_id,j.canvas_id,j.status,j.lease_expires_at,j.agent_snapshot_json,
    a.id AS attempt_id,a.cancel_requested,a.status AS attempt_status
    FROM jobs j LEFT JOIN LATERAL (SELECT id,cancel_requested,status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
    WHERE j.id=${context.jobId}`;
  if (!row || row.project_id !== context.projectId || row.canvas_id !== context.canvasId) return reject("KNOWLEDGE_SCOPE_DENIED", "Job context does not match current scope");
  if (row.status !== "running" || !row.attempt_id || row.attempt_status !== "active" || row.cancel_requested || !row.lease_expires_at || new Date(row.lease_expires_at as string).getTime() <= Date.now())
    return reject("KNOWLEDGE_JOB_INACTIVE", "Job or Attempt is no longer active");
  const snapshot = row.agent_snapshot_json as Record<string, unknown>;
  const tools = snapshot.platform_tools;
  if (!Array.isArray(tools) || !tools.includes(context.operationId)) return reject("KNOWLEDGE_SCOPE_DENIED", "Operation is not in the Job allowlist");
  if (mutation && !context.idempotencyKey) return reject("KNOWLEDGE_IDEMPOTENCY_REQUIRED", "Mutation requires an idempotency key", "idempotency_key");
  return { jobId: context.jobId, projectId: context.projectId, canvasId: context.canvasId, attemptId: String(row.attempt_id), snapshot };
}

async function visibleEntry(db: KnowledgeDb, actor: KnowledgeActor, entry: CatalogEntry): Promise<boolean> {
  if (entry.owner_project_id !== actor.projectId && entry.kind === "memory") return false;
  const [version] = await db`SELECT v.id FROM project_knowledge_versions v
    JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id WHERE v.id=${entry.version_id}
    AND v.project_id=${entry.owner_project_id} AND v.item_id=${entry.item_id} AND v.version=${entry.version}
    AND v.content_sha256=${entry.hash} AND v.revoked_at IS NULL AND i.kind=${entry.kind} AND i.status<>'revoked'`;
  if (!version) return false;
  if (entry.owner_project_id === actor.projectId) return true;
  if (!(await approvedKnowledgeVersion(db, entry.owner_project_id, entry.version_id))) return false;
  if (!entry.grant_id) return false;
  const [grant] = await db`SELECT id FROM project_knowledge_grants WHERE id=${entry.grant_id}
    AND owner_project_id=${entry.owner_project_id} AND item_id=${entry.item_id} AND version_id=${entry.version_id}
    AND grantee_project_id=${actor.projectId} AND revoked_at IS NULL`;
  return Boolean(grant);
}

function catalogFor(actor: KnowledgeActor): { entries: CatalogEntry[]; hash: string } {
  const value = actor.snapshot.project_knowledge_catalog as { entries?: CatalogEntry[]; hash?: string } | undefined;
  if (!Array.isArray(value?.entries) || value.hash !== sha256(canonical(value.entries)))
    return reject("KNOWLEDGE_SCOPE_DENIED", "Job has no valid frozen knowledge catalog");
  return { entries: value.entries, hash: value.hash };
}

async function readOnly(db: KnowledgeDb, actor: KnowledgeActor, operation: KnowledgeOperation, input: Record<string, unknown>, cursorSecret: Buffer): Promise<Record<string, unknown>> {
  if (operation === "read_knowledge_input") return readManifestInput(db, actor, input as never);
  if (operation === "get_knowledge_receipt") {
    const rows = input.receipt_ref
      ? await db`SELECT id,operation,result_json,input_digest FROM project_knowledge_receipts WHERE id=${input.receipt_ref as string} AND job_id=${actor.jobId}`
      : await db`SELECT id,operation,result_json,input_digest FROM project_knowledge_receipts WHERE idempotency_key=${input.idempotency_key as string} AND job_id=${actor.jobId}`;
    if (!rows[0]) return reject("KNOWLEDGE_SCOPE_DENIED", "Receipt is unavailable for this Job");
    return { receipt_ref: rows[0].id, receipt_operation: rows[0].operation, input_digest: rows[0].input_digest, result: rows[0].result_json };
  }
  const catalog = catalogFor(actor);
  if (operation === "read_project_memory") {
    const entry = catalog.entries.find((item) => item.kind === "memory" && item.item_id === input.item_ref && item.version === input.version && item.hash === input.expected_hash && item.owner_project_id === actor.projectId);
    if (!entry) return reject("KNOWLEDGE_SCOPE_DENIED", "Memory version is absent from this Job snapshot");
    if (!(await visibleEntry(db, actor, entry))) return reject("KNOWLEDGE_REVOKED", "Memory version is revoked");
    const candidate = await readKnowledgeVersionContent(db, entry.version_id);
    if (!(await visibleEntry(db, actor, entry))) return reject("KNOWLEDGE_REVOKED", "Memory version was revoked during read");
    const usageRef = await recordKnowledgeUsage(db, { projectId: actor.projectId, jobId: actor.jobId, attemptId: actor.attemptId,
      selector: `project-memory:${entry.item_id}@${entry.version}`, contentHash: entry.hash,
      ownerProjectId: entry.owner_project_id, versionId: entry.version_id });
    return { item_ref: entry.item_id, version: entry.version, content_hash: entry.hash, content: candidate.content ?? "", title: entry.title ?? candidate.title, usage_ref: usageRef };
  }
  if (operation === "search_project_knowledge") {
    const visible: CatalogEntry[] = [];
    for (const entry of catalog.entries) if (await visibleEntry(db, actor, entry)) visible.push(entry);
    const query = String(input.query ?? "").toLocaleLowerCase();
    const keywords = (input.keywords ?? []) as string[];
    const filtered = visible.filter((entry) => (!input.kind || entry.kind === input.kind)
      && (!query || `${entry.title ?? ""} ${entry.logical_key ?? ""} ${(entry.keywords ?? []).join(" ")}`.toLocaleLowerCase().includes(query))
      && keywords.every((term) => (entry.keywords ?? []).includes(term)));
    const binding = sha256(canonical({ job: actor.jobId, catalog: catalog.hash, query, kind: input.kind ?? null, keywords }));
    const sign = (offset: number) => createHmac("sha256", cursorSecret).update(`${binding}:${offset}`).digest("hex");
    let start = 0;
    if (input.cursor) {
      try {
        const [offset, mac] = JSON.parse(Buffer.from(String(input.cursor), "base64url").toString("utf8")) as [number, string];
        if (!Number.isSafeInteger(offset) || mac !== sign(offset)) return reject("KNOWLEDGE_CURSOR_INVALID", "Knowledge cursor does not match this query");
        start = offset;
      } catch { return reject("KNOWLEDGE_CURSOR_INVALID", "Invalid knowledge cursor"); }
    }
    if (!Number.isSafeInteger(start) || start < 0) return reject("KNOWLEDGE_CURSOR_INVALID", "Invalid knowledge cursor");
    const page = filtered.slice(start, start + Number(input.limit ?? 10));
    const next = start + page.length;
    return { items: page, next_cursor: next < filtered.length ? Buffer.from(JSON.stringify([next, sign(next)])).toString("base64url") : null, catalog_hash: catalog.hash };
  }
  return reject("KNOWLEDGE_OPERATION_INVALID", "Unsupported read operation");
}

export function createProjectKnowledgeApplication({ db, governanceHash }: KnowledgeApplicationInput) {
  const cursorSecret = randomBytes(32);
  return {
    async invoke(context: PlatformRuntimeHandlerContext): Promise<Record<string, unknown>> {
      const operation = context.operationId as KnowledgeOperation;
      const schema = KnowledgeControlPayloadSchemas[operation];
      if (!schema) return reject("KNOWLEDGE_OPERATION_INVALID", "Unknown knowledge operation");
      const parsed = schema.safeParse(context.input);
      if (!parsed.success) return reject("KNOWLEDGE_INPUT_INVALID", "Knowledge input violates strict contract", parsed.error.issues[0]?.path.join("."));
      const input = parsed.data as Record<string, unknown>;
      const mutation = (KNOWLEDGE_MUTATION_IDS as readonly string[]).includes(operation);
      const actor = await actorFor(db, context, mutation);
      if (!mutation) return { accepted: true, ...await readOnly(db, actor, operation, input, cursorSecret), operation };
      const key = context.idempotencyKey!;
      const eventId = knowledgeEventId(actor.jobId, key);
      const receiptId = randomUUID();
      const inputDigest = sha256(canonical(input));
      const [existing] = await db`SELECT operation,input_digest,result_json FROM project_knowledge_receipts WHERE job_id=${actor.jobId} AND idempotency_key=${key}`;
      if (existing) {
        if (existing.operation !== operation || existing.input_digest !== inputDigest) return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Idempotency key has a different operation or input");
        return existing.result_json as Record<string, unknown>;
      }
      let prepared: { manifest?: KnowledgeInputManifestEntry[] } = {};
      const recipe = operation === "request_project_knowledge" || operation === "record_knowledge_feedback"
        ? await frozenGovernorRecipe(db, actor) : undefined;
      let candidate: PreparedCandidate | undefined;
      let reviewCandidate: { hash: string; title: string; keywords: string[] } | undefined;
      let trialEvidence: Awaited<ReturnType<typeof prepareTrialEvidence>> = new Map();
      if (operation === "request_project_knowledge") {
        const refs = input.source_refs as Array<{ kind: "asset" | "fact" | "evidence"; ref: string; content_hash: string }>;
        prepared = { manifest: await Promise.all(refs.map((ref) => resolveKnowledgeSource(db, actor, ref))) };
      }
      if (operation === "record_knowledge_feedback") {
        await validateFeedbackUsage(db, actor, String(input.usage_ref));
        prepared = { manifest: await Promise.all((input.evidence_refs as Array<{ kind: "asset" | "fact" | "evidence"; ref: string; content_hash: string }>).map((ref) => resolveKnowledgeSource(db, actor, ref))) };
      }
      if (operation === "propose_project_knowledge" && input.candidate) candidate = await writeKnowledgeBlob(db, input.candidate);
      if (operation === "submit_knowledge_evaluation") trialEvidence = await prepareTrialEvidence(db, input as never);
      if (operation === "review_project_knowledge" && input.decision === "approve") {
        const [row] = await db`SELECT v.id,v.content_sha256 FROM project_knowledge_job_assignments a
          JOIN project_knowledge_proposals p ON p.id=a.proposal_id AND p.project_id=a.project_id
          JOIN project_knowledge_versions v ON v.id=p.candidate_version_id AND v.project_id=p.project_id
          WHERE a.job_id=${actor.jobId} AND a.project_id=${actor.projectId} AND a.stage='reviewer' AND a.proposal_id=${input.proposal_ref as string}`;
        if (row) {
          const content = await readKnowledgeVersionContent(db, String(row.id));
          reviewCandidate = { hash: String(row.content_sha256), title: content.title, keywords: content.keywords };
        }
      }
      const ingestion = createEventIngestionApplication(db, async (tx, jobId, envelope, ingest) => {
        if (envelope.type !== "knowledge" || jobId !== actor.jobId || ingest?.jobStatusAtLock !== "running" || ingest.attemptId !== actor.attemptId) return reject("KNOWLEDGE_JOB_INACTIVE", "Job changed before knowledge settlement");
        // The ingestion transaction already owns the Job lock. An earlier read
        // outside this boundary cannot reserve a key against concurrent completion.
        if (await readControlReceiptByKey(tx, jobId, key)) {
          return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Idempotency key belongs to a control receipt");
        }
        const [current] = await tx`SELECT lease_expires_at,agent_snapshot_json FROM jobs WHERE id=${jobId}`;
        if (!current || !current.lease_expires_at || new Date(current.lease_expires_at as string).getTime() <= Date.now()) return reject("KNOWLEDGE_JOB_INACTIVE", "Job lease expired");
        const [attempt] = await tx`SELECT id FROM job_attempts WHERE id=${actor.attemptId} AND status='active' AND NOT cancel_requested`;
        if (!attempt) return reject("KNOWLEDGE_JOB_INACTIVE", "Attempt is no longer active");
        const tools = (current.agent_snapshot_json as Record<string, unknown>).platform_tools;
        if (!Array.isArray(tools) || !tools.includes(operation)) return reject("KNOWLEDGE_SCOPE_DENIED", "Operation was removed from Job allowlist");
        let result: Record<string, unknown>;
        if (operation === "request_project_knowledge") {
          await recheckKnowledgeSources(tx, actor, input.source_refs as never);
          const work = await enqueueKnowledgeWork(tx, { actor, governanceHash, trigger: input.source_refs, manifest: prepared.manifest!, recipe, reason: String(input.reason) });
          result = { work_ref: work, status: "pending" };
        } else if (operation === "propose_project_knowledge") {
          result = await proposeKnowledge(tx, actor, input as never, candidate, governanceHash, key, inputDigest);
        } else if (operation === "submit_knowledge_evaluation") {
          result = await evaluateKnowledge(tx, actor, input as never, trialEvidence);
        } else if (operation === "review_project_knowledge") {
          result = await reviewKnowledge(tx, actor, input as never, reviewCandidate);
        } else if (operation === "record_knowledge_feedback") {
          await recheckKnowledgeSources(tx, actor, input.evidence_refs as never);
          result = await recordKnowledgeFeedback(tx, actor, input as never, prepared.manifest!, governanceHash, recipe);
        } else return reject("KNOWLEDGE_OPERATION_INVALID", "Knowledge mutation is not implemented");
        result = { accepted: true, operation, receipt_ref: receiptId, ...result };
        await tx`INSERT INTO project_knowledge_receipts(id,project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
          VALUES(${receiptId},${actor.projectId},${actor.jobId},${actor.attemptId},${operation},${key},${inputDigest},${eventId},${tx.json(result as never)})`;
      }, { maxPayloadBytes: 180 * 1024 });
      await ingestion.ingestEvent(actor.jobId, { v: 1, event_id: eventId, type: "knowledge", payload: { operation: operation as never, input } });
      const [settled] = await db`SELECT operation,input_digest,result_json FROM project_knowledge_receipts WHERE job_id=${actor.jobId} AND idempotency_key=${key}`;
      if (!settled) return reject("KNOWLEDGE_RECEIPT_MISSING", "Knowledge event has no durable settlement");
      if (settled.operation !== operation || settled.input_digest !== inputDigest) return reject("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "Idempotency key has a different operation or input");
      return settled.result_json as Record<string, unknown>;
    },
  };
}
