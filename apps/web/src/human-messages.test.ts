import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasHumanMessage, CanvasNode } from "./api.js";
import {
  humanMessageAssetKey,
  humanMessageStatusLabel,
  composeNodeIdForHumanIntervention,
  humanMessageTargetForNode,
  humanMessageTargetLabel,
  humanMessageTargetNodeForJobId,
  humanMessageTargetNodeFromContext,
  isActiveHumanMessageTarget,
  jobCanReceiveHumanReply,
  messagesForCanvasNode,
  safeHumanMessageFileName,
} from "./human-messages.js";

function node(overrides: Partial<CanvasNode>): CanvasNode {
  return {
    id: "node-1",
    node_type: "job",
    title: "审计运行",
    body_json: {},
    x: 0,
    y: 0,
    w: 320,
    h: 180,
    status: "running",
    verification_status: null,
    job_id: "job-1",
    updated_at: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<CanvasHumanMessage>): CanvasHumanMessage {
  return {
    id: "message-1",
    canvas_id: "canvas-1",
    human_node_id: "human-1",
    target_kind: "job",
    target_node_id: "node-1",
    target_job_id: "job-1",
    body: "请检查附件",
    attachments: [],
    status: "planned",
    delivered_at: null,
    acknowledged_at: null,
    ack_summary: null,
    error: null,
    planned_at: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

test("status copy keeps transport injection distinct from Agent acknowledgement", () => {
  assert.equal(humanMessageStatusLabel("injected"), "已注入会话，等待 Agent 确认");
  assert.equal(humanMessageStatusLabel("acknowledged"), "Agent 已确认");
  assert.notEqual(humanMessageStatusLabel("injected"), humanMessageStatusLabel("acknowledged"));
});

test("target mapping only permits active intent, job and report nodes", () => {
  const activeIntent = node({ id: "intent-1", node_type: "intent", status: "waiting_human" });
  assert.equal(isActiveHumanMessageTarget(activeIntent), true);
  assert.deepEqual(humanMessageTargetForNode(activeIntent), { kind: "job", node_id: "intent-1" });
  assert.equal(isActiveHumanMessageTarget(node({ node_type: "report", status: "succeeded" })), false);
  assert.equal(isActiveHumanMessageTarget(node({ node_type: "finding", status: "running" })), false);
  assert.deepEqual(humanMessageTargetForNode(null), { kind: "hub" });
});

test("human intervention reply resolves the waiting job node, otherwise Hub", () => {
  const waitingJob = node({ id: "job-node", node_type: "job", status: "waiting_human" });
  const humanNode = node({
    id: "human-1",
    node_type: "human",
    status: "open",
    job_id: "job-1",
    body_json: { reason: "需要授权", job_id: "job-1" },
  });
  assert.equal(isActiveHumanMessageTarget(humanNode), false);
  assert.equal(humanMessageTargetNodeFromContext(humanNode, [waitingJob, humanNode])?.id, "job-node");
  assert.equal(composeNodeIdForHumanIntervention(humanNode, [waitingJob, humanNode]), "job-node");
  assert.equal(humanMessageTargetNodeFromContext(humanNode, [humanNode]), null);
  assert.equal(composeNodeIdForHumanIntervention(humanNode, [humanNode]), "human-1");
  assert.equal(humanMessageTargetNodeForJobId("job-1", [waitingJob, humanNode])?.id, "job-node");
  assert.equal(humanMessageTargetNodeForJobId("missing", [waitingJob]), null);
});

test("本次运行列表只给等待人工或活动 human Job 直接回复入口", () => {
  assert.equal(jobCanReceiveHumanReply({ type: "explore", status: "waiting_human" }), true);
  assert.equal(jobCanReceiveHumanReply({ type: "human", status: "running" }), true);
  assert.equal(jobCanReceiveHumanReply({ type: "explore", status: "running" }), false);
  assert.equal(jobCanReceiveHumanReply({ type: "human", status: "succeeded" }), false);
});

test("file keys are message-scoped, ordered and path safe", () => {
  assert.equal(safeHumanMessageFileName("../../证据 报告?.txt"), "证据_报告_.txt");
  assert.equal(
    humanMessageAssetKey("3cf3f85e-8641-48ca-97fb-a665c3f56116", "../same name.txt", 1),
    "human-messages/3cf3f85e-8641-48ca-97fb-a665c3f56116/002-same_name.txt",
  );
});

test("target and human-node details derive from the durable message ledger", () => {
  const row = message({ status: "acknowledged", ack_summary: "已纳入复核", acknowledged_at: "2026-08-13T00:01:00.000Z" });
  assert.equal(humanMessageTargetLabel(row, [node({})]), "审计运行");
  assert.equal(humanMessageTargetLabel(message({ target_kind: "hub", target_node_id: null }), []), "Hub");
  assert.deepEqual(messagesForCanvasNode([row], "human-1"), [row]);
  assert.deepEqual(messagesForCanvasNode([row], "node-1"), [row]);
});
