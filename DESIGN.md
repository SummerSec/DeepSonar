# DeepSonar Design

> 当前产品与系统设计摘要（as-built + 已共识演进方向）。  
> 本文件给 Agent / 新人**先读**；细节冲突时以代码、`database/schema.sql`、OpenAPI 与测试为准。
> 日期：2026-08 · 与代码主路径对齐（Plane 可选、本地任务为主）。
> **专题文档索引与 as-built 状态表**：[`docs/README.md`](docs/README.md)（历史方案稿勿当未完成清单）。

## 1. 一句话

**DeepSonar（深流循迹）**：以本地库为唯一管理真相，以任务画布为过程真相，以一次性沙箱为执行真相；多角色 Agent 只提案，调度器唯一落地副作用，通过 fact–intent 二分图与 Hub 循环把探索 → 验证 → 报告收敛。

## 2. 四层真相

| 层 | 真相 | 职责 | 不做 |
|----|------|------|------|
| **本地库 / Web** | 管理真相 | 项目、任务（画布）、角色、凭据、规则、镜像准入 | 不在 Agent 里改基建 |
| **Canvas** | 过程真相 | fact / intent / finding / job 节点与边；布局由服务端算 | Agent 不提案坐标 |
| **Sandbox** | 执行真相 | 每 Job 全新 `/workspace`；独立可写 `HOME`；CLI + Job 级控制 API | 仅持当前 Job 冻结的 CLI 配置，终态即销毁 |
| **Scheduler** | 副作用唯一执行者 | claim、状态机、派生 verify/report、Reaper、注入快照 | 不做业务推理 |

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**  
> Plane 为可选集成，默认主路径是 Web 直接创建项目与任务。

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
- **控制面默认拒绝（#57 / #135 / #152）**：所有控制操作与语义事件先经 `packages/shared-types` 严格 Zod 契约（未知字段、空白文本、类型、枚举、UUID、长度、范围、预算均拒绝），再由宿主重验，最后在同一事件事务执行图/状态副作用。Scheduler 的 `event-ingestion` side-effect application（`core.applySideEffects` 仅为兼容 facade）以 Job 类型/冻结角色快照重算授权，并要求 Job 仍为 `status=running`；终态、角色种类或 operation 不一致均以稳定 `ControlInputError` 拒绝并回滚 dedup、额度、事件及图副作用。冻结 capability 只派生平台 API operation allowlist；所有治理 CLI 均由 Agent 使用自身 HTTP 工具调用 Job 级控制 API，不注入控制 MCP，也不在失败后回退其它控制通道。API 返回 `accepted` 表示 Scheduler 已接收输入，HTTP 错误始终带稳定错误码与人话。
- **控制 payload 字节与确认边界（#166）**：Fact、Finding、Hub 的直接参数与宿主展开后的 `payload_file` 共用固定 256 KiB UTF-8 JSON 上限，超限在暂存或写事件前以可重试控制错误拒绝；`mark_job_done.summary` 上限为 8192 UTF-8 字节，接受后不再附加 Hub、Fact 或 Finding 计数文本。Hub/Human 的真实副作用仍延迟到 Agent 退出后执行，但在返回 `accepted` 前以只读权威事务预检当前 Job、画布引用、角色、Finding 绑定与完成门，最终副作用事务再次校验以防状态漂移。
- **语义事件持久化限流（#57）**：Scheduler 在 `event-ingestion` 权威事务中以 `job_event_rate_limits` 单行 `SELECT ... FOR UPDATE` 执行有界固定窗口；进度、普通事件和终态/人工事件使用独立桶（默认每 60 秒 30/120/8），终态预算不会被 progress 消耗。幂等 `event_id` 先判重，重复投递不占额度；拒绝返回 `event_rate_limited`、`retry_after_sec` 等低基数元数据并回滚全部事件/画布副作用。计数行跨 Scheduler 进程/重启保留，禁止扫描 append-only `events`。
- **同步 ack 边界**：CLI 使用按 Job 签发的短期 capability token 调用 `/control/v1/jobs/:jobId/operations/:operationId`；API 调用进入当前 Job 的宿主 semantic handler，不形成第二套副作用逻辑，不引入可写控制文件队列或未经治理的 socket。
- **静态控制 Skill（#135 / #152）**：所有真实 Job 注入同一份平台内置、不可由 RoleConfig 同名条目覆盖的 `deepsonar-control` Skill。Skill 只说明 capabilities/OpenAPI discovery、Bearer 鉴权、UUID `Idempotency-Key` 和有限重试，不动态生成 API 清单，也不授予权限；实际开放 operation 只认冻结 Job capability 与 token 绑定列表。
- **短期 API Token（Schema v25 / #135）**：平台控制 API 使用独立 `job_capability_tokens`，不复用 Model Gateway `job_tokens`。Token 只存 hash，绑定 Job、项目、精确 operation 列表与到期时间，在执行期通过环境变量注入且不进入 Job snapshot、工作区、运行清单或 evidence；Job 终态撤销。受限网络 sidecar 只允许固定 Scheduler 上游的 `/gateway/` 与 `/control/v1/`，不开放任意代理；受管容器同时绑定 upstream hash 与代理脚本 revision，升级时 revision 不符会自动重建，未受管的同名容器拒绝接管。
- **控制通道不污染**：真实 Job 的语义写入只接受 capability token 授权的 Job 级 API operation；CLI 结构化流中的同名或伪造 MCP tool call 不映射为语义事件。控制 telemetry 只保留 operation、调用标识与输入 shape/count，不记录原始 input/content；非 JSON 运行时行、未知行和写 `.deepsonar/control-*` 的尝试只记低基数告警/指标，跳过后继续处理后续合法事件。
- **Hub 不可下发** `verify` / `report`；须先 `list_available_roles`。
- 单画布同时最多一个活跃 hub；`maxHubRounds` / followup 深度护栏。
- 验证：独立 review + test 证据硬门；rework 回弹 Hub 补证。
- **验证范围（#133）**：`minVerifySeverity` 同时控制自动 Verify 与收敛集合；明确低于阈值的 Finding 保持 `pending` 并记录 `below_min_verify_severity` 策略标记，不创建 Verify Job/round、不阻塞 Hub complete/Report。缺失或未知 severity 保守地继续验证；`info` 即严格全量模式。
- **Hub Finding 绑定（#153 / #154 / #161 / #273）**：Hub 对本轮 canonical Finding 节点派发 review/test 时，Scheduler 在派生前解析并冻结唯一 `finding_id` 与 `verification_followup`；多 Finding、映射歧义、Verify trigger 不一致或低于 `minVerifySeverity` 的目标使整次决策稳定拒绝。compose 的 imported seed 是例外：review/test 只把其共享资产挂到探索 Worker，不创建 verification follow-up，也不改写历史 Finding；compose 画布上 explore/audit 必须绑定至少一条 imported 种子投影，不得未绑定地全图打猎。`request_human` 也必须携带结构化 subject：Finding subject 由 Scheduler 校验同项目、同画布 canonical 关系及最低验证级别，平台阻塞则只能使用受限 kind；系统绝不解析 reason 文本推断目标。analyze 仍可引用多个来源。
- **人工验证收口（#155）**：Finding 详情提供三种显式动作：强制新建受护栏约束的 Verify round、新建绑定 Finding 的 review/test 补证 Job，以及在同画布 Hub 处于 `waiting_human` 时把尚未 confirmed 的 Finding 收口为 `needs_human`。所有动作按 canvas-first 顺序加锁、禁止终态重开并拒绝同类活动 Job；需要恢复时在同一事务将 Hub 转回 `pending` 并通知 dispatcher。人工入口绝不开放 `confirmed`。
- **双轨报告（#43/#142）**：收敛门通过后，Scheduler 为画布派发版本化 Task Report；每版冻结 `report-input.json` 与 checksum，相同输入幂等，输入变化时追加版本，失败同输入重试复用版本。每条 Finding 变为 `confirmed` 时独立派发版本化 Finding Report。两类报告在 `pending/generating` 期间都只允许同一目标一个活跃版本，失败只更新报告行，不改变 Finding 状态。
- **通用 Finding 协议（#44）**：`profile`、`category`、`tags`、`evidence_refs` 是跨安全、质量、合规等领域的通用字段；严重度可不提供，CVSS 评分可选。有效协议由全局、项目、任务三层按任务 > 项目 > 全局合并，在建画布时写入 `target_json.effective_finding_protocol` 冻结；Job 和 Agent 只读取该快照。Scheduler 校验 profile/字段边界、去重并决定 Verify，受支持的 CVSS 4.0/3.1 向量由系统重算，协议显式接受的未知版本保留原始向量/指标。

### 4.1 人工消息与动态附件收件箱

- Web 可向当前画布的 **Hub**，或当前选中的 active `intent` / `job` / `report` 节点发送 1–8000 字人工消息；终态或非运行节点不接受定向消息。发送记录以 durable human message ledger 为准，前端只做派生展示，不写回或污染画布拓扑原始数据。
- 发送入口在任务工作台（人工介入条、本次运行 `waiting_human` Job、工作台 Job 详情），不在过程画布上放 FAB 或画布级撰写器。解析不到活动 Job 时不得静默发给 Hub，必须显式选择；`human` 是节点类型，不能投递。
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
| **能力门禁** | 仅当冻结快照 `agent_runtime.capabilities.incrementalMessages === true` 时订阅。当前：**Claude Code、Pi、DSH 会注入**；**Codex、OpenCode 不声明该能力 → 不订阅、无运行时追加**（非“功能未做”） |
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
- **恢复与当前配置重跑（#202）**：`POST /jobs/:id/resume` 明确定义为使用创建期旧冻结快照重新执行（同 Job、新 Attempt），只接受 `failed/timeout/orphan/waiting_human`；入口先按当前 RoleConfig、Credential、项目策略完整解析受治理身份，若 `agent_cli/model/upstream_model/credential_id/credential_provider`、runtime adapter 或 runtime image digest 等身份漂移，或当前配置无法解析，则稳定返回 `409 SNAPSHOT_STALE`，禁止静默使用旧模型。`POST /jobs/:id/rerun-current` 在 Dispatcher admission lock 下按 Canvas→Job 加锁，完整重冻当前快照后原子转 `pending`；保留 payload/parent/canvas、Intent/Fact/Finding 和旧 Attempt/effect，不清画布、不复用已销毁 Session、不重放 unknown effect。任务 resume 的启动中断批次与单 Job仍默认旧快照，任一 stale 时整批拒绝并返回 `job_ids`。
- **资源 desired-state 对账（#199）**：Agentbox destroy 的最终容器删除使用 120 秒单次上限、最多 5 次指数退避，只有明确 `no such container` 算幂等成功，耗尽后向上抛错。启动 reconcile 与每轮 Reaper 都以 DB 中 `claimed/provisioning/running` Job + active Attempt 为 desired state，只枚举同时具有 canonical `deepsonar.job` / `deepsonar.attempt` 标签的容器，以及严格 `deepsonar-assets-<canonical Job UUID>` 名称/受管标签的本地卷；非活跃资源每轮继续重试且清理防重入。禁止 `docker system prune`、前缀猜测容器归属或删除非 DeepSonar 资源。

## 6. 配置层级

| 层 | 内容 | 覆盖 |
|----|------|------|
| 全局 | `global_settings`、全局 `role_configs`、平台 skill 源、镜像市场 | 缺省 |
| 项目 | 规则（含 `maxConcurrentJobs` 调度配额）、启用角色、项目 RoleConfig、出网默认、`config_json` 中的镜像策略 | **压过全局**（调度硬 cap 除外：项目只能收紧 `maxConcurrentJobs`） |
| 任务/画布 | `target_json`、出网覆盖、Finding 协议等 | **压过项目** |
| Job | `agent_snapshot_json` 创建时冻结（含 `runtime_knobs`） | 执行只认快照 |

**冲突规则：任务 > 项目 > 全局**（RoleConfig 已如此；Finding 协议等演进配置同此心智）。

**运行时护栏（#263 batch 1）**：`stallSec`、`jobTokenMaxRequests`、`auditTimeoutSec` / `verifyTimeoutSec`、`provisionTimeoutSec` 落在 `global_settings.rules_json`，可被项目 `config_json.rules` 与角色 `role_configs.runtime_knobs_json` 覆盖；创建 Job 时可再指定 `stall_sec` / `max_requests` / `timeout_sec`。优先级 **Job > 角色（项目 RoleConfig 字段覆盖全局 RoleConfig）> 项目规则 > 平台规则 > 部署 env 引导**。`provisionTimeoutSec` 仅平台可写。`stallSec=0` 关闭停滞判定；`jobTokenMaxRequests=0` 不限制 Gateway 请求。Scheduler 每次读库（`globalRules()` / 建 Job 冻结快照），改完无需重启；已在跑的 Job 继续用创建时冻结值。Chrome 专项镜像仍有 stall 下限，角色/Job 可再抬高。lease TTL、Reaper 间隔、Gateway 超时、镜像 registry/cosign/syft/trivy/clamav 与巡检间隔仍走部署 env，后续批次再前端化。

DSH RoleConfig 的 `dsh_task_mode` 固定为 `standard | ptc`，默认 `standard`，并随 Job 冻结。Standard 使用 DSH 原生工具呈现；PTC 使用官方 Code Mode（`dsh-tools mode: code`）和受治理的 worker-thread TypeScript runtime，只把 `run_code` 作为模型直接工具。该字段对其他 Agent CLI 无效。模型思考强度统一属于 Provider Credential。Claude Code 只接受 `low | medium | high | xhigh`，运行时物化为 `.claude/settings.json` 的 `effortLevel`；Codex 接受 `none | minimal | low | medium | high | xhigh` 并同时写入 `config.toml` 与冻结启动覆盖；Pi 接受 `off | minimal | low | medium | high | xhigh | max` 并在启动/恢复时传 `--thinking`；OpenCode 将 1–64 字符的 Provider/模型 variant 在启动/恢复时原样传给 `--variant`。DSH 使用 Pi-AI 的规范档位 `off | minimal | low | medium | high | xhigh | max`，第三方实际传输值由每个模型的 `reasoningEfforts` YAML 映射，页面只允许所选模型声明的档位。Pi 与 DSH 同属 llm-pi-ai 家族：Provider 编辑器接受官方 `settings.yaml` / 等价 JSON（`llm-pi-ai.providers` + `agent-default-model`），也保留 Pi 自有 `{ providers: { deepsonar: … } }` 形状；粘贴后提取 `baseURL` / 默认模型 / 若存在的 `apiKey`，POST/PATCH Credential 写入 `public_metadata.base_url`。DSH 使用官方 `@deepseek-ai/dsh-llm-pi-ai`，按同一官方 YAML 保存并做严格校验，可声明任意安全 route 及其 OpenAI/Anthropic 兼容 profile；Job 创建时冻结所选 route/model/reasoning，运行时强制把 `baseURL` 与 `apiKeyEnv` 投影到 Job Model Gateway，并挂载固定 commit 与 SHA-256 的 MIT 插件 `dsh-reasoning-settings@0.3.0`，为 `subagent` / `subagent_fork` 提供受已配置 route/model 限制的按次档位和继承修正。Pi 将官方 profile 物化为 `.pi/agent/models.json`。长期密钥不进入 Cordis 配置或沙箱。

DSH 的无 UI Cordis composition 必须服从镜像内钉死包的真实 Schema；当前完整包闭包统一固定为 `0.1.0-rc.7`，避免 prerelease peer range 混装。`agent-spine-demo` 的 `toolBash` 只接受 `false | object`，平台传入对象并由 spine 单独挂载 bash 工具，禁止写 `true` 或重复注册工具。`dsh-bash-local` 依赖的 `dsh-subprocess-local` 作为固定 integrity 的独立插件显式安装和挂载，命令超时只配置在 bash executor。Base CI 无论新建还是复用不可变镜像，都以 `--network none` 启动 packaged-bin、完成 JSON-RPC `initialize` 并验证干净 `shutdown`；该启动级门禁不调用真实模型。

Finding 协议存于全局 `global_settings.rules_json.finding_protocol`、项目
`projects.config_json.finding_protocol`，任务创建请求可用 `finding_protocol` 只覆盖声明的键；列表字段在高层整表替换。解析后的 `EffectiveFindingProtocol`（模式、默认/允许 profiles、评分策略、显示名和来源）随新画布冻结，后续配置修改只影响新任务。

项目镜像策略也存于 `projects.config_json`，不增加表或迁移：`image_strategy` 缺省为
`inherit_global`，此时 Job 镜像始终取该角色的全局 `RoleConfig.runtime_image_key`，
且 `model` / 默认 CLI 也只认全局 RoleConfig（再落到账号主模型）；遗留项目 RoleConfig 行
上的 `model` / `agent_cli` 在解析时忽略，无需删除历史行。
`project_managed` 时只取 `role_runtime_images`（角色名到可信 runtime key 或 `null`），缺项或
`null` 使用系统 `deepsonar-base`，并允许项目 RoleConfig 托管自己的 model / 默认 CLI。
项目 RoleConfig 的 `runtime_image_key` 不再作为项目镜像来源。
项目对市场版本的绑定：`project_runtime_images.selected_version_id=null` 跟随最新 trusted，不必再写 UUID。显式 UUID 为 pin。官方 catalog 提升 / registry sync 成功后，只把**官方**且已过期（当前通道/宿主平台不再是可执行 trusted，同时新 latest trusted 可用）的项目 pin 滚到 `latest_version_id`；只改 `project_runtime_images.selected_version_id`，已冻结 Job 快照与历史 Attempt 不动。`pin_ok` 的显式旧版（仍 trusted 可执行）不改。第三方 pin 仍 fail closed，不自动换 digest。需要钉死旧官方版本的项目设 `pin_policy=hold`；默认 `follow`。每次自动滚动写 `audit_logs`（`runtime_image.official_pin_roll`，trigger=`official_catalog_promote`）。hold / 第三方过期 pin 仍返回 `409 RUNTIME_IMAGE_PIN_STALE`（含一键升级）。空壳画布（已提交但无 Job）可在 pin 滚动后 `POST /tasks/:id/retry` 补入口 Hub。

### 6.1 Compose 任务的冻结种子

- `kind=compose` 必须从当前项目选择 1–8 条未否定处置（`open` / `accepted` / `confirmed_vuln`）的 Finding；**不要求** `verify_status=confirmed`。`pending` / `verifying` / `needs_human` / `confirmed` 均可作种子。`standard` 禁止携带种子。默认排除 `rejected_fp` / `resolved` / `archived`。
- 创建时把选中 Finding 的必要摘要、来源身份以及冻结当时的 `verify_status` / `disposition` 写入 `canvases.target_json.seed_findings`，并生成当前画布内的只读 finding 投影。投影只作为背景，**不是本画布 canonical Finding**：不复制 Finding 记录，不进入本画布 Verify 生命周期；原 Verify 仍在源画布。新证据应回到源 Finding 或产出明确的新 Finding，不得把投影节点当成可确认正本。
- Graph 对 Agent 暴露当前画布节点 UUID，并标记 `imported` / `readonly`；项目 Finding UUID 和完整冻结摘要不进入 prompt。Hub 仍只能引用当前画布 canonical 节点。YAML 另投影 `compose_scope`（种子位置与「禁止扩大资产范围」规则）。
- **范围护栏（#273）**：compose 画布只围绕冻结种子做确认、补证与组合链，禁止新一轮资产扫描。Hub 不得下发未绑定种子投影的 explore/audit；若保留 explore/audit，必须绑定至少一条 imported 种子，prompt 只覆盖该种子资产。`emit_finding` 必须能追溯到种子资产（同仓/同模块或组合链位置），越界新资产由 Scheduler 拒绝。
- 重试是一次新执行。Scheduler 在清空旧运行数据前重新校验全部源 Finding；源条目已失效、跨项目或变成否定处置时返回 `COMPOSE_SEEDS_STALE`，原画布数据不动。**不因仍未 confirmed 而拒绝重试。**
- Task Report 明确记录 `task_kind`、种子数量和冻结种子列表（含冻结当时的 verify/disposition），种子与本次运行新产出的 Finding 分开统计。

实现入口：`apps/scheduler/src/task-compose.ts`、`domains/project-task/routes.ts`、`graph.ts`、`report.ts` 与 Web `TasksPage.tsx`。

## 7. 注入与读图（as-built）

- `buildGraphSnapshot(canvasId, scope?, opts?)` → YAML：goal、facts/findings 摘要、open/concluded intents、hints。
- **GraphScope**（`hub` | `agent` | `verify` | `report`）与**整图字符预算**已在 `graph.ts` 落地（#30）；Hub/Worker/Verify 注入投影不同，仍须关注超预算截断与索引完整性。
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

**Job Session UI**：前端 `apps/web/src/session-viewer/` 按 CLI 方言将归档文本解析为消息、reasoning、tool call/result、usage 等时间线/工具统计/原始视图，并保留原始文件下载；解析格式须覆盖当前全部 `SupportedAgentCli`（claude-code / codex / open-code / pi / dsh），不假设五类归档拥有同一 schema。只有 CLI 归档中实际持久化了平台注入文本时，查看器才显示对应画布广播条目。**新增 Agent CLI 时必须同步** Session 归档适配器（`cli-session-adapters.ts`）与 Web 解析器，清单见 `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`「Session 归档 + Web 查看器」。

归档来源按 CLI 独立治理：Claude Code、Codex、Pi、DSH 从本次沙箱的受治理本地 session artifact 读取；OpenCode 使用 `opencode export <sessionId>` vendor export，受 32 MiB 上限约束。malformed 的 session identity/path、导出/读取错误或体积超限必须显式报告归档失败；查看器对归档内不可解析行保留 `skipped` 计数，不猜测 latest 或其它 Job。

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
- 镜像：市场 digest 冻结；第三方须 image-admission；Agent 不能指定镜像。项目按全局继承或项目托管策略选择受治理 runtime key，Job 创建时连同兼容 CLI 与工具清单一起冻结。Chrome audit/test/fuzz 是官方但 project-opt-in 的专项运行时。
- **官方 digest 免签（#205）**：官方运行时以 GitHub Release catalog 的不可变 digest 为信任根，当前 release 不 `cosign sign`。准入 Worker 钉 Cosign 3，仅在配置了 `DEEPSONAR_COSIGN_KEY` 或 keyless identity+OIDC issuer 时验签；未配置则记录 `signature: skipped`（`unsigned_policy`），合同、SBOM、漏洞/凭据与恶意扫描仍 fail closed。禁止发出缺 identity/`--key` 的 `cosign verify`。CLI/网络/缺参记 `scanner_misconfigured`，无签名记 `unsigned`，只有 `admission policy failed` 才自动撤销官方 trusted。启用签名后须与发布流水线使用同一套 identity。
- **Runtime image GC（#199）**：可配置周期，`0` 关闭；只对 DB `runtime_image_versions` 及其 registry ref 账本中可证明 digest 一致的 named immutable ref 调用无 `-f` 的 `docker image rm`。保护全部 promoted 版本、每产品当前/最近回滚版、项目 `selected_version_id` 显式 pin，以及 pending/active/waiting Job 快照引用。删除前查询所有容器的 ancestor，删除竞态仍由 Docker 非强制引用门保留；无安全 ref、检查失败或容器占用一律 fail closed。绝不执行 broad prune。
- **宿主磁盘水位（#199）**：Scheduler 用 Node `statfs` 检查配置路径所在文件系统；warning 只告警，error 使 `/readiness` 返回 `HOST_DISK_PRESSURE` 并暂停 Dispatcher 新 claim，探针不可读也 fail closed；两者都不终止已运行 Job。水位恢复后监控器显式唤醒事件驱动 Dispatcher。生产 real compose 只读挂载 `DEEPSONAR_HOST_DISK_SOURCE` 到探针路径。
- 出网：`allow_egress` 任务级冻结；所有 real Job 的模型请求都经 Scheduler-owned gateway proxy。允许出网的沙箱加入 `deepsonar-sandbox-gateway` NAT bridge；禁出网时只加入 `deepsonar-restricted` internal bridge，并通过同时接入两网的固定 proxy 到达 Scheduler。
- Model Gateway 上游单次超时默认为 3,000 秒，但每次 attempt 取 `min(3_000_000ms, Job 剩余时间)`；仅在客户端响应头/响应体尚未开始发送前，对网络/超时和 HTTP 408/429/500/502/503/504 做最多 3 次指数退避加 jitter，永久 HTTP 错误不重试，已开始的 SSE/响应体绝不重放。Job 的 `used_requests` 按沙箱客户端请求只递增一次；上游 attempt/retry/exhausted 仅记录 provider、reason 等低基数指标，不记录请求体、URL 或 Job ID。网络/超时耗尽返回稳定 `502 upstream_unreachable`，最终上游 HTTP 响应原样直通。
- Gateway 重试耗尽并导致 Agent CLI 退出后，runtime runner 只对明确的 HTTP 408/429/500/502/503/504、timeout 与 network 错误，在原沙箱使用已捕获的原 session ID 最多恢复 3 次（1/2/4 秒退避）。Claude Code 使用 `--resume`，Codex 使用 `exec resume`，OpenCode 使用 `--session`；400/401/403、普通退出、缺 session 或恢复耗尽均直接失败，不允许 `--continue`、latest session 或新会话兜底。恢复过程写入低基数 `run.retrying` / `run.retry_skipped`，已成功控制副作用继续由运行时去重与数据库幂等键保护。
- Model Gateway 的每次请求同时写入 `job_usage_ledger`，关联 `attempt_id + effect_id`；只保留 provider/model、输入/输出/总 token、请求序号和 `settled|unknown|not_reported`，不保存 prompt、响应正文、请求头或凭据。流式 usage 按完整记录去重，响应已发送后账本写失败计指标并保留可对账的 effect 标识，不制造未处理异常。

## 10. 前端信息架构

- 一级工作流固定为 **态势 / 项目 / Agent / Agent 市场 / 镜像**；跨项目 Findings/Jobs 保留查询页与命令菜单入口，但不占主 rail。日常闭环从项目 → 任务 → 画布/发现/运行/报告完成。
- **态势运营总览（#242 P0）**：`/` 在关注队列之上展示项目/任务/Job/Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建/完成任务与新增 Finding、活跃项目 Top N 与最近活动。总量走轻量 `GET /dashboard/overview`（Job/Finding 列表有窗口上限，前端不全量拉取）；关注队列仍用 `api.jobs()` / `api.findings()` 作为处置入口。P1 风险分布与 P2 吞吐看板未做。
- Agent 页只维护角色注册表与全局 RoleConfig。模块源归 Agent 市场；账号/用户/API Token 归安全与访问；Provider 密钥归凭据；**配置中心**（`/settings/platform`）维护 batch-1 运行时护栏与全局调度纪律，平台配置包仍归该区。
- Agent 市场 MVP 使用 `deepsonar.agentpack/v1`：官方静态模板与本地 JSON 上传均安装到服务端角色/RoleConfig；包体有 256 KiB 上限，不接受 Credential 绑定、Provider 配置文件或疑似长期密钥环境变量。安装仍由 `agents:write` 权限控制，凭据必须本机另行绑定。
- 任务列表 / 任务工作台（画布 · Findings · Facts · Jobs · 报告）。新建任务支持 `standard` 与 `compose`：compose 从当前项目选择 1–8 条未否定处置 Finding（含未确认），创建后显示为只读种子背景，新画布只围绕这些条目而不扩大资产范围。Facts 使用独立服务端 keyset 分页与状态/证据/Finding/Job 筛选；详情只投影同项目、同画布、具有合法证据边的结构化关联，并提供人工 `verified` / `rejected` / `needs_human` 收口。
- 列表型筛选统一使用可搜索多选 Combobox：同一维度按 OR、不同维度按 AND；URL 用逗号分隔保留可分享深链。服务端分页筛选（如 Facts）由 Scheduler 在分页前执行多值查询。配置、动作和阈值等单值业务选择保持可搜索单选。
- 节点语义色：`SEMANTIC_STYLE`（hub 紫、finding 红、agent 黄、fact 青…）
- 工作角色使用 `agent_roles.ui_color` 的调度器分配色；系统 / Hub 节点保留固定语义色。角色色在创建事务中经 advisory lock 分配，写入 intent/job 节点正文后冻结；画布边线与箭头取源节点最终色，边类型只改变线型与流速。
- **任务是否在跑：以 `active_count` / 活跃 Job 为准**；勿把 `last_job_status=succeeded` 当成任务已完成（#46）
- 画布只读；Finding 详情偏 GitHub Issue（disposition + 评论可唤醒 Hub）
- Finding 列表/画布运行区显示冻结的 profile、可选 category 与 CVSS 版本/基础分；按 severity、profile、verify 状态筛选。详情保留向量、定性严重度、利用难度和原始 JSON；报告按 profile 分组、展示 category，并携带 tags、evidence_refs 与 scoring。
- Finding 详情直接展示服务端统一的验证追踪（来源、review/test Fact、Intent/Fact 有向流、Verify 轮次与 exact Hub）；可用 `traceFinding` 深链在画布中淡化或隐藏非链路节点，并按 `focusNode` 定位单个证据节点。弱关联不从 prompt 推断，未连边 Intent 与证据缺口显式呈现。

## 11. 已共识演进（未完全落地 / 已完成索引）

下列方向曾在 GitHub Issues 立项；**状态以当前代码与本表「已完成」标记为准**（issue 关闭不代表文档自动同步，以本文件 + 代码为准）。

| 主题 | Issue | 设计要点 |
|------|-------|----------|
| 读图预算 / GraphScope | #30 | **部分已落地**（scope + 字符预算）；索引层/Worker 邻域与可观测性可继续收紧 |
| Finding 追踪链 + 画布只看链路 | #31 | **已完成**：`GET /findings/:id` 提供结构化、限界的 `trace`；详情主路径消费 evidence/rounds/Fact-Intent flow/gaps；画布支持 `traceFinding` + `focusNode` 深链、淡化/隐藏与 Finding 节点入口 |
| 整插件 / 整源挂载 | #33 | `modules` selector：`plugin:` / `source:*`（持续打磨挂载体验） |
| Scheduler bounded contexts / characterization | #37 | **已完成**：六个领域均通过 application/ports 暴露窄接口；`event-ingestion` 拥有 envelope、幂等、顺序、限流与语义副作用，Hub/Finding/Report/runtime snapshot 通过显式 ports 协作。顶层 `routes.ts` 只保留 auth/project-scope hook、Gateway 与领域 registrar 组装，业务 handler 全部按域归属。`core.ts` 保留既有 import 的兼容 facade 与 composition root，不再承载事件副作用实现；Canvas-first 事务锁序、终态组合、路由/OpenAPI surface 和无生产动态 import 均有回归护栏。 |
| 实时流 + 运行中过程流 | #38 | **已完成并关 issue**：短时一次性 `ws-ticket` + `/ws`/`terminal-ws`；运行中 `evidence/stream` 可读 inflight ndjson tail；连接失败有明确 close code/文案。残余：stream-bus 仍单进程内存（多副本不共享）、广播卡片进 stream 为可选 |
| 软加载 / 增量同步 | #39 | **已完成并关 issue**：画布 L0 摘要 + `canvas_changes` 修订日志 + `GET /canvases/:id/delta?since=`；前端 `CanvasView` 轮询 delta，过旧回退全量 L0；大 body 不塞列表主路径 |
| 分层共享资产 | #41 | **已实现**：platform/project/finding 三级不可变版本库，CAS blob、配额/MIME/path 校验、人工上传/归档/下载、Agent `list_shared_assets`/`publish_shared_asset`、项目 platform opt-in、Finding 隔离、Job 精确版本快照，以及带 Job 标签的 `:ro` named volume 自动注入/回收；项目/平台/Finding UI 已接入。字节经可插拔 BlobStore（`BLOB_STORE=fs|s3`，官方生产 Compose 默认使用再发布的 `deepsonar-silo`，当前 Release 前回退 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`，仍兼容任意 S3 服务）；Agent **无单独下载工具**，list 返回 `mount_path`/`read_path` 用普通文件工具读取，publish 由 Scheduler 写 BlobStore。 |
| Provider 配置（CC Switch 模型） | #99/#181/#215/#218/#255 | **已落地（五类 CLI 配置方言）**：LLM `provider` 是协议（Anthropic Messages / OpenAI-compatible），不是厂商预设。`credentials` 存 `agent_cli` + 完整 `settings_config_json` + `meta_json`；管理 API 仅返回 `[已保存密钥]` 脱敏投影。角色绑定 Credential 配置文件，`RoleConfig.model` 仅作可选高级覆盖。Job 快照分别冻结 CLI selector `model` 与解析别名后的 `upstream_model`；Claude Code 的 `fable` / `sonnet` / `opus` / `haiku` 继续作为 CLI 参数，Gateway 把请求体 `model` 改写成冻结的 `upstream_model` 再出站，账本记录出站 ID；Gateway 只记录 settings 声明的模型与别名映射，不再用 Credential `allowed_model_ids` 求交集。凭据表单显式维护 Fable/subagent 映射，绑定与 Job UI 同时展示 selector 和上游 ID；已有 Job 快照不因凭据编辑而改写。模型目录只表示 Provider 可发现的 ID，不代表当前 Key 对该 ID 有调用权限。运行时按 CLI 物化受治理配置并统一改写到 Model Gateway，仅注入短期 Job token。Pi 与 DSH 均可解析官方 `llm-pi-ai` settings（YAML 字符串、`config` 对象或顶层 JSON），提取 `baseURL` / 默认模型 / 若存在的 key；Pi 物化为 `models.json`。 |
| 移除 Credential 模型白名单 | #215 | **已完成**：模型可用性只认 `settings_config` 声明清单。`jobGatewayAllowedModels` 只透传配置文件/别名/上游 ID，不再与 `allowed_model_ids` 求交集；Gateway 不再按 Job token 字面白名单 403。旧凭证残留字段读写均静默忽略，不消费、不兼容读取。 |
| Gateway 出站改写 CLI 别名 | #218 | **已完成**：若请求 `model` 是 `fable`/`sonnet`/`opus`/`haiku`，Gateway 改写成 Job 冻结的 `upstream_model` 再转发；已是上游 ID 或没有冻结值则保持原值。`job_usage_ledger` 记录出站后的模型 ID。 |
| 治理多 CLI Runtime Adapter | #100 | **已落地**：Scheduler 通过显式注册表驱动 Claude Code、Codex、OpenCode、Pi 与 DSH 的官方非交互结构化协议；能力、适配器版本和兼容 runtime image 在创建 Job 时校验并冻结到 `agent_snapshot_json`。未注册 CLI、缺失必需能力或镜像不兼容均在执行前 fail closed。详见 [`docs/AGENT_CLI_RUNTIME_ADAPTERS.md`](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)。 |
| 节点/边着色 + Agent 专色 | #42 | **已完成**：边随源节点色；新建 role 分配未占用色（`agent_roles.ui_color`） |
| 双轨报告 | #43/#142 | **已完成**：任务收敛后按冻结输入摘要生成版本化 Task Report，默认返回最新版本并保留历史；每条 `confirmed` Finding 自动生成独立、冻结输入的版本化 Finding Report。两条轨道都限制同一目标同时一个活跃报告，不修改 Finding 状态 |
| 通用 Finding + CVSS | #44 | **已完成**：通用 `profile/category/tags/evidence_refs` 与可选 severity/scoring；协议按任务>项目>全局解析并随画布冻结；真实 Agent 通过严格的 Job 级 API operation 提案，Scheduler 重算 CVSS 4.0/3.1、保留协议允许的未知版本原始数据；Web/报告支持标识、筛选与分组 |
| 任务卡片状态 | #46 | **已完成**：任务级相位与 `active_count` 同源；勿用 `last_job_status=succeeded` 当任务完成 |
| 启动 orphan 批量恢复与证据回退 | #186 | **已完成**：启动 reconcile 不再由 role Worker orphan 立即派生 Hub；任务恢复优先批量重跑同画布启动中断 Worker（同 Job、新 Attempt，明确 action/jobs，不重放 unknown effect）；缺 finalized manifest 时有界暴露 raw stream synthetic manifest 与真实 Session capture_error |
| Job 旧快照恢复与当前配置重跑 | #202 | **已完成**：resume 只用旧冻结快照且受治理身份漂移时 `SNAPSHOT_STALE`；`rerun-current` 在 claim admission 与 Canvas→Job 锁下完整重冻当前配置，同 Job/新 Attempt 保留画布和历史 effect；任务 resume 对 stale 批次原子拒绝并返回 Job IDs |
| 产品 IA 与 Agent 市场 | #49 | **已完成**：5 个一级工作流入口；发现/运行回归项目任务主路径并保留命令检索；Agent、模块市场、安全、凭据、平台数据按权限边界拆页；官方模板与安全约束的本地 agentpack 安装 MVP |
| 官方清单 fallback 不自残 | #191 | **已完成**：远程清单不可达时 `fallback=true` 只插入缺失版本，不 rename / 不改已有 `image_ref` / 不 revoke。官方可信版本的准入扫描失败保持 trusted 并写审计。信任清空时打 error 级日志并写 `runtime_image.official_trust_empty` 审计。 |
| 官方 catalog 不被 Trivy 发行版 CRITICAL 误吊销 | #259 | **已完成**：官方 catalog 与第三方导入分政策。官方周期复扫的 distro CRITICAL/secret 只记扫描结果与告警，不自动 `revoked`；第三方仍 0 CRITICAL / 0 secret，扫描通过后 quarantined 待批准。Job 选择器在仅有吊销版本时返回 `409 RUNTIME_IMAGE_REVOKED` / `RUNTIME_IMAGE_NOT_TRUSTED`，不再误报 `RUNTIME_IMAGE_PLATFORM_UNAVAILABLE`。官方吊销/恢复写 `audit_logs`；warmup / `/health` 以 `official_trust_warnings` 暴露「官方默认镜像已 revoked」。 |
| Cosign 3 验签 identity | #205 | **已完成**：默认官方 digest 免签（`signature: skipped`）；配置 `--key` 或 Cosign 3 `--certificate-identity` + `--certificate-oidc-issuer`（可用 regexp）后才 `verify`。缺参不得发出 keyless `verify`；无签名/扫描器错误不冒充 `admission policy failed`。 |
| DSH Cordis 启动准入与 stderr 证据 | #200 | **已完成**：`toolBash` 改用 rc.6 Schema 接受的对象，由 spine 单独挂载工具；删除重复 bash tool，显式安装/挂载固定 integrity 的 `dsh-subprocess-local`，并把超时配置归还 bash executor。Base 新建/复用镜像均执行断网 packaged-bin `initialize` + clean shutdown smoke，失败 CI stderr 最多保留 8 KiB；runtime 将完整但总量限 1 MiB、精确脱敏的 stderr chunk 写入 normalized evidence，Job error 保持短摘要。 |
| 官方运行镜像多 channel catalog | #70、#143 | **已完成**：v2 canonical digest/platform/size + `registry_refs`/`registry_evidence` 合约、v1 归一化与严格 OCI/host/namespace 校验；release 按 ACR→GHCR→Docker Hub 发布并对每个可用目的地执行真实 `imagetools inspect`，配置通道失败时清单生成 fail-closed，v2 Release asset 与 bundled fallback 同步；schema v23 新库默认选择 `aliyun-acr`，平台全局通道由 Scheduler 落库并经 `GET /runtime-images/registry` 的 `selected_channel` 读取、`PATCH /runtime-images/registry/channel`（`images:manage`）切换，Job 创建时冻结所选 digest/ref，pull/resolution 对未发布通道 fail-closed；官方目录同步和独立准入 Worker 的首次扫描、恢复扫描、周期复扫均按部署 `DEEPSONAR_IMAGE_REGISTRY` 从同一 digest 的已有发布证据中选择引用，配置不匹配或证据缺失时拒绝扫描，绝不回退到 GHCR。若同一官方 digest 曾因旧 registry 引用不可达而被撤销，目录切换到已证明的新 registry 引用时会回到隔离态并仅排队一次恢复扫描；扫描成功才恢复官方信任，部署源上的真实扫描失败重新撤销，同引用的真实安全撤销不会被目录同步覆盖；Web 市场提供固定三选项通道选择器，与 CPU 平台筛选分离，展示加载/403/切换状态并在切换后刷新清单与镜像行 |
| Chrome audit/test/fuzz 专项运行时 | #118 | **已实现发布基础设施**：三个官方 project-opt-in 镜像分别提供 C++ 静态分析、固定 Chromium/CDP 与固定 V8 源码构建的真实 `d8` + `v8_json_libfuzzer`；每个镜像同时声明 amd64/arm64、来源 SHA256/完整包闭包、工具清单与大小预算。V8 与 Chromium 版本语义分开声明；Job 仍只消费准入后的 immutable digest；核心 CI 与 Chrome amd64 合同冒烟已拆为路径过滤的 `.github/workflows/ci.yml` / `.github/workflows/chrome-runtime.yml`；Chrome Fuzz amd64 按正常目标架构构建并执行 smoke，arm64 在 x86 runner 上使用固定 Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装，真实 `d8`/`v8_json_libfuzzer` smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，原生 smoke 通过前不得组装发布 index；Release 还须完成多 registry inspect 后才生成 catalog |
| OpenHarmony Test 钉死官方 hdc | #268 | **已落地**：`deepsonar-openharmony-test` 从官方 OpenHarmony public SDK `toolchains/hdc`（及 `libusb_shared`）钉死设备协议，URL + SHA256 写入 `openharmony-test-runtime.json`；amd64 原生执行，arm64 用同一官方 linux-x64 二进制 + qemu-user-static。冒烟跑 `hdc version` / `hdc -v`，任一输出含 `Ver:` 即通过；qemu 无设备/守护进程时允许 `Connect server failed`，两者都无版本则 fail closed。CI 不要求真机。无 target 时结构化 `needs_human` / `inconclusive`。不装 DevEco / 完整 SDK / HarmonyOS 闭源工具链，不默认打开 nmap 或 USB 特权。audit/fuzz 主机 Clang/ASan/libFuzzer 保留，不把 gdb/strace 抄成 OH 设备协议。 |
| 项目镜像策略 | #130 | **已完成**：项目创建与设置支持 `inherit_global` / `project_managed`；项目托管映射集中绑定全部角色到项目已启用的可信镜像，缺项使用 Base；项目 RoleConfig 不再接受独立镜像覆盖。real/local-docker 先监听 HTTP，再在后台准备 Base + 全局 Audit/Kali 等有效默认集合；就绪前不启用 Dispatcher，失败保持 live 并有界退避重试。项目策略、绑定或通道切换缺图时返回 `202 preparing/saved:false`，后台准备完成后显式重试才落库；Dispatcher 执行期只 inspect 并以 `runtime_image_not_ready` fail closed，不临时 pull |
| 临时上游错误恢复 | #131 | **已完成**：Gateway 在响应交付前有界重试；CLI 仍因明确临时错误退出时，runner 在原沙箱按原 session ID 有界恢复，永久错误和缺 session 均 fail closed |
| Verify 严重度收敛 | #133 | **已完成**：`minVerifySeverity` 同时限定自动 Verify 与收敛集合；低于阈值的 Finding 保留为策略排除项，不占 Verify 资源、不阻塞报告；`info` 保留严格全量模式 |
| 平台 OpenAPI + 静态控制 Skill | #135/#152 | **已完成 API-only 收口**：真实 Job 注入静态 `deepsonar-control` Skill，并以独立短期 capability token 访问按冻结 operation allowlist 过滤的 `/control/v1/jobs/:jobId` capabilities/OpenAPI/operation API。五个治理 CLI 都由 Agent 自身 HTTP 工具调用该 API；真实运行不注入控制 MCP、不识别语义 MCP 映射，也不提供失败回退。 |
| Agent Runtime Context 生命周期与恢复身份 | #138 | **已落地基础契约**：Executor 为每个 Attempt 生成稳定 `context_id`/revision 与只含摘要的 transform manifest，按 attempt state 和 Job runtime evidence 持久化；`context.compacted` 严格校验身份、链摘要、顺序并支持幂等重放，无法观测或不支持时显式记录而不伪造压缩。恢复前必须取得实际上下文身份并逐字段匹配，缺失或不一致则拒绝恢复；Pi 使用精确 session 文件，不选择 latest。Job 详情只展示有界诊断，不展示 prompt 或 provider 原文。 |
| Pi Coding Agent RPC Runtime Adapter 与 Capability API | #140/#197/#193/#194 | **已落地**：Pi 固定使用 `pi --mode rpc --no-approve` 的严格 LF JSONL 协议，平台控制通过 Job 级 HTTP Capability API，不物化或注入 MCP；`agent_settled` 只提供运行时静止信号，Job 成功仍须经过 `mark_job_done` 完成门。`get_state` 返回的精确 `sessionFile` 用于恢复，暂态错误最多同会话重试三次；模型配置经 Gateway 物化为 `models.json` + `auth.json`，`--model` 使用 `provider/model`。空 content/零 usage 视为协议错误；running Job 无语义事件且无在飞 tool.call 超过 `DEEPSONAR_JOB_STALL_SEC`（默认 900，chrome 镜像另有下限）由 Reaper 判失败。五类治理 CLI 均声明 `interactiveTerminal`；Web 对未声明能力的快照显式提示「该 CLI 暂不支持交互终端」。项目 `.pi` 不自动加载，默认 `--no-extensions`，受治理扩展才通过冻结配置显式 `--extension` 加载。 |
| 通用长上下文预算 + 兼容网关 models 探测 | #144 | **已完成并关 issue**：① `credential-test` 多候选 `modelUrls`（含 `/api/anthropic` 等兼容子路径剥离），404/405 继续下一候选。② 模型目录只登记 Provider 返回的模型 ID。③ Credential/RoleConfig `context_window_tokens`（1024–10000000），RoleConfig 覆盖 Credential，Job 冻结；Codex/OpenCode/Pi 落到各 CLI，Claude 只冻结/展示。 |
| Runtime Platform API 能力一致性 | #145/#152 | **已完成**：五个治理 adapter 均声明 Job 级 HTTP `platformControlApi` 且 `controlMcp=false`；所有 CLI 只走 Job 级 API，冻结 adapter 缺少 API capability 或 operation 时执行前 fail closed |
| 项目镜像继承一致性 | #146 | `inherit_global` 继续只认全局 RoleConfig 镜像；`project_managed` 只认项目 `role_runtime_images` 映射。修复遗留项目 RoleConfig `runtime_image_key` 在导入、展示或 readiness 中被误当作有效配置的问题，不恢复 #130 已删除的独立项目镜像覆盖 |
| inherit_global 忽略遗留项目模型 | #233 | **已完成**：`inherit_global`（缺省 / 脏值）下 Job 快照的 `model` / `upstream_model` / 默认 CLI 只认全局 RoleConfig + 账号主模型；遗留项目 RoleConfig.model 在 `resolveAgentSnapshotForJob` 解析时忽略，不删除历史行。`credential.batch_bind` 仍可不改写行上 model，但 impact/UI 标明这些值在 inherit 下不生效 |
| 项目 runtime image pin 过期 | #244 | **#284 修订口径**：不再「永不改写显式 pin」。官方 stale pin 在 catalog 提升时自动滚；`pin_ok` 显式旧版、第三方、`pin_policy=hold` 仍不自动换。过期且未滚动时 readiness / 建任务仍 `409 RUNTIME_IMAGE_PIN_STALE`（含一键升级），市场行标 `pin_stale` |
| 官方升版自动滚过期项目 pin | #284 | **已完成**：权威官方 catalog apply / registry sync 后批量把过期官方 `selected_version_id` 滚到 latest trusted；只改项目绑定，不动 Job 快照；`version_id=null` 不写 UUID；每条滚动写 `runtime_image.official_pin_roll` 审计（trigger=`official_catalog_promote`）；默认 `pin_policy=follow`，opt-out=`hold`。空壳任务可 retry 补 Hub |
| 任务定时开始（北京 08:00） | #147 | **已完成并关 issue**：见 §5；`task-schedule` / `schedule-wake`、dispatcher 门禁、Web 表单与列表 `scheduled` 相位；无 schema 迁移 |
| 过程画布视口 / MiniMap | #185 | **已完成**：过程画布切走任务页签时保持挂载与尺寸（`visibility` 而非 `display:none`）；节点携带稳定宽高；`fitView` 在零尺寸/空 bounds 时拒绝，容器从 0 恢复后再适配；右上角 MiniMap 可点击/拖动/缩放并避开筛选面板 |
| 任务工作台画布层穿透 | #219 | **已完成**：非画布 Tab 仍用 `visibility` 保住 React Flow 尺寸，但画布层固定 `z-0`，列表/报告用 `theme-drawer` + `z-10` 不透明盖住合成层；`CanvasView` 在 `active=false` 时收起并停渲染 Job/节点抽屉与人工消息层，避免与「本次运行」页级抽屉叠层 |
| Hub 验证绑定与人工收口 | #153/#154/#155 | **已完成**：review/test 与 Finding 人工请求都使用结构化 canonical Finding 绑定；below-min、歧义和 trigger 错配在副作用前拒绝；Finding 详情可强制 Verify、派发绑定的 review/test 补证或收口 `needs_human`，并在需要时原子恢复同画布等待中的 Hub |
| 共享资产卷孤儿回收 | #157 | **已完成**：启动对账合并 label 与严格 `deepsonar-assets-<canonical UUID>` 名称扫描，校验本地卷归属并回收无标签孤儿；删除使用 3 次指数退避，暴露清理失败计数、残留孤儿数量和最大年龄指标 |
| 共享资产 helper 预拉与 provision admission | #158 | **已完成（as-built）**：运行时仍要求不可变小写 `name@sha256:64hex`，只使用 `--pull=never`，fake 不使用 helper。默认回退仍是 `docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`（尚未发明未发布的官方 digest）。下一正式 Release 起发布 `deepsonar-assets-helper`（`deploy/Dockerfile.assets-helper`，FROM 该 busybox pin）；real `up`/`pull` 优先拉 `$IMAGE_REGISTRY/deepsonar-assets-helper:$IMAGE_TAG`，把 RepoDigest 写成 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE`，当前 v0.1.40 及更旧标签缺失时回退 busybox pin。覆盖值必须仍是 immutable digest。Provision 超额 Job 由 DB claim admission 留在 pending，不消耗 `claimed_at`，槽位释放后显式唤醒。 |
| 项目级最大并发 Job 配额 | #187 | **已完成**：项目 `config_json.rules.maxConcurrentJobs` 只能收紧全局 `maxJobsPerProject`；未设置继承全局；`0` 暂停新 claim。Dispatcher 在 claim 事务内按项目有效上限跳过满额候选且不阻塞其他项目；`effective_rules` 返回有效上限与来源，Web 展示当前运行数。 |
| Canvas 任务暂停/开始 | #188 | **已完成**：`target_json.execution_control` 的数据库权威 drain pause；成对幂等 API、Dispatcher Canvas 锁门禁、durable pending、start 精确唤醒、列表/画布 `pausing|paused|running` 投影和主操作。 |
| vfs 宿主资源回收与磁盘水位 | #199 | **已完成**：Agentbox 销毁不吞最终删除错误；容器有界指数重试；启动/Reaper desired-state 对账严格限定双 UUID 标签和受管卷；旧 runtime image 仅按 DB 不可变 ref 与保护集合执行非强制 GC；`statfs` warning/error 水位进入 readiness、指标和 Dispatcher claim 门，恢复后自动唤醒。无 broad prune、无非 DeepSonar 资源删除。 |
| Fact 过程真相工作台 | #159 | **已完成**：Schema v31 为 Fact 增加独立验证状态；画布提供 Facts 标签、服务端 keyset 分页与筛选、结构化证据/来源详情和人工验证动作。旧的幽灵 `/canvas-nodes/{id}/verification` 契约已删除，读写统一限定在 `/canvases/{id}/facts` 项目作用域内。 |
| Agent CLI Session 时间线归一化 | #160 | **已完成**（Issue 起因是 Claude）：`queue-operation enqueue` 中带平台前缀的画布增量显示为广播，消费/移除记录不产生噪声；`user` 包装的纯 `tool_result` 不再虚增用户消息，assistant 的 thinking/text/tool_use 按原始块顺序展示且 usage 只累计一次；当前五类治理 CLI 各自解析归档格式，广播仅在归档持久化时展示。 |
| Compose 任务 | #273 | **已落地**：同项目未否定处置 Finding（含 pending 等未确认）作为 1–8 条冻结只读种子；不复制 Finding、不进入本画布 Verify。Graph 隐藏项目 Finding UUID 并投影 `compose_scope`；Hub 禁止未绑定种子的 explore/audit；`emit_finding` 拒收越界新资产；重试前重新校验且不因未确认而 stale。见 §6.1。 |
| s33 启动门禁 / Attempt outcome / 网关预热 | — | **已修复**：startup warmup 不再把 `project_opt_in` 镜像当作 dispatcher 前置（官方 Base/Audit/Kali 仍 fail-closed）；`/health` 暴露 dispatcher+warmup，连续失败打 error 级「dispatcher disabled」；`mark_job_done` 按 8192 UTF-8 字节收口，Attempt outcome 只存 summary hash/bytes；managed gateway 在 real boot 预热，Created leftover 超时必清，`docker run` 使用独立超时；skill-source boot sync 有显式超时且不阻塞 listen。 |
| aliyun-acr warmup OSS 超时与 helper | #228 | **已完成**：startup inspect 以冻结 digest / image Id 为就绪条件，不要求 RepoDigests 等于当前通道仓库名；选定通道 `docker pull` 因 timeout/EOF/OSS `httpReadSeeker` 失败时，对清单已核实的同 digest 其它通道（dockerhub/github）重试一次，不改 `runtime_registry_channel`、不改写历史 Job 快照；`/health.runtime_images.error` 区分「channel timed out, same-digest fallback attempted」与「digest not found」；默认 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 纳入 startup warmup，fake 仍不使用 helper。Job 执行期仍只 inspect，不隐式 pull。 |
| 通道切换不因 in-flight 准备 409 锁死 | #278 | **已完成**：`PATCH /runtime-images/registry/channel` 在已有准备任务时返回当前 `pull-status`（202），不把 busy 当硬失败；同 digest 复用准备锁，通道切换可抢占 `admin_bulk`；准备任务异常退出离开 `queued`/`running`。Web 下拉保持 pending 目标通道，完成后自动重试落库；进行中禁用重入。缺图仍不落库，Job 执行期仍只 inspect。 |
| 凭据删除不受可恢复 Job 永久锁死 | #234 | **已完成**：`DELETE /credentials/:id` 只拦 `pending_unclaimed` 与 `active_frozen`（claimed/provisioning/running/waiting_human）。`failed/timeout/orphan` 与 `succeeded/cancelled` 一样：影响投影照列，确认框可提示删除后不能按原快照 resume，但不 409。删除仍与 resume 串行加锁，不自动恢复、不改写冻结快照。 |
| 态势普通数据看板 | #242 | **P0 已落地**：`/` 运营总览（总量/状态分布/近 7 日/活跃项目 Top N/最近活动）+ 关注队列仍为处置入口；`GET /dashboard/overview` 做轻量聚合，因 Job/Finding 列表有窗口上限。**P1 风险看板、P2 吞吐看板未做。** |
| Windows deploy.ps1 编码与 pull 语义 | #243 | **已完成**：`deploy.ps1` 以 UTF-8 BOM 保存且正文仅 ASCII，避免 Windows PowerShell 5.1 按系统代码页把中文/全角标点解析成 ParserError；`pull`/`up` 与 `deploy.sh` 对齐（默认 real + 拉 ACR 应用镜像；优先官方 `deepsonar-assets-helper` / `deepsonar-silo`，缺失回退 busybox pin / pgsty silo；`-Source build` 才本地 `--build`；`-NoBuild` 仍映射为 pull）。推荐终端 `pwsh`。 |
| 任务下发后就地改标题与内容 | #251 | **已完成**：`PATCH /tasks/:canvasId` 更新 `canvases.title` 与 `target_json.title/content/goal`，并同步 root 节点标题/body；只影响后续 Hub 读图、新派生 Job 与显式重试，不改写已冻结 `agent_snapshot_json`。工作台「任务内容」对未归档且具 `tasks:write` 的主体可编辑保存；viewer 只读。 |
| Chrome / 长工具 stall 误杀 | #257 | **已完成**：Reaper stall 仍以语义事件为主、默认 900s；`tool.call.started/completed` 写入进度事件与 `payload_json.runtime_activity`。在飞工具且 lease 未过期时不判停滞，使 clang-tidy / fuzz / 其它角色的长 Bash 不被 15 分钟静默窗口误杀。`deepsonar-chrome-audit/test` 下限 5400s、`deepsonar-chrome-fuzz` 10800s；不抬高全局 `DEEPSONAR_JOB_STALL_SEC`。无工具活动的普通 Job 仍在 900s 后收口。 |
| 配置中心 / 运行时护栏 | #263 | **Batch 1 已落地**：平台默认写入 `global_settings.rules_json`；角色覆盖在 `role_configs.runtime_knobs_json`；Job 冻结 `agent_snapshot_json.runtime_knobs`。覆盖 `stallSec`、`jobTokenMaxRequests`（0=不限制）、`auditTimeoutSec` / `verifyTimeoutSec`、`provisionTimeoutSec`（仅平台）。Web 配置中心可改，保存走既有 toast + `settings.global_update` / `settings.project_update` / `role_config.upsert` 审计。后续批次（lease / Reaper 间隔 / Gateway 超时 / 镜像 pins 与巡检）仍走部署 env。 |
| 官方运行时不预装决策扫描器 | #267 / #266 | **已完成**：官方 base/audit/kali/chrome/openharmony 只提供基础工具；移除 Semgrep / gitleaks / shellcheck 与 Chrome 固定扫描规则/入口。Finding 质量靠 harness + Verify，不复现企业 SAST/密钥扫描。合入后须发版重建 `deepsonar-audit`、`deepsonar-kali-minimal`、`deepsonar-chrome-audit`。 |
| 人工介入折叠与忽略 | #277 | **已完成**：介入条/消息面板默认可折叠并隐藏历史；介入项可不回复直接隐藏，并可在历史中取消隐藏；操作员回复成功的来源介入项按用户+任务视为已回复并随已处理项隐藏。UI 偏好不改变服务端 `open`/`ignored` 语义；`POST /canvases/:id/human-nodes/:nodeId/ignore` 将 open human 节点标 ignored，waiting_human Job 恢复 pending 后继续。 |
| rebuild / 启动序列对齐 | #281 | **已完成**：`OVERRIDING SYSTEM VALUE` 回填后只对 public 上 IDENTITY/serial 做 `setval(MAX)`；rebuild 结束与 Scheduler 启动自动对齐并 fail closed。不改 append-only，审计 PK 仍是 IDENTITY。 |

## 12. 仓库地图

| 路径 | 职责 |
|------|------|
| `apps/scheduler` | Fastify API、dispatcher、core、verify、report、gateway |
| `apps/web` | React 工作台与画布 |
| `apps/image-admission` | 第三方镜像扫描准入 |
| `packages/runtime-sandbox` | SandboxRunner / agentbox |
| `packages/plane-client` | 可选 Plane 集成的类型化 API client；默认本地任务主路径不依赖 Plane |
| `packages/shared-types` | zod 事件与 payload 单源 |
| `database/schema.sql` | 唯一 schema 基线（当前 v37）；空库套用、非空只校验版本与结构；改表 bump `SCHEMA_VERSION` 后重建库。运维可用 `pnpm db:rebuild` 备份并按列交集回填；启动仍不做增量升级，但会自动对齐并校验 owned sequences |
| `deploy/` | 生产与 real 模式编排 |

## 13. 给实现者的硬约束

### 13.1 Agent 控制面输入 doctrine（D1–D6）

1. **D1 默认拒绝**：每个工具 `additionalProperties: false`；未知字段返回 `unknown_field`，不得 strip 后部分落库。
2. **D2 标识符标准形态**：节点/边只认当前画布 `referableIds` 中的 canonical UUID；Finding 绑定只认数据库 Finding UUID；角色只认本轮 `list_available_roles`；未来路径工具只认白名单前缀。
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
- `.github/workflows/ci.yml` / `chrome-runtime.yml` / `openharmony-runtime.yml` / `release.yml` — 构建、验证与发布门禁
- GitHub Issues — 未完成能力和后续方案
- `AGENTS.md` / `CLAUDE.md` — 给编码 Agent 的操作手册
