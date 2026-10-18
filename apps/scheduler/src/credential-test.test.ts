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
    // #491: 没有可用的推理模型时只有目录证据，目录 401 不能定性为认证失败。
    assert.equal(failure.category, "unknown");
    assert.match(failure.detail, /模型目录不可用/);
    assert.equal(failure.probe_path, "models");
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
    assert.equal(result.detail, "Provider 模型目录不可用（HTTP 405）；该路径失败不代表推理调用不可用");
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

test("inference probe is authoritative while catalog-only failures stay unknown", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  // Provider 声明模型走 settingsConfig；base_url 仍由 metadata 提供。
  const credential = (provider: string, metadata: Record<string, unknown> = { base_url: "http://127.0.0.1" }) => ({
    provider,
    kind: "llm_provider",
    ...encrypted,
    public_metadata_json: metadata,
    settings_config_json: { models: { "probe-model": {} } },
  });
  const statusQueue = (statuses: number[]) => (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ ok: true }), { status: statuses.shift() ?? 200 });
  }) as typeof fetch;
  try {
    globalThis.fetch = statusQueue([200]);
    const accepted = await testCredential(credential("openai") as never);
    assert.deepEqual(calls.map((call) => [call.url, call.method]), [
      ["http://127.0.0.1/v1/responses", "POST"],
    ]);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.probe_path, "inference");
    assert.equal(accepted.source_url, "http://127.0.0.1/v1/responses");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      model: "probe-model",
      max_output_tokens: 8,
      input: "ping",
    });
    assert.match(accepted.detail, /openai-responses/);

    // 400 只说明 ping 的模型/参数被拒，认证本身已通过（与 vendor PoC 同口径）。
    calls.length = 0;
    globalThis.fetch = statusQueue([400]);
    const rejectedModel = await testCredential(credential("openai") as never);
    assert.equal(rejectedModel.ok, true);
    assert.match(rejectedModel.detail, /推理调用已被 Provider 接受（openai-responses，HTTP 400）/);

    // 推理路径 401 才是权威的认证失败。
    calls.length = 0;
    globalThis.fetch = statusQueue([401]);
    const unauthorized = await testCredential(credential("openai") as never);
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.category, "authentication");
    assert.equal(unauthorized.probe_path, "inference");

    // #491 现场：只实现 completions 的中转 —— 推理路径 404/405，目录路径 401。
    calls.length = 0;
    globalThis.fetch = statusQueue([404, 401]);
    const issueCase = await testCredential(credential("openai") as never);
    assert.deepEqual(calls.map((call) => call.url), [
      "http://127.0.0.1/v1/responses",
      "http://127.0.0.1/v1/models",
    ]);
    assert.equal(issueCase.ok, false);
    assert.equal(issueCase.category, "unknown");
    assert.equal(issueCase.probe_path, "models");
    assert.match(issueCase.detail, /模型目录不可用（HTTP 401）.*不代表推理调用不可用/);

    // 推理路径不存在但目录可达：认证已通过，仍然算可用。
    calls.length = 0;
    globalThis.fetch = statusQueue([404, 200]);
    const catalogOnly = await testCredential(credential("openai") as never);
    assert.equal(catalogOnly.ok, true);
    assert.equal(catalogOnly.probe_path, "models");
    assert.match(catalogOnly.detail, /推理路径未实现（HTTP 404）/);

    // Anthropic 走 /v1/messages（与 vendor PoC 同一路径选择）。
    calls.length = 0;
    globalThis.fetch = statusQueue([200]);
    await testCredential(credential("anthropic", { base_url: "https://api.anthropic.com" }) as never);
    assert.deepEqual(calls.map((call) => call.url), ["https://api.anthropic.com/v1/messages"]);
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

test("#624 openai-responses settings probe /v1/responses without doubling /v1", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        body: init?.body,
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const result = await testCredential({
      provider: "anthropic",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://relay.example/v1/" },
      settings_config_json: {
        providers: {
          deepsonar: {
            baseUrl: "https://relay.example/v1/",
            api: "openai-responses",
            models: { "deepseek-v4-pro": {} },
          },
        },
      },
    });
    assert.deepEqual(calls.map((call) => call.url), ["https://relay.example/v1/responses"]);
    assert.equal(calls[0].headers.get("authorization"), "Bearer super-secret");
    assert.equal(calls[0].headers.get("x-api-key"), null);
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      model: "deepseek-v4-pro",
      max_output_tokens: 8,
      input: "ping",
    });
    assert.equal(result.ok, true);
    assert.equal(result.probe_path, "inference");
    assert.equal(result.source_url, "https://relay.example/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#624 openai-completions and anthropic-messages still probe legacy paths", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
      settings_config_json: {
        providers: { deepsonar: { api: "openai-completions", models: { "gpt-probe": {} } } },
      },
    });
    assert.deepEqual(urls, ["http://127.0.0.1/v1/chat/completions"]);

    urls.length = 0;
    await testCredential({
      provider: "anthropic",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://api.anthropic.com" },
      settings_config_json: {
        providers: { deepsonar: { api: "anthropic-messages", models: { "claude-probe": {} } } },
      },
    });
    assert.deepEqual(urls, ["https://api.anthropic.com/v1/messages"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#624 distinguishes unsupported protocol, auth failure, and inference timeout", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    const unsupported = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
      settings_config_json: {
        providers: { deepsonar: { api: "grpc-weird", models: { "probe-model": {} } } },
      },
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.category, "configuration");
    assert.match(unsupported.detail, /不支持的推理协议：grpc-weird/);

    globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const unauthorized = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
      settings_config_json: {
        providers: { deepsonar: { api: "openai-responses", models: { "probe-model": {} } } },
      },
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.category, "authentication");
    assert.equal(unauthorized.probe_path, "inference");
    assert.match(unauthorized.detail, /openai-responses/);

    globalThis.fetch = (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as typeof fetch;
    const timedOut = await testCredential({
      provider: "openai",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "http://127.0.0.1/v1" },
      settings_config_json: {
        providers: { deepsonar: { api: "openai-responses", models: { "probe-model": {} } } },
      },
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.category, "timeout");
    assert.match(timedOut.detail, /openai-responses \/v1\/responses/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#736 anthropic-messages probe and catalog carry Claude CLI fingerprint headers", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { authHeadersForProtocol, listCredentialModels, testCredential } = await import("./credential-test.js");
  const { AGENT_CLI_RUNTIME_ADAPTERS } = await import("@deepsonar/runtime-sandbox");
  const expectedUa = `claude-cli/${AGENT_CLI_RUNTIME_ADAPTERS["claude-code"].version} (external, cli)`;

  const anthropic = authHeadersForProtocol("anthropic-messages", "sk-test");
  assert.match(anthropic["user-agent"] ?? "", /^claude-cli\//u);
  assert.equal(anthropic["user-agent"], expectedUa);
  assert.equal(anthropic["x-app"], "cli");
  // 指纹只用于 Anthropic Messages；OpenAI 协议不冒充 Claude CLI（#321 走 body input[0]）。
  for (const protocol of ["openai-completions", "openai-responses"] as const) {
    const headers = authHeadersForProtocol(protocol, "sk-test");
    assert.equal(headers["user-agent"], undefined);
    assert.equal(headers["x-app"], undefined);
  }

  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const seen: { url: string; headers: Headers }[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), headers });
      // 模拟 new-api 中转：UA 不以 claude-cli 开头时拒绝客户端。
      if (!(headers.get("user-agent") ?? "").startsWith("claude-cli")) {
        return new Response('{"error":{"message":"unauthorized client detected"}}', { status: 401 });
      }
      if (String(input).endsWith("/models")) {
        return Response.json({ data: [{ id: "claude-probe" }] });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const cred = {
      provider: "anthropic",
      kind: "llm_provider" as const,
      ...encrypted,
      public_metadata_json: { base_url: "https://relay.example.test" },
      settings_config_json: {
        providers: { deepsonar: { api: "anthropic-messages", models: { "claude-probe": {} } } },
      },
    };
    const probed = await testCredential(cred);
    assert.equal(probed.ok, true);
    assert.equal(probed.probe_path, "inference");

    const catalog = await listCredentialModels(cred);
    assert.equal(catalog.available, true);
    assert.deepEqual(catalog.models, ["claude-probe"]);

    assert.ok(seen.length >= 2);
    for (const request of seen) {
      assert.equal(request.headers.get("user-agent"), expectedUa, request.url);
      assert.equal(request.headers.get("x-app"), "cli", request.url);
      assert.equal(request.headers.get("anthropic-version"), "2023-06-01", request.url);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#736 inference 401 unauthorized client is labelled as client-fingerprint rejection", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(
      '{"error":{"message":"unauthorized client detected","type":"new_api_error"}}',
      { status: 401 },
    )) as typeof fetch;
    const rejected = await testCredential({
      provider: "anthropic",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://relay.example.test" },
      settings_config_json: {
        providers: { deepsonar: { api: "anthropic-messages", models: { "claude-probe": {} } } },
      },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.category, "authentication");
    assert.match(rejected.detail, /unauthorized client/u);
    assert.match(rejected.detail, /#736/u);
    assert.doesNotMatch(rejected.detail, /new_api_error/u);

    globalThis.fetch = (async () => new Response("invalid api key", { status: 401 })) as typeof fetch;
    const invalid = await testCredential({
      provider: "anthropic",
      kind: "llm_provider",
      ...encrypted,
      public_metadata_json: { base_url: "https://relay.example.test" },
      settings_config_json: {
        providers: { deepsonar: { api: "anthropic-messages", models: { "claude-probe": {} } } },
      },
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.category, "authentication");
    assert.doesNotMatch(invalid.detail, /unauthorized client/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#748 inference 403/402 keep redacted upstream error and backfill the model catalog", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("sk-live-super-secret");
  const originalFetch = globalThis.fetch;
  const credential = (model: string) => ({
    provider: "anthropic",
    kind: "llm_provider" as const,
    ...encrypted,
    public_metadata_json: { base_url: "https://relay.example.test" },
    settings_config_json: {
      providers: { deepsonar: { api: "anthropic-messages", models: { [model]: {} } } },
    },
  });
  const urls: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "model-c" }, { id: "model-b" }] });
      const model = String(JSON.parse(String(init?.body)).model);
      if (model === "model-a") {
        return new Response(JSON.stringify({
          error: {
            message: "该令牌无权访问模型 model-a (request id: 2026101815) key=sk-live-super-secret\nnext",
            type: "new_api_error",
          },
        }), { status: 403 });
      }
      return new Response(JSON.stringify({
        error: { message: "Budget pool quota has been exhausted", type: "bad_response_status_code" },
      }), { status: 402 });
    }) as typeof fetch;

    const forbidden = await testCredential(credential("model-a"));
    assert.deepEqual(urls, ["https://relay.example.test/v1/messages", "https://relay.example.test/v1/models"]);
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.category, "model_unavailable");
    assert.equal(forbidden.probe_path, "inference");
    assert.equal(forbidden.upstream_error?.type, "new_api_error");
    assert.match(forbidden.upstream_error?.message ?? "", /无权访问模型 model-a/u);
    assert.match(forbidden.detail, /HTTP 403/u);
    assert.match(forbidden.detail, /上游 new_api_error：该令牌无权访问模型 model-a/u);
    assert.match(forbidden.detail, /当前模型 model-a 不可用，可用：model-b、model-c/u);
    assert.deepEqual(forbidden.model_catalog, ["model-b", "model-c"]);
    assert.equal(forbidden.model_catalog_source_url, "https://relay.example.test/v1/models");
    assert.ok(forbidden.model_catalog_fetched_at);
    assert.equal(JSON.stringify(forbidden).includes("super-secret"), false);
    assert.doesNotMatch(forbidden.detail, /[\u0000-\u001f]/u);
    assert.ok(forbidden.detail.length <= 300);

    urls.length = 0;
    const quota = await testCredential(credential("model-b"));
    assert.equal(urls.length, 2);
    assert.equal(quota.ok, false);
    assert.equal(quota.category, "quota_exhausted");
    assert.equal(quota.upstream_error?.type, "bad_response_status_code");
    assert.match(quota.detail, /quota_exhausted，HTTP 402/u);
    assert.match(quota.detail, /Budget pool quota has been exhausted/u);
    assert.match(quota.detail, /当前模型 model-b 在可用目录中（共 2 个）/u);
    assert.deepEqual(quota.model_catalog, ["model-b", "model-c"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#748 non model-level failures skip catalog discovery but still surface upstream text", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("super-secret");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const cred = {
    provider: "openai",
    kind: "llm_provider" as const,
    ...encrypted,
    public_metadata_json: { base_url: "http://127.0.0.1/v1" },
    settings_config_json: { providers: { deepsonar: { api: "openai-completions", models: { "gpt-probe": {} } } } },
  };
  try {
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        error: { message: "Incorrect API key provided: Bearer super-secret see https://x.test/a?token=abc", code: "invalid_api_key" },
      }), { status: 401 });
    }) as typeof fetch;
    const invalid = await testCredential(cred);
    assert.deepEqual(urls, ["http://127.0.0.1/v1/chat/completions"]);
    assert.equal(invalid.category, "authentication");
    assert.equal(invalid.upstream_error?.type, "invalid_api_key");
    assert.match(invalid.detail, /上游 invalid_api_key：Incorrect API key provided/u);
    assert.equal(invalid.detail.includes("super-secret"), false);
    assert.equal(invalid.detail.includes("token=abc"), false);
    assert.equal(invalid.model_catalog, undefined);

    // OpenAI 风格 429 insufficient_quota 也是额度耗尽，同样补做目录发现。
    urls.length = 0;
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      if (String(input).endsWith("/models")) return new Response("nope", { status: 401 });
      return new Response(JSON.stringify({
        error: { message: "You exceeded your current quota", type: "insufficient_quota" },
      }), { status: 429 });
    }) as typeof fetch;
    const quota = await testCredential(cred);
    assert.deepEqual(urls, ["http://127.0.0.1/v1/chat/completions", "http://127.0.0.1/v1/models"]);
    assert.equal(quota.category, "quota_exhausted");
    assert.match(quota.detail, /模型目录发现失败（unknown）/u);
    assert.equal(quota.model_catalog, undefined);

    urls.length = 0;
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), { status: 429 });
    }) as typeof fetch;
    const limited = await testCredential(cred);
    assert.equal(urls.length, 1);
    assert.equal(limited.category, "rate_limited");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#748 upstream error summary handles truncated JSON, plain text and HTML bodies", async () => {
  const { summarizeUpstreamError } = await import("./credential-test.js");
  assert.equal(summarizeUpstreamError(""), undefined);
  assert.equal(summarizeUpstreamError("<html><body>403 Forbidden</body></html>"), undefined);
  assert.deepEqual(summarizeUpstreamError("invalid api key"), { message: "invalid api key" });
  assert.deepEqual(
    summarizeUpstreamError(`{"error":{"type":"permission_error","message":"model not allowed ${"x".repeat(5000)}`),
    { type: "permission_error", message: `model not allowed ${"x".repeat(101)}…` },
  );
  assert.deepEqual(summarizeUpstreamError('{"error":"forbidden for my-secret-key","type":"oops"}', ["my-secret-key"]), {
    type: "oops",
    message: "forbidden for [REDACTED]",
  });
  // 非标识符形态的 type 不回显。
  assert.deepEqual(summarizeUpstreamError('{"error":{"type":"has space","message":"m"}}'), { message: "m" });
});

test("#748 upstream summaries redact native and text-config secrets, including a truncated secret prefix", async () => {
  const { encryptSecret } = await import("./credentials.js");
  const { testCredential } = await import("./credential-test.js");
  const encrypted = encryptSecret("primary-probe-secret");
  const nativeSecret = "ordinary-token-without-provider-prefix";
  const yamlSecret = "yaml-config-token";
  const tomlSecret = "toml-config-token";
  const boundarySecret = `boundary-secret-${"x".repeat(4200)}`;
  const originalFetch = globalThis.fetch;
  try {
    for (const message of [
      `model unavailable ${nativeSecret} ${yamlSecret} ${tomlSecret} https://alice:${yamlSecret}@relay.example.test/path?token=${nativeSecret}`,
      `model unavailable ${boundarySecret}`,
    ]) {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        error: {
          type: `provider-${nativeSecret}`,
          message,
        },
      }), { status: 401 })) as typeof fetch;
      const result = await testCredential({
        provider: "openai",
        kind: "llm_provider",
        ...encrypted,
        public_metadata_json: { base_url: "http://127.0.0.1/v1" },
        settings_config_json: {
          models: { "probe-model": {} },
          env: { API_TOKEN: nativeSecret },
          config: `apiKey: ${yamlSecret}\ntoken = "${tomlSecret}"\nsecret: ${boundarySecret}\n`,
        },
      });
      const serialized = JSON.stringify(result);
      for (const secret of [nativeSecret, yamlSecret, tomlSecret, boundarySecret.slice(0, 24)]) {
        assert.equal(serialized.includes(secret), false, `summary leaked ${secret.slice(0, 12)}`);
      }
      assert.equal(serialized.includes("alice:"), false);
      assert.equal(serialized.includes("?token="), false);
      assert.match(result.detail, /model unavailable/u);
      assert.equal(result.upstream_error?.type, undefined);
      }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("#748 upstream summaries clean C0, C1 and DEL controls", async () => {
  const { summarizeUpstreamError } = await import("./credential-test.js");
  const result = summarizeUpstreamError(JSON.stringify({
    error: { message: "model denied\u0001\u0085\u009f\u007f" },
  }));
  assert.ok(result);
  assert.match(result?.message ?? "", /model denied/u);
  assert.doesNotMatch(result?.message ?? "", /[\u0000-\u001f\u007f-\u009f]/u);
});
