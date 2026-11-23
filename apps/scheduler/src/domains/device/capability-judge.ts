/**
 * 补证前的设备能力**只读**判定（#1179，本阶段仅观测，不改变任何状态）。
 *
 * 评审口径：先用正面证据说话。broker 的可用集合里没有目标设备，只说明「此刻没观察到
 * 它可用」——可能只是掉线、维护或还没对账。所以这里**不产出「不可用」结论**，
 * 只区分「观察到可用」与「未知」，并把未知的原因说清楚：
 *
 *  - 观测失败 / 未对账 / 可用集合为空  → 未知；
 *  - 目标设备不在可用集合内            → 未知（absence，不是负面证据）；
 *  - 目标设备在可用集合内              → 可用。
 *
 * 任何「提前收口人工」的动作都要求带对象、来源与时效的明确负面证据，目前平台没有
 * 这样的来源，因此本模块不接线到 Finding 状态机，也不参与是否建立 test Job 的判定。
 */

export type DeviceCapabilityState = "available" | "unknown";

export type DeviceCapabilityVerdict = {
  state: DeviceCapabilityState;
  /** 面向运维的一句话结论；不含设备端点、密钥或外部原文。 */
  reason: string;
  /** 判定所依据的 rig 与它的观测状态，便于后续补齐负面证据时复用。 */
  rigs: Array<{ rig_id: string; reconciled: boolean; usable: string[] }>;
};

export type JudgedDeviceRow = { key: string; transport: string; model: string | null; rig_id: string };

/** rig 的 broker 观测；null 表示这次读取失败（超时、401、契约不符）。 */
export type JudgedRigAdmission = { reconciled: boolean; usable: readonly string[] } | null;

export type JudgedRequirement = {
  transport: string;
  key?: string | null;
  model?: string | null;
  rig_id?: string | null;
};

/** 纯判定，不做 IO：便于覆盖「目标在集合内」「目标缺席」「rig 观测缺失」「跨 rig 不互相顶替」。 */
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
    return { state: "unknown", rigs: [],
      reason: "设备目录里没有匹配本次要求的登记，无法据此形成任何能力结论" };
  }
  // 逐 rig 判定，绝不把不同 rig 的可用集合并起来：一个 rig 上的别的设备可用，
  // 不能说明目标 rig 的状态，也不能替目标 rig 里的目标设备作证。
  const { rigs, reasons, observedAvailable } = observePerRig(candidates, input.admitted);
  if (observedAvailable) return { state: "available", rigs, reason: "所需设备已在 rig 可用集合内" };
  return { state: "unknown", rigs,
    reason: `${reasons.join("；") || "没有可用的观测"}；缺席不构成不可用证据，暂不可用与未知保持原路径` };
}

type RigObservation = { rig_id: string; reconciled: boolean; usable: string[] };

function observePerRig(
  candidates: readonly JudgedDeviceRow[],
  admitted: Readonly<Record<string, JudgedRigAdmission>>,
): { rigs: RigObservation[]; reasons: string[]; observedAvailable: boolean } {
  const rigs: RigObservation[] = [];
  const reasons: string[] = [];
  let observedAvailable = false;
  for (const rig of [...new Set(candidates.map((row) => row.rig_id))]) {
    const admission = admitted[rig] ?? null;
    if (!admission) {
      reasons.push(`rig ${rig} 的可用集合读取失败`);
      continue;
    }
    rigs.push({ rig_id: rig, reconciled: admission.reconciled, usable: [...admission.usable] });
    if (!admission.reconciled) {
      reasons.push(`rig ${rig} 尚未完成对账`);
      continue;
    }
    if (admission.usable.length === 0) {
      reasons.push(`rig ${rig} 未上报任何可用设备`);
      continue;
    }
    const wantedHere = candidates.filter((row) => row.rig_id === rig);
    if (wantedHere.some((row) => admission.usable.includes(row.key))) observedAvailable = true;
    else reasons.push(`目标设备不在 rig ${rig} 当前可用集合内`);
  }
  return { rigs, reasons, observedAvailable };
}
