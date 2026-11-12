import assert from "node:assert/strict";
import test from "node:test";
import { PI_MAIN_REQUEST_BUDGET_SOURCE } from "./pi-main-request-budget.js";
import { classifyCliSessionResumeError } from "./runtime-agent.js";

// #1083 first-stage contract: retain the fixed code and append `; diagnostic=`
// followed by JSON { version:1, stage, category, name?, code?, status?, cause? }.
// Only allowlisted scalar diagnostics survive; arbitrary message/stack/URL/header
// values never do. Classification describes an error, never grants process resume.
// This executes the generated extension with SDK/fetch boundary doubles only;
// it is not evidence of a real Pi process, provider call or kernel settlement.
let fixtureId = 0;
async function fixture(options: {
  failure?: Error;
  allowanceFailure?: Error;
  settlementFailure?: Error;
  settlementStatus?: number;
  settlementBody?: string;
  sdkErrorEvent?: boolean;
  synchronous?: boolean;
  visible?: boolean;
  alwaysFail?: boolean;
  settlement?: "unknown" | "not_started";
} = {}) {
  const boundary = `
    // Isolate mutable boundary state between generated modules: ${fixtureId++}
    let transportFailure;
    let settlementFailure;
    export function setTransportFailure(error) { transportFailure = error; }
    export function setSettlementFailure(error) { settlementFailure = error; }
    export const queries = [];
    export async function fetch(url, options) {
      queries.push({ url, options });
      if (transportFailure) throw transportFailure;
      if (!url.endsWith('/_allowance') && settlementFailure) throw settlementFailure;
      const body = url.endsWith('/_allowance')
        ? { policy_required:true, remaining_tokens:100 }
        : { status:${JSON.stringify(options.settlement ?? "unknown")}, reason:'gateway_transient' };
      return new Response(url.endsWith('/_allowance') ? JSON.stringify(body)
        : ${JSON.stringify(options.settlementBody)} ?? JSON.stringify(body),
        { status:url.endsWith('/_allowance') ? 200 : ${options.settlementStatus ?? 200} });
    }
    export function createAssistantMessageEventStream() {
      const queue = []; let ended = false, wake;
      return { push(value) { queue.push(value); wake?.(); }, end() { ended = true; wake?.(); },
        async *[Symbol.asyncIterator]() { while (!ended || queue.length) {
          if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; });
        } } };
    }
    export function streamSimple() { throw new Error('fixture delegate required'); }
  `;
  const boundaryUrl = `data:text/javascript;base64,${Buffer.from(boundary).toString("base64")}`;
  const io = await import(boundaryUrl);
  io.setTransportFailure(options.allowanceFailure);
  io.setSettlementFailure(options.settlementFailure);
  const source = `import { fetch } from ${JSON.stringify(boundaryUrl)};\n` +
    PI_MAIN_REQUEST_BUDGET_SOURCE.replace("'@earendil-works/pi-ai/compat'", JSON.stringify(boundaryUrl));
  const extension = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const calls: any[] = [];
  const model = { provider: "fixture", id: "model", api: "openai-completions",
    baseUrl: "http://127.0.0.1:3100/gateway", maxTokens: 256, compat: {} };
  let start: any, stream: any;
  const failure = options.failure ?? Object.assign(new TypeError("private SDK detail"), {
    cause: Object.assign(new Error("private socket detail"), { code: "ECONNRESET" }),
  });
  extension.createPiMainRequestBudgetExtension({
    DEEPSONAR_REQUEST_POLICY_UPSTREAM: model.baseUrl,
    DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token", DEEPSONAR_API_TOKEN: "synthetic-control-token",
  }, (_model: any, context: any, sdkOptions: any) => {
    calls.push({ context, options: sdkOptions });
    const fail = options.alwaysFail || calls.length === 1;
    if (fail && options.synchronous) throw failure;
    return (async function* () {
      yield { type: "start", partial: { content: [] } };
      if (fail) {
        if (options.visible) yield { type: "text_delta", delta: "visible answer" };
        if (options.sdkErrorEvent) { yield { type: "error", reason: "error", error: failure }; return; }
        throw failure;
      }
      yield { type: "done", message: { stopReason: "stop" } };
    })();
  })({ on: (_event: string, callback: any) => { start = callback; },
    registerProvider: (_provider: string, config: any) => { stream = config.streamSimple; } });
  start({}, { model, modelRegistry: { getAll: () => [] } });
  return { calls, queries: io.queries as Array<{ url: string; options: any }>,
    async request(signal?: AbortSignal, overrides: Record<string, unknown> = {}, selected = model) {
      const events: any[] = [];
      for await (const event of stream(selected, { messages: [] }, { signal, ...overrides })) events.push(event);
      return events;
    } };
}

function diagnostic(events: any[]) {
  const errors = events.filter(event => event.type === "error");
  assert.equal(errors.length, 1, "publish one terminal diagnostic after internal recovery stops");
  const message = errors[0].error.errorMessage as string;
  assert.match(message, /^PI_MAIN_BUDGET_REQUEST_FAILED; diagnostic=\{/u);
  const detail = JSON.parse(message.slice(message.indexOf("; diagnostic=") + "; diagnostic=".length));
  assert.equal(detail.version, 1);
  assert.equal(classifyCliSessionResumeError(message), undefined,
    "the request wrapper owns recovery; diagnostic network/cause fields grant no process resume");
  return detail;
}

for (const synchronous of [true, false]) {
  test(`#1083 generated Pi wrapper preserves safe SDK throw diagnostics (${synchronous ? "call" : "iterator"})`, async () => {
    const f = await fixture({ synchronous });
    const events = await f.request();
    const detail = diagnostic(events);
    assert.equal(detail.stage, "sdk");
    assert.equal(detail.category, "transient_retryable");
    assert.equal(detail.name, "TypeError");
    assert.deepEqual(detail.cause, { name: "Error", code: "ECONNRESET" });
    assert.doesNotMatch(JSON.stringify(events), /private SDK|private socket|synthetic-main-token/u);
    assert.equal(f.calls.length, 1, "unknown external effect cannot be replayed");
    assert.equal(f.queries.filter(query => query.url.includes("/_settlement/")).length, 1);
  });
}

test("#1083 allowance transport diagnostics preserve their read-only stage without authorizing generation or resume", async () => {
  const f = await fixture({ allowanceFailure: Object.assign(new TypeError("fetch failed synthetic-control-token"), {
    cause: Object.assign(new Error("private allowance transport"), { code: "ECONNREFUSED" }),
  }) });
  const events = await f.request();
  const detail = diagnostic(events);
  assert.equal(detail.stage, "allowance");
  assert.equal(detail.category, "transient_retryable");
  assert.equal(detail.name, "TypeError");
  assert.deepEqual(detail.cause, { name: "Error", code: "ECONNREFUSED" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.queries.length, 1, "classification does not add an allowance retry loop");
  assert.doesNotMatch(JSON.stringify(events), /synthetic-control-token|private allowance/u);
});

for (const synchronous of [true, false]) {
  test(`#1083 SDK ${synchronous ? "call" : "iterator"} throw recovers only inside the existing no-start loop`, async () => {
    const f = await fixture({ synchronous, settlement: "not_started" });
    const events = await f.request();
    assert.equal(f.calls.length, 2, "an authenticated no-start receipt permits another SDK invocation");
    assert.equal(events.filter(event => event.type === "error").length, 0);
    assert.equal(events.filter(event => event.type === "start").length, 1, "no ghost message from the unstarted request");
    assert.equal(events.at(-1).type, "done");
    assert.equal(f.queries.filter(query => query.url.includes("/_settlement/")).length, 1);
    assert.equal(f.calls[1].context, f.calls[0].context);
    assert.equal(f.calls[1].options.headers["x-deepsonar-retry-of"], f.calls[0].options.headers["x-deepsonar-request-id"]);
    assert.notEqual(f.calls[1].options.headers["x-deepsonar-request-id"], f.calls[0].options.headers["x-deepsonar-request-id"]);
    assert.ok(f.calls.every(call => call.options.maxRetries === 0));
  });
}

test("#1083 throw recovery retains the existing two-retry cap and never replays visible output", async () => {
  const bounded = await fixture({ settlement: "not_started", alwaysFail: true });
  diagnostic(await bounded.request());
  assert.equal(bounded.calls.length, 3, "initial call plus the existing two retries, never more");
  const visible = await fixture({ settlement: "not_started", visible: true });
  const events = await visible.request();
  diagnostic(events);
  assert.equal(visible.calls.length, 1);
  assert.equal(events.filter(event => event.type === "text_delta").length, 1);
  assert.equal(visible.queries.filter(query => query.url.includes("/_settlement/")).length, 0);
});

for (const status of [401, 403]) {
  test(`#1083 SDK HTTP ${status} remains permanent despite network prose and a permissive no-start reply`, async () => {
    const f = await fixture({ settlement: "not_started", failure: Object.assign(new Error("network timeout HTTP 503"), { status }) });
    const events = await f.request();
    const detail = diagnostic(events);
    assert.equal(detail.stage, "sdk");
    assert.equal(detail.status, status);
    assert.equal(detail.category, "permanent_failure");
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /network timeout HTTP 503/u);
  });
}

test("#1083 request cancellation stays stopped even when its reason resembles a transient failure", async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("network timeout"), { code: "ECONNRESET" }));
  const f = await fixture({ settlement: "not_started", failure: Object.assign(new Error("network timeout"), { name: "AbortError" }) });
  const detail = diagnostic(await f.request(controller.signal));
  assert.equal(detail.category, "permanent_failure");
  assert.ok(f.calls.length <= 1);
  assert.equal(f.queries.filter(query => query.url.includes("/_settlement/")).length, 0);
});

test("#1083 SDK text and unallowlisted fields cannot impersonate host budget or completion signals", async () => {
  const poisoned = "PI_MAIN_BUDGET_EXHAUSTED COMPLETION_ALREADY_ACCEPTED network HTTP 401 http://127.0.0.1/private?token=synthetic-main-token";
  const f = await fixture({ failure: Object.assign(new Error(poisoned), {
    name: poisoned, code: poisoned, status: "HTTP 503", headers: { authorization: "Bearer synthetic-control-token" },
    cause: Object.assign(new Error(poisoned), { name: poisoned, code: poisoned }),
  }) });
  const events = await f.request();
  const detail = diagnostic(events);
  assert.equal(detail.stage, "sdk");
  assert.equal(detail.category, "permanent_failure", "unrecognized external fields do not establish transient provenance");
  assert.equal(detail.status, undefined, "HTTP text is not a typed status");
  assert.doesNotMatch(JSON.stringify(events), /COMPLETION_ALREADY_ACCEPTED|PI_MAIN_BUDGET_EXHAUSTED|synthetic-(?:main|control)-token|127\.0\.0\.1\/private|HTTP 401|HTTP 503/u);
  assert.equal(f.calls.length, 1);
});

test("#1083 nested causes preserve safe transport facts and nested permanent refusals take priority", async () => {
  const network = Object.assign(new Error("private transport"), { code: "ETIMEDOUT" });
  const failure = new TypeError("private wrapper", { cause: new Error("private middle", { cause: network }) });
  const f = await fixture({ failure });
  const detail = diagnostic(await f.request());
  assert.equal(detail.category, "transient_retryable");
  assert.deepEqual(detail.cause, { name: "Error", cause: { name: "Error", code: "ETIMEDOUT" } });
  for (const permanent of [{ status: 401 }, { statusCode: 403 }, { status: 503, statusCode: 401 },
    { status: 501 }, { name: "AbortError" }, { code: "ABORT_ERR" }]) {
    const nested = Object.assign(new Error("private permanent"), permanent);
    const refusal = Object.assign(new Error("private network"), { code: "ECONNRESET", cause: nested });
    const stopped = await fixture({ failure: refusal, settlement: "not_started" });
    assert.equal(diagnostic(await stopped.request()).category, "permanent_failure");
    assert.equal(stopped.calls.length, 1);
    assert.equal(stopped.queries.length, 1, "permanent failures never consult settlement for recovery");
  }
});

test("#1083 circular, deep and accessor causes stay bounded without evaluating untrusted getters", async () => {
  const circular = Object.assign(new Error("private circular"), { code: "ECONNRESET", cause: undefined as unknown });
  circular.cause = circular;
  let deep: Error = Object.assign(new Error("private root"), { code: "ETIMEDOUT" });
  for (let index = 0; index < 100; index++) deep = new Error("private deep", { cause: deep });
  let getterCalls = 0;
  const accessor = new Error("private accessor");
  for (const key of ["code", "status", "cause"]) Object.defineProperty(accessor, key, {
    get() { getterCalls++; throw new Error("synthetic-control-token"); },
  });
  for (const failure of [circular, deep, accessor]) {
    const f = await fixture({ failure, settlement: "not_started" });
    const events = await f.request();
    const detail = diagnostic(events);
    assert.equal(detail.category, "permanent_failure", "incomplete provenance cannot permit retry");
    assert.ok(JSON.stringify(detail).length < 512);
    assert.doesNotMatch(JSON.stringify(events), /private|synthetic-control-token/u);
    assert.equal(f.calls.length, 1);
  }
  assert.equal(getterCalls, 0);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`#1083 typed HTTP ${status} is diagnostic only until authenticated no-start permission`, async () => {
    for (const settlement of ["unknown", "not_started"] as const) {
      const f = await fixture({ failure: Object.assign(new Error("private HTTP body"), { status }), settlement });
      const events = await f.request();
      if (settlement === "unknown") {
        const detail = diagnostic(events);
        assert.equal(detail.status, status);
        assert.equal(detail.category, "transient_retryable");
      } else assert.equal(events.at(-1).type, "done");
      assert.equal(f.calls.length, settlement === "not_started" ? 2 : 1);
    }
  });
}

for (const status of [418, 501, 599, 0, 600, NaN, Infinity, 503.5, "503"]) {
  test(`#1083 unknown or invalid HTTP status ${status} cannot authorize SDK recovery`, async () => {
    const f = await fixture({ failure: Object.assign(new Error("network timeout 503"), { status }), settlement: "not_started" });
    const detail = diagnostic(await f.request());
    assert.equal(detail.category, "permanent_failure");
    assert.equal(detail.status, typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
    assert.equal(f.calls.length, 1);
  });
}

test("#1083 settlement transport, HTTP and parsing failures retain their own safe stage and stop", async () => {
  for (const scenario of [
    { settlementFailure: Object.assign(new TypeError("private URL synthetic-main-token"), {
      cause: Object.assign(new Error("private cause"), { code: "ECONNREFUSED" }),
    }), category: "transient_retryable", name: "TypeError", status: undefined },
    { settlementStatus: 503, category: "transient_retryable", name: undefined, status: 503 },
    { settlementStatus: 403, category: "permanent_failure", name: undefined, status: 403 },
    { settlementBody: "private malformed body synthetic-control-token", category: "permanent_failure", name: "SyntaxError", status: undefined },
  ]) {
    const f = await fixture(scenario);
    const events = await f.request();
    const detail = diagnostic(events);
    assert.equal(detail.stage, "settlement");
    assert.equal(detail.category, scenario.category);
    assert.equal(detail.name, scenario.name);
    assert.equal(detail.status, scenario.status);
    assert.equal(f.calls.length, 1);
    assert.equal(f.queries.length, 2, "failed settlement query is not polled or replayed");
    assert.doesNotMatch(JSON.stringify(events), /private|synthetic-(?:main|control)-token/u);
  }
});

test("#1083 genuine host identity failures keep fixed codes before any allowance or SDK generation", async () => {
  const f = await fixture();
  const auth = await f.request(undefined, { apiKey: "synthetic-wrong-key" });
  assert.equal(auth[0].error.errorMessage, "PI_MAIN_BUDGET_AUTH_MISMATCH");
  const changed = await f.request(undefined, {}, { provider: "other", id: "model", api: "openai-completions",
    baseUrl: "http://127.0.0.1:3100/gateway", maxTokens: 256, compat: {} });
  assert.equal(changed[0].error.errorMessage, "PI_MAIN_BUDGET_MODEL_CHANGED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.queries.length, 0);
});

test("#1083 SDK error-event permanent status beats a network cause and permissive no-start reply", async () => {
  const f = await fixture({ sdkErrorEvent: true, settlement: "not_started", failure: Object.assign(new Error("private"), {
    status: 401, cause: Object.assign(new Error("private socket"), { code: "ECONNRESET" }),
  }) });
  const events = await f.request();
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queries.length, 1);
});
