# DeepFlowHunter Management API 契约

Base URL：`DFH_BASE_URL`（默认 `http://localhost:3100`）
认证：`Authorization: Bearer <dfh_token>`（`DFH_AUTH_REQUIRED=false` 时本地回环可省略）
豁免鉴权：`/health`、`/webhooks/plane`、`/gateway/*`（各有自保护）

## 端点一览（Management Skill 使用面）

Scope 列见 `apps/scheduler/src/auth.ts` 的 `ROUTE_SCOPES`；未列出的写操作默认 `admin`，读操作只需已认证。

### 项目

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /health | 豁免 | 健康检查 |
| GET | /projects | projects:read | 项目列表 |
| POST | /projects | projects:write | 创建 `{name, description?, plane_project_id?}` |
| GET | /projects/:id | projects:read | 项目详情 |
| PATCH | /projects/:id | projects:write | 仅允许 `{name?, description?, status?: active\|archived}` |
| POST | /projects/:id/archive | projects:write | 归档项目 |

### 任务 / 事件 / 画布

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/tasks | tasks:write | 创建任务 `{title, content, repo_url? \| repo_path?, ref?}`（content 必填）→ 幂等，返回 job/canvas |
| POST | /tasks/:canvasId/retry | jobs:control | 同画布重试（复用同一 canvas） |
| POST | /projects/:id/events | tasks:write | 注入外部事件 `{source, event_id, event_type, title?, content?, data?}`，`source+event_id` 幂等 |
| GET | /projects/:id/canvases | tasks:read | 画布列表（一次任务 = 一个画布） |
| GET | /canvases/:id | tasks:read | 画布节点/边 |
| PATCH | /canvas-nodes/:id/verification | jobs:control | Fact 人工验证 `{status: verified\|rejected\|needs_human, note?}`；处理后可推进报告 |

### Job

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /jobs | tasks:write | 直接建 job `{project_id, type, title?, payload?, priority?, timeout_sec?}`；`type` 须为已注册角色名或系统类型（一般用 tasks.create） |
| GET | /jobs?project_id= | tasks:read | Job 列表 |
| GET | /jobs/:id | tasks:read | Job 详情（含事件） |
| PATCH | /jobs/:id/priority | jobs:control | 调整 pending 优先级 `{priority}` |
| POST | /jobs/:id/cancel | jobs:control | 取消（running 会回收沙箱） |
| POST | /jobs/:id/resume | jobs:control | 恢复 cancelled → pending（终态 409） |

### 结果与报告

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /findings?project_id= | findings:read | Finding 列表（SARIF 2.1.0 对齐） |
| GET | /canvases/:id/report | tasks:read | 画布任务报告（task_reports 行，含 status / markdown_uri / sarif_uri） |
| GET | /reports/:id/markdown | tasks:read | 下载 Markdown 报告（**非 JSON**，text/markdown） |
| GET | /reports/:id/sarif | tasks:read | 下载 SARIF 报告（**非 JSON**，application/sarif+json） |
| POST | /canvases/:id/report/retry | jobs:control | 仅 `failed` 状态可重试，否则 409 |

### 设置（规则与角色启停）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /global-settings | profiles:read | 全局规则 `{rules, effective_rules}` |
| PATCH | /global-settings | profiles:write | 合并式更新 `{rules: {...}}` |
| GET | /projects/:id/settings | profiles:read | 项目规则覆盖 + 角色启用 `{rules, roles, effective_rules}` |
| PATCH | /projects/:id/settings | profiles:write | `{rules?, roles?: {enabled: string[] \| null}}`；`enabled: null` 恢复默认（全部内置角色） |

### 角色注册表（agent_roles，kind: hub/system/role）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /agent-roles | roles:read | 全部角色（含 system prompt 模板） |
| POST | /agent-roles | roles:write | 创建 `{name, prompt_template, title?, description?}`；name 即 job.type，`{{graph}} {{intent}} {{role}}` 占位 |
| PATCH | /agent-roles/:id | roles:write | 部分更新（name 不可改） |
| DELETE | /agent-roles/:id | roles:write | 内置角色不可删（409） |
| GET | /projects/:id/roles | profiles:read | 项目视角角色清单 + 启用状态（启停走 PATCH settings 的 `roles.enabled`） |

### RoleConfig（角色 → agent 配置；声明式全量替换）

PUT body：`{agent_cli?: claude-code\|open-code\|codex, model?, env_keys?, env_vars?, modules?, skills?, commands?, mcps?, subagents?, prompt_suffix?, runtime_image_key?, credentials?: [{credential_id, purpose}], config_files?: [{path, content}]}`。
保存前服务端统一校验：env 白名单、镜像可信目录、Credential 项目边界、配置文件路径白名单与密钥特征扫描，**越界一律 400 拒绝**。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /role-configs/global | roles:read | 全局缺省配置清单 |
| PUT | /role-configs/global/:roleId | roles:write | 全局缺省 upsert（version +1） |
| GET | /projects/:id/role-configs | roles:read | 各角色有效配置来源（project → global → none） |
| PUT | /projects/:id/role-configs/:roleId | roles:write | 项目级覆盖 upsert；普通角色须已在项目启用（409） |
| DELETE | /projects/:id/role-configs/:roleId | roles:write | 删除项目级覆盖，回落全局缺省 |

### Skill 模块源（Git 托管）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /skill-sources | skills:read | 源列表（含 trust_status / enabled / module_count） |
| GET | /skill-sources/:id | skills:read | 目录详情（文件内容不下发，只有计数） |
| POST | /skill-sources | skills:write | 创建 `{name, repo_url, branch?}`；URL 须 https + host 白名单；新源默认 quarantined + disabled |
| POST | /skill-sources/:id/sync | skills:write | 浅克隆同步 → catalog 落库（Git 不可达 502） |
| POST | /skill-sources/:id/trust | skills:write | 信任审批 `{trust_status: quarantined\|trusted\|disabled, enabled?}` |
| DELETE | /skill-sources/:id | skills:write | 删除源 |

### Plane 集成（可选）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| PUT | /projects/:id/integrations/plane | integrations:write | 绑定 `{plane_project_id}` |
| DELETE | /projects/:id/integrations/plane | integrations:write | 解绑 |
| POST | /projects/:id/integrations/plane/sync | integrations:write | 手动触发同步 |
| GET | /plane-info | integrations:read | Plane 连接信息 |

### 管理面（本 Skill 不使用，仅供对照）

`/tokens*`（tokens:manage）、`/credentials*`（profiles:read/write）、`/audit-logs`（admin）、`/metrics`、`/ws`（tasks:read）—— 留给人类管理员或调度器内部，见 references/permissions.md。

## 错误格式

```json
{ "error": "人类可读信息" }
```

- 400：参数/Zod 校验失败（含 RoleConfig 越界校验）
- 401：未认证或 Token 无效/过期/已吊销
- 403：Scope 不足或项目级 Token 跨项目访问
- 404：资源不存在
- 409：冲突（同名、终态 resume、非 failed 的报告重试、未启用角色配项目级 RoleConfig、内置角色删除）
- 502：上游失败（Git 同步、Plane 不可达等）

## 幂等

- 任务创建走 `jobs.ingress_key` 唯一约束：同一 project + 同一标题/source+event_id 重复提交返回既有 Job，不重复执行。
- 事件注入走 `(project_id, source, event_id)` 幂等键。
- RoleConfig PUT 是声明式全量替换（credentials/config_files 同事务整体替换），重复提交安全。
