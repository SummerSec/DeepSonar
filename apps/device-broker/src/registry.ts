import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrokerDevice } from "./device.js";

/**
 * 设备准入登记表（#505 阶段 1 / a-lite）。
 *
 * 平台是「哪台设备可用」的权威：Scheduler 用 `PUT /rig/devices` 把期望集合整集替换进来。
 * broker 自身不持数据库、不持长期凭据；状态落在 rig 本地文件里，重启续用；
 * 文件缺失或损坏时生效集合为空（fail closed），等待平台重新 push。
 *
 * 与 rig 侧 env 上限的关系（三种模式，`snapshot().mode` 可自查）：
 *   1. 从未 push（`env-legacy`）：沿用 #495 行为——`DEVICE_BROKER_ALLOWED_KEYS` 由 LeaseStore 强制，
 *      空 = 拒绝所有设备；
 *   2. push 过且 `ALLOWED_KEYS` 非空（`platform-and-ceiling`）：生效集合 = 平台集合 ∩ env 上限
 *      （rig 主人保留否决权）；
 *   3. push 过且 `ALLOWED_KEYS` 为空：`DEVICE_BROKER_TRUST_PLATFORM=1` 才用平台集合（`platform`），
 *      否则一律不可用（`deny-all`）——防止平台在未获授权时借用 rig。
 */

export type ExpectedDevice = {
  key: string;
  transport: "adb" | "hdc";
  model?: string | null;
  /** 显式 false 的条目不会进入生效集合（保留字段便于平台表达"登记但未启用"）。 */
  enabled?: boolean;
};

export type RegistrySnapshot = {
  revision: number;
  pushedAt: string | null;
  devices: ExpectedDevice[];
  mode: RegistryMode;
};

export type RegistryMode =
  | "env-legacy"
  | "platform-and-ceiling"
  | "platform"
  | "deny-all";

const IMPLEMENTED_TRANSPORTS = new Set(["adb", "hdc"]);

export type ApplyOutcome =
  | { ok: true; snapshot: RegistrySnapshot }
  | { ok: false; reason: "revision_regression" };

function normalize(devices: ExpectedDevice[]): Map<string, ExpectedDevice> {
  const normalized = new Map<string, ExpectedDevice>();
  for (const device of devices) {
    if (!device || typeof device.key !== "string" || device.key.length === 0)
      continue;
    if (!IMPLEMENTED_TRANSPORTS.has(device.transport)) continue;
    if (device.enabled === false) continue;
    normalized.set(device.key, {
      key: device.key,
      transport: device.transport,
      model: device.model ?? null,
    });
  }
  return normalized;
}

export class DeviceRegistry {
  private revision = 0;
  private pushedAt: string | null = null;
  private pushed = new Map<string, ExpectedDevice>();

  constructor(
    private readonly deps: {
      /** rig 侧硬上限（env）；非空时与平台集合取交集。 */
      ceilingKeys: string[];
      /** rig 是否信任平台集合（仅在没有硬上限时生效）。 */
      trustPlatform: boolean;
      /** 本地状态文件；null 表示不持久化（测试用）。 */
      statePath: string | null;
    },
  ) {}

  /** 启动时读取上一次 push；缺失/损坏/非法一律当作"从未 push"（fail closed）。 */
  load(): void {
    if (!this.deps.statePath) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.deps.statePath, "utf8"),
      ) as Partial<RegistrySnapshot>;
      if (
        typeof parsed.revision !== "number" ||
        !Number.isFinite(parsed.revision) ||
        parsed.revision < 0
      )
        return;
      if (typeof parsed.pushedAt !== "string") return;
      if (!Array.isArray(parsed.devices)) return;
      this.revision = Math.floor(parsed.revision);
      this.pushedAt = parsed.pushedAt;
      this.pushed = normalize(parsed.devices as ExpectedDevice[]);
    } catch {
      // 文件不存在、不可读或 JSON 损坏：保持空集合，等待平台重新 push。
      this.revision = 0;
      this.pushedAt = null;
      this.pushed = new Map();
    }
  }

  reconciled(): boolean {
    return this.pushedAt !== null;
  }

  mode(): RegistryMode {
    if (this.pushed.size === 0) return "env-legacy";
    if (this.deps.ceilingKeys.length > 0) return "platform-and-ceiling";
    return this.deps.trustPlatform ? "platform" : "deny-all";
  }

  snapshot(): RegistrySnapshot {
    return {
      revision: this.revision,
      pushedAt: this.pushedAt,
      devices: [...this.pushed.values()],
      mode: this.mode(),
    };
  }

  /**
   * 整集替换。revision 必须单调递增：相同 revision 视为幂等重放（不改动、返回当前快照），
   * 回退则拒绝，避免网络乱序把旧集合盖到新集合上。
   */
  apply(input: {
    revision: number;
    devices: ExpectedDevice[];
    pushedAt?: string;
    nowMs?: number;
  }): ApplyOutcome {
    if (!Number.isFinite(input.revision) || input.revision < 0) {
      return { ok: false, reason: "revision_regression" };
    }
    const revision = Math.floor(input.revision);
    if (revision < this.revision)
      return { ok: false, reason: "revision_regression" };
    if (revision === this.revision && this.reconciled())
      return { ok: true, snapshot: this.snapshot() };

    this.revision = revision;
    this.pushedAt =
      input.pushedAt ?? new Date(input.nowMs ?? Date.now()).toISOString();
    this.pushed = normalize(input.devices);
    this.persist();
    return { ok: true, snapshot: this.snapshot() };
  }

  /** 物理枚举到且位于生效集合内的设备才可发租约。 */
  isUsable(device: Pick<BrokerDevice, "key" | "transport">): boolean {
    // 从未 reconcile：沿用 env 上限语义（LeaseStore 已强制），保持 #495 部署行为不变。
    if (this.pushed.size === 0) return true;
    const expected = this.pushed.get(device.key);
    if (!expected) return false;
    if (expected.transport !== device.transport) return false;
    if (this.deps.ceilingKeys.length > 0)
      return this.deps.ceilingKeys.includes(device.key);
    return this.deps.trustPlatform;
  }

  private persist(): void {
    if (!this.deps.statePath) return;
    try {
      mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
      writeFileSync(
        this.deps.statePath,
        `${JSON.stringify(this.snapshot(), null, 2)}\n`,
        "utf8",
      );
    } catch {
      // 持久化是尽力而为：内存集合仍是本进程的权威，失败由 GET /rig/devices 暴露给平台重推。
    }
  }
}
