/**
 * 真实设备准入（#505）的前端纯逻辑：标签、可管理性判定与错误提示映射。
 * 这里不放请求，只放可单测的投影，页面只负责组装。
 */

export const DEVICE_TRANSPORTS = ["adb", "hdc"] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

export const DEVICE_TRANSPORT_OPTIONS: { value: DeviceTransport; label: string }[] = [
  { value: "adb", label: "ADB（Android）" },
  { value: "hdc", label: "HDC（OpenHarmony）" },
];

const STATUS_LABELS: Record<string, string> = {
  idle: "空闲",
  leased: "已租出",
  offline: "离线",
  maintenance: "维护中",
  revoked: "已下架",
};

const LEASE_STATE_LABELS: Record<string, string> = {
  pending: "待发放",
  active: "生效中",
  released: "已释放",
  expired: "已过期",
  revoked: "已撤销",
};

const ACTION_LABELS: Record<string, string> = {
  enable: "启用",
  maintenance: "转维护",
  revoke: "下架",
};

export function deviceStatusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return STATUS_LABELS[status] ?? status;
}

export function deviceStatusTone(status: string | null | undefined): "ok" | "warn" | "danger" | "muted" {
  if (status === "idle") return "ok";
  if (status === "leased") return "warn";
  if (status === "revoked") return "danger";
  if (status === "maintenance" || status === "offline") return "muted";
  return "muted";
}

export function leaseStateLabel(state: string | null | undefined): string {
  if (!state) return "未知";
  return LEASE_STATE_LABELS[state] ?? state;
}

export function deviceActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** 只有未结束的租约才占用设备：`pending` / `active`。 */
export function leaseIsActive(state: string | null | undefined): boolean {
  return state === "pending" || state === "active";
}

/** 写操作（登记 / 下架 / 删除 / 强制释放）需要 `admin`；与后端 ROUTE_SCOPES 的约定一致。 */
export function deviceCanManage(
  me: {
    auth_required: boolean;
    authenticated: boolean;
    actor: { role: string | null; scopes: string[] } | null;
  } | null,
): boolean {
  if (!me || !me.authenticated) return false;
  // 未开鉴权的单机/内网部署等同全权；否则要求 admin 角色或 admin scope。
  if (!me.auth_required) return true;
  if (me.actor?.role === "admin") return true;
  return Array.isArray(me.actor?.scopes) && me.actor.scopes.includes("admin");
}

/** api 层把错误压成 `CODE: message`，这里取回稳定代号用于给操作者补救提示。 */
export function deviceErrorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  const matched = /^([A-Z][A-Z0-9_]{2,})/.exec(message.trim());
  return matched ? matched[1] : null;
}

/**
 * 把稳定错误码翻成"下一步做什么"，避免让操作者猜（设备在途租约 / 有历史是两种不同处置）。
 */
export function deviceRemedyHint(errorCode: string | null | undefined): string | null {
  switch (errorCode) {
    case "DEVICE_HAS_ACTIVE_LEASE":
      return "设备仍有在途租约：先在下方租约列表强制释放，再下架或删除。";
    case "DEVICE_HAS_LEASE_HISTORY":
      return "该设备有租约历史（审计不可删）：用「下架」把它移出 rig 准入集合，而不是删除。";
    case "DEVICE_LEASE_NOT_ACTIVE":
      return "该租约已结束，无需再次释放。";
    case "DEVICE_NOT_FOUND":
      return "登记项已不存在，刷新列表。";
    case "INVALID_PROJECT":
      return "项目不存在：确认 project_id，留空表示平台共享池。";
    case "PROJECT_MISMATCH":
      return "项目主体的 token 只能管理本项目的设备。";
    default:
      return null;
  }
}

/** rig 侧准入摘要：未配置 / 未同步 / 已同步，供页面直接展示。 */
export function rigAdmissionSummary(rig: {
  enabled: boolean;
  broker_configured: boolean;
  admission: { mode: string; reconciled: boolean; usable: string[] } | null;
} | null | undefined): string {
  if (!rig) return "未知";
  if (!rig.enabled) return "平台未启用真实设备接入";
  if (!rig.broker_configured) return "未配置 rig broker（DEEPSONAR_DEVICE_BROKER_URL）";
  if (!rig.admission) return "rig broker 不可达或返回异常，准入未知";
  return rig.admission.reconciled
    ? `已同步（mode=${rig.admission.mode}，可用 ${rig.admission.usable.length} 台）`
    : `期望集合已下发、rig 尚未确认（mode=${rig.admission.mode}）`;
}
