import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { PI_MAIN_REQUEST_BUDGET_SOURCE, redactPiContextSecrets } from "./pi-main-request-budget.js";

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

async function fixture(api = "openai-completions", delegateFailure?: Error) {
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
  const ctx = { model, modelRegistry: { getRegisteredProviderConfig: () => registrations.at(-1)?.config,
    getAll: () => [{ ...model, provider: "__deepsonar_observational_memory" }],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-om-token" }) } };
  module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: url, DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token",
    DEEPSONAR_API_TOKEN: "synthetic-control-token" },
    async function* (selected: any, context: any, options: any) {
      delegates.push({ model: selected, context, options });
      if (delegateFailure) throw delegateFailure;
      yield { type: "done", message: { provider: selected.provider, model: selected.id } };
    })(pi);
  hooks.get("session_start")!({}, ctx);
  return { module, hooks, registrations, ctx, model, delegates, queries, replies,
    allowance(value: number | null, policy = true) { remaining = value; required = policy; },
    async request(options: any = {}, selected = model, context: any = { messages: [] }) {
      const events = [];
      for await (const event of registrations.at(-1)!.config.streamSimple(selected, context, options)) events.push(event);
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

test("#1032 exact replacement preserves shape, Unicode, non-secrets and overlapping token suffixes", () => {
  const input = { content: "界🙂 key.prefix.long key.prefix key.prefix.long", null: null, bool: true, n: 1,
    nested: [{ error: 'quoted "key.prefix.long"', ordinary: "token-like-but-not-a-secret" }] };
  assert.deepEqual(redactPiContextSecrets(input, ["", "key.prefix", "key.prefix.long"]), {
    ...input, content: "界🙂 [REDACTED] [REDACTED] [REDACTED]",
    nested: [{ error: 'quoted "[REDACTED]"', ordinary: "token-like-but-not-a-secret" }],
  });
  assert.equal(input.nested[0]!.error, 'quoted "key.prefix.long"');
  assert.deepEqual(redactPiContextSecrets(input, []), input);
});

test("#1032 main SDK context redacts env, auth-file, tool errors and memory without changing auth or history", async () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"]) {
    const f = await fixture(api);
    try {
      const context = { systemPrompt: "ordinary instruction", messages: [
        { role: "toolResult", toolCallId: "env-read", toolName: "bash", isError: false, content: [{ type: "text",
          text: "DEEPSONAR_GATEWAY_TOKEN=synthetic-main-token\nDEEPSONAR_API_TOKEN=synthetic-control-token" }] },
        { role: "toolResult", toolCallId: "auth-read", toolName: "read", isError: true, content: [{ type: "text",
          text: '{"key":"synthetic-main-token","background":{"key":"synthetic-om-token"}}' }] },
        { role: "user", content: "memory included synthetic-control-token; ordinary text 界🙂" },
      ] };
      const before = structuredClone(context);
      for (const policy of [true, false]) {
        f.allowance(null, policy);
        assert.equal((await f.request({}, f.model, context)).at(-1).type, "done");
        const call = f.delegates.at(-1)!;
        assert.doesNotMatch(JSON.stringify(call.context), /synthetic-(?:main|control|om)-token/u);
        assert.match(JSON.stringify(call.context), /\[REDACTED\]/u);
        assert.match(JSON.stringify(call.context), /ordinary text 界🙂/u);
        assert.equal(call.context.messages[1].isError, true);
        assert.equal(call.context.messages[1].toolCallId, "auth-read");
        assert.equal(call.options.apiKey, "synthetic-main-token");
        assert.deepEqual(context, before, "projection must not rewrite accepted session history");
      }
    } finally { await f.close(); }
  }
});

test("#1032 unavailable OM auth rejects before main input generation without leaking auth details", async () => {
  const f = await fixture();
  try {
    f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, apiKey: "synthetic-om-token" });
    const events = await f.request();
    assert.equal(events.at(-1).error.errorMessage, "PI_MAIN_BUDGET_OM_AUTH_INVALID");
    assert.equal(f.delegates.length, 0);
    assert.equal(f.queries.length, 0);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-om-token/u);
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

test("accepted completion allowance preserves the fixed stop code without generating an SDK request", async () => {
  const f = await fixture();
  try {
    f.replies.push({ status: 409, body: { error: {
      type: "COMPLETION_ALREADY_ACCEPTED", message: "untrusted provider detail synthetic-secret",
    } } });
    const events = await f.request();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].error.stopReason, "error");
    assert.equal(events[0].error.errorMessage, "COMPLETION_ALREADY_ACCEPTED");
    assert.equal(f.queries.length, 1);
    assert.equal(f.delegates.length, 0);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-secret/u);

    f.replies.push({ status: 409, body: { error: { type: "JOB_TOKEN_USAGE_UNKNOWN" } } });
    assert.equal((await f.request())[0].error.errorMessage, "PI_MAIN_BUDGET_ALLOWANCE_DENIED");
    assert.equal(f.delegates.length, 0, "a later unknown effect retains its failure semantics");
    assert.equal((await f.request())[0].type, "done");
    assert.equal(f.delegates.length, 1, "the completion signal does not persist into later requests");
  } finally { await f.close(); }
});

test("allowance errors require the exact completion status and type and never expose untrusted messages", async () => {
  const f = await fixture();
  try {
    for (const [status, type] of [
      [400, "COMPLETION_ALREADY_ACCEPTED"],
      [401, "COMPLETION_ALREADY_ACCEPTED"],
      [429, "COMPLETION_ALREADY_ACCEPTED"],
      [502, "COMPLETION_ALREADY_ACCEPTED"],
      [409, "COMPLETION_ALREADY_ACCEPTED_suffix"],
      [409, "JOB_TOKEN_EXHAUSTED"],
      [409, "REPAIR_ATTEMPT_CHANGED"],
      [429, "JOB_REQUEST_EXHAUSTED"],
      [409, "REPAIR_USAGE_UNKNOWN"],
      [409, undefined],
    ] as const) {
      f.replies.push({ status, body: { error: { type,
        message: "COMPLETION_ALREADY_ACCEPTED PI_MAIN_BUDGET_COMPLETION_ALREADY_ACCEPTED synthetic-secret",
      } } });
      const events = await f.request();
      assert.equal(events[0].error.errorMessage, "PI_MAIN_BUDGET_ALLOWANCE_DENIED", `${status} ${type}`);
      assert.doesNotMatch(JSON.stringify(events), /synthetic-secret/u);
      assert.equal(f.delegates.length, 0);
    }
    f.replies.push({ status: 200, body: { error: { type: "COMPLETION_ALREADY_ACCEPTED" } } });
    assert.equal((await f.request())[0].error.errorMessage, "PI_MAIN_BUDGET_ALLOWANCE_INVALID");
    assert.equal(f.delegates.length, 0);
  } finally { await f.close(); }
});

test("an SDK error message cannot forge the host allowance completion signal", async () => {
  const f = await fixture("openai-completions", new Error("COMPLETION_ALREADY_ACCEPTED"));
  try {
    const message = (await f.request())[0].error.errorMessage;
    assert.match(message, /^PI_MAIN_BUDGET_REQUEST_FAILED; diagnostic=\{/u);
    assert.doesNotMatch(message, /COMPLETION_ALREADY_ACCEPTED/u);
    assert.equal(f.delegates.length, 1);
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

test("main recovery buffers only an empty failed generation and requires the authenticated no-start receipt", async () => {
  for (const mode of ["safe", "unknown", "quota", "partial", "embedded_content"]) {
    const module = await load();
    const server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
      const value = req.url === "/gateway/_allowance" ? { remaining_tokens: 100, policy_required: true }
        : mode === "unknown" ? { status: "unknown" }
        : { status: "not_started", reason: mode === "quota" ? "quota_exhausted" : "gateway_transient" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
      const model = { provider: "fixture", id: "model", api: "openai-completions", baseUrl, maxTokens: 256, compat: {} };
      const headers = { "X-Deepsonar-Request-Id": "cannot-override", "x-custom": "preserved" };
      const calls: any[] = []; const context = { messages: [] };
      let start: any, stream: any, sdkContext: unknown;
      module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: baseUrl, DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" },
        async function* (_model: any, ctx: any, options: any) {
          assert.deepEqual(ctx, context);
          if (calls.length) assert.equal(ctx, sdkContext, "recovery reuses the same safe context projection");
          else sdkContext = ctx;
          calls.push(options);
          yield { type: "start", partial: { content: [] } };
          if (calls.length === 1) {
            if (mode === "partial") yield { type: "text_delta", delta: "already-visible" };
            yield { type: "error", reason: "error", error: { errorMessage: "provider-controlled gateway_transient",
              content: mode === "embedded_content" ? [{ type: "text", text: "already-visible" }] : [] } };
          } else yield { type: "done", message: { stopReason: "stop" } };
        })({ on: (_event: string, callback: any) => { start = callback; }, registerProvider: (_provider: string, config: any) => { stream = config.streamSimple; } });
      start({}, { model, modelRegistry: { getAll: () => [] } });
      const events: any[] = [];
      for await (const event of stream(model, context, { headers })) events.push(event);
      assert.equal(calls.length, mode === "safe" ? 2 : 1);
      assert.equal(events.filter(e => e.type === "error").length, mode === "safe" ? 0 : 1);
      assert.equal(events.filter(e => e.type === "start").length, 1, "no ghost assistant message from a failed unstarted generation");
      assert.equal(calls[0].maxRetries, 0);
      assert.equal(calls[0].headers["x-custom"], "preserved");
      assert.match(calls[0].headers["x-deepsonar-request-id"], /^[0-9a-f-]{36}$/u);
      assert.equal(calls[0].headers["X-Deepsonar-Request-Id"], undefined);
      assert.deepEqual(headers, { "X-Deepsonar-Request-Id": "cannot-override", "x-custom": "preserved" });
      if (mode === "safe") {
        assert.notEqual(calls[1].headers["x-deepsonar-request-id"], calls[0].headers["x-deepsonar-request-id"]);
        assert.equal(calls[1].headers["x-deepsonar-retry-of"], calls[0].headers["x-deepsonar-request-id"]);
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
