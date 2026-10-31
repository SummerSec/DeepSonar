import assert from "node:assert/strict";
import test from "node:test";
import { deliverCanvasMessage } from "./canvas-updates.js";

test("Canvas 投递只在 send 成功后提交 injected", async () => {
  const order: string[] = [];
  const status = await deliverCanvasMessage({
    send: async () => { order.push("send"); },
    settleInjected: async () => { order.push("injected"); },
    settleUnknown: async () => { order.push("unknown"); },
  });
  assert.equal(status, "injected");
  assert.deepEqual(order, ["send", "injected"]);
});

test("Canvas 发送成功但状态提交失败时只记 unknown 且不重发", async () => {
  const order: string[] = [];
  let sends = 0;
  const status = await deliverCanvasMessage({
    send: async () => { sends += 1; order.push("send"); },
    settleInjected: async () => { order.push("injected"); throw new Error("提交确认失败"); },
    settleUnknown: async () => { order.push("unknown"); },
  });
  assert.equal(status, "unknown");
  assert.equal(sends, 1);
  assert.deepEqual(order, ["send", "injected", "unknown"]);
});

test("Canvas 发送失败时不写 injected 并进入 unknown", async () => {
  const order: string[] = [];
  const status = await deliverCanvasMessage({
    send: async () => { order.push("send"); throw new Error("发送结果未知"); },
    settleInjected: async () => { order.push("injected"); },
    settleUnknown: async () => { order.push("unknown"); },
  });
  assert.equal(status, "unknown");
  assert.deepEqual(order, ["send", "unknown"]);
});
