import { KNOWLEDGE_LIMITS, type KnowledgeInputManifestEntry, type KnowledgeSourceRef } from "@deepsonar/shared-types";
import { getSharedAssetBlobStore } from "../../blob-store/index.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";
import { writeKnowledgeBlob, readKnowledgeBlob } from "./blobs.js";
import { pageKnowledgeInput } from "./input-page.js";

export interface KnowledgeActor { jobId: string; projectId: string; attemptId: string; canvasId: string | null; snapshot: Record<string, unknown> }

export async function resolveKnowledgeSource(db: KnowledgeDb, actor: KnowledgeActor, ref: KnowledgeSourceRef): Promise<KnowledgeInputManifestEntry> {
  let payload: unknown;
  if (ref.kind === "asset") {
    const [row] = await db`SELECT v.content_sha256,v.bytes,b.blob_uri FROM shared_asset_versions v
      JOIN shared_assets a ON a.id=v.asset_id LEFT JOIN job_shared_asset_versions j ON j.version_id=v.id AND j.job_id=${actor.jobId}
      JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
      WHERE v.id=${ref.ref} AND a.project_id=${actor.projectId} AND (j.job_id IS NOT NULL OR v.created_by_job_id=${actor.jobId})`;
    if (!row) return reject("KNOWLEDGE_SCOPE_DENIED", "Asset is not frozen for this Job", "source_refs");
    if (row.content_sha256 !== ref.content_hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Asset version hash changed", "source_refs.content_hash");
    if (Number(row.bytes) > KNOWLEDGE_LIMITS.readBytes) return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Asset exceeds the bounded knowledge input budget");
    const bytes = await getSharedAssetBlobStore().get(String(row.blob_uri));
    if (bytes.length !== Number(row.bytes) || sha256(bytes) !== ref.content_hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Asset bytes fail verification");
    if (bytes.length > KNOWLEDGE_LIMITS.readBytes) return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Asset exceeds bounded knowledge input; select a smaller source");
    payload = { kind: "asset", version_id: ref.ref, content_hash: ref.content_hash, content: bytes.toString("base64") };
  } else if (ref.kind === "fact") {
    const [row] = await db`SELECT n.id,n.body_json,n.verification_status FROM canvas_nodes n
      WHERE n.id=${ref.ref} AND n.node_type='fact' AND n.job_id=${actor.jobId} AND n.canvas_id=${actor.canvasId}`;
    if (!row) return reject("KNOWLEDGE_SCOPE_DENIED", "Fact is not in this Job scope", "source_refs");
    payload = { kind: "fact", id: row.id, body: row.body_json, verification_status: row.verification_status };
    if (sha256(canonical(payload)) !== ref.content_hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Fact hash mismatch", "source_refs.content_hash");
  } else {
    const [row] = await db`SELECT e.id,e.statement,e.payload_json,e.sha256 FROM artifact_evidence e
      JOIN artifacts a ON a.id=e.artifact_id WHERE e.id=${ref.ref} AND a.project_id=${actor.projectId} AND a.job_id=${actor.jobId}`;
    if (!row) return reject("KNOWLEDGE_SCOPE_DENIED", "Evidence is not in this Job scope", "source_refs");
    payload = { kind: "evidence", id: row.id, statement: row.statement, payload: row.payload_json, sha256: row.sha256 };
    if (sha256(canonical(payload)) !== ref.content_hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Evidence hash mismatch", "source_refs.content_hash");
  }
  if (Buffer.byteLength(canonical(payload), "utf8") > KNOWLEDGE_LIMITS.readBytes) return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Source exceeds bounded knowledge input");
  const blob = await writeKnowledgeBlob(db, payload);
  return { input_ref: `${ref.kind}:${ref.ref}`, kind: ref.kind, project_id: actor.projectId, content_hash: ref.content_hash,
    bytes: blob.bytes, blob_hash: blob.hash, audience: ["maker", "evaluator", "reviewer"] };
}

/** Transaction-only recheck; external blob reads have already happened before event ingestion. */
export async function recheckKnowledgeSources(tx: KnowledgeDb, actor: KnowledgeActor, refs: KnowledgeSourceRef[]): Promise<void> {
  for (const ref of refs) {
    if (ref.kind === "asset") {
      const [row] = await tx`SELECT v.content_sha256 FROM shared_asset_versions v JOIN shared_assets a ON a.id=v.asset_id
        LEFT JOIN job_shared_asset_versions j ON j.version_id=v.id AND j.job_id=${actor.jobId}
        WHERE v.id=${ref.ref} AND a.project_id=${actor.projectId} AND (j.job_id IS NOT NULL OR v.created_by_job_id=${actor.jobId})`;
      if (!row || row.content_sha256 !== ref.content_hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Frozen asset changed before settlement");
    } else if (ref.kind === "fact") {
      const [row] = await tx`SELECT id,body_json,verification_status FROM canvas_nodes WHERE id=${ref.ref}
        AND node_type='fact' AND job_id=${actor.jobId} AND canvas_id=${actor.canvasId}`;
      if (!row || sha256(canonical({ kind: "fact", id: row.id, body: row.body_json, verification_status: row.verification_status })) !== ref.content_hash)
        return reject("KNOWLEDGE_HASH_MISMATCH", "Fact changed before settlement");
    } else {
      const [row] = await tx`SELECT e.id,e.statement,e.payload_json,e.sha256 FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
        WHERE e.id=${ref.ref} AND a.project_id=${actor.projectId} AND a.job_id=${actor.jobId}`;
      if (!row || sha256(canonical({ kind: "evidence", id: row.id, statement: row.statement, payload: row.payload_json, sha256: row.sha256 })) !== ref.content_hash)
        return reject("KNOWLEDGE_HASH_MISMATCH", "Evidence changed before settlement");
    }
  }
}

export async function readManifestInput(db: KnowledgeDb, actor: KnowledgeActor, input: { work_ref: string; input_ref: string; expected_hash: string; cursor?: string }) {
  const [assignment] = await db`SELECT a.*,w.governance_hash FROM project_knowledge_job_assignments a
    JOIN project_knowledge_work w ON w.id=a.work_id AND w.project_id=a.project_id
    WHERE a.job_id=${actor.jobId} AND a.project_id=${actor.projectId} AND a.work_id=${input.work_ref}`;
  if (!assignment) return reject("KNOWLEDGE_SCOPE_DENIED", "No assignment to this knowledge work");
  const manifest = assignment.input_manifest_json as KnowledgeInputManifestEntry[];
  const entry = manifest.find((item) => item.input_ref === input.input_ref && item.content_hash === input.expected_hash && item.audience.includes(assignment.stage as never));
  if (!entry) return reject("KNOWLEDGE_SCOPE_DENIED", "Input reference is outside this assignment");
  if (entry.input_ref === "platform-probe:foreign-scope" || entry.input_ref === "platform-probe:revoked") {
    const errorCode = entry.input_ref.endsWith("foreign-scope") ? "KNOWLEDGE_SCOPE_DENIED" : "KNOWLEDGE_REVOKED";
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,error_code)
      VALUES('job',${actor.jobId},'project_knowledge.probe',${actor.projectId},'project_knowledge_work',${input.work_ref},'denied',${errorCode})`;
    return reject(errorCode, errorCode === "KNOWLEDGE_REVOKED" ? "Probe source was revoked before read" : "Probe source is outside this project");
  }
  if (entry.project_id !== actor.projectId) return reject("KNOWLEDGE_SCOPE_DENIED", "Input reference is outside this project");
  const versionMatch = /^(?:candidate|governor|baseline):([0-9a-f-]{36})$/i.exec(entry.input_ref);
  if (versionMatch) {
    const versionId = versionMatch[1]!;
    const [version] = await db`SELECT id FROM project_knowledge_versions WHERE id=${versionId} AND project_id=${actor.projectId}
      AND content_sha256=${entry.content_hash} AND revoked_at IS NULL`;
    if (!version) return reject("KNOWLEDGE_REVOKED", "Frozen knowledge version was revoked");
  }
  const content = await readKnowledgeBlob(db, entry.blob_hash);
  if (versionMatch) {
    const [version] = await db`SELECT id FROM project_knowledge_versions WHERE id=${versionMatch[1]!} AND revoked_at IS NULL`;
    if (!version) return reject("KNOWLEDGE_REVOKED", "Knowledge version was revoked during read");
  }
  return { input_ref: entry.input_ref, content_hash: entry.content_hash,
    ...pageKnowledgeInput(content, `${actor.jobId}/${input.work_ref}/${entry.input_ref}/${entry.content_hash}`, input.cursor) };
}
