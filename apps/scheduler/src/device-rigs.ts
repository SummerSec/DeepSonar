import { DEFAULT_DEVICE_RIG_ID } from "@deepsonar/shared-types";

/**
 * 设备 rig 注册表（#505 后续：多 rig）。
 *
 * rig 是承载 device broker 的外部设备机；平台是准入权威，按 rig 分发期望集合并按 rig 选 broker 端点。
 * 端点与入站凭据只来自平台配置（与单 rig 时代的 `DEEPSONAR_DEVICE_BROKER_URL` 同一模式），不进
 * Job 快照、sandbox 或 evidence；`devices.rig_id` 只存**标识**，不存地址与密钥。
 */

export type DeviceRig = {
  id: string;
  brokerUrl: string;
  brokerToken: string;
};

export type DeviceRigParseResult = {
  rigs: DeviceRig[];
  /** 被拒绝的条目（原因只含形状描述，不回显 token）。 */
  invalid: string[];
};

const RIG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

/** 单条：`id=http(s)://host:port|token`。 */
function parseEntry(entry: string): DeviceRig | string {
  const separator = entry.indexOf("=");
  if (separator <= 0) return `条目缺少 'id=' 前缀`;
  const id = entry.slice(0, separator).trim();
  const rest = entry.slice(separator + 1);
  if (!RIG_ID_RE.test(id)) return `rig id 不合法（${id.length} 字符）`;
  if (id === DEFAULT_DEVICE_RIG_ID)
    return `rig id '${DEFAULT_DEVICE_RIG_ID}' 保留给默认 rig（由 DEEPSONAR_DEVICE_BROKER_URL 提供）`;
  const pipe = rest.indexOf("|");
  if (pipe <= 0) return `条目 ${id} 缺少 '|token'`;
  const brokerUrl = rest.slice(0, pipe).trim().replace(/\/+$/u, "");
  const brokerToken = rest.slice(pipe + 1).trim();
  if (!/^https?:\/\//u.test(brokerUrl)) return `条目 ${id} 的 broker 地址必须是以 http(s):// 开头`;
  if (brokerToken === "") return `条目 ${id} 缺少 broker token`;
  return { id, brokerUrl, brokerToken };
}

/**
 * 解析 `DEEPSONAR_DEVICE_RIGS`（`;` 分隔）。非法条目整条丢弃（fail closed：宁可少一台 rig，
 * 也不接受形状不明的端点），并把原因回报给调用方，便于启动日志/管理面暴露。
 */
export function parseDeviceRigs(raw: string | undefined | null): DeviceRigParseResult {
  const rigs: DeviceRig[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const chunk of String(raw ?? "").split(";")) {
    const entry = chunk.trim();
    if (entry === "") continue;
    const parsed = parseEntry(entry);
    if (typeof parsed === "string") {
      invalid.push(parsed);
      continue;
    }
    if (seen.has(parsed.id)) {
      invalid.push(`rig id 重复：${parsed.id}`);
      continue;
    }
    seen.add(parsed.id);
    rigs.push(parsed);
  }
  return { rigs, invalid };
}

/** 默认 rig 来自单 rig 时代的 `DEEPSONAR_DEVICE_BROKER_URL` / `_TOKEN`（两者齐备才存在）。 */
export function defaultDeviceRig(
  brokerUrl: string | undefined | null,
  brokerToken: string | undefined | null,
): DeviceRig | null {
  const url = String(brokerUrl ?? "").trim().replace(/\/+$/u, "");
  const token = String(brokerToken ?? "").trim();
  if (url === "" || token === "") return null;
  return { id: DEFAULT_DEVICE_RIG_ID, brokerUrl: url, brokerToken: token };
}

/** 默认 rig 在前，其余按 id 排序，保证推送顺序稳定（便于测试与阅读日志）。 */
export function allDeviceRigs(
  defaultRig: DeviceRig | null,
  extraRigs: readonly DeviceRig[],
): DeviceRig[] {
  const sorted = [...extraRigs].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return defaultRig ? [defaultRig, ...sorted] : sorted;
}

/** 目标 rig：缺省标识回落默认 rig；未配置返回 null（调用方必须 fail closed）。 */
export function rigForId(
  rigs: readonly DeviceRig[],
  rigId: string | null | undefined,
): DeviceRig | null {
  const target = rigId === null || rigId === undefined || rigId === "" ? DEFAULT_DEVICE_RIG_ID : rigId;
  return rigs.find((rig) => rig.id === target) ?? null;
}

export function rigIds(rigs: readonly DeviceRig[]): string[] {
  return rigs.map((rig) => rig.id);
}
