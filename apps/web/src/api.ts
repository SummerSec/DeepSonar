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
  node_type: "root" | "job" | "finding" | "note" | "human" | "intent" | "fact" | "report";
  title: string;
  body_json: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  status: string | null;
  /** fact 节点的可信状态（独立于 status 执行状态）：unverified/verifying/verified/rejected/needs_human */
  verification_status: string | null;
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

/** 思考强度（与 agentbox AgentReasoningEffort 对齐） */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Agent profile（§8.1）：env_keys 只是变量名引用，密钥不落库 */
export interface AgentProfile {
  id: string;
  name: string;
  agent_cli: "claude-code" | "open-code" | "codex";
  model: string | null;
  /** 思考强度；null = provider 默认 */
  reasoning: ReasoningEffort | null;
  env_keys: string[];
  /** §6.2：绑定的 Provider Credential（优先于 env_keys） */
  credential_id?: string | null;
  credential_provider?: string | null;
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

/** 角色注册表条目（§8.3）：kind='role' = hub 可下发角色；kind='hub' = 唯一决策中枢；kind='system' = 系统角色（verify/report 等） */
export interface AgentRole {
  id: string;
  name: string;
  title: string;
  description: string;
  prompt_template: string;
  builtin: boolean;
  kind: "hub" | "system" | "role";
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

export interface ApiTokenCreated extends ApiToken {
  /** 仅此一次可见，请立即复制保存 */
  token: string;
  rotated_from?: string;
}

/** Provider Credential（§6.2）：永不返回密文，只有指纹/last4 */
export interface ProviderCredential {
  id: string;
  name: string;
  kind: "llm_provider" | "plane" | "git";
  provider: string;
  project_id: string | null;
  key_version: number;
  public_metadata_json: Record<string, unknown>;
  fingerprint: string;
  last4: string;
  status: "active" | "disabled" | "rotation_required";
  last_used_at: string | null;
  rotated_at: string | null;
  created_at: string;
  created_by: string | null;
}

export type ProfileInput = {
  name: string;
  agent_cli: string;
  model?: string | null;
  reasoning?: ReasoningEffort | null;
  env_keys: string[];
  modules: string[];
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  subagents: Record<string, unknown>[];
  prompt_suffix?: string | null;
  /** §6.2：绑定的 Provider Credential（优先于 env_keys） */
  credential_id?: string | null;
};

// ---------- 角色即配置（RoleConfig，migration 0017）：全局缺省 + 项目覆盖 ----------

/** RoleConfig 保存体（全量声明式：每次 PUT 整体替换 Credential 绑定与配置文件） */
export type RoleConfigInput = {
  agent_cli: "claude-code" | "open-code" | "codex";
  model?: string | null;
  /** 思考强度；null = provider 默认 */
  reasoning?: ReasoningEffort | null;
  env_keys: string[];
  /** 非敏感环境变量（疑似密钥名会被后端拒绝，引导改用 Credential） */
  env_vars: Record<string, string>;
  modules: string[];
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  mcps: Record<string, unknown>[];
  subagents: Record<string, unknown>[];
  prompt_suffix?: string | null;
  /** 只能引用服务端可信镜像目录，不是任意 OCI 地址 */
  runtime_image_key?: string | null;
  credentials: { credential_id: string; purpose: string }[];
  /** Provider 配置文件：路径按 CLI 固定白名单（首期每角色最多 1 个） */
  config_files: { path: string; content: string }[];
};

/** RoleConfig 视图 = role_configs 行 + Credential 绑定 + 配置文件（含 sha256） */
export interface RoleConfigView {
  id: string;
  role_id: string;
  project_id: string | null;
  agent_cli: "claude-code" | "open-code" | "codex";
  model: string | null;
  reasoning: ReasoningEffort | null;
  env_keys: string[];
  env_vars_json: Record<string, string>;
  modules_json: string[];
  skills_json: Record<string, unknown>[];
  commands_json: Record<string, unknown>[];
  mcps_json: Record<string, unknown>[];
  subagents_json: Record<string, unknown>[];
  prompt_suffix: string | null;
  runtime_image_key: string | null;
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
}

// ---------- 任务报告（migration 0017，§8） ----------

export interface TaskReport {
  id: string;
  canvas_id: string;
  project_id: string;
  report_job_id: string | null;
  status: "pending" | "generating" | "succeeded" | "failed";
  /** 结构化摘要：confirmed_count / excluded_count / findings_total / confirmed_by_severity / generated_at */
  summary_json: {
    confirmed_count?: number;
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/** DFH_AUTH_REQUIRED 开启后，Web 端用本地保存的 API Token 调后端（§6.4） */
export function getLocalToken(): string {
  return localStorage.getItem("dfh_token") ?? "";
}
export function setLocalToken(token: string) {
  if (token) localStorage.setItem("dfh_token", token);
  else localStorage.removeItem("dfh_token");
}
function authHeaders(): Record<string, string> {
  const t = getLocalToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
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
      const err = (await res.json()) as { error?: string; message?: string };
      detail = err.error ?? err.message ?? "";
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
  /** 任务报告（§8）：404 = 还没有报告（Hub 宣布分析完成后自动生成） */
  canvasReport: (canvasId: string) => get<TaskReport>(`/canvases/${canvasId}/report`),
  retryReport: (canvasId: string) =>
    send<{ ok: boolean; report_id: string }>("POST", `/canvases/${canvasId}/report/retry`),
  /** 报告 Markdown 正文（text/markdown；SARIF/下载直接用 /api/reports/:id/{markdown,sarif} 链接） */
  reportMarkdown: async (reportId: string): Promise<string> => {
    const res = await fetch(`/api/reports/${reportId}/markdown`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`markdown -> ${res.status}`);
    return res.text();
  },
  /** 人工处理 Fact 验证状态（needs_human 的人工确认/明确排除） */
  setFactVerification: (nodeId: string, status: "verified" | "rejected" | "needs_human", note?: string) =>
    send<{ id: string; canvas_id: string; title: string }>(
      "PATCH",
      `/canvas-nodes/${nodeId}/verification`,
      { status, note },
    ),
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
  trustSkillSource: (id: string, trust_status: SkillTrustStatus) =>
    send<SkillSource>("POST", `/skill-sources/${id}/trust`, { trust_status }),
  /** 平台 API Token 管理（§6.4，与 Provider Credential 分离） */
  tokens: () => get<ApiToken[]>("/tokens"),
  createToken: (t: { name: string; scopes: string[]; project_id?: string | null; expires_in_days?: number }) =>
    send<ApiTokenCreated>("POST", "/tokens", t),
  revokeToken: (id: string) => send<ApiToken>("POST", `/tokens/${id}/revoke`),
  rotateToken: (id: string) => send<ApiTokenCreated>("POST", `/tokens/${id}/rotate`),
  /** Provider Credential（§6.4，与 API Token 分离） */
  credentials: () => get<ProviderCredential[]>("/credentials"),
  createCredential: (c: {
    name: string;
    kind?: string;
    provider: string;
    secret: string;
    project_id?: string | null;
    metadata?: Record<string, unknown>;
  }) => send<ProviderCredential>("POST", "/credentials", c),
  /** 更新非敏感字段（名称 / 项目 / base_url 等 metadata）；密钥仍走 rotate */
  updateCredential: (
    id: string,
    patch: {
      name?: string;
      project_id?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) => send<ProviderCredential>("PATCH", `/credentials/${id}`, patch),
  rotateCredential: (id: string, secret: string) =>
    send<ProviderCredential>("POST", `/credentials/${id}/rotate`, { secret }),
  setCredentialStatus: (id: string, status: "active" | "disabled" | "rotation_required") =>
    send<ProviderCredential>("POST", `/credentials/${id}/status`, { status }),
  testCredential: (id: string) =>
    send<{ ok: boolean; detail: string }>("POST", `/credentials/${id}/test`),
  health: () => get<{ ok: boolean; ts: number }>("/health"),
};
