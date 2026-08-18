import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import {
  mapCliEvent,
  redactToolTelemetry,
  redactRuntimeSecrets,
  DEFAULT_SEMANTIC_TOOL_EVENTS,
  CLI_SESSION_RESUME_MAX_ATTEMPTS,
  CLI_SESSION_RESUME_BASE_DELAY_MS,
  CLI_SESSION_RESUME_MAX_DELAY_MS,
  classifyCliSessionResumeError,
  cliSessionResumeDelayMs,
  createSemanticToolState,
  discardPendingSemanticTools,
  skillMaterializationPath,
  materializationPathCollisions,
  normalizeRuntimeErrorDetails,
  resolveTerminalRunError,
  resolveTerminalProcessOutcome,
  parseRuntimeLine,
  parseDeepSonarContainerRows,
  runtimeCliEnv,
  assertSharedAssetsContainerMount,
  assertSharedAssetsVolumeOwnership,
  sharedAssetsVolumeBinds,
  isDeepsonarRestrictedNetwork,
  isDeepsonarGatewayNetwork,
  dockerSocketPath,
  ensureRuntimeHome,
  buildTerminalShellCommand,
  bindProvisionAbortSignal,
  terminalShellCommand,
  writeTerminalInput,
  GATEWAY_PROXY_REVISION,
  GATEWAY_PROXY_SCRIPT,
  gatewayLeftoverRemovalTarget,
  gatewayCreateTimeoutMs,
  gatewayProxyReuseAction,
  shouldRemoveGatewayLeftover,
  AgentboxRunner,
  BoundedRuntimeStderrEvidence,
  RUNTIME_STDERR_EVIDENCE_MAX_BYTES,
  CONTAINER_REMOVE_MAX_ATTEMPTS,
  CONTAINER_REMOVE_RETRY_BASE_DELAY_MS,
  mergeObservedSessionIdentity,
  normalizePlainFinalOutput,
  removeContainerWithRetry,
} from "./agentbox.js";

test("container force removal retries exponentially and reports exhaustion", async () => {
  const calls: string[][] = [];
  const delays: number[] = [];
  const failure = new Error("daemon busy");
  await assert.rejects(
    removeContainerWithRetry(
      "container-id",
      async (...args) => {
        calls.push(args);
        throw failure;
      },
      async (delay) => {
        delays.push(delay);
      },
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(calls.length, CONTAINER_REMOVE_MAX_ATTEMPTS);
  assert.deepEqual(
    delays,
    Array.from(
      { length: CONTAINER_REMOVE_MAX_ATTEMPTS - 1 },
      (_, index) => CONTAINER_REMOVE_RETRY_BASE_DELAY_MS * 2 ** index,
    ),
  );
});

test("container force removal treats only explicit no-such as idempotent success", async () => {
  let attempts = 0;
  await removeContainerWithRetry("gone", async () => {
    attempts += 1;
    throw new Error("Error response from daemon: No such container: gone");
  });
  assert.equal(attempts, 1);
});

test("Agentbox destroy propagates authoritative container removal failure", async () => {
  const failure = new Error("vfs removal failed");
  const runner = new AgentboxRunner(async () => {
    throw failure;
  });
  await assert.rejects(
    runner.destroy({ sandboxId: "leftover" }),
    (error: unknown) =>
      error instanceof AggregateError
      && error.errors.includes(failure),
  );
});

test("managed container parsing requires canonical Job and Attempt labels", () => {
  const jobId = "11111111-1111-4111-8111-111111111111";
  const attemptId = "22222222-2222-4222-8222-222222222222";
  const rows = parseDeepSonarContainerRows([
    `kept\tdeepsonar.job=${jobId},deepsonar.attempt=${attemptId}\texited`,
    `missing-attempt\tdeepsonar.job=${jobId}\texited`,
    `bad-job\tdeepsonar.job=not-a-uuid,deepsonar.attempt=${attemptId}\texited`,
    `bad-attempt\tdeepsonar.job=${jobId},deepsonar.attempt=not-a-uuid\texited`,
  ].join("\n"));
  assert.deepEqual(rows, [{
    containerId: "kept",
    jobId,
    attemptId,
    state: "exited",
  }]);
});
import { NoopRunner } from "./index.js";
import { CLI_SESSION_ADAPTERS, type SessionDiscoveryRuntime } from "./cli-session-adapters.js";

type GatewayResponse = { statusCode?: number; body: string };

test("运行时会话身份首次绑定、延迟补充文件且禁止切换", () => {
  const initial = mergeObservedSessionIdentity(undefined, { sessionId: "session-1" });
  assert.deepEqual(initial, { sessionId: "session-1" });
  const withFile = mergeObservedSessionIdentity(initial, {
    sessionId: "session-1",
    sessionFile: "/workspace/.deepsonar-home/.pi/agent/session.jsonl",
  });
  assert.deepEqual(withFile, {
    sessionId: "session-1",
    sessionFile: "/workspace/.deepsonar-home/.pi/agent/session.jsonl",
  });
  assert.equal(mergeObservedSessionIdentity(withFile, { sessionId: "session-1" }), withFile);
  assert.throws(() => mergeObservedSessionIdentity(withFile, { sessionId: "session-2" }), /CONTEXT_SESSION_IDENTITY_CHANGED/);
  assert.throws(
    () => mergeObservedSessionIdentity(withFile, { sessionId: "session-1", sessionFile: "/workspace/other.jsonl" }),
    /CONTEXT_SESSION_FILE_CHANGED/,
  );
});

function requestGateway(
  port: number,
  requestPath: string,
  method = "GET",
  body?: string,
  headers?: Record<string, string>,
): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("aborted", () => reject(new Error("网关响应已中止")));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function reserveHttpPort(): Promise<number> {
  const server = http.createServer();
  const port = await listenHttpServer(server);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function listenHttpServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得测试端口");
  return address.port;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startGatewayProxy(upstreamUrl: string): Promise<{
  child: ReturnType<typeof spawn>;
  port: number;
  stderr: () => string;
}> {
  const port = await reserveHttpPort();
  const script = GATEWAY_PROXY_SCRIPT.replace(
    'server.listen(3100, "0.0.0.0");',
    `server.listen(${port}, "127.0.0.1");`,
  );
  if (script === GATEWAY_PROXY_SCRIPT) throw new Error("测试未能替换 Gateway proxy 监听端口");
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, DEEPSONAR_GATEWAY_UPSTREAM: upstreamUrl },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`网关代理启动失败: ${errors.join("")}`);
    try {
      const health = await requestGateway(port, "/_deepsonar_health");
      if (health.statusCode === 200 && health.body === "ok") {
        return { child, port, stderr: () => errors.join("") };
      }
    } catch {
      // 子进程刚启动时端口尚未监听，继续短暂重试。
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill();
  throw new Error(`网关代理健康检查超时: ${errors.join("")}`);
}

async function stopGatewayProxy(proxy: Awaited<ReturnType<typeof startGatewayProxy>>): Promise<void> {
  if (proxy.child.exitCode === null) proxy.child.kill();
  if (proxy.child.exitCode === null) await once(proxy.child, "exit").catch(() => {});
}

test("terminal shell command prefers interactive Bash and safely falls back to interactive /bin/sh", () => {
  assert.equal(terminalShellCommand("bash"), "exec bash -il");
  assert.equal(terminalShellCommand("sh"), "exec /bin/sh -i");
  assert.equal(
    buildTerminalShellCommand(),
    "if command -v bash >/dev/null 2>&1; then exec bash -il; else exec /bin/sh -i; fi",
  );
});

test("Noop provision 遵守 Attempt 标识并响应取消信号", async () => {
  const runner = new NoopRunner();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runner.provision({ jobId: "job-1", attemptId: "attempt-1", image: "image", network: "none", signal: controller.signal }),
    /provision 已取消/,
  );
  assert.equal(typeof (new AgentboxRunner() as { cancelProvision?: unknown }).cancelProvision, "function");
});

test("provision abort 绑定不丢失已发生的取消且只清理一次", () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let immediateCalls = 0;
  bindProvisionAbortSignal(alreadyAborted.signal, () => { immediateCalls += 1; });
  assert.equal(immediateCalls, 1);

  const delayed = new AbortController();
  let delayedCalls = 0;
  const unbind = bindProvisionAbortSignal(delayed.signal, () => { delayedCalls += 1; });
  delayed.abort();
  delayed.abort();
  assert.equal(delayedCalls, 1);
  unbind();
});

test("terminal input writes raw tab, backspace, and Ctrl+C bytes without translation", async () => {
  const writes: string[] = [];
  const process = { write: async (input: string) => { writes.push(input); } };
  const input = "\t\b\u007f\u0003";
  await writeTerminalInput(process, input);
  assert.deepEqual(writes, [input]);
});

test("terminal input rejects a process without an active stdin channel", async () => {
  await assert.rejects(
    () => writeTerminalInput({}, "\u0003"),
    /TERMINAL_SESSION_CLOSED/,
  );
});

test("completion-gate terminal outcomes replace stale Provider errors", () => {
  let runError = resolveTerminalRunError({ isError: true, errorDetail: "Provider 429" });
  assert.equal(runError, "Provider 429");
  runError = resolveTerminalRunError({ isError: false });
  assert.equal(runError, undefined);
  runError = resolveTerminalRunError({ isError: true, errorDetail: "last attempt failed" });
  assert.equal(runError, "last attempt failed");
});

test("completion-gate attempts keep the last process exit authoritative", () => {
  const firstAttempt = resolveTerminalProcessOutcome({
    exitCode: 0,
    terminalResult: { isError: true, errorDetail: "Provider 429" },
  });
  assert.deepEqual(firstAttempt, {
    observed: true,
    error: "Provider 429",
    terminalOutcome: "failure",
  });

  // The old attempt produced text, but the resumed CLI process did not
  // produce a terminal result and exited non-zero.  That exit is the final
  // authoritative failure; prior text must not make it look successful.
  const finalAttempt = resolveTerminalProcessOutcome({
    finalText: "old terminal text from the previous attempt",
    exitCode: 17,
    terminalResult: undefined,
    closeReason: undefined,
    stderrTail: "provider closed the session",
  });
  assert.deepEqual(finalAttempt, {
    observed: true,
    error: "agent CLI 退出码 17: provider closed the session",
    terminalOutcome: "failure",
  });
});

test("intentional stdin close after a valid terminal result is not a runner failure", () => {
  assert.deepEqual(resolveTerminalProcessOutcome({
    exitCode: 1,
    terminalResult: { isError: false },
    closeReason: "terminal_result",
  }), {
    observed: true,
    terminalOutcome: "success",
  });
  assert.deepEqual(resolveTerminalProcessOutcome({
    exitCode: 1,
    terminalResult: { isError: false },
    closeReason: undefined,
  }), {
    observed: true,
    error: "agent CLI 退出码 1",
    terminalOutcome: "failure",
  });
});

test("a clean process exit without a structured terminal result is a runner failure", () => {
  assert.deepEqual(resolveTerminalProcessOutcome({
    finalText: "buffered agent output",
    exitCode: 0,
    terminalResult: undefined,
    stderrTail: "",
  }), {
    observed: true,
    error: "agent CLI exited without a structured terminal result",
    terminalOutcome: "failure",
  });
});

test("plain-final output synthesizes only a normalized successful result", () => {
  const observedSemanticEvents: Record<string, unknown>[] = [];
  const result = normalizePlainFinalOutput(
    "  final answer from dsh\r\n",
    "provider warning\n",
    0,
    (event) => observedSemanticEvents.push(event),
  );
  assert.equal(result.text, "final answer from dsh");
  assert.equal(result.stderr, "provider warning\n");
  assert.deepEqual(result.events, [
    { type: "run.started" },
    { type: "run.completed", text: "final answer from dsh" },
    { type: "run.settled" },
  ]);
  assert.deepEqual(observedSemanticEvents, []);
});

test("plain-final output fails closed when the completion gate is unsatisfied", () => {
  const result = normalizePlainFinalOutput(
    "final answer from dsh",
    "",
    0,
    undefined,
    { adapterId: "dsh", completionGate: false },
  );
  assert.equal(result.error, "AGENT_CLI_COMPLETION_GATE_UNSATISFIED: dsh");
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(result.events.some((event) => event.type === "run.completed"), false);
  assert.equal(result.events.at(-1)?.type, "run.failed");
  assert.equal(result.events.some((event) => event.type === "run.retrying"), false);
});

test("plain-final output rejects an empty successful stdout", () => {
  const result = normalizePlainFinalOutput(
    " \r\n",
    "provider diagnostic",
    0,
    undefined,
    { adapterId: "dsh", completionGate: true },
  );
  assert.equal(result.error, "AGENT_CLI_PLAIN_OUTPUT_EMPTY: dsh");
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(result.events.some((event) => event.type === "run.completed"), false);
  assert.equal(result.events.at(-1)?.type, "run.failed");
  assert.equal(result.stderr, "provider diagnostic");
});

test("plain-final output is bounded at 1 MiB and preserves stderr on failure", () => {
  assert.throws(
    () => normalizePlainFinalOutput("x".repeat(1024 * 1024 + 1), "diagnostic", 0, () => {}),
    /AGENT_CLI_PLAIN_OUTPUT_TOO_LARGE/u,
  );
  const failed = normalizePlainFinalOutput("partial", "fatal diagnostic", 17, () => {});
  assert.equal(failed.text, "partial");
  assert.equal(failed.stderr, "fatal diagnostic");
  assert.equal(failed.events.at(-1)?.type, "run.failed");
});

test("runtime stderr evidence is complete, redacted across chunks, and bounded", () => {
  const events: Array<Record<string, unknown>> = [];
  const secret = "deepsonar-job-secret";
  const stderr = new BoundedRuntimeStderrEvidence([secret], (event) => events.push(event), 32);
  stderr.push(`before ${secret.slice(0, 10)}`);
  stderr.push(`${secret.slice(10)} after ${"界".repeat(20)}`);
  stderr.finish();

  const captured = events
    .filter((event) => event.type === "runtime.stderr")
    .map((event) => String(event.chunk ?? ""))
    .join("");
  assert.equal(captured.includes(secret), false);
  assert.match(captured, /^before \[REDACTED\] after /u);
  assert.ok(Buffer.byteLength(captured, "utf8") <= 32);
  assert.deepEqual(events.at(-1), {
    type: "runtime.stderr.truncated",
    captured_bytes: Buffer.byteLength(captured, "utf8"),
    max_bytes: 32,
  });
});

test("runtime stderr evidence default budget is 1 MiB and keeps short streams losslessly", () => {
  const events: Array<Record<string, unknown>> = [];
  const stderr = new BoundedRuntimeStderrEvidence([], (event) => events.push(event));
  stderr.push("first chunk\n");
  stderr.push("second chunk\n");
  stderr.finish();
  assert.equal(RUNTIME_STDERR_EVIDENCE_MAX_BYTES, 1024 * 1024);
  assert.equal(events.map((event) => String(event.chunk ?? "")).join(""), "first chunk\nsecond chunk\n");
  assert.equal(events.some((event) => event.type === "runtime.stderr.truncated"), false);
});

test("CLI 同会话恢复只接受明确的临时上游错误", () => {
  for (const message of [
    "HTTP 408 Request Timeout",
    "status_code=429",
    "502 Bad Gateway",
    "provider returned HTTP 500",
    "upstream status: 503",
    "response status 504 Gateway Timeout",
  ]) {
    assert.equal(classifyCliSessionResumeError(message), "http", message);
  }
  assert.equal(classifyCliSessionResumeError("TimeoutError: request timed out"), "timeout");
  assert.equal(classifyCliSessionResumeError("network error: ECONNRESET"), "network");
  assert.equal(classifyCliSessionResumeError({ status: 502, message: "provider failed" }), "http");

  for (const message of [
    "HTTP 400 Bad Request",
    "status_code=401",
    "provider returned 403 Forbidden",
    "HTTP 400 network error",
    "agent CLI 退出码 17",
    "spawn claude ENOENT",
    "AbortError: operation was aborted",
  ]) {
    assert.equal(classifyCliSessionResumeError(message), undefined, message);
  }
  assert.equal(classifyCliSessionResumeError({ status: 401, message: "network error" }), undefined);
});

test("CLI 同会话恢复退避有界且最多三次", () => {
  assert.equal(CLI_SESSION_RESUME_MAX_ATTEMPTS, 3);
  assert.equal(CLI_SESSION_RESUME_BASE_DELAY_MS, 1_000);
  assert.equal(CLI_SESSION_RESUME_MAX_DELAY_MS, 4_000);
  assert.deepEqual([1, 2, 3, 4, 99].map(cliSessionResumeDelayMs), [1_000, 2_000, 4_000, 4_000, 4_000]);
});

test("an incomplete control tool call never releases deferred semantic state", () => {
  const state = createSemanticToolState();
  const started = mapCliEvent({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "incomplete-done",
        name: "mcp__deepsonar-control__mark_job_done",
        input: { summary: "terminal proposal" },
      }],
    },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(started.semanticEvents, []);
  assert.equal(state.pendingToolUses.size, 1);

  const terminal = mapCliEvent({ type: "result", subtype: "success", result: "ordinary text" }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(terminal.semanticEvents, []);
  assert.equal(state.pendingToolUses.size, 1);
});

test("restricted network ownership accepts Docker and Podman inspect shapes", () => {
  assert.equal(isDeepsonarRestrictedNetwork({
    Internal: true,
    Driver: "bridge",
    Labels: { "deepsonar.managed": "true" },
    IPAM: { Config: [{ Gateway: "<nil>" }] },
  }), true);
  // Podman lower-case keys from some CLI paths
  assert.equal(isDeepsonarRestrictedNetwork({
    internal: true,
    driver: "bridge",
    labels: { "deepsonar.managed": "true" },
  }), true);
  assert.equal(isDeepsonarRestrictedNetwork({
    Internal: false,
    Driver: "bridge",
    Labels: { "deepsonar.managed": "true" },
  }), false);
  assert.equal(isDeepsonarRestrictedNetwork({
    Internal: true,
    Driver: "bridge",
    Labels: {},
  }), false);
  assert.equal(isDeepsonarRestrictedNetwork(null), false);
});

test("gateway network ownership accepts only a managed non-internal bridge", () => {
  assert.equal(isDeepsonarGatewayNetwork({
    Internal: false,
    Driver: "bridge",
    Labels: { "deepsonar.managed": "true" },
  }), true);
  assert.equal(isDeepsonarGatewayNetwork({
    internal: true,
    driver: "bridge",
    labels: { "deepsonar.managed": "true" },
  }), false);
  assert.equal(isDeepsonarGatewayNetwork({
    Internal: false,
    Driver: "bridge",
    Labels: {},
  }), false);
});

test("网关代理在上游连接失败且未发送响应头时返回 502", async () => {
  const upstreamPort = await reserveHttpPort();
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}/gateway`);
  try {
    const response = await requestGateway(proxy.port, "/gateway/v1/messages");
    assert.equal(response.statusCode, 502);
    assert.equal(response.body, "gateway unavailable");
    assert.equal(proxy.child.exitCode, null, proxy.stderr());
  } finally {
    await stopGatewayProxy(proxy);
  }
});

test("网关代理在上游响应流中断且已发送响应头时销毁响应，不重复写头", async () => {
  const upstream = http.createServer((_request, response) => {
    const socket = response.socket;
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
    setTimeout(() => socket?.destroy(), 20);
  });
  const upstreamPort = await listenHttpServer(upstream);
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}/gateway`);
  try {
    await assert.rejects(
      requestGateway(proxy.port, "/gateway/v1/messages"),
      /中止|aborted|socket hang up|ECONNRESET/,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(proxy.child.exitCode, null, proxy.stderr());
    assert.doesNotMatch(proxy.stderr(), /ERR_HTTP_HEADERS_SENT/);
  } finally {
    await stopGatewayProxy(proxy);
    await closeHttpServer(upstream);
  }
});

test("网关代理在客户端请求中止时销毁上游请求并保持进程运行", async () => {
  let resolveUpstreamClose!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { resolveUpstreamClose = resolve; });
  const upstream = http.createServer((request) => {
    request.once("close", resolveUpstreamClose);
  });
  const upstreamPort = await listenHttpServer(upstream);
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}/gateway`);
  try {
    await new Promise<void>((resolve) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "/gateway/v1/messages",
        method: "POST",
        headers: { "content-length": 1024 * 1024 },
      });
      const done = () => resolve();
      request.once("error", done);
      request.once("close", done);
      request.write("x".repeat(1024));
      setTimeout(() => request.destroy(), 20);
    });
    const closed = await Promise.race([
      upstreamClosed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(closed, true, "客户端中止后上游请求未关闭");
    assert.equal(proxy.child.exitCode, null, proxy.stderr());
  } finally {
    await stopGatewayProxy(proxy);
    await closeHttpServer(upstream);
  }
});

test("managed gateway proxy is replaced when its route implementation is stale", () => {
  const current = { managed: "true", upstreamHash: "upstream", revision: GATEWAY_PROXY_REVISION, running: "true" };
  assert.equal(gatewayProxyReuseAction(current, "upstream"), "reuse");
  assert.equal(gatewayProxyReuseAction({ ...current, running: "false" }, "upstream"), "start");
  assert.equal(gatewayProxyReuseAction({ ...current, running: "false", status: "created" }, "upstream"), "replace");
  assert.equal(gatewayProxyReuseAction({ ...current, revision: "legacy" }, "upstream"), "replace");
  assert.equal(gatewayProxyReuseAction({ ...current, upstreamHash: "old" }, "upstream"), "replace");
  assert.equal(gatewayProxyReuseAction({ ...current, managed: "" }, "upstream"), "reject");
});

test("网关清理只移除本次创建且不健康的受管容器", () => {
  const owned = {
    managed: "true",
    createOwner: "owner-this-run",
    expectedCreateOwner: "owner-this-run",
    status: "created" as const,
    healthy: false,
  };
  assert.equal(shouldRemoveGatewayLeftover(owned), true);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, status: "exited" }), true);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, status: "running", healthy: true }), false);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, status: "missing" }), false);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, managed: "" }), false);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, createOwner: "owner-other-run" }), false);
  assert.equal(shouldRemoveGatewayLeftover({ ...owned, expectedCreateOwner: null }), false);
  assert.equal(gatewayLeftoverRemovalTarget({ ...owned, id: "inspected-container-id" }), "inspected-container-id");
  assert.equal(gatewayLeftoverRemovalTarget({ ...owned, id: "inspected-container-id", managed: "" }), null);
  assert.equal(gatewayCreateTimeoutMs({ DEEPSONAR_GATEWAY_CREATE_TIMEOUT_SEC: "600" }), 600_000);
  assert.ok(gatewayCreateTimeoutMs({}) >= 600_000);
});

test("restricted gateway proxy forwards only /gateway and /control/v1 and preserves Authorization", async () => {
  const received: Array<{ path: string; authorization?: string }> = [];
  const upstream = http.createServer((request, response) => {
    received.push({ path: request.url ?? "", authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }).end('{"accepted":true}');
  });
  const upstreamPort = await listenHttpServer(upstream);
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}/gateway`);
  try {
    const control = await requestGateway(
      proxy.port,
      "/control/v1/jobs/job-1",
      "GET",
      undefined,
      { authorization: "Bearer runtime-secret" },
    );
    assert.equal(control.statusCode, 200);
    assert.deepEqual(received[0], { path: "/control/v1/jobs/job-1", authorization: "Bearer runtime-secret" });

    const gateway = await requestGateway(proxy.port, "/gateway/v1/messages");
    assert.equal(gateway.statusCode, 200);
    assert.equal(received[1]?.path, "/gateway/v1/messages");

    const management = await requestGateway(proxy.port, "/api/projects");
    assert.equal(management.statusCode, 404);
    assert.equal(received.length, 2);
  } finally {
    await stopGatewayProxy(proxy);
    await closeHttpServer(upstream);
  }
});

test("restricted gateway proxy rejects CONNECT even when the target is allowed", async () => {
  const upstream = http.createServer((_request, response) => response.writeHead(200).end("ok"));
  const upstreamPort = await listenHttpServer(upstream);
  const proxy = await startGatewayProxy(`http://127.0.0.1:${upstreamPort}/gateway`);
  try {
    const result = await new Promise<{ connected: boolean; statusCode?: number }>((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: "control/v1/jobs/job-1" });
      request.once("connect", () => resolve({ connected: true }));
      request.once("response", (response) => resolve({ connected: false, statusCode: response.statusCode }));
      request.once("error", () => resolve({ connected: false }));
      request.end();
    });
    assert.equal(result.connected, false);
  } finally {
    await stopGatewayProxy(proxy);
    await closeHttpServer(upstream);
  }
});

test("docker socket path prefers DOCKER_HOST unix:// sockets", () => {
  assert.equal(dockerSocketPath({}, "linux"), "/var/run/docker.sock");
  assert.equal(dockerSocketPath({}, "win32"), "//./pipe/docker_engine");
  assert.equal(
    dockerSocketPath({ DOCKER_HOST: "unix:///tmp/podman-run-1000/podman/podman.sock" }, "win32"),
    "/tmp/podman-run-1000/podman/podman.sock",
  );
  assert.equal(
    dockerSocketPath({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }, "linux"),
    "//./pipe/docker_engine",
  );
});

test("shared assets accept only Scheduler-owned named volumes and always mount read-only", () => {
  assert.deepEqual(sharedAssetsVolumeBinds(undefined), []);
  assert.deepEqual(sharedAssetsVolumeBinds({ volumeName: "deepsonar-assets-123e4567-e89b-12d3-a456-426614174000" }), [
    "deepsonar-assets-123e4567-e89b-12d3-a456-426614174000:/workspace/.deepsonar/shared:ro",
  ]);
  for (const volumeName of ["/host/assets", "C:\\assets", "other-volume", "deepsonar-assets-../secret", "deepsonar-assets-name:rw"]) {
    assert.throws(
      () => sharedAssetsVolumeBinds({ volumeName }),
      /Scheduler-owned deepsonar-assets/,
    );
  }
});

test("shared assets volume ownership is bound to the exact Job", () => {
  const volume = {
    Name: "deepsonar-assets-job-1",
    Driver: "local",
    Scope: "local",
    Labels: {
      "deepsonar.shared_assets.managed": "true",
      "deepsonar.shared_assets.job": "job-1",
    },
  };
  assert.doesNotThrow(() => assertSharedAssetsVolumeOwnership(volume, "deepsonar-assets-job-1", "job-1"));
  assert.throws(
    () => assertSharedAssetsVolumeOwnership(volume, "deepsonar-assets-job-1", "job-2"),
    /Scheduler-managed volume for this Job/,
  );
  assert.throws(
    () => assertSharedAssetsVolumeOwnership({ ...volume, Labels: {} }, "deepsonar-assets-job-1", "job-1"),
    /Scheduler-managed volume for this Job/,
  );
});

test("warm attach accepts only the exact read-only shared assets mount", () => {
  const expected = {
    Mounts: [{
      Type: "volume",
      Name: "deepsonar-assets-job-1",
      Destination: "/workspace/.deepsonar/shared",
      RW: false,
    }],
  };
  assert.doesNotThrow(() => assertSharedAssetsContainerMount(expected, "deepsonar-assets-job-1"));
  for (const invalid of [
    { ...expected, Mounts: [{ ...expected.Mounts[0], RW: true }] },
    { ...expected, Mounts: [{ ...expected.Mounts[0], Name: "deepsonar-assets-foreign" }] },
    { ...expected, Mounts: [{ ...expected.Mounts[0], Type: "bind" }] },
    { Mounts: [] },
  ]) {
    assert.throws(
      () => assertSharedAssetsContainerMount(invalid, "deepsonar-assets-job-1"),
      /frozen read-only volume/,
    );
  }
});

test("rate-limit error details keep only server-owned bounded metadata", () => {
  const normalized = normalizeRuntimeErrorDetails({
    code: "event_rate_limited",
    stack: "secret stack",
    metadata: {
      bucket: "progress",
      retry_after_sec: 4,
      limit: 30,
      window_seconds: 60,
      secret: "Bearer should not cross the sandbox result boundary",
      huge: "x".repeat(10000),
    },
  });
  assert.deepEqual(normalized, {
    code: "event_rate_limited",
    metadata: { bucket: "progress", retry_after_sec: 4, limit: 30, window_seconds: 60 },
  });
  assert.equal(normalizeRuntimeErrorDetails({ code: "invalid_node_ref", metadata: { secret: "drop" } }), undefined);
  assert.deepEqual(normalizeRuntimeErrorDetails({
    code: "event_rate_limited",
    metadata: { bucket: "not-a-bucket", retry_after_sec: 0, limit: 10001, window_seconds: 3601 },
  }), { code: "event_rate_limited" });
});

test("Claude partial stream thinking and text deltas normalize without duplicating the final assistant block", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const emit = (event: Record<string, unknown>) => events.push(event);
  mapCliEvent({
    type: "stream_event",
    event: { type: "message_start", message: { id: "message-1" } },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先看证据" } },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "结论" } },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  const full = mapCliEvent({
    type: "assistant",
    message: {
      id: "message-1",
      content: [
        { type: "thinking", thinking: "先看证据" },
        { type: "text", text: "结论" },
      ],
    },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(full.semanticEvents, []);
  assert.deepEqual(events, [
    { type: "reasoning.delta", delta: "先看证据" },
    { type: "text.delta", delta: "结论" },
  ]);
});

test("complete thinking blocks remain compatible and absent/malformed stream thinking fails soft", () => {
  const events: Record<string, unknown>[] = [];
  const emit = (event: Record<string, unknown>) => events.push(event);
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "完整思考" }, { type: "text", text: "回答" }] },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(events, [
    { type: "reasoning.delta", delta: "完整思考" },
    { type: "text.delta", delta: "回答" },
  ]);

  events.length = 0;
  const noThinking = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "text", text: "只有回答" }] },
  }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, createSemanticToolState());
  assert.deepEqual(noThinking.warnings, []);
  assert.deepEqual(events, [{ type: "text.delta", delta: "只有回答" }]);

  const malformed = mapCliEvent({ type: "stream_event", event: { type: "content_block_delta", delta: null } }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(malformed.semanticEvents, []);
  assert.equal(malformed.warnings[0]?.code, "malformed_runtime_event");
  const unknown = mapCliEvent({ type: "stream_event", event: { type: "future_delta", thinking: "do not fabricate" } }, emit, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(unknown.semanticEvents, []);
  assert.equal(unknown.warnings[0]?.code, "unknown_runtime_event");
  assert.doesNotMatch(JSON.stringify(events), /do not fabricate/);
});

test("控制 tool_use 仅在成功 tool_result 后释放语义事件", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const pending = mapCliEvent({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "mcp__deepsonar-control__emit_fact",
        input: { title: "事实", description: "Bearer supersecret" },
      }],
    },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(pending.semanticEvents.length, 0);
  const released = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "ok" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.deepEqual(released.semanticEvents[0], {
    v: 1,
    event_id: released.semanticEvents[0]?.event_id,
    type: "fact",
    payload: { title: "事实", description: "Bearer supersecret" },
  });
  assert.match(String(released.semanticEvents[0]?.event_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "mcp__deepsonar-control__emit_fact",
    callId: events[0]?.callId,
    inputShape: { kind: "object", field_count: 2 },
  });
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.deepEqual(events[1], {
    type: "tool.call.completed",
    callId: events[0]?.callId,
    toolName: "mcp__deepsonar-control__emit_fact",
    isError: false,
  });
  assert.doesNotMatch(JSON.stringify(events), /supersecret/);
});

test("工具错误不会释放事件，修正后的新 callId 成功只释放一次且结果重放幂等", () => {
  const state = createSemanticToolState();
  const failedCall = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "failed-call", name: "mcp__deepsonar-control__emit_progress", input: { message: "bad" } }] },
  };
  assert.equal(mapCliEvent(failedCall, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  const failedResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "failed-call", is_error: true, content: "invalid" }] },
  };
  assert.equal(mapCliEvent(failedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  assert.equal(mapCliEvent(failedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);

  const correctedCall = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "corrected-call", name: "mcp__deepsonar-control__emit_progress", input: { message: "good" } }] },
  };
  assert.equal(mapCliEvent(correctedCall, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  const correctedResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "corrected-call", is_error: false, content: "ok" }] },
  };
  const released = mapCliEvent(correctedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.equal(released.semanticEvents[0]?.type, "progress");
  assert.equal(mapCliEvent(correctedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  assert.equal(state.pendingToolUses.size, 0);
});

test("tool_result 缺省 is_error 视为成功，畸形标记 fail-closed 并告警", () => {
  const missingState = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "missing-flag", name: "mcp__deepsonar-control__emit_progress", input: { message: "ok" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, missingState);
  const missingResult = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "missing-flag" }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, missingState);
  assert.equal(missingResult.semanticEvents.length, 1);
  assert.deepEqual(missingResult.warnings, []);

  for (const [index, is_error] of ["false", null, 0].entries()) {
    const id = `malformed-flag-${index}`;
    const state = createSemanticToolState();
    mapCliEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "mcp__deepsonar-control__emit_progress", input: { message: "ok" } }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    const malformed = mapCliEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(malformed.semanticEvents.length, 0);
    assert.equal(malformed.warnings[0]?.code, "malformed_control_tool_result");
    assert.doesNotMatch(JSON.stringify(malformed.warnings), /secret|Bearer/);
  }
});

test("pending 控制调用有上限且终态清理告警不包含输入内容", () => {
  const state = createSemanticToolState(1);
  const first = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "pending-one", name: "mcp__deepsonar-control__emit_fact", input: { description: "Bearer supersecret" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(first.semanticEvents.length, 0);
  const overflow = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "pending-two", name: "mcp__deepsonar-control__emit_fact", input: { description: "another-secret" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(overflow.semanticEvents.length, 0);
  assert.equal(overflow.warnings[0]?.code, "control_tool_pending_limit");
  assert.doesNotMatch(JSON.stringify(overflow.warnings), /supersecret|another-secret/);
  const warnings: Array<{ code: string; detail?: string }> = [];
  discardPendingSemanticTools(state, (warning) => warnings.push(warning));
  assert.equal(state.pendingToolUses.size, 0);
  assert.equal(warnings[0]?.code, "control_tool_pending_discarded");
  assert.doesNotMatch(JSON.stringify(warnings), /supersecret|another-secret/);
});

test("流重放时同一成功 callId 派生相同 event_id", () => {
  const line = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "replayed-call", name: "mcp__deepsonar-control__emit_fact", input: { title: "事实", description: "证据" } }] },
  };
  const firstState = createSemanticToolState();
  const replayState = createSemanticToolState();
  mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, firstState);
  mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, replayState);
  const resultLine = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false }] },
  });
  const first = mapCliEvent(resultLine("replayed-call"), () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, firstState);
  const replay = mapCliEvent(resultLine("replayed-call"), () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, replayState);
  assert.equal(first.semanticEvents[0]?.event_id, replay.semanticEvents[0]?.event_id);
});

test("畸形 content block 只告警，后续合法控制调用仍可处理且不泄露原文", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const parsed = mapCliEvent({
    type: "assistant",
    message: {
      content: [
        null,
        "Bearer block-secret",
        42,
        { type: "tool_use", id: "after-malformed", name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } },
      ],
    },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(parsed.semanticEvents.length, 0);
  assert.equal(parsed.warnings.length, 3);
  assert.equal(parsed.warnings.every((warning) => warning.code === "malformed_runtime_block"), true);
  assert.doesNotMatch(JSON.stringify(parsed.warnings), /block-secret/);
  assert.doesNotMatch(JSON.stringify(events), /block-secret/);

  const released = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "after-malformed", is_error: false }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /block-secret/);
});

test("忽略非控制工具", () => {
  const result = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "other-1", name: "Bash", input: { command: "pwd" } }] },
  }, () => {});
  assert.deepEqual(result.semanticEvents, []);
});

test("300 字符 Bash tool id 保持原始 telemetry 且以 hash 关联完成事件", () => {
  const rawCallId = "B".repeat(300);
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "Bash", input: { command: "pwd" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: false, content: "ok" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);

  assert.deepEqual(events, [
    { type: "tool.call.started", toolName: "Bash", callId: rawCallId, input: { command: "pwd" } },
    { type: "tool.call.completed", callId: rawCallId, toolName: "Bash", result: "ok", isError: false },
  ]);
  assert.equal(state.observedNonControlToolUseHashes.size, 0);
  assert.equal(state.settledNonControlToolUseHashes.size, 1);
  assert.equal([...state.settledNonControlToolUseHashes][0]?.length, 64);
});

test("ordinary tool telemetry redacts input and normalizes bounded result fields", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "ordinary-1", name: "Bash", input: { command: "curl", api_key: "top-secret" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "ordinary-1", is_error: true, content: "Bearer result-secret", exit_code: 7 }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "Bash",
    callId: "ordinary-1",
    input: { command: "curl", api_key: "[REDACTED]" },
  });
  assert.deepEqual(events[1], {
    type: "tool.call.completed",
    callId: "ordinary-1",
    toolName: "Bash",
    result: "Bearer [REDACTED]",
    exit: 7,
    error: "Bearer [REDACTED]",
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(events), /top-secret|result-secret/);
});

test("control telemetry remains shape-only after ordinary redaction helpers", () => {
  assert.deepEqual(redactToolTelemetry({ secret: "value", path: "/workspace/app.ts" }), { secret: "[REDACTED]", path: "/workspace/app.ts" });
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "control-shape", name: "mcp__deepsonar-control__emit_progress", input: { secret: "value", path: "/workspace/app.ts" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "mcp__deepsonar-control__emit_progress",
    callId: events[0]?.callId,
    inputShape: { kind: "object", field_count: 2 },
  });
  assert.equal("input" in (events[0] ?? {}), false);
});

test("ordinary tool telemetry redacts standalone platform and provider tokens", () => {
  assert.equal(
    redactToolTelemetry("curl -H x-token:deepsonar_prod_12345678_abcdefghijklmnop"),
    "curl -H x-token:[REDACTED]",
  );
  assert.equal(redactToolTelemetry("use sk-abcdefghijklmnop1234"), "use [REDACTED]");
});

test("exact runtime secret redaction covers result files and archived session artifacts", () => {
  const token = "deepsonarcap_runtime_exact_0123456789";
  const value = redactRuntimeSecrets({
    file: `Authorization: Bearer ${token}`,
    session: {
      captureError: `capture failed ${token}`,
      artifacts: [{ content: `tool output included ${token}`, sourcePath: "/workspace/session.jsonl" }],
    },
  }, [token]);
  assert.deepEqual(value, {
    file: "Authorization: Bearer [REDACTED]",
    session: {
      captureError: "capture failed [REDACTED]",
      artifacts: [{ content: "tool output included [REDACTED]", sourcePath: "/workspace/session.jsonl" }],
    },
  });
  assert.doesNotMatch(JSON.stringify(value), new RegExp(token));
});

test("mapCliEvent redacts an exact runtime token before non-control telemetry", () => {
  const token = "deepsonarcap_runtime_stream_0123456789";
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "secret-call", name: "Bash", input: { command: `echo ${token}` } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state, [token]);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "secret-call", is_error: false, content: `output ${token}` }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state, [token]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(token));
  assert.equal((events[0]?.input as { command: string }).command, "echo [REDACTED]");
  assert.equal(events[1]?.result, "output [REDACTED]");
});

test("已知 control tool 重放只产生一对 hashed telemetry 和一个语义事件", () => {
  const rawCallId = "control-replay-call";
  const events: Record<string, unknown>[] = [];
  const semanticEvents: Record<string, unknown>[] = [];
  const warnings: Array<{ code: string; detail?: string }> = [];
  const state = createSemanticToolState();
  const toolUse = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  };
  const toolResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: false, content: "ok" }] },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = mapCliEvent(toolUse, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    semanticEvents.push(...started.semanticEvents);
    warnings.push(...started.warnings);
    const completed = mapCliEvent(toolResult, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    semanticEvents.push(...completed.semanticEvents);
    warnings.push(...completed.warnings);
  }

  assert.deepEqual(events, [
    {
      type: "tool.call.started",
      toolName: "mcp__deepsonar-control__emit_progress",
      callId: events[0]?.callId,
      inputShape: { kind: "object", field_count: 1 },
    },
    {
      type: "tool.call.completed",
      callId: events[0]?.callId,
      toolName: "mcp__deepsonar-control__emit_progress",
      isError: false,
    },
  ]);
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.equal(events[0]?.callId, events[1]?.callId);
  assert.equal(semanticEvents.length, 1);
  assert.equal(semanticEvents[0]?.type, "progress");
  assert.deepEqual(warnings, []);
});

test("控制工具映射只接受 own key，原型键不会生成语义事件", () => {
  for (const [index, name] of ["__proto__", "constructor", "toString"].entries()) {
    const state = createSemanticToolState();
    const callId = `prototype-key-${index}`;
    const started = mapCliEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: callId, name, input: { secret: "do-not-emit" } }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(started.semanticEvents.length, 0);
    const result = mapCliEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: callId, is_error: false }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(result.semanticEvents.length, 0);
    assert.equal(state.pendingToolUses.size, 0);
  }
});

test("未知控制命名空间工具不发 telemetry 事件且不泄露输入", () => {
  const events: Record<string, unknown>[] = [];
  const unknownCall = {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "unknown-control",
        name: "mcp__deepsonar-control__Bearer-namespace-secret",
        input: { description: "Bearer namespace-secret" },
      }],
    },
  };
  const result = mapCliEvent(unknownCall, (event) => events.push(event));
  assert.deepEqual(events, []);
  assert.equal(result.warnings[0]?.code, "unknown_control_tool");
  assert.doesNotMatch(JSON.stringify(result.warnings), /namespace-secret/);
  const unknownResult = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "unknown-control", is_error: false, content: "Bearer result-secret" }] },
  }, () => {});
  assert.deepEqual(unknownResult.semanticEvents, []);
  assert.deepEqual(events, []);
  assert.doesNotMatch(JSON.stringify(events), /namespace-secret/);
  assert.doesNotMatch(JSON.stringify(events), /result-secret/);
});

test("没有匹配 pending 的 control tool_result 不发 telemetry，也不保留原始 callId", () => {
  const events: Record<string, unknown>[] = [];
  const result = mapCliEvent({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "Bearer-result-token", is_error: false, content: "secret" }],
    },
  }, (event) => events.push(event));
  assert.deepEqual(events, []);
  assert.deepEqual(result.semanticEvents, []);
  assert.deepEqual(result.warnings, []);
});

test("control telemetry 用 bounded hash 关联，不记录原始 callId", () => {
  const rawCallId = "Bearer-call-token";
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: true, content: "secret" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(events.length, 2);
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.equal(events[0]?.callId, events[1]?.callId);
  assert.doesNotMatch(JSON.stringify(events), /Bearer-call-token|secret/);
});

test("超长 control callId 只产生固定长度告警，不进入 telemetry 或 pending", () => {
  const rawCallId = "Bearer-" + "x".repeat(300);
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const started = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(events.length, 0);
  assert.equal(started.warnings[0]?.code, "malformed_control_tool_use");
  assert.equal(started.warnings[0]?.detail, `call_id_length=${rawCallId.length}`);
  assert.equal(state.pendingToolUses.size, 0);
  assert.doesNotMatch(JSON.stringify(started.warnings), /Bearer|xxx/);
});

test("脏运行时行只产生告警，后续合法 tool_use 仍可解析", () => {
  const malformed = parseRuntimeLine("Authorization: Bearer supersecret; echo test > .deepsonar/control-events.jsonl");
  assert.equal(malformed.parsed, undefined);
  assert.equal(malformed.warning?.code, "forbidden_control_file");
  assert.doesNotMatch(malformed.warning?.detail ?? "", /supersecret/);
  const valid = parseRuntimeLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "after-dirty", name: "mcp__deepsonar-control__emit_progress", input: { message: "继续" } }] },
  }));
  assert.ok(valid.parsed);
  const events = mapCliEvent(valid.parsed!, () => {});
  assert.equal(events.semanticEvents.length, 0);
});

test("Claude session resolves its default config directory under HOME", async () => {
  let command = "";
  const bundle = await CLI_SESSION_ADAPTERS["claude-code"].exportSession({
    async run(value) {
      command = Array.isArray(value) ? value.join(" ") : value;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readText() {
      return null;
    },
  }, "session-1");

  assert.match(command, /base="\$\{HOME:-\/root\}\/\.claude\/projects"/);
  assert.match(command, /find "\$base"/);
  assert.equal(bundle.artifacts.length, 0);
});

test("Claude CLI uses the per-Job HOME without a Claude-specific override", () => {
  assert.deepEqual(runtimeCliEnv({ ANTHROPIC_BASE_URL: "http://gateway", CLAUDE_CONFIG_DIR: "/tmp/claude" }), {
    ANTHROPIC_BASE_URL: "http://gateway",
    HOME: "/workspace/.deepsonar-home",
  });
});

test("runtime HOME preparation fails closed when the directory is not writable", async () => {
  let command = "";
  await ensureRuntimeHome({
    async run(value) {
      command = Array.isArray(value) ? value.join(" ") : value;
      return { exitCode: 0 } as Awaited<ReturnType<Parameters<typeof ensureRuntimeHome>[0]["run"]>>;
    },
  });
  assert.match(command, /mkdir -p -- '\/workspace\/\.deepsonar-home'/);
  assert.match(command, /test -w '\/workspace\/\.deepsonar-home'/);

  await assert.rejects(
    ensureRuntimeHome({
      async run() {
        return { exitCode: 1 } as Awaited<ReturnType<Parameters<typeof ensureRuntimeHome>[0]["run"]>>;
      },
    }),
    /runtime_directory_not_writable: \/workspace\/\.deepsonar-home/,
  );
});

test("Codex session discovery falls back to HOME when CODEX_HOME is unset", async () => {
  let command = "";
  await CLI_SESSION_ADAPTERS.codex.exportSession({
    async run(value) {
      command = value;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readText() {
      return null;
    },
  }, "session-1");

  assert.match(command, /base="\$\{CODEX_HOME:-\$\{HOME:-\/root\}\/\.codex\}\/sessions"/);
  });

test("DSH session discovery uses the deterministic exact session directory", async () => {
  let command = "";
  const sourcePath = "/workspace/.deepsonar-home/.dsh/sessions/project/session-context-1/session.jsonl";
  const bundle = await CLI_SESSION_ADAPTERS.dsh.exportSession({
    async run(value) {
      command = value;
      return { exitCode: 0, stdout: `${sourcePath}\n`, stderr: "" };
    },
    async readText(value) {
      return value === sourcePath ? '{"type":"session","id":"session-context-1"}\n' : null;
    },
  }, "session-context-1");
  assert.match(command, /\/workspace\/\.deepsonar-home\/\.dsh\/sessions/);
  assert.match(command, /\/session-context-1\/session\.jsonl/);
  assert.equal(bundle.cli, "dsh");
  assert.equal(bundle.artifacts[0]?.sourcePath, sourcePath);
  assert.equal(bundle.artifacts[0]?.kind, "main");
});

function mockedSessionDiscoveryRuntime(
  result: { exitCode: number; stdout: string; stderr: string },
  files: Record<string, string> = {},
  commands: string[] = [],
  readPaths: string[] = [],
): SessionDiscoveryRuntime {
  return {
    async run(command) {
      commands.push(command);
      return result;
    },
    async readText(path) {
      readPaths.push(path);
      return files[path] ?? null;
    },
  };
}

test("OpenCode session export preserves the vendor JSON artifact", async () => {
  const commands: string[] = [];
  const content = '{"session":"session-open-code"}\n';
  const bundle = await CLI_SESSION_ADAPTERS["open-code"].exportSession(
    mockedSessionDiscoveryRuntime({ exitCode: 0, stdout: content, stderr: "" }, {}, commands),
    "session-open-code",
  );

  assert.match(commands[0] ?? "", /^opencode export /);
  assert.deepEqual(bundle.artifacts, [{
    name: "session-open-code.json",
    sourcePath: "opencode export session-open-code",
    content,
    kind: "vendor_export",
  }]);
  assert.equal(bundle.captureError, undefined);
});

test("OpenCode session export rejects vendor stdout over 32 MiB", async () => {
  const bundle = await CLI_SESSION_ADAPTERS["open-code"].exportSession(
    mockedSessionDiscoveryRuntime({
      exitCode: 0,
      stdout: "x".repeat(32 * 1024 * 1024 + 1),
      stderr: "",
    }),
    "session-open-code-large",
  );

  assert.deepEqual(bundle.artifacts, []);
  assert.match(bundle.captureError ?? "", /32 MiB/);
});

test("OpenCode session export reports vendor command errors", async () => {
  const bundle = await CLI_SESSION_ADAPTERS["open-code"].exportSession(
    mockedSessionDiscoveryRuntime({ exitCode: 1, stdout: "", stderr: "export failed" }),
    "session-open-code-error",
  );

  assert.deepEqual(bundle.artifacts, []);
  assert.equal(bundle.captureError, "export failed");
});

test("Pi session archive accepts only the exact governed sessionFile", async () => {
  const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";
  const readPaths: string[] = [];
  const content = '{"type":"session","id":"session-pi"}\n';
  const bundle = await CLI_SESSION_ADAPTERS.pi.exportSession(
    mockedSessionDiscoveryRuntime({ exitCode: 0, stdout: "", stderr: "" }, { [sessionFile]: content }, [], readPaths),
    "session-pi",
    sessionFile,
  );

  assert.deepEqual(readPaths, [sessionFile]);
  assert.deepEqual(bundle.artifacts, [{
    name: "session.jsonl",
    sourcePath: sessionFile,
    content,
    kind: "main",
  }]);
  assert.equal(bundle.captureError, undefined);
});

test("Pi session archive rejects a governed sessionFile path escape", async () => {
  const readPaths: string[] = [];
  const bundle = await CLI_SESSION_ADAPTERS.pi.exportSession(
    mockedSessionDiscoveryRuntime({ exitCode: 0, stdout: "", stderr: "" }, {}, [], readPaths),
    "session-pi-escape",
    "/workspace/.deepsonar-home/.pi/agent/../escape.jsonl",
  );

  assert.deepEqual(readPaths, []);
  assert.deepEqual(bundle.artifacts, []);
  assert.match(bundle.captureError ?? "", /sessionFile/);
});

test("Pi session archive rejects a sessionFile over 32 MiB", async () => {
  const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session-large.jsonl";
  const bundle = await CLI_SESSION_ADAPTERS.pi.exportSession(
    mockedSessionDiscoveryRuntime(
      { exitCode: 0, stdout: "", stderr: "" },
      { [sessionFile]: "x".repeat(32 * 1024 * 1024 + 1) },
    ),
    "session-pi-large",
    sessionFile,
  );

  assert.deepEqual(bundle.artifacts, []);
  assert.match(bundle.captureError ?? "", /32 MiB/);
});

test("组件 materialize 在同名命令/skill 路径冲突时拒绝覆盖", () => {
  assert.deepEqual(
    materializationPathCollisions({
      commands: [
        { name: "review", description: "one", template: "a" },
        { name: "review", description: "two", template: "b" },
      ],
      skills: [
        { source: "embedded", name: "audit", files: { "SKILL.md": "one" } },
        { source: "embedded", name: "audit", files: { "SKILL.md": "two" } },
      ],
      subAgents: [],
    }),
    ["/workspace/.deepsonar-home/.claude/commands/review.md", "/workspace/.deepsonar-home/.claude/skills/audit/SKILL.md"],
  );
  // Skill and command namespaces are separate and may intentionally share a name.
  assert.deepEqual(
    materializationPathCollisions({
      commands: [{ name: "shared", description: "", template: "" }],
      skills: [{ source: "embedded", name: "shared", files: { "SKILL.md": "" } }],
      subAgents: [],
    }),
    [],
  );
});

test("embedded skill 使用当前 Agent CLI 的标准目录", () => {
  assert.equal(
    skillMaterializationPath("deepsonar-control", "SKILL.md", "claude-code"),
    "/workspace/.deepsonar-home/.claude/skills/deepsonar-control/SKILL.md",
  );
  assert.equal(
    skillMaterializationPath("deepsonar-control", "SKILL.md", "codex"),
    "/workspace/.deepsonar-home/.codex/skills/deepsonar-control/SKILL.md",
  );
  assert.equal(
    skillMaterializationPath("deepsonar-control", "SKILL.md", "open-code"),
    "/workspace/.deepsonar-home/.config/opencode/skills/deepsonar-control/SKILL.md",
  );
  assert.equal(
    skillMaterializationPath("deepsonar-control", "SKILL.md", "dsh"),
    "/workspace/.deepsonar-home/.dsh/skills/deepsonar-control/SKILL.md",
  );
  assert.deepEqual(
    materializationPathCollisions({
      provider: "codex",
      commands: [],
      subAgents: [],
      skills: [{ source: "embedded", name: "deepsonar-control", files: { "SKILL.md": "" } }],
    }),
    [],
  );
});

test("组件 materialize 在任何写入前拒绝路径穿越与控制字符", () => {
  const assertRejected = (spec: Parameters<typeof materializationPathCollisions>[0]) => {
    assert.throws(() => materializationPathCollisions(spec), /拒绝/);
  };

  assertRejected({ commands: [{ name: "../../x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "/tmp/x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "..\\x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "bad\0name", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "bad\u0001name", description: "", template: "" }] });
  assertRejected({ subAgents: [{ name: "C:\\windows", description: "", instructions: "" }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "../AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "..\\AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "/tmp/AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "bad\0.md": "escape" } }] });

  // Ordinary Unicode component/file names remain valid and normalize to a
  // strict child path under the expected namespace.
  assert.deepEqual(
    materializationPathCollisions({
      commands: [{ name: "审计", description: "", template: "" }],
      skills: [{ source: "embedded", name: "安全检查", files: { "说明/技能.md": "ok" } }],
      subAgents: [{ name: "复核", description: "", instructions: "" }],
    }),
    [],
  );
});
