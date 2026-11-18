import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDispatcherFailure,
  isRetryablePiStreamTruncation,
  isRetryablePtyTransportFailure,
} from "./dispatcher.js";
import { PI_STREAM_TRUNCATED_REASON } from "./pi-stream-truncation.js";
import {
  PTY_TRANSPORT_REASON,
  attemptEffectsAllowPtyRetry,
  countConsumedPtyTransportRetries,
  planAutomaticPtyTransportRetry,
} from "./pty-transport-retry.js";

const TRANSPORT = "RuntimeProcessFailure OPENSANDBOX_PTY_TRANSPORT_ERROR: websocket closed without a close frame";
const HOST_KILL = "RuntimeProcessFailure OPENSANDBOX_PTY_HOST_KILL: process killed";

test("#1143 PTY 传输中断归入 opensandbox_pty_transport，Host kill 保持 fail closed", () => {
  for (const message of [TRANSPORT, `agent 运行失败: ${TRANSPORT}`]) {
    const classified = classifyDispatcherFailure(new Error(message));
    assert.equal(classified.reason, PTY_TRANSPORT_REASON, message);
    assert.equal(isRetryablePtyTransportFailure(new Error(message)), true, message);
    // 两条预算互不占用：PTY 传输中断不能被当成 Pi 流截断。
    assert.equal(isRetryablePiStreamTruncation(new Error(message)), false, message);
  }
  for (const message of [
    HOST_KILL,
    // 同一文本同时出现两类时保守拒绝。
    `${TRANSPORT} then ${HOST_KILL}`,
    "Pi message ended: error: OpenAI API error (401): 无效的令牌",
    "PI_EMPTY_MODEL_RESPONSE",
    "CREDENTIAL_IN_BUSINESS_DATA",
    "runtime image digest mismatch",
  ]) {
    assert.notEqual(classifyDispatcherFailure(new Error(message)).reason, PTY_TRANSPORT_REASON, message);
    assert.equal(isRetryablePtyTransportFailure(new Error(message)), false, message);
  }
});

test("#1143 只有全部外部效果已 settled 才允许重派", () => {
  assert.equal(attemptEffectsAllowPtyRetry([]), true, "没有登记效果时不存在未知外部效果");
  assert.equal(attemptEffectsAllowPtyRetry([{ status: "settled" }, { status: "settled" }]), true);
  for (const status of ["planned", "effect_pending", "unknown"]) {
    assert.equal(attemptEffectsAllowPtyRetry([{ status: "settled" }, { status }]), false, status);
  }
  assert.equal(attemptEffectsAllowPtyRetry([{ status: undefined }]), false, "无法确认的状态不能当已结算");
});

test("#1143 每个 Job 只获得一次自动 PTY 重试，预算按已消耗次数而非 attempt_no 计算", () => {
  assert.deepEqual(planAutomaticPtyTransportRetry(0), { retry: true, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticPtyTransportRetry(1), { retry: false, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticPtyTransportRetry(Number.NaN), { retry: true, nextRetryCount: 1 });
  const rows = [
    { status: "failed", outcome_json: { reason: PTY_TRANSPORT_REASON } },
    { status: "failed", state_json: { outcome: { reason: PTY_TRANSPORT_REASON } } },
    { status: "failed", outcome_json: { reason: PI_STREAM_TRUNCATED_REASON } },
    { status: "active", outcome_json: { reason: PTY_TRANSPORT_REASON } },
  ];
  assert.equal(countConsumedPtyTransportRetries(rows), 2);
});

test("#1143 dispatcher 从 running 经新 Attempt 重派，先过效果门再计预算", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const retrySource = readFileSync(new URL("./job-execution-retry.ts", import.meta.url), "utf8");
  assert.match(source, /isRetryablePtyTransportFailure/);
  assert.match(source, /inc\("deepsonar_sandbox_pty_transport_retry_total"\)/);
  assert.match(source, /action: "job\.pty_transport_retry"/);
  assert.match(retrySource, /attemptEffectsAllowPtyRetry\(effects\)/);
  assert.match(retrySource, /planAutomaticPtyTransportRetry\(countConsumedPtyTransportRetries\(previous\)\)/);
  assert.match(retrySource, /txLifecycle\.retryPtyTransportExecution\(/);
  // 效果门必须在预算判定之前，否则一次未收口的重放会先消耗预算。
  const retryFunction = retrySource.slice(retrySource.indexOf("export async function retryPtyTransportJob"), retrySource.indexOf("export async function retryContextWindowExceededJob"));
  assert.ok(retryFunction.indexOf("attemptEffectsAllowPtyRetry") < retryFunction.indexOf("planAutomaticPtyTransportRetry"));
  assert.ok(retryFunction.indexOf("planAutomaticPtyTransportRetry") < retryFunction.indexOf("retryPtyTransportExecution"));
  // Host kill 不进入 PTY 重试分支。
  assert.doesNotMatch(source, /OPENSANDBOX_PTY_HOST_KILL/);
});