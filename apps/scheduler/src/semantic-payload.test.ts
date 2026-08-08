import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlToolInputSchemasJson,
  EmitFactPayload,
  EmitFindingPayload,
  FactPayload,
  FindingPayload,
  HumanPayload,
  DonePayload,
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

test("advertised semantic MCP schemas remain top-level objects", () => {
  for (const name of ["emit_fact", "emit_finding"] as const) {
    const schema = ControlToolInputSchemasJson[name] as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
    assert.equal(schema.type, "object");
    assert.equal(Array.isArray(schema.anyOf), false);
    assert.equal(Array.isArray(schema.oneOf), false);
  }
});
