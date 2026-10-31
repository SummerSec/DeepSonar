import { sql } from "../../db.js";
import { isUuid } from "../../project-scope.js";
import {
  emptyIdentitySnapshot,
  identitySnapshotDigest,
  PLATFORM_IDENTITY_FIELDS,
  type CurrentIdentityField,
  type CurrentIdentitySnapshot,
  type IdentityMappingRecord,
  type IdentityMappingSourceKind,
  type PlatformIdentityField,
} from "./identity.js";
import {
  assertIdentitySourceAuthority,
  loadIdentitySource,
  type IdentityMappingActor,
} from "./identity-source-store.js";
import { boundedText, dateOrNull, fail, StrongRelationStoreError } from "./relation-errors.js";
import { requestStrongRelationRebuild } from "./relation-work.js";

type Db = typeof sql;

export const IDENTITY_MAPPING_HISTORY_LIMIT = 64;

export interface IdentityMappingInput {
  source_id: string;
  field: PlatformIdentityField;
  expected_mapping_version: number | null;
}

export interface IdentityMappingResult {
  id: string;
  project_id: string;
  finding_id: string;
  field: PlatformIdentityField;
  source_id: string;
  source_revision: number;
  identity_digest: string;
  authority_version: string;
  source_kind: IdentityMappingSourceKind;
  source_ref: string;
  source_digest: string;
  mapping_version: number;
  freshness_until: string;
  revoked_at: string | null;
}

export function assertIdentityMappingAuthority(actor: IdentityMappingActor | null | undefined, projectId: string): void {
  assertIdentitySourceAuthority(actor, projectId);
}

function expectedVersion(value: unknown, allowNull: boolean): number | null {
  if (value === null && allowNull) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("INVALID_EXPECTED_MAPPING_VERSION");
  return value;
}

export function validateIdentityMappingInput(input: IdentityMappingInput, mode: "register" | "remap" = "register"): IdentityMappingInput {
  const keys = Object.keys((input ?? {}) as object).sort().join(",");
  if (keys !== "expected_mapping_version,field,source_id") fail("INVALID_IDENTITY_MAPPING");
  if (!isUuid(input?.source_id)) fail("INVALID_SOURCE_ID");
  if (!PLATFORM_IDENTITY_FIELDS.includes(input?.field)) fail("INVALID_IDENTITY_FIELD");
  const version = expectedVersion(input?.expected_mapping_version, mode === "register");
  if (mode === "register" && version !== null) fail("INVALID_EXPECTED_MAPPING_VERSION");
  if (mode === "remap" && version === null) fail("INVALID_EXPECTED_MAPPING_VERSION");
  return { source_id: input.source_id, field: input.field, expected_mapping_version: version };
}

function mappingRow(row: Record<string, unknown>): IdentityMappingRecord {
  const identityDigest = row.identity_digest == null ? "" : String(row.identity_digest);
  const sourceCurrentRevision = row.source_current_revision == null ? null : Number(row.source_current_revision);
  const sourceRevokedAt = dateOrNull(row.source_revoked_at);
  const sourceFreshness = row.source_freshness_until == null ? null : new Date(String(row.source_freshness_until)).toISOString();
  const sourceChanged = sourceCurrentRevision === null || sourceCurrentRevision !== Number(row.source_revision);
  const sourceRevoked = sourceRevokedAt !== null;
  const sourceStale = sourceFreshness === null || Date.parse(sourceFreshness) <= Date.now();
  const mappingRevoked = row.revoked_at !== null && row.revoked_at !== undefined;
  const invalidReason = mappingRevoked
    ? "mapping_revoked"
    : sourceChanged
      ? "source_changed"
      : sourceRevoked
        ? "source_revoked"
        : sourceStale
          ? "source_stale"
          : undefined;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    finding_id: String(row.finding_id),
    field: String(row.field) as PlatformIdentityField,
    identity_digest: identityDigest,
    authority_version: String(row.authority_version),
    source_kind: String(row.source_kind) as IdentityMappingRecord["source_kind"],
    source_ref: String(row.source_ref),
    source_revision: Number(row.source_revision),
    source_digest: String(row.source_digest),
    freshness_until: sourceFreshness ?? new Date(0).toISOString(),
    source_id: String(row.source_id),
    mapping_version: Number(row.mapping_version),
    revoked_at: dateOrNull(row.revoked_at),
    revocation_reason: row.revocation_reason == null ? null : String(row.revocation_reason),
    authorized_by: String(row.authorized_by),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
    currently_valid: invalidReason === undefined && identityDigest.length > 0,
    invalid_reason: invalidReason,
  };
}

function publicMapping(
  row: Record<string, unknown>,
  source: {
    identity_digest: string;
    authority_version: string;
    source_kind: IdentityMappingSourceKind;
    source_ref: string;
    content_sha256: string;
  },
): IdentityMappingResult {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    finding_id: String(row.finding_id),
    field: String(row.field) as PlatformIdentityField,
    source_id: String(row.source_id),
    source_revision: Number(row.source_revision),
    identity_digest: source.identity_digest,
    authority_version: source.authority_version,
    source_kind: source.source_kind,
    source_ref: source.source_ref,
    source_digest: source.content_sha256,
    mapping_version: Number(row.mapping_version),
    freshness_until: new Date(String(row.freshness_until)).toISOString(),
    revoked_at: dateOrNull(row.revoked_at),
  };
}

async function findingExists(db: Db, findingId: string, projectId: string): Promise<boolean> {
  const [row] = await db`SELECT id FROM findings
    WHERE id = ${findingId}::uuid AND project_id = ${projectId}::uuid FOR UPDATE`;
  return Boolean(row);
}

async function mappingRows(db: Db, findingId: string, projectId: string): Promise<Record<string, unknown>[]> {
  return await db`
    WITH fields(field) AS (
      SELECT unnest(ARRAY[
        'asset', 'service', 'tenant', 'environment', 'version', 'parameter',
        'permission_boundary', 'root_cause'
      ]::text[])
    )
    SELECT bounded.*
    FROM fields
    CROSS JOIN LATERAL (
      SELECT m.id, m.project_id, m.finding_id, m.field, m.source_id, m.source_revision,
             m.mapping_version, m.revoked_at, m.revocation_reason, m.authorized_by,
             m.created_at, m.updated_at,
             s.current_revision AS source_current_revision, s.revoked_at AS source_revoked_at,
             r.authority_version, r.source_kind, r.source_ref,
             r.freshness_until AS source_freshness_until, r.content_sha256 AS source_digest,
             r.identity_fields_json ->> m.field AS identity_digest
      FROM project_finding_identity_mappings m
      LEFT JOIN project_finding_identity_sources s
        ON s.project_id = m.project_id AND s.source_id = m.source_id
       AND s.finding_id = m.finding_id
      LEFT JOIN project_finding_identity_source_revisions r
        ON r.project_id = m.project_id AND r.source_id = m.source_id
       AND r.finding_id = m.finding_id AND r.revision = m.source_revision
      WHERE m.project_id = ${projectId}::uuid AND m.finding_id = ${findingId}::uuid
        AND m.field = fields.field
      ORDER BY m.mapping_version DESC
      LIMIT ${IDENTITY_MAPPING_HISTORY_LIMIT + 1}
    ) AS bounded
    ORDER BY bounded.field, bounded.mapping_version` as Record<string, unknown>[];
}

function currentField(
  rows: IdentityMappingRecord[],
  field: PlatformIdentityField,
  historyTruncated: boolean,
): CurrentIdentityField {
  const ordered = [...rows].sort((left, right) => left.mapping_version - right.mapping_version);
  const latest = ordered.at(-1);
  if (!latest) {
    return { field, status: "missing", identity_digest: null, authority_versions: [], mappings: [], invalid_mapping_count: 0 };
  }
  const valid = latest.revoked_at === null && latest.currently_valid === true;
  const currentValid = ordered.filter((row) => row.revoked_at === null && row.currently_valid === true);
  const sameDigest = currentValid.length > 0 && new Set(currentValid.map((row) => row.identity_digest)).size === 1;
  const status = historyTruncated
    ? "conflict"
    : latest.revoked_at !== null
      ? "revoked"
      : latest.invalid_reason === "source_revoked"
        ? "revoked"
        : !valid
          ? "stale"
          : currentValid.length !== 1 || !sameDigest
            ? "conflict"
            : "valid";
  return {
    field,
    status,
    identity_digest: status === "valid" ? latest.identity_digest : null,
    authority_versions: [...new Set((status === "valid" ? currentValid : ordered).map((row) => row.authority_version))].sort(),
    mappings: ordered,
    invalid_mapping_count: status === "valid" ? ordered.length - 1 : ordered.length,
    history_truncated: historyTruncated,
  };
}

export async function loadCurrentIdentitySnapshot(
  findingId: string,
  projectId: string,
  db: Db = sql,
): Promise<CurrentIdentitySnapshot> {
  const rows = await mappingRows(db, findingId, projectId);
  const snapshot = emptyIdentitySnapshot(findingId, projectId);
  let historyTruncated = false;
  for (const field of PLATFORM_IDENTITY_FIELDS) {
    const fieldRows = rows.filter((row) => String(row.field) === field);
    const truncated = fieldRows.length > IDENTITY_MAPPING_HISTORY_LIMIT;
    historyTruncated ||= truncated;
    snapshot.fields[field] = currentField(fieldRows.map(mappingRow), field, truncated);
  }
  snapshot.history_truncated = historyTruncated;
  snapshot.read_bounded = !historyTruncated;
  snapshot.fingerprint = identitySnapshotDigest(snapshot);
  return snapshot;
}

async function sourceForMapping(
  tx: Db,
  projectId: string,
  findingId: string,
  input: IdentityMappingInput,
): Promise<NonNullable<Awaited<ReturnType<typeof loadIdentitySource>>> & { identity_digest: string }> {
  const source = await loadIdentitySource(projectId, findingId, input.source_id, tx);
  if (!source) fail("IDENTITY_SOURCE_NOT_FOUND");
  if (source.revoked_at) fail("IDENTITY_SOURCE_REVOKED");
  if (Date.parse(source.freshness_until) <= Date.now()) fail("IDENTITY_SOURCE_STALE");
  const identityDigest = source.identity_fields[input.field];
  if (!identityDigest) fail("IDENTITY_SOURCE_FIELD_MISSING");
  return { ...source, identity_digest: identityDigest };
}

async function insertMapping(
  tx: Db,
  projectId: string,
  findingId: string,
  input: IdentityMappingInput,
  actor: IdentityMappingActor,
  mode: "register" | "remap",
): Promise<IdentityMappingResult> {
  const source = await sourceForMapping(tx, projectId, findingId, input);
  const [latest] = await tx`
    SELECT id, source_id, source_revision, mapping_version, revoked_at
    FROM project_finding_identity_mappings
    WHERE project_id = ${projectId}::uuid AND finding_id = ${findingId}::uuid
      AND field = ${input.field}
    ORDER BY mapping_version DESC LIMIT 1 FOR UPDATE`;
  if (mode === "register") {
    if (latest) fail("IDENTITY_MAPPING_REMAP_REQUIRED", "an existing mapping requires an explicit CAS remap");
  } else {
    if (!latest || Number(latest.mapping_version) !== input.expected_mapping_version) {
      fail("IDENTITY_MAPPING_CAS_CONFLICT");
    }
    if (String(latest.source_id) === source.source_id && Number(latest.source_revision) === source.current_revision) {
      fail("IDENTITY_MAPPING_SOURCE_CONFLICT", "mapping already references the current source revision");
    }
  }
  const version = latest ? Number(latest.mapping_version) + 1 : 1;
  const [row] = await tx`
    INSERT INTO project_finding_identity_mappings(
      project_id, finding_id, field, source_id, source_revision,
      mapping_version, authorized_by
    ) VALUES (
      ${projectId}::uuid, ${findingId}::uuid, ${input.field}, ${source.source_id}::uuid,
      ${source.current_revision}, ${version}, ${actor.id ?? actor.name ?? actor.type}
    )
    RETURNING id, project_id, finding_id, field, source_id, source_revision,
              mapping_version, revoked_at, ${source.freshness_until}::timestamptz AS freshness_until`;
  if (!row) fail("IDENTITY_MAPPING_WRITE_FAILED");
  return publicMapping(row as Record<string, unknown>, source);
}

export async function registerIdentityMapping(
  projectId: string,
  findingId: string,
  rawInput: IdentityMappingInput,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentityMappingResult> {
  if (!isUuid(projectId) || !isUuid(findingId)) fail("INVALID_ID");
  assertIdentityMappingAuthority(actor, projectId);
  const input = validateIdentityMappingInput(rawInput, "register");
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    if (!(await findingExists(tx, findingId, projectId))) fail("FINDING_NOT_FOUND");
    const result = await insertMapping(tx, projectId, findingId, input, actor, "register");
    await requestStrongRelationRebuild(projectId, tx);
    return result;
  });
}

export async function remapIdentityMapping(
  projectId: string,
  findingId: string,
  rawInput: IdentityMappingInput,
  reason: string,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentityMappingResult> {
  if (!isUuid(projectId) || !isUuid(findingId)) fail("INVALID_ID");
  assertIdentityMappingAuthority(actor, projectId);
  const input = validateIdentityMappingInput(rawInput, "remap");
  const revocationReason = boundedText(reason, "revocation_reason", 512);
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    if (!(await findingExists(tx, findingId, projectId))) fail("FINDING_NOT_FOUND");
    const [active] = await tx`
      SELECT m.id, m.mapping_version, m.revoked_at
      FROM project_finding_identity_mappings m
      WHERE m.project_id = ${projectId}::uuid AND m.finding_id = ${findingId}::uuid
        AND m.field = ${input.field}
      ORDER BY m.mapping_version DESC LIMIT 1 FOR UPDATE`;
    if (!active || Number(active.mapping_version) !== input.expected_mapping_version) fail("IDENTITY_MAPPING_CAS_CONFLICT");
    if (!active.revoked_at) {
      await tx`UPDATE project_finding_identity_mappings
        SET revoked_at = now(), revocation_reason = ${revocationReason}, updated_at = now()
        WHERE id = ${active.id}::uuid AND revoked_at IS NULL`;
    }
    const result = await insertMapping(tx, projectId, findingId, input, actor, "remap");
    await requestStrongRelationRebuild(projectId, tx);
    return result;
  });
}

export async function revokeIdentityMapping(
  projectId: string,
  findingId: string,
  field: PlatformIdentityField,
  expectedMappingVersion: number,
  reason: string,
  actor: IdentityMappingActor,
  db: Db = sql,
): Promise<IdentityMappingResult | null> {
  if (!isUuid(projectId) || !isUuid(findingId)) fail("INVALID_ID");
  assertIdentityMappingAuthority(actor, projectId);
  if (!PLATFORM_IDENTITY_FIELDS.includes(field)) fail("INVALID_IDENTITY_FIELD");
  const expected = expectedVersion(expectedMappingVersion, false);
  const revocationReason = boundedText(reason, "revocation_reason", 512);
  return db.begin(async (raw) => {
    const tx = raw as unknown as Db;
    if (!(await findingExists(tx, findingId, projectId))) fail("FINDING_NOT_FOUND");
    const [row] = await tx`
      SELECT m.id, m.project_id, m.finding_id, m.field, m.source_id, m.source_revision,
             m.mapping_version, r.authority_version, r.source_kind, r.source_ref,
             r.content_sha256 AS source_digest, r.identity_fields_json ->> m.field AS identity_digest,
             r.freshness_until, m.revoked_at
      FROM project_finding_identity_mappings m
      JOIN project_finding_identity_source_revisions r
        ON r.project_id = m.project_id AND r.source_id = m.source_id
       AND r.finding_id = m.finding_id AND r.revision = m.source_revision
      WHERE m.project_id = ${projectId}::uuid AND m.finding_id = ${findingId}::uuid
        AND m.field = ${field}
      ORDER BY m.mapping_version DESC LIMIT 1 FOR UPDATE`;
    if (!row) return null;
    if (Number(row.mapping_version) !== expected) fail("IDENTITY_MAPPING_CAS_CONFLICT");
    if (!row.revoked_at) {
      const updated = await tx`UPDATE project_finding_identity_mappings
        SET revoked_at = now(), revocation_reason = ${revocationReason}, updated_at = now()
        WHERE id = ${row.id}::uuid AND mapping_version = ${expected} AND revoked_at IS NULL
        RETURNING id, revoked_at`;
      if (updated.count !== 1) fail("IDENTITY_MAPPING_CAS_CONFLICT");
      row.revoked_at = updated[0].revoked_at;
    }
    await requestStrongRelationRebuild(projectId, tx);
    return {
      id: String(row.id), project_id: String(row.project_id), finding_id: String(row.finding_id),
      field: String(row.field) as PlatformIdentityField, source_id: String(row.source_id),
      source_revision: Number(row.source_revision), mapping_version: Number(row.mapping_version),
      identity_digest: String(row.identity_digest), authority_version: String(row.authority_version),
      source_kind: String(row.source_kind) as IdentityMappingSourceKind,
      source_ref: String(row.source_ref), source_digest: String(row.source_digest),
      freshness_until: new Date(String(row.freshness_until)).toISOString(), revoked_at: dateOrNull(row.revoked_at),
    };
  });
}

export { StrongRelationStoreError } from "./relation-errors.js";
