import assert from "node:assert/strict";
import test from "node:test";
import {
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
  assert.deepEqual(scanner.finish(), { input: 12, output: 5, total: 17 });
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
    joinGatewayUpstreamUrl("https://ai.feei.cn/v1", "v1/messages"),
    "https://ai.feei.cn/v1/messages",
  );
  assert.equal(
    joinGatewayUpstreamUrl("https://api.anthropic.com", "v1/messages"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    joinGatewayUpstreamUrl("https://ai.feei.cn/v1/", "/v1/messages", "?beta=1"),
    "https://ai.feei.cn/v1/messages?beta=1",
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

test("OpenAI usage 字段可解析，重复完整行不会重复计费", () => {
  const line = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":7}}';
  assert.deepEqual(extractUsageBreakdown(line), { input: 20, output: 7, total: 27 });
  const scanner = createGatewayUsageScanner();
  scanner.push(`${line}\n${line}\n`);
  assert.deepEqual(scanner.finish(), { input: 20, output: 7, total: 27 });
});
