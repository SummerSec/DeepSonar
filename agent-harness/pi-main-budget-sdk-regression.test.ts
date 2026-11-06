import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { PI_MAIN_REQUEST_BUDGET_SOURCE } from "../packages/runtime-sandbox/src/pi-main-request-budget.js";

// Actions installs the existing dsh-runtime lockfile; no credentials or external model calls.
const root = path.resolve(process.env.PI_MAIN_BUDGET_SDK_ROOT ?? fileURLToPath(new URL("./dsh-runtime/node_modules/@earendil-works/pi-ai", import.meta.url)));
async function loadRealSdkExtension() {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-ai");
  assert.equal(manifest.version, "1.4.0", "test the locked production SDK, never an ambient dependency");
  const compatUrl = pathToFileURL(path.join(root, manifest.exports["./compat"].import)).href;
  const source = PI_MAIN_REQUEST_BUDGET_SOURCE
    .replace("'@earendil-works/pi-ai/compat'", JSON.stringify(compatUrl))
    .replace("'/opt/deepsonar/dsh/node_modules/@earendil-works/pi-ai'", JSON.stringify(root));
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
  module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: base + "/gateway", DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" })({
    on(name: string, handler: any) { assert.equal(name, "session_start"); start = handler; },
    registerProvider(_name: string, config: any) { wrapped = config.streamSimple; },
  });
  start({}, { model, modelRegistry: { getRegisteredProviderConfig() { return undefined; } } });
  return { model, bodies, allowance(cap: number) { remaining = cap; },
    async request(options = {}, context = { messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }) {
      const events = [];
      for await (const event of wrapped(model, context, { reasoning: "high", ...options })) events.push(event);
      return events;
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("real pi-ai 1.4.0 nonadaptive thinking refuses insufficient allowance and context before HTTP", async () => {
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
