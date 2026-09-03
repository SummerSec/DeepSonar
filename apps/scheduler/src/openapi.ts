/**
 * DeepSonar HTTP API OpenAPI 3 文档（机器可读 schema）。
 * 端点：GET /openapi.json、GET /schema（同源）、GET /schema.md（人类可读摘要）。
 * 与 skills/deepsonar-management/references/api.md 对齐；改路由时请同步更新本文件与该 md。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SCOPES } from "./auth.js";
import { config } from "./config.js";
import { FINDING_DISPOSITIONS } from "./finding-disposition.js";
import { RUNTIME_IMAGE_REGISTRY_CHANNELS } from "./runtime-image-registry-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 尝试定位仓库内 Management Skill 的 api.md */
export function resolveApiMarkdownPath(): string | null {
  const candidates = [
    path.resolve(HERE, "../../../skills/deepsonar-management/references/api.md"),
    path.resolve(process.cwd(), "skills/deepsonar-management/references/api.md"),
    path.resolve(process.cwd(), "../../skills/deepsonar-management/references/api.md"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function loadApiMarkdown(): string | null {
  const p = resolveApiMarkdownPath();
  if (!p) return null;
  return readFileSync(p, "utf8");
}

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface Op {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  scope?: string | null; // null = 豁免鉴权
  tags: string[];
  body?: Record<string, unknown>;
  bodyContentType?: string;
  query?: Record<string, unknown>;
  requiredQuery?: readonly string[];
  responses?: Record<string, unknown>;
  successStatus?: "200" | "201" | "202";
}

const ErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string", description: "人类可读错误信息" },
    error_code: { type: "string", description: "稳定机器可读错误代码（若该错误提供）" },
  },
  required: ["error"],
};

const TaskExecutionControlResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["canvas_id", "execution_state", "active_count", "pending_count", "changed"],
  properties: {
    canvas_id: { type: "string", format: "uuid" },
    execution_state: { type: "string", enum: ["pausing", "paused", "running"] },
    active_count: {
      type: "integer",
      minimum: 0,
      description: "仍在安全收尾的 claimed/provisioning/running/waiting_human Job 数；pending 不计入",
    },
    pending_count: { type: "integer", minimum: 0 },
    changed: { type: "boolean" },
  },
};

const FactVerificationSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["finding_id", "evidence_kind", "outcome", "subject_revision"],
  properties: {
    finding_id: { type: "string", format: "uuid" },
    evidence_kind: { type: "string", enum: ["review", "test"] },
    outcome: { type: "string", enum: ["supports", "refutes", "inconclusive"] },
    subject_revision: { type: "string", maxLength: 500 },
  },
};

const FactFindingSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["id", "node_id", "title", "severity", "verify_status"],
  properties: {
    id: { type: "string", format: "uuid" },
    node_id: { type: "string", format: "uuid" },
    title: { type: "string" },
    severity: { type: "string", nullable: true },
    verify_status: { type: "string" },
  },
};

const FactJobSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["id", "type", "status"],
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string" },
    status: { type: "string" },
  },
};

const FactSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "canvas_id", "title", "description", "verification_status", "job_id", "created_at", "updated_at", "verification", "finding", "job"],
  properties: {
    id: { type: "string", format: "uuid" },
    canvas_id: { type: "string", format: "uuid" },
    title: { type: "string" },
    description: { type: "string", maxLength: 500 },
    verification_status: { type: "string", enum: ["unverified", "verifying", "verified", "rejected", "needs_human"] },
    job_id: { type: "string", format: "uuid", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    verification: FactVerificationSchema,
    finding: FactFindingSchema,
    job: FactJobSchema,
  },
};

const TaskResumeJobSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "status"],
  properties: {
    id: { type: "string", format: "uuid" },
    type: { type: "string" },
    status: { type: "string" },
  },
};

const TaskResumeResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["canvas_id", "action"],
  properties: {
    canvas_id: { type: "string", format: "uuid" },
    action: {
      type: "string",
      enum: ["already_running", "rerun_interrupted_jobs", "resume_job", "wake_hub", "start_now"],
    },
    jobs: {
      type: "array",
      description: "实际重新入队或已活动的 Job。rerun_interrupted_jobs 返回全部启动中断 Worker。",
      items: TaskResumeJobSchema,
    },
    job: { ...TaskResumeJobSchema, nullable: true },
    effects_replayed: {
      type: "boolean",
      description: "批量重跑固定为 false；旧 Attempt 的 unknown/never effect 不自动重放。",
    },
    message: { type: "string" },
    convergence: { type: "object", additionalProperties: true },
  },
};

const EvidenceFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "path", "kind", "bytes", "sha256"],
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    kind: { type: "string", enum: ["main", "subagent", "vendor_export", "stream", "otlp"] },
    bytes: { type: "integer", minimum: 0 },
    sha256: {
      type: "string",
      nullable: true,
      description: "inflight mutable stream 为 null；finalized 文件为完整 SHA-256。",
    },
    inflight: { type: "boolean" },
  },
};

const JobEvidenceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["transcript_uri", "manifest"],
  properties: {
    transcript_uri: { type: "string", nullable: true },
    manifest: {
      type: "object",
      additionalProperties: false,
      required: ["v", "job_id", "cli", "session_id", "created_at", "finalized_at", "files"],
      properties: {
        v: { type: "integer", enum: [1] },
        job_id: { type: "string", format: "uuid" },
        cli: { type: "string" },
        session_id: { type: "string", nullable: true },
        created_at: { type: "string", format: "date-time" },
        finalized_at: { type: "string", format: "date-time", nullable: true },
        files: { type: "array", items: EvidenceFileSchema },
        capture_error: {
          type: "string",
          description: "Session 无法从已销毁沙箱归档时的明确原因；不代表存在伪造 Session。",
        },
        synthetic: { type: "boolean" },
        inflight: { type: "boolean" },
        truncated: { type: "boolean" },
      },
    },
  },
};

const RuntimeRegistryChannelErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "error_code"],
  properties: {
    error: { type: "string", minLength: 1 },
    error_code: {
      type: "string",
      enum: ["RUNTIME_REGISTRY_CHANNEL_INVALID", "RUNTIME_REGISTRY_CHANNEL_UPDATE_FAILED", "PROJECT_SCOPE_FORBIDDEN"],
    },
    details: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};

const RuntimeImageChannelUnavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "error_code", "channel", "task"],
  properties: {
    error: { type: "string", minLength: 1 },
    error_code: { type: "string", enum: ["RUNTIME_IMAGE_CHANNEL_UNAVAILABLE"] },
    channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
    image_key: { type: "string", minLength: 1 },
    task: { type: "object", nullable: true, additionalProperties: true },
  },
};

/** 核心 API 操作表（OpenAPI paths 的单一来源） */
const OPS: Op[] = [
  // meta
  {
    method: "get",
    path: "/health",
    summary: "存活检查（含产品版本、runtime image、dispatcher 与 OpenSandbox readiness）",
    scope: null,
    tags: ["Meta"],
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["ok", "ready", "version", "runtime_images", "dispatcher", "opensandbox", "ts"],
        properties: {
          ok: { type: "boolean" },
          ready: { type: "boolean" },
          version: {
            type: "string",
            description: "部署版本：DEEPSONAR_VERSION，否则 DEEPSONAR_IMAGE_TAG；未设置时为空字符串，不用 workspace package.json",
          },
          runtime_images: { type: "object", additionalProperties: true },
          dispatcher: { type: "object", additionalProperties: true },
          opensandbox: {
            type: "object",
            additionalProperties: false,
            required: ["level", "domain", "ready"],
            properties: {
              level: { type: "string", enum: ["ok", "error", "unconfigured", "skipped"] },
              domain: { type: "string" },
              ready: { type: "boolean" },
            },
          },
          ts: { type: "integer" },
        },
      },
    },
  },
  { method: "get", path: "/openapi.json", summary: "OpenAPI 3 JSON schema", scope: null, tags: ["Meta"] },
  { method: "get", path: "/schema", summary: "API schema（默认 OpenAPI JSON；?format=markdown 返回 Markdown）", scope: null, tags: ["Meta"] },
  { method: "get", path: "/schema.md", summary: "API Markdown 文档", scope: null, tags: ["Meta"] },
  { method: "get", path: "/metrics", summary: "Prometheus 指标文本", scope: "admin", tags: ["Meta"] },

  // human authentication (API Token auth remains separate)
  {
    method: "get",
    path: "/auth/status",
    summary: "用户认证状态与首次种子状态",
    scope: null,
    tags: ["Auth"],
    responses: {
      "200": {
        description: "认证与默认管理员提示状态",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["auth_required", "has_users", "bootstrap_available", "default_admin_credentials_active"],
              properties: {
                auth_required: { type: "boolean" },
                has_users: { type: "boolean" },
                bootstrap_available: { type: "boolean" },
                default_admin_credentials_active: { type: "boolean" },
                session_ttl_days: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/auth/login",
    summary: "用户名密码登录",
    description:
      "任意密码校验（含成功）按规范化用户名+客户端 IP 限制 5 次/5 分钟，并按 IP 限制 20 次/5 分钟。超限返回 429 LOGIN_RATE_LIMITED，不泄露用户是否存在。成功登录占额且不清桶。",
    scope: null,
    tags: ["Auth"],
    body: {
      type: "object",
      required: ["username", "password"],
      properties: { username: { type: "string" }, password: { type: "string", format: "password" } },
    },
    responses: {
      "429": {
        description: "登录校验次数超限",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error", "error_code"],
              properties: {
                error: { type: "string" },
                error_code: { type: "string", enum: ["LOGIN_RATE_LIMITED"] },
                retry_after_sec: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/auth/bootstrap",
    summary: "兼容旧版的首次管理员引导（默认管理员种子后返回 409）",
    scope: null,
    tags: ["Auth"],
    body: {
      type: "object",
      required: ["username", "password"],
      properties: { username: { type: "string" }, password: { type: "string", format: "password" }, display_name: { type: "string" } },
    },
  },
  { method: "post", path: "/auth/logout", summary: "注销当前用户会话", scope: "projects:read", tags: ["Auth"] },
  {
    method: "get",
    path: "/auth/me",
    summary: "当前认证主体",
    scope: "projects:read",
    tags: ["Auth"],
    responses: {
      "200": {
        description: "Current actor and user projection",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                auth_required: { type: "boolean" },
                authenticated: { type: "boolean" },
                actor: {
                  type: "object",
                  nullable: true,
                  properties: {
                    type: { type: "string" },
                    name: { type: "string" },
                    role: { type: "string", nullable: true },
                    project_id: { type: "string", format: "uuid", nullable: true },
                    scopes: { type: "array", items: { type: "string" } },
                  },
                },
                user: { type: "object", nullable: true, additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/auth/change-password",
    summary: "修改当前用户密码并刷新会话",
    scope: "projects:read",
    tags: ["Auth"],
    body: {
      type: "object",
      required: ["current_password", "new_password"],
      properties: { current_password: { type: "string", format: "password" }, new_password: { type: "string", format: "password" } },
    },
  },
  {
    method: "post",
    path: "/auth/change-username",
    summary: "修改当前用户登录名并刷新会话",
    scope: "projects:read",
    tags: ["Auth"],
    body: {
      type: "object",
      required: ["current_password", "new_username"],
      properties: { current_password: { type: "string", format: "password" }, new_username: { type: "string" } },
    },
  },

  // dashboard
  {
    method: "get",
    path: "/dashboard/overview",
    summary: "态势运营总览聚合",
    description:
      "P0 运营看板只读聚合：项目/任务/Job/Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建/完成任务与新增 Finding、活跃项目 Top N 与最近活动。列表上限不足以做总量时不要前端全量拉取。项目级 token 只看到本项目。",
    scope: "projects:read",
    tags: ["Dashboard"],
    responses: {
      "200": {
        description: "运营总览",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["generated_at", "calendar_timezone", "totals", "distributions", "periods", "trend_7d", "active_projects", "recent_activity"],
              properties: {
                generated_at: { type: "string", format: "date-time" },
                calendar_timezone: { type: "string", enum: ["Asia/Shanghai"] },
                totals: {
                  type: "object",
                  additionalProperties: false,
                  required: ["projects", "tasks", "jobs", "findings"],
                  properties: {
                    projects: { type: "integer", minimum: 0 },
                    tasks: { type: "integer", minimum: 0 },
                    jobs: { type: "integer", minimum: 0 },
                    findings: { type: "integer", minimum: 0 },
                  },
                },
                distributions: {
                  type: "object",
                  additionalProperties: false,
                  required: ["projects", "tasks", "jobs", "findings"],
                  properties: {
                    projects: { type: "array", items: { $ref: "#/components/schemas/DashboardStatusBucket" } },
                    tasks: { type: "array", items: { $ref: "#/components/schemas/DashboardStatusBucket" } },
                    jobs: { type: "array", items: { $ref: "#/components/schemas/DashboardStatusBucket" } },
                    findings: { type: "array", items: { $ref: "#/components/schemas/DashboardStatusBucket" } },
                  },
                },
                periods: {
                  type: "object",
                  additionalProperties: false,
                  required: ["today", "last_7d"],
                  properties: {
                    today: { $ref: "#/components/schemas/DashboardPeriodCounts" },
                    last_7d: { $ref: "#/components/schemas/DashboardPeriodCounts" },
                  },
                },
                trend_7d: {
                  type: "array",
                  items: {
                    allOf: [
                      { $ref: "#/components/schemas/DashboardPeriodCounts" },
                      { type: "object", required: ["date"], properties: { date: { type: "string", format: "date" } } },
                    ],
                  },
                },
                active_projects: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "name", "status", "active_jobs", "task_count", "finding_count", "last_activity_at"],
                    properties: {
                      id: { type: "string", format: "uuid" },
                      name: { type: "string" },
                      status: { type: "string", enum: ["active", "archived"] },
                      active_jobs: { type: "integer", minimum: 0 },
                      task_count: { type: "integer", minimum: 0 },
                      finding_count: { type: "integer", minimum: 0 },
                      last_activity_at: { type: "string", format: "date-time", nullable: true },
                    },
                  },
                },
                recent_activity: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "kind", "title", "at", "project_id", "project_name", "canvas_id"],
                    properties: {
                      id: { type: "string" },
                      kind: { type: "string", enum: ["task", "job", "finding"] },
                      title: { type: "string" },
                      at: { type: "string", format: "date-time" },
                      project_id: { type: "string", format: "uuid" },
                      project_name: { type: "string" },
                      canvas_id: { type: "string", nullable: true },
                      status: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/dashboard/usage",
    summary: "用量账本看板",
    description:
      "聚合 job_usage_ledger（含缓存读/写 token）。period=day|week|month 为 Asia/Shanghai 滚动窗口；period=custom 时 from/to 为含首尾的日历日或 ISO 时刻，跨度最长 366 天。可选 project_id / canvas_id。不定价。项目级 token 只看到本项目。",
    scope: "projects:read",
    tags: ["Dashboard"],
    query: {
      period: { type: "string", enum: ["day", "week", "month", "custom"] },
      from: { type: "string", description: "自定义起点：YYYY-MM-DD（上海日历日）或 ISO 时刻" },
      to: { type: "string", description: "自定义终点：YYYY-MM-DD（含当日）或 ISO 时刻" },
      project_id: { type: "string", format: "uuid" },
      canvas_id: { type: "string", format: "uuid" },
    },
    responses: {
      "200": { description: "用量账本聚合" },
      "400": { description: "自定义时间非法、倒序、超长或缺失" },
    },
  },

  // projects
  { method: "get", path: "/projects", summary: "项目列表", scope: "projects:read", tags: ["Projects"] },
  {
    method: "post",
    path: "/projects",
    summary: "创建项目",
    scope: "projects:write",
    tags: ["Projects"],
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        plane_project_id: { type: "string", nullable: true },
        image_strategy: { type: "string", enum: ["inherit_global", "project_managed"], default: "inherit_global" },
      },
    },
  },
  { method: "get", path: "/projects/{id}", summary: "项目详情", scope: "projects:read", tags: ["Projects"] },
  {
    method: "get",
    path: "/projects/{id}/findings/summary",
    summary: "项目风险聚合（不受 Finding 列表窗口截断）",
    description: "按严重度、verify_status、disposition 与来源任务计数；可选 canvas_id 收窄。列表窗口仍由 GET /findings 限制。",
    scope: "findings:read",
    tags: ["Findings"],
    query: {
      canvas_id: { type: "string", description: "逗号分隔的来源画布 UUID，收窄聚合范围" },
    },
  },
  {
    method: "patch",
    path: "/projects/{id}",
    summary: "更新项目",
    scope: "projects:write",
    tags: ["Projects"],
    body: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["active", "archived"] },
      },
    },
  },
  { method: "post", path: "/projects/{id}/archive", summary: "归档项目", scope: "projects:write", tags: ["Projects"] },

  // shared assets
  { method: "get", path: "/projects/{id}/shared-assets", summary: "项目共享资产目录", scope: "assets:read", tags: ["Shared Assets"] },
  { method: "post", path: "/projects/{id}/shared-assets", summary: "上传项目共享资产（x-asset-key 指定逻辑路径）", scope: "assets:write", tags: ["Shared Assets"], bodyContentType: "application/octet-stream", body: { type: "string", format: "binary" } },
  { method: "get", path: "/projects/{id}/shared-assets/policy", summary: "项目共享资产策略", scope: "assets:read", tags: ["Shared Assets"] },
  { method: "patch", path: "/projects/{id}/shared-assets/policy", summary: "更新平台资产 opt-in", scope: "assets:write", tags: ["Shared Assets"], body: { type: "object", required: ["platform_enabled"], additionalProperties: false, properties: { platform_enabled: { type: "boolean" } } } },
  { method: "get", path: "/findings/{id}/shared-assets", summary: "Finding 只读工作包目录", scope: "assets:read", tags: ["Shared Assets"] },
  { method: "post", path: "/findings/{id}/shared-assets", summary: "上传 Finding 共享资产", scope: "assets:write", tags: ["Shared Assets"], bodyContentType: "application/octet-stream", body: { type: "string", format: "binary" } },
  { method: "get", path: "/platform/shared-assets", summary: "平台共享资产目录（管理员）", scope: "assets:manage", tags: ["Shared Assets"] },
  { method: "post", path: "/platform/shared-assets", summary: "上传平台共享资产（管理员）", scope: "assets:manage", tags: ["Shared Assets"], bodyContentType: "application/octet-stream", body: { type: "string", format: "binary" } },
  { method: "post", path: "/shared-assets/{id}/archive", summary: "归档共享资产（保留历史版本）", scope: "assets:write", tags: ["Shared Assets"] },
  { method: "get", path: "/shared-assets/{id}/content", summary: "下载共享资产内容", scope: "assets:read", tags: ["Shared Assets"] },

  // tasks / canvases
  {
    method: "post",
    path: "/projects/{id}/tasks",
    summary: "创建任务（铸画布 + 入口 job）",
    scope: "tasks:write",
    tags: ["Tasks"],
    body: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        allow_egress: { type: "boolean", description: "省略时继承项目默认值" },
        kind: {
          type: "string",
          enum: ["standard", "compose"],
          default: "standard",
          description: "普通任务从空画布开始；组合续挖任务必须显式选择历史 Finding",
        },
        seed_finding_ids: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", format: "uuid" },
          description: "仅 compose 可用；同项目、未否定处置的具体 Finding UUID（含 pending 等未确认状态）",
        },
        scheduled_start_at: {
          type: "string",
          format: "date-time",
          description: "定时开始（ISO-8601）；到点前 Job 保持 pending。与 schedule_beijing_8am 同时给出时以本字段为准",
        },
        schedule_beijing_8am: {
          type: "boolean",
          description: "为 true 时在下一北京时间 08:00（Asia/Shanghai）开始；scheduled_start_at 优先",
        },
      },
    },
  },
  {
    method: "post",
    path: "/projects/{id}/events",
    summary: "注入外部事件（source+event_id 幂等）",
    scope: "tasks:write",
    tags: ["Tasks"],
    body: {
      type: "object",
      required: ["source", "event_id", "event_type"],
      properties: {
        source: { type: "string" },
        event_id: { type: "string" },
        event_type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
    },
  },
  { method: "get", path: "/projects/{id}/canvases", summary: "画布列表", description: "每项投影 execution_state、execution_active_count 与 pending_count。", scope: "tasks:read", tags: ["Tasks"] },
  { method: "get", path: "/projects/{id}/canvas", summary: "项目当前画布（兼容）", scope: "tasks:read", tags: ["Tasks"] },
  { method: "get", path: "/canvases/{id}", summary: "画布节点与边", description: "canvas 投影 execution_state、execution_active_count 与 pending_count。", scope: "tasks:read", tags: ["Tasks"] },
  {
    method: "get",
    path: "/canvases/{id}/broadcasts",
    summary: "Fact/Finding 广播投递账本",
    description: "返回广播计划及注入 Agent 会话的投递状态；injected 不表示 Agent 已阅读或处理。响应不含广播正文、摘要或哈希。",
    scope: "tasks:read",
    tags: ["Tasks"],
    query: { limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 } },
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["canvas_id", "items", "total", "truncated"],
        properties: {
          canvas_id: { type: "string" },
          total: { type: "integer", minimum: 0 },
          truncated: { type: "boolean" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "source_job_id", "source_node_id", "source_node_type", "target_job_id", "target_node_id", "target_node_type", "target_node_title", "target_role", "target_role_kind", "attempt", "delivery_status", "title", "error", "planned_at", "delivered_at"],
              properties: {
                id: { type: "string", format: "uuid" },
                source_job_id: { type: "string", format: "uuid" },
                source_node_id: { type: "string", format: "uuid" },
                source_node_type: { type: "string", enum: ["fact", "finding"] },
                target_job_id: { type: "string", format: "uuid" },
                target_node_id: { type: "string", format: "uuid", nullable: true },
                target_node_type: { type: "string", enum: ["intent", "job", "report"], nullable: true },
                target_node_title: { type: "string", nullable: true },
                target_role: { type: "string", nullable: true },
                target_role_kind: { type: "string", nullable: true },
                attempt: { type: "integer", minimum: 1 },
                delivery_status: { type: "string", enum: ["planned", "injected", "failed", "unknown"] },
                title: { type: "string" },
                error: { type: "string", nullable: true },
                planned_at: { type: "string", format: "date-time" },
                delivered_at: { type: "string", format: "date-time", nullable: true },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/canvases/{id}/messages",
    summary: "人工消息投递账本",
    description: "返回人工消息的传输与显式确认状态。injected 仅表示已注入 Agent 会话；只有 acknowledged 表示 Agent 调用了 ack_human_message。",
    scope: "tasks:read",
    tags: ["Tasks"],
    query: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
  },
  {
    method: "post",
    path: "/canvases/{id}/messages",
    summary: "向 Hub 或运行节点发送人工消息",
    description: "message_id 是客户端 UUID 幂等键。无附件只需 tasks:write；attachment_version_ids 非空时还需 assets:read（assets:manage/admin 隐式满足），且只接受同项目 active project-scope 资产。消息先持久化；sendMessage 前确定失败记 failed，sendMessage 已尝试后的不确定结果记 unknown 且不会自动重发。",
    scope: "tasks:write",
    tags: ["Tasks"],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["message_id", "target", "body"],
      properties: {
        message_id: { type: "string", format: "uuid" },
        target: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["hub", "job"] },
            node_id: { type: "string", format: "uuid", description: "kind=job 时必填" },
          },
        },
        body: { type: "string", minLength: 1, maxLength: 8000 },
        attachment_version_ids: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", format: "uuid" }, default: [], description: "同项目、scope_type=project、status=active 的附件版本；非空时调用者还必须拥有 assets:read（assets:manage/admin 隐式满足）" },
      },
    },
  },
  {
    method: "post",
    path: "/canvases/{id}/human-nodes/{nodeId}/ignore",
    summary: "忽略未处理的人工介入",
    description: "将 open 的 human 节点标为 ignored。若对应 Job 仍为 waiting_human，则关闭旧 Attempt 并恢复为 pending，让 Agent 在图上看到忽略决议后继续推进。已忽略的请求幂等返回。",
    scope: "jobs:control",
    tags: ["Tasks"],
  },
  { method: "get", path: "/canvases/{id}/summary", summary: "画布 L0 骨架（带 durable revision）", scope: "tasks:read", tags: ["Tasks"] },
  {
    method: "get",
    path: "/canvases/{id}/delta",
    summary: "按 durable revision 读取画布 L0 增量（过旧游标返回 CURSOR_GAP）",
    scope: "tasks:read",
    tags: ["Tasks"],
    query: { since: { type: "string", pattern: "^[0-9]+$" } },
    requiredQuery: ["since"],
  },
  { method: "get", path: "/canvases/{id}/nodes/{nodeId}", summary: "画布节点 L1 详情", scope: "tasks:read", tags: ["Tasks"] },
  {
    method: "get",
    path: "/canvases/{id}/facts",
    summary: "画布 Fact 分页列表",
    description: "按 created_at,id 降序 keyset 分页；四类筛选支持逗号分隔多值，同一参数内按 OR 匹配。Finding 关联仅来自同项目、同画布 canonical Finding 与直接结构化证据边。",
    scope: "tasks:read",
    tags: ["Tasks"],
    query: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
      after: { type: "string", maxLength: 512 },
      verification_status: { type: "string", description: "逗号分隔，最多 20 个；值为 unverified|verifying|verified|rejected|needs_human" },
      evidence_kind: { type: "string", description: "逗号分隔，最多 20 个；值为 review|test" },
      finding_id: { type: "string", description: "逗号分隔，最多 50 个 Finding UUID" },
      job_id: { type: "string", description: "逗号分隔，最多 50 个 Job UUID" },
    },
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["items", "after", "next_cursor", "has_more", "watermark", "live"],
        properties: {
          items: { type: "array", items: FactSummarySchema },
          after: { type: "string", nullable: true },
          next_cursor: { type: "string", nullable: true },
          has_more: { type: "boolean" },
          watermark: { type: "string" },
          live: { type: "boolean" },
        },
      },
    },
  },
  {
    method: "get",
    path: "/canvases/{id}/facts/{nodeId}",
    summary: "画布 Fact 完整详情与直接证据链路",
    scope: "tasks:read",
    tags: ["Tasks"],
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["fact", "finding", "job", "trace"],
        properties: {
          fact: {
            type: "object",
            additionalProperties: false,
            required: ["id", "canvas_id", "title", "description", "body_json", "verification_status", "job_id", "created_at", "updated_at", "verification"],
            properties: {
              id: { type: "string", format: "uuid" },
              canvas_id: { type: "string", format: "uuid" },
              title: { type: "string" },
              description: { type: "string" },
              body_json: { type: "object", additionalProperties: true },
              verification_status: { type: "string", enum: ["unverified", "verifying", "verified", "rejected", "needs_human"] },
              job_id: { type: "string", format: "uuid", nullable: true },
              created_at: { type: "string", format: "date-time" },
              updated_at: { type: "string", format: "date-time" },
              verification: FactVerificationSchema,
            },
          },
          finding: FactFindingSchema,
          job: FactJobSchema,
          trace: {
            type: "object",
            additionalProperties: false,
            required: ["nodes", "edges"],
            properties: {
              nodes: { type: "array", maxItems: 101, items: { type: "object", additionalProperties: true } },
              edges: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: true } },
            },
          },
        },
      },
    },
  },
  {
    method: "patch",
    path: "/canvases/{id}/facts/{nodeId}/verification",
    summary: "人工更新 Fact 验证态",
    scope: "jobs:control",
    tags: ["Tasks"],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["verified", "rejected", "needs_human"] },
        note: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["fact"],
        properties: { fact: FactSummarySchema },
      },
    },
  },
  {
    method: "post",
    path: "/tasks/{canvasId}/pause",
    summary: "暂停任务领取新 Job（已运行 Job 安全收尾）",
    scope: "jobs:control",
    tags: ["Tasks"],
    responses: { "200": TaskExecutionControlResponseSchema },
  },
  {
    method: "post",
    path: "/tasks/{canvasId}/start",
    summary: "解除任务暂停并唤醒调度",
    description: "不清除定时计划，也不重试 failed/orphan/cancelled Job；归档任务返回 409。",
    scope: "jobs:control",
    tags: ["Tasks"],
    responses: { "200": TaskExecutionControlResponseSchema },
  },
  {
    method: "post",
    path: "/tasks/{canvasId}/resume-session",
    summary: "继续任务：优先使用旧冻结快照批量重跑启动中断 Worker（同 Job ID、新 Attempt）",
    description:
      "画布无活动 Job 时，先将全部启动中断的 role Worker 原地重新入队；旧 Attempt 与 unknown/never effect 保留且不自动重放。批次或单 Job 中任一冻结快照相对当前受治理身份过期时返回 409 SNAPSHOT_STALE 与 job_ids，不会静默使用旧模型；调用方应逐 Job 使用 rerun-current。无中断批次时才恢复单个可恢复 Job或唤醒 Hub。唤醒 Hub 时若当前 RoleConfig/Credential 无法解析，同样返回 409 SNAPSHOT_STALE。",
    scope: "jobs:control",
    tags: ["Tasks"],
    responses: { "200": TaskResumeResponseSchema },
  },
  {
    method: "post",
    path: "/tasks/{canvasId}/retry",
    summary: "重试任务（清空历史后从意图重跑）",
    description: "清空本画布运行数据后按当前 RoleConfig/Credential 重冻入口 Hub。当前配置无法解析时返回 409 SNAPSHOT_STALE 且不清空现有数据。",
    scope: "jobs:control",
    tags: ["Tasks"],
  },
  {
    method: "patch",
    path: "/tasks/{canvasId}",
    summary: "更新任务标题与内容（不改写已冻结 Job 快照）",
    description:
      "同步 canvases.title 与 target_json.title/content/goal，并更新 root 节点标题/body。只影响后续 Hub 读图、新派生 Job 与显式重试；不改写已在跑或已结束 Job 的 agent_snapshot_json。归档任务返回 409 TASK_ARCHIVED。",
    scope: "tasks:write",
    tags: ["Tasks"],
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        content: { type: "string", minLength: 1, maxLength: 20000, description: "必要背景、边界与完成标准；同步写入 target_json.content 与 goal" },
      },
    },
    responses: {
      "200": {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "target_json", "has_active_jobs", "snapshot_rewritten", "message"],
        properties: {
          id: { type: "string", format: "uuid" },
          project_id: { type: "string", format: "uuid" },
          title: { type: "string" },
          status: { type: "string" },
          archived_at: { type: ["string", "null"] },
          target_json: { type: "object", additionalProperties: true },
          has_active_jobs: { type: "boolean" },
          snapshot_rewritten: { type: "boolean", enum: [false] },
          message: { type: "string" },
        },
      },
    },
  },
  // jobs
  {
    method: "post",
    path: "/jobs",
    summary: "直接创建 job",
    scope: "tasks:write",
    tags: ["Jobs"],
    body: {
      type: "object",
      required: ["project_id", "type"],
      properties: {
        project_id: { type: "string", format: "uuid" },
        type: {
          type: "string",
          description:
            "Registered public role name. Public POST rejects scheduler-owned hub_reason, hub, verify_finding, and report (409). verify is compatibility-only for runtime-image smoke; its scheduling purpose cannot be spoofed. Canonical system jobs are created by the Scheduler.",
        },
        title: { type: "string" },
        payload: { type: "object", additionalProperties: true },
        priority: { type: "integer", description: "可选；必须等于系统固定调度档位" },
        timeout_sec: { type: "integer" },
        stall_sec: { type: "integer", minimum: 0, description: "本 Job 产出停滞窗口；0 关闭。优先于角色/项目/平台。" },
        max_requests: { type: "integer", minimum: 0, description: "本 Job Token 请求上限；0 不限制。" },
      },
    },
  },
  {
    method: "get",
    path: "/jobs",
    summary: "Job 列表",
    scope: "tasks:read",
    tags: ["Jobs"],
    query: { project_id: { type: "string", format: "uuid" }, status: { type: "string" } },
  },
  { method: "get", path: "/jobs/{id}", summary: "Job 详情（含事件）", scope: "tasks:read", tags: ["Jobs"] },
  {
    method: "get",
    path: "/jobs/{id}/evidence",
    summary: "Job 原始证据 manifest（含有界 synthetic inflight 回退）",
    description:
      "finalized manifest 缺失但 attempts/*/stream.ndjson 存在时返回有界 synthetic/inflight manifest。已销毁沙箱中的 Session 不会伪造，原因通过 capture_error 返回。",
    scope: "tasks:read",
    tags: ["Jobs"],
    responses: { "200": JobEvidenceResponseSchema },
  },
  {
    method: "get",
    path: "/jobs/{id}/evidence/session",
    summary: "查看 Agent CLI 原始 Session",
    description:
      "默认返回主 Session / vendor export。query path 选择 manifest 中的 main / subagent / vendor_export 文件。在线预览最多 8 MiB，超限 truncated=true；完整字节走 download。artifacts 列出全部可切换归档。",
    scope: "tasks:read",
    tags: ["Jobs"],
    query: {
      path: { type: "string", description: "manifest 中的 Session 归档相对路径" },
    },
  },
  {
    method: "get",
    path: "/jobs/{id}/evidence/session/download",
    summary: "下载 Agent CLI 原始 Session",
    description: "下载所选 Session 归档全文。query path 与查看接口相同，默认主 Session。",
    scope: "tasks:read",
    tags: ["Jobs"],
    query: {
      path: { type: "string", description: "manifest 中的 Session 归档相对路径" },
    },
  },
  { method: "get", path: "/jobs/{id}/evidence/stream", summary: "读取历史 normalized stream", scope: "tasks:read", tags: ["Jobs"] },
  {
    method: "patch",
    path: "/jobs/{id}/priority",
    summary: "校验并写入 pending Job 的固定调度档位",
    scope: "jobs:control",
    tags: ["Jobs"],
    body: {
      type: "object",
      required: ["priority"],
      properties: { priority: { type: "integer", description: "不得跨越固定语义档位" } },
    },
  },
  { method: "post", path: "/jobs/{id}/cancel", summary: "取消 job", scope: "jobs:control", tags: ["Jobs"] },
  {
    method: "post",
    path: "/jobs/{id}/resume",
    summary: "使用旧冻结快照重新执行（同 Job、新 Attempt）",
    description:
      "仅 failed/timeout/orphan/waiting_human。先按当前 RoleConfig/Credential/项目策略解析受治理运行身份；agent_cli/model/upstream_model/credential/runtime adapter/image digest 等身份漂移或当前配置无法解析时返回 409 SNAPSHOT_STALE，并提示调用 rerun-current。成功时保留画布和旧 Attempt/effect，清理执行元数据并原子转 pending。",
    scope: "jobs:control",
    tags: ["Jobs"],
  },
  {
    method: "post",
    path: "/jobs/{id}/rerun-current",
    summary: "按当前配置重新执行（同 Job、新 Attempt、保留画布）",
    description:
      "仅 failed/timeout/orphan/waiting_human。持有 Dispatcher admission lock，并按 Canvas→Job 加锁；复用当前 RoleConfig/Credential/项目网络、共享资产与 runtime image 策略完整重冻 agent_snapshot_json，再原子转 pending。payload/parent/canvas/Intent/Fact/Finding 与旧 Attempt/effect 保持不变。",
    scope: "jobs:control",
    tags: ["Jobs"],
  },

  // findings / reports
  {
    method: "get",
    path: "/findings",
    summary: "Finding 列表（SARIF 对齐）",
    scope: "findings:read",
    tags: ["Findings"],
    query: {
      project_id: { type: "string", format: "uuid" },
      canvas_id: { type: "string" },
      severity: { type: "string" },
      profile: { type: "string" },
      category: { type: "string" },
      verify_status: { type: "string" },
      disposition: { type: "string", enum: [...FINDING_DISPOSITIONS] },
    },
  },
  {
    method: "get",
    path: "/findings/{id}",
    summary: "Finding 完整详情与结构化验证追踪",
    description: "trace 仅投影同画布的结构化来源、review/test 证据、Fact/Intent 有向流、Verify 轮次与 exact Hub 关联；不从 prompt 推断关系。",
    scope: "findings:read",
    tags: ["Findings"],
  },
  {
    method: "patch",
    path: "/findings/{id}/disposition",
    summary: "人工更新 Finding 处置态",
    description: "disposition 为人工业务闭环；confirmed_vuln 仍要求 verify_status=confirmed，不得旁路技术确认。",
    scope: "findings:write",
    tags: ["Findings"],
    body: {
      type: "object",
      required: ["disposition"],
      additionalProperties: false,
      properties: {
        disposition: { type: "string", enum: [...FINDING_DISPOSITIONS] },
        note: { type: "string", maxLength: 2000 },
      },
    },
  },
  {
    method: "patch",
    path: "/findings/{id}/verify-status",
    summary: "人工将等待中的 Finding 收口为 needs_human",
    description: "仅允许同画布存在 waiting_human Hub Job 且尚未 confirmed 的 Finding；confirmed 只能由 Scheduler Verify 收口。",
    scope: "findings:write",
    tags: ["Findings"],
    body: {
      type: "object",
      required: ["verify_status"],
      additionalProperties: false,
      properties: {
        verify_status: { type: "string", enum: ["needs_human"] },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
  },
  {
    method: "post",
    path: "/findings/{id}/verify",
    summary: "人工强制创建下一轮 Verify",
    description: "显式人工动作可绕过严重度与已有证据门，但不绕过活动 Verify 唯一约束、最大轮次、画布归属和锁序。",
    scope: "jobs:control",
    tags: ["Findings"],
    successStatus: "202",
    body: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } },
    },
    responses: {
      "202": {
        type: "object",
        additionalProperties: false,
        required: ["finding_id", "verify_job_id", "round_id", "attempt", "resumed_job_id"],
        properties: {
          finding_id: { type: "string", format: "uuid" },
          verify_job_id: { type: "string", format: "uuid" },
          round_id: { type: "string", format: "uuid" },
          attempt: { type: "integer", minimum: 1 },
          resumed_job_id: { type: "string", format: "uuid", nullable: true },
        },
      },
    },
  },
  {
    method: "post",
    path: "/findings/{id}/evidence-jobs",
    summary: "人工创建结构化补证 Job",
    description: "Scheduler 创建全新的 review/test Job，并冻结 finding_id、runtime snapshot、priority 与 verification_followup。",
    scope: "jobs:control",
    tags: ["Findings"],
    successStatus: "202",
    body: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: { role: { type: "string", enum: ["review", "test"] } },
    },
    responses: {
      "202": {
        type: "object",
        additionalProperties: false,
        required: ["finding_id", "job_id", "role", "resumed_job_id"],
        properties: {
          finding_id: { type: "string", format: "uuid" },
          job_id: { type: "string", format: "uuid" },
          role: { type: "string", enum: ["review", "test"] },
          resumed_job_id: { type: "string", format: "uuid", nullable: true },
        },
      },
    },
  },
  {
    method: "get",
    path: "/findings/{id}/report",
    summary: "读取最新单 Finding 报告元数据",
    scope: "findings:read",
    tags: ["Reports"],
  },
  {
    method: "post",
    path: "/findings/{id}/report",
    summary: "为 confirmed Finding 生成或刷新版本化报告",
    description: "同一 Finding 最多一个活动报告；刷新追加版本，不改写 Finding 技术状态。",
    scope: "jobs:control",
    tags: ["Reports"],
  },
  {
    method: "get",
    path: "/canvases/{id}/report",
    summary: "画布最新任务报告元数据",
    scope: "tasks:read",
    tags: ["Reports"],
    responses: {
      "200": {
        type: "object",
        required: ["id", "canvas_id", "project_id", "version", "status", "input_uri", "input_sha256"],
        properties: {
          id: { type: "string", format: "uuid" },
          canvas_id: { type: "string" },
          project_id: { type: "string", format: "uuid" },
          version: { type: "integer", minimum: 1 },
          status: { type: "string", enum: ["pending", "generating", "succeeded", "failed"] },
          input_uri: { type: "string" },
          input_sha256: { type: "string" },
          markdown_uri: { type: "string", nullable: true },
          sarif_uri: { type: "string", nullable: true },
          summary_json: { type: "object", additionalProperties: true },
          error: { type: "string", nullable: true },
        },
      },
      "404": {
        description: "任务报告尚未生成，返回当前服务端完成门阻塞原因",
        type: "object",
        required: ["error", "reason", "blocking_findings"],
        properties: {
          error: { type: "string" },
          reason: {
            type: "string",
            enum: [
              "canvas_not_found",
              "root_not_found",
              "root_not_ready",
              "active_work",
              "no_role_work",
              "findings_not_converged",
              "report_not_dispatched",
            ],
          },
          root_status: { type: "string", nullable: true },
          min_verify_severity: { type: "string", nullable: true },
          blockers: { type: "array", items: { type: "string" } },
          blocking_findings: {
            type: "array",
            items: {
              type: "object",
              required: ["finding_id", "title", "verify_status", "issue"],
              properties: {
                finding_id: { type: "string" },
                title: { type: "string" },
                severity: { type: "string", nullable: true },
                verify_status: { type: "string" },
                issue: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/canvases/{id}/reports",
    summary: "按版本倒序读取画布任务报告历史",
    scope: "tasks:read",
    tags: ["Reports"],
  },
  {
    method: "get",
    path: "/canvases/{id}/report/availability",
    summary: "读取任务报告完成门状态",
    description: "报告尚未生成时返回服务端权威的 Root、活跃工作、阈值和阻塞 Finding 状态；不修改任务状态。",
    scope: "tasks:read",
    tags: ["Reports"],
    responses: {
      "200": {
        type: "object",
        required: ["reason", "blocking_findings"],
        properties: {
          reason: { type: "string" },
          root_status: { type: "string", nullable: true },
          min_verify_severity: { type: "string", nullable: true },
          blockers: { type: "array", items: { type: "string" } },
          blocking_findings: {
            type: "array",
            items: {
              type: "object",
              required: ["finding_id", "title", "verify_status", "issue"],
              properties: {
                finding_id: { type: "string" },
                title: { type: "string" },
                severity: { type: "string", nullable: true },
                verify_status: { type: "string" },
                issue: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/reports/{id}/markdown",
    summary: "下载 Markdown 报告",
    description: "仅返回服务端已生成的 Markdown 文件；响应为 attachment，不是 JSON。",
    scope: "tasks:read | findings:read",
    tags: ["Reports"],
    responses: {
      "200": {
        description: "Markdown attachment",
        headers: {
          "Content-Disposition": {
            description: "安全的 report-<id>.md 下载文件名",
            schema: { type: "string" },
          },
        },
        content: { "text/markdown": { schema: { type: "string", format: "binary" } } },
      },
    },
  },
  {
    method: "get",
    path: "/reports/{id}/sarif",
    summary: "下载 SARIF 报告",
    description: "仅返回服务端已生成的 SARIF 2.1.0 文件；响应为 attachment，不是 JSON。",
    scope: "tasks:read",
    tags: ["Reports"],
    responses: {
      "200": {
        description: "SARIF attachment",
        headers: {
          "Content-Disposition": {
            description: "安全的 report-<id>.sarif 下载文件名",
            schema: { type: "string" },
          },
        },
        content: { "application/sarif+json": { schema: { type: "string", format: "binary" } } },
      },
    },
  },
  {
    method: "post",
    path: "/canvases/{id}/report/retry",
    summary: "失败报告重试",
    scope: "jobs:control",
    tags: ["Reports"],
    responses: {
      "200": {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" }, report_id: { type: "string", format: "uuid" } },
      },
      "409": {
        description: "报告尚未失败、已经成功或不满足重试门禁",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  },
  {
    method: "post",
    path: "/canvases/{id}/report/refresh",
    summary: "按当前收敛输入刷新任务报告",
    description: "输入摘要不变时幂等返回；发生变化时追加版本，不覆盖历史报告。",
    scope: "jobs:control",
    tags: ["Reports"],
  },

  // settings
  { method: "get", path: "/global-settings", summary: "全局规则", scope: "agents:read", tags: ["Settings"] },
  {
    method: "patch",
    path: "/global-settings",
    summary: "合并更新全局规则",
    scope: "agents:write",
    tags: ["Settings"],
    body: {
      type: "object",
      required: ["rules"],
      properties: {
        rules: {
          type: "object",
          additionalProperties: true,
          description: "全局规则。maxGlobalJobs / maxJobsPerProject / maxConcurrentProvisioning 为 1–1000；stallSec / jobTokenMaxRequests 为 0–上限（0=不限制）；auditTimeoutSec / verifyTimeoutSec / provisionTimeoutSec 为配置中心第一批；maxConcurrentJobs 只能写在项目设置。",
        },
      },
    },
  },
  { method: "get", path: "/projects/{id}/settings", summary: "项目规则、角色启用与镜像策略", scope: "agents:read", tags: ["Settings"] },
  {
    method: "get",
    path: "/readiness",
    summary: "Global task readiness/preflight",
    description: "Read-only checks for governed Hub/Worker RoleConfig, Credential and CLI/model compatibility, connection/model evidence, trusted real-mode runtime images, and network/material policy. Secrets, env names and arbitrary OCI refs are never returned.",
    scope: "agents:read",
    tags: ["Settings"],
    query: {
      allow_egress: { type: "string", enum: ["true", "false"], description: "Optional task network override; does not persist or create a task." },
      material_source: { type: "string", enum: ["workspace_or_offline", "external_or_workspace", "declared", "unspecified"] },
    },
    responses: { "200": { $ref: "#/components/schemas/ReadinessResponse" } },
  },
  {
    method: "get",
    path: "/projects/{id}/readiness",
    summary: "Project task readiness/preflight",
    description: "Uses the project role enablement list and effective network default; allow_egress simulates one task override only.",
    scope: "agents:read",
    tags: ["Settings"],
    query: {
      allow_egress: { type: "string", enum: ["true", "false"], description: "Optional task network override; does not persist or create a task." },
      material_source: { type: "string", enum: ["workspace_or_offline", "external_or_workspace", "declared", "unspecified"] },
    },
    responses: { "200": { $ref: "#/components/schemas/ReadinessResponse" } },
  },
  {
    method: "patch",
    path: "/projects/{id}/settings",
    summary: "更新项目规则、角色启用清单与镜像策略",
    scope: "agents:write",
    tags: ["Settings"],
    body: {
      type: "object",
      properties: {
        rules: {
          type: "object",
          additionalProperties: true,
          description: "项目规则覆盖。maxConcurrentJobs 为 0–1000 或 null（清除后继承全局 maxJobsPerProject）；不得修改全局并发键。",
        },
        roles: {
          type: "object",
          properties: {
            enabled: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          },
        },
        image_strategy: { type: "string", enum: ["inherit_global", "project_managed"] },
        role_runtime_images: {
          type: "object",
          additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] },
          description: "project_managed 策略下的角色镜像选择；null 表示系统基础环境",
        },
      },
    },
  },

  // roles
  {
    method: "get",
    path: "/agent-roles",
    summary: "角色注册表（含调度器分配色）",
    description: "读取全局角色注册表。项目限定 token 可读取注册表，但不能创建、修改或删除角色（写操作返回 403 PROJECT_SCOPE_FORBIDDEN）。",
    scope: "agents:read",
    tags: ["Roles"],
  },
  {
    method: "post",
    path: "/agent-roles",
    summary: "创建角色（颜色由调度器分配）",
    description: "仅 unscoped/admin actor 可修改全局角色注册表；项目限定 token 返回 403 PROJECT_SCOPE_FORBIDDEN。",
    scope: "agents:write",
    tags: ["Roles"],
    body: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "即 job.type" },
        title: { type: "string" },
        description: { type: "string" },
      },
    },
  },
  {
    method: "patch",
    path: "/agent-roles/{id}",
    summary: "更新角色（name 不可改）",
    description: "仅 unscoped/admin actor 可修改全局角色注册表；项目限定 token 返回 403 PROJECT_SCOPE_FORBIDDEN。",
    scope: "agents:write",
    tags: ["Roles"],
  },
  {
    method: "delete",
    path: "/agent-roles/{id}",
    summary: "删除 Hub 可下发角色（系统/Hub 角色 409）",
    description: "仅 unscoped/admin actor 可修改全局角色注册表；项目限定 token 返回 403 PROJECT_SCOPE_FORBIDDEN。",
    scope: "agents:write",
    tags: ["Roles"],
  },
  { method: "get", path: "/projects/{id}/roles", summary: "项目视角角色启用清单", scope: "agents:read", tags: ["Roles"] },

  // role-configs
  {
    method: "get",
    path: "/role-configs/global",
    summary: "全局 RoleConfig 清单",
    description: "项目限定 token 可读取全局 RoleConfig，但响应中的 Credential 绑定仅包含全局或该 token 所属项目的 Credential；异常跨项目绑定按未绑定处理。",
    scope: "agents:read",
    tags: ["RoleConfig"],
  },
  {
    method: "get",
    path: "/role-configs/bindable",
    summary: "统一 Provider 绑定选择器（全局/项目 RoleConfig 元数据）",
    description: "项目限定 token 只能看到全局与本项目 RoleConfig；Credential 元数据也只返回全局或本项目绑定，异常跨项目绑定不返回 Credential 字段。",
    scope: "agents:read",
    tags: ["RoleConfig", "Credentials"],
    responses: {
      "200": {
        description: "Bindable RoleConfig metadata",
        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/BindableRoleConfig" } } } },
      },
    },
  },
  {
    method: "patch",
    path: "/role-configs/{id}/agent-cli",
    summary: "仅更新 RoleConfig 的 agent_cli（Provider 绑定列表用）",
    description: "不改写凭据绑定与配置文件。若已绑定 LLM Credential，会校验 CLI 与 Provider 兼容性；兼容时同步凭据 agent_cli 到角色新值，不兼容返回 409。",
    scope: "agents:write",
    tags: ["RoleConfig"],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["agent_cli"],
      properties: {
        agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"] },
      },
    },
  },
  {
    method: "patch",
    path: "/role-configs/{id}/runtime-image",
    summary: "仅更新全局 RoleConfig 的 runtime_image_key（Provider 绑定列表用）",
    description: "项目 RoleConfig 返回 400，项目镜像必须通过项目设置策略管理；全局配置的 null 表示系统默认底座（deepsonar-base）。",
    scope: "agents:write",
    tags: ["RoleConfig", "RuntimeImages"],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["runtime_image_key"],
      properties: {
        runtime_image_key: { type: "string", nullable: true },
      },
    },
  },
  {
    method: "put",
    path: "/role-configs/global/{roleId}",
    summary: "全局 RoleConfig upsert（声明式全量替换）",
    description: "仅 unscoped/admin actor 可写全局 RoleConfig；项目限定 token 返回 403 PROJECT_SCOPE_FORBIDDEN。绑定 LLM 凭据的 agent_cli 与角色不一致时，provider 兼容则自动跟随并写审计，不兼容返回 400。",
    scope: "agents:write",
    tags: ["RoleConfig"],
    body: { $ref: "#/components/schemas/RoleConfigInput" },
  },
  {
    method: "get",
    path: "/projects/{id}/role-configs",
    summary: "项目 RoleConfig 来源清单",
    description: "项目限定 token 只能读取所属项目；RoleConfig Credential 绑定仅包含全局或该项目 Credential。",
    scope: "agents:read",
    tags: ["RoleConfig"],
  },
  {
    method: "put",
    path: "/projects/{id}/role-configs/{roleId}",
    summary: "项目 RoleConfig 覆盖 upsert",
    description: "项目限定 token 只能写所属项目 RoleConfig；runtime_image_key 非 null 返回 400，项目镜像必须通过项目设置策略管理；跨项目访问返回 403 PROJECT_SCOPE_FORBIDDEN。绑定 LLM 凭据的 agent_cli 与角色不一致时，provider 兼容则自动跟随并写审计，不兼容返回 400。",
    scope: "agents:write",
    tags: ["RoleConfig"],
    body: { $ref: "#/components/schemas/RoleConfigInput" },
  },
  {
    method: "delete",
    path: "/projects/{id}/role-configs/{roleId}",
    summary: "删除项目覆盖，回落全局",
    description: "项目限定 token 只能删除所属项目 RoleConfig 覆盖；跨项目访问返回 403 PROJECT_SCOPE_FORBIDDEN。",
    scope: "agents:write",
    tags: ["RoleConfig"],
  },

  // trusted runtime image catalog / marketplace
  {
    method: "get",
    path: "/runtime-images",
    summary: "镜像市场列表（可按项目和关键字过滤）。项目作用域返回 selected_version / pin_stale / pin_policy：官方 stale pin 会在 catalog 提升时自动滚到最新 trusted，hold 与第三方除外。",
    scope: "images:read",
    tags: ["Runtime Images"],
    query: { project_id: { type: "string", format: "uuid" }, search: { type: "string" } },
  },
  {
    method: "get",
    path: "/runtime-images/registry",
    summary: "获取静态注册表及官方环境覆盖的最新清单",
    scope: "images:read",
    tags: ["Runtime Images"],
    description: "仅返回经过解析校验的不可变 @sha256:64hex 版本；未核实的官方 digest 不会被静态清单伪造。响应保留 schema/images 字段，并附 selected_channel=github|dockerhub|aliyun-acr、source=remote|bundled、fallback、error（脱敏）和 checked_at 元数据。selected_channel 由平台全局设置决定，不接受 query、env 或请求体覆盖。私有 GitHub Release 可通过 DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN 读取；凭据只发往 github.com/api.github.com。",
    responses: {
      "200": {
        description: "注册表清单与平台选中的官方分发通道",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["schema", "images", "selected_channel"],
              properties: {
                schema: { type: "string", enum: ["deepsonar.registry/v1", "deepsonar.registry/v2"] },
                schema_version: { type: "integer", enum: [1, 2] },
                images: { type: "array", items: { type: "object", additionalProperties: true } },
                selected_channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
                source: { type: "string", enum: ["remote", "bundled", "upload"] },
                fallback: { type: "boolean" },
                error: { type: "string", nullable: true },
                checked_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "patch",
    path: "/runtime-images/registry/channel",
    summary: "切换官方运行时镜像分发通道",
    description: "仅 unscoped/admin actor 可在 github、dockerhub、aliyun-acr 间修改平台全局通道；项目限定 token 返回 403 PROJECT_SCOPE_FORBIDDEN。先异步准备全局默认与现存项目有效镜像；缺图时把引用加入本机拉取队列并返回 202 preparing/saved:false 与当前整队列 pull-status，旧通道保持有效，准备完成后重试才提交。与项目启用共用同一队列，不抢占以免丢掉已入队项。绝不跨通道回退，历史 Job 快照不改写。",
    scope: "images:manage",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
      },
    },
    responses: {
      "200": {
        description: "通道已切换",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["selected_channel", "previous_channel"],
              properties: {
                selected_channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
                previous_channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
              },
            },
          },
        },
      },
      "202": {
        description: "镜像尚未就绪或已有准备任务，通道未落库",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["status", "saved", "selected_channel", "proposed_channel", "task"],
              properties: {
                status: { type: "string", enum: ["preparing"] },
                saved: { type: "boolean", enum: [false] },
                selected_channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
                proposed_channel: { type: "string", enum: [...RUNTIME_IMAGE_REGISTRY_CHANNELS] },
                task: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
      "400": { description: "通道请求体无效", content: { "application/json": { schema: RuntimeRegistryChannelErrorSchema } } },
      "403": { description: "项目限定 token 不得修改全局通道", content: { "application/json": { schema: RuntimeRegistryChannelErrorSchema } } },
      "500": { description: "全局通道更新失败", content: { "application/json": { schema: RuntimeRegistryChannelErrorSchema } } },
    },
  },
  {
    method: "post",
    path: "/runtime-images/registry/sync",
    summary: "同步当前部署内置镜像市场文件",
    description: "重新读取并校验当前部署内的注册表文件与环境变量覆盖，幂等同步官方产品和版本到本地数据库；不会联网获取任意 URL。",
    scope: "images:manage",
    tags: ["Runtime Images"],
  },
  {
    method: "post",
    path: "/runtime-images/registry/pull",
    summary: "异步拉取同步后的远程不可变镜像",
    description: "仅按平台当前 selected_channel 后台执行无 shell 的 docker pull；默认每个官方产品只拉最新一条可用版本（历史 trusted digest 保留给 pin/Job 快照，不批量预热）。缺少该通道引用时返回 409 RUNTIME_IMAGE_CHANNEL_UNAVAILABLE，绝不跨通道降级。本地 raw image ID 不会进入任务。",
    scope: "images:manage",
    tags: ["Runtime Images"],
    responses: {
      "409": {
        description: "所选官方镜像通道没有可用的可信不可变引用",
        content: { "application/json": { schema: RuntimeImageChannelUnavailableSchema } },
      },
    },
  },
  {
    method: "get",
    path: "/runtime-images/registry/pull-status",
    summary: "查询运行时镜像异步拉取状态",
    description: "返回当前 Scheduler 单实例内存任务；服务重启后返回 idle，不持久化任务。",
    scope: "images:read",
    tags: ["Runtime Images"],
  },
  {
    method: "post",
    path: "/runtime-images/{id}/detect-local",
    summary: "只读检测本地 Docker 运行时镜像",
    description: "输入 runtime image product UUID 与 image_ref（可为本地 tag）；服务端使用无 shell docker image inspect 返回存在性、Id、RepoDigests、os/arch、契约/产品/工具清单标签、不可变采用引用与 reasons。检测不会写库，也不会因 mutable tag 自动信任。",
    scope: "images:read",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["image_ref"],
      properties: { image_ref: { type: "string", description: "本地 tag、digest 或完整 sha256 image ID" } },
    },
  },
  {
    method: "post",
    path: "/runtime-images/{id}/adopt-local",
    summary: "管理员显式采用已检测的本地运行时镜像",
    description: "仅适用于官方产品；第三方镜像仍须走导入、准入扫描与批准。接口再次 inspect 防 TOCTOU，要求 expected_image_id 与当前 Id 一致，并通过 contract、产品 image-key/toolset 兼容标签、/opt/deepsonar/tool-manifest.json 门禁。优先采用匹配产品仓库 RepoDigest，否则使用完整 sha256 image ID；写入 trusted/local-only 与审计，不自动授权项目。",
    scope: "images:approve",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["image_ref", "expected_image_id"],
      properties: {
        image_ref: { type: "string" },
        expected_image_id: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        version: { type: "string" },
      },
    },
  },
  {
    method: "post",
    path: "/runtime-images/{id}/official-digest",
    summary: "登记官方镜像 registry 或本地构建 digest",
    description: "默认 source=registry，仅接受 allowlist 内的 name@sha256:64hex；source=local-build 时仅允许 local-docker、官方产品和完整 sha256:64hex 本地 image ID，服务端通过无 shell docker image inspect 校验 contract、产品 image-key/toolset 兼容标签与工具清单路径后直接 trusted，不创建扫描记录，不进入 registry 导出清单。旧版 tools-manifest/toolset 标签仍受兼容门禁约束。",
    scope: "images:approve",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["image_ref"],
      properties: {
        image_ref: { type: "string", description: "registry: name@sha256:64hex；local-build: sha256:64hex" },
        version: { type: "string" },
        source: { type: "string", enum: ["registry", "local-build"], default: "registry" },
      },
    },
  },
  { method: "get", path: "/runtime-images/{id}", summary: "镜像、不可变版本与准入扫描证据", scope: "images:read", tags: ["Runtime Images"] },
  {
    method: "post",
    path: "/runtime-images/import",
    summary: "导入第三方 OCI 镜像到隔离区",
    scope: "images:manage",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["image_key", "name", "publisher", "image_ref"],
      properties: {
        image_key: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        publisher: { type: "string" },
        source_url: { type: "string", format: "uri" },
        image_ref: { type: "string", description: "受 registry allowlist 限制；tag 将由准入 Worker 解析为 digest" },
        version: { type: "string" },
        registry_credential_id: { type: "string", format: "uuid" },
      },
    },
  },
  {
    method: "post",
    path: "/runtime-images/manual-digest",
    summary: "管理员手动登记非官方镜像 digest 并直接信任",
    description: "需要 images:approve（admin 隐式拥有）。仅允许 registry allowlist 内的不可变 @sha256:64hex；不创建准入扫描记录，调用方必须自行承担绕过扫描的供应链风险。官方产品不能通过此接口绕过官方约束，非官方镜像仍需项目显式启用。",
    scope: "images:approve",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["image_key", "name", "publisher", "image_ref"],
      properties: {
        image_key: { type: "string", description: "非官方产品 key" },
        name: { type: "string" },
        description: { type: "string" },
        publisher: { type: "string" },
        source_url: { type: "string", format: "uri" },
        image_ref: { type: "string", description: "必须是 registry/path@sha256:64hex，且 registry 在 allowlist 内" },
        version: { type: "string" },
      },
    },
  },
  { method: "post", path: "/runtime-image-versions/{id}/rescan", summary: "将镜像版本重新送入准入扫描", scope: "images:manage", tags: ["Runtime Images"] },
  {
    method: "post",
    path: "/runtime-image-versions/{id}/status",
    summary: "批准、拒绝、禁用或撤销镜像版本",
    scope: "images:approve",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["trusted", "rejected", "disabled", "revoked"] },
        reason: { type: "string" },
      },
    },
  },
  { method: "get", path: "/runtime-image-versions/{id}/usage", summary: "反向查询使用该镜像版本的 Job、项目与 Finding 数量", scope: "images:read", tags: ["Runtime Images"] },
  {
    method: "put",
    path: "/projects/{id}/runtime-images/{imageId}",
    summary: "项目启用/停用可信镜像。version_id 省略或 null 表示跟随最新 trusted；显式 UUID 为 pin。官方 stale pin 在 catalog 提升时自动滚到最新 trusted；pin_policy=hold 或第三方 pin 不自动改写。本机缺层时把不可变引用入队（按 digest 去重、串行拉取），返回 202 preparing/saved:false 与整队列 pull-status，不因其它产品正在拉取而 409。该项就绪后才落库；Job 执行期仍只 inspect。",
    scope: "images:manage",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        version_id: { type: "string", format: "uuid", nullable: true },
        pin_policy: { type: "string", enum: ["follow", "hold"], description: "hold 钉死当前官方 pin，catalog 提升时不自动滚动；跟随最新时强制 follow" },
      },
    },
  },

  // skill sources
  { method: "get", path: "/skill-sources", summary: "模块源列表", scope: "skills:read", tags: ["Skills"] },
  { method: "get", path: "/skill-sources/{id}", summary: "模块源目录详情", scope: "skills:read", tags: ["Skills"] },
  {
    method: "post",
    path: "/skill-sources",
    summary: "登记模块源",
    scope: "skills:write",
    tags: ["Skills"],
    body: {
      type: "object",
      required: ["name", "repo_url"],
      properties: {
        name: { type: "string" },
        repo_url: { type: "string", description: "仅 https，host 受 DEEPSONAR_GIT_ALLOWED_HOSTS 约束" },
        branch: { type: "string", default: "main" },
      },
    },
  },
  { method: "post", path: "/skill-sources/{id}/sync", summary: "同步模块源（浅克隆；返回 changed 与新旧 commit）", scope: "skills:write", tags: ["Skills"] },
  {
    method: "post",
    path: "/skill-sources/{id}/trust",
    summary: "信任审批",
    scope: "skills:write",
    tags: ["Skills"],
    body: {
      type: "object",
      required: ["trust_status"],
      properties: {
        trust_status: { type: "string", enum: ["quarantined", "trusted", "disabled"] },
        enabled: { type: "boolean" },
      },
    },
  },
  { method: "delete", path: "/skill-sources/{id}", summary: "删除模块源", scope: "skills:write", tags: ["Skills"] },

  // credentials
  { method: "get", path: "/credentials", summary: "凭据列表（无密文）", scope: "agents:read", tags: ["Credentials"] },
  {
    method: "get",
    path: "/credentials/providers",
    summary: "Server-owned Provider/account catalog",
    scope: "agents:read",
    tags: ["Credentials"],
    responses: {
      "200": {
        description: "Authoritative provider catalog",
        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ProviderAccountCatalogItem" } } } },
      },
    },
  },
  { method: "get", path: "/credentials/{id}", summary: "凭据详情（健康、模型目录与绑定影响；无密文）", scope: "agents:read", tags: ["Credentials"] },
  {
    method: "get",
    path: "/credentials/{id}/impact",
    summary: "凭据只读影响投影（RoleConfig / pending / active / recoverable / historical Job / 活动扫描）",
    scope: "agents:read",
    tags: ["Credentials"],
    responses: {
      "200": {
        description: "有界影响投影。recoverable = failed/timeout/orphan（可被 resume 原地恢复）；scans.active = queued/claimed/running 的镜像准入扫描。",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialImpact" } } },
      },
    },
  },
  {
    method: "post",
    path: "/credentials",
    summary: "登记凭据（AES-GCM 加密）",
    scope: "agents:write",
    tags: ["Credentials"],
    body: {
      type: "object",
      required: ["name", "provider", "secret"],
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["llm_provider", "plane", "git", "oci_registry"] },
        provider: { type: "string", description: "LLM 仅允许协议 ID anthropic（Anthropic Messages）或 openai（OpenAI Responses）；OCI 使用 registry host" },
        secret: { type: "string" },
        project_id: { type: "string", format: "uuid", nullable: true },
        agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"], nullable: true },
        settings_config: { type: "object", additionalProperties: true, description: "完整 CLI 配置；运行时物化为 Agent 沙箱配置文件" },
        meta: { type: "object", additionalProperties: true },
        metadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            base_url: { type: "string", format: "uri", description: "仅 http/https；不得含 userinfo/query/fragment" },
            model_concurrency: { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 1000 } },
            max_concurrent: { type: "integer", minimum: 0, maximum: 1000 },
            registry: { type: "string", description: "OCI registry host/path（不含 scheme/userinfo/query/fragment）" },
            username: { type: "string", maxLength: 200, description: "OCI registry account name（非密钥）" },
          },
          description: "服务器拥有固定字段白名单；未知或 secret-like key 一律拒绝",
        },
      },
    },
  },
  {
    method: "patch",
    path: "/credentials/{id}",
    summary: "更新 Credential 配置（settings_config 中已保存密钥由服务端恢复）",
    scope: "agents:write",
    tags: ["Credentials"],
    body: {
      type: "object",
      properties: {
        name: { type: "string" },
        provider: { type: "string" },
        project_id: { type: "string", format: "uuid", nullable: true },
        metadata: { $ref: "#/components/schemas/CredentialMetadata" },
        agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"], nullable: true },
        settings_config: { type: "object", additionalProperties: true, description: "API 返回的 [已保存密钥] 可原样回传，服务端保留原值" },
        meta: { type: "object", additionalProperties: true },
      },
    },
  },
  {
    method: "post",
    path: "/credentials/{id}/rotate",
    summary: "轮换密钥",
    scope: "agents:write",
    tags: ["Credentials"],
    body: { type: "object", required: ["secret"], properties: { secret: { type: "string" } } },
  },
  {
    method: "delete",
    path: "/credentials/{id}",
    summary: "删除已保存的 Provider 账号",
    description: "有 pending 或 active/frozen Job（claimed/provisioning/running/waiting_human）时返回 409 CREDENTIAL_IN_USE。failed/timeout/orphan 可恢复历史不阻挡删除，影响投影仍列出。有 queued/claimed/running 镜像准入扫描时返回 409 CREDENTIAL_SCAN_IN_USE。仍绑定 RoleConfig 时需 ?unbind=true，并递增受影响 RoleConfig 的 version。吊销并删除 job_tokens；不改写历史 Job 快照。响应与审计不含密文；项目凭据审计保留 project_id。",
    scope: "agents:write",
    tags: ["Credentials"],
    query: {
      unbind: { type: "string", enum: ["true", "1"], description: "确认后解除 RoleConfig 绑定并删除" },
    },
    responses: {
      "200": {
        description: "已删除",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ok", "id"],
              properties: {
                ok: { type: "boolean" },
                id: { type: "string", format: "uuid" },
                unbound_role_config_count: { type: "integer" },
                revoked_job_token_count: { type: "integer" },
              },
            },
          },
        },
      },
      "409": {
        description: "仍被 RoleConfig 绑定、pending/active Job 或活动镜像准入扫描引用",
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/Error" },
                {
                  type: "object",
                  properties: {
                    error_code: {
                      type: "string",
                      enum: ["CREDENTIAL_IN_USE", "CREDENTIAL_BOUND", "CREDENTIAL_SCAN_IN_USE", "CREDENTIAL_CHANGED"],
                    },
                    impact: { $ref: "#/components/schemas/CredentialImpact" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/credentials/{id}/status",
    summary: "启用/禁用凭据",
    scope: "agents:write",
    tags: ["Credentials"],
    body: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string", enum: ["active", "disabled", "rotation_required"] } },
    },
  },
  { method: "post", path: "/credentials/{id}/test", summary: "连接测试", scope: "agents:write", tags: ["Credentials"] },
  { method: "post", path: "/credentials/{id}/models", summary: "从 Provider 实时获取模型目录", scope: "agents:write", tags: ["Credentials"] },
  {
    method: "post",
    path: "/credentials/models/preview",
    summary: "预览未保存 Credential 的模型目录（不落库）",
    scope: "agents:write",
    tags: ["Credentials"],
    body: {
      type: "object",
      required: ["agent_cli", "provider", "secret"],
      properties: {
        agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"] },
        provider: { type: "string", enum: ["anthropic", "openai"] },
        secret: { type: "string", minLength: 1, maxLength: 4096 },
        base_url: { type: "string", format: "uri" },
        metadata: { $ref: "#/components/schemas/CredentialMetadata" },
        settings_config: { type: "object", additionalProperties: true },
      },
    },
  },
  { method: "get", path: "/credentials/{id}/models", summary: "读取已持久化的安全模型目录", scope: "agents:read", tags: ["Credentials"] },
  {
    method: "get",
    path: "/credentials/{id}/compatibility",
    summary: "校验 Credential 与 Agent CLI/模型兼容性",
    scope: "agents:read",
    tags: ["Credentials"],
    query: {
      agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"] },
      model: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  {
    method: "post",
    path: "/credentials/batch-bind",
    summary: "Atomically bind or migrate one account across multiple RoleConfigs",
    description: "Validates provider/CLI/model compatibility under the dispatcher lock. Running/frozen Jobs are never changed. effect=new_jobs_only leaves pending snapshots frozen; effect=refresh_pending updates only pending snapshots.",
    scope: "agents:write",
    tags: ["Credentials", "RoleConfig"],
    body: { $ref: "#/components/schemas/CredentialBatchBindingRequest" },
    responses: {
      "200": {
        description: "Applied atomically",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingImpact" } } },
      },
      "400": {
        description: "Invalid provider or request; no binding mutation is applied",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingError" } } },
      },
      "409": {
        description: "Credential health/catalog/model gate failed; no binding mutation is applied",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingError" } } },
      },
      "403": {
        description: "Project scope or binding target is not permitted; no mutation is applied",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingError" } } },
      },
      "404": {
        description: "Credential or RoleConfig target was not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingError" } } },
      },
      "500": {
        description: "Transaction failed or stored idempotency result is invalid",
        content: { "application/json": { schema: { $ref: "#/components/schemas/CredentialBatchBindingError" } } },
      },
    },
  },

  // tokens
  { method: "get", path: "/tokens", summary: "API Token 列表", scope: "tokens:manage", tags: ["Tokens"] },
  {
    method: "post",
    path: "/tokens",
    summary: "创建 API Token（明文仅返回一次）",
    scope: "tokens:manage",
    tags: ["Tokens"],
    body: {
      type: "object",
      required: ["name", "scopes"],
      properties: {
        name: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        project_id: { type: "string", format: "uuid", nullable: true },
        expires_in_days: { type: "integer" },
      },
    },
  },
  { method: "post", path: "/tokens/{id}/revoke", summary: "吊销 Token", scope: "tokens:manage", tags: ["Tokens"] },
  { method: "post", path: "/tokens/{id}/rotate", summary: "轮换 Token", scope: "tokens:manage", tags: ["Tokens"] },

  // plane
  {
    method: "put",
    path: "/projects/{id}/integrations/plane",
    summary: "绑定 Plane 项目",
    scope: "integrations:write",
    tags: ["Plane"],
    body: { type: "object", required: ["plane_project_id"], properties: { plane_project_id: { type: "string" } } },
  },
  { method: "delete", path: "/projects/{id}/integrations/plane", summary: "解绑 Plane", scope: "integrations:write", tags: ["Plane"] },
  { method: "post", path: "/projects/{id}/integrations/plane/sync", summary: "手动同步 Plane", scope: "integrations:write", tags: ["Plane"] },
  { method: "get", path: "/plane-info", summary: "Plane 连接信息", scope: "integrations:read", tags: ["Plane"] },
  { method: "post", path: "/webhooks/plane", summary: "Plane webhook 入口", scope: null, tags: ["Plane"] },

  // audit
  { method: "get", path: "/audit-logs", summary: "审计日志", scope: "admin", tags: ["Admin"] },
];

function pathParams(p: string): Array<{ name: string; in: "path"; required: true; schema: { type: string; format?: string } }> {
  const names = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return names.map((name) => {
    const useUuid =
      name === "id" ||
      name === "roleId" ||
      (name.endsWith("Id") && !name.toLowerCase().includes("canvas"));
    return {
      name,
      in: "path" as const,
      required: true as const,
      schema: useUuid ? { type: "string", format: "uuid" } : { type: "string" },
    };
  });
}

function isFullResponse(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // A JSON Schema may itself carry `description`; only response-specific
  // members distinguish a complete OpenAPI Response Object here.
  return "content" in record || "headers" in record;
}

/** 构建 OpenAPI 3.0 文档对象 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPS) {
    const item = paths[op.path] ?? (paths[op.path] = {});
    const parameters = [
      ...pathParams(op.path),
      ...Object.entries(op.query ?? {}).map(([name, schema]) => ({
        name,
        in: "query" as const,
        required: op.requiredQuery?.includes(name) ?? false,
        schema,
      })),
    ];
    const declaredResponses = op.responses ?? {};
    const successStatus = op.successStatus ?? "200";
    const declaredSuccess = declaredResponses[successStatus];
    const successResponse = isFullResponse(declaredSuccess)
      ? declaredSuccess
      : {
          description: "成功",
          content: {
            "application/json": {
              schema: declaredSuccess ?? { type: "object", additionalProperties: true },
            },
          },
        };
    const operation: Record<string, unknown> = {
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      operationId: `${op.method}_${op.path.replace(/[{}/]/g, "_").replace(/_+/g, "_")}`,
      parameters: parameters.length ? parameters : undefined,
      security: op.scope === null ? [] : [{ bearerAuth: [] }],
      "x-deepsonar-scope": op.scope === null ? "exempt" : op.scope,
      responses: {
        [successStatus]: successResponse,
        "400": { description: "参数错误", content: { "application/json": { schema: ErrorSchema } } },
        "401": { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
        "403": { description: "权限不足", content: { "application/json": { schema: ErrorSchema } } },
        "404": { description: "不存在", content: { "application/json": { schema: ErrorSchema } } },
        "409": { description: "冲突", content: { "application/json": { schema: ErrorSchema } } },
        ...Object.fromEntries(Object.entries(declaredResponses).filter(([status]) => status !== successStatus)),
      },
    };
    if (op.body) {
      operation.requestBody = {
        required: true,
        content: { [op.bodyContentType ?? "application/json"]: { schema: op.body } },
      };
    }
    item[op.method] = operation;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "DeepSonar Scheduler API",
      version: "0.0.1",
      description:
        "多项目代码审计调度平台 HTTP API。Agent 只提案，调度器是唯一有副作用的执行者。" +
        " 人类可读摘要见 GET /schema.md；Management Skill 契约见 skills/deepsonar-management/references/api.md。" +
        " 运行时镜像官方目录支持 DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN（仅向 github.com/api.github.com 发送，重定向到 release-assets/objects 时丢弃）。",
    },
    servers: [
      {
        url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
        description: "当前调度器实例",
      },
    ],
    tags: [
      { name: "Meta" },
      { name: "Auth" },
      { name: "Dashboard" },
      { name: "Projects" },
      { name: "Tasks" },
      { name: "Jobs" },
      { name: "Findings" },
      { name: "Reports" },
      { name: "Settings" },
      { name: "Roles" },
      { name: "RoleConfig" },
      { name: "Runtime Images" },
      { name: "Skills" },
      { name: "Credentials" },
      { name: "Tokens" },
      { name: "Plane" },
      { name: "Profiles" },
      { name: "Admin" },
    ],
    paths,
    "x-deepsonar-environment": {
      DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN: {
        description: "可选的私有 GitHub Release 只读凭据；Scheduler 仅访问固定 SummerSec/DeepSonar 目录，绝不在 API 响应中返回。",
        secret: true,
        used_by: ["GET /runtime-images/registry", "POST /runtime-images/registry/sync"],
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "deepsonar_<env>_<prefix>_<secret>",
          description: "平台 API Token；DEEPSONAR_AUTH_REQUIRED=false 时本地回环可省略",
        },
      },
      schemas: {
        Error: ErrorSchema,
        DashboardStatusBucket: {
          type: "object",
          additionalProperties: false,
          required: ["key", "count"],
          properties: {
            key: { type: "string" },
            count: { type: "integer", minimum: 0 },
          },
        },
        DashboardPeriodCounts: {
          type: "object",
          additionalProperties: false,
          required: ["new_tasks", "completed_tasks", "new_findings"],
          properties: {
            new_tasks: { type: "integer", minimum: 0 },
            completed_tasks: { type: "integer", minimum: 0 },
            new_findings: { type: "integer", minimum: 0 },
          },
        },
        RuntimeRegistryChannelError: RuntimeRegistryChannelErrorSchema,
        CredentialImpact: {
          type: "object",
          required: ["credential_id", "role_configs", "jobs", "scans"],
          properties: {
            credential_id: { type: "string", format: "uuid" },
            role_configs: {
              type: "object",
              required: ["count", "items"],
              properties: {
                count: { type: "integer", minimum: 0 },
                items: { type: "array", items: { type: "object", additionalProperties: true } },
              },
            },
            jobs: {
              type: "object",
              required: ["pending_unclaimed", "active_frozen", "recoverable", "terminal_historical"],
              properties: {
                pending_unclaimed: { $ref: "#/components/schemas/CredentialImpactJobBucket" },
                active_frozen: { $ref: "#/components/schemas/CredentialImpactJobBucket" },
                recoverable: {
                  allOf: [
                    { $ref: "#/components/schemas/CredentialImpactJobBucket" },
                    { description: "failed / timeout / orphan；可被 /jobs/:id/resume 或 resume-session 原地恢复为 pending；不阻挡删除，删除后不能再按原快照 resume" },
                  ],
                },
                terminal_historical: {
                  allOf: [
                    { $ref: "#/components/schemas/CredentialImpactJobBucket" },
                    { description: "succeeded / cancelled；不可恢复，不阻挡删除" },
                  ],
                },
              },
            },
            scans: {
              type: "object",
              required: ["active"],
              properties: {
                active: {
                  type: "object",
                  description: "queued / claimed / running 的 runtime_image_scans，result_json.registry_credential_id 指向该凭据",
                  required: ["count", "items"],
                  properties: {
                    count: { type: "integer", minimum: 0 },
                    items: { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
        CredentialImpactJobBucket: {
          type: "object",
          required: ["count", "items"],
          properties: {
            count: { type: "integer", minimum: 0 },
            items: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        CredentialMetadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            base_url: { type: "string", format: "uri" },
            model_concurrency: { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 1000 } },
            max_concurrent: { type: "integer", minimum: 0, maximum: 1000 },
            registry: { type: "string" },
            username: { type: "string", maxLength: 200 },
          },
          description: "Server-owned metadata allowlist; secret-like/unknown keys are rejected.",
        },
        CredentialHealth: {
          type: "object",
          required: ["status", "last_tested_at", "error_category", "detail", "model_catalog", "model_catalog_fetched_at"],
          properties: {
            status: { type: "string", enum: ["unknown", "ok", "error"] },
            last_tested_at: { type: "string", format: "date-time", nullable: true },
            error_category: { type: "string", nullable: true },
            detail: { type: "string", nullable: true, maxLength: 300 },
            model_catalog: { type: "array", maxItems: 200, items: { type: "string", maxLength: 200 } },
            model_catalog_fetched_at: { type: "string", format: "date-time", nullable: true },
          },
        },
        ProviderAccountCatalogItem: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "label", "kind", "auth_methods", "compatible_agent_cli", "supports_base_url"],
          properties: {
            provider: { type: "string", maxLength: 50 },
            label: { type: "string" },
            kind: { type: "string", enum: ["llm_provider", "plane", "git", "oci_registry"] },
            auth_methods: { type: "array", items: { type: "string", enum: ["api_key", "oauth", "cli_login"] } },
            compatible_agent_cli: { type: "array", items: { type: "string" } },
            supports_base_url: { type: "boolean" },
          },
        },
        BindableRoleConfig: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "role_id", "role_name", "role_title", "project_id", "project_name", "agent_cli", "dsh_task_mode", "model", "version",
            "runtime_image_key", "sandbox_limits_json", "context_window_tokens",
            "credential_id", "credential_name", "credential_kind", "credential_provider", "credential_status", "credential_project_id", "credential_project_name", "scope", "can_bind",
            "credential_provider_valid", "role_kind", "role_builtin", "image_strategy",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            role_id: { type: "string", format: "uuid" },
            role_name: { type: "string" },
            role_title: { type: "string", nullable: true },
            role_kind: { type: "string", enum: ["hub", "system", "role"] },
            role_builtin: { type: "boolean" },
            role_ui_color: { type: "string", nullable: true },
            project_id: { type: "string", format: "uuid", nullable: true },
            project_name: { type: "string", nullable: true },
            agent_cli: { type: "string" },
            dsh_task_mode: { type: "string", enum: ["standard", "ptc"], description: "DSH tool presentation preset; ignored by other CLIs" },
            model: { type: "string", nullable: true },
            context_window_tokens: { type: "integer", minimum: 1024, maximum: 10000000, nullable: true, description: "通用客户端预算，不会提升上游模型能力；Claude 仅冻结展示" },
            runtime_image_key: { type: "string", nullable: true },
            sandbox_limits_json: { $ref: "#/components/schemas/SandboxLimitsOverride" },
            version: { type: "integer" },
            credential_id: { type: "string", format: "uuid", nullable: true },
            credential_name: { type: "string", nullable: true },
            credential_kind: { type: "string", nullable: true },
            credential_provider: { type: "string", nullable: true },
            credential_status: { type: "string", nullable: true },
            credential_project_id: { type: "string", format: "uuid", nullable: true },
            credential_project_name: { type: "string", nullable: true },
            scope: { type: "string", enum: ["global", "project"] },
            image_strategy: { type: "string", enum: ["inherit_global", "project_managed"], nullable: true },
            can_bind: { type: "boolean" },
            credential_provider_valid: { type: "boolean", nullable: true },
          },
        },
        CredentialBatchBindingRequest: {
          type: "object",
          additionalProperties: false,
          required: ["credential_id", "role_config_ids", "idempotency_key"],
          properties: {
            credential_id: { type: "string", format: "uuid" },
            role_config_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", format: "uuid" } },
            mode: { type: "string", enum: ["bind", "migrate"], default: "bind" },
            source_credential_id: { type: "string", format: "uuid" },
            model: { type: "string", nullable: true, maxLength: 200 },
            effect: { type: "string", enum: ["new_jobs_only", "refresh_pending"], default: "new_jobs_only" },
            idempotency_key: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
          },
        },
        CredentialBatchBindingImpact: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "effect", "credential_id", "source_credential_id", "role_config_count", "pending_job_count", "refreshed_pending_job_count", "active_frozen_job_count", "terminal_historical_job_count", "leftover_project_models_unchanged", "role_configs"],
          properties: {
            mode: { type: "string", enum: ["bind", "migrate"] },
            effect: { type: "string", enum: ["new_jobs_only", "refresh_pending"] },
            credential_id: { type: "string", format: "uuid" },
            source_credential_id: { type: "string", format: "uuid", nullable: true },
            role_config_count: { type: "integer", minimum: 0 },
            pending_job_count: { type: "integer", minimum: 0 },
            refreshed_pending_job_count: { type: "integer", minimum: 0 },
            active_frozen_job_count: { type: "integer", minimum: 0 },
            terminal_historical_job_count: { type: "integer", minimum: 0 },
            leftover_project_models_unchanged: { type: "boolean", description: "True when bind kept stored project RoleConfig.model values" },
            role_configs: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["role_config_id", "role_name", "scope", "project_id", "model", "model_changed", "inherit_global_ignores_project_model"],
                properties: {
                  role_config_id: { type: "string", format: "uuid" },
                  role_name: { type: "string" },
                  scope: { type: "string", enum: ["global", "project"] },
                  project_id: { type: "string", format: "uuid", nullable: true },
                  model: { type: "string", nullable: true },
                  model_changed: { type: "boolean" },
                  inherit_global_ignores_project_model: { type: "boolean", description: "Project leftover model is stored but ignored for new Jobs under inherit_global" },
                },
              },
            },
          },
        },
        CredentialBatchBindingError: {
          type: "object",
          additionalProperties: false,
          required: ["error_code", "error"],
          properties: {
            error_code: {
              type: "string",
              enum: [
                "BATCH_REQUEST_INVALID",
                "BATCH_TRANSACTION_FAILED",
                "CREDENTIAL_NOT_FOUND",
                "CREDENTIAL_KIND_INVALID",
                "CREDENTIAL_NOT_ACTIVE",
                "CREDENTIAL_PROVIDER_INVALID",
                "CREDENTIAL_CLI_INCOMPATIBLE",
                "CREDENTIAL_HEALTH_REQUIRED",
                "CREDENTIAL_MODEL_CATALOG_REQUIRED",
                "CREDENTIAL_MODEL_CATALOG_UNSUPPORTED",
                "CREDENTIAL_MODEL_REQUIRED",
                "CREDENTIAL_MODEL_NOT_CURRENT",
                "ROLE_CONFIG_NOT_FOUND",
                "ROLE_CONFIG_SOURCE_MISMATCH",
                "PROJECT_SCOPE_FORBIDDEN",
                "IDEMPOTENCY_KEY_REUSED",
              ],
            },
            error: { type: "string", minLength: 1, maxLength: 300 },
            field: { type: "string", minLength: 1, maxLength: 80 },
            repair: {
              type: "object",
              additionalProperties: false,
              required: ["action", "credential_id"],
              properties: {
                action: { type: "string", enum: ["activate_credential", "repair_provider", "test_connection", "discover_models", "choose_model", "choose_project_credential", "choose_project_role_config"] },
                credential_id: { type: "string", format: "uuid" },
                role_config_id: { type: "string", format: "uuid" },
              },
            },
          },
        },
        RuntimeKnobOverride: {
          type: "object",
          additionalProperties: false,
          properties: {
            stallSec: { type: "integer", minimum: 0, maximum: 172800, nullable: true, description: "角色覆盖的产出停滞窗口（秒）；0 关闭；省略继承上层" },
            jobTokenMaxRequests: { type: "integer", minimum: 0, maximum: 1000000, nullable: true, description: "角色覆盖的 Job Token 请求上限；0 不限制" },
            timeoutSec: { type: "integer", minimum: 60, maximum: 172800, nullable: true, description: "角色覆盖的 Job 超时（秒）" },
          },
        },
        SandboxLimitsOverride: {
          type: "object",
          additionalProperties: false,
          properties: {
            cpu: { type: "number", minimum: 0.25, maximum: 64 },
            memoryMiB: { type: "integer", minimum: 256, maximum: 131072 },
            pidsLimit: { type: "integer", minimum: 64, maximum: 32768 },
          },
        },
        RoleConfigInput: {
          type: "object",
          properties: {
            agent_cli: { type: "string", enum: ["claude-code", "pi", "dsh"] },
            dsh_task_mode: { type: "string", enum: ["standard", "ptc"], default: "standard" },
            model: { type: "string", nullable: true },
            context_window_tokens: { type: "integer", minimum: 1024, maximum: 10000000, nullable: true, description: "客户端预算，不会提升上游模型能力；Claude 仅冻结展示" },
            env_vars: { type: "object", additionalProperties: { type: "string" } },
            modules: {
              type: "array",
              items: { type: "string" },
              description: "原始 selector：<source_uuid>:<module_id>、<source_uuid>:plugin:<plugin_path> 或 <source_uuid>:source:*",
            },
            skills: { type: "array", items: { type: "object", additionalProperties: true } },
            commands: { type: "array", items: { type: "object", additionalProperties: true } },
            mcps: { type: "array", items: { type: "object", additionalProperties: true } },
            subagents: { type: "array", items: { type: "object", additionalProperties: true } },
            platform_tools: {
              type: "object",
              additionalProperties: { type: "boolean" },
              description: "平台工具启用开关（全量 list 对每个 Agent 可选）；未声明默认启用。仅 mark_job_done 不可关闭。",
            },
            instructions_markdown: { type: "string", nullable: true },
            runtime_image_key: { type: "string", nullable: true, description: "仅全局 RoleConfig 使用；项目覆盖必须传 null，并通过项目镜像策略选择" },
            sandbox_limits: { $ref: "#/components/schemas/SandboxLimitsOverride" },
            runtime_knobs: { $ref: "#/components/schemas/RuntimeKnobOverride" },
            credentials: {
              type: "array",
              items: {
                type: "object",
                required: ["credential_id", "purpose"],
                properties: {
                  credential_id: { type: "string", format: "uuid" },
                  purpose: { type: "string", default: "llm" },
                },
              },
            },
            config_files: {
              type: "array",
              items: {
                type: "object",
                required: ["path", "content"],
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
            pi_extensions: {
              type: "array",
              items: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
              maxItems: 8,
              description: "仅 agent_cli=pi：已注册的 Pi 扩展 id。Job 创建时冻结；启动仍带 --no-extensions，只对冻结路径追加 -e。未注册 id 或与 Job 镜像不兼容则拒绝。出网扩展服从任务 allow_egress。pilot pi-web-access 只预置 audit / kali-minimal。",
            },
          },
        },
        ReadinessResponse: {
          type: "object",
          required: ["schema", "ready", "execution_mode", "scope", "network_policy", "checks", "summary", "generated_at"],
          properties: {
            schema: { type: "string", const: "deepsonar.readiness/v1" },
            ready: { type: "boolean" },
            execution_mode: { type: "string", enum: ["fake", "real"] },
            scope: {
              type: "object",
              required: ["kind", "project_id"],
              properties: {
                kind: { type: "string", enum: ["global", "project"] },
                project_id: { type: "string", format: "uuid", nullable: true },
              },
            },
            network_policy: {
              type: "object",
              required: ["allow_egress", "source", "material_source"],
              properties: {
                allow_egress: { type: "boolean" },
                source: { type: "string", enum: ["global", "project", "task_override"] },
                material_source: { type: "string", enum: ["workspace_or_offline", "external_or_workspace", "declared", "unspecified"] },
              },
            },
            checks: {
              type: "array",
              items: {
                type: "object",
                required: ["code", "state", "severity", "message"],
                properties: {
                  code: { type: "string", description: "Stable machine-readable check code" },
                  state: { type: "string", enum: ["pass", "attention", "fail"] },
                  severity: { type: "string", enum: ["info", "warning", "error"] },
                  message: { type: "string" },
                  fix: {
                    type: "object",
                    nullable: true,
                    properties: {
                      action: { type: "string", enum: ["credentials", "role_config", "rules", "runtime_images"] },
                      scope: { type: "string", enum: ["global", "project"] },
                      project_id: { type: "string", format: "uuid", nullable: true },
                      href: { type: "string" },
                      target: { type: "string" },
                    },
                  },
                  role: { type: "object", nullable: true, additionalProperties: true },
                  credential: { type: "object", nullable: true, additionalProperties: true, description: "Non-sensitive identity only" },
                  runtime_image: { type: "object", nullable: true, additionalProperties: true, description: "Trusted image key/digest summary only" },
                  evidence: { type: "object", nullable: true, additionalProperties: true },
                },
              },
            },
            summary: {
              type: "object",
              required: ["errors", "warnings", "infos"],
              properties: {
                errors: { type: "integer", minimum: 0 },
                warnings: { type: "integer", minimum: 0 },
                infos: { type: "integer", minimum: 0 },
              },
            },
            generated_at: { type: "string", format: "date-time" },
          },
        },
        Scopes: {
          type: "array",
          items: { type: "string", enum: [...ALL_SCOPES] },
          description: "平台 API Token 可用 scope 全集",
        },
      },
    },
    "x-deepsonar-scopes": [...ALL_SCOPES],
    "x-deepsonar-auth-exempt": [
      "/health",
      "/openapi.json",
      "/schema",
      "/schema.md",
      "/auth/status",
      "/auth/login",
      "/auth/bootstrap",
      "/webhooks/plane",
      "/gateway/*",
    ],
  };
}

/** 端点摘要（给 /schema?format=summary 用） */
export function buildSchemaSummary(): Record<string, unknown> {
  return {
    title: "DeepSonar Scheduler API",
    version: "0.0.1",
    base_url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
    auth: {
      header: "Authorization: Bearer <deepsonar_token>",
      required_when: "DEEPSONAR_AUTH_REQUIRED=true",
      scopes: [...ALL_SCOPES],
      exempt: [
        "/health",
        "/openapi.json",
        "/schema",
        "/schema.md",
        "/auth/status",
        "/auth/login",
        "/auth/bootstrap",
        "/webhooks/plane",
        "/gateway/*",
      ],
    },
    documents: {
      openapi_json: "/openapi.json",
      schema: "/schema",
      schema_markdown: "/schema.md",
      management_skill_api_md: "skills/deepsonar-management/references/api.md",
    },
    endpoints: OPS.map((op) => ({
      method: op.method.toUpperCase(),
      path: op.path.replace(/\{(\w+)\}/g, ":$1"),
      summary: op.summary,
      scope: op.scope === null ? "exempt" : op.scope,
      tags: op.tags,
    })),
    errors: {
      "400": "参数/校验失败",
      "401": "未认证或 Token 无效",
      "403": "Scope 不足",
      "404": "资源不存在",
      "409": "冲突",
      "502": "上游失败（Git/Plane 等）",
    },
  };
}
