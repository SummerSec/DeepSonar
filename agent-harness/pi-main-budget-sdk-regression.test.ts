import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { PI_MAIN_REQUEST_BUDGET_SOURCE } from "../packages/runtime-sandbox/src/pi-main-request-budget.js";

// Actions installs the existing dsh-runtime lockfile; no credentials or external model calls.
const root = path.resolve(process.env.PI_MAIN_BUDGET_SDK_ROOT ?? fileURLToPath(new URL("./base-cli-runtime/node_modules/@earendil-works/pi-ai", import.meta.url)));
async function loadRealSdkExtension() {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-ai");
  assert.equal(manifest.version, "1.5.2", "test the locked production SDK, never an ambient dependency");
  const compatUrl = pathToFileURL(path.join(root, manifest.exports["./compat"].import)).href;
  const source = PI_MAIN_REQUEST_BUDGET_SOURCE
    .replace("'@earendil-works/pi-ai/compat'", JSON.stringify(compatUrl))
    .replace("'/usr/local/lib/node_modules/@earendil-works/pi-ai'", JSON.stringify(root));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function fixture(compat: Record<string, unknown> = {}) {
  const module = await loadRealSdkExtension();
  const bodies: any[] = [];
  let remaining = 2048;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/gateway/_allowance") {
      assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ policy_required: true, remaining_tokens: remaining }));
      return;
    }
    assert.equal(req.method, "POST");
    assert.match(req.url!, /^\/v1\/messages(?:\?|$)/u);
    assert.equal(req.headers["x-api-key"], "synthetic-main-token");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { id: "synthetic-message", type: "message", role: "assistant", model: "synthetic-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const model = { id: "synthetic-model", name: "Synthetic", provider: "synthetic-provider", api: "anthropic-messages", baseUrl: base,
    reasoning: true, input: ["text"], maxTokens: 8192, contextWindow: 1000000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat };
  let start: any, wrapped: any;
  module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: base + "/gateway", DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token",
    DEEPSONAR_API_TOKEN: "synthetic-control-token" })({
    on(name: string, handler: any) { assert.equal(name, "session_start"); start = handler; },
    registerProvider(_name: string, config: any) { wrapped = config.streamSimple; },
  });
  start({}, { model, modelRegistry: { getRegisteredProviderConfig() { return undefined; },
    getAll: () => [{ ...model, provider: "__deepsonar_observational_memory" }],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-om-token" }) } });
  return { model, bodies, allowance(cap: number) { remaining = cap; },
    async request(options = {}, context = { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }) {
      const events = [];
      for await (const event of wrapped(model, context, { reasoning: "high", ...options })) events.push(event);
      return events;
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("#1032 locked pi-ai sends a credential-free context while preserving request authentication", async () => {
  const f = await fixture();
  try {
    const context = { messages: [{ role: "user", content: 'tool error: synthetic-control-token; auth.json {"key":"synthetic-main-token","om":"synthetic-om-token"}; 界🙂', timestamp: 1 }] };
    const before = structuredClone(context);
    assert.equal((await f.request({}, context)).at(-1).type, "done");
    assert.equal(f.bodies.length, 1);
    assert.doesNotMatch(JSON.stringify(f.bodies[0]), /synthetic-(?:main|control|om)-token/u);
    assert.match(JSON.stringify(f.bodies[0]), /\[REDACTED\]/u);
    assert.match(JSON.stringify(f.bodies[0]), /界🙂/u);
    assert.deepEqual(context, before);
  } finally { await f.close(); }
});

test("real pi-ai 1.5.2 nonadaptive thinking refuses insufficient allowance and context before HTTP", async () => {
  const f = await fixture();
  try {
    for (const cap of [32, 1024, 1025, 2047]) {
      f.allowance(cap);
      const events = await f.request();
      assert.match(events.at(-1).error.errorMessage, /THINKING_MINIMUM/u);
      assert.equal(f.bodies.length, 0);
    }
    for (const cap of [2048, 2049]) {
      f.allowance(cap);
      assert.equal((await f.request()).at(-1).type, "done");
      const body = f.bodies.at(-1);
      assert.equal(body.max_tokens, cap);
      assert.equal(body.thinking.type, "enabled");
      assert.equal(body.thinking.budget_tokens, cap - 1024);
      assert.ok(body.thinking.budget_tokens >= 1024 && body.thinking.budget_tokens < body.max_tokens);
    }
    f.allowance(2048);
    assert.match((await f.request({ thinkingBudgets: { high: 1 } })).at(-1).error.errorMessage, /THINKING_MINIMUM/u);
    assert.equal(f.bodies.length, 2);
    // Even sufficient ledger allowance is unsafe when the SDK's context clamp leaves <2048.
    f.model.contextWindow = 4096 + 2047;
    assert.match((await f.request()).at(-1).error.errorMessage, /THINKING_MINIMUM/u);
    assert.equal(f.bodies.length, 2);
  } finally { await f.close(); }
});

test("#958 real pi-ai preserves both OpenAI output fields and exposes the one-token context clamp as length", async () => {
  const module = await loadRealSdkExtension();
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const bodies: Record<string, any>[] = [], failures: unknown[] = [];
    let lowBudget = false;
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url === "/gateway/_allowance") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ policy_required: true, remaining_tokens: null }));
          return;
        }
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const envelope = { id: "synthetic-budget", object: "chat.completion.chunk", created: 1, model: "synthetic-model" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", content: lowBudget ? "x" : "synthetic reply" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: lowBudget ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: lowBudget ? 1 : 8, total_tokens: lowBudget ? 2 : 9 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } catch (error) { failures.push(error); res.writeHead(500).end("synthetic fixture failed"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const model = { id: "synthetic-model", name: "Synthetic", provider: "synthetic-provider", api: "openai-completions",
      baseUrl: base + "/v1", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: field } };
    let start: any, wrapped: any;
    module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: base + "/gateway", DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" })({
      on(_name: string, handler: any) { start = handler; },
      registerProvider(_name: string, config: any) { wrapped = config.streamSimple; },
    });
    try {
      start({}, { model, modelRegistry: { getRegisteredProviderConfig() { return undefined; }, getAll: () => [] } });
      const request = async () => {
        const events: any[] = [];
        for await (const event of wrapped(model, { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }, { signal: AbortSignal.timeout(10_000) })) events.push(event);
        return events.at(-1);
      };
      assert.equal((await request()).type, "done");
      assert.equal(bodies[0]![field], 64_000);
      assert.equal(bodies[0]![field === "max_tokens" ? "max_completion_tokens" : "max_tokens"], undefined);
      assert.equal(bodies[0]!.stream_options.include_usage, true);
      // The locked SDK clamps generation options, not the frozen declared limit.
      model.contextWindow = 1024; lowBudget = true;
      const truncated = await request();
      assert.equal(truncated.type, "done"); assert.equal(truncated.reason, "length");
      assert.equal(bodies[1]![field], 1);
      assert.equal(model.maxTokens, 64_000, "request clamp must not mutate the frozen model output limit");
      assert.equal(bodies.length, 2); assert.deepEqual(failures, []);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test("real pi-ai adaptive branches retain reasoning across the legacy threshold without body edits", async () => {
  for (const compat of [{ forceAdaptiveThinking: true }, { supportsMidConvoEffort: true }]) {
    const f = await fixture(compat);
    try {
      for (const cap of [1, 32, 2047, 2048, 2049]) {
        f.allowance(cap);
        assert.equal((await f.request()).at(-1).type, "done");
        const body = f.bodies.at(-1);
        assert.equal(body.max_tokens, cap);
        assert.equal(body.thinking.type, "adaptive");
        assert.equal(body.thinking.budget_tokens, undefined);
      }
    } finally { await f.close(); }
  }
});
