import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIdentityMappingAuthority,
  validateIdentityMappingInput,
} from "./relation-store.js";
import {
  assertIdentitySourceAuthority,
  sourceContentDigest,
  validateIdentitySourceInput,
} from "./identity-source-store.js";
import { StrongRelationStoreError } from "./relation-errors.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const source = {
  authority_version: "inventory/v1",
  source_kind: "platform_inventory" as const,
  source_ref: "inventory://asset/123",
  freshness_until: "2099-01-01T00:00:00.000Z",
  identity_fields: { asset: digest("a"), root_cause: digest("b") },
};

test("source manifests accept only known identity digest fields and compute a stable server digest", () => {
  const normalized = validateIdentitySourceInput(source);
  assert.deepEqual(normalized.identity_fields, source.identity_fields);
  assert.match(sourceContentDigest(normalized), /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => validateIdentitySourceInput({ ...source, source_ref: "inventory://operator-token-reference" }));
  assert.throws(
    () => validateIdentitySourceInput({ ...source, identity_fields: { asset: digest("a"), arbitrary: digest("x") } } as never),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "INVALID_IDENTITY_FIELD",
  );
  assert.throws(
    () => validateIdentitySourceInput({ ...source, identity_fields: {} }),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "IDENTITY_FIELDS_EMPTY",
  );
  assert.throws(
    () => validateIdentitySourceInput({ ...source, content_sha256: digest("caller") } as never),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "INVALID_IDENTITY_SOURCE",
  );
  assert.throws(
    () => validateIdentitySourceInput({ ...source, provenance_json: { secret: "caller" } } as never),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "INVALID_IDENTITY_SOURCE",
  );
});

test("mapping input contains only source id, field, and an explicit CAS version", () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(validateIdentityMappingInput({
    source_id: sourceId,
    field: "asset",
    expected_mapping_version: null,
  }), { source_id: sourceId, field: "asset", expected_mapping_version: null });
  assert.throws(
    () => validateIdentityMappingInput({
      source_id: sourceId,
      field: "asset",
      expected_mapping_version: null,
      identity_digest: digest("caller"),
    } as never),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "INVALID_IDENTITY_MAPPING",
  );
  assert.throws(
    () => validateIdentityMappingInput({ source_id: sourceId, field: "asset", expected_mapping_version: 1 }),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "INVALID_EXPECTED_MAPPING_VERSION",
  );
});

test("source and mapping mutations require a server-authenticated platform admin actor and project scope", () => {
  const actor = { type: "api_token", id: "admin-token", scopes: ["admin"] } as const;
  assert.doesNotThrow(() => assertIdentitySourceAuthority(actor, "project"));
  assert.doesNotThrow(() => assertIdentityMappingAuthority({ ...actor, projectId: "project" }, "project"));
  assert.throws(
    () => assertIdentitySourceAuthority({ type: "internal" }, "project"),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "IDENTITY_SOURCE_FORBIDDEN",
  );
  assert.throws(
    () => assertIdentityMappingAuthority({ ...actor, projectId: "other" }, "project"),
    (error: unknown) => error instanceof StrongRelationStoreError && error.code === "PROJECT_SCOPE_MISMATCH",
  );
});
