import { randomUUID } from "node:crypto";
import { sql } from "../../db.js";
import { isUuid } from "../../project-scope.js";
import {
  canonicalIdentityManifestContent,
  IDENTITY_MAPPING_SOURCE_KINDS,
  identityManifestContentDigest,
  PLATFORM_IDENTITY_FIELDS,
  type IdentityManifestContent,
  type IdentityMappingSourceKind,
  type PlatformIdentityField,
} from "./identity.js";
import { boundedText, dateOrNull, digest, fail, isoTimestamp, StrongRelationStoreError } from "./relation-errors.js";
import { requestStrongRelationRebuild } from "./relation-work.js";

type Db = typeof sql;

export const IDENTITY_SOURCE_ADMIN_SCOPE = "admin" as const;
export const IDENTITY_SOURCE_AUTHORITY_BASIS = "platform_admin_attestation" as const;

export interface IdentityMappingActor {
  type: string;
  id?: string | null;
  name?: string;
  projectId?: string | null;
  scopes?: readonly string[];
}

export interface IdentitySourceManifestInput {
  authority_version: string;
  source_kind: IdentityMappingSourceKind;
  source_ref: string;
  freshness_until: string;
  identity_fields: Partial<Record<PlatformIdentityField, string>>;
}

export interface IdentitySourceRecord extends IdentityManifestContent {
  source_id: string;
  project_id: string;
  finding_id: string;
  current_revision: number;
  content_sha256: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  registered_by: string;
  created_at: string;
  updated_at: string;
  authority_basis: typeof IDENTITY_SOURCE_AUTHORITY_BASIS;
  independent_external_verification: false;
}

export class IdentitySourceError extends StrongRelationStoreError {}

function principal(actor: IdentityMappingActor): string {
  const value = actor.id ?? actor.name;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function assertIdentitySourceAuthority(actor: IdentityMappingActor | null | undefined, projectId: string): void {
  if (!actor || !principal(actor)) fail("IDENTITY_SOURCE_FORBIDDEN", "server-authenticated platform identity authority is required");
  const trusted = actor.type === "internal"
    || ((actor.type === "bootstrap_admin" || actor.type === "api_token" || actor.type === "user")
      && (actor.scopes?.includes(IDENTITY_SOURCE_ADMIN_SCOPE) ?? false));
  if (!trusted) fail("IDENTITY_SOURCE_FORBIDDEN", "platform admin authority is required");
  if (actor.projectId && actor.projectId.toLowerCase() !== projectId.toLowerCase()) {
    fail("PROJECT_SCOPE_MISMATCH");
  }
}

function normalizeSourceRef(value: unknown): string {
  const normalized = boundedText(value, "source_ref", 512).normalize("NFKC").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) fail("INVALID_SOURCE_REF");
  return normalized;
}

function normalizeIdentityFields(value: unknown): Partial<Record<PlatformIdentityField, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_IDENTITY_FIELDS");
  const result: Partial<Record<PlatformIdentityField, string>> = {};
  for (const [field, rawDigest] of Object.entries(value as Record<string, unknown>)) {
    if (!PLATFORM_IDENTITY_FIELDS.includes(field as PlatformIdentityField)) fail("INVALID_IDENTITY_FIELD");
    result[field as PlatformIdentityField] = digest(rawDigest, `identity_field_${field}`);
  }
  if (Object.keys(result).length === 0) fail("IDENTITY_FIELDS_EMPTY");
  return result;
}

export function validateIdentitySourceInput(input: IdentitySourceManifestInput): IdentitySourceManifestInput {
  const keys = Object.keys((input ?? {}) as object).sort().join(",");
  if (keys !== "authority_version,freshness_until,identity_fields,source_kind,source_ref") {
    fail("INVALID_IDENTITY_SOURCE");
  }
  const sourceKind = boundedText(input?.source_kind, "source_kind", 64);
  if (!IDENTITY_MAPPING_SOURCE_KINDS.includes(sourceKind as IdentityMappingSourceKind)) fail("INVALID_SOURCE_KIND");
  return {
    authority_version: boundedText(input?.authority_version, "authority_version", 128).normalize("NFKC").trim(),
    source_kind: sourceKind as IdentityMappingSourceKind,
    source_ref: normalizeSourceRef(input?.source_ref),
    freshness_until: isoTimestamp(input?.freshness_until),
    identity_fields: normalizeIdentityFields(input?.identity_fields),
  };
}

export function sourceContentDigest(input: IdentitySourceManifestInput): string {
  return identityManifestContentDigest(canonicalIdentityManifestContent(input));
}

function positiveRevision(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`INVALID_${name.toUpperCase()}`);
  return value;
}

function fieldsFromRow(value: unknown): Partial<Record<PlatformIdentityField, string>> {
  return normalizeIdentityFields(value);
}

function sourceFromRow(row: Record<string, unknown>): IdentitySourceRecord {
  const identityFields = fieldsFromRow(row.identity_fields_json);
  return {
    source_id: String(row.source_id),
    project_id: String(row.project_id),
    finding_id: String(row.finding_id),
    authority_version: String(row.authority_version),
    source_kind: String(row.source_kind) as IdentityMappingSourceKind,
    source_ref: String(row.source_ref),
    freshness_until: new Date(String(row.freshness_until)).toISOString(),
    identity_fields: identityFields,
    current_revision: Number(row.current_revision),
    content_sha256: String(row.content_sha256),
    revoked_at: dateOrNull(row.revoked_at),
    revocation_reason: row.revocation_reason == null ? null : String(row.revocation_reason),
    registered_by: String(row.registered_by),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
    authority_basis: IDENTITY_SOURCE_AUTHORITY_BASIS,
    independent_external_verification: false,
  };
}

async function findingExists(db: Db, findingId: string, projectId: string, lock = true): Promise<boolean> {
  const rows = lock
    ? await db`SELECT id FROM findings WHERE id = ${findingId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`
    : await db`SELECT id FROM findings WHERE id = ${findingId}::uuid AND project_id = ${projectId}::uuid`;
  return Boolean(rows[0]);
}

export async function loadIdentitySource(
  projectId: string,
  findingId: string,
  sourceId: string,
  db: Db = sql,
): Promise<IdentitySourceRecord | null> {
  if (!isUuid(projectId) || !isUuid(findingId) || !isUuid(sourceId)) fail("INVALID_ID");
  const [row] = await db`
    SELECT s.source_id, s.project_id, s.finding_id, s.current_revision,
           s.revoked_at, s.revocation_reason, s.registered_by, s.created_at, s.updated_at,
           r.authority_version, r.source_kind, r.source_ref, r.freshness_until,
           r.identity_fields_json, r.content_sha256
    FROM project_finding_identity_sources s
    JOIN project_finding_identity_source_revisions r
      ON r.project_id = s.project_id AND r.source_id = s.source_id
     AND r.finding_id = s.finding_id AND r.revision = s.current_revision
    WHERE s.project_id = ${projectId}::uuid AND s.finding_id = ${findingId}::uuid
      AND s.source_id = ${sourceId}::uuid`;
  return row ? sourceFromRow(row as Record<string, unknown>) : null;
}

async function writeSourceRevision(
  tx: Db,
  projectId: string,
  findingId: string,
  sourceId: string,
  expectedRevision: number,
  input: IdentitySourceManifestInput,
  actor: IdentityMappingActor,
): Promise<IdentitySourceRecord> {
  const [source] = await tx`
    SELECT source_id, project_id, finding_id, current_revision, revoked_at
    FROM project_finding_identity_sources
    WHERE project_id = ${projectId}::uuid AND finding_id = ${findingId}::uuid
      AND source_id = ${sourceId}::uuid FOR UPDATE`;
  if (!source) fail("IDENTITY_SOURCE_NOT_FOUND");
  if (source.revoked_at) fail("IDENTITY_SOURCE_REVOKED");
  if (Number(source.current_revision) !== expectedRevision) fail("IDENTITY_SOURCE_CAS_CONFLICT");
  const revision = expectedRevision + 1;
  const contentSha = sourceContentDigest(input);
  await tx`
    INSERT INTO project_finding_identity_source_revisions(
      project_id, source_id, finding_id, revision, authority_version, source_kind,
      source_ref, freshness_until, identity_fields_json, content_sha256, registered_by
    ) VALUES (
      ${projectId}::uuid, ${sourceId}::uuid, ${findingId}::uuid, ${revision},
      ${input.authority_version}, ${input.source_kind}, ${input.source_ref},
      ${input.freshness_until}::timestamptz, ${tx.json(input.identity_fields as never)},
      ${contentSha}, ${principal(actor)}
    )`;
  const updated = await tx`
    UPDATE project_finding_identity_sources
    SET current_revision = ${revision}, updated_at = now()
    WHERE project_id = ${projectId}::uuid AND finding_id = ${findingId}::uuid
      AND source_id = ${sourceId}::uuid AND current_revision = ${expectedRevision}
    RETURNING source_id`;
  if (updated.count !== 1) fail("IDENTITY_SOURCE_CAS_CONFLICT");
  const result = await loadIdentitySource(projectId, findingId, sourceId, tx);
  if (!result) fail("IDENTITY_SOURCE_WRITE_FAILED");
  return result;
}

export async function registerIdentitySource(
  projectId: string,
  findingId: string,
  rawInput: IdentitySourceManifestInput,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentitySourceRecord> {
  if (!isUuid(projectId) || !isUuid(findingId)) fail("INVALID_ID");
  assertIdentitySourceAuthority(actor, projectId);
  const input = validateIdentitySourceInput(rawInput);
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    if (!(await findingExists(tx, findingId, projectId))) fail("FINDING_NOT_FOUND");
    const sourceId = randomUUID();
    const contentSha = sourceContentDigest(input);
    await tx`
      INSERT INTO project_finding_identity_sources(
        source_id, project_id, finding_id, current_revision, registered_by
      ) VALUES (${sourceId}::uuid, ${projectId}::uuid, ${findingId}::uuid, 1, ${principal(actor)})`;
    await tx`
      INSERT INTO project_finding_identity_source_revisions(
        project_id, source_id, finding_id, revision, authority_version, source_kind,
        source_ref, freshness_until, identity_fields_json, content_sha256, registered_by
      ) VALUES (
        ${projectId}::uuid, ${sourceId}::uuid, ${findingId}::uuid, 1,
        ${input.authority_version}, ${input.source_kind}, ${input.source_ref},
        ${input.freshness_until}::timestamptz, ${tx.json(input.identity_fields as never)},
        ${contentSha}, ${principal(actor)}
      )`;
    const result = await loadIdentitySource(projectId, findingId, sourceId, tx);
    if (!result) fail("IDENTITY_SOURCE_WRITE_FAILED");
    await requestStrongRelationRebuild(projectId, tx);
    return result;
  });
}

export async function reviseIdentitySource(
  projectId: string,
  findingId: string,
  sourceId: string,
  expectedRevision: number,
  rawInput: IdentitySourceManifestInput,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentitySourceRecord> {
  if (!isUuid(projectId) || !isUuid(findingId) || !isUuid(sourceId)) fail("INVALID_ID");
  assertIdentitySourceAuthority(actor, projectId);
  const expected = positiveRevision(expectedRevision, "expected_source_revision");
  const input = validateIdentitySourceInput(rawInput);
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    const result = await writeSourceRevision(tx, projectId, findingId, sourceId, expected, input, actor);
    await requestStrongRelationRebuild(projectId, tx);
    return result;
  });
}

export async function revokeIdentitySource(
  projectId: string,
  findingId: string,
  sourceId: string,
  expectedRevision: number,
  reason: string,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentitySourceRecord> {
  if (!isUuid(projectId) || !isUuid(findingId) || !isUuid(sourceId)) fail("INVALID_ID");
  assertIdentitySourceAuthority(actor, projectId);
  const expected = positiveRevision(expectedRevision, "expected_source_revision");
  const revocationReason = boundedText(reason, "revocation_reason", 512);
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    const [source] = await tx`
      SELECT source_id, current_revision, revoked_at
      FROM project_finding_identity_sources
      WHERE project_id = ${projectId}::uuid AND finding_id = ${findingId}::uuid
        AND source_id = ${sourceId}::uuid FOR UPDATE`;
    if (!source) fail("IDENTITY_SOURCE_NOT_FOUND");
    if (Number(source.current_revision) !== expected) fail("IDENTITY_SOURCE_CAS_CONFLICT");
    if (!source.revoked_at) {
      const updated = await tx`
        UPDATE project_finding_identity_sources
        SET revoked_at = now(), revocation_reason = ${revocationReason}, updated_at = now()
        WHERE project_id = ${projectId}::uuid AND finding_id = ${findingId}::uuid
          AND source_id = ${sourceId}::uuid AND current_revision = ${expected}
          AND revoked_at IS NULL RETURNING source_id`;
      if (updated.count !== 1) fail("IDENTITY_SOURCE_CAS_CONFLICT");
    }
    const result = await loadIdentitySource(projectId, findingId, sourceId, tx);
    if (!result) fail("IDENTITY_SOURCE_WRITE_FAILED");
    await requestStrongRelationRebuild(projectId, tx);
    return result;
  });
}

export function sourceRevisionIsCurrent(source: IdentitySourceRecord, revision: number): boolean {
  return source.current_revision === revision && source.revoked_at === null;
}
