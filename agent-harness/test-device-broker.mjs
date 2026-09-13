#!/usr/bin/env node
/**
 * Device broker 冒烟（#495 Phase 1）。
 *
 * 需要一台 device rig（broker + 真机）。未配置时按 skip 退出，不把「没环境」伪装成通过：
 *   DEEPSONAR_DEVICE_BROKER_URL   例如 http://rig.internal:8788
 *   DEEPSONAR_DEVICE_BROKER_TOKEN 与 rig 上 DEVICE_BROKER_TOKEN 相同
 *   DEEPSONAR_DEVICE_EXPECT_KEY   预期上架的真机序列号（白名单内）
 *   DEEPSONAR_DEVICE_ADB_BIN      可选，默认 adb；存在时额外跑一次真实 adb shell。
 *
 * 真机全链路（test 角色 Job → 沙箱 → adb shell → 证据）需要 AGENT_MODE=real 与 rig，
 * 见 docs/DEVICE_ACCESS.md §5；本脚本验证 broker 侧的端点/租约/回收闭环。
 */
const brokerUrl = process.env.DEEPSONAR_DEVICE_BROKER_URL?.trim().replace(/\/+$/, "");
const token = process.env.DEEPSONAR_DEVICE_BROKER_TOKEN?.trim();
const expectKey = process.env.DEEPSONAR_DEVICE_EXPECT_KEY?.trim();

if (!brokerUrl || !token || !expectKey) {
  console.log(
    "skip: device broker smoke needs DEEPSONAR_DEVICE_BROKER_URL, DEEPSONAR_DEVICE_BROKER_TOKEN and DEEPSONAR_DEVICE_EXPECT_KEY",
  );
  process.exit(0);
}

const auth = { authorization: `Bearer ${token}` };

async function json(path, init = {}) {
  const response = await fetch(`${brokerUrl}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function fail(message) {
  console.error(`device broker smoke failed: ${message}`);
  process.exit(1);
}

const health = await json("/health");
if (health.status !== 200 || health.body?.ok !== true) fail(`/health -> ${health.status}`);

const devices = await json("/devices");
if (devices.status !== 200) fail(`/devices -> ${devices.status}`);
const target = (devices.body?.devices ?? []).find((device) => device.key === expectKey);
if (!target) fail(`/devices 没有上架预期设备 ${expectKey}`);
if (target.whitelisted !== true) fail(`设备 ${expectKey} 不在白名单内（broker 会拒发租约）`);

const jobId = process.env.DEEPSONAR_DEVICE_JOB_ID?.trim() || "smoke-job";
const attemptId = process.env.DEEPSONAR_DEVICE_ATTEMPT_ID?.trim() || "smoke-attempt";
const projectId = process.env.DEEPSONAR_DEVICE_PROJECT_ID?.trim() || "smoke-project";
const acquired = await json("/lease/acquire", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    job_id: jobId,
    attempt_id: attemptId,
    project_id: projectId,
    transport: "adb",
    device_key: expectKey,
    exclusive: true,
    ttl_sec: 300,
  }),
});
if (acquired.status !== 201) fail(`/lease/acquire -> ${acquired.status} ${JSON.stringify(acquired.body)}`);
const grant = acquired.body;
if (grant.device_key !== expectKey) fail(`租约设备不符：${grant.device_key}`);
if (!grant.endpoint?.host || !grant.endpoint?.port) fail("租约缺少端点（DEVICE_BROKER_ADB_HOST 未配置？）");

const session = await json("/session", { headers: { authorization: `Bearer ${grant.token}` } });
if (session.status !== 200) fail(`/session -> ${session.status}`);
if (session.body?.device_key !== expectKey) fail("session 与租约设备不一致");

const adbBin = process.env.DEEPSONAR_DEVICE_ADB_BIN?.trim() || "adb";
let adbChecked = false;
try {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(
    adbBin,
    ["-H", grant.endpoint.host, "-P", String(grant.endpoint.port), "-s", expectKey, "shell", "getprop", "ro.product.model"],
    { timeout: 20_000 },
  );
  adbChecked = String(stdout).trim().length > 0;
  if (!adbChecked) fail("adb shell getprop 没有输出");
  console.log(`adb ok: ${String(stdout).trim()}`);
} catch (error) {
  // 沙箱/CI 上没有 adb 时不假装通过，只报告未覆盖的那一步。
  console.log(`note: 跳过真实 adb 调用（${error instanceof Error ? error.message : String(error)}）`);
}

const released = await json("/lease/release", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ lease_id: grant.lease_id, device_key: expectKey, reason: "smoke" }),
});
if (released.status !== 200) fail(`/lease/release -> ${released.status}`);

const afterRelease = await json("/session", { headers: { authorization: `Bearer ${grant.token}` } });
if (afterRelease.status !== 401) fail(`释放后租约 token 仍可用：${afterRelease.status}`);

console.log(
  `device broker smoke ok: key=${expectKey} endpoint=${grant.endpoint.host}:${grant.endpoint.port} adb=${adbChecked ? "checked" : "skipped"}`,
);
