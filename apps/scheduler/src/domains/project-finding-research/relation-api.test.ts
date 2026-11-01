import assert from "node:assert/strict";
import test from "node:test";
import { requiredScopeForRoute } from "../../auth.js";
import { buildOpenApiDocument } from "../../openapi.js";
import { StrongRelationStoreError } from "./relation-errors.js";
import { readCanvasStrongRelations, readStrongRelationPage } from "./relation-read.js";
import {
  CanvasRelationsQuery, FindingRelationsQuery, IdentityMappingBody, IdentityMappingRemapBody,
  IdentitySourceBody, IdentitySourceRevisionBody, IdentitySourceRevokeBody, relationJsonSchema,
} from "./relation-schemas.js";
import { FINDING_RELATION_OPERATIONS } from "./relation-openapi.js";

const id = "11111111-1111-4111-8111-111111111111";
const source = {
  authority_version: "inventory/v1", source_kind: "platform_inventory",
  source_ref: "attestation://fixture/asset", freshness_until: "2099-01-01T00:00:00.000Z",
  identity_fields: { asset: `sha256:${"a".repeat(64)}` },
};

test("source request schemas reject caller provenance and non-digest or unknown identity fields", () => {
  assert.equal(IdentitySourceBody.safeParse(source).success, true);
  for (const extra of [{ registered_by: id }, { actor: { scopes: ["admin"] } }, { content_sha256: "caller" }, { provenance_json: {} }]) {
    assert.equal(IdentitySourceBody.safeParse({ ...source, ...extra }).success, false);
  }
  for (const fields of [{}, { asset: "raw asset" }, { arbitrary: source.identity_fields.asset }]) {
    assert.equal(IdentitySourceBody.safeParse({ ...source, identity_fields: fields }).success, false);
  }
  for (const patch of [{ source_ref: "a\nb" }, { source_ref: " " }, { source_kind: "external_verified" }, { freshness_until: "tomorrow" }]) {
    assert.equal(IdentitySourceBody.safeParse({ ...source, ...patch }).success, false);
  }
  assert.equal(IdentitySourceRevisionBody.safeParse({ ...source, expected_source_revision: 1 }).success, true);
  assert.equal(IdentitySourceRevisionBody.safeParse({ ...source, expected_source_revision: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(IdentitySourceRevokeBody.safeParse({ expected_source_revision: 1, reason: "withdrawn" }).success, true);
  assert.equal(IdentitySourceRevokeBody.safeParse({ expected_source_revision: 0, reason: " " }).success, false);
  const json = relationJsonSchema(IdentitySourceBody) as { properties: { identity_fields: { minProperties: number } }; additionalProperties: boolean };
  assert.equal(json.additionalProperties, false);
  assert.equal(json.properties.identity_fields.minProperties, 1);
});

test("mapping writes select only an admitted source and explicit CAS; public queries cannot reveal suppressed results", () => {
  const mapping = { source_id: id, field: "asset", expected_mapping_version: null };
  assert.equal(IdentityMappingBody.safeParse(mapping).success, true);
  for (const extra of [{ identity_digest: source.identity_fields.asset }, { source_kind: "platform_inventory" }, { source_ref: "caller" }, { source_revision: 1 }, { source_digest: "caller" }]) {
    assert.equal(IdentityMappingBody.safeParse({ ...mapping, ...extra }).success, false);
  }
  assert.equal(IdentityMappingBody.safeParse({ ...mapping, expected_mapping_version: 1 }).success, false);
  assert.equal(IdentityMappingRemapBody.safeParse({ ...mapping, expected_mapping_version: 1, reason: "new source" }).success, true);
  assert.equal(IdentityMappingRemapBody.safeParse({ ...mapping, reason: "new source" }).success, false);
  for (const query of [{ includeSuppressed: "true" }, { include_suppressed: "true" }, { project_id: id }]) {
    assert.equal(FindingRelationsQuery.safeParse(query).success, false);
    assert.equal(CanvasRelationsQuery.safeParse(query).success, false);
  }
});

test("malformed UUIDs in reader IDs and cursor contents fail before any SQL or transaction", async () => {
  const db = { begin: () => { assert.fail("invalid input reached SQL"); } } as never;
  const invalid = "-".repeat(36);
  const hasCode = (code: string) => (error: unknown) => error instanceof StrongRelationStoreError && error.code === code;
  await assert.rejects(readStrongRelationPage(invalid, undefined, db), hasCode("INVALID_ID"));
  await assert.rejects(readCanvasStrongRelations(invalid, db), hasCode("INVALID_ID"));
  const cursor = { v: 1, kind: "finding_strong_relations", project: id, subject: id, after: id, binding: "a".repeat(64) };
  for (const key of ["project", "subject", "after"]) {
    const encoded = Buffer.from(JSON.stringify({ ...cursor, [key]: invalid })).toString("base64url");
    await assert.rejects(readStrongRelationPage(id, encoded, db), hasCode("INVALID_CURSOR"));
  }
  for (const value of ["%%", [], Buffer.from("{}").toString("base64url")]) {
    await assert.rejects(readStrongRelationPage(id, value, db), hasCode("INVALID_CURSOR"));
  }
});

test("all eight Management operations publish the enforced scope, actual strict requests and closed-gate responses", () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
  assert.equal(FINDING_RELATION_OPERATIONS.length, 8);
  for (const op of FINDING_RELATION_OPERATIONS) {
    const route = op.path.replace(/\{(\w+)\}/gu, ":$1");
    const operation = doc.paths[op.path][op.method];
    assert.equal(operation["x-deepsonar-scope"], op.method === "get" ? "findings:read" : "admin");
    assert.equal(requiredScopeForRoute(op.method.toUpperCase(), route), operation["x-deepsonar-scope"]);
    assert.equal(typeof operation.operationId, "string");
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    assert.ok(operation.responses[op.successStatus ?? "200"].content["application/json"].schema);
    for (const status of ["400", "401", "403", "404", "409"]) assert.ok(operation.responses[status]);
    if (op.body) assert.deepEqual(operation.requestBody.content["application/json"].schema, op.body);
    assert.ok(operation.parameters.every((param: any) => param.in !== "path" || param.schema.format === "uuid"));
  }
  for (const name of ["FindingRelations", "CanvasFindingRelations"]) {
    const schema = doc.components.schemas[name];
    assert.deepEqual(schema.properties.published.enum, [false]);
    assert.deepEqual(schema.properties.quality_gate_status.enum, ["not_evaluated"]);
    assert.deepEqual(schema.properties.authority_basis.enum, ["platform_admin_attestation"]);
    assert.deepEqual(schema.properties.independent_external_verification.enum, [false]);
    assert.equal(schema.properties.items.maxItems, 0);
  }
});
