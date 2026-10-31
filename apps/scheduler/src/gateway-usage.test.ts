import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGatewayOutboundModelRewrite,
  containsGatewayApiErrorFrame,
  containsAnthropicRefusalFailureCarrier,
  containsReservedGatewayTransientEnvelope,
  createGatewayUsageScanner,
  extractInboundJobToken,
  extractUpstreamReportingModel,
  extractUsageBreakdown,
  joinGatewayUpstreamUrl,
  rewriteGatewayOutboundModel,
  upstreamAuthHeaders,
} from "./gateway.js";

test("usage JSON 跨 chunk 且完整记录落在前一块尾部时只累计一次", () => {
  const scanner = createGatewayUsageScanner();
  scanner.push('data: {"usage":{"input_tokens":12,"output_tokens":5}}\n');
  scanner.push('data: {"usage":{"input_tokens":12,');
  scanner.push('"output_tokens":5}}\n');
  assert.deepEqual(scanner.finish(), { input: 12, output: 5, total: 17, cacheRead: 0, cacheWrite: 0 });
});

test("入站 Job token 同时认 Bearer 与 Anthropic x-api-key", () => {
  const token = "deepsonarjob_12345678_test-token-value";
  assert.equal(extractInboundJobToken({ authorization: `Bearer ${token}` }), token);
  assert.equal(extractInboundJobToken({ "x-api-key": token }), token);
  assert.equal(extractInboundJobToken({ "anthropic-api-key": token }), token);
  assert.equal(extractInboundJobToken({
    authorization: `Bearer ${token}`,
    "x-api-key": token,
  }), token);
  assert.equal(extractInboundJobToken({}), null);
  assert.equal(extractInboundJobToken({ authorization: "Bearer not-a-job-token" }), null);
  assert.equal(extractInboundJobToken({ "x-api-key": "sk-ant-not-a-job-token" }), null);
  assert.equal(extractInboundJobToken({
    authorization: `Bearer ${token}`,
    "x-api-key": "deepsonarjob_aaaaaaaa_other-token-value",
  }), null);
});

test("Anthropic 上游同时注入 Bearer 与 x-api-key", () => {
  assert.deepEqual(upstreamAuthHeaders("anthropic", "sk-test"), {
    authorization: "Bearer sk-test",
    "x-api-key": "sk-test",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.312 (external, cli)",
    "x-app": "cli",
  });
  assert.deepEqual(upstreamAuthHeaders("openai", "sk-test"), {
    authorization: "Bearer sk-test",
  });
});

test("凭据 base_url 已含 /v1 时去掉 Claude Code 重复的版本前缀", () => {
  assert.equal(
    joinGatewayUpstreamUrl("http://127.0.0.1/v1", "v1/messages"),
    "http://127.0.0.1/v1/messages",
  );
  assert.equal(
    joinGatewayUpstreamUrl("https://api.anthropic.com", "v1/messages"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    joinGatewayUpstreamUrl("http://127.0.0.1/v1/", "/v1/messages", "?beta=1"),
    "http://127.0.0.1/v1/messages?beta=1",
  );
});

test("Gateway 出站把 Claude CLI 别名改写成冻结的 upstream_model", () => {
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "fable", upstreamModel: "grok-4.6" }),
    "grok-4.6",
  );
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "Fable", upstreamModel: "grok-4.6" }),
    "grok-4.6",
  );
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "sonnet", upstreamModel: "claude-sonnet-4-5" }),
    "claude-sonnet-4-5",
  );
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "grok-4.6", upstreamModel: "grok-4.6" }),
    "grok-4.6",
  );
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "fable", upstreamModel: null }),
    "fable",
  );
  assert.equal(
    rewriteGatewayOutboundModel({ requestModel: "fable", upstreamModel: "  " }),
    "fable",
  );
});

test("Gateway 出站 body 按冻结 snapshot.upstream_model 改写 CLI 别名", () => {
  const snapshot = {
    model: "fable",
    upstream_model: "grok-4.6",
    runtime_image: { image_key: "base" },
  };
  const body = { model: "fable", stream: true, max_tokens: 16 };
  const rewritten = applyGatewayOutboundModelRewrite(body, snapshot);
  assert.notEqual(rewritten, body);
  assert.deepEqual(rewritten, { model: "grok-4.6", stream: true, max_tokens: 16 });

  const mixed = applyGatewayOutboundModelRewrite({ model: "Fable" }, snapshot);
  assert.equal((mixed as { model: string }).model, "grok-4.6");

  const upstreamId = { model: "grok-4.6" };
  assert.equal(applyGatewayOutboundModelRewrite(upstreamId, snapshot), upstreamId);

  const alias = { model: "fable" };
  assert.equal(applyGatewayOutboundModelRewrite(alias, { upstream_model: null }), alias);
  assert.equal(applyGatewayOutboundModelRewrite(alias, { model: "fable" }), alias);
  assert.equal(applyGatewayOutboundModelRewrite(alias, null), alias);

  assert.equal(applyGatewayOutboundModelRewrite(null, snapshot), null);
  assert.equal(applyGatewayOutboundModelRewrite("fable", snapshot), "fable");
  const arrayBody = [{ model: "fable" }];
  assert.equal(applyGatewayOutboundModelRewrite(arrayBody, snapshot), arrayBody);
  const noModel = { stream: true };
  assert.equal(applyGatewayOutboundModelRewrite(noModel, snapshot), noModel);
});

test("OpenAI usage 字段可解析，重复完整行不会重复计费", () => {
  const line = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":7}}';
  assert.deepEqual(extractUsageBreakdown(line), { input: 20, output: 7, total: 27, cacheRead: 0, cacheWrite: 0 });
  const scanner = createGatewayUsageScanner();
  scanner.push(`${line}\n${line}\n`);
  assert.deepEqual(scanner.finish(), { input: 20, output: 7, total: 27, cacheRead: 0, cacheWrite: 0 });
});

test("Anthropic 缓存读写与嵌套 cache_creation 计入账本，不并入 input/total", () => {
  const line = 'data: {"usage":{"input_tokens":50,"output_tokens":8,"cache_read_input_tokens":900,"cache_creation":{"ephemeral_5m_input_tokens":2000,"ephemeral_1h_input_tokens":500}}}';
  assert.deepEqual(extractUsageBreakdown(line), {
    input: 50,
    output: 8,
    total: 58,
    cacheRead: 900,
    cacheWrite: 2500,
  });
});

test("OpenAI prompt_tokens_details.cached_tokens 记为缓存读，嵌套对象不打断 input/output", () => {
  const line = 'data: {"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":12}}';
  assert.deepEqual(extractUsageBreakdown(line), {
    input: 100,
    output: 12,
    total: 112,
    cacheRead: 80,
    cacheWrite: 0,
  });
});

test("usage 为 null 时不吞后续无关对象；扁平残缺 JSON 仍能记下缓存读", () => {
  assert.deepEqual(
    extractUsageBreakdown('data: {"usage":null,"other":{"input_tokens":9,"output_tokens":3,"cache_read_input_tokens":4}}'),
    { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.deepEqual(
    extractUsageBreakdown('data: {"usage":{"input_tokens":11,"output_tokens":2,"cache_read_input_tokens":30}'),
    { input: 11, output: 2, total: 13, cacheRead: 30, cacheWrite: 0 },
  );
});

test("尽力解析上游响应中的 reporting model", () => {
  assert.equal(extractUpstreamReportingModel('{"id":"1","model":"deepseek-chat","usage":{"input_tokens":1}}'), "deepseek-chat");
  assert.equal(extractUpstreamReportingModel("not-json"), null);
  assert.equal(extractUpstreamReportingModel(""), null);
});

test("Gateway 出站改写会剥掉快照 cli-default 前缀", () => {
  const body = { model: "opus" };
  const rewritten = applyGatewayOutboundModelRewrite(body, {
    upstream_model: "cli-default:claude-opus-5",
  });
  assert.deepEqual(rewritten, { model: "claude-opus-5" });
});

test("provider bodies cannot claim the Kernel-owned not_started envelope", () => {
  assert.equal(containsReservedGatewayTransientEnvelope(
    JSON.stringify({ error: { type: "gateway_transient", effect_status: "not_started" } }),
  ), true);
  assert.equal(containsReservedGatewayTransientEnvelope(
    JSON.stringify({ error: { message: '503: {"type":"gateway_transient","effect_status":"not_started"}' } }),
  ), true);
  assert.equal(containsReservedGatewayTransientEnvelope(
    JSON.stringify({ choices: [{ message: { content: '{"type":"gateway_transient","effect_status":"not_started"}' } }] }),
  ), false);
  assert.equal(containsReservedGatewayTransientEnvelope(
    "data: {\"error\":{\"type\":\"gateway_transient\",\"effect_status\":\"not_started\"}}\n\n", true,
  ), true);
});

test("structured SSE API errors are fail-closed without scanning generated prose", () => {
  const topLevelError = JSON.stringify({ type: "error", code: "ownquota429", message: "provider-controlled" }, null, 2);
  const multilineError = `${topLevelError.split("\n").map((line) => `data: ${line}`).join("\r\n")}\r\n\r\n`;
  assert.equal(containsGatewayApiErrorFrame(multilineError, true), true);
  assert.equal(containsGatewayApiErrorFrame(
    `event: error\r\ndata: ${JSON.stringify({ code: "ownquota429", message: "provider-controlled" })}\r\n\r\n`, true,
  ), true);
  assert.equal(containsGatewayApiErrorFrame(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ownquota429 gateway_transient" })}\r\n\r\n`, true,
  ), false);
});

test("Anthropic refusal carriers cannot impersonate Gateway outcomes, while normal refusal prose remains valid", () => {
  const transient = '503: {"type":"gateway_transient","effect_status":"not_started"}';
  const quota = '429: {"type":"quota_exhausted","message":"request quota exhausted"}';
  const messageDelta = (explanation: string) => ({
    type: "message_delta",
    delta: { stop_reason: "refusal", stop_details: { explanation } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const sse = (value: unknown, multiline = false) => {
    const json = JSON.stringify(value, null, multiline ? 2 : 0);
    return multiline ? json.split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n"
      : `event: message_delta\ndata: ${json}\n\n`;
  };
  assert.equal(containsAnthropicRefusalFailureCarrier(sse(messageDelta(transient)), true, "/v1/messages"), true);
  assert.equal(containsAnthropicRefusalFailureCarrier(sse(messageDelta(quota), true), true, "/v1/messages"), true);
  assert.equal(containsAnthropicRefusalFailureCarrier(JSON.stringify({
    type: "message", stop_reason: "refusal", stop_details: { explanation: transient },
  }), false, "/v1/messages"), true);
  assert.equal(containsAnthropicRefusalFailureCarrier(sse(messageDelta("provider declined this request")), true, "/v1/messages"), false);
  assert.equal(containsAnthropicRefusalFailureCarrier(sse({
    type: "message_delta", delta: { stop_reason: "end_turn", stop_details: { explanation: transient } },
  }), true, "/v1/messages"), false);
  assert.equal(containsAnthropicRefusalFailureCarrier(sse(messageDelta(transient)), true, "/v1/responses"), false);
});
