import type { Op } from "../../openapi.js";
import {
  CanvasRelationsResponse,
  FindingRelationsQuery,
  FindingRelationsResponse,
  IdentityMappingBody,
  IdentityMappingRemapBody,
  IdentityMappingResponse,
  IdentityMappingRevokeBody,
  IdentitySourceBody,
  IdentitySourceResponse,
  IdentitySourceRevisionBody,
  IdentitySourceRevokeBody,
  relationJsonSchema,
} from "./relation-schemas.js";

export const FINDING_RELATION_SCHEMAS = {
  FindingRelations: relationJsonSchema(FindingRelationsResponse),
  CanvasFindingRelations: relationJsonSchema(CanvasRelationsResponse),
  FindingIdentitySource: relationJsonSchema(IdentitySourceResponse),
  FindingIdentityMapping: relationJsonSchema(IdentityMappingResponse),
};
const ref = (name: keyof typeof FINDING_RELATION_SCHEMAS) => ({ $ref: `#/components/schemas/${name}` });
const errors = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const scopeDescription = "Management authentication and findings:read are required; project-scoped principals are limited to the owning project. "
  + "Only current derived state is read. authority_basis=platform_admin_attestation and independent_external_verification=false describe operator attestation, not authenticated external inventory. "
  + "The quality gate is not_evaluated, published=false, and items is empty. No query can expose suppressed relations. ";
const writeDescription = "Requires a server-authenticated admin principal and the Finding's project scope. Job capability tokens cannot access this Management API. "
  + "Authority is an audited platform admin attestation; no independent external inventory verification is performed. ";
const writeErrors = {
  "400": errors("INVALID_ID, INVALID_IDENTITY_SOURCE / INVALID_IDENTITY_MAPPING, invalid source metadata, IDENTITY_SOURCE_REVOKED / IDENTITY_SOURCE_STALE / IDENTITY_SOURCE_FIELD_MISSING. Unknown body fields are rejected."),
  "403": errors("Missing admin scope, PROJECT_MISMATCH / PROJECT_SCOPE_MISMATCH, or IDENTITY_SOURCE_FORBIDDEN / IDENTITY_MAPPING_FORBIDDEN."),
  "404": errors("FINDING_NOT_FOUND, IDENTITY_SOURCE_NOT_FOUND, or IDENTITY_MAPPING_NOT_FOUND. Sources must belong to this Finding and project."),
  "409": errors("IDENTITY_SOURCE_CAS_CONFLICT, IDENTITY_MAPPING_CAS_CONFLICT, IDENTITY_MAPPING_REMAP_REQUIRED, or IDENTITY_MAPPING_SOURCE_CONFLICT."),
  "500": errors("IDENTITY_SOURCE_WRITE_FAILED / IDENTITY_MAPPING_WRITE_FAILED or an internal storage failure."),
};
const finding = "/findings/{id}";
export const FINDING_RELATION_OPERATIONS: Op[] = [
  {
    method: "get", path: finding + "/relations", tags: ["Findings"], scope: "findings:read",
    summary: "Read current strong-relation derivation status for a Finding",
    description: scopeDescription + "The optional opaque cursor binds project, subject, generation, source and identity fingerprints. Refresh without a cursor after a 409. Unknown query fields are rejected.",
    query: relationJsonSchema(FindingRelationsQuery).properties as Record<string, unknown>,
    responses: {
      "200": {
        description: "Current bounded state; unpublished relations are omitted even after a successful derivation.",
        headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
        content: { "application/json": { schema: ref("FindingRelations") } },
      },
      "400": errors("INVALID_ID, INVALID_QUERY, or INVALID_CURSOR (including malformed UUIDs inside the cursor)."),
      "403": errors("Missing findings:read scope or PROJECT_MISMATCH."),
      "404": errors("FINDING_NOT_FOUND."),
      "409": errors("CURSOR_GAP or CURSOR_SCOPE_MISMATCH; restart from the first page."),
    },
  },
  {
    method: "get", path: "/canvases/{id}/finding-relations", tags: ["Findings"], scope: "findings:read",
    summary: "Read a bounded Canvas strong-relation projection",
    description: scopeDescription + "No query parameters are accepted. One repeatable-read snapshot shares limits across at most 500 Findings, 2,000 relations and 512 KiB of relation bytes. read_status and read_reason expose truncation or blocked identity history; this is not a complete project map.",
    responses: {
      "200": {
        description: "Bounded current projection with explicit budget and authority limits.",
        headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
        content: { "application/json": { schema: ref("CanvasFindingRelations") } },
      },
      "400": errors("INVALID_ID or INVALID_QUERY."),
      "403": errors("Missing findings:read scope or PROJECT_MISMATCH."),
      "404": errors("NOT_FOUND (Canvas)."),
    },
  },
  {
    method: "post", path: finding + "/identity-sources", tags: ["Findings"], scope: "admin",
    summary: "Register a typed identity source attestation", successStatus: "201",
    description: writeDescription + "The server computes the content digest and records the authenticated principal. source_kind is an operator assertion. Identity fields contain only known-field SHA-256 digests.",
    body: relationJsonSchema(IdentitySourceBody), responses: { "201": ref("FindingIdentitySource"), ...writeErrors },
  },
  {
    method: "post", path: finding + "/identity-sources/{sourceId}/revisions", tags: ["Findings"], scope: "admin",
    summary: "Append an identity source revision using CAS", successStatus: "201",
    description: writeDescription + "expected_source_revision must match. The revision invalidates mappings bound to the old source revision immediately on read.",
    body: relationJsonSchema(IdentitySourceRevisionBody), responses: { "201": ref("FindingIdentitySource"), ...writeErrors },
  },
  {
    method: "post", path: finding + "/identity-sources/{sourceId}/revoke", tags: ["Findings"], scope: "admin",
    summary: "Revoke an identity source using CAS",
    description: writeDescription + "Requires the current source revision. Repeated revocation at the same revision is idempotent. History is retained; current mappings and relations become invalid.",
    body: relationJsonSchema(IdentitySourceRevokeBody), responses: { "200": ref("FindingIdentitySource"), ...writeErrors },
  },
  {
    method: "post", path: finding + "/identity-mappings", tags: ["Findings"], scope: "admin",
    summary: "Register the first mapping to an admitted source", successStatus: "201",
    description: writeDescription + "expected_mapping_version must be null. The server resolves the current source revision, identity digest and metadata; caller-supplied digests or provenance are rejected.",
    body: relationJsonSchema(IdentityMappingBody), responses: { "201": ref("FindingIdentityMapping"), ...writeErrors },
  },
  {
    method: "post", path: finding + "/identity-mappings/remap", tags: ["Findings"], scope: "admin",
    summary: "Replace a mapping with an explicit CAS remap", successStatus: "201",
    description: writeDescription + "Requires the latest mapping version and a reason. Revokes the old mapping and appends a new mapping to a different source or source revision atomically.",
    body: relationJsonSchema(IdentityMappingRemapBody), responses: { "201": ref("FindingIdentityMapping"), ...writeErrors },
  },
  {
    method: "post", path: finding + "/identity-mappings/revoke", tags: ["Findings"], scope: "admin",
    summary: "Revoke the current mapping using CAS",
    description: writeDescription + "Requires the latest mapping version and a reason. Repeated revocation at the same version is idempotent and preserves history.",
    body: relationJsonSchema(IdentityMappingRevokeBody), responses: { "200": ref("FindingIdentityMapping"), ...writeErrors },
  },
];
