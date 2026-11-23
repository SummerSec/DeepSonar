import assert from "node:assert/strict";
import test from "node:test";
import { judgeRequiredDeviceCapability } from "./capability-judge.js";

const device = (key: string, rig = "rig-a", model = "P60"): { key: string; transport: string; model: string; rig_id: string } => ({
  key, transport: "hdc", model, rig_id: rig });
const requirement = { transport: "hdc", key: null, model: null, rig_id: null };

test("#1179 已在可用集合内才判可用", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement,
    devices: [device("d1"), device("d2")],
    admitted: { "rig-a": { reconciled: true, usable: ["d2"] } } });
  assert.equal(verdict.state, "available");
});

test("#1179 已登记但都不在可用集合、且 rig 有别的可用设备 → 已证实不可用", () => {
  const verdict = judgeRequiredDeviceCapability({ requirement,
    devices: [device("d1")],
    admitted: { "rig-a": { reconciled: true, usable: ["d9"] } } });
  assert.equal(verdict.state, "unavailable");
  assert.match(verdict.reason, /不在 rig 的可用集合内/u);
});

test("#1179 观察失败、未对账、空集合、空目录一律未知，不得提前收口", () => {
  const cases = [
    judgeRequiredDeviceCapability({ requirement, devices: [device("d1")], admitted: { "rig-a": null } }),
    judgeRequiredDeviceCapability({ requirement, devices: [device("d1")],
      admitted: { "rig-a": { reconciled: false, usable: ["d1"] } } }),
    judgeRequiredDeviceCapability({ requirement, devices: [device("d1")],
      admitted: { "rig-a": { reconciled: true, usable: [] } } }),
    judgeRequiredDeviceCapability({ requirement: { ...requirement, model: "P70" }, devices: [device("d1")],
      admitted: { "rig-a": { reconciled: true, usable: ["d1"] } } }),
  ];
  for (const verdict of cases) assert.equal(verdict.state, "unknown", verdict.reason);
});

test("#1179 指定 key 或 rig 时只按该范围判定", () => {
  const devices = [device("d1", "rig-a"), device("d2", "rig-b")];
  const byKey = judgeRequiredDeviceCapability({ requirement: { ...requirement, key: "d2" }, devices,
    admitted: { "rig-a": { reconciled: true, usable: ["d1"] }, "rig-b": { reconciled: true, usable: ["d2"] } } });
  assert.equal(byKey.state, "available");
  const byRig = judgeRequiredDeviceCapability({ requirement: { ...requirement, rig_id: "rig-b" }, devices,
    admitted: { "rig-a": { reconciled: true, usable: [] }, "rig-b": { reconciled: true, usable: ["d9"] } } });
  assert.equal(byRig.state, "unavailable");
});
