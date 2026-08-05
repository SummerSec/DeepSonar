import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiDocument } from "./openapi.js";

test("report download OpenAPI advertises scopes, attachment headers, and binary MIME", () => {
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { [key: string]: any }>>;
  };
  const markdown = document.paths["/reports/{id}/markdown"].get;
  const sarif = document.paths["/reports/{id}/sarif"].get;
  const retry = document.paths["/canvases/{id}/report/retry"].post;
  const findingReport = document.paths["/findings/{id}/report"];
  assert.equal(markdown["x-deepsonar-scope"], "tasks:read | findings:read");
  assert.ok(markdown.responses["200"].content["text/markdown"]);
  assert.ok(markdown.responses["200"].headers["Content-Disposition"]);
  assert.equal(sarif["x-deepsonar-scope"], "tasks:read");
  assert.ok(sarif.responses["200"].content["application/sarif+json"]);
  assert.ok(sarif.responses["200"].headers["Content-Disposition"]);
  assert.equal(retry["x-deepsonar-scope"], "jobs:control");
  assert.equal(findingReport.get["x-deepsonar-scope"], "findings:read");
  assert.equal(findingReport.post["x-deepsonar-scope"], "jobs:control");
});

test("schema responses remain JSON schemas instead of being mistaken for response objects", () => {
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { [key: string]: any }>>;
  };
  const readiness = document.paths["/readiness"].get.responses["200"];
  assert.equal(readiness.content["application/json"].schema.$ref, "#/components/schemas/ReadinessResponse");
});
