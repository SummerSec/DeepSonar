import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiDocument } from "./openapi.js";

test("canvas delta OpenAPI exposes a required since query parameter", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths as Record<string, Record<string, unknown>>)["/canvases/{id}/delta"]?.get as Record<string, unknown>;
  const parameters = operation.parameters as Array<Record<string, unknown>>;
  const since = parameters.find((parameter) => parameter.name === "since");
  assert.deepEqual(since, {
    name: "since",
    in: "query",
    required: true,
    schema: { type: "string", pattern: "^[0-9]+$" },
  });
  assert.equal(parameters.some((parameter) => parameter.name === "type"), false);
});

test("credential OpenAPI exposes safe metadata, health and impact/model APIs", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, unknown>>;
  assert.ok(paths["/credentials/{id}"]?.get);
  assert.ok(paths["/credentials/{id}/impact"]?.get);
  assert.ok(paths["/credentials/{id}/models"]?.get);
  assert.ok(paths["/credentials/{id}/compatibility"]?.get);
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, unknown>>;
  assert.equal(schemas.CredentialMetadata?.additionalProperties, false);
  assert.deepEqual(schemas.CredentialHealth?.properties && (schemas.CredentialHealth.properties as Record<string, unknown>).status, {
    type: "string",
    enum: ["unknown", "ok", "error"],
  });
});

test("credential batch and picker OpenAPI contracts are strict and typed", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, unknown>>;
  const providers = paths["/credentials/providers"]?.get as Record<string, any>;
  const bindable = paths["/role-configs/bindable"]?.get as Record<string, any>;
  assert.equal(providers.responses["200"].content["application/json"].schema.type, "array");
  assert.equal(bindable.responses["200"].content["application/json"].schema.type, "array");
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  assert.equal(schemas.ProviderAccountCatalogItem.additionalProperties, false);
  assert.equal(schemas.CredentialBatchBindingRequest.additionalProperties, false);
  assert.ok((schemas.CredentialBatchBindingRequest.required as string[]).includes("idempotency_key"));
  assert.equal(schemas.CredentialBatchBindingImpact.additionalProperties, false);
  assert.equal(schemas.CredentialBatchBindingError.additionalProperties, false);
  assert.equal(schemas.CredentialBatchBindingImpact.properties.role_configs.items.additionalProperties, false);
  for (const status of ["400", "403", "404", "409", "500"]) {
    assert.ok((paths["/credentials/batch-bind"]?.post as Record<string, any>).responses[status]);
  }
});

test("RoleConfig and role registry OpenAPI documents project-scope boundaries", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Record<string, Record<string, any>>;
  const schemas = (document.components as Record<string, unknown>).schemas as Record<string, Record<string, any>>;
  assert.ok(schemas.Error?.properties?.error_code);
  for (const [path, method] of [
    ["/role-configs/global/{roleId}", "put"],
    ["/agent-roles", "post"],
    ["/agent-roles/{id}", "patch"],
    ["/agent-roles/{id}", "delete"],
  ] as const) {
    assert.match(String(paths[path]?.[method]?.description), /PROJECT_SCOPE_FORBIDDEN/);
  }
  assert.match(String(paths["/role-configs/global"]?.get?.description), /Credential/);
  assert.match(String(paths["/role-configs/bindable"]?.get?.description), /跨项目绑定/);
});
