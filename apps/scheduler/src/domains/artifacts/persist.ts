import { randomUUID } from "node:crypto";
import { ArtifactKey } from "@deepsonar/shared-types";
import { invalidControlPayload } from "../../control-input.js";
import type { EventIngestionTransaction } from "../event-ingestion/application.js";
import type { ArtifactWrite } from "./model.js";

export interface PersistArtifactInput {
  projectId: string;
  canvasId: string | null;
  jobId: string;
  nodeId?: string | null;
  sourceEventId?: string | null;
  sourceOperation: "emit_fact" | "emit_finding";
  artifactKey?: string;
  document: ArtifactWrite;
}

export interface PersistedArtifact {
  id: string;
  artifact_key: string;
  revision: number;
}

function resolveArtifactKey(input: PersistArtifactInput): string {
  const raw = input.artifactKey ?? input.document.artifact_key ?? `fact:${randomUUID()}`;
  const parsed = ArtifactKey.safeParse(raw);
  if (!parsed.success) {
    throw invalidControlPayload("artifact_key 不符合 Artifact 身份格式。", "artifact.artifact_key");
  }
  return parsed.data;
}

export async function persistArtifact(
  tx: EventIngestionTransaction,
  input: PersistArtifactInput,
): Promise<PersistedArtifact> {
  const key = resolveArtifactKey(input);
  const [current] = await tx<{ id: string; revision: number }[]>`
    SELECT id, revision FROM artifacts
    WHERE project_id = ${input.projectId} AND artifact_key = ${key} AND superseded_at IS NULL
    FOR UPDATE`;
  let revision = 1;
  if (current) {
    await tx`
      UPDATE artifacts
      SET status = 'superseded', superseded_at = now(), updated_at = now()
      WHERE id = ${current.id}`;
    revision = current.revision + 1;
  }
  const [row] = await tx<PersistedArtifact[]>`
    INSERT INTO artifacts ${tx({
      project_id: input.projectId,
      canvas_id: input.canvasId,
      job_id: input.jobId,
      node_id: input.nodeId ?? null,
      artifact_key: key,
      revision,
      kind: input.document.kind,
      schema_version: input.document.schema_version,
      status: "submitted",
      source_event_id: input.sourceEventId ?? null,
      source_operation: input.sourceOperation,
      extensions_json: input.document.extensions as never,
      body_json: input.document.body as never,
    })}
    RETURNING id, artifact_key, revision`;
  if (!row) throw new Error("failed to persist artifact");

  for (const [index, claim] of input.document.claims.entries()) {
    await tx`
      INSERT INTO artifact_claims ${tx({
        artifact_id: row.id,
        ordinal: index + 1,
        statement: claim.statement,
        subject_json: (claim.subject ?? {}) as never,
        expected: claim.expected ?? null,
        actual: claim.actual ?? null,
        status: claim.status,
        evidence_refs_json: claim.evidence_refs as never,
      })}`;
  }
  for (const [index, item] of input.document.evidence.entries()) {
    await tx`
      INSERT INTO artifact_evidence ${tx({
        artifact_id: row.id,
        ordinal: index + 1,
        kind: item.kind,
        statement: item.statement,
        polarity: item.polarity,
        uri: item.uri ?? null,
        sha256: item.sha256 ?? null,
      })}`;
  }
  for (const relation of input.document.relations) {
    if (relation.to_artifact_id === row.id) {
      throw invalidControlPayload("artifact relation 不能指向自身。", "artifact.relations");
    }
    const [target] = await tx<{ id: string }[]>`
      SELECT id FROM artifacts
      WHERE id = ${relation.to_artifact_id} AND project_id = ${input.projectId}`;
    if (!target) {
      throw invalidControlPayload("artifact relation 必须指向同项目已存在的 Artifact。", "artifact.relations");
    }
    await tx`
      INSERT INTO artifact_relations ${tx({
        from_artifact_id: row.id,
        to_artifact_id: target.id,
        relation_type: relation.relation_type,
        status: "asserted",
      })}`;
  }
  return row;
}

export async function bindArtifactNode(
  tx: EventIngestionTransaction,
  artifactId: string,
  nodeId: string,
): Promise<void> {
  await tx`UPDATE artifacts SET node_id = ${nodeId}, updated_at = now() WHERE id = ${artifactId}`;
}

export async function deleteArtifact(
  tx: EventIngestionTransaction,
  artifactId: string,
): Promise<void> {
  await tx`DELETE FROM artifacts WHERE id = ${artifactId}`;
}
