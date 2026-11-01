import { z } from "zod";
import {
  IDENTITY_MAPPING_SOURCE_KINDS,
  PLATFORM_IDENTITY_FIELDS,
  STRONG_RELATION_QUALITY_GATE_STATUS,
  STRONG_RELATION_RULE_VERSION,
  STRONG_RELATIONS_PUBLISHED,
} from "./identity.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const reason = z.string().trim().min(1).max(512);
export const IdentityFieldsBody = z.object({
  asset: digest.optional(), service: digest.optional(), tenant: digest.optional(),
  environment: digest.optional(), version: digest.optional(), parameter: digest.optional(),
  permission_boundary: digest.optional(), root_cause: digest.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "identity_fields must not be empty");

export const IdentitySourceBody = z.object({
  authority_version: z.string().trim().min(1).max(128),
  source_kind: z.enum(IDENTITY_MAPPING_SOURCE_KINDS),
  source_ref: z.string().trim().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u),
  freshness_until: timestamp,
  identity_fields: IdentityFieldsBody,
}).strict();
export const IdentitySourceRevisionBody = IdentitySourceBody.extend({ expected_source_revision: revision });
export const IdentitySourceRevokeBody = z.object({ expected_source_revision: revision, reason }).strict();
const mappingFields = { field: z.enum(PLATFORM_IDENTITY_FIELDS), source_id: z.string().uuid() };
export const IdentityMappingBody = z.object({ ...mappingFields, expected_mapping_version: z.null() }).strict();
export const IdentityMappingRemapBody = z.object({ ...mappingFields, expected_mapping_version: revision, reason }).strict();
export const IdentityMappingRevokeBody = z.object({
  field: z.enum(PLATFORM_IDENTITY_FIELDS), expected_mapping_version: revision, reason,
}).strict();
export const FindingRelationsQuery = z.object({
  cursor: z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/u).optional(),
}).strict();
export const CanvasRelationsQuery = z.object({}).strict();

const authority = {
  authority_basis: z.literal("platform_admin_attestation"),
  independent_external_verification: z.literal(false),
};
export const IdentitySourceResponse = IdentitySourceBody.extend({
  ...authority,
  source_id: z.string().uuid(), project_id: z.string().uuid(), finding_id: z.string().uuid(),
  current_revision: revision, content_sha256: digest,
  revoked_at: timestamp.nullable(), revocation_reason: z.string().nullable(),
  registered_by: z.string(), created_at: timestamp, updated_at: timestamp,
});
export const IdentityMappingResponse = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), finding_id: z.string().uuid(),
  ...mappingFields,
  source_revision: revision, identity_digest: digest,
  authority_version: z.string(), source_kind: z.enum(IDENTITY_MAPPING_SOURCE_KINDS),
  source_ref: z.string(), source_digest: digest, mapping_version: revision,
  freshness_until: timestamp, revoked_at: timestamp.nullable(),
}).strict();
const count = z.number().int().nonnegative();
const readStatus = z.enum(["complete", "truncated", "blocked"]);
const publication = {
  ...authority,
  quality_gate_status: z.literal(STRONG_RELATION_QUALITY_GATE_STATUS),
  published: z.literal(STRONG_RELATIONS_PUBLISHED),
};
const relationItem = z.object({
  relation_id: digest, finding_id: z.string().uuid(),
  kind: z.enum(["same_problem", "same_root_cause_different_instance"]),
  matched_fields: z.array(z.enum(PLATFORM_IDENTITY_FIELDS)),
  different_fields: z.array(z.enum(PLATFORM_IDENTITY_FIELDS)),
  root_cause_continuation: z.boolean(), processed_at: timestamp,
}).strict();
export const FindingRelationsResponse = z.object({
  ...publication,
  subject_id: z.string().uuid(), project_id: z.string().uuid(),
  status: z.enum(["pending", "running", "succeeded", "failed", "stale"]),
  rebuilding: z.boolean(), active_generation: z.string().uuid().nullable(),
  rule_version: z.literal(STRONG_RELATION_RULE_VERSION),
  identity_status: z.enum(["authoritative", "insufficient_information"]),
  query_plane: z.literal("current"), processed_at: timestamp.nullable(),
  error_code: z.string().nullable(), attempts: count, examined: count,
  pair_truncated: z.boolean().nullable(), read_status: readStatus, read_reason: z.string().nullable(),
  next_cursor: z.string().nullable(), stale_results_omitted: z.boolean(),
  items: z.array(relationItem).max(0),
}).strict();
export const CanvasRelationsResponse = z.object({
  ...publication,
  canvas_id: z.string().uuid(), project_id: z.string().uuid(),
  read_status: readStatus, read_reason: z.string().nullable(), truncated: z.boolean(), finding_count: count,
  query_budget: z.object({
    max_findings: count, max_relations: count, max_response_bytes: count,
    used_findings: count, used_relations: count, used_response_bytes: count,
  }).strict(),
  items: z.array(relationItem.extend({ subject_id: z.string().uuid() })).max(0),
}).strict();

/** The nonempty-object refinement has an equivalent JSON Schema constraint. */
export function relationJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "openapi-3.0", io: "input",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === IdentityFieldsBody) jsonSchema.minProperties = 1;
    },
  });
}
