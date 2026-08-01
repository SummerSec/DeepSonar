/** 调度器 API 类型与请求（vite proxy /api → :3100） */

export interface Project {
  id: string;
  /** 可空：NULL = 纯本地项目（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md） */
  plane_project_id: string | null;
  canvas_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

export interface CanvasNode {
  id: string;
  node_type: "root" | "job" | "finding" | "note" | "human" | "intent" | "fact";
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
  edge_type: "child" | "produces" | "verifies" | "next" | "from" | "to";
}

export interface CanvasData {
  canvas?: { id: string; title: string; target_json: Record<string, unknown>; project_id?: string };
  canvas_id: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** 任务画布列表项（一任务一画布；聚合最近一次 job 得任务状态） */
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
  last_job_id: string | null;
  last_job_status: string | null;
  last_job_priority: number | null;
  last_job_at: string | null;
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
}

/** 发现清单 */
export interface FindingSummary {
  id: string;
  project_id: string;
  job_id: string;
  node_id: string | null;
  fingerprint: string;
  title: string;
  severity: string;
  location: string | null;
  summary: string | null;
  verify_status: string;
  created_at: string;
  project_name?: string;
  canvas_id?: string | null;
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
  hubEnabled: boolean;
  maxHubRounds: number;
  maxIntentsPerDecision: number;
}

export interface ProjectSettings {
  profiles: Record<string, string>;
  rules: Record<string, unknown>;
  roles: { enabled: string[] | null };
  effective_rules: EffectiveRules;
}

/** 角色注册表条目（§8.3）：kind='role' = hub 可下发角色；kind='system' = hub/audit/verify 系统 prompt 模板 */
export interface AgentRole {
  id: string;
  name: string;
  title: string;
  description: string;
  prompt_template: string;
  builtin: boolean;
  kind: "role" | "system";
}

/** 项目视角的角色：启用状态 + 绑定的 profile */
export interface ProjectRole extends AgentRole {
  enabled: boolean;
  default_enabled: boolean;
  profile_id: string | null;
}

export type RoleInput = {
  name: string;
  title: string;
  description: string;
  prompt_template: string;
};

/** 全局设置（所有配置落库：规则默认值 → global_settings 单例行） */
export interface GlobalSettings {
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

function qs(params: Record<string, string | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const api = {
  projects: () => get<Project[]>("/projects"),
  createProject: (p: { name: string; description?: string; plane_project_id?: string | null }) =>
    send<Project>("POST", "/projects", p),
  updateProject: (id: string, p: { name?: string; description?: string; status?: "active" | "archived" }) =>
    send<Project>("PATCH", `/projects/${id}`, p),
  archiveProject: (id: string) =>
    send<{ id: string; status: string }>("POST", `/projects/${id}/archive`),
  /** 语义化任务创建（同事务建画布 + root + pending job） */
  createTask: (
    projectId: string,
    t: {
      title: string;
      content: string;
    },
  ) => send<{ canvas_id: string; job: { id: string; status: string } }>("POST", `/projects/${projectId}/tasks`, t),
  retryTask: (canvasId: string) => send<{ id: string; status: string }>("POST", `/tasks/${canvasId}/retry`),
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
  canvases: (projectId: string) => get<CanvasSummary[]>(`/projects/${projectId}/canvases`),
  canvas: (canvasId: string) => get<CanvasData>(`/canvases/${canvasId}`),
  job: (jobId: string) => get<JobDetail>(`/jobs/${jobId}`),
  jobs: (opts?: { project_id?: string; status?: string }) =>
    get<JobSummary[]>(`/jobs${qs({ project_id: opts?.project_id, status: opts?.status })}`),
  findings: (opts?: {
    project_id?: string;
    severity?: string;
    verify_status?: string;
    /** 只拉某任务画布的发现，不混其它任务 */
    canvas_id?: string;
  }) =>
    get<FindingSummary[]>(
      `/findings${qs({
        project_id: opts?.project_id,
        severity: opts?.severity,
        verify_status: opts?.verify_status,
        canvas_id: opts?.canvas_id,
      })}`,
    ),
  cancelJob: (id: string) => send<{ id: string; status: string }>("POST", `/jobs/${id}/cancel`),
  resumeJob: (id: string) => send<{ id: string; status: string }>("POST", `/jobs/${id}/resume`),
  agentProfiles: () => get<AgentProfile[]>("/agent-profiles"),
  createProfile: (p: ProfileInput) => send<AgentProfile>("POST", "/agent-profiles", p),
  updateProfile: (id: string, p: Partial<ProfileInput>) =>
    send<AgentProfile>("PATCH", `/agent-profiles/${id}`, p),
  deleteProfile: (id: string) => send<{ ok: boolean }>("DELETE", `/agent-profiles/${id}`),
  settings: (projectId: string) => get<ProjectSettings>(`/projects/${projectId}/settings`),
  patchSettings: (
    projectId: string,
    body: {
      profiles?: Record<string, string | null>;
      rules?: Record<string, unknown>;
      roles?: { enabled: string[] | null };
    },
  ) => send<ProjectSettings>("PATCH", `/projects/${projectId}/settings`, body),
  agentRoles: () => get<AgentRole[]>("/agent-roles"),
  createRole: (r: RoleInput) => send<AgentRole>("POST", "/agent-roles", r),
  updateRole: (id: string, r: Partial<Omit<RoleInput, "name">>) =>
    send<AgentRole>("PATCH", `/agent-roles/${id}`, r),
  deleteRole: (id: string) => send<{ ok: boolean }>("DELETE", `/agent-roles/${id}`),
  projectRoles: (projectId: string) => get<ProjectRole[]>(`/projects/${projectId}/roles`),
  globalSettings: () => get<GlobalSettings>("/global-settings"),
  patchGlobalSettings: (body: { rules: Record<string, unknown> }) =>
    send<GlobalSettings>("PATCH", "/global-settings", body),
  skillSources: () => get<SkillSource[]>("/skill-sources"),
  skillSource: (id: string) => get<SkillSourceDetail>(`/skill-sources/${id}`),
  createSkillSource: (s: { name: string; repo_url: string; branch: string }) =>
    send<SkillSource>("POST", "/skill-sources", s),
  syncSkillSource: (id: string) =>
    send<{ ok: boolean; modules: number }>("POST", `/skill-sources/${id}/sync`),
  deleteSkillSource: (id: string) => send<{ ok: boolean }>("DELETE", `/skill-sources/${id}`),
  health: () => get<{ ok: boolean; ts: number }>("/health"),
};
