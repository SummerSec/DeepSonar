# DeepSonar Management API 契约

> 状态：当前集成分支 API 参考；字段与授权以运行时 schema 和宿主实现为准，未验收范围明确保留。
> 同步日期：2026-11-08

> **权威机器可读 schema（运行时）**：调度器提供以下豁免鉴权端点，优先以此为准。
> - `GET /openapi.json` — OpenAPI 3.0.3 完整 JSON
> - `GET /schema` — 默认同 openapi；`?format=summary|markdown|openapi`
> - `GET /schema.md` — 本文件（仓库内副本）或运行时生成摘要

Base URL：`DEEPSONAR_BASE_URL`，按实际管理入口配置；本机示例 `http://127.0.0.1:3100`。
认证：`Authorization: Bearer <session or API Token>`（`DEEPSONAR_AUTH_REQUIRED=false` 时本地回环可省略）

**普通 Bearer hook 豁免**：`/health`、`/openapi.json`、`/schema`、`/schema.md`、`/auth/status`、`/auth/login`、`/auth/bootstrap`、`/workers/register`、`/workers/heartbeat`、`/gateway/*`、`/ws`、`/terminal-ws`。其中 `/gateway/*` 使用 Job Token 自鉴权；`/workers/register` 使用 `DEEPSONAR_WORKER_BOOTSTRAP_TOKEN`，`/workers/heartbeat` 使用注册返回的节点 token；`/ws` 与 `/terminal-ws` 必须携带 `POST /auth/ws-ticket` 签发的一次性 ticket，不是匿名入口。

**OpenAPI 覆盖边界**：`GET /openapi.json` 覆盖 Management HTTP operation。Gateway 代理、Job-scoped Control 与 WebSocket 使用各自的认证和运行时契约；Control 另提供当前 Job 的动态 schema/OpenAPI，不并入全局 Management 清单。`route-surface.test.ts` 用显式 allowlist 检查边界，新增路由既未登记也不在 allowlist 会失败。

`x-deepsonar-scope`：具体 scope 名 = 需要该 scope；`authenticated` = 任意已认证主体（无具体 scope 要求）；`exempt` = 豁免鉴权。

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
| GET | /health | 豁免 | 存活检查 `{ok, ready, version, runtime_images, dispatcher, ts}`；`version` 只来自 `DEEPSONAR_VERSION`；warmup/dispatcher 未就绪时仍 200 且 `ready=false` |
| GET | /openapi.json | 豁免 | OpenAPI 3.0.3 完整文档 |
| GET | /schema | 豁免 | `?format=openapi`（默认）/ `summary` / `markdown` |
| GET | /schema.md | 豁免 | Markdown 契约（本文件） |
| GET | /metrics | admin | Prometheus 文本 |
| GET | /workers | admin | 执行面 worker 注册表（无凭据） |
| POST | /workers/register | 豁免（bootstrap token） | `{node_id,endpoint,opensandbox_api_key,capacity,protocol_version,platform_version,deployment_generation}`；返回一次性 `node_token`。不能占用保留 `local`（及 `DEEPSONAR_WORKER_LOCAL_ID`），已有节点重新准入必须携 `X-DeepSonar-Worker-Node-Token` 验证原身份；受管 generation 还必须携独立 `X-DeepSonar-Worker-Generation-Token`，不能仅凭 bootstrap token 换 id 绕过；远程 endpoint 拒绝 loopback / link-local / `169.254.0.0/16` / 不可路由地址。按 IP 限流并写审计 |
| POST | /workers/heartbeat | 豁免（node token） | 刷新存活与容量；版本/generation 或受管代次的 X-DeepSonar-Worker-Generation-Token 缺失或不匹配时保持 unavailable，正确心跳也不能自行解除已有 fence；不能改 endpoint / protocol / kind。拒绝改写所有权时 `409 WORKER_HEARTBEAT_OWNERSHIP`。按 IP 限流；拒绝写入审计 |
| DELETE | /workers/:id | admin | 显式 forget 无租约节点；存在租约时 `409`，不得删除执行证据。升级重新准入使用 register 并保留原 token/leases |

### 项目

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /dashboard/overview | projects:read | 态势 P0 运营总览聚合：项目/任务/Job/Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建/完成任务与新增 Finding、活跃项目 Top N 与最近活动；项目级 token 只看到本项目 |
| GET | /dashboard/ops | projects:read | 态势 P1/P2 服务端运营指标：Finding severity/disposition/verify 分布、高风险未闭环、项目/任务覆盖、近 7 日成功率/耗时/角色对比、并发水位与失败原因；`query_planes.snapshot=current`、`throughput=history` |
| GET | /dashboard/usage | projects:read | 用量账本：聚合 `job_usage_ledger`（含缓存读/写）。`period=day\|week\|month` 为上海日历滚动窗口；`period=custom` 时 `from`/`to` 为含首尾的 `YYYY-MM-DD` 或 ISO 时刻，最长 366 天。可选 `project_id`/`canvas_id`；不定价；项目级 token 只看到本项目 |
| GET | /dashboard/quality | projects:read | 只读质量指标（#445 Phase 1）：确认率、误报率、Verify 分歧率、人工介入率、单 Finding token/时间成本。从 Job / Finding / Verify / Usage Ledger 派生，不改变 Hub 决策。可选 `project_id`/`canvas_id` |
| GET | /dashboard/quality/replay | projects:read | Hub 回放基线：固定 `hub_replay` schema_version=1。可选 `project_id`/`canvas_id`/`limit`（默认 50，最大 200）。`recalled_experiences` Phase 1 恒为空 |
| GET | /projects/:id/quality | projects:read | 项目级质量指标，语义同 `/dashboard/quality?project_id=`。项目级 token 的 `:id` 必须匹配，否则 `PROJECT_MISMATCH` |
| GET | /projects/:id/quality/replay | projects:read | 项目级 Hub 回放基线。项目级 token 的 `:id` 必须匹配，否则 `PROJECT_MISMATCH` |
| GET | /canvases/:id/quality | tasks:read | 任务级质量指标 |
| GET | /canvases/:id/quality/replay | tasks:read | 任务级 Hub 回放基线 |
| GET | /projects | projects:read | 项目列表 |
| POST | /projects | projects:write | 创建 `{name, description?}` |
| GET | /projects/:id | projects:read | 项目详情 |
| PATCH | /projects/:id | projects:write | `{name?, description?, status?: active\|archived}` |
| POST | /projects/:id/archive | projects:write | 归档项目 |

### 任务 / 事件 / 画布

可选 `task_contract` 的版本、模板、字段与准入语义见[下发指南](task-dispatch.md)。已提供契约的 objective/targets/scope/evidence/acceptance 基本完整性在创建/派发检查；201 返回其他字段级 `task_contract_warnings`；创建前存在必要条件阻塞时返回 `409 task_contract_blocked`、`task_contract_blockers` 及 warnings，且不创建 Canvas/Job。每条反馈包含 `code/path/message/suggestion`。未提供契约仍接受自由文本，不按 Markdown 标题拒绝。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/tasks | tasks:write | 创建任务 `{title, content, kind?, seed_finding_ids?, allow_egress?, schedule_beijing_8am?, scheduled_start_at?, device?, task_contract?}`；`device` = 真实设备需求 `{transport, key?, model?, exclusive?, ttl_sec?, roles?}`（缺省 `roles:["test"]`），冻结进 Job 快照并需要项目先 `device_access_enabled=true`，否则 `409 device_not_authorized`；`kind` 缺省为 `standard` 且禁止种子，`compose` 必须显式提交同项目 1–8 个当前可代入（未否定处置，含未确认）Finding UUID；省略出网字段时继承项目默认值；`scheduled_start_at`（ISO）优先于北京时间 08:00 快捷项 |
| GET | /projects/:id/task-queue | tasks:read | 项目 FIFO 队列返回 `{project_id, paused, pause_reason, items, has_more}`；`items[].state` 为 `active/queued/succeeded/failed/cancelled`，活动/等待优先、历史随后，最多 100 项，`has_more` 表示截断；只读投影，不改变 Job 状态 |
| PATCH | /projects/:id/task-queue | jobs:control | `{paused:true}` 暂停推进；恢复为 `{paused:false}`，队列因当前队首失败/取消暂停时，须提交 `{paused:false, acknowledge_failed_head:"当前条目ID"}` 确认跳过；`paused:true` 携带确认被严格 schema 拒绝，旧条目 ID 拒绝；不自动重试、不改写历史 |
| POST | /projects/:id/task-queue/items | jobs:control | `{canvas_id}` 把同项目已有且含合法 pending 工作的任务追加到队尾；已 queued/active 的重复入队幂等成功，保留条目 ID/位置；终态 membership 的新执行排尾，状态/归属不符时拒绝；等待项获得资格前不启动执行 Job |
| PATCH | /tasks/:canvasId | tasks:write | 就地更新 `{title?, content?, plan_objective?}`（至少一项）；`plan_objective` 只能由授权用户提交 `{expected_revision, goal, completion, budget}`，在 Canvas 行锁内做当前目标 revision CAS，冲突返回 `409 plan_stale_revision`，不接受 Agent 的 Plan payload。同步 `canvases.title` 与 `target_json.title/content/goal/plan_objective` 及 root 节点；只影响后续 Hub 读图 / 新派生 Job / 显式重试，不改写已冻结 Job `agent_snapshot_json`、Attempt 或事件。归档返回 `409 TASK_ARCHIVED`。`200` 返回当前 `plan_objective` 与 `snapshot_rewritten:false` |
| POST | /tasks/:canvasId/pause | jobs:control | 幂等 drain pause；阻止该 Canvas 继续 claim，已在 claimed/provisioning/running/waiting_human 的 Job 安全收尾。返回 `execution_state/active_count/pending_count/changed` |
| POST | /tasks/:canvasId/start | jobs:control | 幂等解除执行门禁并 `pg_notify`；不清 schedule，不重试 failed/orphan/cancelled；归档任务返回 `409 TASK_ARCHIVED` |
| POST | /tasks/:canvasId/resume-session | jobs:control | 继续任务且不删历史；无活动 Job 时优先把全部启动中断的 role Worker 按同 Job ID、旧冻结快照重新入队（`action=rerun_interrupted_jobs`，Dispatcher 建新 Attempt），旧 unknown/never effect 不重放；批次或单 Job 任一快照身份漂移时整次返回 `409 SNAPSHOT_STALE` + `job_ids`，应逐 Job 调用 `rerun-current`；无可恢复 Job 强制唤醒 Hub 时若当前配置无法解析，同样 `409 SNAPSHOT_STALE` |
| POST | /tasks/:canvasId/archive | tasks:write | 归档任务 |
| POST | /tasks/:canvasId/unarchive | tasks:write | 取消归档 |
| DELETE | /tasks/:canvasId | tasks:write | 删除任务 |
| POST | /tasks/:canvasId/retry | jobs:control | 同画布重试（复用同一 canvas）；compose 在清空前重验冻结种子，失效时返回 `409 COMPOSE_SEEDS_STALE` 且不清空现有数据；当前 Hub RoleConfig/Credential 无法解析时返回 `409 SNAPSHOT_STALE` 且不清空 |
| POST | /projects/:id/events | tasks:write | 外部事件 `{source, event_id, event_type, title?, content?, data?}`，`source+event_id` 幂等 |
| GET | /projects/:id/canvases | tasks:read | 画布列表（一次任务 = 一个画布）；投影 `execution_state=pausing\|paused\|running`、`execution_active_count` 与 `pending_count` |
| GET | /canvases/:id | tasks:read | 画布节点/边；`canvas` 含任务执行控制投影 |
| GET | /canvases/:id/summary | tasks:read | 画布摘要 |
| GET | /canvases/:id/delta | tasks:read | `?since=` 增量图数据 |
| GET | /canvases/:id/nodes/:nodeId | tasks:read | 节点详情 |
| GET | /canvases/:id/facts | tasks:read | Fact keyset 分页；支持 `after/limit`，`verification_status/evidence_kind/finding_id/job_id` 接受逗号分隔多值并按同维度 OR |
| GET | /canvases/:id/facts/:nodeId | tasks:read | Fact 完整正文、结构化 Finding/Job 关联和有界直接链路 |
| PATCH | /canvases/:id/facts/:nodeId/verification | jobs:control | Fact 证据信任收口 `{status: verified\|rejected\|needs_human, note?}`；不能写 `unverified`/`verifying`；`rejected→verified` 须先 `needs_human`。不改 Finding `verify_status`。数量门禁只认 `verified` |
| GET | /canvases/:id/broadcasts | tasks:read | Fact/Finding 广播投递账本；`injected` 仅表示已注入会话，不表示 Agent 已阅读 |
| GET | /canvases/:id/messages | tasks:read | 读取人工消息账本，`limit` 为 1–500 |
| POST | /canvases/:id/messages | tasks:write | 发送人工消息 `{message_id,target:{kind:hub\|job,node_id?},body,attachment_version_ids}`；带附件还要求 `assets:read` |
| POST | /canvases/:id/human-nodes/:nodeId/ignore | jobs:control | 忽略仍为 open 的人工介入节点；若对应 Job 为 waiting_human 则关闭旧 Attempt 并恢复 pending |
| GET | /canvases/:id/convergence | tasks:read | 画布收敛状态：`convergence` 与项目规则（`minVerifySeverity`/`maxVerificationRounds`）、`careSeverities` |
| POST | /canvases/:id/convergence/pause | jobs:control | 暂停 Hub 自动收敛 `{reason?}`（缺省 `manual_pause`）；已入队 Job 不受影响 |
| POST | /canvases/:id/convergence/resume | jobs:control | 恢复收敛 `{force_hub?}`；`force_hub=true` 时同事务强制唤醒一轮 Hub |
| POST | /canvases/:id/convergence/stop-after-gate | jobs:control | 本轮回合跑（收敛门外）即停，无 body；返回 convergence 与项目规则 |
| POST | /canvases/:id/convergence/drain-priority | jobs:control | 排空当前优先级层，无 body；返回责任严重度与各优先级剩余计数 |
| POST | /canvases/:id/convergence/run-hub-now | jobs:control | 立即唤醒一轮 Hub，无 body；已有活动 Hub 时不重复入队 |
| POST | /canvases/:id/jobs/cancel-active | jobs:control | 取消画布上全部活动 Job `{reason?}`；逐 Job 回收沙箱、吊销 Job Token 并把节点标记为 cancelled |

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
| POST | /jobs | tasks:write | 直接建公共角色 job `{project_id, type, title?, payload?, priority?, timeout_sec?}`；`type` 必须是当前角色名；公共入口对 `hub_reason` / `verify_finding` / `report` 返回 409；leftover `audit_module` / `hub` 不再映射为当前身份；`verify` 仅为 runtime-image smoke 兼容别名，不能伪造 scheduling purpose；系统 Job 由 Scheduler 创建 |
| — | `POST /jobs` 的 `payload.goal_review` | tasks:write | 可选严格评审请求 `{schema_version:1, finding_id? , fact_id?, candidate_artifact_id, task_contract_sha256, criterion_ids}`，`finding_id` 与 `fact_id` 必须恰好提供一个；前者为研究候选，后者为 `emit_fact.artifact.task_result` 生成的 delivery/negative_result Fact（blocked/not_executed 不可评为成果），对应 Artifact 必须一致。复用当前项目候选所属 Canvas 并冻结来源；非法结构 400、来源不可用 404、版本/前置条件不符 409，拒绝不创建新 Canvas。普通 Job 与 Hub 共用冻结规则，不能用请求自授权；详见[任务判据评审](../../../docs/TASK_GOAL_REVIEW.md)。 |
| GET | /jobs | tasks:read | 列表；`?project_id=` 可选 |
| GET | /jobs/:id | tasks:read | 详情（含事件）；`query_plane=current`，含导入 `provenance` |
| GET | /jobs/:id/events | tasks:read | 语义事件分页（`cursor/limit`）；`query_plane=history`，含 `attempt_id` |
| GET | /jobs/:id/evidence | tasks:read | 运行证据 manifest 与 transcript URI；finalized manifest 缺失但 `attempts/*/stream.ndjson` 存在时返回有界 synthetic/inflight manifest；已销毁容器中的 Session 不伪造，以 `capture_error` 明示 |
| GET | /jobs/:id/evidence/runtime | tasks:read | #990 完整 Pi RPC 回读：必填 `path/attempt_id/sha256`，可选 RFC 6901 `pointer`（空串选根）及选中值 `bytes` 断言；只读本 Job manifest 已索引的所选 Attempt 归档，先核验实际源 hash/长度，再 OM 脱敏、返回完整 typed `value`。`source` 为不可变归档元数据，返回 `bytes/sha256` 为实际值；缺损、越界、字段/指针非法、hash/长度不符或超读取预算明确拒绝。不触发 Agent 输入，预算/详细协议见 [Pi RPC 专题](../../../docs/PI_RPC_PAYLOAD_LIMITS.md) 与 `apps/scheduler/src/runtime-evidence.ts`（核对 2026-11-08；最终 Actions 待验收） |
| GET | /jobs/:id/evidence/session | tasks:read | 会话证据：默认主 Session；`artifacts` 列出 main/subagent/vendor_export；`?path=` 切换。DSH 当前 live capture 是 `sessions/<project>/<sessionId>/session.v4.jsonl`，历史 viewer 仍可读旧代归档。在线预览 8 MiB |
| GET | /jobs/:id/evidence/session/download | tasks:read | 下载所选 Session 归档全文；`?path=` 与查看接口相同 |
| GET | /jobs/:id/evidence/stream | tasks:read | 证据流分页（`cursor/limit/tail`） |
| PATCH | /jobs/:id/priority | jobs:control | 仅 pending：`{priority}`；值必须匹配 Scheduler 根据 Job 类型/Finding 严重度计算的固定 priority class，不能任意改分 |
| POST | /jobs/:id/cancel | jobs:control | 取消（可选 `{force,reason}`；running 回收沙箱） |
| POST | /jobs/:id/effects/:effectId/settlement | admin | #1002 P1-9 单条历史效果结清，严格 `{outcome,evidence,operation_id}`；项目限定 admin 仍按 Job 归属隔离。只写人工书面依据与真实认证主体，不补未知用量、不重排 Job、不改 replay_policy；不是 Job-scoped Agent operation。协议及字段限制见[单条效果结清](../../../deploy/README.md#管理-api-的单条效果结清1002-p1-9)与 OpenAPI（核对 2026-11-08；最终 Actions 待验收） |
| POST | /canvases/:id/jobs/cancel-active | jobs:control | 取消画布当前活跃 Jobs |
| POST | /jobs/:id/resume | jobs:control | failed/timeout/orphan/waiting_human 使用旧冻结快照重新执行（同 Job、新 Attempt）；导入 cancelled 返回 `409 JOB_IMPORTED_READONLY`；当前受治理身份漂移或无法解析时返回 `409 SNAPSHOT_STALE`。这会创建新的执行 Attempt，不承诺跨进程恢复 DSH 持久 Session；DSH 进程级恢复明确返回 `CONTEXT_RESUME_UNSUPPORTED` |
| POST | /jobs/:id/rerun-current | jobs:control | failed/timeout/orphan/waiting_human 按当前 RoleConfig/Credential/项目网络、共享资产与 runtime image 策略完整重冻后重新执行；保留同 job_id、payload/parent/canvas/Intent/Fact/Finding 与旧 Attempt/effect |

### Job-scoped Control API：目标授权与 Plan v2

沙箱内 Agent 使用 Job capability token 访问下列路由；它们不属于本文件的普通 Management HTTP/OpenAPI 清单，但 Scheduler 仍以当前 Job 的 operation allowlist、项目/Canvas scope、快照、预算和状态重新校验：

| 方法 | 路径 | 鉴权/范围 | 说明 |
| --- | --- | --- | --- |
| GET | /control/v1/jobs/:jobId/capabilities | Job token | 返回当前 Job 可用 operation 与 invoke URL；不授予额外权限 |
| GET | /control/v1/jobs/:jobId/openapi.json | Job token | 返回当前 Job allowlist 的机器契约 |
| GET / POST | /control/v1/jobs/:jobId/operations/:operationId | Job token | GET 只读 operation schema 或 `receipt_key`；POST 要求 `Idempotency-Key`，输入、状态、scope、引用和效果由宿主/事务层重新校验 |

`submit_plan` 只接受当前 Plan v2，匹配用户 objective/revision、`execution_route` CAS 和 goal/completion/budget；canonical 引用、依赖、lifetime 与已派发 task hash 由 Scheduler 重验，ready task 复用既有 Intent/Job。v1 的目标边界为历史只读；普通 HubIntent 走原 handler，不制造新的 v1 `plan_protocol`，旧 `hub_intent_adapter` 审计只作为不可变历史解析。`submit_plan_result` 只是匹配版本的结果提案，依赖须有当前成功 Attempt、Artifact/语义来源、实际留存字节及期望输出关联；工程 complete/completed 不等于任务完成，后者仍需全部当前正向操作员判据、完整读取与 Hub/Report 门。未知效果不自动 replay，receipt 查询只恢复原响应。

`graph_query(kind=plan_objective)` 是当前 Job scope 内独立于已接受 Plan 的完整只读读取；初始 L0/overview 仅给有界 handle，objective 查询返回 `items[0]` 持久化 tuple。selectors、cross-scope、wholeGraph 不属于受支持契约，预算或 input hash 不满足时如实失败。

目标 write 或显式 identity 触发只读 `deepsonar.target-authorization/v1`。宿主配置 authority/secret/精确动作链，以认证 principal 和契约声明生成 scope、前提、内容/契约 binding；authority 严格复述 revision/freshness 等当前条件。`reference-http/v1` 是当前支持目标，secret 不进请求体或快照；材料、声明或凭据存在不等于授权。创建/派发/重跑重新核验，缺失或变化 grant 以不可重试 `target_authorization_grant_invalid` 拒绝，其他错误保留各自稳定 code。没有目标授权管理端点，授权查询不执行目标动作，见 [ADR 0011](../../../docs/architecture/adr/0011-trusted-target-authorization.md)。

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
| GET | /canvases/:id/reports | tasks:read | 画布任务报告版本历史 |
| GET | /projects/:id/reports | tasks:read | 项目报告聚合（按任务编组总报告版本 + confirmed Finding 独立报告；可选 `canvas_id`） |
| GET | /reports/:id/markdown | report:read | **非 JSON attachment**，`text/markdown; charset=utf-8`，`Content-Disposition: attachment; filename="report-<id>.md"` |
| GET | /reports/:id/sarif | tasks:read | **非 JSON attachment**，`application/sarif+json; charset=utf-8`，`Content-Disposition: attachment; filename="report-<id>.sarif"` |
| POST | /canvases/:id/report/retry | jobs:control | 仅 `failed` 可重试，否则 409 |
| GET | /canvases/:id/report/availability | tasks:read | 报告可生成性投影：缺什么输入、是否冻结可投影；`GET /canvases/:id/report` 为 404 时同一份 availability 随错误返回 |
| POST | /canvases/:id/report/refresh | jobs:control | 对同一冻结输入重算投影（幂等）；输入变化才追加版本，返回 `{ok, report_id}`，失败 409 |
| GET | /findings/:id/candidates | findings:read | 有界候选输入页；只接 `cursor`（其他 query 拒绝）；`no-store`；cursor 失效返回 `cursor_*` 码要求无 cursor 重读；超出语句预算 503 `CANDIDATE_QUERY_BUDGET_EXCEEDED` |
| GET | /findings/:id/lexical-search | findings:read | 字面检索（非语义关联）；同上 cursor 与 `no-store` 约束；预算超限 503 `SEARCH_BUDGET_EXCEEDED` |
| GET | /findings/:id/evidence-trace | findings:read | Fact↔Evidence 可追溯性只读视图；`runtime_proof=false`、`replay.kind=evidence_integrity_check`，不改变 verify verdict。详见 [EVIDENCE_TRACE](../../../docs/EVIDENCE_TRACE.md) |
| GET | /canvases/:id/finding-research | findings:read | 研究运行与去重簇投影：最近 50 次 `finding_research_runs`（含 `error`）+ canvas 内簇及其 canonical Finding（最多 1000 条）；只读，不改变 severity / verify 门 / 报告收敛 |
| PATCH | /findings/:id/verify-status | findings:write | 人工收口 verify 状态 `{status, reason?}`；非法结构 `400 FINDING_VERIFY_STATUS_INVALID`；写 Finding 的 `verify_status` 与人工处置，不重放 `unknown` 外部效果 |

### Finding 身份与关系（#819）

这些路由属于 Management API，不接受 Job capability token；所有操作都先做认证主体、Finding 所属项目和 `findings:read`/`admin` scope 校验。当前关系投影是有界的操作员见证状态：`authority_basis=platform_admin_attestation`、`independent_external_verification=false`、`published=false`、`quality_gate_status=not_evaluated`，未发布 relation items 不会因查询而暴露。操作员见证不认证外部 inventory authenticity。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /findings/:id/relations | findings:read | 当前 Finding 的有界关系状态；可选 opaque cursor 绑定 project/subject/generation/source/identity fingerprints；cursor 冲突需无 cursor 重读 |
| GET | /canvases/:id/finding-relations | findings:read | Canvas 当前关系投影；读取受 Finding/relations/byte budget 限制，并通过 `read_status`/`read_reason` 显式报告截断或身份历史阻断，不是完整项目图 |
| POST | /findings/:id/identity-sources | admin | 登记 typed identity source attestation；服务端计算 digest、记录认证主体，source_kind 是操作员断言，身份字段只保存已知字段 SHA-256 digest |
| POST | /findings/:id/identity-sources/:sourceId/revisions | admin | 以 `expected_source_revision` 做 CAS 追加修订；旧 revision 绑定的 mapping 在读取时立即失效 |
| POST | /findings/:id/identity-sources/:sourceId/revoke | admin | 以当前 source revision 撤销；同 revision 重复撤销幂等，历史保留，当前 mapping/relations 失效 |
| POST | /findings/:id/identity-mappings | admin | 首次绑定 admitted source；`expected_mapping_version` 必须为 `null`，server 解析当前 source revision、identity digest 和 provenance，调用方不能自报 digest/provenance |
| POST | /findings/:id/identity-mappings/remap | admin | 以最新 mapping version 和 reason 做 CAS remap；原 mapping 撤销并原子追加到新 source/revision |
| POST | /findings/:id/identity-mappings/revoke | admin | 以最新 mapping version 和 reason 撤销；同 version 重复撤销幂等，历史保留 |

常见失败包括 `PROJECT_MISMATCH`/`PROJECT_SCOPE_MISMATCH`、`IDENTITY_SOURCE_CAS_CONFLICT`、`IDENTITY_MAPPING_CAS_CONFLICT`、source/mapping stale 或 revoked；未知字段和 caller-supplied provenance 直接拒绝。durable relation worker 只重建当前有界 projection，不把强关系发布为业务结论。

### Finding 质量协议与工程报表（#819）

这组接口用于受治理的工程评估，不是强关系质量证书或发布开关。2026-11-01 用户决定优先发布，独立质量验证、人工数据集及后续证书/晋升/公开建议质量门暂缓（该决定沿用至今，具体发布版本以仓库 tag 为准，本文不复述版本号）；只以最终 SHA 的 GitHub Actions 完整工程检查验收，不以未验证材料阻塞本轮发布，也不把 `not_evaluated` 解释为质量通过。必须使用 `POST /auth/login` 取得的真实数据库用户会话（`deepsonar_user_…` Bearer）、`admin` scope、admin/operator 角色及同项目权限；即使本地普通认证可省略，API/service token、Job/internal 和 bootstrap 主体也不能代替用户。所有路径拒绝 query 参数，成功元数据响应使用 `Cache-Control: no-store`。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /projects/:id/finding-quality/assets | admin | 当前真实装载模块、配置、selector/normalization/rule 摘要；trusted Node preload 捕获返回给 evaluator 的字节，不是部署签名或人工真实性证明 |
| POST | /projects/:id/finding-quality/protocols | admin | 只登记 strict 协议元数据、scope/digests、阈值和有效期；同一登记主体的 exact replay 不重置历史 |
| GET | /projects/:id/finding-quality/protocols/:protocolId | admin | 协议、head、work 摘要和终身 corpus 暴露状态；不返回原始标签或观察 |
| GET | /projects/:id/finding-quality/protocols/:protocolId/report | admin | 在只读 repeatable-read 事务内重构已完成的真实 SQL generation/cohort 和 report digest；明确 `source_validation=repeatable_read_mvcc_snapshot`，不证明未来仍 current |
| POST | /projects/:id/finding-quality/protocols/:protocolId/freeze | admin | `{expected_version}`；在首次留出暴露前冻结协议，终身同 corpus 暴露或历史未知时拒绝重新冻结 |
| POST | /projects/:id/finding-quality/protocols/:protocolId/declarations | admin | `{expected_version}`；追加从 freeze 派生的 digest-only 数据声明，不消费原始留出数据 |
| POST | /projects/:id/finding-quality/protocols/:protocolId/declarations/:declarationId/payload | admin | strict JSON 标签包；可选 `Idempotency-Key`；本请求独立提交 exposure 后才进入媒体/JSON/大小/schema 校验与 admission |
| POST | /projects/:id/finding-quality/protocols/:protocolId/reviews | admin | `{expected_version,evidence_digest,expires_at}`；只追加工程评审候选，须有真实完成的不可变观察批次，不能用 digest-shaped 伪造 evaluation 通过 |
| POST | /projects/:id/finding-quality/protocols/:protocolId/revoke | admin | `{expected_version,reason}`；取消本协议 pending/running work，只清除本协议自己的 current tuple，保留历史、观察与首次暴露 |

`expected_version` 是规范的非负 bigint **字符串**，不是 JSON number；以 GET 返回的版本做精确 CAS，不能重置 generation 或覆盖冻结记录。登记和上传的字段、字节/数量预算以 [共享质量契约](../../../apps/scheduler/src/domains/project-finding-research/quality-contract.ts) 及 [OpenAPI](../../../apps/scheduler/src/domains/project-finding-research/quality-openapi.ts) 为准；这些预算不是最低样本量或质量阈值。数据包 `kind=synthetic`/`human_labeled` 只是声明，不认证标注者、来源或独立性。

**暴露不可回滚**：在本请求的 `preParsing` 已提交 exposure 后，解析、超限、schema 或 SQL admission 失败会保留该收据并追加 linked rejection；admission/payload/work 自身在失败事务中回滚。权限、无效声明或复用 key 在消费请求体前拒绝时，不根据猜测的字节凭空添加暴露。所有 reused key 都冲突，换协议/阈值、重试或 revoke 不能抹掉同 corpus 的终身暴露。

Scheduler 普通有限 tick 只追加一个 heldout subject 的实际当前 SQL 观察；另一个 read-only re-observation 完成阶段核对整个已有 cohort，不追加新观察，再原子写 evaluation/report/head/work。候选选择复用部署中的 current-source/mapping 与 UUID 窗口，不因标签或词法排序筛选；指标使用整个 admitted holdout 真值作分母。GET report 仅给绑定、digest、计数和指标，明确省略 `input`、原始标签、来源对象、selector traces 和 decisions。

评审在同一 repeatable-read 事务中核对实际持久化 review 信封、真实 completed work/observations/report；已知 maker/tuner/registrar/custodian 与其传递 alias 不能自审，冲突或当前来源变化时整次候选与 head 更新回滚。不同账号和 hash 不能证明是不同自然人。当前所有成功结果仍返回 `quality_status=not_evaluated` 及独立标注、自然人 alias、外部 provenance、预先采纳阈值未验证的 blockers；没有 certificate、current promotion 或强关系发布接口，不能提交 `verified`/`passed`/`independent` 等自报标志解除门禁。

常见状态：`400` strict 输入或报告/来源无效，`401` 未认证，`403` 主体/项目权限不足，`404` 当前项目无该协议/声明，`409` 版本、状态或终身暴露冲突，`413` 请求体超预算，`503` 真实装载资产未建立，`500` SQL/拒绝收据写入失败。失败不回显标签包、凭据、内部堆栈或原始异常。工程单元与真实 PostgreSQL/HTTP 入口为 `pnpm ci:unit:finding-quality` 和 `pnpm ci:integration:finding-quality`；后者必须真的配置 `TEST_DATABASE_URL`，本地 skip 不是通过。

注意力成本：平台自动做版本、来源、暴露审计、分母、报表重构和失效检查，统一返回可查询状态与稳定错误；人工只提供平台无法代替的真实标注、预先约定阈值和独立复核证据。不增加逐条 Finding 审批，不改变 Verify、disposition 或任务执行路径。完整未交付项见 [Finding Research](../../../docs/PROJECT_FINDING_RESEARCH.md)。

### 程序材料与 Finding 程序资格（#822）

程序材料和资格是独立的管理/审计投影，不是任务执行授权。写入身份由认证 actor 推导，不能在 body 自报 reviewer、trust 或资格状态；平台管理员/项目范围由服务端检查，Agent/internal actor、viewer 和 Finding maker 不能批准。材料和评审采用 append-only history；撤销、替代、证据/Verify/Finding revision 变化、历史损坏或读取预算不足都会使当前正向资格失效或保持 `blocked`。当前实现不认证外部官方来源。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /program-materials | projects:read | 查询当前可信程序材料；`project_id`、`include_history=true` 可选，返回 `invalid_history_count`/`history_incomplete` |
| GET | /program-materials/:id | projects:read | 查询单个材料及其历史完整性状态 |
| POST | /program-materials | projects:write | 登记可信程序材料；服务端从认证 actor 冻结登记者和权限，非 Job/Agent 自授权 |
| POST | /program-materials/:id/revoke | projects:write | append-only 撤销；历史评审仍可读但不贡献当前资格；使用材料版本/幂等键校验 |
| POST | /findings/:id/program-eligibility/reviews | findings:write | 提交独立资格评审；必须绑定当前 Finding Artifact revision/source digest、Verify confirmed round、材料 version/hash/target、可重读证据、理由和幂等键；`blocked` 返回 409 |
| GET | /findings/:id/program-eligibility/reviews | findings:read | 查询 append-only 历史评审、当前 projection、材料和历史完整性 |
| GET | /findings/:id/program-eligibility | findings:read | 查询当前资格；`eligible` 仅表示当前绑定仍有效的独立评审，`technical_status=confirmed` 不反向推出资格 |

这些路由不改变技术 Verify、Finding disposition 或 Job 生命周期，也不创建第二执行通道。资格投影不能替代 `operator_attestation`、verified Fact 或完整完成门。

### 设置（规则与项目 Agent 授权）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /global-settings | agents:read | `{rules, effective_rules, active_by_agent_cli, active_by_provider}`；`effective_rules` 含 `maxGlobalJobs` / `maxJobsPerProject` / `maxConcurrentByAgentCli` |
| GET | /platform/claims | tasks:read | #740 平台级全局暂停领取状态：`{claims_paused, reason, note, paused_by, paused_at, state: running\|pausing\|paused, drained, in_flight:{claimed,provisioning,running,total}, pending, waiting_human, effect_pending_attempts, unknown_effect_attempts}`。项目级 token 403 `PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN` |
| POST | /platform/claims/pause | admin | `{reason: platform_upgrade\|maintenance, note?}`（strict，note ≤500）。持久化、跨副本生效、重启保持；只阻止新领取，不取消在途 Job。同原因幂等 `changed=false`；其他原因已暂停 409 `PLATFORM_CLAIMS_ALREADY_PAUSED`。审计 `platform.claims_pause` |
| POST | /platform/claims/resume | admin | `{reason?}`：带 reason 时仅当前原因一致才解除，否则 409 `PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH`；未暂停幂等。`pg_notify` 唤醒调度，审计 `platform.claims_resume` |
| PATCH | /global-settings | agents:write | `{rules: {...}, finding_protocol?}` 合并；`finding_protocol` 只走顶层。claim 读 effective 并由 `pg_notify` 唤醒；库 `rules_json` 优先，并发默认以 [config](../../../apps/scheduler/src/config.ts)为准，Finding 协议版本/模式以运行时 OpenAPI 为准 |
| GET | /projects/:id/settings | agents:read | 项目规则、Finding 协议、设备接入、CLI/Provider 白名单及显式默认值、effective 设置与 `active_jobs`；`credential_ids_configured` 区分未配置和显式空名单 |
| PATCH | /projects/:id/settings | agents:write | 支持 `rules`、`finding_protocol`、`device_access_enabled` 与项目 Agent 授权字段，完整形状和配额边界见 [SettingsPatchBody](../../../apps/scheduler/src/settings-validation.ts)；省略字段保持原值，`rules.maxConcurrentJobs: null` 清除项目覆盖 |

项目不再提供角色启用开关；角色由 Hub/Job 在平台角色及本项目自有角色中选择。CLI 的旧 `project-settings update --roles` 会在发送请求前报错，不应把服务端剥离未知 `roles` 字段后的响应当成设置成功。项目授权并未取消：`enabled_agent_clis`、`enabled_credential_ids` 收窄 CLI/Provider 候选；显式空凭据名单禁止所有账号，未配置则动态继承项目可访问账号。`default_agent_cli`、`default_credential_id`、`default_model_ref` 与 `fallback_model_refs` 是范围内的软缺省，不扩大白名单；无效或不可访问引用必须修复，不能自动换账号。

CLI 的 `project-settings update` 只封装 `--rules` 和 `--finding-protocol`。修改白名单等其他支持字段，使用这里的 PATCH HTTP 契约或 Web 项目 Agent 设置；不要发明 CLI 参数，也不要将它们塞入 `rules`。

### 角色注册表（agent_roles）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /agent-roles | agents:read | 全部角色及 Hub 可见职责描述 |
| POST | /agent-roles | agents:write | `{name, title?, description?}`；name 即 job.type |
| PATCH | /agent-roles/:id | agents:write | 部分更新（name 不可改） |
| DELETE | /agent-roles/:id | agents:write | `kind=role` 均可删除；system/hub 返回 409 |
| GET | /projects/:id/roles | agents:read | 平台工作角色与本项目自有工作角色；`enabled` / `default_enabled` 为 true，不是可编辑的项目开关 |

### RoleConfig（角色 → agent 配置；声明式全量替换）

全局 PUT 示例（字段以严格的 [RoleConfigPutBody](../../../apps/scheduler/src/role-config-schema.ts) 为准；不是重置现有配置的建议）：

```json
{
  "agent_cli": null,
  "dsh_task_mode": "standard",
  "model": null,
  "context_window_tokens": null,
  "env_keys": [],
  "env_vars": {},
  "modules": [],
  "skills": [],
  "commands": [],
  "mcps": [],
  "subagents": [],
  "platform_tools": {},
  "instructions_markdown": null,
  "runtime_image_key": null,
  "runtime_knobs": {},
  "config_files": []
}
```

项目 RoleConfig 的 PUT 不接受或持久化 `agent_cli` / `model`；这两个字段只可写入全局 RoleConfig（项目读取不暴露）。全局 `agent_cli: null` 表示没有 CLI 偏好，`model: null` 表示没有角色模型覆盖。项目 RoleConfig 也不能指定 `runtime_image_key`。运行时身份以凭据的 `agent_cli` 与 `settings_config_json` 模型目录为准，Hub 的 provider/model selector 和项目 Agent allowlist 只能提出或收窄候选，不能由项目 RoleConfig 自报模型或 CLI。

RoleConfig 不再接受 `credentials` / `reasoning` 或账号绑定；未知字段严格拒绝，不提供旧请求兼容。`dsh_task_mode` 接受 `standard` / `ptc`；上下文窗口、runtime knobs 与配置文件校验以 [值校验](../../../apps/scheduler/src/role-config-values.ts)为准。保存前服务端检查 env 白名单、镜像可信目录、资源上限、工具/能力以及配置文件路径和密钥特征；Credential 项目范围与 CLI/Provider 兼容性由项目设置及 credential-first 解析另行校验，不能用 RoleConfig 绕过。

GET 的 `env_vars_json`、`modules_json`、`skills_json`、`commands_json`、`mcps_json`、`subagents_json`、`platform_tools_json`、`sandbox_limits_json`、`runtime_knobs_json` 对应 PUT 中去掉 `_json` 的字段；`config_files` 写入只含 `path` / `content`，不回传内容摘要或数据库元数据。`role-configs sync-builtin-prompts` 按此映射保留当前全局配置，仅替换 Prompt；有差异才 PUT，`--dry-run` 或相同 Prompt 不写入。它不更新项目覆盖或历史 Job，目标部署不满足当前契约时必须停止。

`modules` 接受 `<source_id>:<module_id>`、`<source_id>:plugin:<plugin_path>` 或 `<source_id>:source:*`。`source_id` 必须是固定格式 UUID；selector 原样落库。`plugin:` 和 `source:*` 在创建下一 Job 时按当前 trusted/enabled catalog 展开，因此同步后的新增模块会跟随组选择器进入新快照；历史 Job 不会漂移。导入导出会保留合法 selector，路径中的 `..`、绝对路径、空段和未知保留前缀会被拒绝。

常见 400：
- `runtime_image_key 没有可信版本: <key>` — 市场 catalog 有 key 不等于有 `trust_status=trusted` 的版本；先配置 `DEEPSONAR_OFFICIAL_*_IMAGE=@sha256:...` 重启，或 import+approve。
- 建任务 / 开始任务时若市场 key 只有 `revoked` 版本，返回 `409 RUNTIME_IMAGE_REVOKED`；若版本存在但尚未 trusted，返回 `409 RUNTIME_IMAGE_NOT_TRUSTED`。这两种都不是 `RUNTIME_IMAGE_PLATFORM_UNAVAILABLE`（后者只表示 trusted 版本未声明宿主平台）。
- `credentials` / `reasoning` 等已移除的 RoleConfig 输入字段会被严格 schema 拒绝；模型推理配置应在 Credential 的 `settings_config` 中设置。

`platform_tools` 接受平台工具**全集**中的任意工具名（每个 Agent 均可勾选，不再按 role/kind 裁剪 list）；未声明的工具默认启用。仅 **`mark_job_done`** 为形成合法终态所必需，不可关闭。授权以 Job 冻结的 `platform_tools` 快照为准。Hub 需要派发时由 `list_available_roles({})` 按需返回数据库中的项目可用工作角色；返回值排除 system/hub 角色，决策落地时服务端再次严格校验且不做默认回退。其他工具关闭后不会进入当次 Job 控制 API allowlist，也不会进入动态 `AGENTS.md`、`CLAUDE.md` 的可用工具说明。

DSH 运行时固定为官方 `@deepseek-ai/dsh@0.2.1-rc.2`，由隔离 `agent-harness/dsh-runtime/package-lock.json` 冻结，镜像在 `/opt/deepsonar/dsh` 使用 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 安装，入口为 `dsh --profile`。Job 创建时将 `dsh_task_mode=standard|ptc` 冻结：standard 使用 native tools，ptc 使用 `run_code`。`deepsonar` profile 的 `bundles: []` 与显式 allowlist 不启动 UI/web，不使用 settings/credential discovery、native DeepSeek routes、plugin-manager、telemetry 或 home overrides；skills 只从 Scheduler 物化的 `.dsh/skills` 根发现。Provider route/model 只经 Model Gateway，沙箱仅获得短期 Gateway token。官方 JSON-RPC 仅支持 initialize/prompt/shutdown，同进程 follow-up 可用；跨进程持久 resume 不支持，不会静默新建会话或重试。

`runtime_image_key` 仅可配置全局 RoleConfig：`null` 表示系统底座，非空 key 须来自可信且启用的市场目录，不能提交任意 OCI 地址。Job 解析跟随平台目录；官方默认可用，第三方须平台可见且项目启用。`project_opt_in` 只是元数据，不恢复项目钉版本。

非空 `sandbox_limits` 只用于项目 RoleConfig 的资源覆盖；读取字段名为 `sandbox_limits_json`，全局保持空对象。资源维度与上限以 [sandbox limits 校验](../../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.ts)为准，Job 创建时冻结。

Job 创建时必须冻结完整运行快照：平台/项目 Agent allowlist 与 Hub selector 先确定候选，Scheduler 在项目/全局可用范围内解析 credential；运行身份优先来自 Credential 的 `agent_cli` 与 `settings_config_json` 模型目录，平台默认/全局 RoleConfig 仅作软缺省，项目 RoleConfig 的同名遗留字段不生效。`reasoning` 只从 Credential `settings_config_json` 读取。DSH 快照还冻结官方 profile 版本、`dsh_task_mode`、Gateway route/model 与短期 token 注入策略；当前 adapter `persistentSessionResume=false`。快照含 effective `model`、物化后的 CLI 配置文件、Provider-owned `reasoning`、`credential_id` 与 `runtime_image`（digest）。**改 RoleConfig 或 Credential 不影响已创建 Job**。

Pi 扩展同样不是普通 RoleConfig 字段或可由 Agent 上传的管理资源：Hub 能力组合只能选择平台注册的 `pi_extension_ids`，Scheduler 在 Job 创建时重新校验注册项、镜像兼容性和 package/version/integrity/entry 并冻结到 snapshot；RoleConfig、AgentPack 和任务文本不能写入 `pi_extensions`。当前 registry 含 `pi-web-access` 与 pinned `pi-observational-memory@3.1.4`，后者没有单独 Management endpoint，且默认不启用。OM 运行时使用 Gateway-only、独立 workload credential、条件有限预算、私有配置守卫和 archive 脱敏边界；旧 released digest 或 v0.6.2 镜像不能由 manifest key 推断含 OM。

OM 新 Job 还按 [shared registry](../../../packages/shared-types/src/pi-extensions.ts) 的专属下限校验 Scheduler 选定的 `runtimeImage.image_version`，缺失/非法/旧 metadata 拒绝；非 OM/全局下限与历史冻结快照不变。Pi 启动/恢复前的生产 package/entry/wrapper guard 与封装预检独立。实际本地 base 镜像的 canonical RPC/guard 正负例已通过，身份与证据集中见 [RPC 专题](../../../docs/PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；不据此宣称最终组合 CI 或发布通道/平台、registry/catalog 已通过。

路径参数都是 UUID，**不是**角色名（如 `explore`）：

- `:roleId` = `agent_roles.id`（来自 `GET /agent-roles` 的 `id`，或 `GET /role-configs/bindable` 的 `role_id`）。非 UUID 返回 `400 INVALID_ROLE_ID`。
- PATCH `/role-configs/:id/...` 的 `:id` = `role_configs.id`（来自 bindable 的 `id`）。非 UUID 返回 `400 INVALID_ROLE_CONFIG_ID`。
- `:id` 在 `/projects/:id/...` 上是项目 UUID。非 UUID 返回 `400 INVALID_ID`。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /role-configs/global | agents:read | 全局缺省清单与 `config_files`；不含 Credential 绑定 |
| GET | /role-configs/bindable | agents:read | RoleConfig 选择器元数据（含 `agent_cli` / `runtime_image_key` / `id` / `role_id`）；`can_bind` 恒为 false，不是账号绑定入口 |
| PATCH | /role-configs/:id/agent-cli | agents:write | `:id` 为全局 RoleConfig UUID；仅修改 CLI 偏好，不修改 Credential；项目 RoleConfig 拒绝 |
| PATCH | /role-configs/:id/runtime-image | agents:write | `:id` 为全局 RoleConfig UUID；仅改 `runtime_image_key`（`null`=系统底座），不改文件；项目 RoleConfig 拒绝 |
| PUT | /role-configs/global/:roleId | agents:write | `:roleId` 为角色 UUID；全局 upsert 并递增 version。全局显式 CLI 是候选消歧偏好，账号由 Scheduler credential-first 解析；不恢复旧角色账号绑定 |
| GET | /projects/:id/role-configs | agents:read | 各角色来源 project / global / none；`project_config` 返回实时完整项目覆盖 |
| PUT | /projects/:id/role-configs/:roleId | agents:write | `:roleId` 为角色 UUID；写入项目覆盖，不检查旧角色启用清单；拒绝 `agent_cli` / `model`，不绑定或修改 Credential |
| DELETE | /projects/:id/role-configs/:roleId | agents:write | `:roleId` 为角色 UUID；删除覆盖，回落全局 |

### 运行时镜像市场

市场只接受受治理 OCI 目录。第三方导入首先进入 `quarantined`，由独立 Image Admission Worker 解析不可变 digest 并完成验签、SBOM、漏洞/凭据/恶意文件扫描和断网自检。扫描通过也不会自动 trusted；必须由 `images:approve` 管理员提升，第三方版本还需要项目显式启用。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /runtime-images | images:read | 市场列表；`?search=` / `?project_id=` |
| GET | /runtime-images/:id | images:read | 产品、不可变版本、工具清单、SBOM/签名和扫描历史 |
| GET | /runtime-images/contract-selftest | images:read | 只读双哈希自检：catalog `tools_manifest_sha256` vs 本地镜像文件字节哈希 / 内嵌 `manifest.sha256`；本地缺失为 `skipped_not_local`；`ok` 仅非 skipped 全匹配 |
| GET | /runtime-images/registry | images:read | 官方目录；保留 `schema/images`，并附 `selected_channel`（`github`\|`dockerhub`\|`aliyun-acr`）、`source`、`fallback`、`error`、`checked_at` 诊断 |
| PATCH | /runtime-images/registry/channel | images:manage | 严格 body `{channel: github\|dockerhub\|aliyun-acr}`；只允许全局/admin actor，项目限定 token 返回 `403 PROJECT_SCOPE_FORBIDDEN`；审计 `runtime_image.registry_channel_update` |
| POST | /runtime-images/registry/sync | images:manage | 刷新官方/内置 catalog；所选 channel 用于后续镜像引用解析与 pull，不决定 catalog 来源 |
| POST | /runtime-images/registry/apply | images:manage | 直接提交 registry 对象或 `{registry: ...}`；内部运维入口，项目限定 token 被拒 |
| POST | /runtime-images/registry/pull | images:manage | 启动异步拉取任务，返回 202/task |
| GET | /runtime-images/registry/pull-status | images:read | 持久化拉取任务状态、阶段、error_code 与时间戳；重启后 in-flight 为 interrupted |
| POST | /runtime-images/:id/detect-local | images:read | `{image_ref}`；读取本机 Docker 元数据并返回候选（不会改变信任状态） |
| POST | /runtime-images/:id/adopt-local | images:approve | `{image_ref, expected_image_id}`；仅官方产品的 adoptable 候选可由管理员二次确认采用；第三方仍走准入扫描 |
| POST | /runtime-images/import | images:manage | `{image_key,name,publisher,image_ref,description?,source_url?,version?,registry_credential_id?}`；返回 202 |
| POST | /runtime-image-versions/:id/rescan | images:manage | 重新入队；revoked 版本不可恢复 |
| POST | /runtime-image-versions/:id/status | images:approve | `{status: trusted\|rejected\|disabled\|revoked, reason?}`；rejected/revoked 必填 reason |
| GET | /runtime-image-versions/:id/usage | images:read | 反向查询历史 Job、项目和 Finding |
| PUT | /projects/:id/runtime-images/:imageId | images:manage | `{enabled, version_id?}`；只能启用 trusted 版本，`version_id` 用于固定/回滚 |
| POST | /runtime-images/:id/official-digest | images:approve | 管理员登记官方不可变 digest |
| POST | /runtime-images/manual-digest | images:approve | 管理员登记手工 digest（需完整 `image_ref`） |
| POST | /runtime-images/registry/reconcile | images:manage | 只读对账：比对节点上的镜像 digest 与 catalog；`{repair: true}` 才启动受治理的定向拉取，拓扑问题仍如实报告 |
| PATCH | /runtime-images/:id/visibility | images:manage | `{visible_project_ids}`；仅非官方产品可设（官方对所有项目默认可见，返回 `400 RUNTIME_IMAGE_VISIBILITY_OFFICIAL`）；项目限定 token 被拒 |

Job 创建时冻结 `agent_snapshot_json.runtime_image`，至少包含产品/版本 ID、`image_ref=name@sha256:digest`、`image_digest`、工具清单哈希与准入扫描 ID。任务、Hub、Skill 和外部事件都不能提供任意镜像引用。

本地镜像采用刻意拆成 transport 与 trust 两步：用户可自行 `docker pull`、`docker build` 或 `docker load`，然后用 `detect-local` 检查 image ID、RepoDigest、契约、架构和产品匹配。检测结果中的 `adoptable` 只是候选资格；管理员必须核对不可变 `image_id`，再把同一个 `expected_image_id` 传给 `adopt-local`。mutable tag 不会因为检测或传输而自动获得 trusted 状态。

官方镜像引导（环境变量，调度器启动时写入 trusted version）：

```text
DEEPSONAR_OFFICIAL_BASE_IMAGE=repo/image@sha256:<64hex>
DEEPSONAR_OFFICIAL_AUDIT_IMAGE=repo/image@sha256:<64hex>
DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE=...   # 可选，项目 opt-in
```

仅 tag（无 `@sha256:`）会被忽略并打 warn。audit 启动兜底只认 `DEEPSONAR_OFFICIAL_AUDIT_IMAGE`。

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
| GET | /projects/:id/skill-sources | skills:read | 项目级启用白名单（镜像 / CLI·Provider 同构：平台控制面启用，Hub 只在已启用集合里选型）；项目级 token 的 `:id` 必须匹配 |
| PUT | /projects/:id/skill-sources/:sourceId | skills:write | `{enabled}`；只改本项目白名单，不改变源自身的 trust/enabled |

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
| DELETE | /credentials/:id | agents:write | 删除已保存账号；pending/active Job 拒绝（`CREDENTIAL_IN_USE`）；failed/timeout/orphan 可恢复历史不挡删除；活动扫描拒绝（`CREDENTIAL_SCAN_IN_USE`）；吊销 `job_tokens`；不改写历史 Job 快照（#690：不再存在 RoleConfig 凭据绑定） |
| POST | /credentials/:id/test | agents:write | 连接测试（无 body；会更新健康证据）。优先按 vendor 口径做最小推理调用（`POST /v1/chat/completions`，Anthropic 为 `POST /v1/messages`，`max_tokens=8`）：`2xx\|400` = 账号可用（400 只是 ping 参数被拒）；推理路径 `401/403` 才是认证失败。只能走模型目录时，目录侧 `401/403/404/405` 记为 `unknown`（该路径不可用 ≠ 账号不可用），响应带 `probe_path` 标明结论来自哪条路径。推理失败时 `upstream_error` / `detail` 携带脱敏截断的上游 `error.type` / `error.message`；`402` 或额度类正文 → `quota_exhausted`，`403` 指向模型 → `model_unavailable`；402 / 403 / 额度失败会补一次模型目录发现，成功时返回 `model_catalog` 并回填 `model_catalog_json`（#748） |
| POST | /credentials/:id/models | agents:write | 实时拉取 Provider 模型目录（无 body；用于配置文件模型字段的参考） |
| POST | /credentials/models/preview | agents:write | `{agent_cli, provider, secret, base_url?, settings_config?}`；未保存账号一键获取模型目录，不落库/审计/回显密钥 |
| GET | /credentials/:id/models | agents:read | 读取已持久化的有界模型 ID 目录 |
| GET | /credentials/:id/compatibility | agents:read | `?agent_cli=claude-code\|pi\|dsh&model=<可选覆盖>`；省略 model 时服务端从 Credential settingsConfig 解析 effective model；leftover `codex`/`open-code` 拒绝并提示迁移 |

LLM `provider` 表示 Gateway wire protocol：`anthropic` = Anthropic Messages，`openai` = OpenAI Responses。`settings_config_json.reasoning` 由 Provider/模型拥有；Claude Code 只接受 `low | medium | high | xhigh` 并物化为 `effortLevel`；Pi 只接受 `off | minimal | low | medium | high | xhigh | max`；DSH 只接受 `off | minimal | low | medium | high | xhigh | max`，第三方 wire value 必须配置在模型 `reasoningEfforts` 映射。leftover Codex/OpenCode 凭据仍可读历史 reasoning，但不能再保存为新配置。DSH 的 `settings_config_json.config` 保存官方 `settings.yaml` 形状的 YAML（`llm-pi-ai.providers` + `agent-default-model`）；route 可自定义，`api` 必须与 Credential wire protocol 兼容。DSH core 原生继承冻结的 provider/model/reasoning 并传给 subagents，不再需要额外 reasoning settings plugin。Job 只冻结一个 route，并把 endpoint/credential 强制替换为 Model Gateway 与短期 Job token。其它 CLI 的 `settings_config_json` 在 Job 创建时物化为 Agent 沙箱内的 CLI 文件；管理 API 只返回带 `[已保存密钥]` 的脱敏投影。Credential `metadata` 不是任意 JSON。服务器按 kind/provider 只接受 LLM 的 `base_url`、`model_concurrency`、`max_concurrent`，或 OCI 的 `registry`、`username`；未知/secret-like key、URL userinfo/query/fragment 均拒绝。写入时 leftover `allowed_model_ids` 按未知字段拒绝；导入/投影旧行丢弃该键。模型可用性只认 `settings_config`。连接健康只保存固定 category 与平台生成人话；Provider body、Authorization、密钥和带 query 的 URL 永不进入 API、审计或 transfer。`/readiness` 只在推理路径被拒（`authentication`/`authorization` 等权威 category）时把 `CREDENTIAL_TEST_FAILED` 判为 error；探测路径限制（`unknown`）降级为 warning，不再把可用的第三方中转判成不可用。

### 真实设备接入（#495）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| PATCH | /projects/:id/settings | agents:write | `device_access_enabled: true\|false\|null` 项目级 opt-in（默认关；null 清除）。设备租约的发放前置就是它 |
| GET | /projects/:id/settings | agents:read | 返回 `device_access_enabled` |
| GET | /devices | tasks:read | 设备注册表：`?status=&project_id=&limit=`（默认 200，上限 500）；项目级 token 只看到本项目设备；同一响应回报每个 rig 的 `broker_configured` / `admission`，一个 rig 不可达不影响其它 rig 的结论 |
| POST | /devices | admin | 登记设备 `{key, project_id?, rig_id, model, transport, capabilities?, spec?}`；`rig_id` 必须已在 `DEEPSONAR_DEVICE_RIGS` 配好，否则 `400 INVALID_RIG`；登记后立即推送 broker 期望集合 |
| PATCH | /devices/:id | admin | `{action}` 改设备状态（如上下线）；返回 `{device, rig_pushes}` |
| DELETE | /devices/:id | admin | 显式 forget 设备；存在活跃租约时 `409`，不删除执行证据 |
| GET | /devices/:id/events | tasks:read | 该设备的 append-only 事件（不含凭据） |
| GET | /device-leases | tasks:read | 租约列表：`?state=&job_id=&device_id=&project_id=&limit=`（默认 200，上限 500）；项目级 token 只看到本项目租约 |
| POST | /device-leases/:id/release | admin | 手工释放该设备全部租约（复用 Job 终态释放路径：置 `released`、设备回 `idle`、通知 broker） |

设备经 **device broker** 暴露为可租借端点，沙箱不直连物理设备：

- Scheduler 在 Job `provisioning` 前向 broker 申请租约（`POST /lease/acquire`），把
  `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` / `ANDROID_SERIAL` 与
  `DEEPSONAR_DEVICE_*`（端点 + 短期租约 token）注入沙箱；沙箱内 `adb devices` / `adb shell` 免改脚本。
- 稳定错误码：`device_not_available`（可重试：设备忙/离线/broker 不可达）、
  `device_not_authorized`（不可重试：项目未 opt-in、transport 未实现、非独占）。
- 记账：`devices` / `device_leases` / `device_events`（append-only，不含凭据）；
  终态释放、崩溃由 Reaper 回收过期租约。broker 侧 API 只对调度主机开放，并用独立 token 鉴权。

### 平台导入导出（.deepsonarpack）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| POST | /projects/:id/exports | exports:write | 项目包；`preset=configuration\|project_full\|evidence_archive\|custom`，可选 `modules/include_blobs/allow_active_jobs/credentials.mode`。`custom` 的 `modules` 只认已实现白名单（rules/roles/skills/runtime_images/environment/credentials/tasks/findings/events/audit_archive）；未知值 400 `UNKNOWN_EXPORT_MODULES` 并列出 `rejected`。`allow_active_jobs` 仅 `evidence_archive` 或 `custom` 含 `events` 可设为 true；`project_full` 携带则 `400 ACTIVE_JOBS_NOT_ALLOWED` |
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
| POST | /imports/:id/apply | imports:write | `{mode: create_new\|merge_configuration\|merge_platform, project_name?, target_project_id?, modules?, conflict_policy?, credential_mappings?}` |
| POST | /imports/:id/cancel | imports:write | 取消未应用导入 |
| DELETE | /imports/:id | imports:write | 删除上传包及记录 |

AgentPack（`deepsonar.agentpack/v1`）是 Web 本地导入/安装格式；当前没有服务端 `/agent-packs` 端点。Web 安装时通过 Agent Role 与 RoleConfig API 完成登记，凭据与 secret-like 配置不会从 pack 直接写入。

### 管理面

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /tokens | tokens:manage | API Token 列表（前缀 + 安全字段，无明文）；项目级 token 只看到本项目且受管于自己的 token |
| POST | /tokens | tokens:manage | `{name, scopes, project_id?, expires_in_days?}`（≤365 天）；scopes 必须是调用者 scopes 的子集，越权 `403 SCOPE_EXCEEDS_ACTOR` |
| POST | /tokens/:id/revoke | tokens:manage | 吊销；不存在或已吊销 404 |
| POST | /tokens/:id/rotate | tokens:manage | 轮换为同 scope 新 token 并吊销旧 token |
| GET | /users | admin | 用户列表 |
| POST | /users | admin | `{username, password, display_name?, role: admin\|operator\|viewer}`；用户名冲突等以 `400` + `error_code` 返回 |
| PATCH | /users/:id | admin | `{display_name?, role?, status?: active\|disabled}` |
| POST | /users/:id/password | admin | `{password}`；改密会吊销该用户全部旧会话 |
| POST | /auth/ws-ticket | tasks:read | `{job_id, purpose: stream\|terminal}` 换取一次性 WS ticket（秒级过期）；长期 token 不进入 WebSocket URL；`purpose=terminal` 另需 admin 或 `jobs:control` |
| GET | /platform/updates | admin | #740 平台版本发现最近一次检查结果（可更新版本、schema 是否需重建、`check_error`）；只读，不提供升级 apply；项目级 token 拒绝 |
| GET | /audit-logs | admin | 审计日志 |
| GET | /ws | tasks:read | Job 实时流 WebSocket；升级入口不在 `/openapi.json` 的 HTTP operation 清单内，必须先 `POST /auth/ws-ticket` 拿一次性 ticket |
| GET | /terminal-ws | jobs:control | Job 终端 WebSocket（同上）；`purpose=terminal` 的 ticket 需 admin 或 jobs:control |

### 项目知识库（Memory / Skill，#752）

项目知识分为 Memory 与 Skill：稳定身份 + 不可变版本 + active 指针，默认项目私有。Skill 版本可按精确版本授予另一项目（不含未来版本、不可转授权，也不带来源项目的 Memory / Evidence / 凭据 / 网络 / 工具 / 镜像权限）。内容预算与生命周期见[专题](../../../docs/PROJECT_KNOWLEDGE.md)；本表只描述管理面读写。

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /projects/:id/knowledge | projects:read | 目录：`?kind=&status=&query=&limit=&offset=`（`limit+1` 探测 `next_offset`）；只列元数据与 active 版本 hash |
| GET | /projects/:id/knowledge/:itemId | projects:read | 条目详情（含 active 版本指针）；不存在 `404 KNOWLEDGE_ITEM_NOT_FOUND` |
| GET | /projects/:id/knowledge/:itemId/versions | projects:read | 版本历史分页（`limit/offset`），含 `content_sha256`、来源、`revoked_at/reason` |
| GET | /projects/:id/knowledge/:itemId/versions/:versionId | projects:read | 精确版本正文 + 条目摘要；只有所属项目能读历史内容，来源引用保持不透明 |
| GET | /projects/:id/knowledge/:itemId/versions/:versionId/grants | projects:read | 该版本已发出的项目间授权（最多 100 条） |
| POST | /projects/:id/knowledge/:itemId/versions/:versionId/grants | projects:write | `{grantee_project_id}`；仅 `kind=skill` 且已通过评测、未撤销的版本可授；自授 `400 KNOWLEDGE_GRANT_SELF`、接收方无效 `404`、条件不符 `409 KNOWLEDGE_GRANT_DENIED`、重复 `409 KNOWLEDGE_GRANT_EXISTS` |
| POST | /projects/:id/knowledge/grants/:grantId/revoke | projects:write | 撤销授权（安全收紧，立即生效）；不存在或已撤销 `404 KNOWLEDGE_GRANT_NOT_ACTIVE` |
| POST | /projects/:id/knowledge/:itemId/versions/:versionId/revoke | projects:write | `{reason}` 安全撤销版本，同时撤销其全部授权并把条目置 `revoked` |
| GET | /projects/:id/knowledge/receipts | projects:read | 按 `job_id` 查该 Job 的持久操作回执（`?job_id=&limit=&offset=`） |
| GET | /projects/:id/knowledge/receipts/:receiptId | projects:read | 回执详情；只允许所属项目读取，不为查回执延长执行 token |

Agent 侧对应受治理 operation 是 `request_project_knowledge` / `search_project_knowledge` / `read_project_memory` / `pull_skill` 等（见专题），**不是**这些 HTTP 管理接口。

### Readiness / preflight（#35/#36）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | /readiness | agents:read | 全局只读预检；返回 `deepsonar.readiness/v1`、`ready`、稳定 `checks[]`、网络策略和非敏感 role/credential/image 摘要。 |
| GET | /projects/:id/readiness | agents:read | 按项目 CLI/Provider 候选、可用角色、RoleConfig 覆盖和项目网络默认值预检。 |

两个端点都接受可选查询参数 `allow_egress=true|false`（只模拟一次任务网络覆盖，不写入项目/画布）以及 `material_source=workspace_or_offline|external_or_workspace|declared|unspecified`。未声明 `material_source` 时保持 `unspecified`，不会因为允许出网就推断任务需要外部材料。`checks[].code` 是稳定机器码；通常 `severity=error` 会令 `ready=false`，此外全局 real 概览若镜像必须由具体项目启用，也会以 `RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED` 标记 unresolved 并保持 `ready=false`，需要改用项目端点确认。

Credential 连接测试和模型目录只读取 Scheduler append-only audit evidence，并要求最近 24 小时成功记录才标记 `ok`；没有证据或证据过期时响应会明确标记 `missing/stale`，不会凭空声称 Provider 在线或模型可用。运维通过 immutable digest 手工登记的第三方镜像若标记为跳过准入扫描，会给出显式 warning，但遵循运行时 resolver 的实际可执行语义。响应绝不包含 secret、任意 env 名/值、ciphertext、base URL 或任意 OCI 引用；runtime image 仅返回受治理的 `image_key`、版本 ID、digest、trust/准入摘要。

## 错误格式

```json
{ "error": "人类可读信息", "error_code": "稳定机器码（若有）" }
```

未单独处理的 Zod / Fastify 校验失败统一为 `400` + `error_code=invalid_payload`。可选 `issues` 只含字段 `path` 与稳定 `code`，不回显正则、枚举全集或堆栈。未单独校验的分页/枚举查询参数（如 `limit`、`period`）同样归为 `400`，不会静默按缺省值返回另一个结果集。

| 状态 | 含义 |
| --- | --- |
| 400 | 参数 / Zod / RoleConfig 越界校验 |
| 401 | 未认证或 Token 无效/过期/已吊销 |
| 403 | Scope 不足或项目级 Token 跨项目 |
| 404 | 资源不存在 |
| 409 | 冲突（同名、Job 恢复状态/快照冲突、仍被引用的 Credential 删除等） |
| 502 | 上游失败（Git 同步等） |

## 幂等

- 任务创建：`jobs.ingress_key` 唯一；重复提交返回既有 Job。
- 事件注入：`(project_id, source, event_id)` 幂等。
- RoleConfig PUT：声明式全量替换配置和 `config_files`；先 GET 并保留非目标字段，不提交已移除的 Credential 绑定。重复 PUT 仍会递增版本并写审计；Prompt 同步仅在文本有差异时发送。
- 无 body 的 POST（sync / test / resume / model refresh 等）**不要**带 `Content-Type: application/json`，否则 Fastify 可能 400；cancel 只有传 force/reason 时才带 JSON body。

## Job 状态与运维

```text
pending → claimed → provisioning → running → waiting_human → succeeded|failed|timeout|cancelled|orphan
```

- `POST /jobs/:id/effects/:effectId/settlement`：只有管理员能对同 Job、非活动历史 `unknown` / `effect_pending` 提交书面判断。`outcome` 仅 `not_applied`、`applied_run_terminated` 或 `delivered`；同 effect 的 `operation_id` 与规范化 payload 不变时查询原结清结果，改内容或另 key 覆盖原结果返回 409。活动/排队执行仍归内核，拒绝结清；竞争中的原生 settlement 返回 `EFFECT_SETTLEMENT_BUSY`，先读取当前 effect。成功只表示人工事实写入并可通过 `GET /jobs/:id` 回读，不代表自动恢复许可、Provider 账单已确认或未知 Repair 用量可置零。
- `POST /jobs/:id/resume`：使用旧冻结快照重新执行；导入 cancelled 返回 `409 JOB_IMPORTED_READONLY`；当前受治理身份与旧快照不同或无法解析时稳定返回 `409 SNAPSHOT_STALE`，不静默使用旧模型。
- `POST /jobs/:id/rerun-current`：在 Dispatcher admission lock 与 Canvas→Job 行锁下完整重冻当前快照后原子转 `pending`；running/claimed/provisioning/pending 均返回 `409 JOB_NOT_RESUMABLE`。
- 改 `apps/scheduler/src` 触发 tsx watch 时，**running → orphan**；resume 后继续。
- schema 基线：读取同一 checkout 的 [schema.sql](../../../database/schema.sql)和 [SCHEMA_VERSION](../../../apps/scheduler/src/schema-version.ts)，核对目标部署的源码/镜像版本及启动校验结果；`/schema` 发现的是 HTTP 契约，不代替数据库版本校验。空库套对应基线，非空库版本与表结构不符即 fail closed；没有增量 migration，重建前必须授权并备份。
- 清业务数据**禁止** `TRUNCATE projects CASCADE`（会连带 credentials/role_configs）。导出包不含凭据明文。

## 将目标评审显式关联到 Plan 判据

`GET /canvases/:id/facts/:nodeId` 返回 `plan_criterion_source`、`plan_bindings` 和 `goal_review_options`。后者最多 20 项，提供可选评审 Artifact、契约摘要、目标判据与 `expected_review_sha256`；`blocked` 或 `truncated` 不能当作完成依据，列表本身也不授予权限。

现有 `PATCH /canvases/:id/facts/:nodeId/verification` 的 `plan_binding` 可附加 `goal_review: {review_artifact_id, task_contract_sha256, criterion_ids, expected_review_sha256}`。仍须 `jobs:control`、`status: verified`、明确的操作员说明，以及原 Plan/来源/绑定版本字段。操作员须说明这些目标判据如何覆盖完整的 Plan 判据，不按数组序号推导映射。Plan owner 必须冻结同一任务契约；所绑定 Fact 必须是相应评审使用的原始证据，评审 Artifact 自身不能代替执行证据。

关联后每次投影与最终结算都重验评审、来源和证据；冲突、不足、过期、撤销或预算截断仍阻断。原有未选择关联的合法操作员绑定保持原规则，不新增通用人工审批节点。`accepted` 回执只表示持久接纳，不表示 Plan 已完成。

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

- `GET /platform/updates`（admin）：#740 平台版本发现最近一次检查结果（可更新版本、schema 是否需重建、check_error）；项目级 token 拒绝。

### 可选程序规则评审（#767，本片已通过离线行为验收）

goal_review 的 criterion_ids 可选择 `program_rule:<ruleid>`，但必须是 finding_id 主体且冻结契约为 bounty_submission/supplied；fact_id 或未知规则不得使用。沿用相同 Job、Artifact 和证据接口，不新建评审操作。requirement satisfied 表示满足，exclusion satisfied 表示未命中排除；报告 program_rule_review 不等于 submission eligibility。详见[评审边界](../../../docs/TASK_GOAL_REVIEW.md)。

### Finding 证据完整性诊断

`GET /findings/:id/evidence-trace` 及详情诊断只读核验来源与实际留存字节。逐 Fact 的 `execution_assurance:not_attested`、`runtime_claim_structured`、`retained_bytes_verified` 分开表示执行未认证、结构化声明与字节完整性；trace `runtime_proof=false`，`replay.kind=evidence_integrity_check`，不执行复现命令、不改变 Verify verdict/Plan/资格。精确来源与失败边界见[专题](../../../docs/EVIDENCE_TRACE.md)。
