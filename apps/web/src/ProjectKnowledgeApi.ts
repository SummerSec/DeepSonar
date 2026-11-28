import { getLocalToken } from "./api";

export interface KnowledgeItem {
  id: string;
  project_id: string;
  kind: "memory" | "skill";
  logical_key: string;
  title: string;
  keywords_json: string[];
  status: string;
  active_version_id: string | null;
  version: number | null;
  content_sha256: string | null;
  generation: number;
  updated_at: string;
  /** #1256：当前生效版本的一句话短文（服务端截断），没有正文或非 memory 时为 null。 */
  summary?: string | null;
  /** #1256：按本条当前版本聚合的评价计数；没有记录时各计数为 0。 */
  feedback?: { total: number; success: number; failure: number; inapplicable: number; unrated: number };
}

export interface KnowledgeVersion {
  id: string;
  version: number;
  content_sha256: string;
  /** 人工维护的版本没有 Job/Attempt，这里两列为 null。 */
  creator_job_id: string | null;
  creator_attempt_id?: string | null;
  created_by_type?: "job" | "human";
  created_by?: string | null;
  /** 可选的人工修订原因，与这一版一起保存。 */
  revision_reason?: string | null;
  sources_json: Array<{ kind: string; ref: string; content_hash: string }>;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

export interface KnowledgeGrant {
  id: string;
  grantee_project_id: string;
  version_id: string;
  revoked_at: string | null;
  created_at: string;
}

export interface KnowledgeDetail extends KnowledgeItem {
  versions: KnowledgeVersion[];
  versions_next_offset: number | null;
  proposals: Array<{ id: string; action: string; state: string; revision: number; reason: string; created_at: string }>;
  evaluations: Array<{ id: string; kind: string; result_json: Record<string, unknown>; created_at: string }>;
  usages: Array<{ id: string; job_id: string; selector: string; feedback_json: Record<string, unknown> | null; created_at: string }>;
}

export interface KnowledgeVersionDetail extends KnowledgeVersion {
  item: { id: string; kind: string; title: string; logical_key: string };
  candidate: { kind: "memory" | "skill"; content?: string; files?: Record<string, string> };
}

type Page<T> = { items: T[]; next_offset: number | null };

export type KnowledgeCloseoutStatus = "suggestions_available" | "no_new" | "not_submitted" | "restricted";

export interface KnowledgeCloseoutEvaluation {
  work_ref: string;
  status: "queued" | "running" | "passed" | "failed" | "blocked" | "cancelled";
  reason?: string;
}

export interface KnowledgeCloseoutSuggestion {
  candidate_ref: string;
  evaluation?: KnowledgeCloseoutEvaluation;
  kind: "memory" | "skill";
  title: string;
  scope: string;
  content: string;
  evidence_refs: Array<{ kind: "fact" | "evidence"; ref: string }>;
  target?: { item_ref: string; version_ref: string };
}

export interface KnowledgeCloseout {
  status: KnowledgeCloseoutStatus;
  can_evaluate?: boolean;
  evaluation_source_unavailable?: boolean;
  items?: KnowledgeCloseoutSuggestion[];
  next_offset: number | null;
}


export interface KnowledgeBackfillRow {
  job_id: string;
  canvas_id?: string | null;
  job_status: string;
  finished_at: string | null;
  /** 历史结论：已采集 / 当时跳过 / 仅登记（旧批量整理已下线） / 无登记。 */
  status: "collected" | "skipped" | "registered_retired" | "no_history";
  reason?: string;
  closeout_status: KnowledgeCloseoutStatus | "legacy_preview";
  closeout_root_ref: string | null;
  history?: {
    registered_at: string | null;
    collected_at: string | null;
    skipped_at: string | null;
    collection: "collected" | "skipped" | "retired" | "none";
  };
}

export interface KnowledgeActivityWork {
  id: string;
  state: string;
  stage: string;
  reason: string | null;
  job_count: number;
  run_seconds: number;
  active_job_id: string | null;
  canvas_id: string | null;
  created_at: string;
  updated_at: string;
  latest_proposal_state?: string | null;
  source_count: number;
}

export interface KnowledgeActivity extends Page<KnowledgeActivityWork> {
  /** 旧的项目批量整理状态。#1219 第四阶段第 3 步后服务端不再返回，保留可选定义供历史读取。 */
  collection?: {
    state: "idle" | "busy" | "accumulating" | "cooldown" | "ready" | "halted";
    pending_sources: number;
    consecutive_failures: number;
    next_collection_at: string | null;
  };
  summary: {
    registered_sources: number;
    collected_sources: number;
    skipped_sources: number;
    pending_sources: number;
    active_memory: number;
    active_skills: number;
    draft_items: number;
    completed_work: number;
    blocked_work: number;
    usage_count: number;
    feedback_count: number;
    successful_feedback: number;
  };
  skipped_sources: Array<{ job_id: string; reason: string; at: string }>;
}

async function request<T>(path: string, method = "GET", body?: unknown, readOptions?: Pick<RequestInit, "cache" | "signal">): Promise<T> {
  const token = getLocalToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/api${path}`, { ...readOptions, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string; error_code?: string };
    throw new Error(detail.error_code ?? detail.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/knowledge`;

export const projectKnowledgeApi = {
  evaluateCloseout: (projectId: string, rootId: string, candidateRef: string) =>
    request<{ work_ref: string }>(`${base(projectId)}/closeout/${encodeURIComponent(rootId)}/evaluate`,
      "POST", { candidate_ref: candidateRef }),
  backfill: (projectId: string, offset: number, signal?: AbortSignal) =>
    request<Page<KnowledgeBackfillRow>>(`${base(projectId)}/backfill?limit=10&offset=${offset}`,
      "GET", undefined, { cache: "no-store", signal }),
  closeout: (projectId: string, rootId: string, offset: number, signal?: AbortSignal) =>
    request<KnowledgeCloseout>(`${base(projectId)}/closeout/${encodeURIComponent(rootId)}?limit=10&offset=${offset}`,
      "GET", undefined, { cache: "no-store", signal }),
  activity: (projectId: string, input: { limit?: number; offset?: number } = {}) =>
    request<KnowledgeActivity>(`${base(projectId)}/activity?limit=${input.limit ?? 10}&offset=${input.offset ?? 0}`),
  list: (projectId: string, input: { kind?: string; status?: string; query?: string; offset?: number }) => {
    const params = new URLSearchParams();
    if (input.kind) params.set("kind", input.kind);
    if (input.status) params.set("status", input.status);
    if (input.query) params.set("query", input.query);
    params.set("offset", String(input.offset ?? 0));
    return request<Page<KnowledgeItem>>(`${base(projectId)}?${params}`);
  },
  detail: (projectId: string, itemId: string) => request<KnowledgeDetail>(`${base(projectId)}/${encodeURIComponent(itemId)}`),
  versions: (projectId: string, itemId: string, offset: number) =>
    request<Page<KnowledgeVersion>>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions?offset=${offset}&limit=50`),
  version: (projectId: string, itemId: string, versionId: string) =>
    request<KnowledgeVersionDetail>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}`),
  grants: (projectId: string, itemId: string, versionId: string) =>
    request<KnowledgeGrant[]>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/grants`),
  grant: (projectId: string, itemId: string, versionId: string, granteeProjectId: string) =>
    request<KnowledgeGrant>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/grants`, "POST", { grantee_project_id: granteeProjectId }),
  revokeGrant: (projectId: string, grantId: string) =>
    request<KnowledgeGrant>(`${base(projectId)}/grants/${encodeURIComponent(grantId)}/revoke`, "POST"),
  revokeVersion: (projectId: string, itemId: string, versionId: string, reason: string) =>
    request<KnowledgeVersion>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/revoke`, "POST", { reason }),
  create: (projectId: string, body: { kind: "memory" | "skill"; logical_key: string; title: string; keywords?: string[]; content?: string }) =>
    request<{ item_ref: string; version_ref: string; version: number }>(base(projectId), "POST", body),
  revise: (projectId: string, itemId: string, body: { expected_version: number; title: string; keywords?: string[]; content?: string; reason?: string }) =>
    request<{ item_ref: string; version_ref: string; version: number }>(`${base(projectId)}/${encodeURIComponent(itemId)}/versions`, "POST", body),
  archive: (projectId: string, itemId: string) =>
    request<{ item_ref: string; status: string }>(`${base(projectId)}/${encodeURIComponent(itemId)}/archive`, "POST", {}),
  restore: (projectId: string, itemId: string) =>
    request<{ item_ref: string; status: string }>(`${base(projectId)}/${encodeURIComponent(itemId)}/restore`, "POST", {}),
  receipts: (projectId: string, jobId: string) =>
    request<Page<{ id: string; operation: string; result_json: Record<string, unknown>; created_at: string }>>(
      `${base(projectId)}/receipts?job_id=${encodeURIComponent(jobId)}`),
};
