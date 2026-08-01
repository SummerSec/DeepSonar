/** 调度器 API 类型与请求（vite proxy /api → :3100） */

export interface Project {
  id: string;
  plane_project_id: string;
  canvas_id: string;
  name: string;
}

export interface CanvasNode {
  id: string;
  node_type: "root" | "job" | "finding" | "note" | "human";
  title: string;
  body_json: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string | null;
  job_id: string | null;
  updated_at: string;
}

export interface CanvasEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: "child" | "produces" | "verifies" | "next";
}

export interface CanvasData {
  canvas?: { id: string; title: string; target_json: Record<string, unknown> };
  canvas_id: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** 任务画布列表项（一任务一画布） */
export interface CanvasSummary {
  id: string;
  title: string;
  plane_issue_id: string | null;
  target_json: Record<string, unknown>;
  created_at: string;
  job_count: number;
  active_count: number;
  finding_count: number;
  confirmed_count: number;
}

export interface JobEvent {
  id: string;
  job_seq: number;
  type: string;
  payload_json: Record<string, unknown>;
  created_at: string;
}

export interface JobDetail {
  job: {
    id: string;
    type: string;
    status: string;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
  events: JobEvent[];
  findings: { id: string; severity: string; title: string; verify_status: string }[];
}

/** Agent profile（§8.1）：env_keys 只是变量名引用，密钥不落库 */
export interface AgentProfile {
  id: string;
  name: string;
  agent_cli: "claude-code" | "open-code" | "codex";
  model: string | null;
  env_keys: string[];
  modules_json: string[];
  skills_json: Record<string, unknown>[];
  commands_json: Record<string, unknown>[];
  mcps_json: Record<string, unknown>[];
  subagents_json: Record<string, unknown>[];
  prompt_suffix: string | null;
  created_at: string;
  updated_at: string;
}

/** Git 模块源（§8.2） */
export interface SkillSource {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  synced_at: string | null;
  created_at: string;
  module_count?: number;
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
  autoVerifySeverities: string[];
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  maxAutoRetries: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
}

export interface ProjectSettings {
  profiles: Record<string, string>;
  rules: Record<string, unknown>;
  effective_rules: EffectiveRules;
}

export type ProfileInput = {
  name: string;
  agent_cli: string;
  model?: string | null;
  env_keys: string[];
  modules: string[];
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  subagents: Record<string, unknown>[];
  prompt_suffix?: string | null;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  projects: () => get<Project[]>("/projects"),
  canvases: (projectId: string) => get<CanvasSummary[]>(`/projects/${projectId}/canvases`),
  canvas: (canvasId: string) => get<CanvasData>(`/canvases/${canvasId}`),
  job: (jobId: string) => get<JobDetail>(`/jobs/${jobId}`),
  agentProfiles: () => get<AgentProfile[]>("/agent-profiles"),
  createProfile: (p: ProfileInput) => send<AgentProfile>("POST", "/agent-profiles", p),
  updateProfile: (id: string, p: Partial<ProfileInput>) =>
    send<AgentProfile>("PATCH", `/agent-profiles/${id}`, p),
  deleteProfile: (id: string) => send<{ ok: boolean }>("DELETE", `/agent-profiles/${id}`),
  settings: (projectId: string) => get<ProjectSettings>(`/projects/${projectId}/settings`),
  patchSettings: (projectId: string, body: { profiles?: Record<string, string | null>; rules?: Record<string, unknown> }) =>
    send<ProjectSettings>("PATCH", `/projects/${projectId}/settings`, body),
  skillSources: () => get<SkillSource[]>("/skill-sources"),
  skillSource: (id: string) => get<SkillSourceDetail>(`/skill-sources/${id}`),
  createSkillSource: (s: { name: string; repo_url: string; branch: string }) =>
    send<SkillSource>("POST", "/skill-sources", s),
  syncSkillSource: (id: string) => send<{ ok: boolean; modules: number }>("POST", `/skill-sources/${id}/sync`),
  deleteSkillSource: (id: string) => send<{ ok: boolean }>("DELETE", `/skill-sources/${id}`),
};
