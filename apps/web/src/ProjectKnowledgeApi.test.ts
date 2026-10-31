import assert from "node:assert/strict";
import test from "node:test";
import { projectKnowledgeApi } from "./ProjectKnowledgeApi";

test("knowledge management requests keep exact project/version scope and surface server error codes", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const calls: Array<{ path: string; method: string; body?: string; authorization?: string }> = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "deepsonar_api_token" ? "fixture-token" : null,
  } });
  globalThis.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined,
      authorization: headers.Authorization });
    if (calls.length === 2) return new Response(JSON.stringify({ error_code: "KNOWLEDGE_GRANT_DENIED" }), { status: 409 });
    return new Response(JSON.stringify({ id: "grant" }), { status: 201 });
  }) as typeof fetch;
  try {
    await projectKnowledgeApi.grant("owner", "item", "version", "grantee");
    assert.deepEqual(calls[0], {
      path: "/api/projects/owner/knowledge/item/versions/version/grants",
      method: "POST", body: '{"grantee_project_id":"grantee"}', authorization: "Bearer fixture-token",
    });
    await assert.rejects(projectKnowledgeApi.revokeVersion("owner", "item", "version", "reason"),
      /KNOWLEDGE_GRANT_DENIED/);
    assert.equal(calls[1]?.path, "/api/projects/owner/knowledge/item/versions/version/revoke");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
