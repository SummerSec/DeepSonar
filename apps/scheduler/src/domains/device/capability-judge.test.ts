import assert from "node:assert/strict";
import test from "node:test";
import { judgeRequiredDeviceCapability } from "./capability-judge.js";

const device = (key: string, rig = "rig-a", model = "P60"): { key: string; transport: string; model: string; rig_id: string } => ({
  key, transport: "hdc", model, rig_id: rig });
const requirement = { transport: "hdc", key: null, model: null, rig_id: null };

test("#1179 目标设备在 rig 可用集合内才判可用", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement, devices: [device("d1")],
    admitted: { "rig-a": { reconciled: true, usable: ["d1"] } } });
  assert.equal(verdict.state, "available");
});

test("#1179 反例一：目标暂时不在列表、别的设备可用 → 未知（不得据此收口）", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement: { ...requirement, key: "d1" },
    devices: [device("d1")], admitted: { "rig-a": { reconciled: true, usable: ["d9"] } } });
  assert.equal(verdict.state, "unknown");
  assert.match(verdict.reason, /缺席不构成不可用证据/u);
});

test("#1179 反例二：目标 rig 为空、另一个 rig 非空 → 仍未知（不跨 rig 顶替）", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement: { ...requirement, key: "d1" },
    devices: [device("d1", "rig-a"), device("d2", "rig-b")],
    admitted: { "rig-a": { reconciled: true, usable: [] }, "rig-b": { reconciled: true, usable: ["d2"] } } });
  assert.equal(verdict.state, "unknown");
  // 只有承载目标设备的 rig 参与判定，另一个 rig 的可用集不会被借来顶替。
  assert.deepEqual(verdict.rigs.map(rig => rig.rig_id), ["rig-a"]);
  assert.match(verdict.reason, /未上报任何可用设备/u);
});

test("#1179 反例三：观测读取失败（超时/401/契约不符）与未对账 → 未知", () => {
  const failed = judgeRequiredDeviceCapability({ requirement, devices: [device("d1")], admitted: { "rig-a": null } });
  assert.equal(failed.state, "unknown");
  assert.match(failed.reason, /读取失败/u);
  const unreconciled = judgeRequiredDeviceCapability({ requirement, devices: [device("d1")],
    admitted: { "rig-a": { reconciled: false, usable: ["d1"] } } });
  assert.equal(unreconciled.state, "unknown");
  assert.match(unreconciled.reason, /尚未完成对账/u);
});

test("#1179 目录无匹配登记时不形成结论", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement: { ...requirement, model: "P70" },
    devices: [device("d1")], admitted: { "rig-a": { reconciled: true, usable: ["d1"] } } });
  assert.equal(verdict.state, "unknown");
  assert.match(verdict.reason, /没有匹配本次要求的登记/u);
});
