import type { CanvasHumanMessage, CanvasHumanMessageStatus, CanvasNode } from "./api.js";

export const HUMAN_MESSAGE_MAX_LENGTH = 8_000;
export const HUMAN_MESSAGE_ACTIVE_STATUSES = new Set([
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
]);

export type HumanMessageTarget = { kind: "hub" } | { kind: "job"; node_id: string };

export const HUMAN_MESSAGE_STATUS_META: Record<CanvasHumanMessageStatus, { label: string; tone: string }> = {
  planned: { label: "等待注入会话", tone: "planned" },
  injected: { label: "已注入会话，等待 Agent 确认", tone: "injected" },
  acknowledged: { label: "Agent 已确认", tone: "acknowledged" },
  unknown: { label: "投递结果未知", tone: "unknown" },
  failed: { label: "投递失败", tone: "failed" },
};

export function humanMessageStatusLabel(status: CanvasHumanMessageStatus): string {
  return HUMAN_MESSAGE_STATUS_META[status].label;
}

export function isActiveHumanMessageTarget(node: CanvasNode | null | undefined): node is CanvasNode {
  return Boolean(
    node
      && (node.node_type === "intent" || node.node_type === "job" || node.node_type === "report")
      && node.job_id
      && node.status
      && HUMAN_MESSAGE_ACTIVE_STATUSES.has(node.status),
  );
}

export function humanMessageTargetForNode(node: CanvasNode | null | undefined): HumanMessageTarget | null {
  return isActiveHumanMessageTarget(node) ? { kind: "job", node_id: node.id } : null;
}

function jobIdFromNode(node: CanvasNode | null | undefined): string | null {
  if (!node) return null;
  if (node.job_id) return node.job_id;
  return typeof node.body_json?.job_id === "string" ? node.body_json.job_id : null;
}

/** human 节点本身不能投递；解析到同 Job 的活动 intent/job/report，否则没有目标。 */
export function humanMessageTargetNodeFromContext(
  selected: CanvasNode | null | undefined,
  nodes: readonly CanvasNode[],
): CanvasNode | null {
  if (isActiveHumanMessageTarget(selected)) return selected;
  const jobId = jobIdFromNode(selected);
  if (!jobId) return null;
  return nodes.find((node) => node.job_id === jobId && isActiveHumanMessageTarget(node)) ?? null;
}

export function humanMessageTargetNodeForJobId(
  jobId: string | null | undefined,
  nodes: readonly CanvasNode[],
): CanvasNode | null {
  if (!jobId) return null;
  return nodes.find((node) => node.job_id === jobId && isActiveHumanMessageTarget(node)) ?? null;
}

/** 本次运行列表只给正在等待人工的 Job 直接回复；human 是节点类型，不是 Job 类型。 */
export function jobCanReceiveHumanReply(job: { type?: string | null; status?: string | null }): boolean {
  return job.status === "waiting_human";
}

export function humanMessageTargetLabel(message: CanvasHumanMessage, nodes: readonly CanvasNode[]): string {
  if (message.target_kind === "hub") return "Hub";
  const target = nodes.find((node) => node.id === message.target_node_id);
  return target?.title || `运行节点 ${message.target_node_id ?? message.target_job_id}`;
}

export function safeHumanMessageFileName(value: string): string {
  const base = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const safe = base
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 160);
  return safe || "attachment";
}

export function humanMessageAssetKey(messageId: string, fileName: string, index: number): string {
  const ordinal = String(Math.max(0, Math.trunc(index)) + 1).padStart(3, "0");
  return `human-messages/${messageId}/${ordinal}-${safeHumanMessageFileName(fileName)}`;
}

export function messagesForCanvasNode(
  messages: readonly CanvasHumanMessage[],
  nodeId: string,
): CanvasHumanMessage[] {
  return messages.filter((message) => message.human_node_id === nodeId || message.target_node_id === nodeId);
}

/** Open request_human / comment / blocker nodes still waiting for an operator. */
export const HUMAN_INTERVENTION_PENDING_STATUSES = new Set(["open", ""]);
export const HUMAN_INTERVENTION_PREF_PREFIX = "deepsonar:human-intervention";

export interface HumanInterventionItem {
  node: CanvasNode;
  reason: string;
  findingId: string | null;
  jobId: string | null;
  pending: boolean;
}

export interface HumanInterventionPrefs {
  bannerCollapsed: boolean;
  hideProcessed: boolean;
  expandedIds: string[];
  messagesCollapsed: boolean;
  /** Request nodes the current user has already answered through a matching Job reply. */
  repliedIds: string[];
  /** Request nodes the current user explicitly hid without changing scheduler state. */
  hiddenIds: string[];
}

export function defaultHumanInterventionPrefs(): HumanInterventionPrefs {
  return { bannerCollapsed: true, hideProcessed: true, expandedIds: [], messagesCollapsed: true, repliedIds: [], hiddenIds: [] };
}

export function humanInterventionPrefKey(userKey: string, canvasId: string): string {
  return `${HUMAN_INTERVENTION_PREF_PREFIX}:${userKey || "local"}:${canvasId}`;
}

export function readHumanInterventionPrefs(userKey: string, canvasId: string): HumanInterventionPrefs {
  const fallback = defaultHumanInterventionPrefs();
  try {
    const raw = globalThis.localStorage?.getItem(humanInterventionPrefKey(userKey, canvasId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<HumanInterventionPrefs>;
    return {
      bannerCollapsed: parsed.bannerCollapsed !== false,
      hideProcessed: parsed.hideProcessed !== false,
      expandedIds: Array.isArray(parsed.expandedIds) ? parsed.expandedIds.filter((id): id is string => typeof id === "string") : [],
      messagesCollapsed: parsed.messagesCollapsed !== false,
      repliedIds: Array.isArray(parsed.repliedIds) ? parsed.repliedIds.filter((id): id is string => typeof id === "string") : [],
      hiddenIds: Array.isArray(parsed.hiddenIds) ? parsed.hiddenIds.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return fallback;
  }
}

export function writeHumanInterventionPrefs(userKey: string, canvasId: string, prefs: HumanInterventionPrefs): void {
  try {
    globalThis.localStorage?.setItem(humanInterventionPrefKey(userKey, canvasId), JSON.stringify(prefs));
  } catch {
    /* quota / private mode */
  }
}

export function toggleExpandedId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function subjectFindingId(node: CanvasNode): string | null {
  const subject = node.body_json?.subject;
  if (subject && typeof subject === "object" && typeof (subject as Record<string, unknown>).finding_id === "string") {
    return String((subject as Record<string, unknown>).finding_id);
  }
  return typeof node.body_json?.finding_id === "string" ? node.body_json.finding_id : null;
}

export function isIgnoredHumanIntervention(node: CanvasNode): boolean {
  return node.status === "ignored" || node.body_json?.resolution === "ignored";
}

export function isPendingHumanIntervention(node: CanvasNode): boolean {
  if (node.node_type !== "human" || isIgnoredHumanIntervention(node)) return false;
  return HUMAN_INTERVENTION_PENDING_STATUSES.has(node.status ?? "");
}

/** Operator can dismiss an open intervention; processed/history only hide. */
export function canIgnoreHumanIntervention(node: CanvasNode): boolean {
  return isPendingHumanIntervention(node);
}

export function humanInterventionJobId(node: CanvasNode): string | null {
  if (node.job_id) return node.job_id;
  return typeof node.body_json?.job_id === "string" ? node.body_json.job_id : null;
}

export function runtimeImageNotLocalIntervention(node: CanvasNode): {
  image_key: string;
  version: string | null;
  digest: string | null;
} | null {
  if (node.node_type !== "human") return null;
  const body = node.body_json ?? {};
  if (body.kind !== "runtime_image_not_local" && body.error_code !== "RUNTIME_IMAGE_NOT_LOCAL") return null;
  return {
    image_key: typeof body.image_key === "string" ? body.image_key : "",
    version: typeof body.version === "string" ? body.version : null,
    digest: typeof body.digest === "string" ? body.digest : null,
  };
}

export function listHumanInterventions(nodes: readonly CanvasNode[], limit = 12): HumanInterventionItem[] {
  return nodes
    .filter((node) => node.node_type === "human")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit)
    .map((node) => ({
      node,
      reason: typeof node.body_json?.reason === "string" ? node.body_json.reason : node.title || "等待人工判断",
      findingId: subjectFindingId(node),
      jobId: humanInterventionJobId(node),
      pending: isPendingHumanIntervention(node),
    }));
}

export function visibleHumanInterventions(
  items: readonly HumanInterventionItem[],
  hideProcessed: boolean,
  repliedIds: readonly string[] = [],
  hiddenIds: readonly string[] = [],
): HumanInterventionItem[] {
  if (!hideProcessed) return [...items];
  const replied = new Set(repliedIds);
  const hidden = new Set(hiddenIds);
  return items.filter((item) => item.pending && !replied.has(item.node.id) && !hidden.has(item.node.id));
}

export function countVisiblePendingHumanInterventions(
  items: readonly HumanInterventionItem[],
  repliedIds: readonly string[] = [],
  hiddenIds: readonly string[] = [],
): number {
  return visibleHumanInterventions(items, true, repliedIds, hiddenIds).length;
}

export function openHumanInterventionForJob(nodes: readonly CanvasNode[], jobId: string | null | undefined): CanvasNode | null {
  if (!jobId) return null;
  return nodes.find((node) => node.node_type === "human" && humanInterventionJobId(node) === jobId && isPendingHumanIntervention(node)) ?? null;
}

export function humanInterventionUiPrefUserKey(me: { user?: { id?: string | null } | null; actor?: { name?: string | null } | null } | null | undefined): string {
  return me?.user?.id || me?.actor?.name || "local";
}
