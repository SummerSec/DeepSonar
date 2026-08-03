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
  query?: Record<string, unknown>;
  responses?: Record<string, unknown>;
}

const ErrorSchema = {
  type: "object",
  properties: { error: { type: "string", description: "人类可读错误信息" } },
  required: ["error"],
};

const ReasoningEnum = ["low", "medium", "high", "xhigh"] as const;

/** 核心 API 操作表（OpenAPI paths 的单一来源） */
const OPS: Op[] = [
  // meta
  { method: "get", path: "/health", summary: "健康检查", scope: null, tags: ["Meta"] },
  { method: "get", path: "/openapi.json", summary: "OpenAPI 3 JSON schema", scope: null, tags: ["Meta"] },
  { method: "get", path: "/schema", summary: "API schema（默认 OpenAPI JSON；?format=markdown 返回 Markdown）", scope: null, tags: ["Meta"] },
  { method: "get", path: "/schema.md", summary: "API Markdown 文档", scope: null, tags: ["Meta"] },
  { method: "get", path: "/metrics", summary: "Prometheus 指标文本", scope: "admin", tags: ["Meta"] },

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
      },
    },
  },
  { method: "get", path: "/projects/{id}", summary: "项目详情", scope: "projects:read", tags: ["Projects"] },
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
  { method: "get", path: "/projects/{id}/canvases", summary: "画布列表", scope: "tasks:read", tags: ["Tasks"] },
  { method: "get", path: "/projects/{id}/canvas", summary: "项目当前画布（兼容）", scope: "tasks:read", tags: ["Tasks"] },
  { method: "get", path: "/canvases/{id}", summary: "画布节点与边", scope: "tasks:read", tags: ["Tasks"] },
  { method: "post", path: "/tasks/{canvasId}/resume-session", summary: "恢复会话（继续执行，不删历史）", scope: "jobs:control", tags: ["Tasks"] },
  { method: "post", path: "/tasks/{canvasId}/retry", summary: "重试任务（清空历史后从意图重跑）", scope: "jobs:control", tags: ["Tasks"] },
  {
    method: "patch",
    path: "/canvas-nodes/{id}/verification",
    summary: "Fact 人工验证",
    scope: "jobs:control",
    tags: ["Tasks"],
    body: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["verified", "rejected", "needs_human"] },
        note: { type: "string" },
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
        type: { type: "string", description: "已注册角色名或系统类型" },
        title: { type: "string" },
        payload: { type: "object", additionalProperties: true },
        priority: { type: "integer" },
        timeout_sec: { type: "integer" },
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
  { method: "get", path: "/jobs/{id}/evidence", summary: "Job 原始证据 manifest", scope: "tasks:read", tags: ["Jobs"] },
  { method: "get", path: "/jobs/{id}/evidence/session", summary: "查看 Agent CLI 原始 Session", scope: "tasks:read", tags: ["Jobs"] },
  { method: "get", path: "/jobs/{id}/evidence/session/download", summary: "下载 Agent CLI 原始 Session", scope: "tasks:read", tags: ["Jobs"] },
  { method: "get", path: "/jobs/{id}/evidence/stream", summary: "读取历史 normalized stream", scope: "tasks:read", tags: ["Jobs"] },
  {
    method: "patch",
    path: "/jobs/{id}/priority",
    summary: "调整 pending 优先级",
    scope: "jobs:control",
    tags: ["Jobs"],
    body: { type: "object", required: ["priority"], properties: { priority: { type: "integer" } } },
  },
  { method: "post", path: "/jobs/{id}/cancel", summary: "取消 job", scope: "jobs:control", tags: ["Jobs"] },
  { method: "post", path: "/jobs/{id}/resume", summary: "恢复 failed/timeout/orphan → pending", scope: "jobs:control", tags: ["Jobs"] },

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
      verify_status: { type: "string" },
    },
  },
  { method: "get", path: "/findings/{id}", summary: "Finding 完整详情与验证链", scope: "findings:read", tags: ["Findings"] },
  { method: "get", path: "/canvases/{id}/report", summary: "画布任务报告元数据", scope: "tasks:read", tags: ["Reports"] },
  { method: "get", path: "/reports/{id}/markdown", summary: "下载 Markdown 报告", scope: "tasks:read", tags: ["Reports"] },
  { method: "get", path: "/reports/{id}/sarif", summary: "下载 SARIF 报告", scope: "tasks:read", tags: ["Reports"] },
  { method: "post", path: "/canvases/{id}/report/retry", summary: "失败报告重试", scope: "jobs:control", tags: ["Reports"] },

  // settings
  { method: "get", path: "/global-settings", summary: "全局规则", scope: "agents:read", tags: ["Settings"] },
  {
    method: "patch",
    path: "/global-settings",
    summary: "合并更新全局规则",
    scope: "agents:write",
    tags: ["Settings"],
    body: { type: "object", required: ["rules"], properties: { rules: { type: "object", additionalProperties: true } } },
  },
  { method: "get", path: "/projects/{id}/settings", summary: "项目规则与角色启用", scope: "agents:read", tags: ["Settings"] },
  {
    method: "patch",
    path: "/projects/{id}/settings",
    summary: "更新项目规则 / 角色启用清单",
    scope: "agents:write",
    tags: ["Settings"],
    body: {
      type: "object",
      properties: {
        rules: { type: "object", additionalProperties: true },
        roles: {
          type: "object",
          properties: {
            enabled: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          },
        },
      },
    },
  },

  // roles
  { method: "get", path: "/agent-roles", summary: "角色注册表", scope: "agents:read", tags: ["Roles"] },
  {
    method: "post",
    path: "/agent-roles",
    summary: "创建角色",
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
  { method: "patch", path: "/agent-roles/{id}", summary: "更新角色（name 不可改）", scope: "agents:write", tags: ["Roles"] },
  { method: "delete", path: "/agent-roles/{id}", summary: "删除 Hub 可下发角色（系统/Hub 角色 409）", scope: "agents:write", tags: ["Roles"] },
  { method: "get", path: "/projects/{id}/roles", summary: "项目视角角色启用清单", scope: "agents:read", tags: ["Roles"] },

  // role-configs
  { method: "get", path: "/role-configs/global", summary: "全局 RoleConfig 清单", scope: "agents:read", tags: ["RoleConfig"] },
  {
    method: "put",
    path: "/role-configs/global/{roleId}",
    summary: "全局 RoleConfig upsert（声明式全量替换）",
    scope: "agents:write",
    tags: ["RoleConfig"],
    body: { $ref: "#/components/schemas/RoleConfigInput" },
  },
  { method: "get", path: "/projects/{id}/role-configs", summary: "项目 RoleConfig 来源清单", scope: "agents:read", tags: ["RoleConfig"] },
  {
    method: "put",
    path: "/projects/{id}/role-configs/{roleId}",
    summary: "项目 RoleConfig 覆盖 upsert",
    scope: "agents:write",
    tags: ["RoleConfig"],
    body: { $ref: "#/components/schemas/RoleConfigInput" },
  },
  {
    method: "delete",
    path: "/projects/{id}/role-configs/{roleId}",
    summary: "删除项目覆盖，回落全局",
    scope: "agents:write",
    tags: ["RoleConfig"],
  },

  // trusted runtime image catalog / marketplace
  {
    method: "get",
    path: "/runtime-images",
    summary: "镜像市场列表（可按项目和关键字过滤）",
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
    description: "仅返回经过解析校验的不可变 @sha256:64hex 版本；未核实的官方 digest 不会被静态清单伪造。",
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
    summary: "项目启用/停用可信镜像并固定版本",
    scope: "images:manage",
    tags: ["Runtime Images"],
    body: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        version_id: { type: "string", format: "uuid", nullable: true },
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
  { method: "post", path: "/skill-sources/{id}/sync", summary: "同步模块源（浅克隆）", scope: "skills:write", tags: ["Skills"] },
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
        provider: { type: "string", description: "OCI registry 凭据时使用 registry host，其余类型使用平台固定 provider" },
        secret: { type: "string" },
        project_id: { type: "string", format: "uuid", nullable: true },
        metadata: {
          type: "object",
          additionalProperties: true,
          description: "非敏感元数据，如 { base_url }",
        },
      },
    },
  },
  {
    method: "patch",
    path: "/credentials/{id}",
    summary: "更新非敏感字段（name / project_id / metadata）",
    scope: "agents:write",
    tags: ["Credentials"],
    body: {
      type: "object",
      properties: {
        name: { type: "string" },
        project_id: { type: "string", format: "uuid", nullable: true },
        metadata: { type: "object", additionalProperties: true },
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
  { method: "post", path: "/credentials/{id}/test", summary: "连接测试", scope: "agents:read", tags: ["Credentials"] },
  { method: "post", path: "/credentials/{id}/models", summary: "从 Provider 实时获取模型目录", scope: "agents:read", tags: ["Credentials"] },

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
        required: false,
        schema,
      })),
    ];
    const operation: Record<string, unknown> = {
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      operationId: `${op.method}_${op.path.replace(/[{}/]/g, "_").replace(/_+/g, "_")}`,
      parameters: parameters.length ? parameters : undefined,
      security: op.scope === null ? [] : [{ bearerAuth: [] }],
      "x-deepsonar-scope": op.scope === null ? "exempt" : op.scope,
      responses: {
        "200": {
          description: "成功",
          content: {
            "application/json": {
              schema: op.responses?.["200"] ?? { type: "object", additionalProperties: true },
            },
          },
        },
        "400": { description: "参数错误", content: { "application/json": { schema: ErrorSchema } } },
        "401": { description: "未认证", content: { "application/json": { schema: ErrorSchema } } },
        "403": { description: "权限不足", content: { "application/json": { schema: ErrorSchema } } },
        "404": { description: "不存在", content: { "application/json": { schema: ErrorSchema } } },
        "409": { description: "冲突", content: { "application/json": { schema: ErrorSchema } } },
        ...(op.responses ?? {}),
      },
    };
    if (op.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: op.body } },
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
        " 人类可读摘要见 GET /schema.md；Management Skill 契约见 skills/deepsonar-management/references/api.md。",
    },
    servers: [
      {
        url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
        description: "当前调度器实例",
      },
    ],
    tags: [
      { name: "Meta" },
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
        ReasoningEffort: { type: "string", enum: [...ReasoningEnum], nullable: true },
        RoleConfigInput: {
          type: "object",
          properties: {
            agent_cli: { type: "string", enum: ["claude-code", "open-code", "codex"] },
            model: { type: "string", nullable: true },
            reasoning: { $ref: "#/components/schemas/ReasoningEffort" },
            env_keys: { type: "array", items: { type: "string" } },
            env_vars: { type: "object", additionalProperties: { type: "string" } },
            modules: { type: "array", items: { type: "string" }, description: "<source_id>:<module_id>" },
            skills: { type: "array", items: { type: "object", additionalProperties: true } },
            commands: { type: "array", items: { type: "object", additionalProperties: true } },
            mcps: { type: "array", items: { type: "object", additionalProperties: true } },
            subagents: { type: "array", items: { type: "object", additionalProperties: true } },
            platform_tools: {
              type: "object",
              additionalProperties: { type: "boolean" },
              description: "角色合法平台工具的启用开关；未声明默认启用。mark_job_done 与 Hub 的 list_available_roles、submit_hub_decision 不可关闭。",
            },
            instructions_markdown: { type: "string", nullable: true },
            runtime_image_key: { type: "string", nullable: true },
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
    "x-deepsonar-auth-exempt": ["/health", "/openapi.json", "/schema", "/schema.md", "/webhooks/plane", "/gateway/*"],
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
      exempt: ["/health", "/openapi.json", "/schema", "/schema.md", "/webhooks/plane", "/gateway/*"],
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
