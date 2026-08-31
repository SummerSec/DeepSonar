/** 调度器 API 类型与请求（vite proxy /api → :3100） */

import type {
  CanvasLifecycleRollup,
  CredentialBatchBindingImpact,
  CredentialBatchBindingRequest,
  EffectiveFindingProtocol,
  FindingProtocolConfig,
  ProviderAccountCatalogItem,
  PlatformToolConfig,
  ReadinessResponse,
  TaskExecutionControlResult,
  TaskExecutionState,
} from "@deepsonar/shared-types";

export type { ModuleSelectorKind, ParsedModuleSelector } from "@deepsonar/shared-types";
export type { EffectiveFindingProtocol, FindingProtocolConfig } from "@deepsonar/shared-types";

export type TaskKind = "standard" | "compose";

export interface DashboardStatusBucket {
  key: string;
  count: number;
}

export interface DashboardPeriodCounts {
  new_tasks: number;
  completed_tasks: number;
  new_findings: number;
}

export interface DashboardTrendDay extends DashboardPeriodCounts {
  date: string;
}

export interface DashboardActiveProject {
  id: string;
  name: string;
  status: "active" | "archived";
  active_jobs: number;
  task_count: number;
  finding_count: number;
  last_activity_at: string | null;
}

export interface DashboardActivityItem {
  id: string;
  kind: "task" | "job" | "finding";
  title: string;
  at: string;
  project_id: string;
  project_name: string;
  canvas_id: string | null;
  status?: string;
}

/** `GET /dashboard/overview` — P0 运营总览聚合，不受 Job/Finding 列表窗口截断。 */
export interface DashboardOverview {
  generated_at: string;
  calendar_timezone: string;
  totals: {
    projects: number;
    tasks: number;
    jobs: number;
    findings: number;
  };
  distributions: {
    projects: DashboardStatusBucket[];
    tasks: DashboardStatusBucket[];
    jobs: DashboardStatusBucket[];
    findings: DashboardStatusBucket[];
  };
  periods: {
    today: DashboardPeriodCounts;
    last_7d: DashboardPeriodCounts;
  };
  trend_7d: DashboardTrendDay[];
  active_projects: DashboardActiveProject[];
  recent_activity: DashboardActivityItem[];
}

export type UsagePeriod = "day" | "week" | "month" | "custom";

export interface UsageTokenTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  jobs: number;
  projects: number;
  tasks: number;
  settled: number;
  unknown: number;
  not_reported: number;
}

type UsageTokenCounts = Pick<
  UsageTokenTotals,
  "requests" | "input_tokens" | "output_tokens" | "total_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;

export interface DashboardUsage {
  generated_at: string;
  calendar_timezone: string;
  period: UsagePeriod;
  range: { start: string; end: string; days: string[] };
  totals: UsageTokenTotals;
  series: Array<UsageTokenCounts & { date: string }>;
  projects: Array<UsageTokenCounts & { id: string; name: string; jobs: number; tasks: number }>;
  tasks: Array<UsageTokenCounts & {
    canvas_id: string | null;
    title: string;
    project_id: string;
    project_name: string;
    jobs: number;
  }>;
  models: Array<UsageTokenCounts & { provider: string; model: string }>;
}

export interface Project {
  id: string;
  /** 可空：NULL = 纯本地项目（Plane 为可选绑定） */
  plane_project_id: string | null;
  canvas_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  active_jobs?: number;
  max_concurrent_jobs?: number;
  max_concurrent_jobs_source?: "project" | "global";
}

export interface SharedAsset {
  id: string;
  scope_type: "platform" | "project" | "finding";
  project_id: string | null;
  finding_id: string | null;
  logical_key: string;
  origin: "human" | "agent" | "system";
  immutable: boolean;
  labels_json: Record<string, string>;
  status: "active" | "archived" | "quarantined";
  current_version: number;
  version_id: string;
  version: number;
  content_sha256: string;
  bytes: number;
  content_type: string;
  created_by_job_id: string | null;
  created_at: string;
}

export interface SharedAssetPolicy {
  project_id: string;
  platform_enabled: boolean;
  revision: number;
  updated_at?: string;
}

export interface SharedAssetPage { items: SharedAsset[]; limit: number; offset: number }

export interface CanvasNode {
  id: string;
  node_type: "root" | "job" | "finding" | "note" | "human" | "intent" | "fact" | "report";
  title: string;
  body_json: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string | null;
  /** fact 节点的可信状态（独立于 status 执行状态）：unverified/verifying/verified/rejected/needs_human */
  verification_status: FactVerificationStatus | null;
  job_id: string | null;
  updated_at: string;
}

export interface CanvasEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: "child" | "produces" | "verifies" | "reviewed_by" | "tested_by" | "next" | "from" | "to";
}

export interface CanvasData {
  canvas?: CanvasLifecycle & {
    id: string;
    title: string;
    target_json: Record<string, unknown>;
    project_id?: string | null;
    change_revision?: string;
    change_floor_revision?: string;
  };
  canvas_id: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  convergence?: CanvasConvergence;
  /** Durable L0 projection revision returned by /summary. */
  revision?: string;
  floor_revision?: string;
}

export interface CanvasDelta {
  canvas_id: string;
  since: string;
  upper_revision: string;
  floor_revision: string;
  upsert_nodes: CanvasNode[];
  delete_node_ids: string[];
  upsert_edges: CanvasEdge[];
  delete_edge_ids: string[];
  upsert_meta: Array<{
    id: string;
    title?: string;
    target_json?: Record<string, unknown>;
    project_id?: string | null;
    status?: string;
    archived_at?: string | null;
  }>;
  /** Authoritative lifecycle rollup; null/zero values are meaningful. */
  active_count: CanvasLifecycleRollup["active_count"];
  execution_active_count?: number;
  pending_count?: number;
  execution_state?: TaskExecutionState;
  job_count: CanvasLifecycleRollup["job_count"];
  started_at: CanvasLifecycleRollup["started_at"];
  ended_at: CanvasLifecycleRollup["ended_at"];
  root_status: CanvasLifecycleRollup["root_status"];
  report_status: CanvasLifecycleRollup["report_status"];
  projection?: "L0_DELTA";
  live?: boolean;
}

export type CanvasBroadcastDeliveryStatus = "planned" | "injected" | "failed" | "unknown";

export interface CanvasBroadcastItem {
  id: string;
  source_job_id: string;
  source_node_id: string;
  source_node_type: "fact" | "finding";
  target_job_id: string;
  target_node_id: string | null;
  target_node_type: "intent" | "job" | "report" | null;
  target_node_title: string | null;
  target_role: string | null;
  target_role_kind: string | null;
  attempt: number;
  delivery_status: CanvasBroadcastDeliveryStatus;
  title: string;
  error: string | null;
  planned_at: string;
  delivered_at: string | null;
}

export interface CanvasBroadcastPage {
  canvas_id: string;
  items: CanvasBroadcastItem[];
  total: number;
  truncated: boolean;
}

export type CanvasHumanMessageStatus = "planned" | "injected" | "acknowledged" | "unknown" | "failed";

export interface CanvasHumanMessageAttachment {
  version_id: string;
  asset_id?: string;
  logical_key?: string;
  filename?: string;
  workspace_path?: string;
  content_sha256: string;
  bytes: number;
  content_type?: string;
}

/** Durable human-to-runtime ledger. `injected` is transport-only; only `acknowledged` is an Agent ACK. */
export interface CanvasHumanMessage {
  id: string;
  canvas_id: string;
  human_node_id: string;
  target_kind: "hub" | "job";
  target_node_id: string | null;
  target_job_id: string;
  body: string;
  attachments: CanvasHumanMessageAttachment[];
  status: CanvasHumanMessageStatus;
  delivery_status?: CanvasHumanMessageStatus;
  planned_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  ack_summary: string | null;
  error: string | null;
}

type CanvasHumanMessageWire = Omit<CanvasHumanMessage, "status"> & {
  status?: CanvasHumanMessageStatus;
  delivery_status?: CanvasHumanMessageStatus;
};

export interface CanvasHumanMessagePage {
  canvas_id: string;
  items: CanvasHumanMessage[];
  total: number;
  truncated: boolean;
}

export interface CreateCanvasHumanMessage {
  message_id: string;
  target: { kind: "hub" } | { kind: "job"; node_id: string };
  body: string;
  attachment_version_ids: string[];
}

/** Bounded keyset response shared by jobs, findings, events, and evidence. */
export interface PageEnvelope<T> {
  items: T[];
  after: string | null;
  next_cursor: string | null;
  has_more: boolean;
  watermark: string;
  live: boolean;
  truncated?: boolean;
  gap?: boolean;
}

export type FactVerificationStatus = "unverified" | "verifying" | "verified" | "rejected" | "needs_human";

export interface FactVerification {
  finding_id: string;
  evidence_kind: "review" | "test";
  outcome: "supports" | "refutes" | "inconclusive";
  subject_revision: string;
}

export interface FactSummary {
  id: string;
  canvas_id: string;
  title: string;
  description: string;
  verification_status: FactVerificationStatus;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  verification: FactVerification | null;
  finding: {
    id: string;
    node_id: string | null;
    title: string;
    severity: string | null;
    verify_status: string;
  } | null;
  job: {
    id: string;
    type: string;
    status: string;
  } | null;
}

export interface FactTraceNode {
  id: string;
  node_type: string;
  title: string;
  status: string | null;
  job_id: string | null;
}

export interface FactTraceEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
}

export interface FactDetail {
  fact: Omit<FactSummary, "finding" | "job"> & { body_json: Record<string, unknown> };
  finding: FactSummary["finding"];
  job: FactSummary["job"];
  trace: { nodes: FactTraceNode[]; edges: FactTraceEdge[] };
}

/** 任务画布的生命周期聚合（由调度器按 Job 时间戳计算）。 */
export type CanvasLifecycle = CanvasLifecycleRollup & {
  /** 画布创建时间，是任务生命周期的起点。 */
  created_at: string;
  /** 所有 Job 中第一个实际开始执行的时间；pending 尚未开始时为 null。 */
  started_at: string | null;
  /** 无活动 Job 后的最后完成时间；存在活动 Job 时始终为 null。 */
  ended_at: string | null;
  /** 活动 Job 数量（pending 也算活动工作）。 */
  active_count: number;
  /** Execution pause drain count; pending queue entries are projected separately. */
  execution_active_count: number;
  pending_count: number;
  execution_state: TaskExecutionState;
  /** 画布上累计 Job 数量。 */
  job_count: number;
  /** 当前根节点阶段（由 Scheduler 从画布投影中治理）。 */
  root_status: string | null;
  /** 当前报告节点阶段（由 Scheduler 从画布投影中治理）。 */
  report_status: string | null;
};

/** 任务画布列表项（一任务一画布；聚合最近一次 job 得任务状态） */
export type CanvasSummary = CanvasLifecycleRollup & {
  id: string;
  title: string;
  plane_issue_id: string | null;
  target_json: Record<string, unknown>;
  created_at: string;
  status: "active" | "archived";
  archived_at: string | null;
  /** 首个实际开始、终态结束与活动 Job 数量，均由服务端 rollup。 */
  started_at: string | null;
  ended_at: string | null;
  job_count: number;
  active_count: number;
  execution_active_count: number;
  pending_count: number;
  execution_state: TaskExecutionState;
  /** 当前根节点/报告阶段，避免列表从 last_job_status 推断任务终态。 */
  root_status: string | null;
  report_status: string | null;
  finding_count: number;
  confirmed_count: number;
  last_job_id: string | null;
  last_job_status: string | null;
  last_job_priority: number | null;
  last_job_at: string | null;
};

export interface JobEvent {
  id: string;
  job_seq: number;
  type: string;
  payload_json: Record<string, unknown>;
  created_at: string;
}

export interface ContextDiagnostics {
  context_id: string;
  context_revision: number;
  attempt_id: string | null;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  transform_chain_digest: string;
  transforms: Array<{
    stage: string;
    version: number;
    revision: number;
    input_digest: string;
    output_digest: string;
    budget: { unit: string; limit: number; observed: number | null } | null;
    omission: { kind: string; count: number | null; reason: string; truncated: boolean } | null;
    source: string;
  }>;
  compaction: {
    observation: "observed" | "unknown" | "unsupported";
    source: string;
    policy: string;
    reason: string | null;
    last_event_id: string | null;
  };
}

export interface JobAttemptSummary {
  id: string;
  attempt_no: number;
  status: string;
  phase: string;
  replay_policy: string;
  cancel_requested: boolean;
  sandbox_id: string | null;
  session_id: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEffectSummary {
  id: string;
  attempt_id: string;
  effect_id: string;
  effect_kind: string;
  status: "planned" | "effect_pending" | "settled" | "unknown";
  error: string | null;
  effect_started_at: string | null;
  settled_at: string | null;
}

export interface CanvasBroadcastSummary {
  id: string;
  effect_id: string;
  delivery_status: "planned" | "injected" | "failed" | "unknown";
  source_node_type: string;
  title: string;
  planned_at: string;
  delivered_at: string | null;
}

export interface JobUsageSummary {
  id: string;
  attempt_id?: string;
  effect_id: string;
  request_no: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  adjustment_tokens: number;
  settlement_status: "settled" | "unknown" | "not_reported";
  source?: string;
  observed_at: string;
}

export interface JobDetail {
  job: {
    id: string;
    type: string;
    status: string;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
    payload_json: Record<string, unknown>;
    agent_snapshot_json: Record<string, unknown>;
    /** 冻结的通用客户端上下文预算；Claude 仅展示。 */
    context_window_tokens?: number | null;
  };
  events: JobEvent[];
  findings: { id: string; severity: string; title: string; verify_status: string }[];
  attempts: JobAttemptSummary[];
  effects: JobEffectSummary[];
  broadcasts: CanvasBroadcastSummary[];
  usage: JobUsageSummary[];
  /** Structured module omissions copied from the frozen snapshot (old jobs: []). */
  missing_modules: unknown[];
  /** 结果页下发 prompt：冻结 dispatched_prompt，否则从 intent/画布目标回填。 */
  dispatched_prompt: string | null;
  /** 上下文生命周期的有界摘要；缺失表示旧 Job 尚未记录。 */
  context_diagnostics: ContextDiagnostics | null;
}

/** 全局 / 项目 Job 列表 */
export interface JobSummary {
  id: string;
  project_id: string;
  canvas_id: string | null;
  plane_issue_id: string | null;
  type: string;
  status: string;
  priority: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  project_name?: string;
  canvas_title?: string;
  /** 冻结快照：所用 Agent CLI（claude-code / open-code / codex…） */
  agent_cli?: string | null;
  /** 冻结快照：所用模型 ID */
  model?: string | null;
  /** 解析 CLI 别名后实际发送给上游的模型 ID；旧 Job 可能为空。 */
  upstream_model?: string | null;
  /** 冻结快照：角色名 */
  role_name?: string | null;
  /** 冻结快照：凭据 Provider */
  credential_provider?: string | null;
  /** 冻结快照：RoleConfig 版本号 */
  role_config_version?: number | null;
}

/** 人工处置态（验证完成后的业务闭环） */
export type FindingDisposition =
  | "open"
  | "accepted"
  | "human_reproducing"
  | "confirmed_vuln"
  | "rejected_fp"
  | "resolved"
  | "archived";

export interface ProjectFindingsSummary {
  project_id: string;
  total: number;
  project_total: number;
  list_window: number;
  truncated: boolean;
  severity: Array<{ key: string; count: number }>;
  verify_status: Array<{ key: string; count: number }>;
  disposition: Array<{ key: string; count: number }>;
  canvases: Array<{ id: string; title: string; count: number }>;
}

/** 发现清单 */
export interface FindingSummary {
  id: string;
  project_id: string;
  job_id: string;
  node_id: string | null;
  fingerprint: string;
  title: string;
  severity: string | null;
  profile: string;
  category: string | null;
  tags_json: string[];
  evidence_refs_json: string[];
  scoring_json: Record<string, unknown>;
  location: string | null;
  summary: string | null;
  verify_status: string;
  disposition?: FindingDisposition | string;
  disposition_note?: string | null;
  disposition_by?: string | null;
  disposition_at?: string | null;
  created_at: string;
  updated_at?: string;
  project_name?: string;
  canvas_id?: string | null;
  canvas_title?: string | null;
  has_waiting_human?: boolean;
}

export interface FindingComment {
  id: string;
  finding_id: string;
  body: string;
  author_type: string;
  author_id: string | null;
  author_name: string;
  created_at: string;
}

export interface FindingLink {
  id: string;
  finding_id: string;
  url: string;
  title: string;
  link_type: "related" | "ticket" | "pr" | "doc" | "evidence" | string;
  created_by: string | null;
  created_at: string;
}

/** Git 模块源（§8.2） */
export type SkillTrustStatus = "quarantined" | "trusted" | "disabled";

export interface SkillSource {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  synced_at: string | null;
  created_at: string;
  module_count?: number;
  trust_status?: SkillTrustStatus;
  enabled?: boolean;
  last_commit_sha?: string | null;
  last_content_hash?: string | null;
  synced_by?: string | null;
}

export interface SourceModuleEntry {
  id: string;
  kind: "skill" | "command";
  plugin: string;
  name: string;
  description: string;
  file_count?: number;
}

export interface SkillSourceDetail {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  synced_at: string | null;
  catalog_json: SourceModuleEntry[];
}

export interface EffectiveRules {
  /** 唯一策略：最低关注级别（high = critical+high 自动验/等Hub/停自驱） */
  minVerifySeverity: "critical" | "high" | "medium" | "low" | "info";
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  maxAutoRetries: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
  stallSec: number;
  jobTokenMaxRequests: number;
  provisionTimeoutSec: number;
  hubEnabled: boolean;
  maxHubRounds: number;
  maxIntentsPerDecision: number;
  allowEgress: boolean;
  /** Scheduler-wide hard caps. Persisted global rules are authoritative; env only bootstraps defaults. */
  maxGlobalJobs: number;
  maxJobsPerProject: number;
  /** Claim-time effective active-job cap for this project. */
  maxConcurrentJobs: number;
  maxConcurrentJobsSource: "project" | "global";
  /** Scheduler 全局 provisioning admission 上限，项目规则不得覆盖。 */
  maxConcurrentProvisioning: number;
  /** Provider 总并发；优先级高于 Credential / Model / Agent CLI。 */
  maxConcurrentByProvider: Record<string, number>;
  /** 全局按 Agent CLI 的并发配额；项目层只读继承。 */
  maxConcurrentByAgentCli: Record<string, number>;
}

export interface EvidenceFileMeta {
  name: string;
  path: string;
  kind: "main" | "subagent" | "vendor_export" | "stream" | "otlp";
  bytes: number;
  sha256: string | null;
  inflight?: boolean;
}

export interface JobEvidence {
  transcript_uri: string | null;
  manifest: {
    v: 1;
    job_id: string;
    cli: string;
    session_id: string | null;
    created_at: string;
    finalized_at: string | null;
    files: EvidenceFileMeta[];
    capture_error?: string;
    synthetic?: boolean;
    inflight?: boolean;
    truncated?: boolean;
  };
}

export interface StreamPage {
  items: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  after: string | null;
  next_cursor: string | null;
  has_more: boolean;
  watermark: string;
  live: boolean;
  truncated?: boolean;
  gap?: boolean;
}

export interface WsTicket {
  ticket: string;
  expires_at: string;
  job_id: string;
  purpose?: "stream" | "terminal";
}

export interface FindingDetail {
  finding: FindingSummary & {
    raw_json: Record<string, unknown>;
    suggest_verify: boolean;
    source_job_type: string;
    source_job_status: string;
    canvas_title?: string | null;
  };
  verification_jobs: Array<{
    id: string;
    type: string;
    status: string;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
  }>;
  source_events: JobEvent[];
  verification_rounds: FindingTraceRound[];
  trace: FindingTrace;
  comments?: FindingComment[];
  links?: FindingLink[];
}

export interface FindingTraceEvidence {
  node_id: string;
  job_id: string;
  job_type: string;
  job_status: string;
  outcome: string;
  title: string;
  at: string;
}

export interface FindingTraceRound {
  attempt: number;
  status: string;
  outcome: string | null;
  verify_job_id: string | null;
  missing: string[];
  summary: string | null;
  proposed_verdict: string | null;
  at: string;
  finished_at: string | null;
}

export interface FindingTrace {
  source: {
    job_id: string;
    job_type: string;
    job_status: string;
    node_id: string | null;
    job_node_id: string | null;
    canvas_id: string;
    at: string;
  };
  evidence: { review: FindingTraceEvidence[]; test: FindingTraceEvidence[] };
  rounds: FindingTraceRound[];
  intents: Array<{
    node_id: string;
    role: string;
    status: string | null;
    job_id: string;
    description: string;
    at: string;
  }>;
  hubs: Array<{
    job_id: string;
    node_id: string | null;
    trigger_kind: string;
    status: string;
    at: string;
    confidence: "exact";
  }>;
  flow: {
    nodes: Array<{
      node_id: string;
      node_type: string;
      title: string;
      status: string | null;
      job_id: string | null;
      role: string | null;
      at: string;
    }>;
    edges: Array<{
      edge_id: string;
      from_node_id: string;
      to_node_id: string;
      edge_type: string;
    }>;
  };
  gaps: string[];
  node_ids: string[];
  edge_ids: string[];
}

export interface CanvasConvergence {
  hub_paused: boolean;
  paused_reason?: string;
  paused_at?: string;
  auto_stopped: boolean;
  pending_confirmed_ids?: string[];
}

export interface ProjectSettings {
  rules: Record<string, unknown>;
  roles: { enabled: string[] | null };
  effective_rules: EffectiveRules;
  finding_protocol: FindingProtocolConfig | null;
  effective_finding_protocol: EffectiveFindingProtocol;
  image_strategy: ProjectImageStrategy;
  role_runtime_images: Record<string, string | null>;
  /** claimed / provisioning / running；waiting_human 不占调度额度。 */
  active_jobs: number;
}

export type ProjectImageStrategy = "inherit_global" | "project_managed";

/** 角色注册表条目（§8.3）：kind='role' = hub 可下发角色；kind='hub' = 唯一决策中枢；kind='system' = 系统角色（verify/report 等） */
export interface AgentRole {
  id: string;
  name: string;
  title: string;
  description: string;
  builtin: boolean;
  kind: "hub" | "system" | "role";
  ui_color: string | null;
}

/** 项目视角的角色启用状态。 */
export interface ProjectRole extends AgentRole {
  enabled: boolean;
  default_enabled: boolean;
}

export type RoleInput = {
  name: string;
  title: string;
  description: string;
};

/** 全局设置（所有配置落库：规则默认值 → global_settings 单例行） */
export interface GlobalSettings {
  rules: Record<string, unknown>;
  effective_rules: EffectiveRules;
  finding_protocol: FindingProtocolConfig | null;
  effective_finding_protocol: EffectiveFindingProtocol;
  active_by_agent_cli: Record<string, number>;
  active_by_provider: Record<string, number>;
}

export interface DataExportRow {
  id: string;
  project_id: string;
  preset: string;
  modules_json: string[];
  status: string;
  artifact_sha256?: string | null;
  artifact_size?: number | null;
  expires_at?: string | null;
  error?: string | null;
  error_code?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface DataImportRow {
  id: string;
  source_sha256: string;
  source_manifest_json?: Record<string, unknown> | null;
  target_project_id?: string | null;
  mode?: string | null;
  preview_json?: ImportPreview | null;
  status: string;
  error?: string | null;
  created_at: string;
}

export interface ImportPreview {
  compatible: boolean;
  kind?: "platform" | string;
  source: { project_name?: string; project_id?: string; app_version?: string };
  selected_modules: string[];
  counts: Record<string, number>;
  conflicts: { module: string; key: string; message: string }[];
  warnings: string[];
  credential_mappings_required: { source_id: string; name: string; provider: string }[];
  environment_keys_required?: string[];
}

/** 平台 API Token（§6.1）：列表永不返回哈希/明文；明文仅创建/轮换响应里出现一次 */
export interface ApiToken {
  id: string;
  name: string;
  subject_type: string;
  subject_id: string | null;
  project_id: string | null;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface CredentialModels {
  models: string[];
  source_url: string;
  fetched_at: string;
}

export interface CredentialImpact {
  credential_id: string;
  role_configs: { count: number; items: Array<Record<string, unknown>> };
  jobs: {
    pending_unclaimed: { count: number; items: Array<Record<string, unknown>> };
    active_frozen: { count: number; items: Array<Record<string, unknown>> };
    recoverable: { count: number; items: Array<Record<string, unknown>> };
    terminal_historical: { count: number; items: Array<Record<string, unknown>> };
  };
  scans: {
    active: { count: number; items: Array<Record<string, unknown>> };
  };
}

export type ProviderAccountCatalogItemView = ProviderAccountCatalogItem;
export type CredentialBatchBindingInput = CredentialBatchBindingRequest;
export type CredentialBatchBindingResult = CredentialBatchBindingImpact;

export interface BindableRoleConfig {
  id: string;
  role_id: string;
  role_name: string;
  role_title: string;
  /** hub | system | role — system = 调度内核系统角色 */
  role_kind?: "hub" | "system" | "role";
  role_builtin?: boolean;
  role_ui_color?: string | null;
  project_id: string | null;
  project_name: string | null;
  agent_cli: "claude-code" | "open-code" | "codex" | "pi" | "dsh";
  dsh_task_mode: "standard" | "ptc";
  model: string | null;
  context_window_tokens: number | null;
  scope: "global" | "project";
  /** 项目 RoleConfig 所属项目的镜像/模型继承策略；全局行为 null。 */
  image_strategy?: ProjectImageStrategy | null;
  /** null = 系统默认底座（deepsonar-base） */
  runtime_image_key: string | null;
  version: number;
  credential_id: string | null;
  credential_name: string | null;
  credential_kind: ProviderCredential["kind"] | null;
  credential_provider: string | null;
  credential_provider_valid: boolean | null;
  credential_status: string | null;
  credential_project_id: string | null;
  credential_project_name: string | null;
  /** Project-scoped actors may inspect global RoleConfigs but cannot mutate/bind them. */
  can_bind: boolean;
}

export interface ApiTokenCreated extends ApiToken {
  /** 仅此一次可见，请立即复制保存 */
  token: string;
  rotated_from?: string;
}

/** Provider Credential（§6.2）：永不返回密文，只有指纹/last4 */
export interface ProviderCredential {
  id: string;
  name: string;
  kind: "llm_provider" | "plane" | "git" | "oci_registry";
  provider: string;
  project_id: string | null;
  key_version: number;
  public_metadata_json: Record<string, unknown>;
  model_catalog_json?: string[];
  /** CC Switch-style profile: which CLI this settingsConfig targets. */
  agent_cli?: "claude-code" | "codex" | "open-code" | "pi" | "dsh" | null;
  /** CLI settingsConfig projection. Secret values are returned as [已保存密钥]. */
  settings_config_json?: Record<string, unknown>;
  /** Manager-only meta (apiFormat, fullUrl, …). */
  meta_json?: Record<string, unknown>;
  fingerprint: string;
  last4: string;
  status: "active" | "disabled" | "rotation_required";
  last_used_at: string | null;
  rotated_at: string | null;
  created_at: string;
  created_by: string | null;
  scope?: "global" | "project";
  provider_valid?: boolean;
  bound_role_config_count?: number;
  health?: {
    status: "unknown" | "ok" | "error";
    last_tested_at: string | null;
    error_category: string | null;
    detail: string | null;
    model_catalog: string[];
    model_catalog_fetched_at: string | null;
  };
  active_count: number;
  active_by_model: Record<string, number>;
}

export interface CredentialUpdateResponse extends ProviderCredential {
  impact?: {
    role_config_count: number;
    pending_job_count: number;
  };
}

export type RuntimeImageTrustStatus = "quarantined" | "scanning" | "trusted" | "disabled" | "rejected" | "revoked";

export interface RuntimeImageSummary {
  id: string;
  image_key: string;
  name: string;
  description: string;
  publisher: string;
  source_url: string | null;
  source_kind: "official" | "third_party";
  official: boolean;
  project_opt_in: boolean;
  enabled: boolean;
  project_enabled: boolean | null;
  selected_version_id: string | null;
  selected_version: string | null;
  selected_trust_status: RuntimeImageTrustStatus | null;
  pin_stale: boolean;
  pin_policy?: "follow" | "hold" | null;
  latest_version_id: string | null;
  latest_version: string | null;
  digest: string | null;
  resolved_ref: string | null;
  platforms_json: string[] | null;
  tools_json: Array<{ name: string; version: string; capabilities?: string[] }> | null;
  tools_manifest_sha256: string | null;
  trust_status: RuntimeImageTrustStatus | null;
  scan_summary_json: Record<string, unknown> | null;
  size_bytes: number | null;
  scanned_at: string | null;
  approved_at: string | null;
  promoted_at: string | null;
}

export interface RuntimeImageScan {
  id: string;
  status: "queued" | "claimed" | "running" | "succeeded" | "failed";
  worker_id: string | null;
  result_json: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RuntimeImageVersion {
  id: string;
  version: string;
  image_ref: string;
  resolved_ref: string | null;
  digest: string | null;
  contract_version: string;
  platforms_json: string[];
  tools_json: Array<{ name: string; version: string; capabilities?: string[] }>;
  tools_manifest_sha256: string | null;
  sbom_json: Record<string, unknown> | null;
  signature_json: Record<string, unknown> | null;
  scan_summary_json: Record<string, unknown>;
  size_bytes: number | null;
  trust_status: RuntimeImageTrustStatus;
  status_reason: string | null;
  scanned_at: string | null;
  approved_at: string | null;
  promoted_at: string | null;
  created_at: string;
  scans: RuntimeImageScan[];
}

export interface RuntimeImageDetail {
  image: RuntimeImageSummary;
  versions: RuntimeImageVersion[];
}

/** 本地 Docker 镜像检测结果；检测只返回候选，不改变市场信任状态。 */
export interface RuntimeImageLocalCandidate {
  exists: boolean;
  image_ref: string;
  image_id: string | null;
  repo_digests: string[];
  os: string | null;
  architecture: string | null;
  labels: Record<string, string>;
  contract_valid: boolean;
  product_match: boolean;
  adoptable: boolean;
  immutable_ref: string | null;
  reasons: string[];
  /** Optional diagnostics emitted by newer schedulers. */
  tool_manifest_valid?: boolean;
  error?: string | null;
  product_id?: string;
  product_key?: string;
}

export interface RuntimeImageLocalAdoptionResult {
  adopted?: boolean;
  local_only?: boolean;
  immutable_ref?: string;
  image: { id: string; image_key: string; official: boolean; enabled: boolean };
  version: RuntimeImageVersion;
  inspection?: RuntimeImageLocalCandidate;
}

export const RUNTIME_IMAGE_REGISTRY_CHANNELS = ["github", "dockerhub", "aliyun-acr"] as const;
export type RuntimeImageRegistryChannel = typeof RUNTIME_IMAGE_REGISTRY_CHANNELS[number];

export interface RuntimeImageRegistryVersion {
  version: string;
  /** Legacy/current reference retained for v1 catalogs. */
  image_ref?: string;
  digest?: string;
  platforms?: string[];
  size_bytes?: number;
  registry_refs?: Partial<Record<RuntimeImageRegistryChannel, string>>;
  tools_manifest_sha256?: string;
}

export interface RuntimeImageRegistry {
  schema: "deepsonar.registry/v1" | "deepsonar.registry/v2";
  schema_version?: 1 | 2;
  images: Array<{
    image_key: string;
    name: string;
    description: string;
    publisher: string;
    source_kind: "official";
    source_url?: string;
    project_opt_in: boolean;
    default_role?: string;
    versions: RuntimeImageRegistryVersion[];
  }>;
  /** 目录获取诊断；旧服务端没有这些字段时仍可正常渲染。 */
  metadata?: Record<string, unknown> | null;
  source?: "remote" | "bundled" | "upload" | string | { kind?: string; url?: string; fetched_at?: string; [key: string]: unknown } | null;
  fallback?: boolean;
  error?: string | null;
  checked_at?: string;
  selected_channel: RuntimeImageRegistryChannel;
}

export interface RuntimeImageRegistryChannelUpdate {
  selected_channel: RuntimeImageRegistryChannel;
  previous_channel: RuntimeImageRegistryChannel;
}

export interface RuntimeImagePreparingResponse {
  status: "preparing";
  saved: false;
  task: RuntimeImagePullTask;
  selected_channel?: RuntimeImageRegistryChannel;
  proposed_channel?: RuntimeImageRegistryChannel;
}

export type RuntimeImageRegistryCatalog = Omit<
  RuntimeImageRegistry,
  "metadata" | "fallback" | "error" | "checked_at" | "selected_channel"
>;

/** Project a GET response back to the strict catalog payload accepted by apply. */
export function runtimeImageRegistryCatalog(registry: RuntimeImageRegistry): RuntimeImageRegistryCatalog {
  const {
    metadata: _metadata,
    fallback: _fallback,
    error: _error,
    checked_at: _checkedAt,
    selected_channel: _selectedChannel,
    ...catalog
  } = registry;
  return catalog;
}

export function isSupportedRuntimeImageRegistryEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as { schema?: unknown; schema_version?: unknown };
  const schemaVersion = envelope.schema === "deepsonar.registry/v1"
    ? 1
    : envelope.schema === "deepsonar.registry/v2"
      ? 2
      : undefined;
  const numericVersion = envelope.schema_version === 1 || envelope.schema_version === 2
    ? envelope.schema_version
    : undefined;
  if (envelope.schema !== undefined && schemaVersion === undefined) return false;
  if (envelope.schema_version !== undefined && numericVersion === undefined) return false;
  if (schemaVersion === undefined && numericVersion === undefined) return false;
  return schemaVersion === undefined || numericVersion === undefined || schemaVersion === numericVersion;
}

export interface RuntimeImageCatalogSyncResult {
  /** Sync/apply responses return the catalog payload; read selected_channel from the GET response. */
  registry: Omit<RuntimeImageRegistry, "selected_channel">;
  product_count: number;
  version_count: number;
  synced_at: string;
  pin_rolls?: Array<{
    project_id: string;
    image_id: string;
    image_key: string;
    from_version_id: string;
    from_version: string | null;
    to_version_id: string;
    to_version: string | null;
  }>;
}

export interface RuntimeImagePullItem {
  image_key: string;
  image_ref: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
}

export interface RuntimeImagePullTask {
  task_id: string | null;
  purpose?: string;
  status: "idle" | "queued" | "running" | "succeeded" | "failed";
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  items: RuntimeImagePullItem[];
}

// ---------- 角色即配置（RoleConfig，migration 0017）：全局缺省 + 项目覆盖 ----------

/** RoleConfig 保存体（全量声明式：每次 PUT 整体替换 Credential 绑定与配置文件） */
/** Project-only numeric sandbox resource overrides. Capability flags are server-owned. */
export interface SandboxLimitsOverride {
  cpu?: number;
  memoryMiB?: number;
  pidsLimit?: number;
}

/** Role-level overlay for batch-1 runtime knobs. Null/omit inherits the next layer. */
export interface RuntimeKnobOverride {
  stallSec?: number | null;
  jobTokenMaxRequests?: number | null;
  timeoutSec?: number | null;
}

export type RoleConfigInput = {
  agent_cli: "claude-code" | "open-code" | "codex" | "pi" | "dsh";
  dsh_task_mode?: "standard" | "ptc";
  model?: string | null;
  /** 通用客户端上下文预算；不会提升上游模型能力。 */
  context_window_tokens?: number | null;
  /** 非敏感环境变量（疑似密钥名会被后端拒绝，引导改用 Credential） */
  env_keys: string[];
  env_vars: Record<string, string>;
  /** 原始模块 selector：source:module（兼容）/source:plugin:path/source:source:*。 */
  modules: string[];
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  subagents: Record<string, unknown>[];
  /** 本角色平台工具开关；未声明的合法工具默认启用。 */
  platform_tools: PlatformToolConfig;
  instructions_markdown?: string | null;
  /** 只能引用服务端可信镜像目录，不是任意 OCI 地址 */
  runtime_image_key?: string | null;
  /** Project-only CPU/memory/PID overrides; blank fields inherit server defaults. */
  sandbox_limits?: SandboxLimitsOverride | null;
  runtime_knobs?: RuntimeKnobOverride | null;
  credentials: { credential_id: string; purpose: string }[];
  /** Provider 配置文件：路径按 CLI 固定白名单（首期每角色最多 1 个） */
  config_files: { path: string; content: string }[];
};

/** RoleConfig 视图 = role_configs 行 + Credential 绑定 + 配置文件（含 sha256） */
export interface RoleConfigView {
  id: string;
  role_id: string;
  project_id: string | null;
  agent_cli: "claude-code" | "open-code" | "codex" | "pi" | "dsh";
  dsh_task_mode: "standard" | "ptc";
  model: string | null;
  context_window_tokens: number | null;
  env_keys: string[];
  env_vars_json: Record<string, string>;
  modules_json: string[];
  skills_json: Record<string, unknown>[];
  commands_json: Record<string, unknown>[];
  mcps_json: Record<string, unknown>[];
  subagents_json: Record<string, unknown>[];
  platform_tools_json: PlatformToolConfig;
  instructions_markdown: string | null;
  runtime_image_key: string | null;
  sandbox_limits_json: SandboxLimitsOverride;
  runtime_knobs_json?: RuntimeKnobOverride;
  version: number;
  created_at: string;
  updated_at: string;
  credentials: {
    credential_id: string;
    purpose: string;
    name: string;
    provider: string;
    status: string;
    project_id: string | null;
  }[];
  config_files: { path: string; content: string; content_sha256: string }[];
}

/** 全局缺省配置清单项（GET /role-configs/global 附带角色名/标题/kind） */
export interface GlobalRoleConfigEntry extends RoleConfigView {
  role_name: string;
  role_title: string;
  role_kind: "hub" | "system" | "role";
}

/** 项目视角的角色配置清单项（GET /projects/:id/role-configs） */
export interface ProjectRoleConfigEntry {
  role_id: string;
  name: string;
  title: string;
  kind: "hub" | "system" | "role";
  builtin: boolean;
  project_config_id: string | null;
  project_config_version: number | null;
  global_config_id: string | null;
  global_config_version: number | null;
  /** project=项目覆盖 / global=全局缺省 / none=未配置 */
  config_source: "project" | "global" | "none";
  /** 当前项目覆盖的实时完整配置；没有覆盖时为 null。 */
  project_config: RoleConfigView | null;
}

// ---------- 任务报告（migration 0017，§8） ----------

export interface TaskReport {
  id: string;
  canvas_id: string;
  project_id: string;
  version: number;
  report_job_id: string | null;
  status: "pending" | "generating" | "succeeded" | "failed";
  input_uri: string;
  input_sha256: string;
  /** 结构化摘要：confirmed / needs_human / 未自动验证分栏，SARIF 只含 confirmed */
  summary_json: {
    confirmed_count?: number;
    needs_human_count?: number;
    excluded_count?: number;
    findings_total?: number;
    confirmed_by_severity?: Record<string, number>;
    generated_at?: string;
  };
  markdown_uri: string | null;
  markdown_sha256: string | null;
  sarif_uri: string | null;
  sarif_sha256: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskReportAvailabilityReason =
  | "canvas_not_found"
  | "root_not_found"
  | "root_not_ready"
  | "active_work"
  | "no_role_work"
  | "findings_not_converged"
  | "report_not_dispatched";

export interface TaskReportBlockingFinding {
  finding_id: string;
  title: string;
  severity: string | null;
  verify_status: string;
  issue: string;
}

export interface TaskReportAvailability {
  reason: TaskReportAvailabilityReason;
  root_status: string | null;
  min_verify_severity: string | null;
  blockers: string[];
  blocking_findings: TaskReportBlockingFinding[];
}

export class TaskReportUnavailableError extends Error {
  readonly availability: TaskReportAvailability;

  constructor(availability: TaskReportAvailability) {
    super("任务报告尚未生成");
    this.name = "TaskReportUnavailableError";
    this.availability = availability;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface FindingReport {
  id: string;
  finding_id: string;
  canvas_id: string;
  project_id: string;
  version: number;
  report_job_id: string | null;
  status: "pending" | "generating" | "succeeded" | "failed";
  input_uri: string;
  input_sha256: string;
  summary_json: {
    finding_id?: string;
    fingerprint?: string;
    severity?: string;
    verification_attempts?: number;
    report_version?: number;
    frozen_at?: string;
    generated_at?: string;
  };
  markdown_uri: string | null;
  markdown_sha256: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: authHeaders() });
  if (!res.ok) {
    let detail = "";
    try {
      const err = (await res.json()) as { error?: string; message?: string; error_code?: string };
      detail = [err.error_code, err.error ?? err.message].filter(Boolean).join(": ");
    } catch {
      /* ignore non-JSON error body */
    }
    throw new Error(detail ? `${path} -> ${res.status}: ${detail}` : `${path} -> ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function getTaskReport(path: string): Promise<TaskReport> {
  const res = await fetch(`/api${path}`, { headers: authHeaders() });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* 忽略非 JSON 错误响应 */
    }
    if (res.status === 404) {
      try {
        const availability = await get<TaskReportAvailability>(`${path}/availability`);
        throw new TaskReportUnavailableError(availability);
      } catch (availabilityError) {
        if (availabilityError instanceof TaskReportUnavailableError) throw availabilityError;
        if (
          body &&
          typeof body === "object" &&
          "reason" in body &&
          "blocking_findings" in body &&
          Array.isArray((body as { blocking_findings?: unknown }).blocking_findings)
        ) {
          throw new TaskReportUnavailableError(body as TaskReportAvailability);
        }
      }
    }
    const err = body as { error?: string; message?: string; error_code?: string } | undefined;
    const detail = [err?.error_code, err?.error ?? err?.message].filter(Boolean).join(": ");
    throw new Error(detail ? `${path} -> ${res.status}: ${detail}` : `${path} -> ${res.status}`);
  }
  return res.json() as Promise<TaskReport>;
}

async function uploadSharedAsset(path: string, file: File, key: string, labels: Record<string, string> = {}): Promise<SharedAsset> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    "content-type": "application/octet-stream",
    "x-asset-key": key,
  };
  if (file.type) headers["x-asset-content-type"] = file.type;
  if (Object.keys(labels).length) headers["x-asset-labels"] = JSON.stringify(labels);
  const res = await fetch(`/api${path}`, { method: "POST", headers, body: file });
  if (!res.ok) throw new Error(await responseErrorDetail(res));
  return res.json() as Promise<SharedAsset>;
}

/**
 * Keep browser downloads on the same authenticated fetch path as every other
 * API request.  Native links cannot attach the Bearer token kept in
 * localStorage, and would also happily save a JSON 401/403 response as a
 * report file.
 */
export function safeDownloadFilename(candidate: string | null | undefined, fallback: string): string {
  const value = candidate?.trim() ?? "";
  if (!value || value === "." || value === ".." || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(value)) return fallback;
  // Strip bidi controls and keep the resulting name bounded before handing it
  // to the browser's download attribute.
  const clean = value.replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return clean && clean !== "." && clean !== ".." ? clean.slice(0, 240) : fallback;
}

/** Parse RFC 6266 filename / filename* without allowing path traversal. */
export function parseContentDispositionFilename(disposition: string, fallback: string): string {
  const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]*)/i)?.[1];
  if (encoded) {
    try {
      return safeDownloadFilename(decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")), fallback);
    } catch {
      return fallback;
    }
  }
  const quoted = disposition.match(/(?:^|;)\s*filename\s*=\s*"([^"]*)"/i)?.[1];
  const unquoted = disposition.match(/(?:^|;)\s*filename\s*=\s*([^;\s]+)/i)?.[1];
  return safeDownloadFilename(quoted ?? unquoted, fallback);
}

async function responseErrorDetail(res: Response): Promise<string> {
  let detail = "";
  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("json")) {
      const body = (await res.json()) as { error?: string; message?: string; error_code?: string };
      detail = [body.error_code, body.error ?? body.message].filter(Boolean).join(": ");
    } else {
      detail = (await res.text()).trim();
    }
  } catch {
    // Some proxies return an empty or malformed body for auth failures.
  }
  if (res.status === 401) return detail ? `登录已失效或未登录：${detail}` : "登录已失效或未登录，请重新登录后再下载";
  if (res.status === 403) return detail ? `当前账号无权下载该报告：${detail}` : "当前账号无权下载该报告";
  return detail || `下载请求失败（HTTP ${res.status}）`;
}

/** Fetch an authenticated binary and trigger a local browser download. */
export async function downloadAuthenticatedFile(path: string, fallbackFilename: string): Promise<void> {
  const safeFallback = safeDownloadFilename(fallbackFilename, "download");
  const res = await fetch(`/api${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await responseErrorDetail(res));
  const blob = await res.blob();
  const filename = parseContentDispositionFilename(res.headers.get("content-disposition") ?? "", safeFallback);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body?.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Let the browser start the navigation before releasing the object URL;
    // revoking synchronously can cancel downloads in Chromium/WebKit.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

/**
 * 浏览器侧鉴权材料（DEEPSONAR_AUTH_REQUIRED 时 Web 调 API 用）。
 * 用户会话与平台 API Token 分 key 存放，避免设置页把会话 secret 当成「可编辑本机令牌」摊开。
 * 请求优先级：会话 token > API Token。
 */
const LEGACY_TOKEN_KEY = "deepsonar_token";
const SESSION_TOKEN_KEY = "deepsonar_session";
const API_TOKEN_KEY = "deepsonar_api_token";

/** 用户会话明文形如 deepsonar_user_<env>_<prefix>_<secret> */
export function isUserSessionToken(token: string): boolean {
  return token.startsWith("deepsonar_user_");
}

function migrateLegacyTokenKeys(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (!legacy) return;
    const hasSession = Boolean(localStorage.getItem(SESSION_TOKEN_KEY));
    const hasApi = Boolean(localStorage.getItem(API_TOKEN_KEY));
    if (!hasSession && !hasApi) {
      if (isUserSessionToken(legacy)) localStorage.setItem(SESSION_TOKEN_KEY, legacy);
      else localStorage.setItem(API_TOKEN_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* private mode / SSR */
  }
}

export function getSessionToken(): string {
  migrateLegacyTokenKeys();
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSessionToken(token: string): void {
  migrateLegacyTokenKeys();
  try {
    if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
    else localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function getApiAccessToken(): string {
  migrateLegacyTokenKeys();
  try {
    return localStorage.getItem(API_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiAccessToken(token: string): void {
  migrateLegacyTokenKeys();
  try {
    if (token) localStorage.setItem(API_TOKEN_KEY, token);
    else localStorage.removeItem(API_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 当前请求实际使用的 Bearer（会话优先） */
export function getLocalToken(): string {
  return getSessionToken() || getApiAccessToken();
}

/**
 * 写入鉴权材料：空串清空两者；用户会话 / API Token 按格式分流。
 * 粘贴 API Token 时会清掉会话，避免「会话优先」导致新 Token 不生效。
 */
export function setLocalToken(token: string): void {
  if (!token) {
    setSessionToken("");
    setApiAccessToken("");
    return;
  }
  if (isUserSessionToken(token)) {
    setSessionToken(token);
  } else {
    setSessionToken("");
    setApiAccessToken(token);
  }
}

/** 展示用：保留前缀，遮住 secret（不用于鉴权） */
export function maskTokenForDisplay(token: string): string {
  if (!token) return "";
  const m = token.match(/^(deepsonar_(?:user_)?[a-z0-9]+_[0-9a-f]{8})_([A-Za-z0-9_-]+)$/i);
  if (m) return `${m[1]}_${"•".repeat(Math.min(12, m[2].length))}`;
  if (token.length <= 16) return "•".repeat(token.length);
  return `${token.slice(0, 12)}${"•".repeat(8)}…`;
}

function authHeaders(): Record<string, string> {
  const t = getLocalToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface AuthStatus {
  auth_required: boolean;
  has_users: boolean;
  bootstrap_available: boolean;
  default_admin_credentials_active: boolean;
  session_ttl_days: number;
}

export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "operator" | "viewer";
  status: "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
}

export interface AuthMe {
  auth_required: boolean;
  authenticated: boolean;
  actor: {
    type: string;
    name: string;
    role: string | null;
    project_id?: string | null;
    scopes: string[];
  } | null;
  user: PublicUser | null;
}

export interface LoginResult {
  user: PublicUser;
  token: string;
  expires_at: string;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 无 body 时不要带 application/json，否则 Fastify 会因空 JSON body 直接 400
  // （FST_ERR_CTP_EMPTY_JSON_BODY）—— 凭据测试/同步/取消/归档等无参 POST 都会踩中
  const headers: Record<string, string> = { ...authHeaders() };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  if (!res.ok) {
    let detail = "";
    try {
      const err = (await res.json()) as { error?: string; message?: string; error_code?: string };
      detail = [err.error_code, err.error ?? err.message].filter(Boolean).join(": ");
    } catch {
      /* ignore non-JSON error body */
    }
    throw new Error(
      detail
        ? `${method} ${path} -> ${res.status}: ${detail}`
        : `${method} ${path} -> ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

function qs(params: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function unwrapPage<T>(payload: T[] | PageEnvelope<T>): T[] {
  return Array.isArray(payload) ? payload : payload.items;
}

export const api = {
  dashboardOverview: () => get<DashboardOverview>("/dashboard/overview"),
  dashboardUsage: (query: {
    period?: UsagePeriod;
    from?: string;
    to?: string;
    project_id?: string;
    canvas_id?: string;
  } = {}) => get<DashboardUsage>(`/dashboard/usage${qs({
    period: query.period,
    from: query.from,
    to: query.to,
    project_id: query.project_id,
    canvas_id: query.canvas_id,
  })}`),
  projects: () => get<Project[]>("/projects"),
  createProject: (p: { name: string; description?: string; plane_project_id?: string | null; image_strategy?: ProjectImageStrategy }) =>
    send<Project>("POST", "/projects", p),
  updateProject: (id: string, p: { name?: string; description?: string; status?: "active" | "archived" }) =>
    send<Project>("PATCH", `/projects/${id}`, p),
  archiveProject: (id: string) =>
    send<{ id: string; status: string }>("POST", `/projects/${id}/archive`),
  /** 就地更新任务标题与内容；不改写已冻结 Job 快照 */
  updateTask: (
    canvasId: string,
    t: { title?: string; content?: string },
  ) =>
    send<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      archived_at: string | null;
      target_json: Record<string, unknown>;
      has_active_jobs: boolean;
      snapshot_rewritten: false;
      message: string;
    }>("PATCH", `/tasks/${canvasId}`, t),
  /** 语义化任务创建（同事务建画布 + root + pending job） */
  createTask: (
    projectId: string,
    t: {
      title: string;
      content: string;
      /** 省略则继承项目设置；服务端在任务创建时冻结。 */
      allow_egress?: boolean;
      finding_protocol?: FindingProtocolConfig;
      kind?: TaskKind;
      seed_finding_ids?: string[];
      /** ISO-8601；到点前不领取 Job。与 schedule_beijing_8am 同时给出时本字段优先。 */
      scheduled_start_at?: string;
      /** 下一北京时间 08:00（Asia/Shanghai）开始。 */
      schedule_beijing_8am?: boolean;
    },
  ) =>
    send<{ canvas_id: string; job: { id: string; status: string }; scheduled_start_at?: string | null }>(
      "POST",
      `/projects/${projectId}/tasks`,
      t,
    ),
  /** 任务创建前的 Scheduler 权威就绪检查；网络覆盖只作用于本次任务。 */
  readiness: (projectId: string, opts?: { allow_egress?: boolean; material_source?: string }) =>
    get<ReadinessResponse>(
      `/projects/${projectId}/readiness${qs({
        allow_egress: opts?.allow_egress === undefined ? undefined : String(opts.allow_egress),
        material_source: opts?.material_source,
      })}`,
    ),
  /** 继续执行：默认旧冻结快照；身份漂移时服务端返回 SNAPSHOT_STALE */
  resumeTaskSession: (canvasId: string) =>
    send<{
      canvas_id: string;
      action: "already_running" | "rerun_interrupted_jobs" | "resume_job" | "wake_hub" | "start_now";
      jobs?: Array<{ id: string; type: string; status: string }>;
      job?: { id: string; status: string } | null;
      effects_replayed?: boolean;
      message?: string;
    }>("POST", `/tasks/${canvasId}/resume-session`),
  /** Drain-pause: block future claim while current work safely finishes. */
  pauseTask: (canvasId: string) =>
    send<TaskExecutionControlResult>("POST", `/tasks/${canvasId}/pause`),
  /** Clear only the execution pause gate; schedules and failed/orphan Jobs are untouched. */
  startTask: (canvasId: string) =>
    send<TaskExecutionControlResult>("POST", `/tasks/${canvasId}/start`),
  /** 重试任务：清空本画布历史后从意图重新执行 */
  retryTask: (canvasId: string) => send<{ id: string; status: string }>("POST", `/tasks/${canvasId}/retry`),
  /** 归档任务（软删除，历史保留） */
  archiveTask: (canvasId: string) =>
    send<{ id: string; status: string; archived_at: string | null; cancelled_jobs: number }>(
      "POST",
      `/tasks/${canvasId}/archive`,
    ),
  /** 取消归档 */
  unarchiveTask: (canvasId: string) =>
    send<{ id: string; status: string; archived_at: string | null }>(
      "POST",
      `/tasks/${canvasId}/unarchive`,
    ),
  /** 硬删除任务及全部运行数据（不可恢复） */
  deleteTask: (canvasId: string) =>
    send<{ ok: boolean; id: string; deleted: boolean; cancelled_jobs: number }>(
      "DELETE",
      `/tasks/${canvasId}`,
    ),
  setJobPriority: (jobId: string, priority: number) =>
    send<{ id: string; status: string; priority: number }>("PATCH", `/jobs/${jobId}/priority`, { priority }),
  /** Plane 集成（按项目绑定；解绑不删已导入任务） */
  bindPlane: (projectId: string, planeProjectId: string) =>
    send<Project>("PUT", `/projects/${projectId}/integrations/plane`, { plane_project_id: planeProjectId }),
  unbindPlane: (projectId: string) =>
    send<Project>("DELETE", `/projects/${projectId}/integrations/plane`),
  syncPlane: (projectId: string) =>
    send<{ ok: boolean; created: number }>("POST", `/projects/${projectId}/integrations/plane/sync`),
  /** Plane 连接信息（任务页下发指引；不含 token） */
  planeInfo: () =>
    get<{ enabled: boolean; web_url: string; workspace_slug: string; ready_state: string }>(
      "/plane-info",
    ),
  canvases: (projectId: string, opts?: { status?: "active" | "archived" | "all" }) =>
    get<CanvasSummary[]>(
      `/projects/${projectId}/canvases${opts?.status ? `?status=${opts.status}` : ""}`,
    ),
  canvas: (canvasId: string) => get<CanvasData>(`/canvases/${canvasId}`),
  /** L0 graph projection; node body_json is a bounded summary. */
  canvasSummary: (canvasId: string) => get<CanvasData & { projection?: "L0"; watermark?: string; live?: boolean }>(`/canvases/${canvasId}/summary`),
  canvasDelta: (canvasId: string, since: string) =>
    get<CanvasDelta>(`/canvases/${canvasId}/delta?since=${encodeURIComponent(since)}`),
  canvasBroadcasts: (canvasId: string, limit = 500) =>
    get<CanvasBroadcastPage>(
      `/canvases/${canvasId}/broadcasts${qs({ limit: String(Math.min(1_000, Math.max(1, Math.trunc(limit)))) })}`,
    ),
  canvasMessages: async (canvasId: string, limit = 100) => {
    const page = await get<Omit<CanvasHumanMessagePage, "items"> & { items: CanvasHumanMessageWire[] }>(
      `/canvases/${canvasId}/messages${qs({ limit: String(Math.min(500, Math.max(1, Math.trunc(limit)))) })}`,
    );
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        // The database field is delivery_status. Keep the UI contract on one status key.
        status: item.status ?? item.delivery_status ?? "unknown",
        attachments: Array.isArray(item.attachments) ? item.attachments : [],
      })),
    };
  },
  createCanvasMessage: async (canvasId: string, message: CreateCanvasHumanMessage) => {
    const created = await send<CanvasHumanMessageWire>("POST", `/canvases/${canvasId}/messages`, message);
    return {
      ...created,
      status: created.status ?? created.delivery_status ?? "unknown",
      attachments: Array.isArray(created.attachments) ? created.attachments : [],
    };
  },
  ignoreHumanIntervention: (canvasId: string, nodeId: string) =>
    send<{
      node_id: string;
      status: "ignored";
      job_id: string | null;
      job_resumed: boolean;
      already_ignored: boolean;
    }>("POST", `/canvases/${canvasId}/human-nodes/${nodeId}/ignore`),
  canvasNode: (canvasId: string, nodeId: string) =>
    get<{ node: CanvasNode; projection: "L1" }>(`/canvases/${canvasId}/nodes/${nodeId}`),
  factsPage: (
    canvasId: string,
    opts?: {
      verification_status?: readonly FactVerificationStatus[];
      evidence_kind?: readonly FactVerification["evidence_kind"][];
      finding_id?: readonly string[];
      job_id?: readonly string[];
      after?: string | null;
      limit?: number;
    },
  ) => get<PageEnvelope<FactSummary>>(
    `/canvases/${canvasId}/facts${qs({
      verification_status: opts?.verification_status?.join(","),
      evidence_kind: opts?.evidence_kind?.join(","),
      finding_id: opts?.finding_id?.join(","),
      job_id: opts?.job_id?.join(","),
      after: opts?.after,
      limit: opts?.limit ? String(opts.limit) : undefined,
    })}`,
  ),
  fact: (canvasId: string, nodeId: string) =>
    get<FactDetail>(`/canvases/${canvasId}/facts/${nodeId}`),
  setFactVerification: (
    canvasId: string,
    nodeId: string,
    status: "verified" | "rejected" | "needs_human",
    note?: string,
  ) => send<{ fact: FactSummary }>(
    "PATCH",
    `/canvases/${canvasId}/facts/${nodeId}/verification`,
    { status, note },
  ),
  canvasConvergence: (canvasId: string) =>
    get<{
      canvas_id: string;
      convergence: CanvasConvergence;
      minVerifySeverity: string;
      careSeverities: string[];
    }>(`/canvases/${canvasId}/convergence`),
  pauseCanvasDecision: (canvasId: string, reason?: string) =>
    send<{ canvas_id: string; convergence: CanvasConvergence }>(
      "POST",
      `/canvases/${canvasId}/convergence/pause`,
      { reason },
    ),
  resumeCanvasDecision: (canvasId: string, force_hub?: boolean) =>
    send<{ canvas_id: string; convergence: CanvasConvergence; hub_triggered: boolean }>(
      "POST",
      `/canvases/${canvasId}/convergence/resume`,
      { force_hub },
    ),
  stopCanvasAfterGate: (canvasId: string) =>
    send<{ canvas_id: string; convergence: CanvasConvergence }>(
      "POST",
      `/canvases/${canvasId}/convergence/stop-after-gate`,
    ),
  drainCanvasPriority: (canvasId: string) =>
    send<{ canvas_id: string; cancelled: number; hubWaitSeverities: string[] }>(
      "POST",
      `/canvases/${canvasId}/convergence/drain-priority`,
    ),
  runCanvasHubNow: (canvasId: string) =>
    send<{ canvas_id: string; ok: boolean; convergence: CanvasConvergence }>(
      "POST",
      `/canvases/${canvasId}/convergence/run-hub-now`,
    ),
  job: (jobId: string) => get<JobDetail>(`/jobs/${jobId}`),
  jobEvidence: (jobId: string) => get<JobEvidence>(`/jobs/${jobId}/evidence`),
  jobStreamPage: (jobId: string, opts?: { after?: string | null; limit?: number; tail?: boolean }) =>
    get<StreamPage>(`/jobs/${jobId}/evidence/stream${qs({ after: opts?.after, limit: opts?.limit ? String(opts.limit) : undefined, tail: opts?.tail ? "1" : undefined })}`),
  jobStream: async (jobId: string) => {
    const page = await get<StreamPage>(`/jobs/${jobId}/evidence/stream${qs({ limit: "50" })}`);
    return { events: page.items, ...page };
  },
  jobEventsPage: (jobId: string, opts?: { after?: string | null; limit?: number }) =>
    get<PageEnvelope<JobEvent>>(`/jobs/${jobId}/events${qs({ after: opts?.after, limit: opts?.limit ? String(opts.limit) : undefined })}`),
  jobSession: (jobId: string) => get<{ meta: EvidenceFileMeta; text: string; truncated: boolean }>(`/jobs/${jobId}/evidence/session`),
  downloadJobSession: async (jobId: string): Promise<void> => {
    await downloadAuthenticatedFile(
      `/jobs/${encodeURIComponent(jobId)}/evidence/session/download`,
      safeDownloadFilename(`${jobId}.jsonl`, "session.jsonl"),
    );
  },
  jobsPage: (opts?: { project_id?: string; canvas_id?: string; status?: string; after?: string | null; limit?: number }) =>
    get<PageEnvelope<JobSummary>>(`/jobs${qs({ project_id: opts?.project_id, canvas_id: opts?.canvas_id, status: opts?.status, after: opts?.after, limit: opts?.limit ? String(opts.limit) : undefined })}`),
  jobs: async (opts?: { project_id?: string; canvas_id?: string; status?: string }) =>
    unwrapPage(await get<JobSummary[] | PageEnvelope<JobSummary>>(`/jobs${qs({ project_id: opts?.project_id, canvas_id: opts?.canvas_id, status: opts?.status })}`)),
  findingsPage: (opts?: {
    project_id?: string;
    severity?: string;
    profile?: string;
    category?: string;
    verify_status?: string;
    disposition?: string;
    /** 只拉某任务画布的发现，不混其它任务 */
    canvas_id?: string;
    after?: string | null;
    limit?: number;
  }) => get<PageEnvelope<FindingSummary>>(
      `/findings${qs({
        project_id: opts?.project_id,
        severity: opts?.severity,
        profile: opts?.profile,
        category: opts?.category,
        verify_status: opts?.verify_status,
        disposition: opts?.disposition,
        canvas_id: opts?.canvas_id,
        after: opts?.after,
        limit: opts?.limit ? String(opts.limit) : undefined,
      })}`,
    ),
  findings: async (opts?: {
    project_id?: string;
    severity?: string;
    profile?: string;
    category?: string;
    verify_status?: string;
    disposition?: string;
    canvas_id?: string;
  }) => unwrapPage(await get<FindingSummary[] | PageEnvelope<FindingSummary>>(`/findings${qs({
    project_id: opts?.project_id,
    severity: opts?.severity,
    profile: opts?.profile,
    category: opts?.category,
    verify_status: opts?.verify_status,
    disposition: opts?.disposition,
    canvas_id: opts?.canvas_id,
  })}`)),
  projectFindingsSummary: (projectId: string, opts?: { canvas_id?: string }) =>
    get<ProjectFindingsSummary>(`/projects/${projectId}/findings/summary${qs({ canvas_id: opts?.canvas_id })}`),
  finding: (id: string) => get<FindingDetail>(`/findings/${id}`),
  projectSharedAssets: (projectId: string, page: { limit?: number; offset?: number } = {}) =>
    get<SharedAssetPage>(`/projects/${projectId}/shared-assets${qs({ limit: page.limit?.toString(), offset: page.offset?.toString() })}`),
  findingSharedAssets: (findingId: string, page: { limit?: number; offset?: number } = {}) =>
    get<SharedAssetPage>(`/findings/${findingId}/shared-assets${qs({ limit: page.limit?.toString(), offset: page.offset?.toString() })}`),
  platformSharedAssets: (page: { limit?: number; offset?: number } = {}) =>
    get<SharedAssetPage>(`/platform/shared-assets${qs({ limit: page.limit?.toString(), offset: page.offset?.toString() })}`),
  sharedAssetPolicy: (projectId: string) => get<SharedAssetPolicy>(`/projects/${projectId}/shared-assets/policy`),
  updateSharedAssetPolicy: (projectId: string, platform_enabled: boolean) =>
    send<SharedAssetPolicy>("PATCH", `/projects/${projectId}/shared-assets/policy`, { platform_enabled }),
  uploadProjectSharedAsset: (projectId: string, file: File, key: string, labels?: Record<string, string>) =>
    uploadSharedAsset(`/projects/${projectId}/shared-assets`, file, key, labels),
  uploadFindingSharedAsset: (findingId: string, file: File, key: string, labels?: Record<string, string>) =>
    uploadSharedAsset(`/findings/${findingId}/shared-assets`, file, key, labels),
  uploadPlatformSharedAsset: (file: File, key: string, labels?: Record<string, string>) =>
    uploadSharedAsset("/platform/shared-assets", file, key, labels),
  archiveSharedAsset: (id: string) => send<SharedAsset>("POST", `/shared-assets/${id}/archive`),
  downloadSharedAsset: (asset: SharedAsset) =>
    downloadAuthenticatedFile(`/shared-assets/${asset.id}/content`, safeDownloadFilename(asset.logical_key.split("/").at(-1), "asset")),
  findingReport: (id: string) => get<FindingReport>(`/findings/${id}/report`),
  createFindingReport: (id: string) =>
    send<{ dispatched: boolean; reason?: string; report_id?: string; job_id?: string; version?: number }>(
      "POST",
      `/findings/${id}/report`,
    ),
  setFindingDisposition: (
    id: string,
    body: { disposition: FindingDisposition; note?: string },
  ) => send<FindingSummary>("PATCH", `/findings/${id}/disposition`, body),
  setFindingNeedsHuman: (id: string, body?: { verify_status: "needs_human"; reason?: string }) =>
    send<FindingSummary>("PATCH", `/findings/${id}/verify-status`, body ?? { verify_status: "needs_human" }),
  forceFindingVerify: (id: string, body?: { reason?: string }) =>
    send<{
      finding_id: string;
      verify_job_id: string;
      round_id: string;
      attempt: number;
      resumed_job_id: string | null;
    }>("POST", `/findings/${id}/verify`, body ?? {}),
  createFindingEvidenceJob: (id: string, role: "review" | "test") =>
    send<{
      finding_id: string;
      job_id: string;
      role: "review" | "test";
      resumed_job_id: string | null;
    }>("POST", `/findings/${id}/evidence-jobs`, { role }),
  addFindingComment: (id: string, body: string, request_hub = true) =>
    send<
      FindingComment & {
        hub?: { hub_queued: boolean; reason?: string; canvas_id?: string; hub_job_id?: string };
      }
    >("POST", `/findings/${id}/comments`, { body, request_hub }),
  deleteFindingComment: (id: string, commentId: string) =>
    send<{ ok: boolean }>("DELETE", `/findings/${id}/comments/${commentId}`),
  addFindingLink: (
    id: string,
    body: { url: string; title?: string; link_type?: FindingLink["link_type"] },
  ) => send<FindingLink>("POST", `/findings/${id}/links`, body),
  deleteFindingLink: (id: string, linkId: string) =>
    send<{ ok: boolean }>("DELETE", `/findings/${id}/links/${linkId}`),
  cancelJob: (id: string, opts?: { force?: boolean; reason?: string }) =>
    send<{ id: string; status: string; force?: boolean; reason?: string }>(
      "POST",
      `/jobs/${id}/cancel`,
      opts ?? {},
    ),
  /** 强制退出画布上全部活动 Job */
  cancelCanvasActiveJobs: (canvasId: string, reason?: string) =>
    send<{ canvas_id: string; cancelled: number; reason: string }>(
      "POST",
      `/canvases/${canvasId}/jobs/cancel-active`,
      reason ? { reason } : {},
    ),
  /** 同 Job、新 Attempt，严格使用旧冻结快照；身份漂移时 409 SNAPSHOT_STALE。 */
  resumeJob: (id: string) =>
    send<{ id: string; status: string; execution: "frozen_snapshot"; snapshot_refreshed: false }>(
      "POST",
      `/jobs/${id}/resume`,
    ),
  /** 同 Job、新 Attempt，按当前 RoleConfig/Credential/项目策略完整重冻快照。 */
  rerunJobCurrent: (id: string) =>
    send<{ id: string; status: string; execution: "current_snapshot"; snapshot_refreshed: true }>(
      "POST",
      `/jobs/${id}/rerun-current`,
    ),
  settings: (projectId: string) => get<ProjectSettings>(`/projects/${projectId}/settings`),
  patchSettings: (
    projectId: string,
    body: {
      rules?: Record<string, unknown>;
      roles?: { enabled: string[] | null };
      finding_protocol?: FindingProtocolConfig | null;
      image_strategy?: ProjectImageStrategy;
      role_runtime_images?: Record<string, string | null>;
    },
  ) => send<ProjectSettings | RuntimeImagePreparingResponse>("PATCH", `/projects/${projectId}/settings`, body),
  agentRoles: () => get<AgentRole[]>("/agent-roles"),
  createRole: (r: RoleInput) => send<AgentRole>("POST", "/agent-roles", r),
  updateRole: (id: string, r: Partial<Omit<RoleInput, "name">>) =>
    send<AgentRole>("PATCH", `/agent-roles/${id}`, r),
  deleteRole: (id: string) => send<{ ok: boolean }>("DELETE", `/agent-roles/${id}`),
  /** 角色即配置（§4.2）：全局缺省 / 项目覆盖，全量声明式 PUT */
  globalRoleConfigs: () => get<GlobalRoleConfigEntry[]>("/role-configs/global"),
  putGlobalRoleConfig: (roleId: string, body: RoleConfigInput) =>
    send<RoleConfigView>("PUT", `/role-configs/global/${roleId}`, body),
  projectRoleConfigs: (projectId: string) =>
    get<ProjectRoleConfigEntry[]>(`/projects/${projectId}/role-configs`),
  putProjectRoleConfig: (projectId: string, roleId: string, body: RoleConfigInput) =>
    send<RoleConfigView>("PUT", `/projects/${projectId}/role-configs/${roleId}`, body),
  deleteProjectRoleConfig: (projectId: string, roleId: string) =>
    send<{ ok: boolean }>("DELETE", `/projects/${projectId}/role-configs/${roleId}`),
  /** 任务报告（§8）：404 返回服务端完成门阻塞原因 */
  canvasReport: (canvasId: string) => getTaskReport(`/canvases/${canvasId}/report`),
  canvasReports: (canvasId: string) => get<TaskReport[]>(`/canvases/${canvasId}/reports`),
  canvasReportAvailability: (canvasId: string) =>
    get<TaskReportAvailability>(`/canvases/${canvasId}/report/availability`),
  retryReport: (canvasId: string) =>
    send<{ ok: boolean; report_id: string }>("POST", `/canvases/${canvasId}/report/retry`),
  refreshReport: (canvasId: string) =>
    send<{ ok: boolean; report_id?: string; reason?: string }>("POST", `/canvases/${canvasId}/report/refresh`),
  /** 报告 Markdown 正文（text/markdown；带认证头） */
  reportMarkdown: async (reportId: string): Promise<string> => {
    const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/markdown`, { headers: authHeaders() });
    if (!res.ok) throw new Error(await responseErrorDetail(res));
    return res.text();
  },
  /** 报告二进制下载（Bearer 不进 URL，成功后才触发 Blob 下载）。 */
  downloadReport: (reportId: string, format: "markdown" | "sarif"): Promise<void> =>
    downloadAuthenticatedFile(
      `/reports/${encodeURIComponent(reportId)}/${format}`,
      `report-${safeDownloadFilename(reportId, "unknown")}.${format === "markdown" ? "md" : "sarif"}`,
    ),
  projectRoles: (projectId: string) => get<ProjectRole[]>(`/projects/${projectId}/roles`),
  /** 项目数据包导出 */
  createExport: (
    projectId: string,
    body: {
      preset: "configuration" | "project_full" | "evidence_archive" | "custom";
      modules?: string[];
      allow_active_jobs?: boolean;
      credentials?: { mode?: "excluded" | "metadata" };
    },
  ) => send<DataExportRow>("POST", `/projects/${projectId}/exports`, body),
  listExports: (projectId: string) => get<DataExportRow[]>(`/projects/${projectId}/exports`),
  /** 平台配置导出（全局规则 / 角色 / Skill 源等） */
  createPlatformExport: (body?: {
    preset?: "platform_full" | "custom";
    modules?: string[];
    credentials?: { mode?: "excluded" | "metadata" };
  }) => send<DataExportRow>("POST", `/platform/exports`, body ?? { preset: "platform_full" }),
  listPlatformExports: () => get<DataExportRow[]>(`/platform/exports`),
  getExport: (id: string) => get<DataExportRow>(`/exports/${id}`),
  downloadExport: async (id: string): Promise<Blob> => {
    const res = await fetch(`/api/exports/${id}/download`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`download -> ${res.status}`);
    return res.blob();
  },
  cancelExport: (id: string) => send<DataExportRow>("POST", `/exports/${id}/cancel`),
  deleteExport: (id: string) => send<{ ok: boolean }>("DELETE", `/exports/${id}`),
  /** 上传 .deepsonarpack（raw body） */
  uploadImport: async (file: Blob): Promise<DataImportRow> => {
    const res = await fetch(`/api/imports`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/x-deepsonarpack",
      },
      body: file,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const err = (await res.json()) as { error?: string };
        detail = err.error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `upload -> ${res.status}`);
    }
    return res.json() as Promise<DataImportRow>;
  },
  getImport: (id: string) => get<DataImportRow>(`/imports/${id}`),
  previewImport: (id: string) => send<ImportPreview>("POST", `/imports/${id}/preview`),
  applyImport: (
    id: string,
    body: {
      mode?: "create_new" | "merge_configuration" | "merge_platform";
      project_name?: string;
      target_project_id?: string;
      conflict_policy?: "rename" | "keep_target" | "use_source";
      credential_mappings?: Record<string, string>;
    },
  ) =>
    send<{ project_id?: string; id_map?: Record<string, unknown>; ok?: boolean; summary?: Record<string, number> }>(
      "POST",
      `/imports/${id}/apply`,
      body,
    ),
  cancelImport: (id: string) => send<DataImportRow>("POST", `/imports/${id}/cancel`),
  deleteImport: (id: string) => send<{ ok: boolean }>("DELETE", `/imports/${id}`),
  globalSettings: () => get<GlobalSettings>("/global-settings"),
  patchGlobalSettings: (body: { rules?: Record<string, unknown>; finding_protocol?: FindingProtocolConfig | null }) =>
    send<GlobalSettings>("PATCH", "/global-settings", body),
  skillSources: () => get<SkillSource[]>("/skill-sources"),
  skillSource: (id: string) => get<SkillSourceDetail>(`/skill-sources/${id}`),
  createSkillSource: (s: { name: string; repo_url: string; branch: string }) =>
    send<SkillSource>("POST", "/skill-sources", s),
  syncSkillSource: (id: string) =>
    send<{
      ok: boolean;
      modules: number;
      changed: boolean;
      previous_commit_sha: string | null;
      last_commit_sha: string | null;
      previous_content_hash: string | null;
      last_content_hash: string | null;
      synced_at: string;
    }>("POST", `/skill-sources/${id}/sync`),
  deleteSkillSource: (id: string) => send<{ ok: boolean }>("DELETE", `/skill-sources/${id}`),
  trustSkillSource: (id: string, trust_status: SkillTrustStatus) =>
    send<SkillSource>("POST", `/skill-sources/${id}/trust`, { trust_status }),
  /** 用户认证 */
  authStatus: () => get<AuthStatus>("/auth/status"),
  authMe: () => get<AuthMe>("/auth/me"),
  createWsTicket: (jobId: string, purpose: "stream" | "terminal" = "stream") =>
    send<WsTicket>("POST", "/auth/ws-ticket", { job_id: jobId, purpose }),
  login: (body: { username: string; password: string }) =>
    send<LoginResult>("POST", "/auth/login", body),
  bootstrap: (body: { username: string; password: string; display_name?: string }) =>
    send<LoginResult>("POST", "/auth/bootstrap", body),
  logout: () => send<{ ok: boolean }>("POST", "/auth/logout"),
  changePassword: (body: { current_password: string; new_password: string }) =>
    send<LoginResult & { ok: boolean }>("POST", "/auth/change-password", body),
  changeUsername: (body: { current_password: string; new_username: string }) =>
    send<LoginResult & { ok: boolean }>("POST", "/auth/change-username", body),
  listUsers: () => get<PublicUser[]>("/users"),
  createUser: (body: {
    username: string;
    password: string;
    display_name?: string;
    role?: "admin" | "operator" | "viewer";
  }) => send<PublicUser>("POST", "/users", body),
  updateUser: (
    id: string,
    body: { display_name?: string; role?: "admin" | "operator" | "viewer"; status?: "active" | "disabled" },
  ) => send<PublicUser>("PATCH", `/users/${id}`, body),
  resetUserPassword: (id: string, password: string) =>
    send<{ ok: boolean }>("POST", `/users/${id}/password`, { password }),
  runtimeImages: (projectId?: string, search?: string) =>
    get<RuntimeImageSummary[]>(`/runtime-images${qs({ project_id: projectId, search })}`),
  runtimeImagesRegistry: () => get<RuntimeImageRegistry>("/runtime-images/registry"),
  setRuntimeImagesRegistryChannel: (channel: RuntimeImageRegistryChannel) =>
    send<RuntimeImageRegistryChannelUpdate | RuntimeImagePreparingResponse>("PATCH", "/runtime-images/registry/channel", { channel }),
  syncRuntimeImagesRegistry: () => send<RuntimeImageCatalogSyncResult>("POST", "/runtime-images/registry/sync"),
  /** 手动上传 runtime-image-registry.json 并写入市场（schema deepsonar.registry/v1/v2） */
  applyRuntimeImagesRegistry: (registry: RuntimeImageRegistry | Record<string, unknown>) =>
    send<RuntimeImageCatalogSyncResult>("POST", "/runtime-images/registry/apply", registry),
  pullRuntimeImagesRegistry: () => send<{ task: RuntimeImagePullTask }>("POST", "/runtime-images/registry/pull"),
  runtimeImagesPullStatus: () => get<RuntimeImagePullTask>("/runtime-images/registry/pull-status"),
  runtimeImage: (id: string) => get<RuntimeImageDetail>(`/runtime-images/${id}`),
  detectLocalRuntimeImage: (imageId: string, image_ref: string) =>
    send<RuntimeImageLocalCandidate>("POST", `/runtime-images/${imageId}/detect-local`, { image_ref }),
  adoptLocalRuntimeImage: (imageId: string, body: { image_ref: string; expected_image_id: string }) =>
    send<RuntimeImageLocalAdoptionResult>("POST", `/runtime-images/${imageId}/adopt-local`, body),
  importRuntimeImage: (body: {
    image_key: string;
    name: string;
    description?: string;
    publisher: string;
    source_url?: string;
    image_ref: string;
    version?: string;
    registry_credential_id?: string;
  }) => send<{ image: RuntimeImageSummary; version: RuntimeImageVersion; scan: RuntimeImageScan }>(
    "POST", "/runtime-images/import", body,
  ),
  /** 官方镜像登记 @sha256 digest 为 trusted（无版本时可用；等价 env bootstrap） */
  registerOfficialRuntimeDigest: (
    imageId: string,
    body: { image_ref: string; version?: string; source?: "registry" | "local-build" },
  ) => send<{ image: RuntimeImageSummary; version: RuntimeImageVersion }>(
    "POST", `/runtime-images/${imageId}/official-digest`, body,
  ),
  registerManualRuntimeDigest: (body: {
    image_key: string;
    name: string;
    description?: string;
    publisher: string;
    source_url?: string;
    image_ref: string;
    version?: string;
  }) => send<{ image: RuntimeImageSummary; version: RuntimeImageVersion }>("POST", "/runtime-images/manual-digest", body),
  setRuntimeImageVersionStatus: (
    id: string,
    status: "trusted" | "rejected" | "disabled" | "revoked",
    reason?: string,
  ) => send<RuntimeImageVersion>("POST", `/runtime-image-versions/${id}/status`, { status, reason }),
  rescanRuntimeImageVersion: (id: string) =>
    send<RuntimeImageScan>("POST", `/runtime-image-versions/${id}/rescan`),
  bindProjectRuntimeImage: (
    projectId: string,
    imageId: string,
    enabled: boolean,
    versionId?: string | null,
    pinPolicy?: "follow" | "hold",
  ) => send<{ project_id: string; runtime_image_id: string; enabled: boolean; selected_version_id: string | null; pin_policy?: "follow" | "hold" } | RuntimeImagePreparingResponse>(
    "PUT", `/projects/${projectId}/runtime-images/${imageId}`, {
      enabled,
      version_id: versionId ?? null,
      ...(pinPolicy ? { pin_policy: pinPolicy } : {}),
    },
  ),
  /** 平台 API Token 管理（§6.4，与 Provider Credential 分离） */
  tokens: () => get<ApiToken[]>("/tokens"),
  createToken: (t: { name: string; scopes: string[]; project_id?: string | null; expires_in_days?: number }) =>
    send<ApiTokenCreated>("POST", "/tokens", t),
  revokeToken: (id: string) => send<ApiToken>("POST", `/tokens/${id}/revoke`),
  rotateToken: (id: string) => send<ApiTokenCreated>("POST", `/tokens/${id}/rotate`),
  /** Provider Credential（§6.4，与 API Token 分离） */
  credentials: () => get<ProviderCredential[]>("/credentials"),
  credentialImpact: (id: string) => get<CredentialImpact>(`/credentials/${id}/impact`),
  credentialProviders: () => get<ProviderAccountCatalogItemView[]>("/credentials/providers"),
  bindableRoleConfigs: () => get<BindableRoleConfig[]>("/role-configs/bindable"),
  /** Provider 绑定列表：仅改 RoleConfig.agent_cli，不整表替换 */
  updateRoleConfigAgentCli: (roleConfigId: string, agent_cli: "claude-code" | "open-code" | "codex" | "pi" | "dsh") =>
    send<{ id: string; agent_cli: string; version: number; role_id: string; project_id: string | null }>(
      "PATCH",
      `/role-configs/${roleConfigId}/agent-cli`,
      { agent_cli },
    ),
  /** Provider 绑定列表：仅改 RoleConfig.runtime_image_key；null = 系统底座 */
  updateRoleConfigRuntimeImage: (roleConfigId: string, runtime_image_key: string | null) =>
    send<{ id: string; runtime_image_key: string | null; version: number; role_id: string; project_id: string | null }>(
      "PATCH",
      `/role-configs/${roleConfigId}/runtime-image`,
      { runtime_image_key },
    ),
  createCredential: (c: {
    name: string;
    kind?: string;
    provider: string;
    secret: string;
    project_id?: string | null;
    metadata?: Record<string, unknown>;
    agent_cli?: "claude-code" | "codex" | "open-code" | "pi" | "dsh" | null;
    settings_config?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  }) => send<ProviderCredential>("POST", "/credentials", c),
  /** 更新非敏感字段（名称 / provider / 项目 / base_url / settingsConfig 等）；密钥仍走 rotate */
  updateCredential: (
    id: string,
    patch: {
      name?: string;
      provider?: string;
      project_id?: string | null;
      metadata?: Record<string, unknown>;
      agent_cli?: "claude-code" | "codex" | "open-code" | "pi" | "dsh" | null;
      settings_config?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    },
  ) => send<CredentialUpdateResponse>("PATCH", `/credentials/${id}`, patch),
  rotateCredential: (id: string, secret: string) =>
    send<ProviderCredential>("POST", `/credentials/${id}/rotate`, { secret }),
  setCredentialStatus: (id: string, status: "active" | "disabled" | "rotation_required") =>
    send<ProviderCredential>("POST", `/credentials/${id}/status`, { status }),
  deleteCredential: (id: string, opts?: { unbind?: boolean }) =>
    send<{ ok: boolean; id: string; unbound_role_config_count: number; revoked_job_token_count: number }>(
      "DELETE",
      `/credentials/${id}${opts?.unbind ? "?unbind=true" : ""}`,
    ),
  testCredential: (id: string) =>
    send<{ ok: boolean; detail: string; category?: string; fetched_at?: string }>("POST", `/credentials/${id}/test`),
  credentialModels: (id: string) =>
    send<CredentialModels>("POST", `/credentials/${id}/models`),
  credentialModelsPreview: (input: {
      agent_cli?: "claude-code" | "codex" | "open-code" | "pi" | "dsh";
    provider: string;
    secret: string;
    base_url?: string;
    metadata?: Record<string, unknown>;
    settings_config?: Record<string, unknown>;
  }) => send<CredentialModels>("POST", "/credentials/models/preview", input),
  credentialCompatibility: (id: string, agent_cli: string, model?: string | null) => {
    const query = new URLSearchParams({ agent_cli });
    if (model) query.set("model", model);
    return get<{
      credential_id: string;
      provider: string;
      provider_valid: boolean;
      agent_cli: string;
      model: string | null;
      upstream_model: string | null;
      model_source: "role_override" | "credential_settings" | "none";
      compatible: boolean;
      error: string | null;
    }>(`/credentials/${id}/compatibility?${query.toString()}`);
  },
  bindCredentialsBatch: (input: CredentialBatchBindingInput) =>
    send<CredentialBatchBindingResult>("POST", "/credentials/batch-bind", input),
  health: () => get<{
    ok: boolean;
    ready: boolean;
    version: string;
    runtime_images: { status: "idle" | "preparing" | "ready" | "failed"; error: string | null; retry_at: string | null };
    dispatcher: { enabled: boolean; started_at: string | null };
    opensandbox: { level: "ok" | "error" | "unconfigured" | "skipped"; domain: string; ready: boolean };
    ts: number;
  }>("/health"),
  /** API schema 文档（OpenAPI 3 JSON；调度器豁免鉴权） */
  openApi: () => get<Record<string, unknown>>("/openapi.json"),
  /** schema 入口：format=openapi|summary|markdown */
  apiSchema: (format: "openapi" | "summary" | "markdown" = "openapi") =>
    get<Record<string, unknown>>(`/schema?format=${format}`),
};
