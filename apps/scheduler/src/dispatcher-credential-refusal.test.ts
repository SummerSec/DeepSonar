import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyDispatcherFailure, isRetryableProvisionFailure } from "./dispatcher.js";
import { PI_STREAM_TRUNCATED_REASON } from "./pi-stream-truncation.js";
import { CONTEXT_WINDOW_EXCEEDED_REASON } from "./context-window-exceeded.js";
import {
  CREDENTIAL_IN_BUSINESS_DATA_REASON,
  isCredentialInBusinessDataMessage,
} from "./credential-refusal.js";

/** gateway.ts 里五处 deny(400, "Job credential in …") 的原始文案。 */
const GATEWAY_DENIALS = [
  "Job credential in request target",
  "Job credential in body",
  "Job credential in upstream target",
  "Job credential in business data",
  "Job credential in trailers",
];

test("#1032: 凭据守卫拒绝被识别为平台稳定错误码，而非 CLI 黑话", () => {
  for (const denial of GATEWAY_DENIALS) {
    // 现场形态：executor 的 agent 运行失败前缀 + CLI 进程退出短语 + gateway 400 摘要。
    const observed = `agent 运行失败: agent CLI 退出码 1: Pi message ended: error: 400: ${denial}`;
    const classified = classifyDispatcherFailure(new Error(observed));
    assert.equal(classified.reason, CREDENTIAL_IN_BUSINESS_DATA_REASON, denial);
    assert.equal(
      classified.message,
      `${CREDENTIAL_IN_BUSINESS_DATA_REASON}: ${observed}`,
      "Job error 必须以稳定错误码开头，同时保留原始观测串",
    );
    assert.equal(isCredentialInBusinessDataMessage(observed), true, denial);
    // 裸 400 摘要（无进程框）同样识别，避免依赖 CLI 退出短语的具体措辞。
    assert.equal(isCredentialInBusinessDataMessage(`error: 400: ${denial}`), true, denial);
    // openai-responses（非 Anthropic Pi 配置的默认 provider）经 Pi 1.5.2
    // formatProviderError 产出 `<provider> API error (400): <body>`。
    const providerWrapped =
      `agent 运行失败: agent CLI 退出码 1: Pi message ended: error: OpenAI API error (400): ${denial}`;
    assert.equal(isCredentialInBusinessDataMessage(providerWrapped), true, denial);
    assert.equal(
      classifyDispatcherFailure(new Error(providerWrapped)).reason,
      CREDENTIAL_IN_BUSINESS_DATA_REASON,
      `provider 封装形态必须同样归入稳定码：${denial}`,
    );
  }
});

test("#1032: 只有 400 凭据拒绝进入该分类，其它失败保持原判据", () => {
  for (const text of [
    // 非 400 上下文：运维/审计文本里出现同名字样不得改写分类。
    "审计摘要：Job credential in body 命中 2 次",
    "gateway 500: Job credential in body",
    // provider 封装形态只认 400：(500) 不得进入该分类。
    "agent 运行失败: agent CLI 退出码 1: Pi message ended: error: OpenAI API error (500): Job credential in body",
    "error: 500: Job credential in body",
    // 既有重试家族必须不受影响。
    "agent 运行失败: agent CLI 退出码 1: Pi message ended: error: 409: COMPLETION_ALREADY_ACCEPTED",
    "Gateway 429 rate limited",
    "CONTAINER_START_FAILED",
    "Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)",
    "upstream stream ended before message_stop",
  ]) {
    assert.equal(isCredentialInBusinessDataMessage(text), false, text);
    assert.notEqual(classifyDispatcherFailure(new Error(text)).reason, CREDENTIAL_IN_BUSINESS_DATA_REASON, text);
  }
  // 凭据拒绝是永久失败：不得被任何自动重试预算消费，也不得被 provision 重试名单命中。
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(isCredentialInBusinessDataMessage\(message\)\) return \{ reason: CREDENTIAL_IN_BUSINESS_DATA_REASON/,
    "分类必须早于 exception fallback",
  );
  assert.match(source, /classified\.reason === CREDENTIAL_IN_BUSINESS_DATA_REASON\) msg = classified\.message/);
  const refusal = classifyDispatcherFailure(
    new Error("agent 运行失败: agent CLI 退出码 1: Pi message ended: error: 400: Job credential in body"),
  );
  assert.notEqual(refusal.reason, PI_STREAM_TRUNCATED_REASON);
  assert.notEqual(refusal.reason, CONTEXT_WINDOW_EXCEEDED_REASON);
  assert.equal(isRetryableProvisionFailure(new Error(refusal.message)), false);
});