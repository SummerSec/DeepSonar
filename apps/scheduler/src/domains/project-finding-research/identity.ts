import { createHash } from "node:crypto";

/**
 * Strong Finding identity is deliberately separate from declaration text.
 * These values are platform-issued digests.  Callers cannot promote title,
 * summary, task targets, or free-form evidence text into this contract.
 */
export const STRONG_IDENTITY_FIELDS = [
  "asset",
  "tenant",
  "environment",
  "version",
  "parameter",
  "root_cause",
] as const;
export type StrongIdentityField = typeof STRONG_IDENTITY_FIELDS[number];

/** Optional context fields can block a relation when both sides are known. */
export const CONTEXT_IDENTITY_FIELDS = ["service", "permission_boundary"] as const;
export type ContextIdentityField = typeof CONTEXT_IDENTITY_FIELDS[number];

export const PLATFORM_IDENTITY_FIELDS = [
  ...STRONG_IDENTITY_FIELDS,
  ...CONTEXT_IDENTITY_FIELDS,
] as const;
export type PlatformIdentityField = typeof PLATFORM_IDENTITY_FIELDS[number];

export const IDENTITY_MAPPING_SOURCE_KINDS = [
  "platform_target",
  "platform_inventory",
  "platform_deployment",
  "platform_evidence",
  "platform_root_cause",
] as const;
export type IdentityMappingSourceKind = typeof IDENTITY_MAPPING_SOURCE_KINDS[number];

export const STRONG_RELATION_RULE_VERSION = "project-finding-strong-relations/v1";
export const STRONG_RELATION_QUALITY_GATE_STATUS = "not_evaluated" as const;
/** Human-labelled holdout evidence is not present in this repository. */
export const STRONG_RELATIONS_PUBLISHED = false;

export interface IdentityManifestContent {
  authority_version: string;
  source_kind: IdentityMappingSourceKind;
  source_ref: string;
  freshness_until: string;
  identity_fields: Partial<Record<PlatformIdentityField, string>>;
}

export type IdentityFieldStatus = "valid" | "missing" | "stale" | "revoked" | "conflict";

export interface IdentityMappingRecord {
  id: string;
  project_id: string;
  finding_id: string;
  field: PlatformIdentityField;
  identity_digest: string;
  authority_version: string;
  source_kind: IdentityMappingSourceKind;
  source_ref: string;
  source_revision: number;
  source_digest: string;
  freshness_until: string;
  source_id: string;
  mapping_version: number;
  revoked_at: string | null;
  revocation_reason: string | null;
  authorized_by: string;
  created_at: string;
  updated_at: string;
  currently_valid?: boolean;
  invalid_reason?: "source_changed" | "source_revoked" | "source_stale" | "mapping_revoked";
}

export interface CurrentIdentityField {
  field: PlatformIdentityField;
  status: IdentityFieldStatus;
  identity_digest: string | null;
  authority_versions: string[];
  mappings: IdentityMappingRecord[];
  invalid_mapping_count: number;
  history_truncated?: boolean;
}

export interface CurrentIdentitySnapshot {
  finding_id: string;
  project_id: string;
  fields: Record<PlatformIdentityField, CurrentIdentityField>;
  fingerprint: string;
  read_bounded?: boolean;
  history_truncated?: boolean;
}

export type StrongRelationKind = "same_problem" | "same_root_cause_different_instance";

export type StrongRelationDecisionReason =
  | "same_authoritative_identity"
  | "root_cause_continuation"
  | "project_scope_mismatch"
  | "identity_missing"
  | "identity_source_invalid"
  | "identity_conflict"
  | "root_cause_continuity_unknown";

export interface StrongRelationDecision {
  kind: StrongRelationKind | "distinct" | "insufficient_information";
  matched_fields: PlatformIdentityField[];
  different_fields: PlatformIdentityField[];
  conflicts: PlatformIdentityField[];
  missing_fields: PlatformIdentityField[];
  root_cause_continuation: boolean;
  rule_version: string;
  reason: StrongRelationDecisionReason;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function digestIdentityValue(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error("identity value must not be blank");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function identitySnapshotDigest(snapshot: CurrentIdentitySnapshot): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(snapshot.fields)), "utf8")
    .digest("hex")}`;
}

export function canonicalIdentityManifestContent(input: IdentityManifestContent): IdentityManifestContent {
  return canonical({
    authority_version: input.authority_version,
    source_kind: input.source_kind,
    source_ref: input.source_ref,
    freshness_until: input.freshness_until,
    identity_fields: input.identity_fields,
  }) as IdentityManifestContent;
}

/** The source registry stores this server-computed digest, never a caller claim. */
export function identityManifestContentDigest(input: IdentityManifestContent): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalIdentityManifestContent(input)), "utf8")
    .digest("hex")}`;
}

function blankField(field: PlatformIdentityField): CurrentIdentityField {
  return {
    field,
    status: "missing",
    identity_digest: null,
    authority_versions: [],
    mappings: [],
    invalid_mapping_count: 0,
    history_truncated: false,
  };
}

export function emptyIdentitySnapshot(findingId: string, projectId: string): CurrentIdentitySnapshot {
  const fields = Object.fromEntries(PLATFORM_IDENTITY_FIELDS.map((field) => [field, blankField(field)])) as Record<
    PlatformIdentityField,
    CurrentIdentityField
  >;
  const snapshot = {
    finding_id: findingId,
    project_id: projectId,
    fields,
    fingerprint: "",
    read_bounded: true,
    history_truncated: false,
  };
  snapshot.fingerprint = identitySnapshotDigest(snapshot);
  return snapshot;
}

/**
 * Compare only current, platform-trusted snapshots.  All six strong fields
 * must be present on both sides.  A root-cause match never erases an instance
 * difference: it selects the second strong relation kind instead.
 */
export function compareAuthoritativeIdentity(
  left: CurrentIdentitySnapshot,
  right: CurrentIdentitySnapshot,
): StrongRelationDecision {
  const base = {
    matched_fields: [] as PlatformIdentityField[],
    different_fields: [] as PlatformIdentityField[],
    conflicts: [] as PlatformIdentityField[],
    missing_fields: [] as PlatformIdentityField[],
    root_cause_continuation: false,
    rule_version: STRONG_RELATION_RULE_VERSION,
  };
  if (left.project_id !== right.project_id) {
    return { ...base, kind: "insufficient_information", reason: "project_scope_mismatch" };
  }
  if (left.read_bounded === false || right.read_bounded === false
    || left.history_truncated === true || right.history_truncated === true) {
    return { ...base, kind: "insufficient_information", reason: "identity_source_invalid" };
  }

  for (const field of PLATFORM_IDENTITY_FIELDS) {
    const a = left.fields[field];
    const b = right.fields[field];
    if (a.status === "conflict" || b.status === "conflict") {
      base.conflicts.push(field);
      continue;
    }
    if (a.status !== "valid" || b.status !== "valid") {
      base.missing_fields.push(field);
      continue;
    }
    if (field === "root_cause" && (
      a.authority_versions.length !== 1
      || b.authority_versions.length !== 1
      || a.authority_versions[0] !== b.authority_versions[0]
    )) {
      base.conflicts.push(field);
      continue;
    }
    if (a.identity_digest === b.identity_digest) base.matched_fields.push(field);
    else base.different_fields.push(field);
  }

  if (base.conflicts.length > 0) {
    const rootConflict = base.conflicts.includes("root_cause");
    return {
      ...base,
      kind: "insufficient_information",
      reason: rootConflict ? "root_cause_continuity_unknown" : "identity_conflict",
    };
  }

  const missingStrong = STRONG_IDENTITY_FIELDS.filter((field) =>
    !base.matched_fields.includes(field) && !base.different_fields.includes(field),
  );
  if (missingStrong.length > 0) {
    return {
      ...base,
      missing_fields: [...new Set([...base.missing_fields, ...missingStrong])],
      kind: "insufficient_information",
      reason: base.missing_fields.length > 0 ? "identity_source_invalid" : "identity_missing",
    };
  }

  const contextConflict = CONTEXT_IDENTITY_FIELDS.some((field) => base.different_fields.includes(field));
  if (contextConflict) {
    return { ...base, kind: "distinct", reason: "identity_conflict" };
  }

  const rootCauseSame = base.matched_fields.includes("root_cause");
  if (!rootCauseSame) return { ...base, kind: "distinct", reason: "identity_conflict" };
  const instanceDifference = STRONG_IDENTITY_FIELDS.some((field) => field !== "root_cause" && base.different_fields.includes(field));
  if (instanceDifference) {
    return {
      ...base,
      kind: "same_root_cause_different_instance",
      root_cause_continuation: true,
      reason: "root_cause_continuation",
    };
  }
  return { ...base, kind: "same_problem", reason: "same_authoritative_identity" };
}
