import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { provisionFailureProvesNeverStarted } from "./provision-retry-admission.js";

function diagnostic(overrides: Record<string, unknown> = {}) {
  return {
    stage: "create",
    session_observed: false,
    cancelled: false,
    http_status: 500,
    signals: { execd_distribution_failed: false, broken_pipe: false, connection_reset: false, timeout: false },
    ...overrides,
  };
}

test("#1119 方案 C：只有可证伪的 host 诊断才等价于 never_started", () => {
  assert.equal(provisionFailureProvesNeverStarted(diagnostic()), true, "create + 无会话 + 非取消 + 500 应放行");
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ stage: "runtime_contract" })), true);
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ http_status: 599 })), true);
  // 会话已观察到 → 外部效果未知，必须继续 fail closed
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ session_observed: true })), false);
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ cancelled: true })), false);
  // 阶段不在白名单
  for (const stage of ["shared_assets", "runtime_manual", "gateway"]) {
    assert.equal(provisionFailureProvesNeverStarted(diagnostic({ stage })), false, stage);
  }
  // 非 5xx 或未知状态码
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ http_status: 404 })), false);
  assert.equal(provisionFailureProvesNeverStarted(diagnostic({ http_status: null })), false);
  // 结构不合法（缺字段 / 非对象 / 字符串 / 数组）
  assert.equal(provisionFailureProvesNeverStarted(undefined), false);
  assert.equal(provisionFailureProvesNeverStarted("create"), false);
  assert.equal(provisionFailureProvesNeverStarted([]), false);
  const broken = diagnostic();
  delete (broken as Record<string, unknown>).signals;
  assert.equal(provisionFailureProvesNeverStarted(broken), false, "缺 signals 不是合法诊断");
});

test("#1119 方案 C：unknown-effect 门禁只在证据成立时放行，且保留重试预算与人工边界", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /if \(blocked && !provisionFailureProvesNeverStarted\(blocked\.evidence_json\)\) return false;/,
    "放行必须挂在既有 blocked 门禁上，不能绕过");
  assert.match(source, /from "\.\/provision-retry-admission\.js"/);
  assert.match(source, /planAutomaticProvisionRetry\(countConsumedProvisionRetries\(previous\)\)/,
    "有界重试预算仍然生效");
  assert.match(source, /hasHumanOrRepairBoundary\(tx, jobId\)/,
    "人工/修复边界仍然优先于自动重试");
});
