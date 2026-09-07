import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlToolInputSchemasJson,
  EmitFactDirectPayload,
  EmitFactPayload,
  EmitFindingDirectPayload,
  EmitFindingPayload,
  FactPayload,
  FindingPayload,
  HumanPayload,
  DonePayload,
  QUANTITY_ANCHOR_MAX,
  QuantityAnchor,
} from "@deepsonar/shared-types";

const fact = { title: "事实标题", description: "This fact includes enough evidence context." };
const finding = {
  title: "认证路径存在重放风险",
  summary: "This finding summary contains enough durable evidence context.",
};

test("semantic payloads reject truncated direct content at shared boundaries", () => {
  assert.equal(EmitFactPayload.safeParse({ title: "x", description: "short" }).success, false);
  assert.equal(EmitFindingPayload.safeParse({ title: "short", summary: "short" }).success, false);
  assert.equal(FactPayload.safeParse({ title: "x", description: fact.description }).success, false);
  assert.equal(FindingPayload.safeParse({ title: finding.title }).success, false);
  assert.equal(DonePayload.safeParse({ summary: "x" }).success, false);
  assert.equal(HumanPayload.safeParse({ reason: "x" }).success, false);
});

test("request_human requires one explicit structured subject", () => {
  assert.equal(HumanPayload.safeParse({
    reason: "需要人工确认当前风险接受边界。",
    subject: { type: "finding", finding_id: "00000000-0000-4000-8000-000000000001", subject_revision: "app@abc123" },
  }).success, true);
  assert.equal(HumanPayload.safeParse({
    reason: "需要人工提供隔离测试账号。",
    subject: { type: "platform_blocker", kind: "credential" },
  }).success, true);
  assert.equal(HumanPayload.safeParse({
    reason: "尝试通过自由文本绕过结构化目标。",
  }).success, false);
});

test("semantic tool payloads accept exactly one direct object or payload_file", () => {
  assert.equal(EmitFactPayload.safeParse(fact).success, true);
  assert.equal(EmitFactPayload.safeParse({ payload_file: "fact.json" }).success, true);
  assert.equal(EmitFactPayload.safeParse({ ...fact, payload_file: "fact.json" }).success, false);
  assert.equal(EmitFindingPayload.safeParse(finding).success, true);
  assert.equal(EmitFindingPayload.safeParse({ payload_file: "finding.json" }).success, true);
  assert.equal(EmitFindingPayload.safeParse({ ...finding, payload_file: "finding.json" }).success, false);
  assert.equal(EmitFindingPayload.safeParse({ payload_file: "../finding.json" }).success, false);
  assert.equal(EmitFactPayload.safeParse({ payload_file: "C:\\tmp\\fact.json" }).success, false);
});

const quantity = {
  value: 774,
  unit: "Ghidra records after 37 LDDW fold",
  basis: "811 8-byte ELF slots minus folded LDDW aliases",
  ref: "evidence/elf-slots.json",
};

test("optional quantities accept a strict capped list on fact and finding payloads", () => {
  const withQuantities = { ...fact, quantities: [quantity] };
  const findingWithQuantities = { ...finding, quantities: [quantity] };
  assert.equal(QuantityAnchor.safeParse(quantity).success, true);
  assert.equal(FactPayload.safeParse(withQuantities).success, true);
  assert.equal(EmitFactPayload.safeParse(withQuantities).success, true);
  assert.equal(EmitFactDirectPayload.safeParse(withQuantities).success, true);
  assert.equal(FindingPayload.safeParse(findingWithQuantities).success, true);
  assert.equal(EmitFindingPayload.safeParse(findingWithQuantities).success, true);
  assert.equal(EmitFindingDirectPayload.safeParse(findingWithQuantities).success, true);
});

test("quantities reject extra fields, missing unit/basis, and more than 20 entries", () => {
  assert.equal(QuantityAnchor.safeParse({ value: 1, unit: "slots", extra: true }).success, false);
  assert.equal(QuantityAnchor.safeParse({ value: 1, unit: "slots" }).success, false);
  assert.equal(QuantityAnchor.safeParse({ value: "774", unit: "slots", basis: "raw count" }).success, false);
  assert.equal(QuantityAnchor.safeParse({ value: Number.NaN, unit: "slots", basis: "raw count" }).success, false);
  const tooMany = Array.from({ length: QUANTITY_ANCHOR_MAX + 1 }, () => quantity);
  assert.equal(FactPayload.safeParse({ ...fact, quantities: tooMany }).success, false);
  assert.equal(FindingPayload.safeParse({ ...finding, quantities: tooMany }).success, false);
  assert.equal(FactPayload.safeParse({ ...fact, quantities: tooMany.slice(0, QUANTITY_ANCHOR_MAX) }).success, true);
});

test("undeclared quantities remain optional so prose numbers stay unprotected", () => {
  assert.equal(FactPayload.safeParse(fact).success, true);
  assert.equal(FindingPayload.safeParse(finding).success, true);
});

test("emit_finding rejects leftover suggest_verify as an unknown field", () => {
  const withSuggestion = { ...finding, suggest_verify: true };
  assert.equal(FindingPayload.safeParse(withSuggestion).success, false);
  assert.equal(EmitFindingPayload.safeParse(withSuggestion).success, false);
  assert.equal(EmitFindingDirectPayload.safeParse(withSuggestion).success, false);
});

test("mark_job_done rejects leftover false_positive verdict", () => {
  const summary = "验证结束：证据不足，需要补运行时复现。";
  assert.equal(DonePayload.safeParse({ summary, verdict: "rework" }).success, true);
  assert.equal(DonePayload.safeParse({ summary, verdict: "false_positive" }).success, false);
});

test("advertised semantic MCP schemas remain top-level objects", () => {
  for (const name of ["emit_fact", "emit_finding"] as const) {
    const schema = ControlToolInputSchemasJson[name] as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
    assert.equal(schema.type, "object");
    assert.equal(Array.isArray(schema.anyOf), false);
    assert.equal(Array.isArray(schema.oneOf), false);
  }
});
