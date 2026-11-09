import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasHumanMessage, CanvasNode } from "./api.js";
import { HumanInterventionDetailStore, isCurrentHumanTaskCallback, mergeHumanInterventionDetails } from "./human-intervention-details.js";
import {
  countPendingHumanInterventions,
  canIgnoreHumanIntervention,
  countVisiblePendingHumanInterventions,
  defaultHumanInterventionPrefs,
  humanInterventionPrefKey,
  humanInterventionUiPrefUserKey,
  humanInterventionKindLabel,
  humanInterventionSafetyMessage,
  humanMessageAssetKey,
  humanMessageStatusLabel,
  humanMessageTargetForNode,
  humanMessageTargetLabel,
  humanMessageTargetNodeForJobId,
  humanMessageTargetNodeFromContext,
  isActiveHumanMessageTarget,
  isReplyableHumanMessageTarget,
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

test("latest pending human request per Job is the reply target", () => {
  const older = node({
    id: "human-old",
    node_type: "human",
    status: "open",
    job_id: "job-1",
    updated_at: "2026-08-13T00:00:00.000Z",
  });
  const latest = node({
    id: "human-latest",
    node_type: "human",
    status: "open",
    job_id: "job-1",
    updated_at: "2026-08-13T00:01:00.000Z",
  });
  assert.deepEqual(listHumanInterventions([older, latest]).map((item) => item.node.id), ["human-latest"]);
  assert.equal(openHumanInterventionForJob([older, latest], "job-1")?.id, "human-latest");
  const unscopedHuman = node({ id: "human-unscoped", node_type: "human", job_id: null, body_json: { reason: "请检查证据" } });
  assert.equal(humanMessageTargetNodeFromContext(unscopedHuman, [unscopedHuman]), null, "a request without a Job must not force a reply target");
});

test("pending requests outrank recent history and report the bounded list overflow", () => {
  const pending = Array.from({ length: 14 }, (_, index) => node({
    id: `human-pending-${index}`,
    node_type: "human",
    status: "open",
    job_id: `job-${index}`,
    updated_at: `2026-08-13T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const history = Array.from({ length: 20 }, (_, index) => node({
    id: `human-history-${index}`,
    node_type: "human",
    status: "acknowledged",
    job_id: null,
    updated_at: `2026-08-13T23:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const items = listHumanInterventions([...history, ...pending]);
  assert.equal(items.length, 12);
  assert.ok(items.every((item) => item.pending), "history must not push open requests out of the bounded candidates");
  assert.equal(countPendingHumanInterventions([...history, ...pending]), 14);
});

test("L1 detail restores the full reason tail and parses the shared guidance contract", () => {
  const fullReason = `${"原因摘要。".repeat(100)}末尾必须可见`;
  const summary = node({
    id: "human-long",
    node_type: "human",
    status: "open",
    body_json: { reason: fullReason.slice(0, 500) },
  });
  const detail = {
    ...summary,
    body_json: {
      reason: fullReason,
      guidance: {
        question: "是否允许这项任务继续？",
        required_action: "在授权设置中确认范围",
        reply_instructions: "回复已确认的范围，不要包含密钥",
        after_reply: "Agent 会按现有准入重新提交",
      },
    },
  };
  const entries = new Map([[summary.id, { status: "loaded" as const, updatedAt: summary.updated_at, node: detail }]]);
  const [item] = mergeHumanInterventionDetails(listHumanInterventions([summary]), entries);
  assert.equal(item?.reason, fullReason);
  assert.equal(item?.guidance?.question, "是否允许这项任务继续？");
  assert.equal(item?.guidanceStatus, "available");
  assert.equal(item?.detailVersionMatches, true);
});

test("historical detail without guidance stays readable and reports the missing instructions", () => {
  const summary = node({ id: "human-history", node_type: "human", status: "open", body_json: { reason: "原始请求原因" } });
  const detail = { ...summary, body_json: { reason: "完整的历史请求原因" } };
  const entries = new Map([[summary.id, { status: "loaded" as const, updatedAt: summary.updated_at, node: detail }]]);
  const [item] = mergeHumanInterventionDetails(listHumanInterventions([summary]), entries);
  assert.equal(item?.reason, "完整的历史请求原因");
  assert.equal(item?.guidance, null);
  assert.equal(item?.guidanceStatus, "missing");
  assert.equal(item?.pending, true);
});

test("a current L1 resolution overrides the stale L0 pending status", () => {
  const summary = node({ id: "human-resolved", node_type: "human", status: "open" });
  const detail = { ...summary, status: "ignored", updated_at: "2026-08-13T00:01:00.000Z", body_json: { reason: "已在平台处理" } };
  const entries = new Map([[summary.id, { status: "loaded" as const, updatedAt: summary.updated_at, node: detail }]]);
  const [item] = mergeHumanInterventionDetails(listHumanInterventions([summary]), entries);
  assert.equal(item?.pending, false);
  assert.equal(item?.detailVersionMatches, false, "a changed detail must not enable a reply against stale L0 context");
});

test("pending requests stay visible after a local send until the node is actually processed", () => {
  const pending = node({ id: "human-open", node_type: "human", status: "open" });
  const items = listHumanInterventions([pending]);
  assert.deepEqual(visibleHumanInterventions(items, true, ["human-open"]).map((item) => item.node.id), ["human-open"]);
  assert.equal(countVisiblePendingHumanInterventions(items, ["human-open"]), 1);
});

test("credential and authorization requests are described without inviting secrets or implying approval", () => {
  const credential = node({ node_type: "human", body_json: { subject: { type: "platform_blocker", kind: "credential" } } });
  const authorization = node({ node_type: "human", body_json: { subject: { type: "platform_blocker", kind: "authorization" } } });
  assert.equal(humanInterventionKindLabel(credential), "凭据配置");
  assert.match(humanInterventionSafetyMessage(credential) ?? "", /不要把秘密写进回复或附件/);
  assert.equal(humanInterventionKindLabel(authorization), "授权确认");
  assert.match(humanInterventionSafetyMessage(authorization) ?? "", /不会替代平台核验或扩大权限/);
});

test("human detail store caches by updated_at and requires an explicit retry after failure", async () => {
  const target = node({ id: "human-cache", node_type: "human", status: "open" });
  let calls = 0;
  const store = new HumanInterventionDetailStore(async () => {
    calls += 1;
    if (calls === 1) throw new Error("detail unavailable");
    return { ...target, body_json: { reason: "full reason" } };
  });
  store.refresh("canvas-1", [target]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().entries.get(target.id)?.status, "error");
  store.refresh("canvas-1", [target]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "five-second L0 refreshes must not retry a failed L1 request forever");
  store.retry("canvas-1", target);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot().entries.get(target.id)?.status, "loaded");
  store.refresh("canvas-1", [target]);
  assert.equal(calls, 2, "the same updated_at remains cached after success");
});

test("the thirteenth reply request stays loaded when the bounded preview order changes", async () => {
  const requests = Array.from({ length: 13 }, (_, index) => node({
    id: `human-${index}`, job_id: `job-${index}`, node_type: "human", status: "open",
    updated_at: `2026-08-13T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const selected = openHumanInterventionForJob(requests, "job-0")!;
  assert.ok(!listHumanInterventions(requests).some(item => item.node.id === selected.id));
  let calls = 0;
  const store = new HumanInterventionDetailStore(async (_canvasId, id) => {
    calls++;
    return { ...requests.find(item => item.id === id)!, body_json: { reason: `full ${id}` } };
  });
  const preview = listHumanInterventions(requests).map(item => item.node);
  store.refresh("canvas-1", preview, selected);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().entries.size, 13);
  assert.equal(store.getSnapshot().entries.get(selected.id)?.status, "loaded");
  store.refresh("canvas-1", [...preview].reverse(), selected);
  assert.equal(calls, 13, "reordering must keep the selected request cached");
  const [item] = mergeHumanInterventionDetails(listHumanInterventions([selected]), store.getSnapshot().entries);
  assert.equal(item?.detailVersionMatches, true);
  assert.equal(item?.reason, "full human-0");
  const updated = { ...selected, updated_at: "2026-08-14T00:00:00.000Z" };
  store.refresh("canvas-1", preview, updated);
  const [stale] = mergeHumanInterventionDetails(listHumanInterventions([updated]), store.getSnapshot().entries);
  assert.equal(stale?.detailVersionMatches, false, "changed L0 must disable sending until L1 catches up");
});

test("late human detail responses from a previous task cannot replace current task data", async () => {
  let resolveOld!: (value: CanvasNode) => void;
  const oldRequest = new Promise<CanvasNode>((resolve) => { resolveOld = resolve; });
  const current = node({ id: "human-current", node_type: "human", status: "open" });
  const store = new HumanInterventionDetailStore(async (canvasId) => canvasId === "canvas-old"
    ? oldRequest
    : { ...current, body_json: { reason: "current task" } });
  const old = node({ id: "human-old-task", node_type: "human", status: "open" });
  store.refresh("canvas-old", [old]);
  store.refresh("canvas-current", [current]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  resolveOld({ ...old, body_json: { reason: "stale previous task" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.canvasId, "canvas-current");
  assert.deepEqual([...snapshot.entries.keys()], [current.id]);
  assert.equal(snapshot.entries.get(current.id)?.status, "loaded");
});

test("a completed reply callback from another task cannot mutate the active task UI", () => {
  assert.equal(isCurrentHumanTaskCallback("canvas-a", "canvas-b"), false);
  assert.equal(isCurrentHumanTaskCallback("canvas-b", "canvas-b"), true);
  assert.equal(isCurrentHumanTaskCallback(null, "canvas-b"), false);
});

test("failed canvas node remains replyable when the Job ledger is waiting_human", () => {
  const failedJobNode = node({ id: "job-node", node_type: "job", status: "failed" });
  const humanNode = node({
    id: "human-1",
    node_type: "human",
    status: "open",
    job_id: "job-1",
    body_json: { reason: "需要授权", job_id: "job-1" },
  });
  const jobs = [{ id: "job-1", status: "waiting_human" }];
  assert.equal(isActiveHumanMessageTarget(failedJobNode), false);
  assert.equal(isReplyableHumanMessageTarget(failedJobNode, jobs), true);
  assert.equal(isReplyableHumanMessageTarget(failedJobNode, [{ id: "job-1", status: "failed" }]), false);
  assert.equal(humanMessageTargetNodeFromContext(humanNode, [failedJobNode, humanNode])?.id, undefined);
  assert.equal(humanMessageTargetNodeFromContext(humanNode, [failedJobNode, humanNode], jobs)?.id, "job-node");
  assert.deepEqual(humanMessageTargetForNode(failedJobNode, jobs), { kind: "job", node_id: "job-node" });
  assert.equal(humanMessageTargetNodeForJobId("job-1", [failedJobNode], jobs)?.id, "job-node");
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
  assert.equal(isPendingHumanIntervention(node({
    id: "human-expired",
    node_type: "human",
    status: "expired",
    job_id: "job-1",
    body_json: { reason: "过期请求", resolution: "expired" },
  })), false);
  assert.equal(canIgnoreHumanIntervention(ignored), false);
  assert.equal(canIgnoreHumanIntervention(delivered), false);
  assert.equal(openHumanInterventionForJob([pending, ignored], "job-1")?.id, "human-open");
  const listed = listHumanInterventions([delivered, pending, ignored]);
  assert.deepEqual(listed.map((item) => item.node.id), ["human-open", "human-msg", "human-ignored"]);
  assert.deepEqual(visibleHumanInterventions(listed, true).map((item) => item.node.id), ["human-open"]);
  assert.deepEqual(visibleHumanInterventions(listed, true, ["human-open"]).map((item) => item.node.id), ["human-open"]);
  assert.deepEqual(visibleHumanInterventions(listed, true, [], ["human-open"]), []);
  assert.deepEqual(visibleHumanInterventions(listed, false, ["human-open"]).map((item) => item.node.id), ["human-open", "human-msg", "human-ignored"]);
  assert.deepEqual(visibleHumanInterventions(listed, false, [], ["human-open"]).map((item) => item.node.id), ["human-open", "human-msg", "human-ignored"]);
  assert.equal(countVisiblePendingHumanInterventions(listed), 1);
  assert.equal(countVisiblePendingHumanInterventions(listed, [], ["human-open"]), 0);
  assert.equal(countVisiblePendingHumanInterventions(listed, ["human-open"]), 1);
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
