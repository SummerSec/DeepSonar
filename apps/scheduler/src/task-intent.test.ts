import assert from "node:assert/strict";
import test from "node:test";
import {
  PatchTaskIntentBody,
  applyRootBodyIntent,
  applyTaskIntentPatch,
  taskIntentSavedMessage,
  TASK_INTENT_SAVED_IDLE,
  TASK_INTENT_SAVED_RUNNING,
} from "./task-intent.js";

test("patch body requires title or content and reuses create limits", () => {
  assert.deepEqual(PatchTaskIntentBody.parse({ title: "  新标题  " }), { title: "新标题" });
  assert.deepEqual(PatchTaskIntentBody.parse({ content: " 完成标准 " }), { content: "完成标准" });
  assert.equal(PatchTaskIntentBody.safeParse({}).success, false);
  assert.equal(PatchTaskIntentBody.safeParse({ title: "" }).success, false);
  assert.equal(PatchTaskIntentBody.safeParse({ content: "x".repeat(20_001) }).success, false);
});

test("intent patch only syncs title/content/goal and keeps frozen policy", () => {
  const target = {
    title: "旧标题",
    content: "旧内容",
    goal: "旧内容",
    kind: "compose",
    network_policy: { allow_egress: false },
    seed_finding_ids: ["11111111-1111-4111-8111-111111111111"],
    schedule: { start_at: "2099-01-01T00:00:00.000Z" },
  };
  const next = applyTaskIntentPatch(target, { title: "新标题", content: "新完成标准" });
  assert.equal(next.title, "新标题");
  assert.equal(next.content, "新完成标准");
  assert.equal(next.goal, "新完成标准");
  assert.equal(next.kind, "compose");
  assert.deepEqual(next.network_policy, { allow_egress: false });
  assert.deepEqual(next.seed_finding_ids, target.seed_finding_ids);
  assert.deepEqual(next.schedule, target.schedule);
  assert.deepEqual(applyTaskIntentPatch(target, { title: "只改标题" }).content, "旧内容");
});

test("root body keeps sibling keys and replaces the stored target snapshot", () => {
  const body = applyRootBodyIntent(
    { note: "keep", target: { title: "old" } },
    { title: "new", content: "c", goal: "c" },
  );
  assert.deepEqual(body, {
    note: "keep",
    target: { title: "new", content: "c", goal: "c" },
  });
});

test("saved copy distinguishes in-flight jobs from later reads", () => {
  assert.equal(taskIntentSavedMessage(false), TASK_INTENT_SAVED_IDLE);
  assert.equal(taskIntentSavedMessage(true), TASK_INTENT_SAVED_RUNNING);
});
