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

export function humanMessageTargetForNode(node: CanvasNode | null | undefined): HumanMessageTarget {
  return isActiveHumanMessageTarget(node) ? { kind: "job", node_id: node.id } : { kind: "hub" };
}

function jobIdFromNode(node: CanvasNode | null | undefined): string | null {
  if (!node) return null;
  if (node.job_id) return node.job_id;
  return typeof node.body_json?.job_id === "string" ? node.body_json.job_id : null;
}

/** human 节点本身不能投递；解析到同 Job 的活动 intent/job/report，否则回落 Hub。 */
export function humanMessageTargetNodeFromContext(
  selected: CanvasNode | null | undefined,
  nodes: readonly CanvasNode[],
): CanvasNode | null {
  if (isActiveHumanMessageTarget(selected)) return selected;
  const jobId = jobIdFromNode(selected);
  if (!jobId) return null;
  return nodes.find((node) => node.job_id === jobId && isActiveHumanMessageTarget(node)) ?? null;
}

export function composeNodeIdForHumanIntervention(
  humanNode: CanvasNode,
  nodes: readonly CanvasNode[],
): string {
  return humanMessageTargetNodeFromContext(humanNode, nodes)?.id ?? humanNode.id;
}

export function humanMessageTargetNodeForJobId(
  jobId: string | null | undefined,
  nodes: readonly CanvasNode[],
): CanvasNode | null {
  if (!jobId) return null;
  return nodes.find((node) => node.job_id === jobId && isActiveHumanMessageTarget(node)) ?? null;
}

/** 本次运行列表：waiting_human 或仍活动的 human Job 可直接回复。 */
export function jobCanReceiveHumanReply(job: { type?: string | null; status?: string | null }): boolean {
  if (!job.status || !HUMAN_MESSAGE_ACTIVE_STATUSES.has(job.status)) return false;
  return job.status === "waiting_human" || job.type === "human";
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
