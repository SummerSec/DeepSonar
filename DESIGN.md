# DeepSonar Design

> 当前产品与系统设计摘要（as-built + 已共识演进方向）。  
> 本文件给 Agent / 新人**先读**；细节冲突时以代码、`database/schema.sql`、OpenAPI 与测试为准。
> 日期：2026-08 · 与代码主路径对齐（Plane 可选、本地任务为主）。

## 1. 一句话

**DeepSonar（深流循迹）**：以本地库为唯一管理真相，以任务画布为过程真相，以一次性沙箱为执行真相；多角色 Agent 只提案，调度器唯一落地副作用，通过 fact–intent 二分图与 Hub 循环把探索 → 验证 → 报告收敛。

## 2. 四层真相

| 层 | 真相 | 职责 | 不做 |
|----|------|------|------|
| **本地库 / Web** | 管理真相 | 项目、任务（画布）、角色、凭据、规则、镜像准入 | 不在 Agent 里改基建 |
| **Canvas** | 过程真相 | fact / intent / finding / job 节点与边；布局由服务端算 | Agent 不提案坐标 |
| **Sandbox** | 执行真相 | 每 Job 全新 `/workspace`；独立可写 `HOME`；CLI + 控制 MCP | 仅持当前 Job 冻结的 CLI 配置，终态即销毁 |
| **Scheduler** | 副作用唯一执行者 | claim、状态机、派生 verify/report、Reaper、注入快照 | 不做业务推理 |

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**  
> Plane 为可选集成，默认主路径是 Web 直接创建项目与任务。

## 3. 核心实体（实现）

```
Project 1 ── * Canvas（= 任务；无独立 tasks 表）
Canvas  1 ── * Job
Canvas  1 ── * canvas_nodes / canvas_edges
Job     1 ── * events（语义）
Job     1 ──  transcript / evidence（冷存储）
Finding * ── 1 project + job + optional node
Finding 1 ── * finding_verification_rounds
Canvas  1 ── * task_reports（版本化任务总报告）
Finding 1 ── * finding_reports（confirmed Finding 的版本化单报告）
```

| 概念 | 说明 |
|------|------|
| **任务** | 即 `canvases` 一行；API `GET /projects/:id/canvases` |
| **Job** | 一次沙箱运行：`hub_reason` / 角色名 / `verify_finding` / `report` 等 |
| **Intent** | Hub 下发；与角色 Job 1:1；`prompt` 直接注入 Worker CLI |
| **Fact** | 工作角色增量产出；可带 verification 证据块 |
| **Finding** | 通用协议条目（`profile` / `category` / `tags` / `evidence_refs`）；`severity` 可选，`scoring` 可选且由 Scheduler 规范化；达到 `minVerifySeverity` 或未提供/未知 severity 时进入 verify 生命周期，明确低于阈值的 Finding 保留但不自动验证 |
| **Finding report** | 仅对 `confirmed` Finding 自动生成；每个版本冻结 Scheduler 输入，报告本身不改变 Finding 状态 |
| **Task report** | 画布收敛后按输入摘要版本化；相同输入幂等，输入变化时追加版本并保留历史 |
| **Root** | 画布根；阶段如 `analysis_complete` / `reporting` / `succeeded` |

## 4. 控制闭环（Hub）

```
用户建任务 → hub_reason
    → intents（角色 + 完整 prompt）
    → Worker emit_fact / emit_finding
    → finalizeJob → 再 hub_reason
    → 每个 Finding confirmed → 独立版本化 Finding Report（冻结输入）
    → 验证范围内 Finding ∈ {confirmed, needs_human} 且无活跃工作
    → Hub complete → 版本化 Task Report（系统角色，默认读取最新版本）
```

纪律：

- **Agent 只提案**：`emit_*` / `submit_hub_decision` / `mark_job_done` / `request_human`；是否 verify、是否 report 由调度器决定。
- **图引用硬约束**：Hub 的 `intents[].from` / `complete.from` 必须使用同画布 `root`/`fact`/`finding` 节点的 canonical UUID（YAML `root_id` 的值）；字段名、别名、占位符或跨画布 ID 会使整次决策被拒绝。
- **控制面默认拒绝（#57 / #135）**：所有控制工具与语义事件先经 `packages/shared-types` 严格 Zod 契约（未知字段、空白文本、类型、枚举、UUID、长度、范围、预算均拒绝），再由宿主重验，最后在同一事件事务执行图/状态副作用。Scheduler 的 `event-ingestion` side-effect application（`core.applySideEffects` 仅为兼容 facade）以 Job 类型/冻结角色快照重算工具授权，并要求 Job 仍为 `status=running`；终态、角色种类或工具不一致均以稳定 `ControlInputError` 拒绝并回滚 dedup、额度、事件及图副作用。现有本地 MCP 行为保持不变；同一冻结 capability 同时派生 MCP allowlist 与平台 API operation allowlist，Agent 可按单次调用选择任一通道，但不得跨通道重复提交同一语义写入。MCP 合法响应只代表 `schema_validated / pending_scheduler_validation`，平台 API 返回 Scheduler 接受或拒绝结果；`isError` / HTTP 错误始终带稳定错误码与人话。
- **语义事件持久化限流（#57）**：Scheduler 在 `event-ingestion` 权威事务中以 `job_event_rate_limits` 单行 `SELECT ... FOR UPDATE` 执行有界固定窗口；进度、普通事件和终态/人工事件使用独立桶（默认每 60 秒 30/120/8），终态预算不会被 progress 消耗。幂等 `event_id` 先判重，重复投递不占额度；拒绝返回 `event_rate_limited`、`retry_after_sec` 等低基数元数据并回滚全部事件/画布副作用。计数行跨 Scheduler 进程/重启保留，禁止扫描 append-only `events`。
- **双通道 ack 边界**：本地 MCP 子进程仍不连 Scheduler/数据库，维持既有二阶段 ack，不引入可写控制文件队列或未经治理的 socket。需要同步业务 ack 的 CLI 使用按 Job 签发的短期 capability token 调用 `/control/v1/jobs/:jobId/operations/:operationId`；API 调用进入当前 Job 的同一个宿主 semantic handler，不形成第二套副作用逻辑。
- **静态控制 Skill（#135）**：所有真实 Job 注入同一份平台内置、不可由 RoleConfig 同名条目覆盖的 `deepsonar-control` Skill。Skill 只说明 capabilities/OpenAPI discovery、Bearer 鉴权、UUID `Idempotency-Key`、有限重试和 MCP/API 选择方式，不动态生成 API 清单，也不授予权限；实际开放 operation 只认冻结 Job capability 与 token 绑定列表。
- **短期 API Token（Schema v25 / #135）**：平台控制 API 使用独立 `job_capability_tokens`，不复用 Model Gateway `job_tokens`。Token 只存 hash，绑定 Job、项目、精确 operation 列表与到期时间，在执行期通过环境变量注入且不进入 Job snapshot、工作区、运行清单或 evidence；Job 终态撤销。受限网络只允许固定 Scheduler 上游的 `/control/v1/`，不开放任意代理。
- **控制通道不污染**：结构化 MCP `tool_use` 先进入宿主 bounded pending；对应的合法非错误 `tool_result`（`is_error` 省略或为 `false`）才释放语义事件，显式错误或畸形标记均丢弃 pending。控制工具 telemetry 只保留 toolName/callId 与输入 shape/count，不记录原始 input/content；非 JSON 运行时行、未知行和写 `.deepsonar/control-*` 的尝试只记低基数告警/指标，跳过后继续处理后续合法事件。
- **Hub 不可下发** `verify` / `report`；须先 `list_available_roles`。
- 单画布同时最多一个活跃 hub；`maxHubRounds` / followup 深度护栏。
- 验证：独立 review + test 证据硬门；rework 回弹 Hub 补证。
- **验证范围（#133）**：`minVerifySeverity` 同时控制自动 Verify 与收敛集合；明确低于阈值的 Finding 保持 `pending` 并记录 `below_min_verify_severity` 策略标记，不创建 Verify Job/round、不阻塞 Hub complete/Report。缺失或未知 severity 保守地继续验证；`info` 即严格全量模式。
- **双轨报告（#43/#142）**：收敛门通过后，Scheduler 为画布派发版本化 Task Report；每版冻结 `report-input.json` 与 checksum，相同输入幂等，输入变化时追加版本，失败同输入重试复用版本。每条 Finding 变为 `confirmed` 时独立派发版本化 Finding Report。两类报告在 `pending/generating` 期间都只允许同一目标一个活跃版本，失败只更新报告行，不改变 Finding 状态。
- **通用 Finding 协议（#44）**：`profile`、`category`、`tags`、`evidence_refs` 是跨安全、质量、合规等领域的通用字段；严重度可不提供，CVSS 评分可选。有效协议由全局、项目、任务三层按任务 > 项目 > 全局合并，在建画布时写入 `target_json.effective_finding_protocol` 冻结；Job 和 Agent 只读取该快照。Scheduler 校验 profile/字段边界、去重并决定 Verify，受支持的 CVSS 4.0/3.1 向量由系统重算，协议显式接受的未知版本保留原始向量/指标。

### 4.1 人工消息与动态附件收件箱

- Web 可向当前画布的 **Hub**，或当前选中的 active `intent` / `job` / `report` 节点发送 1–8000 字人工消息；终态或非运行节点不接受定向消息。发送记录以 durable human message ledger 为准，前端只做派生展示，不写回或污染画布拓扑原始数据。
- 多文件先逐个写入项目共享资产，逻辑 key 为 `human-messages/<message-uuid>/<序号>-<安全文件名>`；全部上传成功后，消息才一次性引用对应不可变 `version_id`。任一附件上传失败时不创建带残缺引用的消息；已经成功上传的项目资产保留并明确提示。
- 运行时将每条消息的附件按 message UUID 放入动态收件箱 `/workspace/.deepsonar/inbox/<message-id>/`，并在注入文本中提供不可变路径、摘要与字节数。收件箱不是 Agent 可写回的控制队列，也不改变原有 snapshot 输入。
- 确认严格分两阶段：`injected` 仅表示“已注入会话，等待 Agent 确认”；只有目标 Agent 显式调用受治理的 ACK operation，持久化 `acknowledged_at`（及可选 `ack_summary`）后，UI 才显示“Agent 已确认”。不得从普通文本回复、Session 内容或节点标题推断已读/已处理。
- `planned` / `injected` / `acknowledged` / `unknown` / `failed` 均真实展示；未知窗口与失败不会触发消息自动重发。人类若要再次发送，必须在确认目标和账本状态后主动提交新消息 UUID。

## 5. Job 与并发

```
pending → claimed → provisioning → running
       ↘ waiting_human
       → succeeded | failed | timeout | cancelled | orphan
```

- Lease + Reaper：超时/孤儿**调度器判定**，不信任 Agent 自报。
- 唤醒：`pg_notify('deepsonar_jobs')` 为主；轮询可关。
- 优先级：资格与排序分离（图阶段 / 收敛证据 vs 固定优先级），避免 priority 通胀。

### 5.1 Job Attempt 与外部效果

- 每次 Job 领取在 `job_attempts` 建立一个 Scheduler-owned Attempt；`(job_id)` 的活动唯一索引与事务行锁保证并发 claim 只产生一个活动 Attempt。
- Attempt 的 total state 持久化 `phase`、快照身份、sandbox/session/resource identity 和取消标记。外部动作先在 `job_attempt_effects` 写入 intent 与 `effect_pending`，完成后同事务写 settlement；`replay_policy` 默认 `never`，未确认窗口只标记 `unknown`，不因重启自动重放。
- provision 的 Attempt、效果、资源身份和 `jobs.sandbox_id` 在同一个事务收口；用户取消先提交 Job/Attempt 终态，再通过进程内句柄触发 `AbortSignal`/runtime cancel。dispatcher 在调用 provider 前重查 `provisioning`，runtime 在安装监听后重查 signal，覆盖取消与句柄注册的两个竞态窗口；超时复用同一幂等中止路径，迟到资源立即销毁。Job 与 Attempt 终态也在同一事务提交。
- 启动对账按 Attempt phase/effect 账本分类：只有尚未开始且无效果的 `preparing` 可回到 `pending`；`effect_pending/unknown` 统一转 `orphan`，清理沙箱、Token、画布和外部同步。

## 6. 配置层级

| 层 | 内容 | 覆盖 |
|----|------|------|
| 全局 | `global_settings`、全局 `role_configs`、平台 skill 源、镜像市场 | 缺省 |
| 项目 | 规则、启用角色、项目 RoleConfig、出网默认、`config_json` 中的镜像策略 | **压过全局** |
| 任务/画布 | `target_json`、出网覆盖、Finding 协议等 | **压过项目** |
| Job | `agent_snapshot_json` 创建时冻结 | 执行只认快照 |

**冲突规则：任务 > 项目 > 全局**（RoleConfig 已如此；Finding 协议等演进配置同此心智）。

Finding 协议存于全局 `global_settings.rules_json.finding_protocol`、项目
`projects.config_json.finding_protocol`，任务创建请求可用 `finding_protocol` 只覆盖声明的键；列表字段在高层整表替换。解析后的 `EffectiveFindingProtocol`（模式、默认/允许 profiles、评分策略、显示名和来源）随新画布冻结，后续配置修改只影响新任务。

项目镜像策略也存于 `projects.config_json`，不增加表或迁移：`image_strategy` 缺省为
`inherit_global`，此时 Job 镜像始终取该角色的全局 `RoleConfig.runtime_image_key`；
`project_managed` 时只取 `role_runtime_images`（角色名到可信 runtime key 或 `null`），缺项或
`null` 使用系统 `deepsonar-base`。项目 RoleConfig 的 `runtime_image_key` 不再作为项目镜像来源。

## 7. 注入与读图（as-built）

- `buildGraphSnapshot(canvasId, scope?, opts?)` → YAML：goal、facts/findings 摘要、open/concluded intents、hints。
- **GraphScope**（`hub` | `agent` | `verify` | `report`）与**整图字符预算**已在 `graph.ts` 落地（#30）；Hub/Worker/Verify 注入投影不同，仍须关注超预算截断与索引完整性。
- 单字段仍有截断（description/summary 等）；`job` 类型节点**不进** YAML。
- Worker 运行包会注入画布冻结的 Finding 协议说明（模式、允许 profile、CVSS 接受版本和必评分 profile）；Agent 只能通过严格的 `emit_finding` MCP 或同名 Job-scoped API operation 提交提案，不能写 `raw` 或修改协议、验证派生和 severity/scoring 的系统归一化。
- Skill：`skill_sources` sync catalog；RoleConfig `modules` 现为 `"source_id:module_id"` / `plugin:` / `source:*` 展开为 embedded skills/commands。手写同 kind/name 配置覆盖 catalog 模块时，最终 expanded 集合/hash 只保留实际嵌入内容，并记录 `manual-override`。Job 快照同时冻结模块元数据哈希与结构化 `missing_modules`；同一 materializer 命名空间的重名模块全部排除，禁止顺序覆盖；materializer 对组件名和 skill 文件路径执行严格子树安全校验。

## 8. 观测与证据

| 通道 | 内容 | 持久化 |
|------|------|--------|
| 语义 events | progress / finding / done / human | Postgres |
| 实时流 | text.delta / tool.call.* | 进程内 `stream-bus` + WS `/ws`；环形缓冲 |
| 过程流 | normalized NDJSON | Job 目录；**manifest 多在 finalize 后可读** |
| Session / OTLP | CLI 原始 | 冷存储 blob |

`DEEPSONAR_AUTH_REQUIRED=true` 时 HTTP 需 Bearer；**WS 鉴权与前端带 token 为已知缺口**（#38）。

## 9. 安全边界

- 被审计目标 = 不可信输入（prompt injection）。
- `settings_config_json` 是 CLI 连接真相，但 Job 只冻结去除长期密钥后的配置结构；每次执行把 CLI endpoint 改写到 Model Gateway，并只注入短期单 Job token。管理 API/Web 同样只返回脱敏投影，长期 Provider 密钥不进入 Job 快照或工作区。
- 镜像：市场 digest 冻结；第三方须 image-admission；Agent 不能指定镜像。项目按全局继承或项目托管策略选择受治理 runtime key，Job 创建时连同兼容 CLI 与工具清单一起冻结。Chrome audit/test/fuzz 是官方但 project-opt-in 的专项运行时。
- 出网：`allow_egress` 任务级冻结；所有 real Job 的模型请求都经 Scheduler-owned gateway proxy。允许出网的沙箱加入 `deepsonar-sandbox-gateway` NAT bridge；禁出网时只加入 `deepsonar-restricted` internal bridge，并通过同时接入两网的固定 proxy 到达 Scheduler。
- Model Gateway 上游单次超时默认为 3,000 秒，但每次 attempt 取 `min(3_000_000ms, Job 剩余时间)`；仅在客户端响应头/响应体尚未开始发送前，对网络/超时和 HTTP 408/429/500/502/503/504 做最多 3 次指数退避加 jitter，永久 HTTP 错误不重试，已开始的 SSE/响应体绝不重放。Job 的 `used_requests` 按沙箱客户端请求只递增一次；上游 attempt/retry/exhausted 仅记录 provider、reason 等低基数指标，不记录请求体、URL 或 Job ID。网络/超时耗尽返回稳定 `502 upstream_unreachable`，最终上游 HTTP 响应原样直通。
- Gateway 重试耗尽并导致 Agent CLI 退出后，runtime runner 只对明确的 HTTP 408/429/500/502/503/504、timeout 与 network 错误，在原沙箱使用已捕获的原 session ID 最多恢复 3 次（1/2/4 秒退避）。Claude Code 使用 `--resume`，Codex 使用 `exec resume`，OpenCode 使用 `--session`；400/401/403、普通退出、缺 session 或恢复耗尽均直接失败，不允许 `--continue`、latest session 或新会话兜底。恢复过程写入低基数 `run.retrying` / `run.retry_skipped`，已成功控制副作用继续由运行时去重与数据库幂等键保护。
- Model Gateway 的每次请求同时写入 `job_usage_ledger`，关联 `attempt_id + effect_id`；只保留 provider/model、输入/输出/总 token、请求序号和 `settled|unknown|not_reported`，不保存 prompt、响应正文、请求头或凭据。流式 usage 按完整记录去重，响应已发送后账本写失败计指标并保留可对账的 effect 标识，不制造未处理异常。

## 10. 前端信息架构

- 一级工作流固定为 **态势 / 项目 / Agent / Agent 市场 / 镜像**；跨项目 Findings/Jobs 保留查询页与命令菜单入口，但不占主 rail。日常闭环从项目 → 任务 → 画布/发现/运行/报告完成。
- Agent 页只维护角色注册表与全局 RoleConfig。模块源归 Agent 市场；账号/用户/API Token 归安全与访问；Provider 密钥归凭据；全局调度规则与平台配置包归平台数据。
- Agent 市场 MVP 使用 `deepsonar.agentpack/v1`：官方静态模板与本地 JSON 上传均安装到服务端角色/RoleConfig；包体有 256 KiB 上限，不接受 Credential 绑定、Provider 配置文件或疑似长期密钥环境变量。安装仍由 `agents:write` 权限控制，凭据必须本机另行绑定。
- 任务列表 / 任务工作台（画布 · Findings · Jobs · 报告）
- 节点语义色：`SEMANTIC_STYLE`（hub 紫、finding 红、agent 黄、fact 青…）
- 工作角色使用 `agent_roles.ui_color` 的调度器分配色；系统 / Hub 节点保留固定语义色。角色色在创建事务中经 advisory lock 分配，写入 intent/job 节点正文后冻结；画布边线与箭头取源节点最终色，边类型只改变线型与流速。
- **任务是否在跑：以 `active_count` / 活跃 Job 为准**；勿把 `last_job_status=succeeded` 当成任务已完成（#46）
- 画布只读；Finding 详情偏 GitHub Issue（disposition + 评论可唤醒 Hub）
- Finding 列表/画布运行区显示冻结的 profile、可选 category 与 CVSS 版本/基础分；按 severity、profile、verify 状态筛选。详情保留向量、定性严重度、利用难度和原始 JSON；报告按 profile 分组、展示 category，并携带 tags、evidence_refs 与 scoring。
- Finding 详情直接展示服务端统一的验证追踪（来源、review/test Fact、Intent/Fact 有向流、Verify 轮次与 exact Hub）；可用 `traceFinding` 深链在画布中淡化或隐藏非链路节点，并按 `focusNode` 定位单个证据节点。弱关联不从 prompt 推断，未连边 Intent 与证据缺口显式呈现。

## 11. 已共识演进（未完全落地）

下列方向已在 GitHub Issues 中立项，**实现前以 issue 和当前代码为准**。

| 主题 | Issue | 设计要点 |
|------|-------|----------|
| 读图预算 / GraphScope | #30 | **部分已落地**（scope + 字符预算）；索引层/Worker 邻域与可观测性可继续收紧 |
| Finding 追踪链 + 画布只看链路 | #31 | **已完成**：`GET /findings/:id` 提供结构化、限界的 `trace`；详情主路径消费 evidence/rounds/Fact-Intent flow/gaps；画布支持 `traceFinding` + `focusNode` 深链、淡化/隐藏与 Finding 节点入口 |
| 整插件 / 整源挂载 | #33 | `modules` selector：`plugin:` / `source:*` |
| Scheduler bounded contexts / characterization | #37 | **已完成**：六个领域均通过 application/ports 暴露窄接口；`event-ingestion` 拥有 envelope、幂等、顺序、限流与语义副作用，Hub/Finding/Report/runtime snapshot 通过显式 ports 协作。顶层 `routes.ts` 只保留 auth/project-scope hook、Gateway 与领域 registrar 组装，业务 handler 全部按域归属。`core.ts` 保留既有 import 的兼容 facade 与 composition root，不再承载事件副作用实现；Canvas-first 事务锁序、终态组合、路由/OpenAPI surface 和无生产动态 import 均有回归护栏。 |
| 实时流 + 运行中过程流 | #38 | WS 鉴权；inflight 读 `stream.ndjson` |
| 软加载 / 增量同步 | #39 | 骨架 L0 → 视口 L1 → 详情 L2；`canvas_changes` durable revision/tombstone；`delta?since=<revision>`，游标过旧显式回退 L0 |
| 分层共享资产 | #41 | **已实现**：platform/project/finding 三级不可变版本库，CAS blob、配额/MIME/path 校验、人工上传/归档/下载、Agent `list_shared_assets`/`publish_shared_asset`、项目 platform opt-in、Finding 隔离、Job 精确版本快照，以及带 Job 标签的 `:ro` named volume 自动注入/回收；项目/平台/Finding UI 已接入。字节经可插拔 BlobStore（`BLOB_STORE=fs|s3`，官方生产 Compose 默认使用 PGSTY Silo，仍兼容任意 S3 服务）；Agent **无单独下载工具**，list 返回 `mount_path`/`read_path` 用普通文件工具读取，publish 由 Scheduler 写 BlobStore。 |
| Provider 配置（CC Switch 模型） | #99 | **已落地（三类配置方言）**：LLM `provider` 是协议（Anthropic Messages / OpenAI Responses），不是厂商预设。`credentials` 存 `agent_cli` + 完整 `settings_config_json` + `meta_json`；管理 API 仅返回 `[已保存密钥]` 脱敏投影。角色绑定 Credential 配置文件，`RoleConfig.model` 仅作可选高级覆盖；所有门禁与 Job 冻结统一解析 `effectiveModel = RoleConfig.model ?? Credential settings model ?? null`。显式 `allowed_model_ids` 只约束 effective model，settings 模型不会静默开启白名单。Job 快照仅保存无密钥配置结构；运行时物化 `.claude/settings.json` / `.codex/*` / `.opencode/config.json` 时统一改写到 Model Gateway，并注入短期 Job token。 |
| 治理多 CLI Runtime Adapter | #100 | **已落地**：Scheduler 通过显式注册表驱动 Claude Code、Codex、OpenCode 的官方非交互结构化协议；能力、适配器版本和兼容 runtime image 在创建 Job 时校验并冻结到 `agent_snapshot_json`。未注册 CLI、缺失必需能力或镜像不兼容均在执行前 fail closed。详见 [`docs/AGENT_CLI_RUNTIME_ADAPTERS.md`](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)。 |
| 节点/边着色 + Agent 专色 | #42 | 边随源节点色；新建 role 分配未占用色 |
| 双轨报告 | #43/#142 | **已完成**：任务收敛后按冻结输入摘要生成版本化 Task Report，默认返回最新版本并保留历史；每条 `confirmed` Finding 自动生成独立、冻结输入的版本化 Finding Report。两条轨道都限制同一目标同时一个活跃报告，不修改 Finding 状态 |
| 通用 Finding + CVSS | #44 | **已完成**：通用 `profile/category/tags/evidence_refs` 与可选 severity/scoring；协议按任务>项目>全局解析并随画布冻结；Agent 通过严格 MCP 提案，Scheduler 重算 CVSS 4.0/3.1、保留协议允许的未知版本原始数据；Web/报告支持标识、筛选与分组 |
| 任务卡片状态 | #46 | 任务级相位与 `active_count` 同源 |
| 产品 IA 与 Agent 市场 | #49 | **已完成**：5 个一级工作流入口；发现/运行回归项目任务主路径并保留命令检索；Agent、模块市场、安全、凭据、平台数据按权限边界拆页；官方模板与安全约束的本地 agentpack 安装 MVP |
| 官方运行镜像多 channel catalog | #70、#143 | **已完成**：v2 canonical digest/platform/size + `registry_refs`/`registry_evidence` 合约、v1 归一化与严格 OCI/host/namespace 校验；release 按 ACR→GHCR→Docker Hub 发布并对每个可用目的地执行真实 `imagetools inspect`，配置通道失败时清单生成 fail-closed，v2 Release asset 与 bundled fallback 同步；schema v23 新库默认选择 `aliyun-acr`，平台全局通道由 Scheduler 落库并经 `GET /runtime-images/registry` 的 `selected_channel` 读取、`PATCH /runtime-images/registry/channel`（`images:manage`）切换，Job 创建时冻结所选 digest/ref，pull/resolution 对未发布通道 fail-closed；官方目录同步和独立准入 Worker 的首次扫描、恢复扫描、周期复扫均按部署 `DEEPSONAR_IMAGE_REGISTRY` 从同一 digest 的已有发布证据中选择引用，配置不匹配或证据缺失时拒绝扫描，绝不回退到 GHCR。若同一官方 digest 曾因旧 registry 引用不可达而被撤销，目录切换到已证明的新 registry 引用时会回到隔离态并仅排队一次恢复扫描；扫描成功才恢复官方信任，部署源上的真实扫描失败重新撤销，同引用的真实安全撤销不会被目录同步覆盖；Web 市场提供固定三选项通道选择器，与 CPU 平台筛选分离，展示加载/403/切换状态并在切换后刷新清单与镜像行 |
| Chrome audit/test/fuzz 专项运行时 | #118 | **已实现发布基础设施**：三个官方 project-opt-in 镜像分别提供 C++ 静态分析、固定 Chromium/CDP 与固定 V8 源码构建的真实 `d8` + `v8_json_libfuzzer`；每个镜像同时声明 amd64/arm64、来源 SHA256/完整包闭包、工具清单与大小预算。V8 与 Chromium 版本语义分开声明；Job 仍只消费准入后的 immutable digest；核心 CI 与 Chrome amd64 合同冒烟已拆为路径过滤的 `.github/workflows/ci.yml` / `.github/workflows/chrome-runtime.yml`；Chrome Fuzz amd64 按正常目标架构构建并执行 smoke，arm64 在 x86 runner 上使用固定 Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装，真实 `d8`/`v8_json_libfuzzer` smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，原生 smoke 通过前不得组装发布 index；Release 还须完成多 registry inspect 后才生成 catalog |
| 项目镜像策略 | #130 | **已完成**：项目创建与设置支持 `inherit_global` / `project_managed`；项目托管映射集中绑定全部角色到项目已启用的可信镜像，缺项使用 Base；项目 RoleConfig 不再接受独立镜像覆盖，Job 创建时只按项目策略解析并冻结 immutable digest |
| 临时上游错误恢复 | #131 | **已完成**：Gateway 在响应交付前有界重试；CLI 仍因明确临时错误退出时，runner 在原沙箱按原 session ID 有界恢复，永久错误和缺 session 均 fail closed |
| Verify 严重度收敛 | #133 | **已完成**：`minVerifySeverity` 同时限定自动 Verify 与收敛集合；低于阈值的 Finding 保留为策略排除项，不占 Verify 资源、不阻塞报告；`info` 保留严格全量模式 |
| 平台 OpenAPI + 静态控制 Skill | #135 | **第一阶段已落地**：现有 MCP 暂作过渡通道；真实 Job 注入静态 `deepsonar-control` Skill，并以独立短期 capability token 访问按冻结 operation allowlist 过滤的 `/control/v1/jobs/:jobId` capabilities/OpenAPI/operation API。API 与 MCP 共用宿主 semantic handler 和 Scheduler 权威副作用；当前由 Agent 对每个逻辑操作自行选择一个通道，长期统一到 API 并淘汰 MCP；未来新平台工具只扩展 API。 |
| Agent Runtime Context 生命周期与恢复身份 | #138 | **已落地基础契约**：Executor 为每个 Attempt 生成稳定 `context_id`/revision 与只含摘要的 transform manifest，按 attempt state 和 Job runtime evidence 持久化；`context.compacted` 严格校验身份、链摘要、顺序并支持幂等重放，无法观测或不支持时显式记录而不伪造压缩。恢复前必须取得实际上下文身份并逐字段匹配，缺失或不一致则拒绝恢复；Pi 使用精确 session 文件，不选择 latest。Job 详情只展示有界诊断，不展示 prompt 或 provider 原文。 |
| Pi Coding Agent RPC Runtime Adapter 与 Capability API | #140 | **已落地**：Pi 固定使用 `pi --mode rpc --no-approve` 的严格 LF JSONL 协议，平台控制通过 Job 级 HTTP Capability API，不物化或注入 MCP；`agent_settled` 只提供运行时静止信号，Job 成功仍须经过 `mark_job_done` 完成门。`get_state` 返回的精确 `sessionFile` 用于恢复，暂态错误最多同会话重试三次；模型配置经 Gateway 物化为 `models.json`。项目 `.pi` 不自动加载，默认 `--no-extensions`，受治理扩展才通过冻结配置显式 `--extension` 加载。 |
| 通用长上下文预算 | #144 | **已完成**：模型目录只登记 Provider 返回的模型 ID，不把 “1M” 等营销标签推导成能力。Credential `settings_config_json.context_window_tokens` 提供 1024–10000000 的 CLI 客户端基准预算，RoleConfig 同名字段可覆盖，`null` 依次继承 Credential、Provider/CLI 默认；新 Job 冻结解析值，旧 Job 不变。该预算不提升上游模型能力，真实可用窗口仍受 Provider、模型 ID 与账号权限限制。Codex 落到 `model_auto_compact_token_limit`，OpenCode 落到模型 `limit.context`，Pi 落到 `models.json` 的 `contextWindow`；Claude Code 没有受支持的绝对窗口设置，因此只冻结/展示，不伪造环境变量或 CLI 参数。 |
| Runtime Platform API 能力一致性 | #145 | **已完成当前阶段**：四个治理 adapter 均声明 Job 级 HTTP `platformControlApi`；Claude Code、Codex、OpenCode 当前同时向 Agent 提供 MCP 与 API，由 Agent 对每个逻辑操作自行二选一，Pi 仅使用 API。长期统一到 API 并淘汰 MCP |
| 项目镜像继承一致性 | #146 | `inherit_global` 继续只认全局 RoleConfig 镜像；`project_managed` 只认项目 `role_runtime_images` 映射。修复遗留项目 RoleConfig `runtime_image_key` 在导入、展示或 readiness 中被误当作有效配置的问题，不恢复 #130 已删除的独立项目镜像覆盖 |

## 12. 仓库地图

| 路径 | 职责 |
|------|------|
| `apps/scheduler` | Fastify API、dispatcher、core、verify、report、gateway |
| `apps/web` | React 工作台与画布 |
| `apps/image-admission` | 第三方镜像扫描准入 |
| `packages/runtime-sandbox` | SandboxRunner / agentbox |
| `packages/shared-types` | zod 事件与 payload 单源 |
| `database/schema.sql` | 唯一 schema 基线（当前 v28）；空库套用、非空只校验版本与结构；改表 bump `SCHEMA_VERSION` 后重建库，无增量 migration |
| `deploy/` | 生产与 real 模式编排 |

## 13. 给实现者的硬约束

### 13.1 Agent 控制面输入 doctrine（D1–D6）

1. **D1 默认拒绝**：每个工具 `additionalProperties: false`；未知字段返回 `unknown_field`，不得 strip 后部分落库。
2. **D2 标识符标准形态**：节点/边只认当前画布 `referableIds` 中的 canonical UUID；Finding 绑定只认数据库 Finding UUID；角色只认本轮 `list_available_roles`；未来路径工具只认白名单前缀。
3. **D3 通道不可污染**：语义事件只能由控制 MCP 或按 Job 授权的平台 API 结构化提交；Agent 不能用 shell 或 `.deepsonar/control-*` 文件模拟队列，也不能猜测管理 API；脏行告警后不得丢弃后续合法事件。
4. **D4 错误形态**：拒绝返回稳定 `error_code` + 可读消息；禁止把 PostgreSQL/`JSON.parse` 堆栈作为唯一结果；禁止 MCP 先报成功、Scheduler 后静默失败。
5. **D5 单源契约**：`shared-types` Zod schema 同时生成 MCP JSON Schema；每个工具必须有合法/非法夹具、宿主重验和业务前置条件测试。
6. **D6 纵深校验**：MCP/API 同源 schema → runtime/host parse → ingest/apply transaction 三层均须拒绝；任何层缺失都不算完成。

语义事件限流配置由 Scheduler 环境变量读取并在启动时做正整数/上界校验：
`EVENT_RATE_LIMIT_WINDOW_SEC`（1–3600，默认 60）、
`EVENT_RATE_LIMIT_PROGRESS_PER_WINDOW`（1–10000，默认 30）、
`EVENT_RATE_LIMIT_STANDARD_PER_WINDOW`（1–10000，默认 120）和
`EVENT_RATE_LIMIT_TERMINAL_PER_WINDOW`（1–1000，默认 8）。计数器按 Job 固定窗口落库；窗口跨进程/重启共享，时钟回拨不会倒退窗口。历史项目导入/恢复可直接批量写入既有事件作为审计数据，不走运行时额度；导入后的新 Agent 语义事件仍经上述摄入硬门，且只接受 `status=running` 的 Job。

工具 → 禁止输入 → 稳定错误码：

| 工具 | 关键禁止输入 | 错误码 |
|---|---|---|
| `list_available_roles` | 非空参数、未知字段、未授权调用 | `invalid_payload` / `unknown_field` / `tool_not_allowed` |
| `emit_progress` | 空白/超长 message、percent 越界或非数字 | `invalid_progress` |
| `emit_fact` | 缺 title/description、未知字段、非法 verification 或错误 Finding 绑定 | `invalid_payload` / `unknown_field` / `invalid_verification` |
| `emit_finding` | 非法 profile/category、空白/超长字段、未接受的评分版本、写入内部 `raw` | `invalid_payload` / `unknown_field` |
| `submit_hub_decision` | complete/intents 同时或皆无、空/半截 intent、非法 UUID/角色/预算 | `invalid_payload` / `invalid_node_ref` / `invalid_role` / `invalid_reference_budget` |
| `mark_job_done` | 空白 summary、verify 缺 verdict、rework 缺 missing_evidence、非 verify 乱传 verdict | `invalid_done` |
| `request_human` | 空白/超长 reason、未授权角色 | `invalid_human` / `tool_not_allowed` |

新增控制工具 checklist：定义严格 Zod payload + 同源 JSON Schema；列出禁止输入/错误码/业务白名单；MCP 与宿主各有合法/非法测试；core 事务断言失败全回滚；确认不写控制文件、不把普通文本当语义事件；更新本表、平台工具说明和 CI 冒烟。

1. **不扩大 Agent 权限**：镜像、凭据、派生、状态机终态只在调度器。  
2. **改表 = 改基线 + bump 版本 + 重建库验证**（直至 #34 类迁移落地）。  
3. **列表 API 不塞大 body**；大字段详情/按需（#39）。  
4. **进 prompt 的内容当不可信**；共享资产只读挂载（#41）。  
5. **配置覆盖：任务 > 项目 > 全局**；Job 只认冻结快照。  
6. 细节冲突时：代码 + schema + OpenAPI + 测试 > 本摘要；演进以 open issue 为准。

## 14. 当前事实入口

- `database/schema.sql` — 数据结构与默认值唯一基线
- `/api/openapi.json` — HTTP API 契约
- `.github/workflows/ci.yml` / `chrome-runtime.yml` / `openharmony-runtime.yml` / `release.yml` — 构建、验证与发布门禁
- GitHub Issues — 未完成能力和后续方案
- `AGENTS.md` / `CLAUDE.md` — 给编码 Agent 的操作手册
