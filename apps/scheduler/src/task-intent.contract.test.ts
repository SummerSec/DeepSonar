import assert from "node:assert/strict";
import test from "node:test";
import { requiredScopeForRoute } from "./auth.js";
import { buildOpenApiDocument } from "./openapi.js";

test("PATCH /tasks/:canvasId requires tasks:write and documents snapshot semantics", () => {
  assert.equal(requiredScopeForRoute("PATCH", "/tasks/:canvasId"), "tasks:write");

  const document = buildOpenApiDocument() as {
    paths: Record<string, {
      patch?: {
        "x-deepsonar-scope": string;
        description?: string;
        responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }>;
      };
    }>;
  };
  const operation = document.paths["/tasks/{canvasId}"]?.patch;
  assert.ok(operation, "PATCH /tasks/{canvasId} must be present");
  assert.equal(operation["x-deepsonar-scope"], "tasks:write");
  assert.match(String(operation.description), /不改写已在跑或已结束 Job 的 agent_snapshot_json/);
  const schema = operation.responses["200"].content["application/json"].schema as {
    required: string[];
    properties: { snapshot_rewritten: { enum: boolean[] } };
  };
  assert.ok(schema.required.includes("snapshot_rewritten"));
  assert.deepEqual(schema.properties.snapshot_rewritten.enum, [false]);
});
