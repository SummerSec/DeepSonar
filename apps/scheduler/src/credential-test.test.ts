import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

test("connection success/failure returns fixed health category and safe URL", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    const successUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      successUrls.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const success = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1///" },
    });
    assert.deepEqual(successUrls, ["http://127.0.0.1/v1/models"]);
    assert.equal(success.ok, true);
    assert.equal(success.source_url, "http://127.0.0.1/v1/models");

    const failureUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      failureUrls.push(String(input));
      return new Response("Bearer super-secret", { status: 401 });
    }) as typeof fetch;
    const failure = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.deepEqual(failureUrls, ["http://127.0.0.1/v1/models"]);
    assert.equal(failure.ok, false);
    assert.equal(failure.category, "authentication");
    assert.equal(failure.detail.includes("super-secret"), false);
    assert.equal(JSON.stringify(failure).includes("Bearer"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status-only probes best-effort cancel successful and failed response bodies", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  const responseWithTrackedBody = (status: number) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("upstream body"));
    },
    cancel() {
      cancelled += 1;
    },
  }), { status });
  try {
    globalThis.fetch = (async () => responseWithTrackedBody(200)) as typeof fetch;
    await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    globalThis.fetch = (async () => responseWithTrackedBody(500)) as typeof fetch;
    await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.equal(cancelled, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection test falls back on 404/405 and reports the last missing candidate", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  let cancelled = 0;
  try {
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      const status = urls.length === 1 ? 404 : 405;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("secret upstream body"));
        },
        cancel() {
          cancelled += 1;
        },
      }), { status });
    }) as typeof fetch;
    const result = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v2" },
    });
    assert.deepEqual(urls, [
      "http://127.0.0.1/v2/models",
      "http://127.0.0.1/v2/v1/models",
    ]);
    assert.equal(cancelled, 2);
    assert.equal(result.ok, false);
    assert.equal(result.detail, "Provider 连接失败（unknown，HTTP 405）");
    assert.equal(result.source_url, "http://127.0.0.1/v2/v1/models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview discovery strips Anthropic compatibility suffix and de-duplicates candidates", async () => {
  const { listCredentialModelsPreview } = await import("./credential-test.js");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer super-secret");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "super-secret");
      if (String(input) === "http://127.0.0.1/models") {
        return new Response(JSON.stringify({ models: ["claude-sonnet"] }), { status: 200 });
      }
      return new Response("not found", { status: urls.length === 2 ? 405 : 404 });
    }) as typeof fetch;
    const result = await listCredentialModelsPreview({
      provider: "anthropic",
      kind: "llm_provider",
      public_metadata_json: { base_url: "http://127.0.0.1/api/anthropic/" },
    }, "super-secret");
    assert.deepEqual(urls, [
      "http://127.0.0.1/api/anthropic/v1/models",
      "http://127.0.0.1/v1/models",
      "http://127.0.0.1/models",
    ]);
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(result.available, true);
    assert.deepEqual(result.models, ["claude-sonnet"]);
    assert.equal(result.source_url, "http://127.0.0.1/models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saved discovery uses the ordinary model endpoint", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { listCredentialModels } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await listCredentialModels({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1" },
    });
    assert.deepEqual(urls, ["http://127.0.0.1/v1/models"]);
    assert.equal(result.available, true);
    assert.equal(result.source_url, "http://127.0.0.1/v1/models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model discovery returns bounded IDs and fixed error categories", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { listCredentialModels } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "z" }, { id: "a" }, { id: "a" }] }), { status: 200 })) as typeof fetch;
    const result = await listCredentialModels({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.deepEqual(result.models, ["a", "z"]);
    assert.equal(result.available, true);
    assert.equal(result.source_url?.includes("?"), false);
    globalThis.fetch = (async () => new Response("secret upstream body", { status: 500 })) as typeof fetch;
    const failed = await listCredentialModels({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.equal(failed.available, false);
    assert.deepEqual(failed.models, []);
    assert.equal(failed.fetched_at, null);
    assert.equal(failed.category, "upstream");
    assert.equal(String(failed.detail ?? "").includes("secret upstream body"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model discovery best-effort cancels a non-ok response body", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { listCredentialModels } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upstream body"));
      },
      cancel() {
        cancelled += 1;
      },
    }), { status: 503 })) as typeof fetch;
    const failed = await listCredentialModels({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.equal(failed.available, false);
    assert.deepEqual(failed.models, []);
    assert.equal(cancelled, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model discovery rejects oversized declared and streamed provider bodies", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES, listCredentialModels } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const credential = {
    provider: "openai",
    kind: "llm_provider",
    ...encrypted,
    public_metadata_json: { base_url: "http://127.0.0.1/v1" },
  };
  try {
    globalThis.fetch = (async () => new Response(`body-secret-${"x".repeat(64)}`, {
      status: 200,
      headers: { "content-length": String(CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES + 1) },
    })) as typeof fetch;
    const declared = await listCredentialModels(credential);
    assert.equal(declared.available, false);
    assert.deepEqual(declared.models, []);
    assert.equal(declared.fetched_at, null);
    assert.equal(declared.category, "invalid_response");
    assert.equal(String(declared.detail ?? "").includes("body-secret"), false);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body-secret-"));
        controller.enqueue(new Uint8Array(CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES));
        controller.close();
      },
    });
    globalThis.fetch = (async () => new Response(stream, {
      status: 200,
      headers: { "content-length": "1" },
    })) as typeof fetch;
    const streamed = await listCredentialModels(credential);
    assert.equal(streamed.available, false);
    assert.deepEqual(streamed.models, []);
    assert.equal(streamed.category, "invalid_response");
    assert.equal(String(streamed.detail ?? "").includes("body-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model discovery maps a header-then-stall AbortError to timeout", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { listCredentialModels } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const error = new Error("upstream stalled");
        error.name = "AbortError";
        controller.error(error);
      },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    const stalled = await listCredentialModels({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    });
    assert.equal(stalled.available, false);
    assert.deepEqual(stalled.models, []);
    assert.equal(stalled.fetched_at, null);
    assert.equal(stalled.category, "timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unreachable /models soft-degrades to an empty catalog", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { discoverModelCatalog, listCredentialModelsPreview } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8088"), { code: "ECONNREFUSED" });
    }) as typeof fetch;
    const refused = await discoverModelCatalog({
      provider: "anthropic",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1:8088" },
      settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    });
    assert.equal(refused.available, false);
    assert.deepEqual(refused.models, []);
    assert.equal(refused.fetched_at, null);
    assert.equal(refused.category, "network");

    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const missing = await listCredentialModelsPreview({
      provider: "anthropic",
      kind: "llm_provider",
      public_metadata_json: { base_url: "http://127.0.0.1:8088" },
    }, "super-secret");
    assert.equal(missing.available, false);
    assert.deepEqual(missing.models, []);
    assert.equal(missing.fetched_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
