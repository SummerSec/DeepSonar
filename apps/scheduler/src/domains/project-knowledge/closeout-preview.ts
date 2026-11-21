import { z } from "zod";
import { SubmitTaskKnowledgeSuggestionPayload, TASK_KNOWLEDGE_SUGGESTION_OPERATION } from "@deepsonar/shared-types";
import { readKnowledgeBlob } from "./blobs.js";
import { suggestionSourceHashes, resolveSuggestionTarget } from "./closeout-intake.js";
import type { KnowledgeDb, KnowledgeRow } from "./types.js";
import { closeoutEvaluationKey } from "./closeout-evaluation-key.js";
import { readCloseoutEvaluation } from "./closeout-evaluation-result.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const StoredBundle = z.object({ input: SubmitTaskKnowledgeSuggestionPayload, source_hashes: z.array(z.array(hash).max(4)).max(2) });

async function closeoutNode(db: KnowledgeDb, projectId: string, rootId: string) {
  const [node] = await db`SELECT n.canvas_id,n.body_json->>'state' AS state FROM canvas_nodes n
    JOIN canvases c ON c.id=n.canvas_id JOIN canvas_nodes root ON root.canvas_id=c.id
    WHERE c.project_id=${projectId} AND root.id=${rootId} AND root.node_type='root' AND root.status='succeeded'
      AND n.node_type='knowledge_closeout' AND n.body_json->>'root_node_id'=${rootId}`;
  return node;
}

async function candidateRows(db: KnowledgeDb, projectId: string, rootId: string, canvasId: string,
  page: { limit: number; offset: number }, fingerprint?: string) {
  return db`SELECT chosen.* FROM (
    SELECT DISTINCT ON (fp.value) r.id,r.created_at,r.job_id,r.attempt_id,r.result_json->>'blob_hash' AS blob_hash,fp.ordinality,fp.value AS fingerprint
    FROM project_knowledge_receipts r JOIN jobs j ON j.id=r.job_id AND j.project_id=r.project_id
    JOIN LATERAL (SELECT id,status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a
      ON a.id=r.attempt_id AND a.status='succeeded'
    CROSS JOIN LATERAL jsonb_array_elements_text(r.result_json->'fingerprints') WITH ORDINALITY fp
    WHERE r.project_id=${projectId} AND j.canvas_id=${canvasId} AND j.status='succeeded'
      AND r.operation=${TASK_KNOWLEDGE_SUGGESTION_OPERATION} AND r.result_json->>'root_node_id'=${rootId}
      AND r.result_json->>'result'='suggestions'
      ${fingerprint ? db`AND fp.value=${fingerprint}` : db``}
    ORDER BY fp.value,r.created_at,r.id,fp.ordinality
  ) chosen ORDER BY chosen.created_at,chosen.id,chosen.ordinality LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
}

async function verifiedCandidate(db: KnowledgeDb, projectId: string, canvasId: string, row: KnowledgeRow) {
  const blobHash = hash.safeParse(row.blob_hash);
  if (!blobHash.success) return undefined;
  const bundle = await readKnowledgeBlob(db, blobHash.data).then(value => StoredBundle.safeParse(value)).catch(() => null);
  const index = Number(row.ordinality) - 1;
  const item = bundle?.success ? bundle.data.input.items[index] : undefined;
  const sourceHashes = bundle?.success ? bundle.data.source_hashes[index] : undefined;
  if (!item || sourceHashes?.length !== item.evidence_refs.length) return undefined;
  const owner = { projectId, canvasId, jobId: String(row.job_id), attemptId: String(row.attempt_id) };
  const target = item.target ? await resolveSuggestionTarget(db, owner, item) : undefined;
  if (item.target && !target) return undefined;
  const refs = [];
  for (const [i, ref] of item.evidence_refs.entries()) {
    const hashes = await suggestionSourceHashes(db, owner, ref);
    if (!hashes || hashes.integrity !== sourceHashes[i]) return undefined;
    refs.push({ ...ref, content_hash: hashes.knowledge });
  }
  return { item, owner, target, refs };
}

export async function findTaskKnowledgeCandidate(db: KnowledgeDb, projectId: string, rootId: string, fingerprint: string) {
  const node = await closeoutNode(db, projectId, rootId);
  if (node?.state !== "suggestions_available") return undefined;
  const canvasId = String(node.canvas_id);
  const [row] = await candidateRows(db, projectId, rootId, canvasId, { limit: 1, offset: 0 }, fingerprint);
  return row && verifiedCandidate(db, projectId, canvasId, row);
}

export async function readTaskKnowledgeCloseout(db: KnowledgeDb, projectId: string, rootId: string,
  scope: { sources: boolean; evaluate?: boolean }, page: { limit: number; offset: number }) {
  const node = await closeoutNode(db, projectId, rootId);
  if (!node) return undefined;
  if (node.state !== "suggestions_available") return { status: node.state, items: [], next_offset: null };
  const restricted = { status: "restricted", items: [], next_offset: null };
  if (!scope.sources) return restricted;
  const canvasId = String(node.canvas_id);
  const rows = await candidateRows(db, projectId, rootId, canvasId, page);
  const candidates = [];
  for (const row of rows.slice(0, page.limit)) {
    const candidate = await verifiedCandidate(db, projectId, canvasId, row);
    if (!candidate) return restricted;
    candidates.push({ ...candidate, fingerprint: String(row.fingerprint) });
  }
  const items = [];
  for (const { item, target, fingerprint } of candidates) {
    const evaluation = await readCloseoutEvaluation(db, projectId, closeoutEvaluationKey(rootId, fingerprint));
    items.push({ kind: item.kind, title: item.title, scope: item.scope, content: item.content, candidate_ref: fingerprint,
      evidence_refs: item.evidence_refs.map(({ kind, ref }) => ({ kind, ref })),
      ...(target ? { target: { item_ref: target.item_ref, version_ref: target.version_ref } } : {}),
      ...(evaluation ? { evaluation } : {}) });
  }
  if (!items.length && page.offset === 0) return restricted;
  return { status: "suggestions_available", items, can_evaluate: scope.evaluate === true,
    next_offset: rows.length > page.limit ? page.offset + page.limit : null };
}
