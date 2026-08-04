import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

test("connection success/failure returns fixed health category and safe URL", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      assert.equal(String(input), "https://provider.example/v1/models");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    const success = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://provider.example/v1///" },
    });
    assert.equal(success.ok, true);
    assert.equal(success.source_url, "https://provider.example/v1/models");
    globalThis.fetch = (async () => new Response("Bearer super-secret", { status: 401 })) as typeof fetch;
    const failure = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://provider.example/v1" },
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.category, "authentication");
    assert.equal(failure.detail.includes("super-secret"), false);
    assert.equal(JSON.stringify(failure).includes("Bearer"), false);
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
      public_metadata_json: { base_url: "https://provider.example/v1" },
    });
    assert.deepEqual(result.models, ["a", "z"]);
    assert.equal(result.source_url.includes("?"), false);
    globalThis.fetch = (async () => new Response("secret upstream body", { status: 500 })) as typeof fetch;
    await assert.rejects(
      listCredentialModels({
        provider: "openai",
        kind: "llm_provider",
        ...encrypted,
        public_metadata_json: { base_url: "https://provider.example/v1" },
      }),
      (error: unknown) => {
        assert.equal((error as { category?: string }).category, "upstream");
        assert.equal(String((error as Error).message).includes("secret upstream body"), false);
        return true;
      },
    );
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
    public_metadata_json: { base_url: "https://provider.example/v1" },
  };
  try {
    globalThis.fetch = (async () => new Response(`body-secret-${"x".repeat(64)}`, {
      status: 200,
      headers: { "content-length": String(CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES + 1) },
    })) as typeof fetch;
    await assert.rejects(listCredentialModels(credential), (error: unknown) => {
      assert.equal((error as { category?: string }).category, "invalid_response");
      assert.equal(String((error as Error).message).includes("body-secret"), false);
      return true;
    });

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
    await assert.rejects(listCredentialModels(credential), (error: unknown) => {
      assert.equal((error as { category?: string }).category, "invalid_response");
      assert.equal(String((error as Error).message).includes("body-secret"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
