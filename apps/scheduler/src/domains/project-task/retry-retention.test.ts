import assert from "node:assert/strict";
import test from "node:test";
import { classifyRetryRetention, retryRetentionGuidance } from "./retry-retention.js";

test("#1236 只有设备租约历史时给专门的码与引导，不复读知识记录的话术", () => {
  const verdict = classifyRetryRetention({ device_leases: 1 });
  assert.equal(verdict.blocked, true);
  if (!verdict.blocked) return;
  assert.equal(verdict.code, "TASK_DELETE_KNOWLEDGE_RETAINED", "顶层错误码保持兼容");
  assert.equal(verdict.reason, "device_history");
  assert.deepEqual(verdict.kinds, ["device_lease"]);
  const guidance = retryRetentionGuidance(verdict);
  assert.match(guidance.error, /设备使用记录仍引用它的旧 Job/u);
  assert.match(guidance.next_action, /任务本来支持继续时/u);
  assert.match(guidance.next_action, /另建新任务/u);
  assert.doesNotMatch(guidance.next_action, /治理\/审计记录/u);
});

test("#1236 续做预算留痕不算知识记录，知识记录与设备历史可同时出现", () => {
  const knowledge = classifyRetryRetention({ receipts: 2 });
  assert.equal(knowledge.blocked && knowledge.code, "TASK_DELETE_KNOWLEDGE_RETAINED");
  assert.deepEqual(knowledge.blocked && knowledge.kinds, ["knowledge"]);
  const budget = classifyRetryRetention({ continuation_budget_chain: 1 });
  assert.deepEqual(budget.blocked && budget.kinds, ["continuation_budget"]);
  assert.equal(budget.blocked && budget.reason, "governance_records");
  const both = classifyRetryRetention({ receipts: 2, device_leases: 1 });
  assert.equal(both.blocked && both.reason, "governance_records");
  assert.deepEqual(both.blocked && both.kinds, ["knowledge", "device_lease"]);
});

test("#1236 没有保留记录时不阻塞", () => {
  assert.equal(classifyRetryRetention({}).blocked, false);
  assert.equal(classifyRetryRetention({ receipts: 0, device_leases: 0 }).blocked, false);
});
