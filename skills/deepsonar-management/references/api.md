# DeepSonar Management API 契约

> **权威机器可读 schema（运行时）**：调度器提供以下豁免鉴权端点，优先以此为准。
> - `GET /openapi.json` — OpenAPI 3.0.3 完整 JSON
> - `GET /schema` — 默认同 openapi；`?format=summary|markdown|openapi`
> - `GET /schema.md` — 本文件（仓库内副本）或运行时生成摘要

Base URL：`DEEPSONAR_BASE_URL`（默认 `http://localhost:3100`）
认证：`Authorization: Bearer <deepsonar_token>`（`DEEPSONAR_AUTH_REQUIRED=false` 时本地回环可省略）

**豁免鉴权**：`/health`、`/openapi.json`、`/schema`、`/schema.md`、`/webhooks/plane`、`/gateway/*`

Scope 列以 `apps/scheduler/src/auth.ts` 的 `ROUTE_SCOPES` 为准；未列出的写操作默认 `admin`，读操作只需已认证。

**注意**：「角色 / RoleConfig / 设置 / 凭据」统一使用 `agents:read` / `agents:write`；运行时镜像市场使用独立的 `images:*` scopes。

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
| GET | /global-settings | agents:read | `{rules, effective_rules, active_by_agent_cli, active_by_provider}`；`effective_rules` 含 `maxGlobalJobs` / `maxJobsPerProject` / `maxConcurrentByAgentCli` |
| PATCH | /global-settings | agents:write | `{rules: {...}}` 合并；调度 claim 读取更新后的 effective 规则并由 `pg_notify` 唤醒，无需重启 |
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
  "platform_tools": {
    "emit_progress": true,
    "emit_fact": true,
    "mark_job_done": true,
    "request_human": false
  },
  "instructions_markdown": "string | null",
  "runtime_image_key": "string | null",
  "credentials": [{ "credential_id": "uuid", "purpose": "llm" }],
  "config_files": [{ "path": ".claude/settings.json", "content": "{...}" }]
}
```

保存前服务端校验：env 白名单、镜像可信目录、Credential 项目边界、配置文件路径白名单与密钥特征扫描，**越界一律 400**。

常见 400：
- `runtime_image_key 没有可信版本: <key>` — 市场 catalog 有 key 不等于有 `trust_status=trusted` 的版本；先配置 `DEEPSONAR_OFFICIAL_*_IMAGE=@sha256:...` 重启，或 import+approve。
- 凭据 `purpose` 必须是 **`llm`** 才会进入模型通道；其它 purpose 不会被 Executor 当作 LLM key。

`platform_tools` 只接受该角色合法的工具名；未声明的合法工具默认启用。所有角色的 `mark_job_done`，以及 Hub 的 `list_available_roles`、`submit_hub_decision` 是形成合法决策/终态所必需的工具，不可关闭。`verify` / `report` 不支持 `request_human`：Verify 用 verdict=`needs_human` 收口 Finding，Report 输入损坏则失败并重试。Hub 需要派发时由 `list_available_roles({})` 按需返回数据库中的项目可用工作角色；返回值排除 system/hub 角色，决策落地时服务端再次严格校验且不做默认回退。其他工具关闭后不会注入当次 Worker 的控制 MCP，也不会进入动态 `AGENTS.md`、`CLAUDE.md` 的可用工具说明。

Job 创建时必须冻结完整运行快照：项目 RoleConfig → 全局 RoleConfig → 平台缺省。快照含 `model` / `reasoning` / `credential_id` / `runtime_image`（digest）；**改 RoleConfig 不影响已创建 Job**。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /role-configs/global | agents:read | 全局缺省清单（含 credentials / config_files） |
| PUT | /role-configs/global/:roleId | agents:write | 全局 upsert（version +1） |
| GET | /projects/:id/role-configs | agents:read | 各角色来源 project / global / none；`project_config` 返回实时完整项目覆盖 |
| PUT | /projects/:id/role-configs/:roleId | agents:write | 项目覆盖；普通角色须已启用（409） |
| DELETE | /projects/:id/role-configs/:roleId | agents:write | 删除覆盖，回落全局 |

仓库管理 CLI 提供 `role-configs sync-builtin-prompts`：从 `database/schema.sql` 的单一基线提取内置 Prompt，读取线上全局 RoleConfig 后仅替换 `instructions_markdown`，保留模型、凭据、镜像、模块和配置文件；可先用 `--dry-run` 查看 Prompt 哈希。

### 运行时镜像市场

市场只接受受治理 OCI 目录。第三方导入首先进入 `quarantined`，由独立 Image Admission Worker 解析不可变 digest 并完成验签、SBOM、漏洞/凭据/恶意文件扫描和断网自检。扫描通过也不会自动 trusted；必须由 `images:approve` 管理员提升，第三方版本还需要项目显式启用。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /runtime-images | images:read | 市场列表；`?search=` / `?project_id=` |
| GET | /runtime-images/:id | images:read | 产品、不可变版本、工具清单、SBOM/签名和扫描历史 |
| GET | /runtime-images/registry | images:read | 官方目录；保留 `schema/images`，并附 `source`、`fallback`、`error`、`checked_at` 诊断 |
| POST | /runtime-images/:id/detect-local | images:read | `{image_ref}`；读取本机 Docker 元数据并返回候选（不会改变信任状态） |
| POST | /runtime-images/:id/adopt-local | images:approve | `{image_ref, expected_image_id}`；仅官方产品的 adoptable 候选可由管理员二次确认采用；第三方仍走准入扫描 |
| POST | /runtime-images/import | images:manage | `{image_key,name,publisher,image_ref,description?,source_url?,version?,registry_credential_id?}`；返回 202 |
| POST | /runtime-image-versions/:id/rescan | images:manage | 重新入队；revoked 版本不可恢复 |
| POST | /runtime-image-versions/:id/status | images:approve | `{status: trusted\|rejected\|disabled\|revoked, reason?}`；rejected/revoked 必填 reason |
| GET | /runtime-image-versions/:id/usage | images:read | 反向查询历史 Job、项目和 Finding |
| PUT | /projects/:id/runtime-images/:imageId | images:manage | `{enabled, version_id?}`；只能启用 trusted 版本，`version_id` 用于固定/回滚 |

Job 创建时冻结 `agent_snapshot_json.runtime_image`，至少包含产品/版本 ID、`image_ref=name@sha256:digest`、`image_digest`、工具清单哈希与准入扫描 ID。任务、Hub、Skill 和外部事件都不能提供任意镜像引用。

本地镜像采用刻意拆成 transport 与 trust 两步：用户可自行 `docker pull`、`docker build` 或 `docker load`，然后用 `detect-local` 检查 image ID、RepoDigest、契约、架构和产品匹配。检测结果中的 `adoptable` 只是候选资格；管理员必须核对不可变 `image_id`，再把同一个 `expected_image_id` 传给 `adopt-local`。mutable tag 不会因为检测或传输而自动获得 trusted 状态。

官方镜像引导（环境变量，调度器启动时写入 trusted version）：

```text
DEEPSONAR_OFFICIAL_BASE_IMAGE=repo/image@sha256:<64hex>
DEEPSONAR_OFFICIAL_AUDIT_IMAGE=repo/image@sha256:<64hex>
DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE=...   # 可选，项目 opt-in
```

仅 tag（无 `@sha256:`）会被忽略并打 warn。`DOCKER_IMAGE_AUDIT` 仅在其已是不可变 digest 时可作为 audit 回落。

### Skill 模块源

数据库基线内置 `DeepSonar-Skills`：稳定 source id 为 `f150e774-d237-57e4-847c-4800722f88ee`，仓库为 `https://github.com/SummerSec/DeepSonar-Skills.git`，分支 `main`，默认 trusted + enabled。catalog 不嵌入 schema，需经同步接口获取当前仓库内容。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /skill-sources | skills:read | 源列表 |
| GET | /skill-sources/:id | skills:read | 目录详情（无文件内容） |
| POST | /skill-sources | skills:write | `{name, repo_url, branch?}`；https + host 白名单；默认 quarantined |
| POST | /skill-sources/:id/sync | skills:write | 浅克隆同步（无 body；Git 不可达 502） |
| POST | /skill-sources/:id/trust | skills:write | `{trust_status, enabled?}` |
| DELETE | /skill-sources/:id | skills:write | 删除 |

### Provider / OCI Registry Credential（密钥加密；明文不回显）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /credentials | agents:read | 列表（指纹 / last4 / metadata） |
| POST | /credentials | agents:write | `{name, provider, secret, kind?, project_id?, metadata?}`；OCI 使用 `kind=oci_registry`、`provider=<registry-host>`、`metadata={registry,username}` |
| PATCH | /credentials/:id | agents:write | 非敏感：`{name?, project_id?, metadata?}`（可改 base_url） |
| POST | /credentials/:id/rotate | agents:write | `{secret}` 轮换密钥 |
| POST | /credentials/:id/status | agents:write | `{status: active\|disabled\|rotation_required}` |
| POST | /credentials/:id/test | agents:read | 连接测试（无 body） |
| POST | /credentials/:id/models | agents:read | 实时拉取 Provider 模型目录（无 body；选 RoleConfig.model 前调用） |

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
- 无 body 的 POST（sync / test / cancel / resume / models 等）**不要**带 `Content-Type: application/json`，否则 Fastify 可能 400。

## Job 状态与运维

```text
pending → claimed → provisioning → running → succeeded|failed|timeout|cancelled|orphan
```

- `POST /jobs/:id/resume`：`failed` / `timeout` / `orphan` → `pending`（终态 409）。
- 改 `apps/scheduler/src` 触发 tsx watch 时，**running → orphan**；resume 后继续。
- schema 版本：`schema_meta.version` 必须等于调度器 `SCHEMA_VERSION`；**无增量迁移**，不符则重建空库（`DROP SCHEMA public CASCADE`）再恢复凭据。
- 清业务数据**禁止** `TRUNCATE projects CASCADE`（会连带 credentials/role_configs）。导出包不含凭据明文。

## 发现契约（推荐流程）

```bash
# 1) 拉机器可读 OpenAPI
curl -s "$DEEPSONAR_BASE_URL/openapi.json" -o openapi.json

# 2) 或拉端点摘要（Windows 无 jq 时用 python）
curl -s "$DEEPSONAR_BASE_URL/schema?format=summary" -o schema.json
python -X utf8 -c "import json; print(json.load(open('schema.json',encoding='utf-8-sig'))['auth'])"

# 3) 或拉 Markdown
curl -s "$DEEPSONAR_BASE_URL/schema.md"
```
