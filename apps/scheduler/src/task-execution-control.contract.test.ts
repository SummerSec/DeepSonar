import assert from "node:assert/strict";
import test from "node:test";
import { requiredScopeForRoute } from "./auth.js";
import { buildOpenApiDocument } from "./openapi.js";

test("task execution control routes require jobs:control and publish their response contract", () => {
  assert.equal(requiredScopeForRoute("POST", "/tasks/:canvasId/pause"), "jobs:control");
  assert.equal(requiredScopeForRoute("POST", "/tasks/:canvasId/start"), "jobs:control");

  const document = buildOpenApiDocument() as {
    paths: Record<string, {
      post: {
        "x-deepsonar-scope": string;
        responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }>;
      };
    }>;
  };
  for (const path of ["/tasks/{canvasId}/pause", "/tasks/{canvasId}/start"]) {
    const operation = document.paths[path]?.post;
    assert.ok(operation, `${path} must be present`);
    assert.equal(operation["x-deepsonar-scope"], "jobs:control");
    const schema = operation.responses["200"].content["application/json"].schema as {
      required: string[];
      properties: { execution_state: { enum: string[] } };
    };
    assert.deepEqual(schema.required, [
      "canvas_id",
      "execution_state",
      "active_count",
      "pending_count",
      "changed",
    ]);
    assert.deepEqual(schema.properties.execution_state.enum, ["pausing", "paused", "running"]);
  }
});
