import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import test from "node:test";
import { assertGatewayOutputBudget, assertGatewayUnambiguousPolicyJson, gatewayObservationBytes, transparentGatewayUrl } from "./gateway-transparent-policy.js";
import { RepairTokenBudgetError } from "./domains/event-ingestion/repair-token-budget.js";

test("Gateway URL mapping strips only the exact bound base-path overlap and preserves opaque URI bytes", () => {
  for (const [base, path, query, expected] of [
    ["https://relay.invalid", "v1/messages", "", "https://relay.invalid/v1/messages"],
    ["https://relay.invalid/v1/", "/v1/messages", "", "https://relay.invalid/v1/messages"],
    ["https://relay.invalid/prefix/v1", "v1/messages", "", "https://relay.invalid/prefix/v1/v1/messages"],
    ["https://relay.invalid/v1", "v10/messages", "", "https://relay.invalid/v1/v10/messages"],
    ["https://relay.invalid/v1", "v1", "", "https://relay.invalid/v1"],
    ["HTTP://RELAY.invalid:80/prefix", "/prefix/%2e/%2F/a/../b", "?a=1&a=2&empty=&bare&x=%2f",
      "http://relay.invalid/prefix/%2e/%2F/a/../b?a=1&a=2&empty=&bare&x=%2f"],
    ["https://relay.invalid/%70refix", "prefix/messages", "", "https://relay.invalid/%70refix/prefix/messages"],
  ]) assert.equal(transparentGatewayUrl(base!, path!, query!), expected);
});

test("Gateway URL mapping rejects target ambiguity, invalid HTTP bytes and path/query boundary confusion", () => {
  for (const base of ["file:///tmp/test", "https://user:password@relay.invalid", "https://relay.invalid#fragment",
    "https://relay.invalid?config=1", "https://relay.invalid\\other/path", "https://relay.invalid /path"]) {
    assert.throws(() => transparentGatewayUrl(base, "v1/messages"));
  }
  for (const path of ["//other.invalid/path", "v1/messages?hidden=query", "v1/has space", "v1/has\\slash",
    "v1/fragment#value", "v1/line\r\nheader"]) assert.throws(() => transparentGatewayUrl("https://relay.invalid/v1", path));
  for (const query of ["not-a-query", "?x=has space", "?x=fragment#value", "?x=has\\slash"]) {
    assert.throws(() => transparentGatewayUrl("https://relay.invalid/v1", "messages", query));
  }
});

test("observation decoding supports identity/gzip/deflate/br without changing forwarded representation", () => {
  const original = Buffer.from('{"model":"fixture","usage":{"total_tokens":7}}');
  assert.equal(gatewayObservationBytes(original, undefined), original);
  assert.equal(gatewayObservationBytes(original, "identity"), original);
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
    const encoded = compress(original);
    const before = Buffer.from(encoded);
    assert.deepEqual(gatewayObservationBytes(encoded, encoding), original);
    assert.deepEqual(encoded, before, "the forwarded compressed byte buffer is untouched");
  }
  assert.throws(() => gatewayObservationBytes(original, "unknown"), /unsupported_content_encoding/u);
  assert.throws(() => gatewayObservationBytes(original, "gzip"));
  assert.throws(() => gatewayObservationBytes(gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)), "gzip"),
    "decompression never bypasses the bounded observation budget");
});

test("budget admission accepts compliant original protocol parameters without mutating request objects", () => {
  const cases = [
    { path: "v1/messages", body: { model: "fixture", max_tokens: 4, extension: { enabled: true } } },
    { path: "v1/chat/completions", body: { max_completion_tokens: 4, messages: [], stream: true, stream_options: { include_usage: true, extension: 1 } } },
    { path: "v1/chat/completions", body: { max_tokens: 4, messages: [] } },
    { path: "v1/responses", body: { max_output_tokens: 4, input: "fixture" } },
    { path: "v1/completions", body: { max_tokens: 4, prompt: "fixture" } },
  ];
  for (const fixture of cases) {
    const original = structuredClone(fixture.body);
    assert.doesNotThrow(() => assertGatewayOutputBudget(fixture.body, fixture.path, 10));
    assert.deepEqual(fixture.body, original);
  }
  assert.doesNotThrow(() => assertGatewayOutputBudget({ messages: [] }, "v1/chat/completions", null));
});

test("budget admission rejects missing/excess limits and missing terminal stream usage instead of adapting", () => {
  for (const body of [
    { messages: [] }, { max_completion_tokens: 11 }, { max_tokens: 11 },
    { max_completion_tokens: 10, stream: true },
    { max_completion_tokens: 10, stream: true, stream_options: { include_usage: false } },
  ]) {
    const before = structuredClone(body);
    assert.throws(() => assertGatewayOutputBudget(body, "v1/chat/completions", 10),
      (error: unknown) => error instanceof RepairTokenBudgetError && error.code === "GATEWAY_OUTPUT_BUDGET_REQUIRED");
    assert.deepEqual(body, before);
  }
  for (const body of [{ n: 3 }, { best_of: 3 }, { max_completion_tokens: -1 }, Buffer.from("binary")]) {
    assert.throws(() => assertGatewayOutputBudget(body, "v1/chat/completions", 10),
      (error: unknown) => error instanceof RepairTokenBudgetError && error.code === "REPAIR_PROTOCOL_UNSUPPORTED");
  }
});

test("Gateway rejects duplicate policy members even when the last value passes admission", () => {
  for (const source of [
    '{"max_tokens":9999,"max_tokens":3}',
    '{"max_completion_tokens":9999,"max_completion_tokens":3}',
    '{"max_output_tokens":9999,"max_output_tokens":3}',
    '{"n":8,"n":1,"max_tokens":3}',
    '{"best_of":8,"best_of":1,"max_tokens":3}',
    '{"model":"unauthorized","model":"allowed"}',
    '{"stream":false,"stream":true}',
    '{"stream_options":{"include_usage":false},"stream_options":{"include_usage":true}}',
    '{"stream_options":{"include_usage":false,"include_usage":true}}',
    String.raw`{"max_\u0074okens":9999,"max_tokens":3}`,
    String.raw`{"stream_\u006fptions":{"include_\u0075sage":false,"include_usage":true}}`,
  ]) {
    const bytes = Buffer.from(source), before = Buffer.from(bytes);
    assert.throws(() => assertGatewayUnambiguousPolicyJson(bytes), /ambiguous_gateway_policy_json/u);
    assert.deepEqual(bytes, before, "rejection never rewrites the wire representation");
  }
});

test("Gateway preserves unknown duplicate business keys and ignores policy-like nested extension keys", () => {
  const source = String.raw` {"max_tokens":3,"extension":1,"extension":9007199254740993,"nested":{"model":"one","model":"two","n":8,"n":1},"array":[{"max_tokens":100,"max_tokens":3}],"quoted":"} \" \\","stream_options":{"extension":1,"extension":2,"include_usage":true,"nested":{"include_usage":false,"include_usage":true}}} `;
  const bytes = Buffer.from(source), before = Buffer.from(bytes);
  assert.doesNotThrow(() => JSON.parse(source), "the nested duplicate fixture is valid JSON");
  assert.doesNotThrow(() => assertGatewayUnambiguousPolicyJson(bytes));
  assert.deepEqual(bytes, before);
  for (const nonObject of ['[]', 'null', '"string"', '42', '{invalid']) {
    assert.doesNotThrow(() => assertGatewayUnambiguousPolicyJson(Buffer.from(nonObject)), "existing body parsing owns non-object and invalid JSON policy");
  }
});
