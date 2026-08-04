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
