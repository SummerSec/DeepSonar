import assert from "node:assert/strict";
import test from "node:test";
import { AckHumanMessagePayload, resolvePlatformTools } from "@deepsonar/shared-types";
import {
  canIgnoreHumanNode,
  HUMAN_IGNORE_CONTINUE_HINT,
  humanIgnoreBodyPatch,
  humanMessageWorkspacePath,
  isAlreadyIgnoredHumanNode,
  safeHumanMessageFilename,
} from "./human-messages.js";
import { actorHasScope, requiredScopeForRoute, type Actor } from "../../auth.js";

test("human message attachment paths remain inside the scheduler-owned inbox", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(safeHumanMessageFilename("../../报告 final?.txt"), "_final_.txt");
  assert.equal(
    humanMessageWorkspacePath(id, "../../payload.bin"),
    `/workspace/.deepsonar/inbox/${id}/payload.bin`,
  );
  assert.doesNotMatch(humanMessageWorkspacePath(id, "../x"), /\/\.\.\//u);
});

test("acknowledgement contract is strict and cannot be disabled per role", () => {
  const messageId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(AckHumanMessagePayload.parse({ message_id: messageId, summary: "已纳入当前工作" }), {
    message_id: messageId,
    summary: "已纳入当前工作",
  });
  assert.equal(AckHumanMessagePayload.safeParse({ message_id: messageId, extra: true }).success, false);
  assert.equal(AckHumanMessagePayload.safeParse({ message_id: messageId, summary: "x".repeat(501) }).success, false);
  assert.ok(resolvePlatformTools("audit", "role", { ack_human_message: false }).includes("ack_human_message"));
});

test("human message routes use task read/write scopes", () => {
  assert.equal(requiredScopeForRoute("GET", "/canvases/:id/messages"), "tasks:read");
  assert.equal(requiredScopeForRoute("POST", "/canvases/:id/messages"), "tasks:write");
  assert.equal(requiredScopeForRoute("POST", "/canvases/:id/human-nodes/:nodeId/ignore"), "jobs:control");
});

test("only open human nodes can be ignored and ignored is a terminal resolution", () => {
  assert.equal(canIgnoreHumanNode({ node_type: "human", status: "open" }), true);
  assert.equal(canIgnoreHumanNode({ node_type: "human", status: null }), true);
  assert.equal(canIgnoreHumanNode({ node_type: "human", status: "acknowledged" }), false);
  assert.equal(canIgnoreHumanNode({ node_type: "intent", status: "open" }), false);
  assert.equal(isAlreadyIgnoredHumanNode({ status: "ignored" }), true);
  assert.equal(isAlreadyIgnoredHumanNode({ status: "open", body_json: { resolution: "ignored" } }), true);
  assert.equal(canIgnoreHumanNode({ node_type: "human", status: "ignored" }), false);
  const patch = humanIgnoreBodyPatch("2026-08-21T00:00:00.000Z", "alice");
  assert.equal(patch.resolution, "ignored");
  assert.equal(patch.instruction, HUMAN_IGNORE_CONTINUE_HINT);
  assert.match(HUMAN_IGNORE_CONTINUE_HINT, /不要再次为同一事项调用 request_human/);
});

test("attachment messages accept assets read, management, or admin authority", () => {
  const actor = (scopes: string[]): Actor => ({ type: "api_token", id: "token", name: "test", projectId: null, scopes });
  assert.equal(actorHasScope(actor(["tasks:write"]), "assets:read"), false);
  assert.equal(actorHasScope(actor(["assets:read"]), "assets:read"), true);
  assert.equal(actorHasScope(actor(["assets:manage"]), "assets:read"), true);
  assert.equal(actorHasScope(actor(["admin"]), "assets:read"), true);
});
