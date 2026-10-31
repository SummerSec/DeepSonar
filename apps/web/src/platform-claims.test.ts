import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { platformClaimsBanner, type PlatformClaimsStatus } from "./platform-claims";

const base: PlatformClaimsStatus = {
  claims_paused: false,
  reason: null,
  note: null,
  paused_by: null,
  paused_at: null,
  state: "running",
  drained: true,
  in_flight: { claimed: 0, provisioning: 0, running: 0, total: 0 },
  pending: 0,
  waiting_human: 0,
  effect_pending_attempts: 0,
  unknown_effect_attempts: 0,
};

test("no banner while platform claims run", () => {
  assert.equal(platformClaimsBanner(null), null);
  assert.equal(platformClaimsBanner(base), null);
});

test("pausing banner shows in-flight drain and unsettled effects", () => {
  const banner = platformClaimsBanner({
    ...base,
    claims_paused: true,
    reason: "platform_upgrade",
    note: "  升级到 v0.6.0 ",
    state: "pausing",
    drained: false,
    in_flight: { claimed: 1, provisioning: 0, running: 2, total: 3 },
    pending: 4,
    effect_pending_attempts: 1,
  });
  assert.ok(banner);
  assert.equal(banner.title, "平台已暂停领取新任务（平台升级）");
  assert.match(banner.detail, /新任务仍可创建并入队/);
  assert.match(banner.detail, /在途 3 个 Job 收尾中/);
  assert.match(banner.detail, /1 个 Attempt 有未结算外部效果/);
  assert.match(banner.detail, /4 个已入队等待恢复/);
  assert.equal(banner.note, "升级到 v0.6.0");
});

test("drained banner and unknown reason stay explicit", () => {
  const banner = platformClaimsBanner({ ...base, claims_paused: true, reason: null, state: "paused" });
  assert.ok(banner);
  assert.equal(banner.title, "平台已暂停领取新任务（原因未知）");
  assert.match(banner.detail, /在途 Job 已全部收尾/);
  assert.equal(banner.note, null);
});

test("app shell renders the global platform claims banner", () => {
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /platformClaimsBanner\(/);
  assert.match(shell, /api\.platformClaims\(\)/);
  assert.match(shell, /canAccessAnyScope\(me, \["tasks:read"\]\)/);
});
