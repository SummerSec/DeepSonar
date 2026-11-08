import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PI_MAIN_REQUEST_BUDGET_SOURCE } from "./pi-main-request-budget.js";

// This is an SDK-boundary double, not evidence of a real Pi process or provider run.
const streamDouble = `
export function createAssistantMessageEventStream() {
  const queue = []; let ended = false, wake;
  return { push(value) { queue.push(value); wake?.(); }, end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!ended || queue.length) {
      if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; });
    } } };
}
export function streamSimple() { throw new Error('test must supply a pre-generation SDK delegate'); }
`;

async function load() {
  const sdkUrl = `data:text/javascript;base64,${Buffer.from(streamDouble).toString("base64")}`;
  const source = PI_MAIN_REQUEST_BUDGET_SOURCE.replace("'@earendil-works/pi-ai/compat'", JSON.stringify(sdkUrl));
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function fixture(api = "openai-completions") {
  const module = await load();
  const queries: string[] = [];
  const delegates: Array<{ model: any; context: any; options: any }> = [];
  const replies: Array<{ status: number; body: unknown }> = [];
  let remaining: number | null = 100;
  let required = true;
  const server = http.createServer((req, res) => {
    queries.push(req.url!);
    assert.equal(req.url, "/gateway/_allowance");
    assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
    const next = replies.shift() ?? { status: 200, body: { remaining_tokens: remaining, policy_required: required } };
    res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify(next.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
  const model = { provider: "synthetic-main-provider", id: "synthetic-model", api, baseUrl: url,
    maxTokens: 256, contextWindow: 1000000, compat: {} };
  const hooks = new Map<string, (...args: any[]) => unknown>();
  const registrations: Array<{ provider: string; config: any }> = [];
  const pi = { on: (event: string, handler: (...args: any[]) => unknown) => hooks.set(event, handler),
    registerProvider: (provider: string, config: any) => registrations.push({ provider, config }) };
  const ctx = { model, modelRegistry: { getRegisteredProviderConfig: () => registrations.at(-1)?.config } };
  module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: url, DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" },
    async function* (selected: any, context: any, options: any) {
      delegates.push({ model: selected, context, options });
      yield { type: "done", message: { provider: selected.provider, model: selected.id } };
    })(pi);
  hooks.get("session_start")!({}, ctx);
  return { module, hooks, registrations, ctx, model, delegates, queries, replies,
    allowance(value: number | null, policy = true) { remaining = value; required = policy; },
    async request(options: any = {}, selected = model) {
      const events = [];
      for await (const event of registrations.at(-1)!.config.streamSimple(selected, { messages: [] }, options)) events.push(event);
      return events;
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("Pi public provider override negotiates every main SDK request before HTTP generation", async () => {
  const f = await fixture();
  try {
    assert.deepEqual([...f.hooks.keys()], ["session_start"], "no serialized-payload or HTTP interception hook");
    assert.equal(f.registrations[0]!.provider, f.model.provider);
    assert.deepEqual(Object.keys(f.registrations[0]!.config).sort(), ["api", "streamSimple"]);
    const onPayload = () => undefined;
    const options = { maxTokens: 128, apiKey: "synthetic-main-token", onPayload };
    assert.equal((await f.request(options))[0].type, "done");
    assert.equal(f.delegates[0]!.options.maxTokens, 100);
    assert.equal(f.delegates[0]!.model.maxTokens, 100);
    assert.equal(f.delegates[0]!.model.compat.supportsUsageInStreaming, true);
    assert.equal(f.delegates[0]!.options.onPayload, onPayload, "the SDK's existing callback is passed through, never replaced");
    f.allowance(40);
    await f.request(options);
    assert.equal(f.delegates[1]!.options.maxTokens, 40);
    assert.equal(f.delegates[1]!.model.maxTokens, 40);
    assert.equal(f.delegates[1]!.options.maxRetries, 0);
    assert.equal(f.model.maxTokens, 256, "a request cap does not permanently lower the frozen model catalog");
    assert.equal(options.maxTokens, 128);
    f.allowance(null, false);
    await f.request(options);
    assert.equal(f.delegates[2]!.model, f.model);
    assert.equal(f.delegates[2]!.options.maxTokens, 128);
    assert.equal(f.queries.length, 3);
    const registered = f.registrations[0]!.config.streamSimple;
    f.hooks.get("session_start")!({}, f.ctx);
    assert.equal(f.registrations.at(-1)!.config.streamSimple, registered, "session start does not stack wrappers");
  } finally { await f.close(); }
});

test("pending settlement polls only allowance; unknown usage and mismatched identities invoke no SDK request", async () => {
  const f = await fixture();
  try {
    f.replies.push({ status: 409, body: { error: { type: "JOB_TOKEN_USAGE_PENDING" } } },
      { status: 409, body: { error: { type: "REPAIR_USAGE_PENDING" } } });
    assert.equal((await f.request())[0].type, "done");
    assert.equal(f.queries.length, 3); assert.equal(f.delegates.length, 1);
    f.replies.push({ status: 409, body: { error: { type: "JOB_TOKEN_USAGE_UNKNOWN" } } });
    const unknown = await f.request();
    assert.match(unknown[0].error.errorMessage, /PI_MAIN_BUDGET_ALLOWANCE_DENIED/u);
    assert.equal(f.queries.length, 4); assert.equal(f.delegates.length, 1);
    for (const selected of [{ ...f.model, provider: "__deepsonar_observational_memory" }, { ...f.model, baseUrl: "http://127.0.0.1:1/gateway" }]) {
      assert.equal((await f.request({}, selected))[0].type, "error");
    }
    assert.equal((await f.request({ apiKey: "synthetic-background-token" }))[0].type, "error");
    assert.equal(f.queries.length, 4); assert.equal(f.delegates.length, 1);
  } finally { await f.close(); }
});

test("only the exact Gateway completion refusal survives allowance negotiation without a model request", async () => {
  const f = await fixture();
  try {
    f.replies.push({ status: 409, body: { error: { type: "COMPLETION_ALREADY_ACCEPTED", message: "private ignored message" } } });
    assert.equal((await f.request())[0].error.errorMessage, "COMPLETION_ALREADY_ACCEPTED");
    assert.equal(f.delegates.length, 0);
    for (const reply of [
      { status: 401, body: { error: { type: "COMPLETION_ALREADY_ACCEPTED" } } },
      { status: 409, body: { error: { message: "COMPLETION_ALREADY_ACCEPTED" } } },
      { status: 409, body: { error: { type: "JOB_TOKEN_USAGE_UNKNOWN" } } },
      { status: 409, body: { error: { type: "REPAIR_ATTEMPT_CHANGED" } } },
      { status: 429, body: { error: { type: "JOB_REQUEST_EXHAUSTED" } } },
    ]) {
      f.replies.push(reply);
      assert.equal((await f.request())[0].error.errorMessage, "PI_MAIN_BUDGET_ALLOWANCE_DENIED");
    }
    assert.equal(f.delegates.length, 0);
    assert.equal(f.queries.length, 6);
  } finally { await f.close(); }
});

test("Anthropic thinking rejects insufficient room before delegation; adaptive thinking and Responses keep SDK caps", async () => {
  for (const api of ["anthropic-messages", "openai-responses"]) {
    const f = await fixture(api);
    try {
      f.allowance(32);
      if (api === "anthropic-messages") {
        Object.assign(f.model, { reasoning: true });
        assert.match((await f.request({ reasoning: "high" }))[0].error.errorMessage, /THINKING_MINIMUM/u);
        assert.equal(f.delegates.length, 0);
        Object.assign(f.model.compat, { forceAdaptiveThinking: true });
      }
      assert.equal((await f.request({ reasoning: "high", maxTokens: 128 }))[0].type, "done");
      assert.equal(f.delegates[0]!.model.maxTokens, 32);
      assert.equal(f.delegates[0]!.options.maxTokens, 32);
      assert.equal(f.delegates[0]!.options.reasoning, "high");
      if (api === "openai-responses") {
        f.allowance(15);
        assert.match((await f.request())[0].error.errorMessage, /PI_MAIN_BUDGET_PROTOCOL_LIMIT/u);
        assert.equal(f.delegates.length, 1);
      }
    } finally { await f.close(); }
  }
});

test("sampling overrides and unsupported providers cannot bypass the explicit SDK budget contract", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.model);
    assert.match((await f.request({ samplingParams: { max_tokens: 9999 } }))[0].error.errorMessage, /PI_MAIN_BUDGET_SAMPLING_CONFLICT/u);
    assert.equal(f.delegates.length, 0); assert.deepEqual(f.model, before);
    assert.match((await f.request({}, { ...f.model, compat: { supportsUsageInStreaming: false } }))[0].error.errorMessage,
      /PI_MAIN_BUDGET_STREAM_USAGE_UNSUPPORTED/u);
    assert.equal(f.delegates.length, 0);
    f.allowance(0);
    assert.match((await f.request())[0].error.errorMessage, /PI_MAIN_BUDGET_EXHAUSTED/u);
    assert.equal(f.delegates.length, 0);
    assert.throws(() => f.hooks.get("session_start")!({}, { ...f.ctx, model: { ...f.model, provider: "__deepsonar_observational_memory" } }));
    assert.throws(() => f.hooks.get("session_start")!({}, { ...f.ctx, modelRegistry: { getRegisteredProviderConfig: () => ({ streamSimple: () => undefined }) } }));
  } finally { await f.close(); }
});


test("nonadaptive Anthropic thinking validates the exact pinned SDK minimum and custom budgets", async () => {
  const { assertPiAnthropicThinkingBudget: check } = await load();
  const model = { api: "anthropic-messages", reasoning: true, compat: {} };
  for (const cap of [1, 32, 1024, 1025, 2047]) assert.throws(() => check(model, { reasoning: "high" }, cap), /THINKING_MINIMUM/u);
  check(model, { reasoning: "high" }, 2048);
  check(model, { reasoning: "xhigh", thinkingBudgets: { high: 1024 } }, 2048);
  for (const budget of [0, 1, 1023, null, NaN]) assert.throws(() => check(model, { reasoning: "high", thinkingBudgets: { high: budget } }, 2048), /THINKING_MINIMUM/u);
  check({ ...model, compat: { forceAdaptiveThinking: true } }, { reasoning: "high" }, 32);
  check({ ...model, compat: { supportsMidConvoEffort: true } }, { reasoning: "high" }, 32);
  assert.throws(() => check({ ...model, compat: { supportsAdaptiveThinking: true } }, { reasoning: "high" }, 32), /THINKING_MINIMUM/u);
  check(model, {}, 32);
});
