import assert from "node:assert/strict";
import test from "node:test";
import { FactPayload, FactVerificationStatus } from "@deepsonar/shared-types";
import { requiredScopeForRoute } from "../../auth.js";
import {
  evaluateFactVerificationTransition,
  factQuantityParticipatesInGate,
  HUMAN_FACT_VERIFICATION_STATUSES,
} from "./fact-verification.js";
import { FactVerificationPatch } from "./fact-contract.js";

const ALL_STATUSES = FactVerificationStatus.options;

test("Fact 与 Finding 词汇不共用：confirmed 不是 Fact 状态，也不进数量门禁", () => {
  assert.equal(FactVerificationStatus.safeParse("confirmed").success, false);
  assert.equal(FactVerificationStatus.safeParse("pending").success, false);
  assert.equal(FactVerificationStatus.safeParse("false_positive").success, false);
  assert.deepEqual(ALL_STATUSES, ["unverified", "verifying", "verified", "rejected", "needs_human"]);
  for (const status of ["unverified", "verifying", "needs_human", "rejected", "confirmed", "pending", undefined]) {
    assert.equal(factQuantityParticipatesInGate(status), false, String(status));
  }
  assert.equal(factQuantityParticipatesInGate("verified"), true);
});

test("Agent emit_fact 不能提案 verification_status", () => {
  const ok = FactPayload.safeParse({ title: "事实标题足够长", description: "描述必须足够长才能作为事实提案通过契约。" });
  assert.equal(ok.success, true);
  assert.equal(FactPayload.safeParse({
    title: "事实标题足够长",
    description: "描述必须足够长才能作为事实提案通过契约。",
    verification_status: "verified",
  }).success, false);
});

test("人工 PATCH 只接受 verified/rejected/needs_human，拒绝 unverified/verifying", () => {
  assert.deepEqual(HUMAN_FACT_VERIFICATION_STATUSES, ["verified", "rejected", "needs_human"]);
  assert.equal(FactVerificationPatch.safeParse({ status: "unverified" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ status: "verifying" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ status: "confirmed" }).success, false);
  assert.equal(FactVerificationPatch.safeParse({ status: "verified" }).success, true);
  assert.equal(requiredScopeForRoute("PATCH", "/canvases/:id/facts/:nodeId/verification"), "jobs:control");
  assert.equal(requiredScopeForRoute("GET", "/canvases/:id/facts"), "tasks:read");
});

test("人工收口与非法迁移表", () => {
  const allowed: Array<[string, "verified" | "rejected" | "needs_human"]> = [
    ["unverified", "verified"],
    ["unverified", "rejected"],
    ["unverified", "needs_human"],
    ["verifying", "verified"],
    ["verifying", "rejected"],
    ["verifying", "needs_human"],
    ["needs_human", "verified"],
    ["needs_human", "rejected"],
    ["verified", "rejected"],
    ["verified", "needs_human"],
    ["rejected", "needs_human"],
  ];
  for (const [from, to] of allowed) {
    const decision = evaluateFactVerificationTransition(from, to);
    assert.equal(decision.ok, true, `${from} → ${to}`);
    if (decision.ok) assert.equal(decision.idempotent, false);
  }
  for (const status of HUMAN_FACT_VERIFICATION_STATUSES) {
    const same = evaluateFactVerificationTransition(status, status);
    assert.equal(same.ok, true);
    if (same.ok) assert.equal(same.idempotent, true);
  }
  const illegal = evaluateFactVerificationTransition("rejected", "verified");
  assert.equal(illegal.ok, false);
  if (!illegal.ok) assert.equal(illegal.error_code, "FACT_VERIFICATION_ILLEGAL_TRANSITION");
  const unknown = evaluateFactVerificationTransition("confirmed", "verified");
  assert.equal(unknown.ok, false);
});
