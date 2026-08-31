import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGatewayOutboundModelRewrite,
  createGatewayUsageScanner,
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

test("Anthropic 上游同时注入 Bearer 与 x-api-key", () => {
  assert.deepEqual(upstreamAuthHeaders("anthropic", "sk-test"), {
    authorization: "Bearer sk-test",
    "x-api-key": "sk-test",
    "anthropic-version": "2023-06-01",
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
