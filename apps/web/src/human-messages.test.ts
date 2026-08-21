import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasHumanMessage, CanvasNode } from "./api.js";
import {
  canIgnoreHumanIntervention,
  countVisiblePendingHumanInterventions,
  defaultHumanInterventionPrefs,
  humanInterventionPrefKey,
  humanInterventionUiPrefUserKey,
  humanMessageAssetKey,
  humanMessageStatusLabel,
  humanMessageTargetForNode,
  humanMessageTargetLabel,
  humanMessageTargetNodeForJobId,
  humanMessageTargetNodeFromContext,
  isActiveHumanMessageTarget,
  isPendingHumanIntervention,
  jobCanReceiveHumanReply,
  listHumanInterventions,
  messagesForCanvasNode,
  openHumanInterventionForJob,
  readHumanInterventionPrefs,
  safeHumanMessageFileName,
  toggleExpandedId,
  visibleHumanInterventions,
  writeHumanInterventionPrefs,
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
  assert.equal(humanMessageTargetForNode(null), null);
});

test("human intervention reply resolves the waiting job node, otherwise no target", () => {
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
  assert.equal(humanMessageTargetNodeFromContext(humanNode, [humanNode]), null);
  assert.equal(humanMessageTargetForNode(humanNode), null);
  assert.equal(humanMessageTargetNodeForJobId("job-1", [waitingJob, humanNode])?.id, "job-node");
  assert.equal(humanMessageTargetNodeForJobId("missing", [waitingJob]), null);
});

test("本次运行列表只给 waiting_human 的 Job 直接回复入口", () => {
  assert.equal(jobCanReceiveHumanReply({ status: "waiting_human" }), true);
  assert.equal(jobCanReceiveHumanReply({ status: "running" }), false);
  assert.equal(jobCanReceiveHumanReply({ status: "succeeded" }), false);
  assert.equal(jobCanReceiveHumanReply({ type: "human", status: "running" }), false);
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

test("open human interventions can be ignored; processed history cannot", () => {
  const pending = node({
    id: "human-open",
    node_type: "human",
    status: "open",
    job_id: "job-1",
    body_json: { reason: "需要授权", subject: { finding_id: "finding-1" } },
  });
  const ignored = node({
    id: "human-ignored",
    node_type: "human",
    status: "ignored",
    job_id: "job-1",
    body_json: { reason: "旧请求", resolution: "ignored" },
  });
  const delivered = node({
    id: "human-msg",
    node_type: "human",
    status: "acknowledged",
    body_json: { message_id: "message-1", reason: "已投递说明" },
  });
  assert.equal(isPendingHumanIntervention(pending), true);
  assert.equal(canIgnoreHumanIntervention(pending), true);
  assert.equal(canIgnoreHumanIntervention(ignored), false);
  assert.equal(canIgnoreHumanIntervention(delivered), false);
  assert.equal(openHumanInterventionForJob([pending, ignored], "job-1")?.id, "human-open");
  const listed = listHumanInterventions([delivered, pending, ignored]);
  assert.deepEqual(listed.map((item) => item.node.id), ["human-msg", "human-open", "human-ignored"]);
  assert.deepEqual(visibleHumanInterventions(listed, true).map((item) => item.node.id), ["human-open"]);
  assert.deepEqual(visibleHumanInterventions(listed, true, ["human-open"]), []);
  assert.deepEqual(visibleHumanInterventions(listed, true, [], ["human-open"]), []);
  assert.deepEqual(visibleHumanInterventions(listed, false, ["human-open"]).map((item) => item.node.id), ["human-msg", "human-open", "human-ignored"]);
  assert.deepEqual(visibleHumanInterventions(listed, false, [], ["human-open"]).map((item) => item.node.id), ["human-msg", "human-open", "human-ignored"]);
  assert.equal(countVisiblePendingHumanInterventions(listed), 1);
  assert.equal(countVisiblePendingHumanInterventions(listed, [], ["human-open"]), 0);
  assert.equal(listed.find((item) => item.node.id === "human-open")?.findingId, "finding-1");
});

test("collapse prefs default collapsed and persist per user and task", () => {
  const store = new Map<string, string>();
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  });
  try {
    const defaults = defaultHumanInterventionPrefs();
    assert.equal(defaults.bannerCollapsed, true);
    assert.equal(defaults.hideProcessed, true);
    assert.equal(defaults.messagesCollapsed, true);
    assert.deepEqual(defaults.expandedIds, []);
    assert.deepEqual(defaults.repliedIds, []);
    assert.deepEqual(defaults.hiddenIds, []);
    assert.equal(humanInterventionPrefKey("user-1", "canvas-1"), "deepsonar:human-intervention:user-1:canvas-1");
    assert.equal(humanInterventionUiPrefUserKey({ user: { id: "u1" }, actor: { name: "alice" } }), "u1");
    assert.equal(humanInterventionUiPrefUserKey({ user: null, actor: { name: "dev" } }), "dev");
    writeHumanInterventionPrefs("user-1", "canvas-1", {
      ...defaults,
      bannerCollapsed: false,
      hideProcessed: false,
      expandedIds: ["human-open"],
      messagesCollapsed: false,
      repliedIds: ["human-replied"],
      hiddenIds: ["human-hidden"],
    });
    const stored = readHumanInterventionPrefs("user-1", "canvas-1");
    assert.equal(stored.bannerCollapsed, false);
    assert.equal(stored.hideProcessed, false);
    assert.deepEqual(stored.expandedIds, ["human-open"]);
    assert.deepEqual(stored.repliedIds, ["human-replied"]);
    assert.deepEqual(stored.hiddenIds, ["human-hidden"]);
    assert.notDeepEqual(readHumanInterventionPrefs("user-2", "canvas-1"), stored);
    assert.deepEqual(toggleExpandedId(["a"], "b"), ["a", "b"]);
    assert.deepEqual(toggleExpandedId(["a", "b"], "a"), ["b"]);
  } finally {
    if (localStorageDescriptor) Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
