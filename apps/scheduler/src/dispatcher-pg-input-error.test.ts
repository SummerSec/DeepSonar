import assert from "node:assert/strict";
import test from "node:test";
import { classifyDispatcherFailure } from "./dispatcher.js";
import { EVENT_PAYLOAD_CONTROL_CHARACTERS_MESSAGE, EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON } from "./pg-input-error.js";
import { CREDENTIAL_IN_BUSINESS_DATA_REASON } from "./credential-refusal.js";
import { CONTEXT_WINDOW_EXCEEDED_REASON } from "./context-window-exceeded.js";
import { PI_STREAM_TRUNCATED_REASON } from "./pi-stream-truncation.js";

test("22P05 输入拒绝分类为稳定 reason 且不回显数据库原文", () => {
  const incident = new Error(
    "agent 运行失败: agent CLI 退出码 1: unsupported Unicode escape sequence (22P05; \u0000 cannot be converted to text.)",
  );
  const classified = classifyDispatcherFailure(incident);
  assert.equal(classified.reason, EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON);
  assert.equal(classified.message, EVENT_PAYLOAD_CONTROL_CHARACTERS_MESSAGE);
  assert.match(classified.message, /^event_payload_control_characters: /u);
  assert.doesNotMatch(classified.message, /cannot be converted to text|unsupported Unicode escape/u);
  assert.doesNotMatch(classified.message, /\u0000/u);
});

test("裸 22P05 代码与嵌套错误体同样分类", () => {
  assert.equal(
    classifyDispatcherFailure(new Error("insert into events failed (22P05)")).reason,
    EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON,
  );
  const nested = Object.assign(new Error("event ingestion failed"), {
    error: { message: "unsupported Unicode escape sequence: \u0000 cannot be converted to text." },
  });
  assert.equal(classifyDispatcherFailure(nested).reason, EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON);
});

test("非 22P05 文本保持既有分类，不被新分支抢占", () => {
  assert.equal(classifyDispatcherFailure(new Error("agent CLI 退出码 1: 500 upstream error")).reason, "exception");
  assert.equal(
    classifyDispatcherFailure(new Error("Pi message ended: error: 400: Job credential in body")).reason,
    CREDENTIAL_IN_BUSINESS_DATA_REASON,
  );
  assert.equal(
    classifyDispatcherFailure(new Error("Prompt is too long: context window exceeded")).reason,
    CONTEXT_WINDOW_EXCEEDED_REASON,
  );
  assert.equal(classifyDispatcherFailure(new Error("Pi stream truncated before message_stop")).reason, PI_STREAM_TRUNCATED_REASON);
});