import assert from "node:assert/strict";
import test from "node:test";
import { createToolCallActivityRecorder } from "./tool-call-activity.js";

function fixture() {
  const queries: string[] = [];
  const events: string[] = [];
  const db = ((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof createToolCallActivityRecorder>[0]["db"];
  (db as unknown as { json: (value: unknown) => unknown }).json = (value: unknown) => value;
  const record = createToolCallActivityRecorder({
    db, jobId: "job-1", emit: (_type, payload) => { events.push(payload.message); return Promise.resolve(true); },
    scrub: (name) => name,
  });
  return { record, queries, events };
}

test("#1304 started 与对应的 completed 成对投递，不因 20s 节流被吞", () => {
  const { record, events } = fixture();
  record("started", "bash", "call-1");
  record("completed", "bash", "call-1");
  assert.equal(events.length, 2, "短工具的 completed 必须投递");
  assert.match(events[0]!, /tool\.call\.started/);
  assert.match(events[1]!, /tool\.call\.completed/);
});

test("#1304 同一 callId 的重复事件只投递一次", () => {
  const { record, events } = fixture();
  record("started", "bash", "call-1");
  record("started", "bash", "call-1");
  assert.equal(events.length, 1, "重复 started 被去重");
});

test("#1304 两相都写 payload，供 Reaper 读取权威信号", () => {
  const { record, queries } = fixture();
  record("started", "bash", "call-1");
  record("completed", "bash", "call-1");
  assert.equal(queries.length, 2, "started 与 completed 各写一次 runtime_activity");
  assert.match(queries[0]!, /payload_json/);
});

test("#1304 started 之后的无关 completed 仍受 20s 节流约束", () => {
  const { record, events } = fixture();
  record("started", "bash", "call-1");
  record("completed", "bash", "call-1");
  record("completed", "grep", "call-2");
  assert.equal(events.length, 2, "未配对的 completed 仍按节流丢弃，避免实时流噪声");
});
