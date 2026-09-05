# DeepSonar Management API 契约

> **权威机器可读 schema（运行时）**：调度器提供以下豁免鉴权端点，优先以此为准。
> - `GET /openapi.json` — OpenAPI 3.0.3 完整 JSON
> - `GET /schema` — 默认同 openapi；`?format=summary|markdown|openapi`
> - `GET /schema.md` — 本文件（仓库内副本）或运行时生成摘要

Base URL：`DEEPSONAR_BASE_URL`（默认 `http://localhost:3100`）
认证：`Authorization: Bearer <deepsonar_token>`（`DEEPSONAR_AUTH_REQUIRED=false` 时本地回环可省略）

**普通 Bearer hook 豁免**：`/health`、`/openapi.json`、`/schema`、`/schema.md`、`/auth/status`、`/auth/login`、`/auth/bootstrap`、`/gateway/*`、`/ws`、`/terminal-ws`。其中 `/gateway/*` 使用 Job Token 自鉴权；`/ws` 与 `/terminal-ws` 必须携带 `POST /auth/ws-ticket` 签发的一次性 ticket，不是匿名入口。

Scope 列以 `apps/scheduler/src/auth.ts` 的 `ROUTE_SCOPES` 为准；未列出的写操作默认 `admin`，读操作只需已认证。

**注意**：「角色 / RoleConfig / 设置 / 凭据」统一使用 `agents:read` / `agents:write`；运行时镜像市场使用独立的 `images:*` scopes。

共享资产使用 `assets:read` / `assets:write` / `assets:manage`。上传请求体是原始二进制（`application/octet-stream`），逻辑路径由 `x-asset-key` 指定，真实 MIME 可放 `x-asset-content-type`；不要用 JSON/base64。

### 人类用户认证

人类登录使用数据库中的 scrypt 用户会话，与 API Token 服务账号分离。空库启动时 Scheduler 只创建一次公开的默认管理员 `admin` / `Deep@Sonar66`；已有任意用户时不会重置密码或再次创建。生产或公网部署必须在首次登录后立即修改登录名和密码。密码或登录名修改会吊销该用户全部旧会话，并返回一个新的会话 Token。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /auth/status | 豁免 | 返回 `auth_required`、`has_users`、`bootstrap_available`、`default_admin_credentials_active`（仅默认 admin 仍可用时为 true） |
| POST | /auth/login | 豁免 | `{username,password}`；返回用户会话。任意校验（含成功）按用户名+IP 5 次/5 分钟，并按 IP 20 次/5 分钟；超限 `429 LOGIN_RATE_LIMITED`，不泄露用户是否存在 |
| POST | /auth/bootstrap | 豁免 | 兼容旧版首次引导；默认管理员种子后返回 409 |
| POST | /auth/logout | projects:read | 吊销当前用户会话 |
| GET | /auth/me | projects:read | 当前用户/认证主体 |
| POST | /auth/change-password | projects:read | `{current_password,new_password}`；旧会话失效并返回新 Token |
| POST | /auth/change-username | projects:read | `{current_password,new_username}`；用户名冲突返回 409，旧会话失效并返回新 Token |

用户管理（仅 `admin`）：`GET /users`、`POST /users`、`PATCH /users/:id`、`POST /users/:id/password`。

## 端点一览

### Meta / Schema（发现契约）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /health | 豁免 | 存活检查 `{ok, ready, version, runtime_images, dispatcher, ts}`；`version` 来自 `DEEPSONAR_VERSION` 或 `DEEPSONAR_IMAGE_TAG`；warmup/dispatcher 未就绪时仍 200 且 `ready=false` |
| GET | /openapi.json | 豁免 | OpenAPI 3.0.3 完整文档 |
| GET | /schema | 豁免 | `?format=openapi`（默认）/ `summary` / `markdown` |
| GET | /schema.md | 豁免 | Markdown 契约（本文件） |
| GET | /metrics | admin | Prometheus 文本 |

### 项目

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /dashboard/overview | projects:read | 态势 P0 运营总览聚合：项目/任务/Job/Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建/完成任务与新增 Finding、活跃项目 Top N 与最近活动；项目级 token 只看到本项目 |
| GET | /dashboard/usage | projects:read | 用量账本：聚合 `job_usage_ledger`（含缓存读/写）。`period=day\|week\|month` 为上海日历滚动窗口；`period=custom` 时 `from`/`to` 为含首尾的 `YYYY-MM-DD` 或 ISO 时刻，最长 366 天。可选 `project_id`/`canvas_id`；不定价；项目级 token 只看到本项目 |
| GET | /projects | projects:read | 项目列表 |
| POST | /projects | projects:write | 创建 `{name, description?}` |
| GET | /projects/:id | projects:read | 项目详情 |
| PATCH | /projects/:id | projects:write | `{name?, description?, status?: active\|archived}` |
| POST | /projects/:id/archive | projects:write | 归档项目 |

### 任务 / 事件 / 画布

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/tasks | tasks:write | 创建任务 `{title, content, kind?, seed_finding_ids?, allow_egress?, schedule_beijing_8am?, scheduled_start_at?}`；`kind` 缺省为 `standard` 且禁止种子，`compose` 必须显式提交同项目 1–8 个当前可代入（未否定处置，含未确认）Finding UUID；省略出网字段时继承项目默认值；`scheduled_start_at`（ISO）优先于北京时间 08:00 快捷项 |
| PATCH | /tasks/:canvasId | tasks:write | 就地更新 `{title?, content?}`（至少一项）；同步 `canvases.title` 与 `target_json.title/content/goal` 及 root 节点。只影响后续 Hub 读图 / 新派生 Job / 显式重试，不改写已冻结 Job `agent_snapshot_json`。归档返回 `409 TASK_ARCHIVED` |
| POST | /tasks/:canvasId/pause | jobs:control | 幂等 drain pause；阻止该 Canvas 继续 claim，已在 claimed/provisioning/running/waiting_human 的 Job 安全收尾。返回 `execution_state/active_count/pending_count/changed` |
| POST | /tasks/:canvasId/start | jobs:control | 幂等解除执行门禁并 `pg_notify`；不清 schedule，不重试 failed/orphan/cancelled；归档任务返回 `409 TASK_ARCHIVED` |
| POST | /tasks/:canvasId/resume-session | jobs:control | 继续任务且不删历史；无活动 Job 时优先把全部启动中断的 role Worker 按同 Job ID、旧冻结快照重新入队（`action=rerun_interrupted_jobs`，Dispatcher 建新 Attempt），旧 unknown/never effect 不重放；批次或单 Job 任一快照身份漂移时整次返回 `409 SNAPSHOT_STALE` + `job_ids`，应逐 Job 调用 `rerun-current`；无可恢复 Job 强制唤醒 Hub 时若当前配置无法解析，同样 `409 SNAPSHOT_STALE` |
| POST | /tasks/:canvasId/archive | tasks:write | 归档任务 |
| POST | /tasks/:canvasId/unarchive | tasks:write | 取消归档 |
| DELETE | /tasks/:canvasId | tasks:write | 删除任务 |
| POST | /tasks/:canvasId/retry | jobs:control | 同画布重试（复用同一 canvas）；compose 在清空前重验冻结种子，失效时返回 `409 COMPOSE_SEEDS_STALE` 且不清空现有数据；当前 Hub RoleConfig/Credential 无法解析时返回 `409 SNAPSHOT_STALE` 且不清空 |
| POST | /projects/:id/events | tasks:write | 外部事件 `{source, event_id, event_type, title?, content?, data?}`，`source+event_id` 幂等 |
| GET | /projects/:id/canvases | tasks:read | 画布列表（一次任务 = 一个画布）；投影 `execution_state=pausing|paused|running`、`execution_active_count` 与 `pending_count` |
| GET | /canvases/:id | tasks:read | 画布节点/边；`canvas` 含任务执行控制投影 |
| GET | /canvases/:id/summary | tasks:read | 画布摘要 |
| GET | /canvases/:id/delta | tasks:read | `?since=` 增量图数据 |
| GET | /canvases/:id/nodes/:nodeId | tasks:read | 节点详情 |
| GET | /canvases/:id/facts | tasks:read | Fact keyset 分页；支持 `after/limit`，`verification_status/evidence_kind/finding_id/job_id` 接受逗号分隔多值并按同维度 OR |
| GET | /canvases/:id/facts/:nodeId | tasks:read | Fact 完整正文、结构化 Finding/Job 关联和有界直接链路 |
| PATCH | /canvases/:id/facts/:nodeId/verification | jobs:control | Fact 人工验证 `{status: verified\|rejected\|needs_human, note?}` |
| GET | /canvases/:id/broadcasts | tasks:read | Fact/Finding 广播投递账本；`injected` 仅表示已注入会话，不表示 Agent 已阅读 |
| GET | /canvases/:id/messages | tasks:read | 读取人工消息账本，`limit` 为 1–500 |
| POST | /canvases/:id/messages | tasks:write | 发送人工消息 `{message_id,target:{kind:hub\|job,node_id?},body,attachment_version_ids}`；带附件还要求 `assets:read` |
| POST | /canvases/:id/human-nodes/:nodeId/ignore | jobs:control | 忽略仍为 open 的人工介入节点；若对应 Job 为 waiting_human 则关闭旧 Attempt 并恢复 pending |

### 共享资产

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET / POST | /projects/:id/shared-assets | assets:read / assets:write | 项目目录；GET 支持 `limit/offset`，POST 为原始字节并要求 `x-asset-key` |
| GET / PATCH | /projects/:id/shared-assets/policy | assets:read / assets:write | 读取或设置 `{platform_enabled}` |
| GET / POST | /findings/:id/shared-assets | assets:read / assets:write | Finding 工作包；GET 支持 `limit/offset`，服务端校验 Finding 归属项目 |
| GET / POST | /platform/shared-assets | assets:manage + admin actor | 平台管理员目录与上传；GET 支持 `limit/offset` |
| GET | /shared-assets/:id/content | assets:read | 鉴权下载；项目 token 读取 platform 资产还要求项目 opt-in |
| POST | /shared-assets/:id/archive | assets:write | 归档逻辑对象，保留不可变版本和 Job 引用 |

Agent 不调用这些 HTTP 上传接口；运行中使用 Job 按 RoleConfig 冻结的 `list_shared_assets` / `publish_shared_asset`。前者支持 `scope/prefix/limit/offset`，后者只能发布普通 `/workspace` 正则文件到 project 或当前绑定 Finding，不能写 platform。

### Job

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /jobs | tasks:write | 直接建公共角色 job `{project_id, type, title?, payload?, priority?, timeout_sec?}`；公共入口对 `hub_reason` / `hub` / `verify_finding` / `report` 返回 409；`verify` 仅为 runtime-image smoke 兼容别名，不能伪造 scheduling purpose；系统 Job 由 Scheduler 创建 |
| GET | /jobs | tasks:read | 列表；`?project_id=` 可选 |
| GET | /jobs/:id | tasks:read | 详情（含事件） |
| GET | /jobs/:id/events | tasks:read | 语义事件分页（`cursor/limit`） |
| GET | /jobs/:id/evidence | tasks:read | 运行证据 manifest 与 transcript URI；finalized manifest 缺失但 `attempts/*/stream.ndjson` 存在时返回有界 synthetic/inflight manifest；已销毁容器中的 Session 不伪造，以 `capture_error` 明示 |
| GET | /jobs/:id/evidence/session | tasks:read | 会话证据：默认主 Session；`artifacts` 列出 main/subagent/vendor_export；`?path=` 切换。在线预览 8 MiB |
| GET | /jobs/:id/evidence/session/download | tasks:read | 下载所选 Session 归档全文；`?path=` 与查看接口相同 |
| GET | /jobs/:id/evidence/stream | tasks:read | 证据流分页（`cursor/limit/tail`） |
| PATCH | /jobs/:id/priority | jobs:control | 仅 pending：`{priority}`；值必须匹配 Scheduler 根据 Job 类型/Finding 严重度计算的固定 priority class，不能任意改分 |
| POST | /jobs/:id/cancel | jobs:control | 取消（可选 `{force,reason}`；running 回收沙箱） |
| POST | /canvases/:id/jobs/cancel-active | jobs:control | 取消画布当前活跃 Jobs |
| POST | /jobs/:id/resume | jobs:control | failed/timeout/orphan/waiting_human 使用旧冻结快照重新执行（同 Job、新 Attempt）；当前 agent_cli/model/upstream_model/credential/runtime adapter/image digest 等受治理身份漂移或无法解析时返回 `409 SNAPSHOT_STALE` |
| POST | /jobs/:id/rerun-current | jobs:control | failed/timeout/orphan/waiting_human 按当前 RoleConfig/Credential/项目网络、共享资产与 runtime image 策略完整重冻后重新执行；保留同 job_id、payload/parent/canvas/Intent/Fact/Finding 与旧 Attempt/effect |

### 结果与报告

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /findings | findings:read | Finding 列表；`?project_id=` / `?canvas_id=`；未分页窗口 500 条 |
| GET | /projects/:id/findings/summary | findings:read | 项目风险聚合（严重度 / verify_status / disposition / 来源任务）；可选 `?canvas_id=` |
| GET | /findings/:id | findings:read | Finding 详情、验证 Jobs、来源事件、评论、链接、验证轮次和 trace |
| POST | /findings/:id/verify | jobs:control | 人工强制创建下一轮 Scheduler Verify；可选 `{reason?}`，仍受活动任务、轮次和深度护栏约束 |
| POST | /findings/:id/evidence-jobs | jobs:control | 新建绑定当前 Finding 的补证 Job，body 为 `{role: review\|test}` |
| PATCH | /findings/:id/disposition | findings:write | `{disposition, note?}` |
| POST | /findings/:id/comments | findings:write | `{body, request_hub?}`；评论可请求 Hub 继续分析 |
| DELETE | /findings/:id/comments/:commentId | findings:write | 删除评论 |
| POST | /findings/:id/links | findings:write | `{url, title?, link_type?}` |
| DELETE | /findings/:id/links/:linkId | findings:write | 删除链接 |
| GET | /findings/:id/report | findings:read | Finding 报告详情 |
| POST | /findings/:id/report | jobs:control | 生成/重算 Finding 报告 |
| GET | /canvases/:id/report | tasks:read | 任务报告元数据（status / markdown_uri / sarif_uri） |
| GET | /reports/:id/markdown | tasks:read | **非 JSON attachment**，`text/markdown; charset=utf-8`，`Content-Disposition: attachment; filename="report-<id>.md"` |
| GET | /reports/:id/sarif | tasks:read | **非 JSON attachment**，`application/sarif+json; charset=utf-8`，`Content-Disposition: attachment; filename="report-<id>.sarif"` |
| POST | /canvases/:id/report/retry | jobs:control | 仅 `failed` 可重试，否则 409 |

### 设置（规则与角色启停）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /global-settings | agents:read | `{rules, effective_rules, active_by_agent_cli, active_by_provider}`；`effective_rules` 含 `maxGlobalJobs` / `maxJobsPerProject` / `maxConcurrentByAgentCli` |
| PATCH | /global-settings | agents:write | `{rules: {...}, finding_protocol?}` 合并；claim 读 effective 并由 `pg_notify` 唤醒。并发默认 **20 / 5**（env/代码）；库 `rules_json` 优先。Finding 协议默认 **CVSS 3.1**（接受 3.1/4.0），模式 hybrid/fixed/agent_choice |
| GET | /projects/:id/settings | agents:read | 项目规则覆盖 + 角色启用 + `effective_rules.maxConcurrentJobs` / `maxConcurrentJobsSource` + `active_jobs` |
| PATCH | /projects/:id/settings | agents:write | `{rules?, roles?: {enabled: string[] \| null}, finding_protocol?}`；`rules.maxConcurrentJobs` 为 `0–1000` 或 `null`（清除继承全局）；`enabled: null` 恢复默认 |

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
  "agent_cli": "claude-code | pi | dsh",
  "dsh_task_mode": "standard | ptc",
  "model": "string | null",
  "env_keys": ["..."],
  "env_vars": { "KEY": "value" },
  "modules": [
    "<source_id>:<module_id>",
    "<source_id>:plugin:<plugin_path>",
    "<source_id>:source:*"
  ],
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
  "sandbox_limits": {
    "cpu": 2,
    "memoryMiB": 4096,
    "pidsLimit": 256
  },
  "credentials": [{ "credential_id": "uuid", "purpose": "llm" }],
  "config_files": [{ "path": ".claude/settings.json", "content": "{...}" }]
}
```

保存前服务端校验：env 白名单、镜像可信目录、Credential 项目边界、配置文件路径白名单与密钥特征扫描，**越界一律 400**。

`source_id` 必须是固定格式 UUID；selector 原样落库。`plugin:` 和 `source:*` 在创建下一 Job 时按当前 trusted/enabled catalog 展开，因此同步后的新增模块会跟随组选择器进入新快照；历史 Job 不会漂移。导入导出会保留合法 selector，路径中的 `..`、绝对路径、空段和未知保留前缀会被拒绝。

常见 400：
- `runtime_image_key 没有可信版本: <key>` — 市场 catalog 有 key 不等于有 `trust_status=trusted` 的版本；先配置 `DEEPSONAR_OFFICIAL_*_IMAGE=@sha256:...` 重启，或 import+approve。
- 建任务 / 开始任务时若市场 key 只有 `revoked` 版本，返回 `409 RUNTIME_IMAGE_REVOKED`；若版本存在但尚未 trusted，返回 `409 RUNTIME_IMAGE_NOT_TRUSTED`。这两种都不是 `RUNTIME_IMAGE_PLATFORM_UNAVAILABLE`（后者只表示 trusted 版本未声明宿主平台）。
- 凭据 `purpose` 必须是 **`llm`** 才会进入模型通道；其它 purpose 不会被 Executor 当作 LLM key。

`platform_tools` 接受平台工具**全集**中的任意工具名（每个 Agent 均可勾选，不再按 role/kind 裁剪 list）；未声明的工具默认启用。仅 **`mark_job_done`** 为形成合法终态所必需，不可关闭。授权以 Job 冻结的 `platform_tools` 快照为准。Hub 需要派发时由 `list_available_roles({})` 按需返回数据库中的项目可用工作角色；返回值排除 system/hub 角色，决策落地时服务端再次严格校验且不做默认回退。其他工具关闭后不会注入当次 Worker 的控制 MCP，也不会进入动态 `AGENTS.md`、`CLAUDE.md` 的可用工具说明。

`runtime_image_key`：
- `null` = 系统底座（调度默认 deepsonar-base）
- 官方 Chrome 产品 key 包括 `deepsonar-chrome-audit`、`deepsonar-chrome-test`、`deepsonar-chrome-fuzz`；ClickHouse 为 `deepsonar-clickhouse-audit`、`deepsonar-clickhouse-test`、`deepsonar-clickhouse-fuzz`；移动端为 `deepsonar-mobile`；以运行时 registry 为准
- 官方 catalog（含 `project_opt_in` 专项如 OpenHarmony）可先写入 RoleConfig
- Job 解析时：官方非 opt-in 默认可跑；opt-in / 第三方仍要求**项目启用**
- 与镜像市场列表对齐（enabled 官方全量可选）

`sandbox_limits` 是项目 RoleConfig 的唯一覆盖入口（不是全局 RoleConfig）；项目 RoleConfig 读取投影字段名为 `sandbox_limits_json`。Schema v24 的字段仍服从服务端硬上限，Job 创建时冻结。

Job 创建时必须冻结完整运行快照：项目 RoleConfig → 全局 RoleConfig → 平台缺省。模型按 `RoleConfig.model（可选覆盖）→ Credential settingsConfig → null` 解析；`reasoning` 只从 Credential `settings_config_json` 读取。快照含 effective `model`、物化后的 CLI 配置文件、Provider-owned `reasoning`、`credential_id` 与 `runtime_image`（digest）。**改 RoleConfig 或 Credential 不影响已创建 Job**。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /role-configs/global | agents:read | 全局缺省清单（含 credentials / config_files） |
| GET | /role-configs/bindable | agents:read | Provider 绑定选择器元数据（含 `agent_cli` / `runtime_image_key` / `can_bind`） |
| PATCH | /role-configs/:id/agent-cli | agents:write | 仅改 `agent_cli`；已绑 LLM 时校验 CLI↔Provider，兼容则同步凭据 `agent_cli` |
| PATCH | /role-configs/:id/runtime-image | agents:write | 仅改 `runtime_image_key`（`null`=系统底座）；不改写凭据/文件 |
| PUT | /role-configs/global/:roleId | agents:write | 全局 upsert（version +1）；绑定 LLM 凭据兼容则跟随最新 `agent_cli` |
| GET | /projects/:id/role-configs | agents:read | 各角色来源 project / global / none；`project_config` 返回实时完整项目覆盖 |
| PUT | /projects/:id/role-configs/:roleId | agents:write | 项目覆盖；普通角色须已启用（409）；绑定 LLM 凭据兼容则跟随最新 `agent_cli` |
| DELETE | /projects/:id/role-configs/:roleId | agents:write | 删除覆盖，回落全局 |

仓库管理 CLI 提供 `role-configs sync-builtin-prompts`：从 `database/schema.sql` 的单一基线提取内置 Prompt，读取线上全局 RoleConfig 后仅替换 `instructions_markdown`，保留模型、凭据、镜像、模块和配置文件；可先用 `--dry-run` 查看 Prompt 哈希。

### 运行时镜像市场

市场只接受受治理 OCI 目录。第三方导入首先进入 `quarantined`，由独立 Image Admission Worker 解析不可变 digest 并完成验签、SBOM、漏洞/凭据/恶意文件扫描和断网自检。扫描通过也不会自动 trusted；必须由 `images:approve` 管理员提升，第三方版本还需要项目显式启用。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /runtime-images | images:read | 市场列表；`?search=` / `?project_id=` |
| GET | /runtime-images/:id | images:read | 产品、不可变版本、工具清单、SBOM/签名和扫描历史 |
| GET | /runtime-images/registry | images:read | 官方目录；保留 `schema/images`，并附 `selected_channel`（`github`\|`dockerhub`\|`aliyun-acr`）、`source`、`fallback`、`error`、`checked_at` 诊断 |
| PATCH | /runtime-images/registry/channel | images:manage | 严格 body `{channel: github\|dockerhub\|aliyun-acr}`；只允许全局/admin actor，项目限定 token 返回 `403 PROJECT_SCOPE_FORBIDDEN`；审计 `runtime_image.registry_channel_update` |
| POST | /runtime-images/registry/sync | images:manage | 刷新官方/内置 catalog；所选 channel 用于后续镜像引用解析与 pull，不决定 catalog 来源 |
| POST | /runtime-images/registry/apply | admin | 直接提交 registry 对象或 `{registry: ...}`；该内部运维入口未分配 `images:manage` scope |
| POST | /runtime-images/registry/pull | images:manage | 启动异步拉取任务，返回 202/task |
| GET | /runtime-images/registry/pull-status | images:read | 拉取任务状态、进度与错误 |
| POST | /runtime-images/:id/detect-local | images:read | `{image_ref}`；读取本机 Docker 元数据并返回候选（不会改变信任状态） |
| POST | /runtime-images/:id/adopt-local | images:approve | `{image_ref, expected_image_id}`；仅官方产品的 adoptable 候选可由管理员二次确认采用；第三方仍走准入扫描 |
| POST | /runtime-images/import | images:manage | `{image_key,name,publisher,image_ref,description?,source_url?,version?,registry_credential_id?}`；返回 202 |
| POST | /runtime-image-versions/:id/rescan | images:manage | 重新入队；revoked 版本不可恢复 |
| POST | /runtime-image-versions/:id/status | images:approve | `{status: trusted\|rejected\|disabled\|revoked, reason?}`；rejected/revoked 必填 reason |
| GET | /runtime-image-versions/:id/usage | images:read | 反向查询历史 Job、项目和 Finding |
| PUT | /projects/:id/runtime-images/:imageId | images:manage | `{enabled, version_id?}`；只能启用 trusted 版本，`version_id` 用于固定/回滚 |
| POST | /runtime-images/:id/official-digest | images:approve | 管理员登记官方不可变 digest |
| POST | /runtime-images/manual-digest | images:approve | 管理员登记手工 digest（需完整 `image_ref`） |

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
| GET | /credentials/providers | agents:read | Scheduler-owned Provider catalog and validation metadata |
| GET | /credentials | agents:read | 列表（指纹 / last4 / 安全 metadata / scope / health / bound RoleConfig count；无密文） |
| GET | /credentials/:id | agents:read | 详情（安全 health/model catalog + 有界 impact 投影；无密文） |
| GET | /credentials/:id/impact | agents:read | 只读影响：RoleConfig、pending / active / recoverable / terminal Job，以及活动镜像准入扫描（counts + 有界条目） |
| POST | /credentials | agents:write | LLM：`{name, provider: anthropic\|openai, agent_cli, secret, settings_config, metadata?}`；OCI 使用 `kind=oci_registry`、`provider=<registry-host>`、`metadata={registry,username}` |
| PATCH | /credentials/:id | agents:write | `{name?, provider?, project_id?, metadata?, agent_cli?, settings_config?, meta?}`；`settings_config` 中 `[已保存密钥]` 由服务端恢复原值 |
| POST | /credentials/:id/rotate | agents:write | `{secret}` 轮换密钥 |
| POST | /credentials/:id/status | agents:write | `{status: active\|disabled\|rotation_required}` |
| DELETE | /credentials/:id | agents:write | 删除已保存账号；pending/active Job 拒绝（`CREDENTIAL_IN_USE`）；failed/timeout/orphan 可恢复历史不挡删除；活动扫描拒绝（`CREDENTIAL_SCAN_IN_USE`）；绑定 RoleConfig 时需 `?unbind=true` 并 bump version；吊销 `job_tokens`；不改写历史 Job 快照 |
| POST | /credentials/:id/test | agents:write | 连接测试（无 body；会更新健康证据） |
| POST | /credentials/:id/models | agents:write | 实时拉取 Provider 模型目录（无 body；用于配置文件模型字段的参考） |
| POST | /credentials/models/preview | agents:write | `{agent_cli, provider, secret, base_url?, settings_config?}`；未保存账号一键获取模型目录，不落库/审计/回显密钥 |
| GET | /credentials/:id/models | agents:read | 读取已持久化的有界模型 ID 目录 |
| GET | /credentials/:id/compatibility | agents:read | `?agent_cli=claude-code|pi|dsh&model=<可选覆盖>`；省略 model 时服务端从 Credential settingsConfig 解析 effective model；leftover `codex`/`open-code` 拒绝并提示迁移 |
| POST | /credentials/batch-bind | agents:write | `{credential_id, role_config_ids[], mode: bind|migrate, source_credential_id?, model?, effect: new_jobs_only|refresh_pending, idempotency_key}`；运行中 Job 不会被改写 |

LLM `provider` 表示 Gateway wire protocol：`anthropic` = Anthropic Messages，`openai` = OpenAI Responses。`settings_config_json.reasoning` 由 Provider/模型拥有；Claude Code 只接受 `low | medium | high | xhigh` 并物化为 `effortLevel`；Pi 只接受 `off | minimal | low | medium | high | xhigh | max`；DSH 只接受 `off | minimal | low | medium | high | xhigh | max`，第三方 wire value 必须配置在模型 `reasoningEfforts` 映射。leftover Codex/OpenCode 凭据仍可读历史 reasoning，但不能再保存为新配置。DSH 使用官方 `@deepseek-ai/dsh-llm-pi-ai` 与固定提交的 `dsh-reasoning-settings@0.3.0`，`settings_config_json.config` 保存官方 `settings.yaml` 形状的 YAML（`llm-pi-ai.providers` + `agent-default-model`）；route 可自定义，`api` 必须与 Credential wire protocol 兼容。Job 只冻结一个 route，并把 endpoint/credential 强制替换为 Model Gateway 与短期 Job token。其它 CLI 的 `settings_config_json` 在 Job 创建时物化为 Agent 沙箱内的 CLI 文件；管理 API 只返回带 `[已保存密钥]` 的脱敏投影。Credential `metadata` 不是任意 JSON。服务器按 kind/provider 只接受 LLM 的 `base_url`、`model_concurrency`、`max_concurrent`，或 OCI 的 `registry`、`username`；未知/secret-like key、URL userinfo/query/fragment 均拒绝。旧 `allowed_model_ids` 读写静默忽略，模型可用性只认 `settings_config`。连接健康只保存固定 category 与平台生成人话；Provider body、Authorization、密钥和带 query 的 URL 永不进入 API、审计或 transfer。

### 平台导入导出（.deepsonarpack）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/exports | exports:write | 项目包；`preset=configuration|project_full|evidence_archive|custom`，可选 `modules/include_blobs/allow_active_jobs/credentials.mode` |
| GET | /projects/:id/exports | exports:read | 项目导出任务列表 |
| POST | /platform/exports | exports:write | `{preset: platform_full\|custom, modules?: string[], credentials?: {mode}}`；`custom` 时 `modules` 可自由勾选：`global_rules` / `agent_roles` / `global_role_configs` / `skill_sources` / `credentials` |
| GET | /platform/exports | exports:read | 平台导出任务列表 |
| GET | /exports/:id | exports:read | 导出详情（pending/collecting/packaging/succeeded/failed/cancelled） |
| GET | /exports/:id/download | exports:read | 下载 pack |
| POST | /exports/:id/cancel | exports:write | 取消未完成导出 |
| DELETE | /exports/:id | exports:write | 删除导出记录及 artifact |
| POST | /imports | imports:write | 上传 `.deepsonarpack`（raw body，`application/zip`/`application/x-deepsonarpack`） |
| GET | /imports/:id | imports:read | 导入详情/状态 |
| POST | /imports/:id/preview | imports:write | 预览可导入模块与冲突 |
| POST | /imports/:id/apply | imports:write | `{mode: create_new|merge_configuration|merge_platform, project_name?, target_project_id?, modules?, conflict_policy?, credential_mappings?}` |
| POST | /imports/:id/cancel | imports:write | 取消未应用导入 |
| DELETE | /imports/:id | imports:write | 删除上传包及记录 |

AgentPack（`deepsonar.agentpack/v1`）是 Web 本地导入/安装格式；当前没有服务端 `/agent-packs` 端点。Web 安装时通过 Agent Role 与 RoleConfig API 完成登记，凭据与 secret-like 配置不会从 pack 直接写入。

### 管理面

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| * | /tokens* | tokens:manage | API Token 管理 |
| GET | /audit-logs | admin | 审计日志 |
| GET | /ws | tasks:read | Job 实时流 WebSocket |

### Readiness / preflight（#35/#36）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /readiness | agents:read | 全局只读预检；返回 `deepsonar.readiness/v1`、`ready`、稳定 `checks[]`、网络策略和非敏感 role/credential/image 摘要。 |
| GET | /projects/:id/readiness | agents:read | 按项目启用角色、RoleConfig 覆盖和项目网络默认值预检。 |

两个端点都接受可选查询参数 `allow_egress=true|false`（只模拟一次任务网络覆盖，不写入项目/画布）以及 `material_source=workspace_or_offline|external_or_workspace|declared|unspecified`。未声明 `material_source` 时保持 `unspecified`，不会因为允许出网就推断任务需要外部材料。`checks[].code` 是稳定机器码；通常 `severity=error` 会令 `ready=false`，此外全局 real 概览若镜像必须由具体项目启用，也会以 `RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED` 标记 unresolved 并保持 `ready=false`，需要改用项目端点确认。

Credential 连接测试和模型目录只读取 Scheduler append-only audit evidence，并要求最近 24 小时成功记录才标记 `ok`；没有证据或证据过期时响应会明确标记 `missing/stale`，不会凭空声称 Provider 在线或模型可用。运维通过 immutable digest 手工登记的第三方镜像若标记为跳过准入扫描，会给出显式 warning，但遵循运行时 resolver 的实际可执行语义。响应绝不包含 secret、任意 env 名/值、ciphertext、base URL 或任意 OCI 引用；runtime image 仅返回受治理的 `image_key`、版本 ID、digest、trust/准入摘要。

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
| 502 | 上游失败（Git 同步等） |

## 幂等

- 任务创建：`jobs.ingress_key` 唯一；重复提交返回既有 Job。
- 事件注入：`(project_id, source, event_id)` 幂等。
- RoleConfig PUT：声明式全量替换 credentials/config_files，重复提交安全。
- 无 body 的 POST（sync / test / resume / model refresh 等）**不要**带 `Content-Type: application/json`，否则 Fastify 可能 400；cancel 只有传 force/reason 时才带 JSON body。

## Job 状态与运维

```text
pending → claimed → provisioning → running → waiting_human → succeeded|failed|timeout|cancelled|orphan
```

- `POST /jobs/:id/resume`：使用旧冻结快照重新执行；当前受治理身份与旧快照不同或无法解析时稳定返回 `409 SNAPSHOT_STALE`，不静默使用旧模型。
- `POST /jobs/:id/rerun-current`：在 Dispatcher admission lock 与 Canvas→Job 行锁下完整重冻当前快照后原子转 `pending`；running/claimed/provisioning/pending 均返回 `409 JOB_NOT_RESUMABLE`。
- 改 `apps/scheduler/src` 触发 tsx watch 时，**running → orphan**；resume 后继续。
- schema 版本：以运行中 `/schema` 为准；远端 `origin/main` 最新基线为 v24，当前未同步 checkout 仍可能是 v23。空库套对应 checkout 的 `database/schema.sql`，非空只校验版本与表结构。版本不符 fail closed，无增量 migration——备份后重建库。
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
