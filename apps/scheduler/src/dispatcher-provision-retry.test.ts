import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyDispatcherFailure, formatDispatcherFailureMessage, isDefiniteSandboxStartFailure, isRetryableProvisionFailure } from "./dispatcher.js";
import { countConsumedProvisionRetries, planAutomaticProvisionRetry } from "./provision-retry-budget.js";
import { cleanupDispatcherSandbox } from "./dispatcher-human-wait.js";

test("OpenSandbox container startup errors retain nested provider details", () => {
  const error = Object.assign(new Error("Egress sidecar container failed to start."), {
    code: "CONTAINER_START_FAILED",
    statusCode: 500,
    error: { message: "bind: An attempt was made to access a socket in a way forbidden by its access permissions" },
  });
  const message = formatDispatcherFailureMessage(error);
  assert.match(message, /CONTAINER_START_FAILED/);
  assert.match(message, /500/);
  assert.match(message, /bind:/);
  assert.equal(isRetryableProvisionFailure(error), true);
});

test("transient container startup errors are retry candidates, not proof that create never started", () => {
  assert.equal(isRetryableProvisionFailure(new Error("runtime image digest mismatch")), false);
  assert.equal(isRetryableProvisionFailure(new Error("Egress sidecar container failed to start.")), true);
  assert.equal(isRetryableProvisionFailure(new Error("provision 已取消")), false);
  assert.equal(
    isRetryableProvisionFailure(
      new Error("Sandbox health check timed out after 30s (1 attempts). Last health check error: An internal error occurred in the proxy: Server disconnected without sending a response. Connection context: domain=open"),
    ),
    true,
  );
  assert.equal(
    isRetryableProvisionFailure(
      Object.assign(new Error("Egress sidecar did not become ready within 30s for sandbox a15628b7-fb39-423b-966e-4423569a21ac: timed out"), {
        code: "DOCKER::SANDBOX_START_FAILED",
        statusCode: 500,
      }),
    ),
    true,
  );
});

test("empty Error without nested details still yields a non-empty failure message", () => {
  const error = new Error("");
  const message = formatDispatcherFailureMessage(error);
  assert.notEqual(message.trim(), "");
  assert.match(message, /exception/);
  assert.equal(isRetryableProvisionFailure(error), false);
  const classified = classifyDispatcherFailure(error);
  assert.equal(classified.reason, "exception");
  assert.equal(classified.message, "exception");
});

test("empty Error keeps nested provider code when message is blank", () => {
  const error = Object.assign(new Error(""), { code: "EPIPE" });
  const message = formatDispatcherFailureMessage(error);
  assert.match(message, /EPIPE/);
  assert.notEqual(message.trim(), "");
});

test("sidecar retry after a non-provision attempt still has budget", () => {
  const consumed = countConsumedProvisionRetries([
    { status: "failed", outcome_json: { reason: "exception" } },
  ]);
  assert.equal(consumed, 0);
  assert.equal(planAutomaticProvisionRetry(consumed).retry, true);
});

test("dispatcher provision retry budget is counted attempts, not attempt_no", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /planAutomaticProvisionRetry\(countConsumedProvisionRetries\(previous\)\)/);
  assert.match(source, /FROM job_attempts/);
  assert.doesNotMatch(source, /attempt_no\s*>\s*MAX_AUTOMATIC_PROVISION_RETRIES/);
  assert.doesNotMatch(source, /attempt_no \?\? 0\) <= MAX_AUTOMATIC_PROVISION_RETRIES/);
});

test("source contract: opaque started failure stays unknown; retry requires current owner and explicit no-create evidence", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const failure = source.slice(source.indexOf("// Once runner.provision was invoked"), source.indexOf("// Job → Attempt: settlement"));
  // #1309：明确的启动失败结算成 never_started，其余（含超时/断开）仍 unknown。
  assert.match(failure, /lateProvisionExternalUncertain\s*\|\| \(provisionAttempted && !isDefiniteSandboxStartFailure\(error\)\)/);
  assert.match(failure, /else\s*\{\s*await settleUnstartedProvisionEffect/);
  assert.match(failure, /await lockCurrentProvisioningAttempt/);
  assert.match(failure, /throw new AggregateError\(\[error, settlementError\]/);
  assert.doesNotMatch(failure, /\.catch\(\(\) => \{\}\)/);
  const retry = source.slice(source.indexOf("export async function retryProvisioningJob"), source.indexOf("async function retryTruncatedExecutionJob"));
  assert.match(retry, /owner\.latest_attempt_id !== attempt\.id/);
  assert.match(retry, /typeof current\.id !== "string" \|\| current\.id !== attempt\.id/);
  assert.match(retry, /settlement_json @> '\{"result":"never_started","external_effect":false\}'::jsonb/);
  assert.match(retry, /settlement_json @> '\{"outcome":"not_applied"\}'::jsonb/);
  assert.match(source, /if \(!handle && attemptId && activeAttempt &&\s*\(isRetryableProvisionFailure\(e\) \|\| e instanceof OpenSandboxCreateAdmissionExpiredError\)\)/);
  const outboundFence = source.indexOf('if (provider === "opensandbox") assertOpenSandboxCreateAdmission(createProbe)');
  assert.ok(outboundFence > source.indexOf("await sharedAssetsPreparation?.assertCurrent()"));
  assert.ok(outboundFence < source.indexOf("provisionAttempted = true"));
  // Behavioral proof is in shared-asset-lifecycle.integration.test.ts, not these source assertions.
});

test("dispatcher closes accepted human runs only through confirmed exact-sandbox cleanup", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const cleanup = source.slice(source.indexOf("} finally {\n    stopLease?.();"), source.indexOf("export async function withProvisionTimeout"));
  assert.match(cleanup, /cleanupDispatcherSandbox\(sql, runner, \{ jobId, attemptId, sandboxId: h\.sandboxId \}\)/);
  assert.ok(cleanup.indexOf("cleanupDispatcherSandbox") < cleanup.indexOf("cleanupSharedAssetsForJob"));
});

test("ordinary terminal finally cleanup destroys once without using the human-wait gate", async () => {
  for (const status of ["succeeded", "failed", "timeout", "cancelled", "pending"]) {
    let destroys = 0;
    const db = Object.assign(async () => [{ status }], { begin: async () => { throw new Error("ordinary cleanup must not enter the human gate"); } });
    await cleanupDispatcherSandbox(db as never, { destroy: async handle => {
      assert.equal(handle.sandboxId, "fixture-sandbox"); destroys++;
    } }, { jobId: "fixture-job", attemptId: "fixture-attempt", sandboxId: "fixture-sandbox" });
    assert.equal(destroys, 1, status);
  }
});

test("refused human-wait cleanup never falls back to ordinary destruction", async () => {
  let transactions = 0, destroys = 0;
  const db = Object.assign(async () => [{ status: "waiting_human" }], { begin: async () => { transactions++; return false; } });
  const runner = { destroy: async () => { destroys++; } };
  await cleanupDispatcherSandbox(db as never, runner,
    { jobId: "fixture-job", attemptId: "fixture-attempt", sandboxId: "fixture-sandbox" });
  assert.equal(transactions, 1); assert.equal(destroys, 0);
  await cleanupDispatcherSandbox(db as never, runner, { jobId: "fixture-job", sandboxId: "fixture-sandbox" });
  assert.equal(transactions, 1); assert.equal(destroys, 0, "missing Attempt does not authorize unfenced wait cleanup");
  await cleanupDispatcherSandbox(db as never, runner,
    { jobId: "fixture-job", attemptId: null, sandboxId: "fixture-sandbox" });
  assert.equal(transactions, 1); assert.equal(destroys, 0, "null Attempt does not authorize unfenced wait cleanup");
});

test("provision diagnostic uses the durable audit sink without serializing Job env or raw failures", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const sink = source.slice(source.indexOf("onFailure: async"), source.indexOf("} as Parameters<typeof runner.provision>"));
  assert.match(sink, /await recordProvisionFailureEvidence\(sql/);
  assert.match(sink, /attemptId: attemptId!/);
  const evidence = readFileSync(new URL("./provision-failure-evidence.ts", import.meta.url), "utf8");
  assert.match(evidence, /recordDurableSystemAudit/);
  assert.match(evidence, /action: "job.provision_failed"/);
  assert.match(evidence, /assertBoundedJson\(next/);
  assert.doesNotMatch(sink, /provisionInput\.env|platformCapability|error\.message|stack/);
  // Runtime callback/cleanup behavior is exercised by opensandbox.test.ts; this checks only Scheduler wiring.
});

test("Upload failed 500 / UNEXPECTED_RESPONSE is a transient retry candidate, not a create receipt", () => {
  assert.equal(
    isRetryableProvisionFailure(
      Object.assign(new Error("Upload failed (status=500)"), {
        statusCode: 500,
        code: "UNEXPECTED_RESPONSE",
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProvisionFailure(
      new Error("An internal error occurred in the proxy: Unexpected websocket proxy failure for sandbox=abc port=44772"),
    ),
    true,
  );
  assert.equal(isRetryableProvisionFailure(new Error("Upload failed (status=400)")), false);
});

test("dispatcher failure messages scrub NUL before classification", () => {
  const message = formatDispatcherFailureMessage(new Error("Upload failed (status=500)\0UNEXPECTED_RESPONSE"));
  assert.equal(message.includes("\0"), false);
  assert.match(message, /Upload failed \(status=500\)/);
  assert.equal(isRetryableProvisionFailure(new Error("Upload failed (status=500)\0")), true);
});

test("directory create 500 is circuit evidence without enlarging automatic replay candidacy", () => {
  assert.equal(isRetryableProvisionFailure(new Error(
    "Failed to create directory /opt/opensandbox in sandbox: 500 Server Error")), false);
});

test("#1309 只有明确的沙箱启动失败才算「确定未落地」", () => {
  assert.equal(isDefiniteSandboxStartFailure(new Error("Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)")), true);
  assert.equal(isDefiniteSandboxStartFailure(Object.assign(new Error("start failed"), { code: "SANDBOX_START_FAILED" })), true);
  // 超时、断开、无响应都不能证明没有创建，必须继续按 unknown 处理。
  assert.equal(isDefiniteSandboxStartFailure(new Error("provision 超时（1800s）")), false);
  assert.equal(isDefiniteSandboxStartFailure(new Error("Server disconnected without sending a response")), false);
  assert.equal(isDefiniteSandboxStartFailure(undefined), false);
});

test("#1309 source contract: reconcile 已证 not_applied 的效果也是可重试前置", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  // 闸 2：准入同时接受 never_started 与 reconcile 的 not_applied，未知效果仍被拒。
  assert.match(source, /settlement_json @> '\{"outcome":"not_applied"\}'::jsonb/);
  assert.match(source, /settlement_json @> '\{"result":"never_started","external_effect":false\}'::jsonb/);
  // 拒绝时必须留下可检索原因。
  assert.match(source, /provision_retry_denied reason=state_not_admissible/);
  // 闸 1：provision 已发起但已证未落地时也要能进重试分支。
  assert.doesNotMatch(source, /if \(!provisionAttempted && !handle/);
  // P1：确定的启动失败结算成 never_started，其余仍 unknown。
  assert.match(source, /provisionAttempted && !isDefiniteSandboxStartFailure\(error\)/);
});
