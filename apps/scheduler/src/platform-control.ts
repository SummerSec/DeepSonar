/**
 * Job 控制面常量。真实 Job 不注入控制 MCP；快照里若仍带同名 MCP，执行器只负责滤掉。
 * 语义事件名给 Platform API 摄入用。
 */
export const CONTROL_MCP_NAME = "deepsonar-control";
export const CONTROL_SEMANTIC_EVENT_TYPES = {
  emit_progress: "progress",
  emit_fact: "fact",
  emit_finding: "finding",
  submit_hub_decision: "hub_decision",
  mark_job_done: "done",
  request_human: "human",
  publish_shared_asset: "shared_asset_publish",
  ack_human_message: "human_message_ack",
} as const;
