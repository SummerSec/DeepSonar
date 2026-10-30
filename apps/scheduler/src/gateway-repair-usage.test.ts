import assert from "node:assert/strict";
import test from "node:test";
import { createRepairUsageScanner } from "./gateway-repair-usage.js";

// Offline provider protocol fixtures, not model-quality or paid-provider tests.
const oaUsage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } };
const oa = { object: "chat.completion", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: oaUsage };
const anthropic = { type: "message", role: "assistant", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
const response = { object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 } } };
const event = (value: unknown, name?: string) => `${name ? `event: ${name}\n` : ""}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
function scan(path: string, value: unknown, sse = false, chunk = 7) {
  const scanner = createRepairUsageScanner(path, sse);
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  for (let i = 0; i < bytes.length; i += chunk) scanner.push(bytes.subarray(i, i + chunk));
  return scanner.finish();
}
const chatEnd = { object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null };
const chatUsage = { object: "chat.completion.chunk", choices: [], usage: oaUsage };
const chatStream = event(chatEnd) + event(chatUsage) + event("[DONE]");
const antStart = { type: "message_start", message: { ...anthropic, stop_reason: null, usage: { ...anthropic.usage, output_tokens: 1 } } };
const antDelta = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } };
const antStop = { type: "message_stop" };
const antStream = event(antStart, "message_start") + event(antDelta, "message_delta") + event(antStop, "message_stop");

test("strict JSON protocols retain provider cache accounting and zero usage", () => {
  assert.deepEqual(scan("/v1/chat/completions", oa), { input: 10, output: 4, total: 14, cacheRead: 3, cacheWrite: 0 });
  assert.deepEqual(scan("v1/completions", { ...oa, object: "text_completion" }), { input: 10, output: 4, total: 14, cacheRead: 3, cacheWrite: 0 });
  assert.deepEqual(scan("responses", response), { input: 10, output: 4, total: 14, cacheRead: 3, cacheWrite: 0 });
  assert.deepEqual(scan("v1/messages", anthropic), { input: 10, output: 4, total: 19, cacheRead: 3, cacheWrite: 2 });
  assert.deepEqual(scan("chat/completions", { ...oa, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 });
});

test("JSON ignores assistant/tool self-reported usage and requires complete envelopes", () => {
  for (const value of [
    { ...oa, usage: undefined, choices: [{ finish_reason: "stop", message: { content: '{"usage":{"prompt_tokens":2,"completion_tokens":1}}' } }] },
    { ...oa, usage: undefined, tool: { usage: oaUsage } },
    { ...oa, error: { message: "failed" } }, { ...oa, choices: [{ finish_reason: null }] },
  ]) assert.equal(scan("chat/completions", value), null);
  assert.equal(scan("responses", { ...response, status: "incomplete" }), null);
  assert.equal(scan("messages", { ...anthropic, stop_reason: null }), null);
  assert.equal(scan("other", oa), null);
  assert.equal(scan("chat/completions", JSON.stringify(oa).slice(0, -1)), null);
});

test("invalid, missing, unsafe and contradictory counts are unknown", () => {
  for (const bad of [null, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(scan("chat/completions", { ...oa, usage: { ...oaUsage, completion_tokens: bad } }), null);
  }
  assert.equal(scan("chat/completions", { ...oa, usage: { prompt_tokens: 10, total_tokens: 10 } }), null);
  assert.equal(scan("chat/completions", { ...oa, usage: { ...oaUsage, total_tokens: 999 } }), null);
  assert.equal(scan("chat/completions", { ...oa, usage: { ...oaUsage, prompt_tokens_details: { cached_tokens: 11 } } }), null);
  assert.equal(scan("messages", { ...anthropic, usage: { ...anthropic.usage, cache_creation: { ephemeral_5m_input_tokens: 9 } } }), null);
});

test("OpenAI SSE requires DONE and finished choices, deduplicates cumulative usage", () => {
  const expected = scan("chat/completions", oa);
  assert.deepEqual(scan("chat/completions", chatStream, true), expected);
  assert.deepEqual(scan("chat/completions", event(chatEnd) + event(chatUsage) + event(chatUsage) + event("[DONE]"), true), expected);
  assert.equal(scan("chat/completions", event(chatEnd) + event(chatUsage), true), null);
  assert.equal(scan("chat/completions", event(chatUsage) + event("[DONE]"), true), null);
  assert.equal(scan("chat/completions", chatStream + event(chatUsage), true), null);
  assert.equal(scan("chat/completions", event({ ...chatEnd, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) + event(chatUsage) + event("[DONE]"), true), null);
});

test("Responses SSE accepts only completed response usage, not text deltas", () => {
  const stream = event({ type: "response.output_text.delta", delta: '{"usage":{"input_tokens":1}}' }) + event({ type: "response.completed", response });
  assert.deepEqual(scan("v1/responses", stream, true), scan("responses", response));
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    assert.equal(scan("responses", event({ type }) + stream, true), null);
  }
  assert.equal(scan("responses", event({ type: "response.output_text.delta", usage: response.usage }), true), null);
});

test("Anthropic SSE joins start input and final cumulative output with stop", () => {
  const expected = scan("messages", anthropic);
  assert.deepEqual(scan("messages", antStream, true), expected);
  assert.deepEqual(scan("messages", event(antStart) + event(antDelta) + event(antDelta) + event(antStop), true), expected);
  assert.equal(scan("messages", event(antStart) + event(antDelta), true), null);
  assert.equal(scan("messages", event(antStart) + event(antStop), true), null);
  assert.equal(scan("messages", event(antStart) + event(antDelta) + event({ ...antDelta, usage: { output_tokens: 2 } }) + event(antStop), true), null);
  assert.equal(scan("messages", event({ type: "error", error: { type: "overloaded_error" } }) + antStream, true), null);
});

test("truncated SSE, malformed UTF8, mismatched events and bounded input fail closed", () => {
  assert.equal(scan("messages", antStream.slice(0, -2), true), null);
  assert.equal(scan("messages", "event: error\n\n" + antStream, true), null);
  assert.equal(scan("messages", event(antStart, "error") + event(antDelta) + event(antStop), true), null);
  const scanner = createRepairUsageScanner("chat/completions", true);
  scanner.push(Buffer.from([0xc3, 0x28])); scanner.push(chatStream);
  assert.equal(scanner.finish(), null);
  assert.equal(scan("chat/completions", "x".repeat(1_048_577), false, 65536), null);
  assert.equal(scan("chat/completions", `data: ${"x".repeat(1_048_577)}`, true, 65536), null);
});

test("SSE CRLF, UTF8 split boundaries and repeated finish preserve results", () => {
  const stream = event({ ...chatEnd, choices: [{ index: 0, delta: { content: "修正" }, finish_reason: "stop" }] }) + event(chatUsage) + event("[DONE]");
  assert.deepEqual(scan("chat/completions", stream.replaceAll("\n", "\r\n"), true, 1), scan("chat/completions", oa));
  const scanner = createRepairUsageScanner("chat/completions", true);
  scanner.push(chatStream);
  assert.deepEqual(scanner.finish(), scanner.finish());
  scanner.push("late");
  assert.equal(scanner.finish(), null);
});


test("Anthropic delta input/cache snapshots cannot be silently undercounted", () => {
  const revised = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8, cache_creation_input_tokens: 6 };
  const update = { ...antDelta, usage: revised };
  const nextOutput = { ...antDelta, usage: { output_tokens: 7 } };
  const stream = event(antStart) + event(update) + event(update) + event(nextOutput) + event(antStop);
  assert.deepEqual(scan("messages", stream, true), { input: 12, output: 7, total: 33, cacheRead: 8, cacheWrite: 6 });
  for (const [field, value] of [["input_tokens", 9], ["cache_read_input_tokens", 2], ["cache_creation_input_tokens", 1]]) {
    assert.equal(scan("messages", event(antStart) + event({ ...antDelta, usage: { output_tokens: 4, [field]: value } }) + event(antStop), true), null);
  }
  // Nested cache details are also validated rather than discarded.
  assert.equal(scan("messages", event(antStart) + event({ ...antDelta, usage: { output_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 9 } } }) + event(antStop), true), null);
  for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    for (const invalid of [null, -1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(scan("messages", event(antStart) + event({ ...antDelta, usage: { output_tokens: 4, [field]: invalid } }) + event(antStop), true), null);
    }
  }
});

test("stream zero usage is known, and fractional usage is unknown across protocols", () => {
  const zero = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  const zeroChat = { ...chatUsage, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  assert.deepEqual(scan("chat/completions", event(chatEnd) + event(zeroChat) + event(zeroChat) + event("[DONE]"), true), zero);
  const zeroResponse = { ...response, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  assert.deepEqual(scan("responses", event({ type: "response.completed", response: zeroResponse }), true), zero);
  const zeroStart = { ...antStart, message: { ...antStart.message, usage: { input_tokens: 0, output_tokens: 0 } } };
  const zeroDelta = { ...antDelta, usage: { output_tokens: 0 } };
  assert.deepEqual(scan("messages", event(zeroStart) + event(zeroDelta) + event(zeroDelta) + event(antStop), true), zero);
  assert.equal(scan("chat/completions", event(chatEnd) + event({ ...zeroChat, usage: { ...zeroChat.usage, prompt_tokens: 0.5 } }) + event("[DONE]"), true), null);
  assert.equal(scan("responses", event({ type: "response.completed", response: { ...zeroResponse, usage: { ...zeroResponse.usage, output_tokens: 0.5 } } }), true), null);
});
