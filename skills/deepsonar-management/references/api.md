# DeepSonar Management API 契约

> **权威机器可读 schema（运行时）**：调度器提供以下豁免鉴权端点，优先以此为准。
> - `GET /openapi.json` — OpenAPI 3.0.3 完整 JSON
> - `GET /schema` — 默认同 openapi；`?format=summary|markdown|openapi`
> - `GET /schema.md` — 本文件（仓库内副本）或运行时生成摘要

Base URL：`DEEPSONAR_BASE_URL`（默认 `http://localhost:3100`）
认证：`Authorization: Bearer <deepsonar_token>`（`DEEPSONAR_AUTH_REQUIRED=false` 时本地回环可省略）

**豁免鉴权**：`/health`、`/openapi.json`、`/schema`、`/schema.md`、`/webhooks/plane`、`/gateway/*`

Scope 列以 `apps/scheduler/src/auth.ts` 的 `ROUTE_SCOPES` 为准；未列出的写操作默认 `admin`，读操作只需已认证。

**注意**：「角色 / RoleConfig / 设置 / 凭据」统一使用 `agents:read` / `agents:write`。

## 端点一览

### Meta / Schema（发现契约）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /health | 豁免 | 健康检查 `{ok, ts}` |
| GET | /openapi.json | 豁免 | OpenAPI 3.0.3 完整文档 |
| GET | /schema | 豁免 | `?format=openapi`（默认）/ `summary` / `markdown` |
| GET | /schema.md | 豁免 | Markdown 契约（本文件） |
| GET | /metrics | admin | Prometheus 文本 |

### 项目

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /projects | projects:read | 项目列表 |
| POST | /projects | projects:write | 创建 `{name, description?, plane_project_id?}` |
| GET | /projects/:id | projects:read | 项目详情 |
| PATCH | /projects/:id | projects:write | `{name?, description?, status?: active\|archived}` |
| POST | /projects/:id/archive | projects:write | 归档项目 |

### 任务 / 事件 / 画布

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/tasks | tasks:write | 创建任务 `{title, content, allow_egress?}`；省略出网字段时继承项目默认值 |
| POST | /tasks/:canvasId/retry | jobs:control | 同画布重试（复用同一 canvas） |
| POST | /projects/:id/events | tasks:write | 外部事件 `{source, event_id, event_type, title?, content?, data?}`，`source+event_id` 幂等 |
| GET | /projects/:id/canvases | tasks:read | 画布列表（一次任务 = 一个画布） |
| GET | /projects/:id/canvas | tasks:read | 项目当前画布（兼容） |
| GET | /canvases/:id | tasks:read | 画布节点/边 |
| PATCH | /canvas-nodes/:id/verification | jobs:control | Fact 人工验证 `{status: verified\|rejected\|needs_human, note?}` |

### Job

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /jobs | tasks:write | 直接建 job `{project_id, type, title?, payload?, priority?, timeout_sec?}`；一般用 tasks.create |
| GET | /jobs | tasks:read | 列表；`?project_id=` 可选 |
| GET | /jobs/:id | tasks:read | 详情（含事件） |
| PATCH | /jobs/:id/priority | jobs:control | 仅 pending：`{priority}` |
| POST | /jobs/:id/cancel | jobs:control | 取消（running 回收沙箱） |
| POST | /jobs/:id/resume | jobs:control | failed/timeout/orphan → pending（终态 409） |

### 结果与报告

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /findings | findings:read | Finding 列表；`?project_id=` / `?canvas_id=` |
| GET | /canvases/:id/report | tasks:read | 任务报告元数据（status / markdown_uri / sarif_uri） |
| GET | /reports/:id/markdown | tasks:read | **非 JSON**，text/markdown |
| GET | /reports/:id/sarif | tasks:read | **非 JSON**，application/sarif+json |
| POST | /canvases/:id/report/retry | jobs:control | 仅 `failed` 可重试，否则 409 |

### 设置（规则与角色启停）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /global-settings | agents:read | `{rules, effective_rules}` |
| PATCH | /global-settings | agents:write | `{rules: {...}}` 合并 |
| GET | /projects/:id/settings | agents:read | 项目规则覆盖 + 角色启用 |
| PATCH | /projects/:id/settings | agents:write | `{rules?, roles?: {enabled: string[] \| null}}`；`enabled: null` 恢复默认 |

### 角色注册表（agent_roles）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /agent-roles | agents:read | 全部角色及 Hub 可见职责描述 |
| POST | /agent-roles | agents:write | `{name, title?, description?}`；name 即 job.type |
| PATCH | /agent-roles/:id | agents:write | 部分更新（name 不可改） |
| DELETE | /agent-roles/:id | agents:write | `kind=role` 均可删除；system/hub 返回 409 |
| GET | /projects/:id/roles | agents:read | 项目视角启用状态 |

### RoleConfig（角色 → agent 配置；声明式全量替换）

PUT body：

```json
{
  "agent_cli": "claude-code | open-code | codex",
  "model": "string | null",
  "reasoning": "low | medium | high | xhigh | null",
  "env_keys": ["..."],
  "env_vars": { "KEY": "value" },
  "modules": ["<source_id>:<module_id>"],
  "skills": [],
  "commands": [],
  "mcps": [],
  "subagents": [],
  "instructions_markdown": "string | null",
  "runtime_image_key": "string | null",
  "credentials": [{ "credential_id": "uuid", "purpose": "llm" }],
  "config_files": [{ "path": ".claude/settings.json", "content": "{...}" }]
}
```

保存前服务端校验：env 白名单、镜像可信目录、Credential 项目边界、配置文件路径白名单与密钥特征扫描，**越界一律 400**。
Job 创建时必须冻结完整运行快照：项目 RoleConfig → 全局 RoleConfig → 平台缺省。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /role-configs/global | agents:read | 全局缺省清单（含 credentials / config_files） |
| PUT | /role-configs/global/:roleId | agents:write | 全局 upsert（version +1） |
| GET | /projects/:id/role-configs | agents:read | 各角色来源 project / global / none |
| PUT | /projects/:id/role-configs/:roleId | agents:write | 项目覆盖；普通角色须已启用（409） |
| DELETE | /projects/:id/role-configs/:roleId | agents:write | 删除覆盖，回落全局 |

### Skill 模块源

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /skill-sources | skills:read | 源列表 |
| GET | /skill-sources/:id | skills:read | 目录详情（无文件内容） |
| POST | /skill-sources | skills:write | `{name, repo_url, branch?}`；https + host 白名单；默认 quarantined |
| POST | /skill-sources/:id/sync | skills:write | 浅克隆同步（无 body；Git 不可达 502） |
| POST | /skill-sources/:id/trust | skills:write | `{trust_status, enabled?}` |
| DELETE | /skill-sources/:id | skills:write | 删除 |

### Provider Credential（密钥加密；明文不回显）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /credentials | agents:read | 列表（指纹 / last4 / metadata） |
| POST | /credentials | agents:write | `{name, provider, secret, kind?, project_id?, metadata?}` |
| PATCH | /credentials/:id | agents:write | 非敏感：`{name?, project_id?, metadata?}`（可改 base_url） |
| POST | /credentials/:id/rotate | agents:write | `{secret}` 轮换密钥 |
| POST | /credentials/:id/status | agents:write | `{status: active\|disabled\|rotation_required}` |
| POST | /credentials/:id/test | agents:read | 连接测试（无 body） |

### Plane 集成（可选）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| PUT | /projects/:id/integrations/plane | integrations:write | `{plane_project_id}` |
| DELETE | /projects/:id/integrations/plane | integrations:write | 解绑 |
| POST | /projects/:id/integrations/plane/sync | integrations:write | 手动同步 |
| GET | /plane-info | integrations:read | 连接信息 |
| POST | /webhooks/plane | 豁免 | Webhook 入口（签名校验） |

### 管理面

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| * | /tokens* | tokens:manage | API Token 管理 |
| GET | /audit-logs | admin | 审计日志 |
| GET | /ws | tasks:read | Job 实时流 WebSocket |

## 错误格式

```json
{ "error": "人类可读信息" }
```

| 状态 | 含义 |
| --- | --- |
| 400 | 参数 / Zod / RoleConfig 越界校验 |
| 401 | 未认证或 Token 无效/过期/已吊销 |
| 403 | Scope 不足或项目级 Token 跨项目 |
| 404 | 资源不存在 |
| 409 | 冲突（同名、终态 resume、未启用角色配项目覆盖等） |
| 502 | 上游失败（Git 同步、Plane 等） |

## 幂等

- 任务创建：`jobs.ingress_key` 唯一；重复提交返回既有 Job。
- 事件注入：`(project_id, source, event_id)` 幂等。
- RoleConfig PUT：声明式全量替换 credentials/config_files，重复提交安全。
- 无 body 的 POST（sync / test / cancel 等）**不要**带 `Content-Type: application/json`，否则 Fastify 可能 400。

## 发现契约（推荐流程）

```bash
# 1) 拉机器可读 OpenAPI
curl -s "$DEEPSONAR_BASE_URL/openapi.json" -o openapi.json

# 2) 或拉端点摘要
curl -s "$DEEPSONAR_BASE_URL/schema?format=summary" | jq .

# 3) 或拉 Markdown
curl -s "$DEEPSONAR_BASE_URL/schema.md"
```
