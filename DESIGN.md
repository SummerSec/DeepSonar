# DeepSonar Design

> 当前产品与系统设计摘要（as-built + 已共识演进方向）。  
> 本文件给 Agent / 新人**先读**；细节冲突时以代码、`database/schema.sql`、OpenAPI 与测试为准。
> 日期：2026-08 · 与代码主路径对齐（本地任务为主）。
> **专题文档索引与 as-built 状态表**：[`docs/README.md`](docs/README.md)（历史方案稿勿当未完成清单）。

## 1. 一句话

**DeepSonar（深流循迹）**：以本地库为唯一管理真相，以任务画布为过程真相，以一次性沙箱为执行真相；多角色 Agent 只提案，调度器唯一落地副作用，通过 fact–intent 二分图与 Hub 循环把探索 → 验证 → 报告收敛。

## 2. 四层真相

| 层 | 真相 | 职责 | 不做 |
|----|------|------|------|
| **本地库 / Web** | 管理真相 | 项目、任务（画布）、角色、凭据、规则、镜像准入 | 不在 Agent 里改基建 |
| **Canvas** | 过程真相 | fact / intent / finding / job 节点与边；服务端 `x/y` 仅作 placement/exchange hint，Web 对当前可见投影布局：默认深度 3 且首批总计 24 个节点，elkjs 同时负责主 DAG 节点与边路由，指向 root 的完成反馈边脱离排位并走共享收敛 rail | Agent 不提案坐标 |
| **Sandbox** | 执行真相 | 每 Job 全新 `/workspace`；独立可写 `HOME`；CLI + Job 级控制 API | 仅持当前 Job 冻结的 CLI 配置，终态即销毁 |
| **Scheduler** | 副作用唯一执行者 | claim、状态机、派生 verify/report、Reaper、注入快照 | 不做业务推理 |

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**  
> 默认主路径是 Web 直接创建项目与任务。

### 2.1 设计原则

1. **极简优先**：用最少的概念、状态、配置和依赖完成当前闭环；能删除就不新增一层，不为假设需求做预防性抽象。
2. **成熟开源优先**：通用能力默认采用经过生产验证、持续维护的开源产品和开放标准。站在巨人的肩膀上，不把重写基础设施当作目标。
3. **先复用再引入**：先核对仓库已有依赖与平台能力，再评估成熟方案，最后才自行实现。自研必须指出现成方案无法满足的具体约束。
4. **依赖按全生命周期评估**：维护活跃度、许可证、安全记录、生态采用、可替换性和运维成本都要过关，不能只看 API。
5. **边界长期稳定，局部保持可替换**：数据所有权、安全模型和副作用边界按长期方案设计；边界内实现保持简单，避免临时双轨和兼容层。
6. **分层设计，控制文件职责**：按领域和层次组织代码，单个文件只承担一个稳定职责。入口负责组装，领域模块负责规则，基础设施模块负责外部效果；不在同一文件里持续叠加跨领域逻辑，也不为追求拆分制造空洞薄层。
7. **采用已验证的产品模式**：优先沿用成熟产品的术语、交互和运维方式，减少学习成本，不另造协议与工作流。
8. **工具助力，扫描不决策（#267 / #266）**：官方运行时提供 **基础工具**（git、ripgrep、语言运行时、编译器、调试/反汇编、fuzz 引擎），给 AI 读代码、构建、调试、PoC 与 fuzz。**不**预装决策型扫描器（Semgrep / gitleaks / shellcheck 及同类规则引擎），**不**提供平台规定的固定扫描脚本/规则包作为 audit 主路径。是否扫描、扫什么、用什么启发式，由 Agent 在本轮 intent 下自行决定；平台只保证工具存在、版本钉死、断网可跑。Finding 质量来自 harness + Verify 硬门，不是复现企业 SAST/密钥扫描覆盖面。

## 3. 核心实体（实现）

```
Project 1 ── * Canvas（= 任务；无独立 tasks 表）
Canvas  1 ── * Job
Canvas  1 ── * canvas_nodes / canvas_edges
Canvas  1 ── * canvas_broadcasts（Fact/Finding 向并发 Worker 的投递账本）
Job     1 ── * events（语义）
Job     1 ──  transcript / evidence（冷存储）
Finding * ── 1 project + job + optional node
Finding 1 ── * finding_verification_rounds
Canvas  1 ── * task_reports（版本化任务总报告）
Finding 1 ── * finding_reports（confirmed Finding 的版本化单报告）
```

| 概念 | 说明 |
|------|------|
| **任务** | 即 `canvases` 一行；API `GET /projects/:id/canvases`；`kind=standard` 为普通任务，`kind=compose` 以同项目 1–8 条未否定处置 Finding（含未确认）作为冻结只读种子，且不得扩大资产范围 |
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
- **控制面默认拒绝（#57 / #135 / #152）**：所有控制操作与语义事件先经 `packages/shared-types` 严格 Zod 契约（未知字段、空白文本、类型、枚举、UUID、长度、范围、预算均拒绝），再由宿主重验，最后在同一事件事务执行图/状态副作用。Scheduler 的 `event-ingestion` side-effect application（`core.applySideEffects` 是 composition root 接线）以 Job 类型/冻结角色快照重算授权，并要求 Job 仍为 `status=running`；终态、角色种类或 operation 不一致均以稳定 `ControlInputError` 拒绝并回滚 dedup、额度、事件及图副作用。冻结 capability 只派生平台 API operation allowlist；所有治理 CLI 均由 Agent 使用自身 HTTP 工具调用 Job 级控制 API，不注入控制 MCP，也不在失败后回退其它控制通道。API 返回 `accepted` 表示 Scheduler 已接收输入，HTTP 错误始终带稳定错误码与人话。
- **控制 payload 字节与确认边界（#166）**：Fact、Finding、Hub 的直接参数与宿主展开后的 `payload_file` 共用固定 256 KiB UTF-8 JSON 上限，超限在暂存或写事件前以可重试控制错误拒绝；`mark_job_done.summary` 上限为 8192 UTF-8 字节，接受后不再附加 Hub、Fact 或 Finding 计数文本。Hub/Human 的真实副作用仍延迟到 Agent 退出后执行，但在返回 `accepted` 前以只读权威事务预检当前 Job、画布引用、角色、Finding 绑定与完成门，最终副作用事务再次校验以防状态漂移。
- **语义事件持久化限流（#57）**：Scheduler 在 `event-ingestion` 权威事务中以 `job_event_rate_limits` 单行 `SELECT ... FOR UPDATE` 执行有界固定窗口；进度、普通事件和终态/人工事件使用独立桶（默认每 60 秒 30/120/8），终态预算不会被 progress 消耗。幂等 `event_id` 先判重，重复投递不占额度；拒绝返回 `event_rate_limited`、`retry_after_sec` 等低基数元数据并回滚全部事件/画布副作用。计数行跨 Scheduler 进程/重启保留，禁止扫描 append-only `events`。
- **同步 ack 边界**：CLI 使用按 Job 签发的短期 capability token 调用 `/control/v1/jobs/:jobId/operations/:operationId`；API 调用进入当前 Job 的宿主 semantic handler，不形成第二套副作用逻辑，不引入可写控制文件队列或未经治理的 socket。
- **静态控制 Skill（#135 / #152）**：所有真实 Job 注入同一份平台内置、不可由 RoleConfig 同名条目覆盖的 `deepsonar-control` Skill。Skill 只说明 capabilities/OpenAPI discovery、Bearer 鉴权、UUID `Idempotency-Key` 和有限重试，不动态生成 API 清单，也不授予权限；实际开放 operation 只认冻结 Job capability 与 token 绑定列表。
- **短期 API Token（Schema v25 / #135）**：平台控制 API 使用独立 `job_capability_tokens`，不复用 Model Gateway `job_tokens`。Token 只存 hash，绑定 Job、项目、精确 operation 列表与到期时间，在执行期通过环境变量注入且不进入 Job snapshot、工作区、运行清单或 evidence；Job 终态撤销。受限网络 sidecar 只允许固定 Scheduler 上游的 `/gateway/` 与 `/control/v1/`，不开放任意代理；受管容器同时绑定 upstream hash 与代理脚本 revision，升级时 revision 不符会自动重建，未受管的同名容器拒绝接管。
- **控制通道不污染**：真实 Job 的语义写入只接受 capability token 授权的 Job 级 API operation；CLI 结构化流中的同名或伪造 MCP tool call 不映射为语义事件。控制 telemetry 只保留 operation、调用标识与输入 shape/count，不记录原始 input/content；非 JSON 运行时行、未知行和写 `.deepsonar/control-*` 的尝试只记低基数告警/指标，跳过后继续处理后续合法事件。
- **Hub 不可下发** `verify` / `report`；须先 `list_available_roles`。
- 单画布同时最多一个活跃 hub；`maxHubRounds` / followup 深度护栏。
- 验证：独立 review + test 证据硬门；rework 回弹 Hub 补证。
- **盲验 Phase 1（#367）**：`verify_finding` 只冻结主体 / location / `artifact_refs`，不下发 maker 的 title/summary/severity；`GraphScope=verify` 默认只投影骨架与引用。Verify prompt 要求先独立推导再逐项 DIFF，仅 exact match 可 confirm；`confirmed` 另需至少一条带非空 `expected`+`actual` 的 `VerificationEvidence`，路径分叉必须 rework。数值保真 / 矛盾检测 / 对抗挑战留待后续 issue。
- **验证范围（#133）**：`minVerifySeverity` 同时控制自动 Verify 与收敛集合；明确低于阈值的 Finding 保持 `pending` 并记录 `below_min_verify_severity` 策略标记，不创建 Verify Job/round、不阻塞 Hub complete/Report。缺失或未知 severity 保守地继续验证；`info` 即严格全量模式。
- **Hub Finding 绑定（#153 / #154 / #161 / #273）**：Hub 对本轮 canonical Finding 节点派发 review/test 时，Scheduler 在派生前解析并冻结唯一 `finding_id` 与 `verification_followup`；多 Finding、映射歧义、Verify trigger 不一致或低于 `minVerifySeverity` 的目标使整次决策稳定拒绝。compose 的 imported seed 是例外：review/test 只把其共享资产挂到探索 Worker，不创建 verification follow-up，也不改写历史 Finding；compose 画布上 explore/audit 必须绑定至少一条 imported 种子投影，不得未绑定地全图打猎。`request_human` 也必须携带结构化 subject：Finding subject 由 Scheduler 校验同项目、同画布 canonical 关系及最低验证级别，平台阻塞则只能使用受限 kind；系统绝不解析 reason 文本推断目标。analyze 仍可引用多个来源。
- **人工验证收口（#155）**：Finding 详情提供三种显式动作：强制新建受护栏约束的 Verify round、新建绑定 Finding 的 review/test 补证 Job，以及在同画布 Hub 处于 `waiting_human` 时把尚未 confirmed 的 Finding 收口为 `needs_human`。所有动作按 canvas-first 顺序加锁、禁止终态重开并拒绝同类活动 Job；需要恢复时在同一事务将 Hub 转回 `pending` 并通知 dispatcher。人工入口绝不开放 `confirmed`。
- **双轨报告（#43/#142）**：收敛门通过后，Scheduler 为画布派发版本化 Task Report；每版冻结 `report-input.json` 与 checksum，相同输入幂等，输入变化时追加版本，失败同输入重试复用版本。每条 Finding 变为 `confirmed` 时独立派发版本化 Finding Report。两类报告在 `pending/generating` 期间都只允许同一目标一个活跃版本，失败只更新报告行，不改变 Finding 状态。
- **通用 Finding 协议（#44）**：`profile`、`category`、`tags`、`evidence_refs` 是跨安全、质量、合规等领域的通用字段；严重度可不提供，CVSS 评分可选。有效协议由全局、项目、任务三层按任务 > 项目 > 全局合并，在建画布时写入 `target_json.effective_finding_protocol` 冻结；Job 和 Agent 只读取该快照。Scheduler 校验 profile/字段边界、去重并决定 Verify，受支持的 CVSS 4.0/3.1 向量由系统重算，协议显式接受的未知版本保留原始向量/指标。

### 4.1 人工消息与动态附件收件箱

- Web 可向当前画布的 **Hub**，或当前选中的 active `intent` / `job` / `report` 节点发送 1–8000 字人工消息；终态或非运行节点不接受定向消息。发送记录以 durable human message ledger 为准，前端只做派生展示，不写回或污染画布拓扑原始数据。
- 发送入口在任务工作台（人工介入条、本次运行 `waiting_human` Job、工作台 Job 详情），不在过程画布上放 FAB 或画布级撰写器。解析不到活动 Job 时不得静默发给 Hub，必须显式选择；`human` 是节点类型，不能投递。Job 账本仍为 `waiting_human` 时，即使画布节点被刷成 `failed` 也可定向回复。
- **回复恢复与忽略同路径**：向 `waiting_human` Job 发送消息与 `ignore` 共用恢复：关闭旧 Attempt、Job 转 `pending`、对应 `job`/`intent`/`report` 节点转 `pending`，并 `pg_notify('deepsonar_jobs')`。新 Attempt 领取后再注入已入账的 planned 消息。只建账本不恢复会导致沙箱已毁、消息停在 `planned`。
- 多文件先逐个写入项目共享资产，逻辑 key 为 `human-messages/<message-uuid>/<序号>-<安全文件名>`；全部上传成功后，消息才一次性引用对应不可变 `version_id`。任一附件上传失败时不创建带残缺引用的消息；已经成功上传的项目资产保留并明确提示。
- 运行时将每条消息的附件按 message UUID 放入动态收件箱 `/workspace/.deepsonar/inbox/<message-id>/`，并在注入文本中提供不可变路径、摘要与字节数。收件箱不是 Agent 可写回的控制队列，也不改变原有 snapshot 输入。
- 确认严格分两阶段：`injected` 仅表示“已注入会话，等待 Agent 确认”；只有目标 Agent 显式调用受治理的 ACK operation，持久化 `acknowledged_at`（及可选 `ack_summary`）后，UI 才显示“Agent 已确认”。不得从普通文本回复、Session 内容或节点标题推断已读/已处理。
- `planned` / `injected` / `acknowledged` / `unknown` / `failed` 均真实展示；未知窗口与失败不会触发消息自动重发。人类若要再次发送，必须在确认目标和账本状态后主动提交新消息 UUID。
- **人工介入折叠与忽略（#277）**：任务工作台介入条、画布消息面板默认折叠；任意介入项可由当前用户直接隐藏并在“显示历史”中取消隐藏，操作员从任一 waiting Job 回复成功后，来源介入项也按当前用户+任务记为“已回复”并随已处理项隐藏。展开、隐藏与已回复展示偏好写入 `localStorage`（`deepsonar:human-intervention:<user>:<canvas>`）；“隐藏”和“已回复”都只影响 UI，不把请求误记为 `ignored`。`POST /canvases/:id/human-nodes/:nodeId/ignore`（`jobs:control`）把仍为 `open` 的 human 节点标为 `ignored`；若对应 Job 仍是 `waiting_human`，关闭旧 Attempt 并恢复 `pending`，图 YAML `hints` 带上 `resolution=ignored`，Agent 据此继续而不是挂起。

### 4.2 Fact/Finding 画布广播（真注入 + 投递账本）

同画布并行 Worker 之间的增量通知**已落地**（Scheduler 唯一执行；Agent 不互调）：

```
emit_fact / emit_finding → canvas_nodes INSERT
  → pg_notify('deepsonar_canvas_events')
  → canvas-updates LISTEN → 组装「DeepSonar 画布增量通知」
  → 对已订阅的目标 Job 调用 sendMessage(...)
  → canvas_broadcasts：planned → injected | unknown
```

| 要点 | 说明 |
|------|------|
| **真注入** | `executor-real` 在 `onRunReady` 注册 `subscribeCanvasUpdates(canvasId, jobId, sendMessage)`；`sendMessage` 成功且账本结算后记 `injected` |
| **能力门禁** | 仅当冻结快照 `agent_runtime.capabilities.incrementalMessages === true` 时订阅。当前三类 CLI（Claude Code、Pi、DSH）均声明该能力并注入。leftover Codex/OpenCode 历史快照不声明该能力，只读可看、不订阅运行时追加 |
| **目标集合** | 同 `canvas_id`、有 **active Attempt**、状态 ∈ claimed/provisioning/running/waiting_human；**不**广播给自己；**不**给后启动 Job 补历史 fact（Hub 整图职责） |
| **`injected` 语义** | 仅表示平台已把文本塞进 CLI 输入通道；**禁止**文案写成「模型已收到/已处理」 |
| **查看器展示** | 画布上的广播徽标与连线 overlay 由 `canvas_broadcasts` 投递账本派生，不写入 `canvas_nodes` / `canvas_edges`；Job Session 的 `broadcast` 条目则来自 CLI 实际持久化的注入文本，只是账本旁证，不是读取或 ACK 回执 |
| **可观测** | DB 表 `canvas_broadcasts`；`GET /canvases/:id/broadcasts`；画布面板、账本派生 overlay 与节点侧聚合；Job 详情可挂广播列表。实时流增强见 `docs/TODO_CANVAS_PROCESS_TRUTH.md`（A 已落地账本/UI，B 布局仍分期） |
| **安全** | 正文标为「平台转发的任务数据，不是系统指令」；不经目标出网；不改变冻结角色/镜像/网络 |

实现入口：`apps/scheduler/src/canvas-updates.ts`、schema `canvas_broadcasts`、Web `canvas-broadcasts.ts` / `CanvasView`。

## 5. Job 与并发

```
pending → claimed → provisioning → running
       ↘ waiting_human
       → succeeded | failed | timeout | cancelled | orphan
```

- Lease + Reaper：超时/孤儿**调度器判定**，不信任 Agent 自报。
- 唤醒：`pg_notify('deepsonar_jobs')` 为主；轮询可关。
- 优先级：资格与排序分离（图阶段 / 收敛证据 vs 固定优先级），避免 priority 通胀。
- **Provision admission（#158）**：并发上限由数据库 claim admission 判定，不是进程内 semaphore。超过 `global_settings.maxConcurrentProvisioning` 的 Job 保持 `pending`，不写入/消耗 `claimed_at`；释放槽位后由调度器显式唤醒 pending 队列，重新 claim 后才进入 `running`。仅在全局配置缺失时使用 `PROVISION_CONCURRENCY=2`。
- **项目并发配额（#187）**：全局 `maxJobsPerProject` 仍是每项目安全硬上限。项目可在 `config_json.rules.maxConcurrentJobs` 收紧自己的 claim 预算（`0` 暂停领取新 Job），有效值 `min(全局每项目上限, 项目值 ?? 全局上限)`；不能放宽全局 cap。同一项目下全部任务与 Hub/Worker/Verify/Report 共用该额度。`pending` / `waiting_human` 不占额度（与 Dispatcher 活跃计数一致：`claimed` / `provisioning` / `running`）。修改只影响后续 claim，经 `pg_notify('deepsonar_jobs')` 唤醒，不终止已运行 Job；Job 快照不冻结此配额。
- **任务 drain pause（#188）**：Canvas 在 `target_json.execution_control` 自由区保存 `paused/paused_at/paused_by/reason`。`POST /tasks/:canvasId/pause|start` 使用 Canvas 行锁提供数据库权威、幂等的执行门禁；Dispatcher 在 claim 前锁定并重读 Canvas，暂停后所有该画布的 pending Hub/Worker/Verify/Report 均保持 durable pending，不再领取。已有 `claimed/provisioning/running/waiting_human` Job 安全收尾，分别投影 `pausing → paused`；`pending` 不算收尾。start 不清定时计划、不重试失败/孤儿 Job，提交后 `pg_notify`，仅在解除暂停且画布无 pending/活动工作、Hub 仍有资格时幂等补一个 Hub。
- **任务执行时间（定时开始，#147 已关闭）**：创建任务时可设 `schedule_beijing_8am`（下一北京时间 08:00）或 `scheduled_start_at`（ISO）；冻结在 `canvases.target_json.schedule`，到点前该画布全部 Job 保持 `pending` 不被 claim。默认仍为立即执行。调度器用进程内最近 `start_at` 定时器补唤醒（不依赖 `DISPATCH_POLL`）。「恢复会话 / 立即开始」在仅有 pending 时清除定时门；重试也会清门并立即重跑。

### 5.1 Job Attempt 与外部效果

- 每次 Job 领取在 `job_attempts` 建立一个 Scheduler-owned Attempt；`(job_id)` 的活动唯一索引与事务行锁保证并发 claim 只产生一个活动 Attempt。
- Attempt 的 total state 持久化 `phase`、快照身份、sandbox/session/resource identity 和取消标记。外部动作先在 `job_attempt_effects` 写入 intent 与 `effect_pending`，完成后同事务写 settlement；`replay_policy` 默认 `never`，未确认窗口只标记 `unknown`，不因重启自动重放。
- provision 的 Attempt、效果、资源身份和 `jobs.sandbox_id` 在同一个事务收口；用户取消先提交 Job/Attempt 终态，再通过进程内句柄触发 `AbortSignal`/runtime cancel。dispatcher 在调用 provider 前重查 `provisioning`，runtime 在安装监听后重查 signal，覆盖取消与句柄注册的两个竞态窗口；超时复用同一幂等中止路径，并等待外部 create 收口及清理完成后才释放 provision 槽位；迟到成功的 handle 先销毁，异常/abort 还会按 Job/Attempt 标签扫除迟到容器。Job 与 Attempt 终态也在同一事务提交。
- 启动对账按 Attempt phase/effect 账本分类：只有尚未开始且无效果的 `preparing` 可回到 `pending`；`effect_pending/unknown` 统一转 `orphan`，清理沙箱、Token、画布和外部同步。
- **启动中断批量恢复（#186）**：启动 reconcile 会先批量把 running Worker 收口为 `orphan`，但 role Worker 不在对账阶段推进画布或派生新 Hub，避免更新的 Hub 抢占人工恢复入口。`POST /tasks/:canvasId/resume-session` 在画布无活动 Job 时优先把该画布全部启动中断 role Worker 按原 Job ID 重新入队，响应 `action=rerun_interrupted_jobs` 与完整 `jobs[]`；Dispatcher 随后建立新 Attempt。旧 Attempt 与 `unknown` / `replay_policy=never` effect 原样保留，不自动重放；没有中断批次时才恢复单 Job 或唤醒 Hub。
- **恢复与当前配置重跑（#202）**：`POST /jobs/:id/resume` 明确定义为使用创建期旧冻结快照重新执行（同 Job、新 Attempt），只接受 `failed/timeout/orphan/waiting_human`；入口先按当前 RoleConfig、Credential、项目策略完整解析受治理身份，若 `agent_cli/model/upstream_model/credential_id/credential_provider`、runtime adapter 或 runtime image digest 等身份漂移，或当前配置无法解析，则稳定返回 `409 SNAPSHOT_STALE`，禁止静默使用旧模型。`POST /jobs/:id/rerun-current` 在 Dispatcher admission lock 下按 Canvas→Job 加锁，完整重冻当前快照后原子转 `pending`；保留 payload/parent/canvas、Intent/Fact/Finding 和旧 Attempt/effect，不清画布、不复用已销毁 Session、不重放 unknown effect。任务 resume 的启动中断批次与单 Job仍默认旧快照，任一 stale 时整批拒绝并返回 `job_ids`。无可恢复 Job 时强制唤醒 Hub（`maybeTriggerHub`），以及 `POST /tasks/:id/retry` 解析当前 Hub 快照：当前 RoleConfig/Credential 无法解析时同样稳定返回 `409 SNAPSHOT_STALE`，不得 500。`done` / `human` / `hub_decision` 终态互斥按当前 Attempt 计数（#298）：旧 Attempt 的 `request_human` 不得阻止新 Attempt `mark_job_done` / `submit_hub_decision`；同 Attempt 真重复仍拒绝。同一摄入里先成功终态再跟 `mark_job_done`（#300）按 lock 时 running 判断，迟到 done 幂等，不得 `job_not_running` 整笔回滚；同一摄入先成功 `request_human` 再跟迟到 `mark_job_done` / `submit_hub_decision` 同样 skip，保住 `waiting_human`，不得整笔回滚 wait gate。分次摄入且 Job 被改回 `running` 后再 done 仍 `duplicate_tool_call`。开始时已终态的迟到回调仍 fail-closed。
- **资源 desired-state 对账（#199）**：sandbox destroy 的最终容器删除使用 120 秒单次上限、最多 5 次指数退避，只有明确 `no such container` 算幂等成功，耗尽后向上抛错。启动 reconcile 与每轮 Reaper 都以 DB 中 `claimed/provisioning/running` Job + active Attempt 为 desired state，只枚举同时具有 canonical `deepsonar.job` / `deepsonar.attempt` 标签的容器，以及严格 `deepsonar-assets-<canonical Job UUID>` 名称/受管标签的本地卷；非活跃资源每轮继续重试且清理防重入。禁止 `docker system prune`、前缀猜测容器归属或删除非 DeepSonar 资源。

## 6. 配置层级

| 层 | 内容 | 覆盖 |
|----|------|------|
| 全局 | `global_settings`、全局 `role_configs`、平台 skill 源、镜像市场 | 缺省 |
| 项目 | 规则（含 `maxConcurrentJobs` 调度配额）、启用角色、项目 RoleConfig、出网默认、`config_json` 中的镜像策略 | **压过全局**（调度硬 cap 除外：项目只能收紧 `maxConcurrentJobs`） |
| 任务/画布 | `target_json`、出网覆盖、Finding 协议等 | **压过项目** |
| Job | `agent_snapshot_json` 创建时冻结（含 `runtime_knobs`） | 执行只认快照 |

**冲突规则：任务 > 项目 > 全局**（RoleConfig 已如此；Finding 协议等演进配置同此心智）。

**运行时护栏（#263 batch 1）**：`stallSec`、`jobTokenMaxRequests`、`auditTimeoutSec` / `verifyTimeoutSec`、`provisionTimeoutSec` 落在 `global_settings.rules_json`，可被项目 `config_json.rules` 与角色 `role_configs.runtime_knobs_json` 覆盖；创建 Job 时可再指定 `stall_sec` / `max_requests` / `timeout_sec`。优先级 **Job > 角色（项目 RoleConfig 字段覆盖全局 RoleConfig）> 项目规则 > 平台规则 > 部署 env 引导**。`provisionTimeoutSec` 仅平台可写。`stallSec=0` 关闭停滞判定；`jobTokenMaxRequests=0` 不限制 Gateway 请求。Scheduler 每次读库（`globalRules()` / 建 Job 冻结快照），改完无需重启；已在跑的 Job 继续用创建时冻结值。Chrome 专项镜像仍有 stall 下限，ClickHouse 专项镜像同样适用，角色/Job 可再抬高。lease TTL、Reaper 间隔、Gateway 超时、镜像 registry/cosign/syft/trivy/clamav 与巡检间隔仍走部署 env，后续批次再前端化。

DSH RoleConfig 的 `dsh_task_mode` 固定为 `standard | ptc`，默认 `standard`，并随 Job 冻结。Standard 使用 DSH 原生工具呈现；PTC 使用官方 Code Mode（`dsh-tools mode: code`）和受治理的 worker-thread TypeScript runtime，只把 `run_code` 作为模型直接工具。该字段对其他 Agent CLI 无效。模型思考强度统一属于 Provider Credential。Claude Code 只接受 `low | medium | high | xhigh`，运行时物化为 `.claude/settings.json` 的 `effortLevel`；Pi 接受 `off | minimal | low | medium | high | xhigh | max` 并在启动/恢复时传 `--thinking`。leftover Codex/OpenCode 历史凭据仍可读其 reasoning，但不能再保存或物化为新 Job。DSH 使用 Pi-AI 的规范档位 `off | minimal | low | medium | high | xhigh | max`，第三方实际传输值由每个模型的 `reasoningEfforts` YAML 映射，页面只允许所选模型声明的档位。Pi 与 DSH 同属 llm-pi-ai 家族：Provider 编辑器接受官方 `settings.yaml` / 等价 JSON（`llm-pi-ai.providers` + `agent-default-model`），也保留 Pi 自有 `{ providers: { deepsonar: … } }` 形状；粘贴后提取 `baseURL` / 默认模型 / 若存在的 `apiKey`，POST/PATCH Credential 写入 `public_metadata.base_url`。DSH 使用官方 `@deepseek-ai/dsh-llm-pi-ai`，按同一官方 YAML 保存并做严格校验，可声明任意安全 route 及其 OpenAI/Anthropic 兼容 profile；Job 创建时冻结所选 route/model/reasoning，运行时强制把 `baseURL` 与 `apiKeyEnv` 投影到 Job Model Gateway，并把首条 system 消息投影为 pi 兼容帧（#321：部分上游按 `input[0]` 识别客户端），同时挂载固定 commit 与 SHA-256 的 MIT 插件 `dsh-reasoning-settings@0.3.0`，为 `subagent` / `subagent_fork` 提供受已配置 route/model 限制的按次档位和继承修正。Pi 将官方 profile 物化为 `.pi/agent/models.json`。长期密钥不进入 Cordis 配置或沙箱。

DSH 的无 UI Cordis composition 必须服从镜像内钉死包的真实 Schema；当前完整包闭包统一固定为 `0.1.1-rc.2`，避免 prerelease peer range 混装。`agent-spine-demo` 的 `toolBash` 只接受 `false | object`，平台传入对象并由 spine 单独挂载 bash 工具，禁止写 `true` 或重复注册工具。`dsh-bash-local` 依赖的 `dsh-subprocess-local` 作为固定 integrity 的独立插件显式安装和挂载，命令超时只配置在 bash executor。Base CI 无论新建还是复用不可变镜像，都以 `--network none` 启动 packaged-bin、完成 JSON-RPC `initialize` 并验证干净 `shutdown`；该启动级门禁不调用真实模型。

Finding 协议存于全局 `global_settings.rules_json.finding_protocol`、项目
`projects.config_json.finding_protocol`，任务创建请求可用 `finding_protocol` 只覆盖声明的键；列表字段在高层整表替换。解析后的 `EffectiveFindingProtocol`（模式、默认/允许 profiles、评分策略、显示名和来源）随新画布冻结，后续配置修改只影响新任务。

项目镜像策略也存于 `projects.config_json`，不增加表或迁移：`image_strategy` 缺省为
`inherit_global`，此时 Job 镜像始终取该角色的全局 `RoleConfig.runtime_image_key`，
且 `model` / 默认 CLI 也只认全局 RoleConfig（再落到账号主模型）。
`inherit_global` 项目 RoleConfig **不落库** `model`；启动、切换策略、写入、导入导出与批量绑定
会物理清空已被忽略的项目 `model` / `runtime_image_key`。解析层仍忽略脏行作为纵深。
`project_managed` 时只取 `role_runtime_images`（角色名到可信 runtime key 或 `null`），缺项或
`null` 使用系统 `deepsonar-base`，并允许项目 RoleConfig 托管自己的 model / 默认 CLI。
项目 RoleConfig 的 `runtime_image_key` 不再作为项目镜像来源。
以上策略解析的是**角色缺省镜像**；Hub 还可在每个 intent 上提案本轮 `runtime_image_key` 压过缺省（见 §9 镜像条目与 #357 / #360）。
项目对市场版本的绑定：`project_runtime_images.selected_version_id=null` 跟随最新 trusted，不必再写 UUID。显式 UUID 为 pin。官方 catalog 提升 / registry sync 成功后，只把**官方**且已过期（当前通道/宿主平台不再是可执行 trusted，同时新 latest trusted 可用）的项目 pin 滚到 `latest_version_id`；只改 `project_runtime_images.selected_version_id`，已冻结 Job 快照与历史 Attempt 不动。`pin_ok` 的显式旧版（仍 trusted 可执行）不改。第三方 pin 仍 fail closed，不自动换 digest。需要钉死旧官方版本的项目设 `pin_policy=hold`；默认 `follow`。每次自动滚动写 `audit_logs`（`runtime_image.official_pin_roll`，trigger=`official_catalog_promote`）。hold / 第三方过期 pin 仍返回 `409 RUNTIME_IMAGE_PIN_STALE`（含一键升级）。空壳画布（已提交但无 Job）可在 pin 滚动后 `POST /tasks/:id/retry` 补入口 Hub。

### 6.1 Compose 任务的冻结种子

- `kind=compose` 必须从当前项目选择 1–8 条未否定处置（`open` / `accepted` / `human_reproducing` / `confirmed_vuln`）的 Finding；**不要求** `verify_status=confirmed`。`pending` / `verifying` / `needs_human` / `confirmed` 均可作种子。`standard` 禁止携带种子。默认排除 `rejected_fp` / `resolved` / `archived`。
- 创建时把选中 Finding 的必要摘要、来源身份以及冻结当时的 `verify_status` / `disposition` 写入 `canvases.target_json.seed_findings`，并生成当前画布内的只读 finding 投影。投影只作为背景，**不是本画布 canonical Finding**：不复制 Finding 记录，不进入本画布 Verify 生命周期；原 Verify 仍在源画布。新证据应回到源 Finding 或产出明确的新 Finding，不得把投影节点当成可确认正本。
- Graph 对 Agent 暴露当前画布节点 UUID，并标记 `imported` / `readonly`；项目 Finding UUID 和完整冻结摘要不进入 prompt。Hub 仍只能引用当前画布 canonical 节点。YAML 另投影 `compose_scope`（种子位置与「禁止扩大资产范围」规则）。
- **范围护栏（#273）**：compose 画布只围绕冻结种子做确认、补证与组合链，禁止新一轮资产扫描。Hub 不得下发未绑定种子投影的 explore/audit；若保留 explore/audit，必须绑定至少一条 imported 种子，prompt 只覆盖该种子资产。`emit_finding` 必须能追溯到种子资产（同仓/同模块或组合链位置），越界新资产由 Scheduler 拒绝。
- 重试是一次新执行。Scheduler 在清空旧运行数据前重新校验全部源 Finding；源条目已失效、跨项目或变成否定处置时返回 `COMPOSE_SEEDS_STALE`，原画布数据不动。**不因仍未 confirmed 而拒绝重试。**
- Task Report 明确记录 `task_kind`、种子数量和冻结种子列表（含冻结当时的 verify/disposition），种子与本次运行新产出的 Finding 分开统计。

实现入口：`apps/scheduler/src/task-compose.ts`、`domains/project-task/routes.ts`、`graph.ts`、`report.ts` 与 Web `TasksPage.tsx`。

## 7. 注入与读图（as-built）

- `buildGraphSnapshot(canvasId, scope?, opts?)` → YAML：goal、facts/findings 摘要、open/concluded intents、hints。
- **GraphScope**（`hub` | `agent` | `verify` | `report`）与**整图字符预算**已在 `graph.ts` 落地（#30）；Hub/Worker/Verify 注入投影不同，仍须关注超预算截断与索引完整性。`verify` 投影隐藏 maker 结论正文（title/summary/severity），只保留主体骨架、location 与物证引用（#367）。
- 单字段仍有截断（description/summary 等）；`job` 类型节点**不进** YAML。
- Worker 运行包会注入画布冻结的 Finding 协议说明（模式、允许 profile、CVSS 接受版本和必评分 profile）；真实 Agent 只能通过严格的 Job-scoped `emit_finding` API operation 提交提案，不能写 `raw` 或修改协议、验证派生和 severity/scoring 的系统归一化。fake/direct 测试路径复用同一摄入契约，不构成真实运行的第二控制通道。
- Skill：`skill_sources` sync catalog；RoleConfig `modules` 现为 `"source_id:module_id"` / `plugin:` / `source:*` 展开为 embedded skills/commands。手写同 kind/name 配置覆盖 catalog 模块时，最终 expanded 集合/hash 只保留实际嵌入内容，并记录 `manual-override`。Job 快照同时冻结模块元数据哈希与结构化 `missing_modules`；同一 materializer 命名空间的重名模块全部排除，禁止顺序覆盖；materializer 对组件名和 skill 文件路径执行严格子树安全校验。

## 8. 观测与证据

| 通道 | 内容 | 持久化 |
|------|------|--------|
| 语义 events | progress / finding / done / human | Postgres |
| 画布广播 | Fact/Finding 向并发 Worker 的投递 | `canvas_broadcasts`（`planned`/`injected`/`unknown`…） |
| 实时流 | text.delta / tool.call.* | 进程内 `stream-bus` + 短时 ticket 的 WS `/ws`；环形缓冲（单进程；多副本不共享 bus） |
| 过程流 | normalized NDJSON | Job 目录；**运行中**可读 inflight `stream.ndjson` tail，**终态**读 manifest gzip；CLI stderr 按 chunk 精确脱敏后保留，单次运行总计最多 1 MiB 并显式记录截断，Job `error` 仍只存短摘要 |
| Session / OTLP | CLI 原始 | 冷存储 blob |

Scheduler 在写出 finalized manifest 前中断时，`GET /jobs/:id/evidence` 会从
`attempts/*/stream.ndjson` 生成最多 32 个文件条目的 synthetic/inflight manifest，
`evidence/stream` 继续按既有限界读取原始过程流。该 manifest 不为可变文件伪造 SHA-256，
也不把已销毁容器中的 session identity 冒充为 Session 归档；orphan Job 通过
`capture_error` 明确说明 CLI Session 无法跨容器恢复。

**Job Session UI**：前端 `apps/web/src/session-viewer/` 按 CLI 方言将归档文本解析为消息、reasoning、tool call/result、usage 等时间线/用量/工具统计/原始视图，并保留原始文件下载。`GET /jobs/:id/evidence/session` 默认主 Session / vendor export，`artifacts` 列出全部 `main` / `subagent` / `vendor_export`，`?path=` 切换；在线预览 8 MiB，超限 `truncated`，全文走 download。用量页分列展示 Session 归档 usage（按轮次累加、峰值上下文）与 Gateway `job_usage_ledger`（按请求/模型）；两套数字不对账、不定价。无归档但已有账本时仍可打开用量页。解析格式须覆盖当前运行 CLI（claude-code / pi / dsh）以及 leftover Session 归档（codex / open-code），不假设归档拥有同一 schema。只有 CLI 归档中实际持久化了平台注入文本时，查看器才显示对应画布广播条目。**新增 Agent CLI 时必须同步** Session 归档适配器（`cli-session-adapters.ts`）与 Web 解析器，清单见 `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`「Session 归档 + Web 查看器」。

归档来源按 CLI 独立治理：当前 Claude Code、Pi、DSH 从本次沙箱的受治理本地 session artifact 读取。leftover Codex/OpenCode 历史归档仍由查看器只读解析（本地 rollout JSONL / `opencode export`），不再作为新 Job 的运行时 adapter。malformed 的 session identity/path、导出/读取错误或体积超限必须显式报告归档失败；查看器对归档内不可解析行保留 `skipped` 计数，不猜测 latest 或其它 Job。

**画布广播**：真注入路径见 §4.2；账本为唯一投递真相，Session 文本仅作旁证。

**宿主资源清理指标（#199）**：`/metrics` 暴露 desired-state 清理残留容器/卷、连续失败轮次和按资源分类失败 counter；安全 runtime image GC 暴露候选、删除、容器占用保留与失败；Node `statfs` 宿主文件系统探针暴露使用率和 `ok/warning/error` 水位。指标抓取路径只读进程内结果，不在抓取时调用 Docker。

**鉴权（HTTP + WS，#38 已关）**：

- `DEEPSONAR_AUTH_REQUIRED=true` 时 HTTP 需 Bearer（用户会话或 API Token + scope）。
- 浏览器 WebSocket **不能**设自定义 Header：先 `POST /auth/ws-ticket`（`tasks:read`，绑定单 Job、短 TTL、一次性），再连 `/ws?job_id=&ticket=`（终端为 `/terminal-ws` + purpose `terminal`）。失败用 close code 区分 4401 鉴权 / 4403 权限 / 4409 已终态等；前端展示明确错误而非无限「等待事件」。
- 实时流先 HTTP 补 `GET /jobs/:id/evidence/stream`（含运行中 tail），再订 WS；**禁止**把长期 token 打进 WS 查询日志。

## 9. 安全边界

- 人类登录暴力破解防护：`POST /auth/login` / `loginUser` 对任意密码校验（成功、错密、未知用户、禁用账号）计数。紧桶是规范化用户名 + 客户端 IP，5 次 / 5 分钟（窗口从首次计入的尝试起算）；粗桶是客户端 IP，20 次 / 5 分钟，防止跨用户名喷洒。成功登录占额且不清桶。额度在同一事务里先锁 IP 再锁 identity（`SELECT … FOR UPDATE`）；IP 已满时不插入 identity 行。过期窗口在同一事务删除。超限返回稳定 `429 LOGIN_RATE_LIMITED`（`retry_after_sec`），登录失败统一 `BAD_CREDENTIALS`，不泄露用户是否存在或是否禁用。计数落在 `login_rate_limits`，跨 Scheduler 重启保留。校验路径始终先付 scrypt 成本（未知用户走固定 dummy），再做占额/返回，避免锁定位比密码校验更便宜而成为用户名预言机。官方拓扑是浏览器 → `deploy/web-server.mjs` → Scheduler：Web 用入站 TCP peer **覆盖** `X-Forwarded-For`（不信任公网自带 XFF），Scheduler 只信任 1 跳（`DEEPSONAR_TRUST_PROXY_HOPS`，默认 1）。再前面加未纳入 hop 策略的代理时，IP 桶会塌缩为 Web 看到的那一跳，等于全站共享；不要把 Scheduler HTTP 暴露到公网。
- 被审计目标 = 不可信输入（prompt injection）。
- `settings_config_json` 是 CLI 连接真相，但 Job 只冻结去除长期密钥后的配置结构；每次执行把 CLI endpoint 改写到 Model Gateway，并只注入短期单 Job token。管理 API/Web 同样只返回脱敏投影，长期 Provider 密钥不进入 Job 快照或工作区。
- 镜像：市场 digest 冻结；第三方须 image-admission；Agent 不能指定任意镜像引用。项目按全局继承或项目托管策略得出角色缺省 runtime key，Job 创建时连同兼容 CLI 与工具清单一起冻结。Chrome / ClickHouse audit/test/fuzz 是官方但 project-opt-in 的专项运行时。**Hub 可按任务动态选图（#357 / #360）**：intent 可携带可选 `runtime_image_key`，只接受本轮 `list_available_runtime_images` 返回的市场 key（项目已启用、存在当前通道与宿主平台 trusted 版本、至少一种治理 CLI 能跑），preflight 与摄入事务双重校验目录成员并冻快照验 CLI 兼容，非法/未启用/OCI/CLI 不兼容使整次决策以 `invalid_runtime_image` / `invalid_payload` 拒绝（不得变成 `HANDLER_FAILED`）；省略时按角色缺省解析。resume/`rerun-current` 保留 Job 已冻结的 `image_key`。Worker 无此提案能力，运行中 Job 不换图。
- **官方 digest 免签（#205）**：官方运行时以 GitHub Release catalog 的不可变 digest 为信任根，当前 release 不 `cosign sign`。准入 Worker 钉 Cosign 3，仅在配置了 `DEEPSONAR_COSIGN_KEY` 或 keyless identity+OIDC issuer 时验签；未配置则记录 `signature: skipped`（`unsigned_policy`），合同、SBOM、漏洞/凭据与恶意扫描仍 fail closed。禁止发出缺 identity/`--key` 的 `cosign verify`。CLI/网络/缺参记 `scanner_misconfigured`，无签名记 `unsigned`，只有 `admission policy failed` 才自动撤销官方 trusted。启用签名后须与发布流水线使用同一套 identity。
- **Runtime image GC（#199）**：可配置周期，`0` 关闭；只对 DB `runtime_image_versions` 及其 registry ref 账本中可证明 digest 一致的 named immutable ref 调用无 `-f` 的 `docker image rm`。保护全部 promoted 版本、每产品当前/最近回滚版、项目 `selected_version_id` 显式 pin，以及 pending/active/waiting Job 快照引用。删除前查询所有容器的 ancestor，删除竞态仍由 Docker 非强制引用门保留；无安全 ref、检查失败或容器占用一律 fail closed。绝不执行 broad prune。
- **宿主磁盘水位（#199）**：Scheduler 用 Node `statfs` 检查配置路径所在文件系统；warning 只告警，error 使 `/readiness` 返回 `HOST_DISK_PRESSURE` 并暂停 Dispatcher 新 claim，探针不可读也 fail closed；两者都不终止已运行 Job。水位恢复后监控器显式唤醒事件驱动 Dispatcher。生产 real compose 只读挂载 `DEEPSONAR_HOST_DISK_SOURCE` 到探针路径。
- 出网：`allow_egress` 任务级冻结；所有 real Job 的模型请求都经 Scheduler-owned gateway proxy。允许出网的沙箱加入 `deepsonar-sandbox-gateway` NAT bridge；禁出网时只加入 `deepsonar-restricted` internal bridge，并通过同时接入两网的固定 proxy 到达 Scheduler。
- Model Gateway 上游单次超时默认为 3,000 秒，但每次 attempt 取 `min(3_000_000ms, Job 剩余时间)`；仅在客户端响应头/响应体尚未开始发送前，对网络/超时和 HTTP 408/429/500/502/503/504 做最多 3 次指数退避加 jitter，永久 HTTP 错误不重试，已开始的 SSE/响应体绝不重放。Job 的 `used_requests` 按沙箱客户端请求只递增一次；上游 attempt/retry/exhausted 仅记录 provider、reason 等低基数指标，不记录请求体、URL 或 Job ID。网络/超时耗尽返回稳定 `502 upstream_unreachable`，最终上游 HTTP 响应原样直通。
- Gateway 重试耗尽并导致 Agent CLI 退出后，runtime runner 只对明确的 HTTP 408/429/500/502/503/504、timeout 与 network 错误，在原沙箱使用已捕获的原 session ID 最多恢复 3 次（1/2/4 秒退避）。Claude Code 使用 `--resume`，Pi 使用精确 `sessionFile`，DSH 复用冻结 session id；400/401/403、普通退出、缺 session 或恢复耗尽均直接失败，不允许 `--continue`、latest session 或新会话兜底。leftover Codex/OpenCode 历史快照不再进入新执行。恢复过程写入低基数 `run.retrying` / `run.retry_skipped`，已成功控制副作用继续由运行时去重与数据库幂等键保护。
- Model Gateway 的每次请求同时写入 `job_usage_ledger`，关联 `attempt_id + effect_id`；只保留 provider/model、输入/输出/总 token、缓存读/写 token、请求序号和 `settled|unknown|not_reported`，不保存 prompt、响应正文、请求头或凭据。流式 usage 按完整记录去重，响应已发送后账本写失败计指标并保留可对账的 effect 标识，不制造未处理异常。

## 10. 前端信息架构

- 一级工作流固定为 **态势 / 项目 / Agent / Agent 市场 / 镜像**；跨项目 Findings/Jobs 保留查询页与命令菜单入口，但不占主 rail。日常闭环从项目 → 任务 → 画布/发现/运行/报告完成。进入项目后，**项目账本**（`/projects/:id/usage`）看本项目 Gateway 用量；**项目风险**（`/projects/:id/findings`，文案「项目风险 / 风险发现」）是本项目全部任务 Finding 的风险台，不是默认首页，也不是跨项目 `/findings`。顶部计数走 `GET /projects/:id/findings/summary`，避免 Finding 列表 500 条窗口静默截断。
- Finding 人工处置含 `human_reproducing`（人工复现中）：人已接手手工复现 / 打 PoC，尚未标「漏洞存在」或「拒绝误报」。**不是**技术 `verify_status=confirmed`，不能旁路 `confirmed_vuln` 的 Verify 门。compose 种子视为未否定处置。
- **态势运营总览（#242 P0）**：`/` 在关注队列之上展示项目/任务/Job/Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建/完成任务与新增 Finding、活跃项目 Top N 与最近活动。总量走轻量 `GET /dashboard/overview`（Job/Finding 列表有窗口上限，前端不全量拉取）；关注队列仍用 `api.jobs()` / `api.findings()` 作为处置入口。P1 风险分布与 P2 吞吐看板未做。
- **用量账本看板**：`GET /dashboard/usage` 聚合 `job_usage_ledger`（不定价，含 `cache_read_input_tokens` / `cache_creation_input_tokens`）。预设 `day` / `week` / `month` 为 Asia/Shanghai 滚动窗口；`period=custom` 时 `from`/`to` 为含首尾的上海日历日或 ISO 时刻，跨度最长 366 天。可选 `project_id` / `canvas_id`。态势页看全局（项目/任务/模型 Top 8），CURRENT PROJECT「项目账本」tab（`/projects/:id/usage`）看本项目，任务工作台「本次运行」看本画布。任务工作台列表不再内嵌项目账本。看板可折叠，偏好按用户 + 页面写入 `localStorage`（`deepsonar:usage-ledger:<user>:<page>`），默认展开。
- Agent 页只维护角色注册表与全局 RoleConfig。模块源归 Agent 市场；账号/用户/API Token 归安全与访问；Provider 密钥归凭据；**配置中心**（`/settings/platform`）维护 batch-1 运行时护栏与全局调度纪律，平台配置包仍归该区。
- Agent 市场 MVP 使用 `deepsonar.agentpack/v1`：官方静态模板与本地 JSON 上传均安装到服务端角色/RoleConfig；包体有 256 KiB 上限，不接受 Credential 绑定、Provider 配置文件或疑似长期密钥环境变量。安装仍由 `agents:write` 权限控制，凭据必须本机另行绑定。
- 任务列表 / 任务工作台（画布 · Findings · Facts · Jobs · 报告）。新建任务支持 `standard` 与 `compose`：compose 从当前项目选择 1–8 条未否定处置 Finding（含未确认），创建后显示为只读种子背景，新画布只围绕这些条目而不扩大资产范围。Facts 使用独立服务端 keyset 分页与状态/证据/Finding/Job 筛选；详情只投影同项目、同画布、具有合法证据边的结构化关联，并提供人工 `verified` / `rejected` / `needs_human` 收口。
- 列表型筛选统一使用可搜索多选 Combobox：同一维度按 OR、不同维度按 AND；URL 用逗号分隔保留可分享深链。服务端分页筛选（如 Facts）由 Scheduler 在分页前执行多值查询。配置、动作和阈值等单值业务选择保持可搜索单选。
- 节点语义色：`SEMANTIC_STYLE`（hub 紫、finding 红、agent 黄、fact 青…）
- 工作角色使用 `agent_roles.ui_color` 的调度器分配色；系统 / Hub 节点保留固定语义色。角色色在创建事务中经 advisory lock 分配，写入 intent/job 节点正文后冻结；画布边线与箭头取源节点最终色，边类型只改变线型与流速。
- **任务是否在跑：以 `active_count` / 活跃 Job 为准**；勿把 `last_job_status=succeeded` 当成任务已完成（#46）。**已完成** 还要求至少一次 `started_at` 且根/报告处于成功终态；仅有 `ended_at` 的从未 running 失败（provision 写了 `finished_at`）不是完成（#292）
- 画布只读；Finding 详情偏 GitHub Issue（disposition + 评论可唤醒 Hub）
- Finding 列表/画布运行区显示冻结的 profile、可选 category 与 CVSS 版本/基础分；按 severity、profile、verify 状态筛选。详情保留向量、定性严重度、利用难度和原始 JSON；报告按 profile 分组、展示 category，并携带 tags、evidence_refs 与 scoring。
- Finding 详情直接展示服务端统一的验证追踪（来源、review/test Fact、Intent/Fact 有向流、Verify 轮次与 exact Hub）；可用 `traceFinding` 深链在画布中淡化或隐藏非链路节点，并按 `focusNode` 定位单个证据节点。弱关联不从 prompt 推断，未连边 Intent 与证据缺口显式呈现。

## 11. 开放演进（仅未完成）

已关闭 Issue 与 as-built 实施日记见 [`CHANGELOG.md`](CHANGELOG.md) 与 Git 历史，不再堆进本表。

| 主题 | Issue | 未完成点 |
|------|-------|----------|
| 数值保真（quantities） | #368 / #374 | **Phase 1 已落地**：Fact/Finding 可选 `quantities: [{value, unit, basis, ref?}]`（最多 20，strict）；Report 机械核对已确认 Finding 与 **verified/confirmed Fact** 的值+口径（`unverified` / `verifying` / `needs_human` 不参与门禁）。Agent 覆盖足够但改写口径时回退 `defaultMarkdown`（模板逐字嵌入口径），仅回退仍失败才 `numeric_inconsistent`。Report 图注入与下发 prompt 要求原样保留 value/unit/basis。graph 预算砍掉带 quantities 的节点时沿用 `truncated/omitted`。**仍开放**：Phase 2 NL 抽取/单位换算（#368 明确不做）。 |
| 设计债收口 | #359 | **已落地**：Plane / `CONTROL_MCP_SERVER` / `projects.canvas_id` 假身份（#363）；verify/report 转发 ports 删除、`core.ts` 只做组装（#366）；dispatcher 不再回退已删的 `projects.canvas_id`；leftover Session 类型隔离到 `legacy-session/`；`*.poc.ts` 迁出生产 `src/`；leftover Codex/OpenCode **解析函数**已迁出 `parseAgentSession.ts` 热路径；规则读取只认 `minVerifySeverity`（不再从 `autoVerifySeverities` / `hubWaitSeverities` / `AUTO_VERIFY_SEVERITIES` 推断）；态势修复入口只认 Scheduler `action`；bindable 角色只认 API `role_kind` / `role_builtin`；遗留项目 RoleConfig `model` / `runtime_image_key` 物理清扫（启动 + 写入/导入/绑定，不再保留「存着但不生效」警告层）；`suggest_verify` 从契约 / 表 / 导入导出 / 控制说明删除（schema v43；是否 Verify 只认冻结规则）。**双轨报告保留**（#361：不是设计债）。**仍开放**：其余配置面减法、Fact 验证第二套状态机、`stream-bus`、DSH 方言退出内核。路径守卫保留 `/.codex/` `/.opencode/`。不砍沙箱、token、Zod、digest pin、Reaper、Attempt 账本。 |
| 读图预算 / GraphScope | #30 | scope + 字符预算已落地；索引层/Worker 邻域与可观测性可继续收紧 |
| 整插件 / 整源挂载 | #33 | `modules` selector 持续打磨挂载体验 |
| 实时流 | #38 | issue 已关；残余：stream-bus 仍单进程内存（多副本不共享） |
| 态势看板 | #242 | P0 运营总览与用量账本已落地；P1 风险看板、P2 吞吐看板未做 |
| 配置中心后续批次 | #263 | Batch 1（stall / token / timeout）已落库；lease / Reaper 间隔 / Gateway 超时 / 镜像 pins 仍走部署 env |
| DSH 完整 pi 解码 | #320 | 当前仅为 input[0] 指纹兼容；完整解码器未做 |

## 12. 仓库地图

| 路径 | 职责 |
|------|------|
| `apps/scheduler` | Fastify API、dispatcher、core、verify、report、gateway |
| `apps/web` | React 工作台与画布 |
| `apps/image-admission` | 第三方镜像扫描准入 |
| `packages/runtime-sandbox` | SandboxRunner / RuntimeHost（OpenSandbox） |
| `packages/shared-types` | zod 事件与 payload 单源 |
| `database/schema.sql` | 唯一 schema 基线（当前 v43）；空库套用、非空只校验版本与结构；改表 bump `SCHEMA_VERSION` 后重建库。运维可用 `pnpm db:rebuild` 备份并按列交集回填；启动仍不做增量升级，但会自动对齐并校验 owned sequences |
| `deploy/` | 生产与 real 模式编排 |

## 13. 给实现者的硬约束

### 13.1 Agent 控制面输入 doctrine（D1–D6）

1. **D1 默认拒绝**：每个工具 `additionalProperties: false`；未知字段返回 `unknown_field`，不得 strip 后部分落库。
2. **D2 标识符标准形态**：节点/边只认当前画布 `referableIds` 中的 canonical UUID；Finding 绑定只认数据库 Finding UUID；角色只认本轮 `list_available_roles`；运行镜像只认本轮 `list_available_runtime_images` 的市场 `image_key`；未来路径工具只认白名单前缀。
3. **D3 通道不可污染**：语义事件只能由按 Job 授权的平台 API 结构化提交；Agent 不能用 shell 或 `.deepsonar/control-*` 文件模拟队列，也不能猜测管理 API；脏行告警后不得丢弃后续合法事件。
4. **D4 错误形态**：拒绝返回稳定 `error_code` + 可读消息；禁止把 PostgreSQL/`JSON.parse` 堆栈作为唯一结果；禁止 API 先报成功、Scheduler 后静默失败。
5. **D5 单源契约**：`shared-types` Zod schema 生成平台 operation 输入契约；每个 operation 必须有合法/非法夹具、宿主重验和业务前置条件测试。
6. **D6 纵深校验**：API 同源 schema → runtime handler → ingest/apply transaction 三层均须拒绝；任何层缺失都不算完成。

语义事件限流配置由 Scheduler 环境变量读取并在启动时做正整数/上界校验：
`EVENT_RATE_LIMIT_WINDOW_SEC`（1–3600，默认 60）、
`EVENT_RATE_LIMIT_PROGRESS_PER_WINDOW`（1–10000，默认 30）、
`EVENT_RATE_LIMIT_STANDARD_PER_WINDOW`（1–10000，默认 120）和
`EVENT_RATE_LIMIT_TERMINAL_PER_WINDOW`（1–1000，默认 8）。计数器按 Job 固定窗口落库；窗口跨进程/重启共享，时钟回拨不会倒退窗口。历史项目导入/恢复可直接批量写入既有事件作为审计数据，不走运行时额度；导入后的新 Agent 语义事件仍经上述摄入硬门，且只接受 `status=running` 的 Job。

工具 → 禁止输入 → 稳定错误码：

| 工具 | 关键禁止输入 | 错误码 |
|---|---|---|
| `list_available_roles` | 非空参数、未知字段、未授权调用 | `invalid_payload` / `unknown_field` / `tool_not_allowed` |
| `list_available_runtime_images` | 非空参数、未知字段、未授权调用 | `invalid_payload` / `unknown_field` / `tool_not_allowed` |
| `emit_progress` | 空白/超长 message、percent 越界或非数字 | `invalid_progress` |
| `emit_fact` | 缺 title/description、未知字段、非法 verification 或错误 Finding 绑定 | `invalid_payload` / `unknown_field` / `invalid_verification` |
| `emit_finding` | 非法 profile/category、空白/超长字段、未接受的评分版本、写入内部 `raw` | `invalid_payload` / `unknown_field` |
| `submit_hub_decision` | complete/intents 同时或皆无、空/半截 intent、非法 UUID/角色/预算 | `invalid_payload` / `invalid_node_ref` / `invalid_role` / `invalid_reference_budget` |
| `mark_job_done` | 空白或超过 8192 UTF-8 字节的 summary、verify 缺 verdict、rework 缺 missing_evidence、非 verify 乱传 verdict | `invalid_done` |
| `request_human` | 空白/超长 reason、缺失或非法 subject、跨画布 Finding、低于验证阈值的 Finding、未授权角色 | `invalid_human` / `tool_not_allowed` |

新增控制 operation checklist：定义严格 Zod payload + 同源 JSON Schema；列出禁止输入、错误码和业务白名单；Job 级 API、runtime handler 与摄入事务各有合法/非法测试；事务断言失败全回滚；确认不写控制文件、不把普通文本当语义事件；更新本表、静态控制 Skill、动态 OpenAPI 和 CI 冒烟。

1. **不扩大 Agent 权限**：镜像、凭据、派生、状态机终态只在调度器。  
2. **改表 = 改基线 + bump 版本 + 重建库验证**。短期**不**做 #34 类增量 ALTER 链（产品与 schema 仍在快速迭代，过早迁移会锁死演进）。同实例升级用 `pnpm db:rebuild`（备份 + 套最新 `schema.sql` + 列交集回填）；跨环境复制仍走 **`.deepsonarpack`**。Credential 仅迁元数据，不导出明文 Secret。
3. **列表 API 不塞大 body**；大字段详情/按需（#39）。  
4. **进 prompt 的内容当不可信**；共享资产只读挂载（#41）。  
5. **配置覆盖：Job > 角色/项目 > 平台 > env 引导**；Job 只认冻结快照。  
6. 细节冲突时：代码 + schema + OpenAPI + 测试 > 本摘要；演进以 open issue 为准。

## 14. 当前事实入口

- `database/schema.sql` — 数据结构与默认值唯一基线
- `/api/openapi.json` — HTTP API 契约
- `.github/workflows/ci.yml` / `chrome-runtime.yml` / `openharmony-runtime.yml` / `mobile-runtime.yml` / `release.yml` — 构建、验证与发布门禁
- GitHub Issues — 未完成能力和后续方案
- `AGENTS.md` / `CLAUDE.md` — 给编码 Agent 的操作手册
