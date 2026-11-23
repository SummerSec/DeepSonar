/**
 * 补证前的设备能力判定（#1179）。
 *
 * 目标只有一个：在有**可信依据**证明所需运行能力不可用时，才在首次补证前直接收口人工，
 * 不再建立一个注定失败的 test Job。因此这里只承认一种「不可用」证据，其余一律回报未知，
 * 交回既有护栏，绝不把「观察失败」「空列表」「离线维护」当成不可用。
 *
 * 判定只读两个平台侧事实：
 *  - 设备目录里的登记行（哪些 key 属于本次要求的 transport / key / model）；
 *  - 对应 rig 的 broker 观测（是否已对账、以及它当前真正可用的 key 集合）。
 */

export type DeviceCapabilityState = "available" | "unavailable" | "unknown";

export type DeviceCapabilityVerdict = {
  state: DeviceCapabilityState;
  /** 面向运维的一句话结论；不含设备端点、密钥或外部原文。 */
  reason: string;
};

export type JudgedDeviceRow = {
  key: string;
  transport: string;
  model: string | null;
  rig_id: string;
};

/** rig 的 broker 观测；null 表示这次读取失败（超时、401、契约不符）。 */
export type JudgedRigAdmission = { reconciled: boolean; usable: readonly string[] } | null;

export type JudgedRequirement = {
  transport: string;
  key?: string | null;
  model?: string | null;
  rig_id?: string | null;
};

/**
 * 纯判定，不做 IO，便于单测覆盖「不可用 / 未知 / 可用」三态与它们的边界。
 *
 * 只有一种情况判 `unavailable`：目录里存在符合要求的登记行，相关 rig 都读到了观测、
 * 都已对账，且 broker 的可用集合**非空**但一个都不包含这些登记 key。此时「读不到能力」
 * 不是观察失败，而是平台已经知道它有别的设备、就是没有这一台。
 */
export function judgeRequiredDeviceCapability(input: {
  requirement: JudgedRequirement;
  devices: readonly JudgedDeviceRow[];
  admitted: Readonly<Record<string, JudgedRigAdmission>>;
}): DeviceCapabilityVerdict {
  const wanted = input.requirement;
  const requestedKey = typeof wanted.key === "string" && wanted.key.trim() !== "" ? wanted.key : null;
  const requestedModel = typeof wanted.model === "string" && wanted.model.trim() !== "" ? wanted.model : null;
  const scoped = wanted.rig_id ? input.devices.filter((row) => row.rig_id === wanted.rig_id) : [...input.devices];
  const candidates = scoped.filter((row) => row.transport === wanted.transport
    && (requestedKey ? row.key === requestedKey : !requestedModel || row.model === requestedModel));
  if (candidates.length === 0) {
    // 空目录也可能是同步失败，因此不能据此收口（#1179 明确点名的情形）。
    return { state: "unknown", reason: "设备目录里没有匹配本次要求的登记，无法据此断定不可用" };
  }
  const rigs = [...new Set(candidates.map((row) => row.rig_id))];
  const observations: JudgedRigAdmission[] = [];
  for (const rig of rigs) {
    const admission = input.admitted[rig] ?? null;
    if (!admission) return { state: "unknown", reason: `设备 rig ${rig} 的可用集合读取失败，不能断定不可用` };
    if (!admission.reconciled) return { state: "unknown", reason: `设备 rig ${rig} 尚未完成对账，观察不算证据` };
    observations.push(admission);
  }
  const usable = new Set(observations.flatMap((admission) => [...(admission?.usable ?? [])]));
  if (candidates.some((row) => usable.has(row.key))) return { state: "available", reason: "所需设备已在 rig 可用集合内" };
  if (usable.size === 0) {
    // 离线、维护、broker 只上报空集合，都属于暂不可用，交给既有租约与护栏路径。
    return { state: "unknown", reason: "设备 rig 未上报任何可用设备（离线或维护），属于暂不可用" };
  }
  return { state: "unavailable", reason: "已登记的匹配设备都不在 rig 的可用集合内" };
}
