import assert from "node:assert/strict";
import test from "node:test";
import { verifyDeviceLeaseToken } from "@deepsonar/shared-types";
import type { BrokerAdbDevice } from "./adb.js";
import { LeaseStore } from "./leases.js";

const SECRET = "broker-lease-secret-0123456789abcdef";
const device: BrokerAdbDevice = { key: "rig-1", model: "Pixel-7", state: "device", transport: "adb" };

function store(options: { allowedKeys?: string[]; now?: () => number; ttlMaxSec?: number } = {}) {
  return new LeaseStore({
    allowedKeys: options.allowedKeys ?? ["rig-1"],
    leaseSecret: SECRET,
    ttlDefaultSec: 900,
    ttlMaxSec: options.ttlMaxSec ?? 3600,
    now: options.now,
  });
}

const acquireInput = {
  jobId: "job-1",
  attemptId: "attempt-1",
  projectId: "project-1",
  transport: "adb",
  deviceKey: null,
  model: null,
  exclusive: true,
  ttlSec: 900,
};

test("acquire only grants whitelisted devices and mints a verifiable short-lived token", async () => {
  const s = store();
  const granted = await s.acquire(acquireInput, [device]);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.equal(granted.lease.deviceKey, "rig-1");

  // token 是 broker 自己签发、两侧同一实现可验证的短期凭据。
  const payload = await verifyDeviceLeaseToken(granted.lease.token, SECRET);
  assert.equal(payload?.lease_id, granted.lease.leaseId);
  assert.equal(payload?.device_key, "rig-1");
  assert.equal(payload?.job_id, "job-1");
  assert.equal(await verifyDeviceLeaseToken(granted.lease.token, "wrong-secret-0123456789abcdefghij"), null);
  assert.equal(await verifyDeviceLeaseToken(`${granted.lease.token}x`, SECRET), null);

  // 名单外的设备与未实现的传输都不发租约（fail closed）。
  const notWhitelisted = await store({ allowedKeys: [] }).acquire(acquireInput, [device]);
  assert.deepEqual(notWhitelisted, { ok: false, reason: "not_whitelisted" });
  const unsupported = await s.acquire({ ...acquireInput, transport: "hdc" }, [device]);
  assert.deepEqual(unsupported, { ok: false, reason: "unsupported_transport" });
  const shared = await s.acquire({ ...acquireInput, exclusive: false }, [device]);
  assert.deepEqual(shared, { ok: false, reason: "unsupported_transport" });
});

test("one device holds at most one live lease and re-acquire is refused", async () => {
  const s = store();
  assert.equal((await s.acquire(acquireInput, [device])).ok, true);
  const second = await s.acquire({ ...acquireInput, jobId: "job-2" }, [device]);
  assert.deepEqual(second, { ok: false, reason: "device_busy" });

  // 释放后可以再租；重复释放幂等。
  const first = s.list()[0]!;
  assert.equal(s.release(first.leaseId, "released").lease?.releaseReason, "released");
  assert.equal((await s.acquire({ ...acquireInput, jobId: "job-2" }, [device])).ok, true);
  assert.equal(s.release("unknown-lease", "released").lease, null);
});

test("ttl is bounded by the broker ceiling and expiry frees the device", async () => {
  let now = 1_000_000;
  const s = store({ now: () => now, ttlMaxSec: 120 });
  const granted = await s.acquire({ ...acquireInput, ttlSec: 86_400 }, [device]);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  assert.equal((granted.lease.expiresAt - now) / 1000, 120);
  assert.equal(await s.session(granted.lease.token), granted.lease);

  now += 121_000;
  assert.equal(await s.session(granted.lease.token), null);
  // 过期由任何一次状态访问收敛：租约标记 expired，设备回到可用池。
  const expired = s.list()[0]!;
  assert.equal(expired.releaseReason, "expired");
  assert.equal(s.purgeExpired(), 0);
  assert.equal((await s.acquire({ ...acquireInput, jobId: "job-3" }, [device])).ok, true);
});

test("session resolves an active lease token and rejects a released one", async () => {
  const s = store();
  const granted = await s.acquire(acquireInput, [device]);
  assert.equal(granted.ok, true);
  if (!granted.ok) return;
  s.release(granted.lease.leaseId, "job_done");
  assert.equal(await s.session(granted.lease.token), null);
  assert.equal(await s.session("not-a-token"), null);
});
