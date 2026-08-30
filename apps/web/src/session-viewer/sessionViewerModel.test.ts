import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionLedger,
  buildSessionTokenUsage,
  filterSessionLedger,
  sessionHasTokenUsage,
  sessionLedgerTurnCount,
  sessionViewerWorkspaceMode,
} from "./sessionViewerModel";

const items = [
  { id: "u1", kind: "user", title: "用户", body: "检查登录入口" },
  { id: "a1", kind: "assistant", title: "助手", body: "定位路由" },
  { id: "t1", kind: "tool_call", title: "工具调用", toolName: "shell", body: "pwd" },
  { id: "r1", kind: "tool_result", title: "工具结果", toolName: "shell", body: "ok" },
  { id: "u2", kind: "user", title: "用户", body: "继续验证" },
] as const;

test("projects parser items into compact turn and step rows", () => {
  const rows = buildSessionLedger(items);

  assert.deepEqual(rows.map(({ index, turn, step, turnStart }) => ({ index, turn, step, turnStart })), [
    { index: 1, turn: 1, step: 1, turnStart: true },
    { index: 2, turn: 1, step: 2, turnStart: false },
    { index: 3, turn: 1, step: 3, turnStart: false },
    { index: 4, turn: 1, step: 4, turnStart: false },
    { index: 5, turn: 2, step: 1, turnStart: true },
  ]);
  assert.equal(sessionLedgerTurnCount(rows), 2);
  assert.equal(rows[0]?.item, items[0]);
});

test("filters rows by kind and full-text search without changing source order", () => {
  const rows = buildSessionLedger(items);

  assert.deepEqual(filterSessionLedger(rows, { kind: "tool_call" }).map((row) => row.index), [3]);
  assert.deepEqual(filterSessionLedger(rows, { query: "登录" }).map((row) => row.index), [1]);
  assert.deepEqual(filterSessionLedger(rows, { query: "shell" }).map((row) => row.index), [3, 4]);
});

test("only opens the split inspector layout after selecting a row", () => {
  assert.equal(sessionViewerWorkspaceMode(false), "ledger");
  assert.equal(sessionViewerWorkspaceMode(true), "split");
});

test("aggregates session token usage by turn and keeps gateway ledger separate", () => {
  const rows = buildSessionLedger([
    { id: "u1", kind: "user", title: "用户", tokens: { input: 20, output: 0 } },
    { id: "a1", kind: "assistant", title: "助手", tokens: { input: 80, output: 12, cacheRead: 40 } },
    { id: "u2", kind: "user", title: "用户" },
    { id: "a2", kind: "assistant", title: "助手", tokens: { input: 10, output: 4, cacheWrite: 6 } },
  ]);
  const usage = buildSessionTokenUsage(rows, [
    { request_no: 2, provider: "anthropic", model: "claude", input_tokens: 90, output_tokens: 8, total_tokens: 98, settlement_status: "settled" },
    { request_no: 1, provider: "anthropic", model: "claude", input_tokens: 30, output_tokens: 5, total_tokens: 35, settlement_status: "unknown" },
    { request_no: 3, provider: "openai", model: "gpt", input_tokens: 7, output_tokens: 2, total_tokens: 9, settlement_status: "settled" },
  ]);

  assert.equal(usage.session.input, 110);
  assert.equal(usage.session.output, 16);
  assert.equal(usage.session.cacheRead, 40);
  assert.equal(usage.session.cacheWrite, 6);
  assert.equal(usage.session.peakContext, 120);
  assert.equal(usage.session.reportedEvents, 3);
  assert.deepEqual(usage.session.turns.map((turn) => ({
    turn: turn.turn,
    input: turn.input,
    output: turn.output,
    events: turn.events,
  })), [
    { turn: 1, input: 100, output: 12, events: 2 },
    { turn: 2, input: 10, output: 4, events: 1 },
  ]);
  assert.equal(usage.gateway?.requests, 3);
  assert.equal(usage.gateway?.input, 127);
  assert.equal(usage.gateway?.output, 15);
  assert.equal(usage.gateway?.total, 142);
  assert.equal(usage.gateway?.settled, 2);
  assert.equal(usage.gateway?.unknown, 1);
  assert.deepEqual(usage.gateway?.rows.map((row) => row.request_no), [1, 2, 3]);
  assert.deepEqual(usage.gateway?.models.map((model) => ({ key: model.key, requests: model.requests, total: model.total })), [
    { key: "anthropic::claude", requests: 2, total: 133 },
    { key: "openai::gpt", requests: 1, total: 9 },
  ]);
  assert.equal(sessionHasTokenUsage(usage), true);
});

test("empty session and empty gateway produce no token usage", () => {
  const usage = buildSessionTokenUsage(buildSessionLedger(items));
  assert.equal(usage.session.reportedEvents, 0);
  assert.equal(usage.session.peakContext, null);
  assert.equal(usage.gateway, null);
  assert.equal(sessionHasTokenUsage(usage), false);
});
