import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayUsageScanner, extractUsageBreakdown } from "./gateway.js";

test("usage JSON 跨 chunk 且完整记录落在前一块尾部时只累计一次", () => {
  const scanner = createGatewayUsageScanner();
  scanner.push('data: {"usage":{"input_tokens":12,"output_tokens":5}}\n');
  scanner.push('data: {"usage":{"input_tokens":12,');
  scanner.push('"output_tokens":5}}\n');
  assert.deepEqual(scanner.finish(), { input: 12, output: 5, total: 17 });
});

test("OpenAI usage 字段可解析，重复完整行不会重复计费", () => {
  const line = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":7}}';
  assert.deepEqual(extractUsageBreakdown(line), { input: 20, output: 7, total: 27 });
  const scanner = createGatewayUsageScanner();
  scanner.push(`${line}\n${line}\n`);
  assert.deepEqual(scanner.finish(), { input: 20, output: 7, total: 27 });
});
