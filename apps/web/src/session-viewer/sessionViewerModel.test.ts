import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionLedger,
  filterSessionLedger,
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
