import assert from "node:assert/strict";
import test from "node:test";
import {
  allDeviceRigs,
  defaultDeviceRig,
  parseDeviceRigs,
  rigForId,
  rigIds,
  type DeviceRig,
} from "./device-rigs.js";

test("rig entries parse into id/url/token and trailing slashes are trimmed", () => {
  const parsed = parseDeviceRigs(
    "rig-a=http://127.0.0.1:8788|token-a; rig-b=https://rig.internal:9443/|token-b",
  );
  assert.deepEqual(parsed.invalid, []);
  assert.deepEqual(parsed.rigs, [
    { id: "rig-a", brokerUrl: "http://127.0.0.1:8788", brokerToken: "token-a" },
    { id: "rig-b", brokerUrl: "https://rig.internal:9443", brokerToken: "token-b" },
  ]);
});

test("malformed or reserved entries are dropped whole instead of half-applied", () => {
  const parsed = parseDeviceRigs(
    [
      "rig-a", // 缺 '='
      "Bad=Id|tok", // id 形状非法
      "rig-c=ftp://host|tok", // 非 http(s)
      "rig-d=http://host", // 缺 |token
      "rig-e=http://host|", // token 为空
      "default=http://host|tok", // 保留给默认 rig
      "rig-a=http://host|tok", // 重复（第一条已合法时才算重复）
      "rig-f=http://host|tok",
    ].join(";"),
  );
  // 只保留 rig-a（第一条合法）与 rig-f；其余整条丢弃。
  assert.deepEqual(rigIds(parsed.rigs), ["rig-a", "rig-f"]);
  assert.equal(parsed.invalid.length, 6);
  // 原因只描述形状，不回显 token。
  assert.deepEqual(parsed.invalid.some((reason) => reason.includes("tok") && reason.includes("http")), false);
});

test("empty or missing configuration yields no rigs and no errors", () => {
  assert.deepEqual(parseDeviceRigs(undefined), { rigs: [], invalid: [] });
  assert.deepEqual(parseDeviceRigs(""), { rigs: [], invalid: [] });
  assert.deepEqual(parseDeviceRigs("  ;;  "), { rigs: [], invalid: [] });
});

test("the default rig only exists when both url and token are configured", () => {
  assert.equal(defaultDeviceRig("", "token"), null);
  assert.equal(defaultDeviceRig("http://host", ""), null);
  assert.deepEqual(defaultDeviceRig("http://host/", "token"), {
    id: "default",
    brokerUrl: "http://host",
    brokerToken: "token",
  });
});

test("default rig comes first and the rest are ordered by id", () => {
  const extra: DeviceRig[] = [
    { id: "rig-z", brokerUrl: "http://z", brokerToken: "z" },
    { id: "rig-a", brokerUrl: "http://a", brokerToken: "a" },
  ];
  const rigs = allDeviceRigs(defaultDeviceRig("http://host", "token"), extra);
  assert.deepEqual(rigIds(rigs), ["default", "rig-a", "rig-z"]);
  assert.deepEqual(rigIds(allDeviceRigs(null, extra)), ["rig-a", "rig-z"]);
  assert.deepEqual(allDeviceRigs(null, []), []);
});

test("rig lookup falls back to the default rig but never invents one", () => {
  const rigs = allDeviceRigs(defaultDeviceRig("http://host", "token"), [
    { id: "rig-a", brokerUrl: "http://a", brokerToken: "a" },
  ]);
  assert.equal(rigForId(rigs, undefined)?.id, "default");
  assert.equal(rigForId(rigs, null)?.id, "default");
  assert.equal(rigForId(rigs, "")?.id, "default");
  assert.equal(rigForId(rigs, "rig-a")?.brokerUrl, "http://a");
  // 未配置的 rig → null（调用方 fail closed，绝不回落默认 rig）。
  assert.equal(rigForId(rigs, "rig-missing"), null);
  assert.equal(rigForId([], undefined), null);
});
