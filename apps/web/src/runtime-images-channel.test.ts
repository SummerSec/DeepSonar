import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  isSupportedRuntimeImageRegistryEnvelope,
  runtimeImageRegistryCatalog,
  type RuntimeImageRegistry,
  type RuntimeImageRegistryChannel,
} from "./api";

test("runtime registry export removes every Scheduler-owned response field", () => {
  const catalog = runtimeImageRegistryCatalog({
    schema: "deepsonar.registry/v2",
    schema_version: 2,
    images: [],
    source: { kind: "remote" },
    metadata: { fetched_at: "2026-08-05T00:00:00.000Z" },
    fallback: false,
    error: null,
    checked_at: "2026-08-05T00:00:00.000Z",
    selected_channel: "github",
  } satisfies RuntimeImageRegistry);

  assert.deepEqual(catalog, {
    schema: "deepsonar.registry/v2",
    schema_version: 2,
    images: [],
    source: { kind: "remote" },
  });
});

test("manual catalog envelope validation matches v1/v2 schema compatibility", () => {
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema: "deepsonar.registry/v1", images: [] }), true);
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema_version: 2, images: [] }), true);
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema: "deepsonar.registry/v2", schema_version: 2, images: [] }), true);
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema: "deepsonar.registry/v2", schema_version: 1, images: [] }), false);
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema: "deepsonar.registry/v3", schema_version: 2, images: [] }), false);
  assert.equal(isSupportedRuntimeImageRegistryEnvelope({ schema: "deepsonar.registry/v2", schema_version: 3, images: [] }), false);
});

test("runtime registry channel mutation uses the server-owned PATCH contract", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ selected_channel: "dockerhub", previous_channel: "github" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await api.setRuntimeImagesRegistryChannel("dockerhub");
    assert.deepEqual(result, { selected_channel: "dockerhub", previous_channel: "github" });
    assert.deepEqual(requests, [{
      url: "/api/runtime-images/registry/channel",
      method: "PATCH",
      body: JSON.stringify({ channel: "dockerhub" satisfies RuntimeImageRegistryChannel }),
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime registry channel API preserves a forbidden response for the UI", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "project-scoped actors may not modify the global runtime registry channel",
    error_code: "PROJECT_SCOPE_FORBIDDEN",
  }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

  try {
    await assert.rejects(
      () => api.setRuntimeImagesRegistryChannel("aliyun-acr"),
      /PATCH \/runtime-images\/registry\/channel -> 403: PROJECT_SCOPE_FORBIDDEN/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
