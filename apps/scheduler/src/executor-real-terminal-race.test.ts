import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { call, completionReady, completionDiagnosticEvidence, frozenRuntimeBudget, piRecoveryAllowed, jobId, attemptId, rootId, runExecutor, setPreflight, terminalBundleCalls, terminalEvents, setSharedAssetPublication, sharedAssetPublicationState, sharedAssetControlApp } from "./executor-real-terminal-race.fixture.js";
import { getAgentCliRuntimeAdapter, resolveTerminalProcessOutcome, type RealAgentResult } from "@deepsonar/runtime-sandbox";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";

const done = { summary: "Completion accepted during the bounded offline race." };
const humanGuidance = {
  question: "请确认是否能提供隔离测试环境的凭据引用。",
  required_action: "请通过当前已知且受治理的凭据配置提供非秘密引用；不要粘贴秘密。",
  reply_instructions: "请回复已配置的非秘密引用；若没有，请明确回复未配置。",
  after_reply: "收到后仅核对当前 Job 已有权限；回复不扩权、不构成 ACK 或任务完成。",
};
const human = { reason: "Operator credential authorization is required.", guidance: humanGuidance, subject: { type: "platform_blocker", kind: "credential" } };

const assetProposal = { scope: "project", source_path: "/workspace/trial.txt", key: "trial/evidence.txt" };
const assetIdentity = { asset: { id: "00000000-0000-4000-8000-000000000201" },
  version: { id: "00000000-0000-4000-8000-000000000202", content_sha256: "a".repeat(64) } };

test("executeReal: publish HTTP response exposes the actual asset version, including same-key retries after cache loss", async () => {
  const { app, clearCache } = await sharedAssetControlApp();
  try {
    await runExecutor(async () => {
      const key = randomUUID(), eventId = randomUUID();
      const request = { method: "POST" as const, url: `/control/v1/jobs/${jobId}/operations/publish_shared_asset`,
        headers: { authorization: "Bearer offline-capability", "idempotency-key": key },
        payload: { event_id: eventId, input: assetProposal } };
      const first = await app.inject(request);
      assert.equal(first.statusCode, 200);
      assert.deepEqual(first.json(), { accepted: true, operation: "publish_shared_asset", completion_ready: false, ...assetIdentity });
      assert.notEqual(first.json().version.id, eventId);
      assert.notEqual(first.json().version.id, key);
      assert.notEqual(first.json().asset.id, eventId);
      assert.notEqual(first.json().asset.id, key);
      setSharedAssetPublication({ source: "changed after the first publication" });
      assert.deepEqual((await app.inject(request)).json(), first.json());
      clearCache(); // Exercise the executor, rather than only the HTTP cache.
      assert.deepEqual((await app.inject(request)).json(), first.json());
      assert.equal(sharedAssetPublicationState().inputs.length, 1);
      assert.equal(sharedAssetPublicationState().reads, 1);
      assert.equal(sharedAssetPublicationState().inputs[0].bytes.toString(), "trial evidence");
      const conflict = await app.inject({ ...request, payload: { input: { ...assetProposal, key: "trial/other.txt" } } });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error_code, "IDEMPOTENCY_KEY_CONFLICT");
      clearCache();
      const executorConflict = await app.inject({ ...request, payload: { input: { ...assetProposal, key: "trial/other.txt" } } });
      assert.equal(executorConflict.statusCode, 409);
      assert.equal(executorConflict.json().error_code, "IDEMPOTENCY_KEY_CONFLICT");
      assert.equal(sharedAssetPublicationState().inputs.length, 1);
      await call("mark_job_done", done);
    });
  } finally { await app.close(); clearCache(); }
});

test("executeReal: concurrent same-key publication calls share one source read and one version", { timeout: 5000 }, async () => {
  await runExecutor(async () => {
    const entered = barrier(), release = barrier();
    setSharedAssetPublication({ beforePublish: async () => { entered.release(); await release.promise; } });
    const key = randomUUID();
    const first = call("publish_shared_asset", assetProposal, { idempotencyKey: key });
    await entered.promise;
    const retry = call("publish_shared_asset", assetProposal, { idempotencyKey: key });
    release.release();
    const [a, b] = await Promise.all([first, retry]);
    assert.deepEqual(a, { accepted: true, operation: "publish_shared_asset", completion_ready: false, ...assetIdentity });
    assert.deepEqual(b, a);
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    assert.equal(sharedAssetPublicationState().reads, 1);
    await call("mark_job_done", done);
  });
});

test("executeReal: ambiguous publish failure is readable, non-retryable and never replayed after HTTP cache loss", async () => {
  const { app, clearCache } = await sharedAssetControlApp();
  try {
    await runExecutor(async () => {
      setSharedAssetPublication({ error: new Error("database connection closed after possible commit: private detail") });
      const request = { method: "POST" as const, url: `/control/v1/jobs/${jobId}/operations/publish_shared_asset`,
        headers: { authorization: "Bearer offline-capability", "idempotency-key": randomUUID() }, payload: assetProposal };
      const first = await app.inject(request);
      assert.equal(first.statusCode, 409);
      assert.equal(first.json().accepted, false);
      assert.equal(first.json().retryable, false);
      assert.equal(first.json().repair.category, "unknown_external_effect");
      assert.equal(first.json().version, undefined);
      assert.doesNotMatch(first.body, /private detail|database connection/);
      clearCache();
      setSharedAssetPublication({ source: "must not be published" });
      const retry = await app.inject(request);
      assert.equal(retry.statusCode, 409);
      assert.deepEqual(retry.json(), first.json());
      const newKey = await app.inject({ ...request,
        headers: { ...request.headers, "idempotency-key": randomUUID() },
        payload: { ...assetProposal, key: " /trial\\evidence.txt " } });
      assert.equal(newKey.statusCode, 409);
      assert.equal(newKey.json().repair.category, "unknown_external_effect");
      assert.equal(sharedAssetPublicationState().inputs.length, 1);
      assert.equal(sharedAssetPublicationState().reads, 1);
      await call("mark_job_done", done);
    });
  } finally { await app.close(); clearCache(); }
});

test("executeReal: same canonical asset serializes different keys and fences a queued call after unknown", { timeout: 5000 }, async () => {
  await runExecutor(async () => {
    const entered = barrier(), release = barrier();
    setSharedAssetPublication({ error: new Error("unknown commit"),
      beforePublish: async () => { entered.release(); await release.promise; } });
    const unknown = (error: unknown) => error instanceof PlatformRuntimeHandlerError
      && error.rejection?.category === "unknown_external_effect";
    const first = assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() }), unknown);
    await entered.promise;
    const queued = assert.rejects(call("publish_shared_asset", { ...assetProposal, key: " /trial\\evidence.txt " },
      { idempotencyKey: randomUUID() }), unknown);
    release.release();
    await Promise.all([first, queued]);
    setSharedAssetPublication({ source: "new bytes must not create a second version" });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() }), unknown);
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    assert.equal(sharedAssetPublicationState().reads, 1);
    // A different asset identity remains independent.
    await call("publish_shared_asset", { ...assetProposal, key: "trial/independent.txt" }, { idempotencyKey: randomUUID() });
    assert.equal(sharedAssetPublicationState().inputs.length, 2);
    await call("mark_job_done", done);
  });
});

test("executeReal: successful same-asset publications with different keys wait before reading changed source", { timeout: 5000 }, async () => {
  await runExecutor(async () => {
    const entered = barrier(), release = barrier();
    setSharedAssetPublication({ beforePublish: async () => { entered.release(); await release.promise; } });
    const first = call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() });
    await entered.promise;
    const second = call("publish_shared_asset", { ...assetProposal, key: "/trial/evidence.txt" }, { idempotencyKey: randomUUID() });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    assert.equal(sharedAssetPublicationState().reads, 1);
    setSharedAssetPublication({ source: "second version bytes" });
    release.release();
    await Promise.all([first, second]);
    const state = sharedAssetPublicationState();
    assert.equal(state.inputs.length, 2);
    assert.equal(state.inputs[0].bytes.toString(), "trial evidence");
    assert.equal(state.inputs[1].bytes.toString(), "second version bytes");
    assert.equal(state.inputs[1].key, "trial/evidence.txt");
    await call("mark_job_done", done);
  });
});

test("executeReal: known publication rejection and source read failures expose no invented asset identity", async () => {
  await runExecutor(async () => {
    for (const options of [{ error: new Error("asset_quota_exceeded") }, { readError: new Error("ENOENT private path") }]) {
      setSharedAssetPublication(options);
      const key = randomUUID();
      const rejected = (error: unknown) =>
        error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "invalid_payload"
          && error.rejection.retryable === true;
      await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: key }), rejected);
      await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: key }), rejected);
    }
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    assert.equal(sharedAssetPublicationState().reads, 2);
    setSharedAssetPublication({});
    const repaired = await call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() });
    assert.deepEqual(repaired, { accepted: true, operation: "publish_shared_asset", completion_ready: false, ...assetIdentity });
    assert.equal(sharedAssetPublicationState().inputs.length, 2);
    await call("mark_job_done", done);
  });
});

test("executeReal: publication rechecks execution fencing after reading and before returning a cached version", async () => {
  await runExecutor(async () => {
    const key = randomUUID();
    await call("publish_shared_asset", assetProposal, { idempotencyKey: key });
    setSharedAssetPublication({ attemptCurrent: false });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: key }), (error: unknown) =>
      error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "SHARED_ASSET_PUBLISH_ATTEMPT_CHANGED");
    setSharedAssetPublication({ current: false });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: key }));
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    setSharedAssetPublication({ afterRead: async () => { setSharedAssetPublication({ current: false }); } });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() }));
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    setSharedAssetPublication({ afterRead: async () => { setSharedAssetPublication({ attemptCurrent: false }); } });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() }), (error: unknown) =>
      error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "SHARED_ASSET_PUBLISH_ATTEMPT_CHANGED");
    assert.equal(sharedAssetPublicationState().inputs.length, 1);
    await call("mark_job_done", done);
  });
});

test("executeReal: publish rejects an unbound Finding or missing key before reading source bytes", async () => {
  await runExecutor(async () => {
    await assert.rejects(call("publish_shared_asset", { ...assetProposal, scope: "finding" }, { idempotencyKey: randomUUID() }),
      (error: unknown) => error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "invalid_payload"
        && error.rejection.path === "scope");
    await assert.rejects(call("publish_shared_asset", assetProposal), (error: unknown) =>
      error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "IDEMPOTENCY_KEY_REQUIRED");
    assert.deepEqual(sharedAssetPublicationState(), { inputs: [], reads: 0 });
    await call("mark_job_done", done);
  });
});

test("executeReal: malformed publish result stops as unknown instead of using the operation event id as a version", async () => {
  await runExecutor(async () => {
    setSharedAssetPublication({ result: { id: assetIdentity.asset.id, current_version: 2, content_sha256: assetIdentity.version.content_sha256 } });
    await assert.rejects(call("publish_shared_asset", assetProposal, { idempotencyKey: randomUUID() }), (error: unknown) =>
      error instanceof PlatformRuntimeHandlerError && error.rejection?.category === "unknown_external_effect"
        && error.rejection.retryable === false);
    await call("mark_job_done", done);
  });
});

test("executeReal: missing completion persists scoped evidence and keeps failure authoritative", async () => {
  await assert.rejects(runExecutor(async () => {}), (error: unknown) => {
    if (!(error instanceof Error)) throw error;
    assert.ok(error instanceof Error);
    assert.match(error.message, /^AGENT_COMPLETION_UNOBSERVED:/);
    assert.match(error.message, /diagnostic=persisted/);
    return true;
  });
  const [diagnostic] = completionDiagnosticEvidence();
  assert.ok(diagnostic); assert.equal(diagnostic.job_id, jobId); assert.equal(diagnostic.attempt_id, attemptId);
  assert.equal(diagnostic.completion_state, "no_durable_receipt_observed");
  assert.equal((diagnostic.reason as { phase: string }).phase, "completion_missing");
  assert.equal(terminalBundleCalls(), 0); assert.deepEqual(terminalEvents(), []);
});

test("executeReal: runner exception persists diagnostics without replacing the original cause", async () => {
  const failure = new Error("original runner failure");
  await assert.rejects(runExecutor(async () => { throw failure; }), (error: unknown) => error === failure);
  const [diagnostic] = completionDiagnosticEvidence();
  assert.ok(diagnostic); assert.equal((diagnostic.reason as { phase: string }).phase, "runner_exception");
  assert.equal(terminalBundleCalls(), 0); assert.deepEqual(terminalEvents(), []);
});

test("executeReal: accepted normal completion creates no missing-completion diagnostic", async () => {
  await runExecutor(async () => {
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
  });
  assert.equal(terminalBundleCalls(), 1); assert.deepEqual(completionDiagnosticEvidence(), []);
});
test("#958 executeReal passes the frozen Pi budget and fences prepared/accepted completion without another SQL read", async () => {
  const budget: import("@deepsonar/shared-types").ModelTokenBudget = {
    context_window_tokens: { configured: null, declared: 1_000_000, effective: 1_000_000, source: "provider_declared" },
    max_output_tokens: { configured: 64_000, declared: null, effective: 64_000, source: "credential_settings" },
    catalog_revision: "fixture:958",
  };
  const terminals = await runExecutor(async () => {
    assert.deepEqual(frozenRuntimeBudget(), budget);
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    assert.deepEqual(await piRecoveryAllowed(), { allowed: false, reason: "terminal_prepared" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    assert.equal(completionReady(), true);
    assert.deepEqual(await piRecoveryAllowed(), { allowed: false, reason: "completion_accepted" });
  }, "role", false, "pi", budget);
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
  assert.deepEqual(completionDiagnosticEvidence(), []);
});

test("#958 executeReal leaves historical Pi budget unknown and prevents recovery after accepted human", async () => {
  const terminals = await runExecutor(async () => {
    assert.equal(frozenRuntimeBudget(), undefined);
    await call("request_human", human);
    assert.equal(completionReady(), false);
    assert.deepEqual(await piRecoveryAllowed(), { allowed: false, reason: "waiting_human" });
  }, "role", false, "pi");
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function exclusive(error: unknown) {
  return error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "duplicate_tool_call";
}

test("executeReal: completion committed during human preflight wins without dual acceptance", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHuman = call("request_human", human);
    // Attach the rejection observer before releasing either concurrent request.
    const rejected = assert.rejects(pendingHuman, exclusive);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    assert.equal(completionReady(), false);
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    assert.equal(completionReady(), true);
    resume.release();
    await rejected;
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
  assert.equal((terminals[0].payload as { summary: string }).summary, done.summary);
});

test("executeReal: first accepted human cannot be overwritten by a preflight already in flight", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const firstId = randomUUID();
  const terminals = await runExecutor(async () => {
    let preflightCalls = 0;
    setPreflight(async () => { if (++preflightCalls === 1) { entered.release(); await resume.promise; } });
    const lateHuman = call("request_human", { ...human, reason: "This stale request must not replace the accepted human." });
    const rejected = assert.rejects(lateHuman, exclusive);
    await entered.promise;
    const accepted = await call("request_human", human, { eventId: firstId }) as { accepted: boolean };
    assert.equal(accepted.accepted, true);
    resume.release();
    await rejected;
  });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, "human");
  assert.equal(terminals[0].event_id, firstId);
  assert.equal((terminals[0].payload as { reason: string }).reason, human.reason);
  assert.deepEqual((terminals[0].payload as { guidance: typeof humanGuidance }).guidance, human.guidance);
});

test("executeReal: accepted human rejects both completion prepare and commit", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    await call("request_human", human);
    await assert.rejects(call("mark_job_done", done, { completionPhase: "prepare" }), (error: unknown) => {
      if (!(error instanceof PlatformRuntimeHandlerError)) throw error;
      assert.ok(error instanceof PlatformRuntimeHandlerError);
      assert.equal(error.rejection?.category, "permanent_failure");
      assert.equal(error.rejection?.retryable, false);
      assert.equal(error.rejection?.details?.accepted_terminal, "human");
      assert.match(error.rejection?.next_action ?? "", /等待原提案结算/);
      return exclusive(error);
    });
    await assert.rejects(call("mark_job_done", done, { completionPhase: "commit" }), exclusive);
    assert.equal(completionReady(), false);
  });
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: prepared completion blocks human until the matching reservation is aborted", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    assert.equal(completionReady(), false, "prepare never commits done");
    await assert.rejects(call("request_human", human), exclusive);
    await call("mark_job_done", done, { eventId: randomUUID(), completionPhase: "abort" });
    await assert.rejects(call("request_human", human), exclusive, "another proposal cannot release the reservation");
    await call("mark_job_done", done, { eventId, completionPhase: "abort" });
    await call("request_human", human);
    assert.equal(completionReady(), false);
  });
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: preparation during human preflight blocks it even before commit", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHuman = call("request_human", human);
    const rejected = assert.rejects(pendingHuman, exclusive);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    resume.release();
    await rejected;
    assert.equal(completionReady(), false);
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
});

test("executeReal: failed human preflight does not reserve a terminal outcome", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { throw new Error("offline preflight rejected"); });
    await assert.rejects(call("request_human", human),
      (error: unknown) => error instanceof PlatformRuntimeHandlerError && error.code === "HANDLER_FAILED");
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    assert.equal(completionReady(), true);
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
});

const hub = { complete: { from: [rootId], description: "Offline objective is complete." } };
const completionRefusal = "409 Completion already accepted; reconcile its receipt";
const structuredRefusal: RealAgentResult = { text: "", files: {}, errorKind: "runner",
  ...resolveTerminalProcessOutcome({ exitCode: 0,
    terminalResult: { isError: true, errorDetail: completionRefusal } }) };

function piMessageFailure(errorMessage: string, state = {}): RealAgentResult {
  const adapter = getAgentCliRuntimeAdapter("pi");
  assert.ok(adapter);
  const [terminal] = adapter.decodeOutput({ type: "message_end", message: {
    role: "assistant", stopReason: "error", errorMessage,
  } }, state);
  assert.equal(terminal.type, "result");
  assert.equal(terminal.is_error, true);
  assert.ok(typeof terminal.result === "string");
  assert.equal(terminal.runnerErrorSource, undefined);
  // Mirror runtime-agent's structured-result normalization, without inventing the error string.
  return { text: "", files: {}, errorKind: "runner",
    ...resolveTerminalProcessOutcome({ exitCode: 0,
      terminalResult: { isError: true, errorDetail: terminal.result } }) };
}
const piRefusal = piMessageFailure("409: Completion already accepted; reconcile its receipt");

test("executeReal: Pi allowance completion refusal reaches the original accepted settlement", async () => {
  // Only the SDK stream container is a double. Run the generated host extension,
  // real HTTP allowance read, Pi decoder and executor completion gate together.
  const { PI_MAIN_REQUEST_BUDGET_SOURCE } = await import(new URL(
    "../../../packages/runtime-sandbox/src/pi-main-request-budget.ts", import.meta.url).href);
  const sdk = `export function createAssistantMessageEventStream() {
    const events = []; let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    return { push: event => events.push(event), end: () => finish(),
      async *[Symbol.asyncIterator]() { await ended; yield* events; } };
  }
  export function streamSimple() { throw new Error('SDK must not be called after completion'); }`;
  const sdkUrl = `data:text/javascript;base64,${Buffer.from(sdk).toString("base64")}`;
  const source = PI_MAIN_REQUEST_BUDGET_SOURCE.replace("'@earendil-works/pi-ai/compat'", JSON.stringify(sdkUrl));
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  let queries = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/gateway/_allowance");
    assert.equal(req.headers.authorization, "Bearer synthetic-main-token");
    assert.equal(completionReady(), true);
    queries++;
    res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({
      error: { type: "COMPLETION_ALREADY_ACCEPTED", message: "untrusted diagnostic" },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
    const model = { provider: "synthetic", id: "synthetic", api: "openai-completions", baseUrl };
    let start!: (event: unknown, ctx: unknown) => void;
    let stream!: (...args: unknown[]) => AsyncIterable<{ error: { errorMessage: string } }>;
    module.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: baseUrl,
      DEEPSONAR_GATEWAY_TOKEN: "synthetic-main-token" })({
      on: (_event: string, handler: typeof start) => { start = handler; },
      registerProvider: (_provider: string, config: { streamSimple: typeof stream }) => { stream = config.streamSimple; },
    });
    start({}, { model, modelRegistry: { getAll: () => [] } });
    const terminals = await runExecutor(async () => {
      await acceptHubAndDone();
      const events = [];
      for await (const event of stream(model, { messages: [] }, {})) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.error.errorMessage, "COMPLETION_ALREADY_ACCEPTED");
      const adapter = getAgentCliRuntimeAdapter("pi");
      assert.ok(adapter);
      const state = { failed: false };
      assert.deepEqual(adapter.decodeOutput({ type: "message_update", assistantMessageEvent: {
        type: "error", error: events[0]!.error,
      } }, state), [], "the SDK update must not terminate the original accepted completion");
      assert.equal(state.failed, false);
      return piMessageFailure(events[0]!.error.errorMessage, state);
    }, "hub", false, "pi");
    assert.equal(queries, 1);
    assert.equal(terminalBundleCalls(), 1);
    assert.deepEqual(terminals.map(event => event.payload), [hub, done]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function acceptHubAndDone() {
  const hubId = randomUUID(), doneId = randomUUID();
  await call("submit_hub_decision", hub, { eventId: hubId });
  await call("mark_job_done", done, { eventId: doneId, completionPhase: "prepare" });
  await call("mark_job_done", done, { eventId: doneId, completionPhase: "commit" });
  await call("mark_job_done", done, { eventId: doneId, completionPhase: "commit" });
  assert.equal(completionReady(), true);
  return [hubId, doneId];
}

for (const [format, result] of [
  ["409 space", structuredRefusal], ["Pi message_end 409 colon", piRefusal],
  ["Pi allowance code", piMessageFailure("COMPLETION_ALREADY_ACCEPTED")],
  // #1045: the CLI exits 1 after the SDK's exact completion refusal; the accepted
  // completion must still settle, whether the exit is framed locally or synthesized.
  ["Pi exit 1 after structured allowance refusal", { text: "", files: {}, errorKind: "runner" as const,
    ...resolveTerminalProcessOutcome({ exitCode: 1, terminalResult: { isError: true,
      errorDetail: "Pi message ended: error: COMPLETION_ALREADY_ACCEPTED" } }) }],
  ["Pi exit 1 locally framed refusal", { text: "", files: {}, errorKind: "runner" as const,
    error: "agent CLI 退出码 1: Pi message ended: error: COMPLETION_ALREADY_ACCEPTED",
    runnerErrorSource: "process", terminalOutcome: "failure" }],
] as const) {
  test(`executeReal: ${format} refusal settles the original accepted Hub/done exactly once`, async () => {
    let ids: string[] = [];
    const terminals = await runExecutor(async () => {
      ids = await acceptHubAndDone();
      return result;
    }, "hub");
    assert.equal(terminalBundleCalls(), 1);
    assert.deepEqual(terminals.map(event => event.type), ["hub_decision", "done"]);
    assert.deepEqual(terminals.map(event => event.event_id), ids);
    assert.deepEqual(terminals.map(event => event.payload), [hub, done]);
  });

  for (const phase of ["none", "prepare"] as const) {
    test(`executeReal: ${format} refusal with ${phase} completion does not finalize`, async () => {
      await assert.rejects(runExecutor(async () => {
        await call("submit_hub_decision", hub);
        if (phase === "prepare") await call("mark_job_done", done, { completionPhase: "prepare" });
        assert.equal(completionReady(), false);
        return result;
      }, "hub"), { message: `agent 运行失败: ${result.error}` });
      assert.equal(terminalBundleCalls(), 0);
      assert.deepEqual(terminalEvents(), []);
    });
  }
}

const rejectedResults: Array<[string, RealAgentResult]> = [
  ...[0, 137].map(exitCode => [`exit ${exitCode} without structured terminal`, {
    text: "", files: {}, errorKind: "runner" as const,
    ...resolveTerminalProcessOutcome({ exitCode, stderrTail: completionRefusal }),
  }] as [string, RealAgentResult]),
  ["exit 137 after structured refusal", { text: "", files: {}, errorKind: "runner",
    ...resolveTerminalProcessOutcome({ exitCode: 137, closeReason: "terminal_result",
      terminalResult: { isError: true, errorDetail: completionRefusal } }) }],
  ["transport error", { ...structuredRefusal, runnerErrorSource: "process" }],
  ["missing provenance", { ...structuredRefusal, runnerErrorSource: undefined }],
  ["arbitrary structured diagnostic", { ...structuredRefusal, error: `unrelated diagnostic: ${completionRefusal}` }],
  ["semantic failure", { ...structuredRefusal, errorKind: "semantic" }],
  // #1045 accepts an exact refusal behind a locally framed ordinary exit; bare process
  // diagnostics, kill signals and any non-refusal text keep failing closed (#1016).
  ["Pi colon refusal with bare process failure", { ...piRefusal, runnerErrorSource: "process" }],
  ["Pi colon refusal without provenance", { ...piRefusal, runnerErrorSource: undefined }],
  ["Pi colon refusal with semantic failure", { ...piRefusal, errorKind: "semantic" }],
  ["unrelated process failure after accepted completion", { text: "", files: {}, errorKind: "runner",
    error: "agent CLI 退出码 1: PI_MAIN_BUDGET_EXHAUSTED", runnerErrorSource: "process", terminalOutcome: "failure" }],
  ["refusal text with trailing diagnostic", { text: "", files: {}, errorKind: "runner",
    error: "agent CLI 退出码 1: Pi message ended: error: COMPLETION_ALREADY_ACCEPTED (retry suppressed)",
    runnerErrorSource: "process", terminalOutcome: "failure" }],
  ["Pi colon refusal after exit 137", { ...piRefusal,
    ...resolveTerminalProcessOutcome({ exitCode: 137, closeReason: "terminal_result",
      terminalResult: { isError: true, errorDetail: piRefusal.error } }) }],
  ["Pi repair usage not settled", piMessageFailure("409: Repair usage is not settled; reconcile the existing request before continuing")],
  ["Pi unrelated 409", piMessageFailure("409: Request rejected; inspect its policy")],
  ...["cancelled", "timeout", "lease expired", "COMPLETION_EFFECT_UNKNOWN"].map(reason => [reason,
    { ...structuredRefusal, error: `${reason}: ${completionRefusal}` }] as [string, RealAgentResult]),
];
for (const [name, result] of rejectedResults) {
  test(`executeReal: accepted Hub/done cannot swallow ${name}`, async () => {
    await assert.rejects(runExecutor(async () => {
      await acceptHubAndDone();
      return result;
    }, "hub"), /agent 运行失败:/);
    assert.equal(terminalBundleCalls(), 0);
    assert.deepEqual(terminalEvents(), []);
  });
}

test("executeReal: human accepted during Hub preflight rejects the late Hub", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async type => { if (type === "hub_decision") { entered.release(); await resume.promise; } });
    const pendingHub = call("submit_hub_decision", hub);
    const rejected = assert.rejects(pendingHub, exclusive);
    await entered.promise;
    await call("request_human", human);
    resume.release();
    await rejected;
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: late Hub preflight cannot replace the first accepted Hub", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const firstId = randomUUID();
  const terminals = await runExecutor(async () => {
    let calls = 0;
    setPreflight(async () => { if (++calls === 1) { entered.release(); await resume.promise; } });
    const pendingHub = call("submit_hub_decision", { complete: { ...hub.complete, description: "Stale decision must not overwrite." } });
    const rejected = assert.rejects(pendingHub, exclusive);
    await entered.promise;
    await call("submit_hub_decision", hub, { eventId: firstId });
    resume.release();
    await rejected;
    await call("mark_job_done", done, { completionPhase: "commit" });
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["hub_decision", "done"]);
  assert.equal(terminals[0].event_id, firstId);
  assert.deepEqual(terminals[0].payload, hub);
});

test("executeReal: completion during Hub preflight still permits the Hub decision", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHub = call("submit_hub_decision", hub);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    resume.release();
    assert.equal((await pendingHub as { accepted: boolean }).accepted, true);
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["hub_decision", "done"]);
});

test("executeReal: runner failure unregisters a prepared handler and rejects late input", { timeout: 5000 }, async () => {
  const failure = new Error("offline runner exited unexpectedly");
  // The runner deliberately omits its disposer: exercise executeReal outer finally.
  await assert.rejects(runExecutor(async () => {
    await call("mark_job_done", done, { completionPhase: "prepare" });
    assert.equal(completionReady(), false);
    throw failure;
  }, "role", true), (error: unknown) => error === failure);
  await assert.rejects(call("mark_job_done", done, { completionPhase: "commit" }),
    (error: unknown) => error instanceof PlatformRuntimeHandlerError && error.code === "HANDLER_NOT_REGISTERED");
  assert.equal(completionReady(), false, "late input cannot open the old completion gate");
});

const planHuman = { reason: 'Current evidence needs an operator decision.',
  guidance: humanGuidance,
  subject: {type:'platform_blocker',kind:'business_decision'},
  plan_basis: {v:1,plan_job_id:randomUUID(),plan_sha256:'a'.repeat(64),criterion_id:'completion',expected_revision:'1',
    expected_task_input_sha256:'b'.repeat(64),expected_projection_sha256:'c'.repeat(64),source_refs:[],outcome:'needs_human',rationale:'Evidence is insufficient for completion.'} };

test('executeReal: durable Plan prepare is local-only and blocks an older human preflight', {timeout:5000}, async()=>{
  const {attemptId}=await import('./executor-real-terminal-race.fixture.js');
  const entered=barrier(),resume=barrier(),eventId=randomUUID();
  const terminals=await runExecutor(async()=>{
    setPreflight(async()=>{entered.release();await resume.promise;});
    const late=call('request_human',human);
    const rejected=assert.rejects(late,exclusive);
    await entered.promise;
    // The database-aware validate phase already ran before the transaction.
    const prepared=await call('request_human',planHuman,{eventId,planPhase:'prepare',planAttemptId:attemptId}) as {plan_prepared:boolean};
    assert.equal(prepared.plan_prepared,true);
    resume.release();await rejected;
    await assert.rejects(call('request_human',human,{eventId}),exclusive);
    await assert.rejects(call('mark_job_done',done,{eventId,completionPhase:'prepare'}),exclusive);
    setPreflight(async()=>{throw new Error('commit must not reacquire a pool connection');});
    await call('request_human',planHuman,{eventId,planPhase:'commit',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId,planPhase:'commit',planAttemptId:attemptId});
  });
  assert.equal(terminals.length,1);assert.equal(terminals[0].type,'human');
  assert.equal(terminals[0].event_id,eventId);assert.deepEqual((terminals[0].payload as typeof planHuman).plan_basis,planHuman.plan_basis);
  assert.deepEqual((terminals[0].payload as typeof planHuman).guidance,planHuman.guidance);
});

test('executeReal: failed Plan persistence releases only its own reservation', {timeout:5000},async()=>{
  const {attemptId}=await import('./executor-real-terminal-race.fixture.js');
  const eventId=randomUUID();
  const terminals=await runExecutor(async()=>{
    await call('request_human',planHuman,{eventId,planPhase:'validate',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId,planPhase:'prepare',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId:randomUUID(),planPhase:'abort',planAttemptId:attemptId});
    await assert.rejects(call('mark_job_done',done,{completionPhase:'prepare'}),exclusive);
    await call('request_human',planHuman,{eventId,planPhase:'abort',planAttemptId:attemptId});
    await call('request_human',human);
  });
  assert.equal(terminals.length,1);assert.equal((terminals[0].payload as typeof human).reason,human.reason);
});
