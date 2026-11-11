import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { providerCustomHeadersFromSettings } from "../apps/scheduler/src/provider-custom-headers.ts";
import { assertGatewayRequestModelAllowed, GatewayFrozenModelMismatchError } from "../apps/scheduler/src/domains/provider-adapter/gateway-guard.ts";

// Real locked coding-agent ModelRuntime/ModelRegistry execute their shipped composer
// and real pi-ai transport. The in-memory credential backend contains no real secrets.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repository, "agent-harness/pi-provider-runtime");
const packageRoot = join(fixture, "node_modules/@earendil-works/pi-coding-agent");
const provider = "deepseek"; // Its pinned built-in catalog uses OpenAI Chat completions.
const token = "synthetic-provider-composer-token";
const selectedHeaders = (headers: Record<string, unknown>) => Object.fromEntries(
  Object.entries(headers).filter(([key]) => key.startsWith("x-synthetic-")).sort(([a], [b]) => a.localeCompare(b)),
);

test("Pi 1.5.2 real composer retains built-ins and agrees with Gateway header layers", { timeout: 60000 }, async () => {
  const lock = JSON.parse(await readFile(join(fixture, "package-lock.json"), "utf8"));
  const locked = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
  assert.equal(locked.version, "1.5.2");
  assert.equal(locked.integrity, "sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==");
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "1.5.2");
  assert.equal(JSON.parse(await readFile(join(fixture, "node_modules/@earendil-works/pi-ai/package.json"), "utf8")).version, "1.5.2");
  const { ModelRuntime } = await import(pathToFileURL(join(packageRoot, "dist/core/model-runtime.js")).href);
  const { ModelRegistry } = await import(pathToFileURL(join(packageRoot, "dist/core/model-registry.js")).href);
  const directory = await mkdtemp(join(tmpdir(), "deepsonar-pi-composer-"));
  const captured: Array<{ model: string; headers: Record<string, unknown> }> = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      captured.push({ model: body.model, headers: selectedHeaders(request.headers) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const envelope = { id: "synthetic-composer", object: "chat.completion.chunk", created: 1, model: body.model };
      response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic reply" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { errors.push(error); response.writeHead(500).end("synthetic fixture assertion failed"); }
  });
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
    const baseline = new ModelRegistry(await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }));
    const builtins = baseline.getAll().filter((entry: any) => entry.provider === provider && entry.api === "openai-completions");
    assert.ok(builtins.length >= 2, "pinned built-in fixture needs two distinct models");
    const [first, other] = builtins;
    const customId = "synthetic-extra-model";
    const providerHeaders = { "x-synthetic-layer": "provider-value", "x-synthetic-provider": "provider-only" };
    const overrideHeaders = { "x-synthetic-layer": "override-value", "x-synthetic-override": "override-only" };
    const definitionHeaders = { "x-synthetic-layer": "definition-value", "x-synthetic-definition": "definition-only" };
    const overridesOnly = { baseUrl, apiKey: token, headers: providerHeaders, modelOverrides: { [first.id]: { headers: overrideHeaders } } };
    const withCustom = { ...overridesOnly, models: [
      { id: first.id, headers: definitionHeaders },
      { id: customId, api: "openai-completions", contextWindow: 32768, maxTokens: 512, headers: { "x-synthetic-custom": "custom-only" } },
    ] };
    const scenarios = [
      { name: "one-override", config: overridesOnly, selections: [first.id, other.id] },
      { name: "additional-custom", config: withCustom, selections: [first.id, other.id, customId] },
    ];
    for (const scenario of scenarios) {
      const settings = { providers: { [provider]: scenario.config } };
      const modelsPath = join(directory, scenario.name + ".json");
      await writeFile(modelsPath, JSON.stringify(settings));
      const registry = new ModelRegistry(await ModelRuntime.create({ credentials, modelsPath, refreshOnCreate: false, allowModelNetwork: false }));
      assert.equal(registry.getError(), undefined);
      for (const builtin of builtins) assert.ok(registry.find(provider, builtin.id), `custom configuration removed built-in ${builtin.id}`);
      for (const id of scenario.selections) {
        const model = registry.find(provider, id);
        assert.ok(model);
        assert.equal(model.baseUrl, baseUrl);
        const resolved = await registry.getApiKeyAndHeaders(model);
        assert.equal(resolved.ok, true, JSON.stringify(resolved));
        assert.equal(resolved.apiKey, token);
        const gateway = providerCustomHeadersFromSettings(settings, baseUrl, { purpose: "inference", provider, model: id });
        assert.deepEqual(gateway.rejected, []);
        assert.deepEqual(selectedHeaders(resolved.headers ?? {}), selectedHeaders(gateway.headers));
        const expected = { ...providerHeaders,
          ...(id === first.id ? overrideHeaders : {}),
          ...(scenario.name === "additional-custom" && id === first.id ? definitionHeaders : {}),
          ...(id === customId ? { "x-synthetic-custom": "custom-only" } : {}),
        };
        assert.deepEqual(selectedHeaders(gateway.headers), selectedHeaders(expected));
        const before = captured.length;
        // ModelRegistry owns auth/header composition and delegates to the actual
        // configured SDK; no hand-composed headers or SDK doubles enter this call.
        const result = await registry.streamSimple(model, { messages: [{ role: "user", content: "synthetic request", timestamp: 1 }] },
          { maxTokens: 64, maxRetries: 0, signal: AbortSignal.timeout(10000) }).result();
        assert.notEqual(result.stopReason, "error", result.errorMessage);
        assert.equal(captured.length, before + 1);
        assert.deepEqual(captured.at(-1), { model: id, headers: selectedHeaders(expected) });
        assert.equal(result.usage.totalTokens, 4);
      }
      const unknown = "synthetic-unregistered-and-unfrozen";
      assert.equal(registry.find(provider, unknown), undefined);
      // Header resolution is intentionally not model authorization. The actual
      // Gateway admission guard must still reject an unknown/non-frozen model.
      assert.deepEqual(providerCustomHeadersFromSettings(settings, baseUrl, { purpose: "inference", provider, model: unknown }).rejected, []);
      const snapshot = { provider_model: { provider: "openai", cli_model_id: first.id, upstream_model_id: first.id, passthrough: false } };
      assert.doesNotThrow(() => assertGatewayRequestModelAllowed({ requestModel: first.id, agentSnapshot: snapshot }));
      assert.throws(() => assertGatewayRequestModelAllowed({ requestModel: unknown, agentSnapshot: snapshot }), GatewayFrozenModelMismatchError);
      assert.throws(() => assertGatewayRequestModelAllowed({ requestModel: other.id, agentSnapshot: snapshot }), GatewayFrozenModelMismatchError);
      // Full HTTP/SQL zero-upstream rejection remains covered by
      // gateway-transparent.integration.test.ts: forbidden frozen models.
    }
    assert.equal(captured.length, 5);
    assert.deepEqual(errors, []);
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
