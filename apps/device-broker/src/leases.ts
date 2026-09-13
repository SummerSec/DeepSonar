import { randomUUID } from "node:crypto";
import {
  DEVICE_LEASE_TOKEN_VERSION,
  DeviceLeaseTokenPayload,
  mintDeviceLeaseToken,
  verifyDeviceLeaseToken,
} from "@deepsonar/shared-types";
import type { BrokerAdbDevice } from "./adb.js";

/**
 * 租约登记表（Phase 1 为进程内状态）。
 *
 * 单设备同刻只允许一个未结束租约；租约 token 由 broker 签发（HMAC-SHA256，与 Scheduler
 * 共享密钥），沙箱只拿到短期 token 与端点，不持有任何长期凭据。设备是真机，broker 重启
 * 后租约全部失效——这比“租约泄漏导致设备被永久占用”更安全，Scheduler 侧会按
 * `device_not_available` 重试或由 Reaper 收敛。
 */

export type BrokerLease = {
  leaseId: string;
  deviceKey: string;
  jobId: string;
  attemptId: string;
  projectId: string;
  createdAt: number;
  expiresAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
  token: string;
};

export type AcquireInput = {
  jobId: string;
  attemptId: string;
  projectId: string;
  transport: string;
  deviceKey: string | null;
  model: string | null;
  exclusive: boolean;
  ttlSec: number;
};

export type AcquireOutcome =
  | { ok: true; lease: BrokerLease }
  | { ok: false; reason: "unsupported_transport" | "no_device" | "device_busy" | "not_whitelisted" | "leased" };

export class LeaseStore {
  private readonly leases = new Map<string, BrokerLease>();

  constructor(
    private readonly deps: {
      allowedKeys: string[];
      leaseSecret: string;
      ttlDefaultSec: number;
      ttlMaxSec: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private isWhitelisted(deviceKey: string): boolean {
    return this.deps.allowedKeys.includes(deviceKey);
  }

  private activeLeaseFor(deviceKey: string): BrokerLease | null {
    for (const lease of this.leases.values()) {
      if (lease.deviceKey !== deviceKey) continue;
      if (lease.releasedAt !== null) continue;
      if (lease.expiresAt <= this.now()) continue;
      return lease;
    }
    return null;
  }

  /** 到期即视为释放：设备回到可用池，token 立即失效。 */
  purgeExpired(): number {
    let purged = 0;
    for (const lease of this.leases.values()) {
      if (lease.releasedAt !== null) continue;
      if (lease.expiresAt > this.now()) continue;
      lease.releasedAt = this.now();
      lease.releaseReason = "expired";
      purged += 1;
    }
    return purged;
  }

  async acquire(input: AcquireInput, devices: BrokerAdbDevice[]): Promise<AcquireOutcome> {
    this.purgeExpired();
    if (input.transport !== "adb") return { ok: false, reason: "unsupported_transport" };
    if (!input.exclusive) return { ok: false, reason: "unsupported_transport" };
    const candidates = devices.filter((device) =>
      input.deviceKey ? device.key === input.deviceKey : input.model ? device.model === input.model : true,
    );
    if (candidates.length === 0) return { ok: false, reason: "no_device" };
    const device = candidates.find((candidate) => this.isWhitelisted(candidate.key));
    if (!device) return { ok: false, reason: "not_whitelisted" };
    if (this.activeLeaseFor(device.key)) return { ok: false, reason: "device_busy" };

    const ttlSec = Math.min(
      Math.max(Number.isFinite(input.ttlSec) ? input.ttlSec : this.deps.ttlDefaultSec, 60),
      this.deps.ttlMaxSec,
    );
    const leaseId = randomUUID();
    const expiresAt = this.now() + ttlSec * 1000;
    const payload = DeviceLeaseTokenPayload.parse({
      lease_id: leaseId,
      device_key: device.key,
      job_id: input.jobId,
      attempt_id: input.attemptId,
      exp: Math.floor(expiresAt / 1000),
      nonce: randomUUID().replaceAll("-", ""),
    });
    const token = await mintDeviceLeaseToken(payload, this.deps.leaseSecret);
    const lease: BrokerLease = {
      leaseId,
      deviceKey: device.key,
      jobId: input.jobId,
      attemptId: input.attemptId,
      projectId: input.projectId,
      createdAt: this.now(),
      expiresAt,
      releasedAt: null,
      releaseReason: null,
      token,
    };
    this.leases.set(leaseId, lease);
    return { ok: true, lease };
  }

  /** 幂等释放；未知租约也返回 released（Scheduler 侧把 404 当成功）。 */
  release(leaseId: string, reason: string): { ok: true; lease: BrokerLease | null } {
    this.purgeExpired();
    const lease = this.leases.get(leaseId) ?? null;
    if (!lease) return { ok: true, lease: null };
    if (lease.releasedAt === null) {
      lease.releasedAt = this.now();
      lease.releaseReason = reason;
    }
    return { ok: true, lease };
  }

  /** 沙箱侧短时端点查询：只接受未过期的租约 token。 */
  async session(token: string): Promise<BrokerLease | null> {
    this.purgeExpired();
    const payload = await verifyDeviceLeaseToken(token, this.deps.leaseSecret, this.now());
    if (!payload) return null;
    const lease = this.leases.get(payload.lease_id);
    if (!lease || lease.releasedAt !== null) return null;
    if (lease.expiresAt <= this.now()) return null;
    return lease;
  }

  list(): BrokerLease[] {
    this.purgeExpired();
    return [...this.leases.values()];
  }

  static tokenVersion(): string {
    return DEVICE_LEASE_TOKEN_VERSION;
  }
}
