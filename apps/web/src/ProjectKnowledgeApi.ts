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
}

export interface KnowledgeVersion {
  id: string;
  version: number;
  content_sha256: string;
  creator_job_id: string;
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

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const token = getLocalToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string; error_code?: string };
    throw new Error(detail.error_code ?? detail.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/knowledge`;

export const projectKnowledgeApi = {
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
  receipts: (projectId: string, jobId: string) =>
    request<Page<{ id: string; operation: string; result_json: Record<string, unknown>; created_at: string }>>(
      `${base(projectId)}/receipts?job_id=${encodeURIComponent(jobId)}`),
};
