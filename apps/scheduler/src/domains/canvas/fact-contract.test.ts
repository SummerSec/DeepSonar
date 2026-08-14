import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, cursorForRow } from "../../pagination.js";
import { boundedCanvasBody, projectCanvasNode } from "../../canvas-delta.js";
import { requiredScopeForRoute } from "../../auth.js";
import { FactListQuery, FactVerificationPatch } from "./fact-contract.js";

test("Fact 查询和人工验证契约严格拒绝非法输入", () => {
  const multi = FactListQuery.safeParse({ limit: "50", verification_status: "verified,rejected,verified", evidence_kind: "review,test" });
  assert.equal(multi.success, true);
  if (multi.success) {
    assert.deepEqual(multi.data.verification_status, ["verified", "rejected"]);
    assert.deepEqual(multi.data.evidence_kind, ["review", "test"]);
  }
  assert.equal(FactListQuery.safeParse({ verification_status: "verified,unknown" }).success, false);
  assert.equal(FactListQuery.safeParse({ limit: "0" }).success, false);
  assert.equal(FactListQuery.safeParse({ limit: "51" }).success, false);
  assert.equal(FactListQuery.safeParse({ finding_id: "not-a-uuid" }).success, false);
  assert.equal(FactListQuery.safeParse({ unknown: "value" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ status: "verified", note: "人工复核通过" }).success, true);
  assert.equal(FactVerificationPatch.safeParse({ status: "unverified" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ status: "verified", note: "x".repeat(2001) }).success, false);
});

test("facts keyset 游标只接受 canonical UUID 和时间戳", () => {
  const cursor = cursorForRow("facts", {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: new Date("2026-08-14T00:00:00.000Z"),
  });
  assert.deepEqual(decodeCursor(cursor, "facts"), {
    v: 1,
    kind: "facts",
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(decodeCursor(cursor, "findings"), null);
});

test("L0 从稳定列读取 Fact 验证态，并有界投影 human subject", () => {
  const fact = projectCanvasNode({
    id: "fact-1",
    node_type: "fact",
    title: "Fact",
    body_json: { verification_status: "rejected" },
    verification_status: "verified",
  });
  assert.equal(fact?.verification_status, "verified");

  const human = boundedCanvasBody({
    reason: "r".repeat(700),
    subject: {
      type: "finding",
      finding_id: "00000000-0000-4000-8000-000000000001",
      subject_revision: "s".repeat(700),
      ignored: "不得进入 L0",
    },
  }, "human");
  assert.equal((human.reason as string).length, 500);
  assert.deepEqual(human.subject, {
    type: "finding",
    finding_id: "00000000-0000-4000-8000-000000000001",
    subject_revision: "s".repeat(500),
  });
  assert.equal(JSON.stringify(human).includes("ignored"), false);
});

test("Fact 路由 scopes 与管理动作分离", () => {
  assert.equal(requiredScopeForRoute("GET", "/canvases/:id/facts"), "tasks:read");
  assert.equal(requiredScopeForRoute("GET", "/canvases/:id/facts/:nodeId"), "tasks:read");
  assert.equal(requiredScopeForRoute("PATCH", "/canvases/:id/facts/:nodeId/verification"), "jobs:control");
  assert.equal(requiredScopeForRoute("POST", "/findings/:id/verify"), "jobs:control");
  assert.equal(requiredScopeForRoute("POST", "/findings/:id/evidence-jobs"), "jobs:control");
});

