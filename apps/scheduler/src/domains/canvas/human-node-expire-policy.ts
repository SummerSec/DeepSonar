export type HumanNodeExpireReason =
  | "keep"
  | "job_not_waiting_human"
  | "finding_not_needs_human"
  | "dangling_human_node";

/**
 * Canvas human 投影收口（#536）。
 *
 * waiting_human / Finding needs_human / 画布 human 节点是三条独立链路。
 * 只把无类型、无目标、无处理入口的 dangling open 节点标 expired。
 *
 * 保留：仍绑 waiting_human 的请求、仍为 needs_human 的 verification_blocker、
 * finding_comment、用户消息账本、以及 ignored / acknowledged / expired。
 */
export function classifyOpenHumanNodeExpiry(input: {
  status?: unknown;
  jobId?: string | null;
  body?: unknown;
  jobStatus?: string | null;
  findingVerifyStatus?: string | null;
}): HumanNodeExpireReason {
  const status = String(input.status ?? "open");
  if (status !== "open" && status !== "") return "keep";
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const kind = typeof body.kind === "string" ? body.kind : "";
  const resolution = typeof body.resolution === "string" ? body.resolution : "";
  if (resolution === "ignored" || resolution === "expired") return "keep";
  if (kind === "finding_comment") return "keep";
  if (typeof body.message_id === "string") return "keep";
  if (kind === "verification_blocker") {
    return input.findingVerifyStatus === "needs_human" ? "keep" : "finding_not_needs_human";
  }
  if (input.jobId) {
    return input.jobStatus === "waiting_human" ? "keep" : "job_not_waiting_human";
  }
  return "dangling_human_node";
}
