# DeepSonar 系统规格

> 状态：**as-built + 规范缺口登记**（#741 PR 2）。正文把规范要求、当前代码事实和验收入口分开；“进行中/实现违约”不表示已达标。
> 同步日期：2026-10-30

本文是编号需求的唯一权威位置。规范要求使用“必须/不得”；“代码入口”指向实际代码、schema 或 OpenAPI，“决策来源”记录约束依据，“实现状态”描述当前实现是否满足该陈述，“验证证据”是可复现入口或人工核查方法，不是本次已经执行的结果。schema 主线版本以 [schema-version.ts](../../apps/scheduler/src/schema-version.ts) 和 [database/schema.sql](../../database/schema.sql) 为准。

## 1. 规格边界和术语

DeepSonar 的四层真相是：PostgreSQL/API 保存管理与审计真相，Canvas 保存过程真相，Sandbox/Evidence 保存执行与原始证据，Scheduler 是唯一有副作用的执行者。Artifact 是版本化内部写入真相，Fact 是观察或验证证据，Finding 是可查询风险投影，Report 是冻结输入后的交付投影。下文把 Canvas、Fact、Artifact、Device、shared assets 和 transfer 分别归入独立域，避免把它们混为 Job 或 Finding 的字段。

本文件不把长期 Plan 全量调度、任务/会话级 Pack 生命周期、跨任务经验推荐、全图权威布局或跨进程持久 resume 写成当前能力；这些若作为规范目标，均标为暂缓或未实现。代码事实与规范不一致时保留规范陈述并登记实现违约，不能反向降低规范。

## 2. 功能需求

### FR-TASK-001 创建项目任务画布

- **规范要求**：系统必须允许在活跃项目下创建任务；每次创建必须对应一张 Canvas，并把目标、约束和触发来源写入画布，不得在已归档项目上新建任务或建立绕过 Canvas 的第二任务真相。
- **决策来源**：Canvas 是 Hub、Job、Fact、Finding 和 Report 的共同边界，项目 scope 需要在创建时确定。
- **实现状态**：as-built；`canvases` 以 `project_id` 外键保存任务并关联 Job。
- **代码入口**：[task 路由](../../apps/scheduler/src/domains/project-task/routes.ts)、[数据库基线](../../database/schema.sql)、[设计摘要](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:task-intent`、`pnpm ci:integration:task-intent`；人工核对 `POST /projects/{id}/tasks` 的 project scope 和 Canvas 行。

### FR-TASK-002 创建后派发 Hub Job

- **规范要求**：任务创建在可立即调度时必须由 Scheduler 派发首个 `hub_reason` Job，或按调度配置延迟启动；用户 API 和 Agent 不得绕过 Hub 直接伪造工作角色执行闭环。
- **决策来源**：Hub 是任务图上的决策者，首轮派发必须进入统一 Job/Attempt 生命周期。
- **实现状态**：as-built；任务入口通过 Scheduler 创建 `hub_reason` Job，Hub 角色不存在时 readiness/准入会拒绝。
- **代码入口**：[任务编排](../../apps/scheduler/src/task-compose.ts)、[Hub 编排](../../apps/scheduler/src/domains/hub-orchestration/)、[设计摘要](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:task-intent`、`pnpm ci:integration:task-intent`、`pnpm ci:smoke:hub`；人工核对新任务首个 Job 类型和不可绕过 Hub 的拒绝路径。

### FR-TASK-005 更新任务意图与冻结运行

- **规范要求**：系统必须允许更新空闲任务的标题/内容并供后续 Hub 和新 Job 使用；进行中的 Job 必须继续使用创建时的冻结快照，不得被 PATCH 静默改写。
- **决策来源**：任务编辑和执行可并行，历史执行必须可解释、可复现。
- **实现状态**：as-built；代码明确区分 `TASK_INTENT_SAVED_IDLE` 与 `TASK_INTENT_SAVED_RUNNING`，Job 读取 `agent_snapshot_json`。
- **代码入口**：[任务意图模型](../../apps/scheduler/src/task-intent.ts)、[任务路由](../../apps/scheduler/src/domains/project-task/routes.ts)、[Job schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:task-intent`、`pnpm ci:integration:task-intent`；人工核对进行中 Job 的 snapshot 与 PATCH 前后不变。

### FR-TASK-003 外部事件创建任务幂等

- **规范要求**：系统必须按项目、来源和 `event_id` 去重事件触发，重复投递必须返回原 Canvas/入口 Job，不得重复建立执行链。
- **决策来源**：Webhook、重试和消息投递可能重复，任务入口需要 durable 幂等键。
- **实现状态**：as-built；`POST /projects/:id/events` 在项目任务路由中组装 `event:${source}:${event_id}` 并由 `canvases_trigger_uniq` 与 Job ingress 幂等共同提供边界；运行中 Job 的语义事件摄入属于另一条受治理路径。
- **代码入口**：[项目任务路由](../../apps/scheduler/src/domains/project-task/routes.ts)、[任务编排](../../apps/scheduler/src/task-compose.ts)、[schema 中的 Canvas 唯一索引](../../database/schema.sql)、[OpenAPI](../../apps/scheduler/src/openapi.ts)。
- **验证证据**：`pnpm ci:integration:event-ingestion`、`pnpm ci:integration:event-authorization`；人工重复发送相同 `event_id` 并核对返回身份。

### FR-TASK-004 任务生命周期、归档与受限继续执行

- **规范要求**：系统必须支持任务启动、暂停、继续执行、重试、取消、归档和取消归档，并保留归档任务的 Canvas、Job、Evidence 与 Report 引用；`resume-session` 只能恢复仍可识别的 Job/Attempt 账本或创建受治理的新执行，不得宣称跨进程恢复 CLI/模型会话；归档不得默默物理删除历史真相。
- **决策来源**：运维操作和审计需要可恢复的历史，取消必须传播到在途执行；跨进程 Session resume 没有当前实现证据，必须与任务级继续执行语义分开。
- **实现状态**：部分达标；任务归档/取消归档和受限 `resume-session` 入口已实现并保留历史引用，但跨进程 CLI/模型会话恢复不是当前能力；显式硬删除端点仍需按本规范人工区分。
- **代码入口**：[项目任务路由](../../apps/scheduler/src/domains/project-task/routes.ts)、[Job 重跑集成测试](../../apps/scheduler/src/job-rerun.integration.test.ts)、[恢复集成测试](../../apps/scheduler/src/recovery-issue186.integration.test.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:integration:job-lifecycle`、`pnpm ci:integration:recovery`；人工分别验证 archive/unarchive 与 `resume-session`，并核对没有把 Session archive 当作跨进程 resume（入口，未在本任务执行）。

### FR-TASK-006 版本化任务契约与派发前校验

- **规范要求**：系统必须支持可选版本化任务契约，保留原始需求及采用的模板版本/规范化快照；缺项返回字段级建议，不通过固定标题或字数评定质量。显式契约必须严格校验版本、结构与未知字段；契约只能收窄平台权限，不得自行证明身份、授权或前置条件。派发前必须按当前可信事实复核必要条件，不能沿用创建时的过期通过结果。
- **决策来源**：#767；减少不同创建者与入口造成的遗漏，同时保留非审计工程任务和自由文本输入。
- **实现状态**：结构化校验、共享场景模板和派发门禁已接线；已提供契约的 objective/targets/scope/evidence/acceptance 缺项在创建/派发阻塞，其他缺项给具体建议。没有契约时返回未评估提示，这条旧入口迁移尚未完成。没有可信核验器的目标身份、写授权、必需前置条件保持未核验并阻塞依赖链，不自动缩窄任务或声称动态验证已完成。自然语言语义分析、任意资产可达性/基线探测及真实模型质量收益尚无实现/评测证据。
- **代码入口**：[共享契约](../../packages/shared-types/src/task-contract.ts)、[创建路由](../../apps/scheduler/src/domains/project-task/routes.ts)、[Dispatcher](../../apps/scheduler/src/dispatcher.ts)、[下发指南](../../skills/deepsonar-management/references/task-dispatch.md)。
- **验证证据**：契约规范化、变形输入与安全边界行为测试；人工核对 API/Web/CLI 对同一结构化意图返回一致缺项/阻塞，并核对创建后撤销权限时派发拒绝。实际运行结果见 PR 验收记录，不以字段校验冒充模型效果评测。

### FR-TASK-007 通用任务标准与研究候选准入

- **规范要求**：已提供的任务契约必须在创建与派发前检查目标、资产、范围、证据与验收要求的基本完整性，不能通过省略 outcome 或选择 task_defined 绕过。研究候选必须绑定整个冻结契约与判据 Fact 引用；观察须独立保留，unknown/无关观察不计成果。赏金规则只作可选附加筛选，不由严重度或相似文本推导资格。
- **决策来源**：#767 / #794 通用任务下发主轴；#775 拥有目标版本、证据缺口和整体报告收敛。
- **实现状态**：首片接通关键字段完整性、整契约摘要、通用判据与赏金附加声明筛选；通过仅为 admitted_for_research，submission_eligibility 保持 not_assessed。至少一项 acceptance 贡献关联不代表全部目标满足。无契约旧入口仍 unassessed，迁移未完成。报告防误报已接确定性目标投影，不能将技术 confirmed 计为任务达标；独立复核、可复现证据、攻击链、knownness适用性、资格与整体报告收敛仍后续交付；真实模型验收不作为交付门槛，效果未验证。
- **代码入口**：[研究候选契约](../../packages/shared-types/src/task-outcome.ts)、[Finding 入口](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)、[Artifact](../../apps/scheduler/src/domains/artifacts/model.ts)、[首片边界](../TASK_OUTCOME_ADMISSION.md)。
- **验证证据**：通用完整性、outcome 不绕过、整契约版本、判据与 Fact/Artifact 来源、依据保存及冻结压缩传播行为测试；实际运行结果见 PR，不以研究候选计目标完成。

### FR-HUB-001 Scheduler 派生 Hub Job

- **规范要求**：系统必须由 Scheduler 在 Canvas 锁边界内派生 `hub_reason` Job；同一 Canvas 同时最多一个活跃 Hub。`verify_finding` 与 `report` 必须由 Scheduler 从 `finalizeJob`/画布状态派生，不得由 Hub Intent 直接扮演或改变收敛状态。
- **决策来源**：Hub 决策需串行化，防止并发 Intent、重复派发和跨状态写入。
- **实现状态**：as-built；Canvas 锁和活跃 Hub 查询在应用事务中执行。
- **代码入口**：[Hub 编排应用](../../apps/scheduler/src/domains/hub-orchestration/application.ts)、[Hub 策略](../../apps/scheduler/src/domains/hub-orchestration/policy.ts)、[finalizeJob](../../apps/scheduler/src/core.ts)、[事件副作用](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)、[Job schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:smoke:hub`、`pnpm ci:integration:convergence-recovery`。

### FR-HUB-002 Scheduler admission 与工作角色 Intent

- **规范要求**：Hub 只能提出工作角色 Intent（角色、能力、prompt、引用、预算和可选运行时镜像）；权限、引用合法性、预算、镜像与能力 admission 必须由 Scheduler 判定。模型不得通过 Intent 扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。
- **决策来源**：模型输出是提案，Job scope、快照和内核准入必须由 Scheduler 拥有。
- **实现状态**：as-built；Intent 进入事件摄入与各 admission 路径重新校验，越权字段拒绝。
- **代码入口**：[事件摄入副作用](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)、[能力准入](../../apps/scheduler/src/domains/capability-pack/)、[镜像边界](../../apps/scheduler/src/domains/role-runtime-snapshot/runtime-image-boundary-policy.ts)、[Control operation registry](../../apps/scheduler/src/domains/platform-api/operations.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:bounded-contexts`、`pnpm ci:integration:platform-api`；人工提交扩大工具、凭据、镜像、出网或项目范围的 Intent 并核对拒绝。

### FR-HUB-003 Canonical UUID 引用

- **规范要求**：Hub 只能引用当前画布已投影的 canonical UUID；Finding 绑定必须使用数据库 Finding UUID。字段名、别名、跨画布 ID 和占位符必须拒绝。
- **决策来源**：引用集是提案可审计的边界，不能让模型凭标题或猜测 ID 改写事实。
- **实现状态**：as-built；compose scope 和 `referable_ids` 校验会拒绝跨 Canvas/非 canonical 引用。
- **代码入口**：[图与引用校验](../../apps/scheduler/src/graph.ts)、[Hub Intent 校验](../../apps/scheduler/src/domains/hub-orchestration/application.ts)、[任务编排作用域断言](../../apps/scheduler/src/task-compose.ts)。
- **验证证据**：`pnpm ci:unit:graph-references`、`pnpm ci:integration:graph-references`、`pnpm ci:integration:task-intent`；人工提交别名、占位符和跨画布 UUID。

### FR-HUB-006 角色目录驱动派发

- **规范要求**：Hub 必须通过受治理的 `list_available_roles` 读取当前数据库角色目录，再提交合法角色；不得依赖代码内固定角色枚举或把管理角色、系统 Verify/Report 角色暴露为可派发工作角色。
- **决策来源**：角色是可编辑的能力组合，运行时目录是唯一事实来源；固定枚举会造成配置漂移。
- **实现状态**：as-built；Hub 决策在 Scheduler 再次按同一项目边界校验角色。
- **代码入口**：[角色快照](../../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)、[平台操作](../../apps/scheduler/src/domains/platform-api/operations.ts)、[角色 schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:capability-pack`；人工新增/删除项目角色后核对下一轮目录。

### FR-HUB-004 收敛、验证唤醒与可观测停止

- **规范要求**：Hub 必须在角色 Job 终态后按事件触发下一轮或 Report；Verify 等待证据时必须按证据签名/门禁指纹唤醒，重复无进展达到配置上限时必须记录停止原因并可请求人工，不得静默空转。
- **决策来源**：事件驱动避免定时轮询，证据未变化时需要明确阻塞而不是无限派发。
- **实现状态**：as-built；`maxNoProgressRounds` 默认 2，正向预算和暂停原因均持久化。
- **代码入口**：[Hub 编排](../../apps/scheduler/src/domains/hub-orchestration/application.ts)、[Hub 策略](../../apps/scheduler/src/domains/hub-orchestration/policy.ts)、[配置](../../apps/scheduler/src/config.ts)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:integration:convergence-recovery`、`pnpm ci:smoke:convergence`。

### FR-HUB-005 决策必须有可执行理由和提示词

- **规范要求**：Hub 提交每个 Intent 时必须提供非空、自包含 prompt 和合法引用；首次决策不得在没有执行证据时直接宣称完成，完成、继续、阻塞和请求人工必须走结构化决策。
- **决策来源**：模型输出是提案，平台需要可审计的意图和可执行输入，不能把自然语言结论当终态。
- **实现状态**：as-built；`submit_hub_decision` 和 Intent schema 在 Scheduler 端拒绝缺 prompt/非法引用。显式 Plan 的可选 plan_basis 首片绑定当前版本和来源，一次补证后必须停止或基于全判据正向操作员授权完成；不替代语义评测。
- **代码入口**：[Control 输入](../../apps/scheduler/src/control-input.ts)、[Hub application](../../apps/scheduler/src/domains/hub-orchestration/application.ts)、[任务契约测试](../../apps/scheduler/src/task-intent.contract.test.ts)。
- **验证证据**：`pnpm ci:unit:plan-protocol`、`pnpm ci:integration:plan-protocol`；`pnpm ci:unit:bounded-contexts`、`pnpm ci:smoke:hub`；人工提交空 prompt 或无证据 complete 应得到稳定错误。

### FR-JOB-001 Job 生命周期与 Attempt

- **规范要求**：系统必须维护 `pending → claimed → provisioning → running` 以及 `waiting_human`、`succeeded`、`failed`、`timeout`、`cancelled`、`orphan` 状态；Job 状态权威在 Scheduler，每次成功领取建立 Scheduler-owned Attempt，Agent 不得单独写 Job/Attempt 终态。
- **决策来源**：Job 是宏观生命周期，Attempt 是一次执行程序计数器，二者分离才能恢复和审计。
- **实现状态**：as-built；状态约束和单活跃 Attempt 唯一索引在 schema 中固定。
- **代码入口**：[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[Dispatcher](../../apps/scheduler/src/dispatcher.ts)、[Attempt model](../../apps/scheduler/src/domains/job-attempt/model.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:integration:job-lifecycle`、`pnpm ci:unit:scheduler-characterization`。

### FR-JOB-002 Claim 创建 Scheduler-owned Attempt

- **规范要求**：每次成功领取（claim）必须建立 Scheduler 拥有的 Attempt；Attempt 携带快照身份、沙箱身份、取消标记和效果账本，不得把 prompt 或 Provider 原文写入 Attempt 账本。
- **决策来源**：Attempt 是一次执行的审计边界，不能将模型原文混入生命周期账本。
- **实现状态**：as-built；claim 事务创建 Attempt 并保存受限字段。
- **代码入口**：[Attempt 应用](../../apps/scheduler/src/domains/job-attempt/)、[Dispatcher](../../apps/scheduler/src/dispatcher.ts)、[Attempt model](../../apps/scheduler/src/domains/job-attempt/model.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:scheduler-characterization`；人工抽查 Attempt 字段白名单。

### FR-JOB-003 finalizeJob 派生系统 Job

- **规范要求**：Job 成功收口（`finalizeJob`）后，Scheduler 必须按 Canvas 状态派生 Verify、Research（启用时）、下一轮 Hub 或 Report；Agent 不得自行创建系统 Job。
- **决策来源**：系统 Job 的派生必须受状态机、项目 scope 和幂等约束控制。
- **实现状态**：as-built；收口路径由 Scheduler 事务和画布收敛策略派生后续 Job。
- **代码入口**：[finalizeJob](../../apps/scheduler/src/core.ts)、[Verify](../../apps/scheduler/src/verify.ts)、[Report](../../apps/scheduler/src/report.ts)、[事件副作用](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)。
- **验证证据**：`pnpm ci:integration:convergence-recovery`、`pnpm ci:integration:finding-report`、`pnpm ci:unit:bounded-contexts`；人工提交 Agent 伪造系统 Job 应被拒绝。

### FR-JOB-004 外部效果先记账再执行

- **规范要求**：任何 provision、agent_run、destroy 等外部动作在调用外部系统前，必须先把 intent 写入 `job_attempt_effects` 且状态为 `effect_pending`，观察结果后再写 settlement；禁止先外部调用再补账本。
- **决策来源**：数据库状态和外部网络效果可能以不同顺序完成，效果账本是恢复与对账的唯一身份。
- **实现状态**：as-built；外部动作通过 effect identity 进入 pending → settled/unknown 路径。
- **代码入口**：[Attempt 应用](../../apps/scheduler/src/domains/job-attempt/application.ts)、[Effect schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:recovery`；人工故障注入核对没有“外部先行、账本后补”。

### FR-JOB-009 创建时冻结执行快照

- **规范要求**：系统必须在 Job 创建时冻结 CLI、Provider/model、运行时镜像 digest、工具/能力、Finding protocol、网络策略、设备需求和 runtime knobs；Dispatcher 运行时不得回读最新 RoleConfig 代替快照。
- **决策来源**：执行结果要能按当时的权限、镜像和配置重放审计。
- **实现状态**：as-built；快照身份和 schema 版本进入 `agent_snapshot_json`。
- **代码入口**：[运行时快照应用](../../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)、[Provider freeze](../../apps/scheduler/src/domains/provider-adapter/freeze.ts)、[Agent profile](../../apps/scheduler/src/agent-runtime-profile.ts)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:credential-compatibility`；人工在创建后修改角色并核对执行输入不变。

### FR-JOB-010 Claim、并发和 Lease

- **规范要求**：Scheduler 必须在持久化 claim、全局/项目并发和 lease 约束内领取 Job；Lease 续期必须绑定有效 Job/Attempt，过期或迟到回调不得重新取得执行权。
- **决策来源**：多 Scheduler 副本、重试和迟到网络回调不能造成双执行或跨项目资源占用。
- **实现状态**：as-built；claim 使用持久状态和锁，Lease TTL 默认 120 秒。
- **代码入口**：[Dispatch 控制](../../apps/scheduler/src/task-execution-control.ts)、[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[全局设置](../../apps/scheduler/src/config.ts)。
- **验证证据**：`pnpm ci:unit:dispatch-limits`、`pnpm ci:integration:dispatch-limits`；人工并发抢同一 Job 并核对最多一个 Attempt。

### FR-JOB-011 超时、取消和清理

- **规范要求**：Job 超时、取消或 Reaper 判停滞时必须先原子化状态/账本，再中止 provision、撤销 token、释放设备并清理沙箱；清理操作必须幂等。
- **决策来源**：外部进程和数据库状态可能以不同顺序完成，清理不能依赖单个网络回调成功。
- **实现状态**：as-built；取消、超时、停滞和设备释放复用统一路径。
- **代码入口**：[Job lifecycle recovery](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[资源清理](../../apps/scheduler/src/resource-cleanup.ts)、[Attempt cancellation](../../apps/scheduler/src/domains/job-attempt/provision-cancellation.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:runtime-cleanup`、`pnpm ci:smoke:opensandbox-reaper`。

### FR-JOB-005 未知外部效果禁止重放

- **规范要求**：当外部效果无法证明未发生（`effect_pending` / `unknown`，含崩溃、超时、取消后的未证实窗口）时，系统必须将 Attempt/Job 标为不可自动重放路径，通常进入 `orphan`/对账/人工路径，清理 Token、沙箱、画布同步和租约；`replay_policy` 不得被本次结算改宽。
- **决策来源**：未知效果是事实状态，不是普通 transient error；猜测重放可能重复创建资源或修改目标。
- **实现状态**：as-built；`effect_pending`/`unknown` 与 `replay_policy=never` 被单独处理并进入清理/对账路径。
- **代码入口**：[Attempt 应用](../../apps/scheduler/src/domains/job-attempt/application.ts)、[reconcile](../../apps/scheduler/src/reconcile.ts)、[Effect schema](../../database/schema.sql)、[工作台重试投影](../../apps/web/src)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:integration:recovery`、`pnpm ci:smoke:opensandbox-reconcile`；人工核对 unknown 不提示安全重放。

### FR-JOB-006 provision never_started 结算

- **规范要求**：若 provision 失败且从未绑定 `sandbox_id`、也未观察到迟到沙箱，必须记为 `settled` 且 outcome 为 `never_started`；一旦观察到迟到 sandbox handle、late destroy 失败，或沙箱已启动后的中断/timeout/cancel/orphan，仍必须按未知外部效果处理。
- **决策来源**：只有明确证明没有外部后果时才能安全结束；迟到 handle 或已启动迹象都必须保留 unknown 语义。
- **实现状态**：as-built；provision failure 分支区分 `never_started` 与 unknown/late handle。
- **代码入口**：[Attempt model](../../apps/scheduler/src/domains/job-attempt/model.ts)、[Attempt 应用](../../apps/scheduler/src/domains/job-attempt/application.ts)、[恢复测试](../../apps/scheduler/src/recovery-issue186.integration.test.ts)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:integration:recovery`；分别覆盖无 sandbox、迟到 sandbox 和运行中断场景。

### FR-JOB-007 reconcileOnBoot 启动恢复

- **规范要求**：Scheduler 启动时必须在 dispatcher/reaper 前完成 `reconcileOnBoot`：回收孤儿容器与共享资产卷；仅当 Attempt 仍在 `preparing` 且无效果记录时可回到 `pending`；provision 未知效果与 running 中断必须 orphan 并清理，禁止与新调度交错留下半终态。
- **决策来源**：启动恢复必须先处理上一进程的外部遗留，再开放新的领取，避免重复资源和半终态。
- **实现状态**：as-built；启动顺序与准备阶段条件分开实现，unknown 不回到 pending。
- **代码入口**：[reconcile](../../apps/scheduler/src/reconcile.ts)、[Scheduler 启动](../../apps/scheduler/src/index.ts)、[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:integration:recovery`、`pnpm ci:smoke:opensandbox-reconcile`；人工核对 dispatcher/reaper 只在 reconcile 完成后启动。

### FR-JOB-008 Reaper 与终态幂等

- **规范要求**：Reaper 必须由 Scheduler 判定 timeout、stall、orphan 与 `waiting_human` 超时，不得信任 Agent 自报；取消、超时、迟到回调、容器创建与销毁必须走幂等路径，不得 resurrect 终态 Job。
- **决策来源**：运维判定和外部清理是平台责任，迟到回调不能重新取得执行权。
- **实现状态**：as-built；Reaper 和状态条件更新复用 Job/Attempt effect identity。
- **代码入口**：[Dispatcher/Reaper](../../apps/scheduler/src/dispatcher.ts)、[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[配置](../../apps/scheduler/src/config.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:runtime-cleanup`、`pnpm ci:smoke:opensandbox-reaper`；人工重复取消/迟到回调核对稳定结果。

### FR-JOB-014 重试创建新 Attempt

- **规范要求**：可重试的 provision、stream 截断或上下文超限必须以有界策略将 Job 重新排队并创建新 Attempt；不得复用已开始的 Attempt 或把未知 Effect 当成安全重试。
- **决策来源**：一次 Attempt 的资源和证据必须可独立结算，重试需要新的身份和审计链。
- **实现状态**：as-built；Job/Attempt 重试分别计数，外部效果按 replay policy 判定。
- **代码入口**：[Attempt application](../../apps/scheduler/src/domains/job-attempt/application.ts)、[Job control rerun](../../apps/scheduler/src/domains/job-control/rerun.ts)、[重试测试](../../apps/scheduler/src/dispatcher-provision-retry.test.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:integration:job-lifecycle`、`pnpm ci:integration:recovery`。

### FR-JOB-013 运行时配置按层收紧并冻结

- **规范要求**：对支持覆盖的 runtime knobs，解析顺序必须为 Job > role/project > platform > env，最终值必须冻结到 Job；role/project 只能在平台上限内收紧，env 仅作引导回退，`provisionTimeoutSec` 目前只接受 platform/env；未知或非法字段必须 fail closed。
- **决策来源**：配置覆盖是权限和资源边界，运行时隐式回退会绕过审计。
- **实现状态**：as-built；支持的 timeout 合法范围为 60–172800 秒，Job 创建另有 1–172800 秒边界；非所有 knobs 都支持 Job/role/project 覆盖。
- **代码入口**：[runtime knobs](../../apps/scheduler/src/runtime-knobs.ts)、[runtime knob tests](../../apps/scheduler/src/runtime-knobs.test.ts)、[sandbox limits](../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.ts)。
- **验证证据**：`pnpm ci:unit:dispatch-limits`、`pnpm ci:unit:bounded-contexts`；人工提交未知字段、超过平台上限和 `provisionTimeoutSec` 的非法低层覆盖。

### FR-CTRL-001 API-only Control 与 RepairFeedback

- **规范要求**：Agent 控制面必须 API-only，不得回退 MCP、普通文本或 CLI 控制文件；对 schema、权限、工具不允许和作用域失败的严格拒绝路径，必须返回版本化 `RepairFeedback`。
- **决策来源**：控制面是 Agent 提案边界，结构化拒绝才能保持 Job scope、审计和修复闭环。
- **实现状态**：部分达标（Phase 1）；部分 Control schema/语义 payload 拒绝路径已返回 RepairFeedback，但 Hub、Verify、Completion Gate 和完整 Proposal/Receipt/Settlement 尚未统一，不把覆盖缺口写成 as-built。
- **代码入口**：[RepairFeedback 类型](../../packages/shared-types/src/repair-feedback.ts)、[平台修复构造](../../apps/scheduler/src/domains/platform-api/repair.ts)、[Control routes](../../apps/scheduler/src/domains/platform-api/routes.ts)。
- **验证证据**：`pnpm ci:smoke:control-api`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:capability-pack`；人工提交 MCP/文本回退应被拒绝。

### FR-CTRL-002 RepairFeedback 失败分类

- **规范要求**：`RepairFeedback.category` 至少必须区分 `model_correctable`、`transient_retryable`、`unknown_external_effect`、`permanent_failure`；可修正失败必须给出 `next_action`/期望形状信息，unknown 不得暗示模型可猜测重放。
- **决策来源**：错误类别决定模型能否修复、平台是否可重试以及是否必须人工对账。
- **实现状态**：as-built；Control 拒绝路径使用稳定分类，未知外部效果不返回安全重试建议。
- **代码入口**：[RepairFeedback 类型](../../packages/shared-types/src/repair-feedback.ts)、[repair 分类](../../apps/scheduler/src/domains/platform-api/repair.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`；覆盖四类 category 和 next_action/shape。

### FR-CTRL-003 observed_shape 脱敏

- **规范要求**：`observed_shape` 只能包含类型、长度、计数等形状信息，不得把凭据、Provider 原文、完整不可信输入或内部堆栈复制进模型上下文。
- **决策来源**：修复反馈需要说明形状但不能扩大泄密面。
- **实现状态**：as-built；反馈仅保留脱敏 shape/摘要。
- **代码入口**：[RepairFeedback shared types](../../packages/shared-types/src/repair-feedback.ts) `describeObservedShape`、[平台修复构造](../../apps/scheduler/src/domains/platform-api/repair.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`；人工抽查拒绝响应无 secret/provider 原文。

### FR-CTRL-007 Job Capability Token 与操作白名单

- **规范要求**：真实 Job 必须使用短期 Job-scoped capability token 调用 Control API，token 只允许快照中的 operation ids 和有效期内的 Job；不得用管理 Token、沙箱内长期凭据或项目 API 猜测替代。
- **决策来源**：Control API 是 Agent 提案边界，权限应随 Job 快照收紧并可撤销。
- **实现状态**：as-built；token 只持久化 hash/prefix，Job 终态撤销。
- **代码入口**：[Control routes](../../apps/scheduler/src/domains/platform-api/routes.ts)、[Token store](../../apps/scheduler/src/domains/platform-api/tokens.ts)、[token schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`、`pnpm ci:smoke:control-api`。

### FR-CTRL-008 三层严格校验与未知字段拒绝

- **规范要求**：每个 Control operation 必须经过 shared Zod/schema、HTTP handler 和 event-ingestion/application transaction 三层校验；未知字段、非法类型、错误 project/canvas/job 引用必须拒绝，不得静默丢字段。
- **决策来源**：模型输入不可信，单层校验不能保证边界在不同入口一致。
- **实现状态**：as-built；错误 code 与人类消息由 Control input 集中定义。
- **代码入口**：[shared Control schema](../../packages/shared-types/src/index.ts)、[control input](../../apps/scheduler/src/control-input.ts)、[event ingestion](../../apps/scheduler/src/domains/event-ingestion/application.ts)。
- **验证证据**：`pnpm ci:smoke:control-api`、`pnpm ci:unit:bounded-contexts`、`pnpm ci:integration:platform-api`。

### FR-CTRL-009 幂等键、事件去重和速率预算

- **规范要求**：写入型 Control operation 必须使用 Idempotency-Key、event identity 或 effect identity；重复 event/事件去重必须返回原结果或稳定冲突，不得重复执行；语义事件必须按独立桶限流。HTTP API 的进程内 `idempotencyCache` 只能是优化，不能宣称跨副本 durable receipt；durable 去重以事件/效果账本、数据库约束和事务路径为准。
- **决策来源**：网络重试不能重复写入 Fact、Finding、Asset 或终态，进度噪声不能阻塞 done/human。
- **实现状态**：部分达标；Event、Attempt Effect、Report version 和 asset version 有持久身份约束，但 `idempotencyCache` 当前为进程内缓存，重启/跨副本不提供 durable HTTP receipt；默认窗口 60 秒、progress/standard/terminal 为 30/120/8。
- **代码入口**：[平台 API routes](../../apps/scheduler/src/domains/platform-api/routes.ts)、[平台 API registry](../../apps/scheduler/src/domains/platform-api/registry.ts)、[事件摄入](../../apps/scheduler/src/domains/event-ingestion/application.ts)、[事件限流](../../apps/scheduler/src/domains/event-ingestion/rate-limit.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:event-rate-limit`、`pnpm ci:integration:event-rate-limit`、`pnpm ci:integration:platform-api`；人工跨进程/重启核对 HTTP cache 不被当作权威 receipt。

### FR-CTRL-004 受治理语义事件写入

- **规范要求**：Agent 必须通过 `emit_progress`、`emit_fact`、`emit_finding`、`mark_job_done`、`request_human` 等注册 operation 提案语义事件；普通文本、CLI 输出、伪造工具调用、Shell 控制文件或管理 API 不得被当作语义状态。
- **决策来源**：只有结构化、带 Job 身份的事件才能进入事实和状态机。
- **实现状态**：as-built；未授权 operation 与禁止控制文件会 fail closed。
- **代码入口**：[operation definitions](../../apps/scheduler/src/domains/platform-api/operations.ts)、[Control input](../../apps/scheduler/src/control-input.ts)、[平台控制 Skill 测试](../../apps/scheduler/src/platform-control-skill.test.ts)。
- **验证证据**：`pnpm ci:smoke:control-api`、`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:bounded-contexts`。

### FR-CTRL-005 标准 RepairFeedback

- **规范要求**：可由模型修正的 schema、引用、权限、状态和字节限制错误必须返回版本化 RepairFeedback，至少含 category、code、operation、path、脱敏 message/observed_shape、current_state_ref、accepted_effects、idempotency_key、proposal revision、repair attempt、remaining budget 和 next_action；不得回显凭据、Provider 原文、完整不可信输入或内部堆栈。
- **决策来源**：错误反馈需要足够修复信息又不能扩大泄密面；模型应重新读状态并用新 revision/key 修正。
- **实现状态**：部分达标（Phase 1）；当前共享类型和部分 Control 拒绝路径具备完整 envelope，Hub、Verify、Completion Gate 和完整 Proposal/Receipt/Settlement 仍未统一。 #776 B 为 mark_job_done 增加持久 revision/key 回执与拒绝额度，独立修正 token 已复用原 Gateway usage ledger 实现显式配置、累计熔断与未知停止；单次调用前输入成本上界仍未知，不代表绝对费用上限或通用完成门；C0 仅为具备当前图查询权限的 Hub 无效引用提供 scoped 刷新指引，不绑定图版本或扩展权限；C1 投影既有 Hub complete 门的有界缺失项，保留原判定与提交时重校验，不构成统一效果回执；见[完成回执专题](../REPAIR_FEEDBACK_DONE_REPAIR.md)。
- **代码入口**：[RepairFeedback shared types](../../packages/shared-types/src/repair-feedback.ts)、[平台修复构造](../../apps/scheduler/src/domains/platform-api/repair.ts)、[Repair tests](../../apps/scheduler/src/repair-feedback.test.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:executor-real`；人工核对反馈只含形状/摘要。

### FR-CTRL-006 失败分类与无控制通道回退

- **规范要求**：Scheduler 必须区分 `model_correctable`、`transient_retryable`、`unknown_external_effect`、`permanent_failure`；未知外部效果必须停止自动重放，权限/快照/版本错误必须 fail closed，不得回退到 MCP、普通文本或另一套控制通道。
- **决策来源**：不同失败的安全动作不同，回退通道会绕过 Job scope 和审计。
- **实现状态**：as-built（分类与 API 失败路径）；完整 Receipt/Settlement 目标尚未全部落地。
- **代码入口**：[trusted kernel 文档](../AI_NATIVE_TRUSTED_KERNEL.md)、[Control input](../../apps/scheduler/src/control-input.ts)、[Job recovery](../../apps/scheduler/src/domains/job-lifecycle/application.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:recovery`、`pnpm ci:smoke:control-api`。

### FR-CAP-007 Capability Pack 机器契约

- **规范要求**：Capability Pack 必须使用 `deepsonar.capability-pack/v1`，声明 id/version/scope/digest、inputs/outputs、platform_tools、网络权限、预算、失败策略和可选 evaluator；不得由 Pack 自行扩大 Job 的权限、镜像、凭据、出网或项目范围。
- **决策来源**：能力可组合但治理边界属于 Scheduler，Manifest 是选择契约而非授权令牌。
- **实现状态**：as-built；内置 Pack 与受信模块均生成不可变 digest。
- **代码入口**：[Capability Pack shared types](../../packages/shared-types/src/capability-pack.ts)、[Pack catalog](../../apps/scheduler/src/domains/capability-pack/catalog.ts)、[设计摘要](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`。

### FR-CAP-001 发现目录不等于授权

- **规范要求**：能力发现（目录/Manifest）不是授权。Scheduler 必须按项目范围、Job 快照、平台工具 allowlist、镜像兼容性和网络策略决定可执行集合；Pack、Skill、CLI、LSP 不得拥有第二执行通道。
- **决策来源**：Agent 可以自主选择能力，但实际权限必须由内核在当前 Job 边界内重新准入。
- **实现状态**：as-built；catalog/discovery 仅提供选择入口，admit 路径重新校验可执行集合。
- **代码入口**：[Capability Pack](../../apps/scheduler/src/domains/capability-pack/)、[CLI admission](../../apps/scheduler/src/domains/cli-capability/admit.ts)、[LSP admission](../../apps/scheduler/src/domains/language-server-capability/admit.ts)、[Extension admission](../../apps/scheduler/src/domains/extension-materialization/admit.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:cli-capability`、`pnpm ci:unit:language-server`；人工尝试扩展工具/镜像/出网/项目范围应被拒绝。

### FR-CAP-002 Job 级能力发现

- **规范要求**：当前 Job 必须提供有界只读的 `list_capabilities`、`search_capabilities`、`describe_capability`、`validate_composition`、`preview_materialization`；发现结果不得直接等同执行授权。
- **决策来源**：Agent 需要自主选择能力，Scheduler 仍须按快照、项目和镜像重新准入。
- **实现状态**：as-built；目录只投影摘要，详细契约需显式 describe。
- **代码入口**：[Capability discovery](../../apps/scheduler/src/domains/capability-pack/discovery.ts)、[operation registry](../../apps/scheduler/src/domains/platform-api/operations.ts)、[能力测试](../../apps/scheduler/src/domains/capability-pack/capability-pack.test.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`。

### FR-CAP-003 受治理 Skill 拉取

- **规范要求**：Agent 必须先从 trusted+enabled 源 `list_available_skills`/`search_skills` 取得 selector 与 content hash，再通过 `pull_skill` 拉取有界文件；拉取不得安装任意包或改变 Job 权限，不得读取未冻结或未授权来源。
- **决策来源**：业务 Skill 可插拔但不能成为绕过平台准入的安装入口。
- **实现状态**：as-built；内容 hash、源信任和 Job token 均重新校验。 #778 增加独立[离线适用证据校验](../../agent-harness/capability-applicability/README.md)，仅验证导出的一致性及 JSON 断言，不改变在线拉取或证明方法有效。
- **代码入口**：[Skill operation registry](../../apps/scheduler/src/domains/platform-api/operations.ts)、[Skill source route](../../apps/scheduler/src/domains/skill-source/routes.ts)、[Skill pull 测试](../../apps/scheduler/src/skill-pull.test.ts)。
- **验证证据**：`pnpm ci:unit:startup-gate`、`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`。

### FR-CAP-004 Capability 组合权限不扩张

- **规范要求**：`validate_composition` 和物化前校验必须拒绝超出冻结 platform_tools、allow_egress、镜像或项目范围的组合，并返回可修复或永久失败反馈；不得静默裁剪后执行未知组合。
- **决策来源**：模型提交的 Manifest 属于不可信提案，显式拒绝比隐式降级可审计。
- **实现状态**：as-built；权限扩张返回 `PERMISSION_ESCALATION` 类 RepairFeedback。
- **代码入口**：[Capability discovery](../../apps/scheduler/src/domains/capability-pack/discovery.ts)、[role snapshot policy](../../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)、[platform tools tighten 测试](../../apps/scheduler/src/domains/role-runtime-snapshot/platform-tools-tighten-697.test.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:bounded-contexts`。

### FR-CAP-005 受治理 LSP 与 CLI Capability

- **规范要求**：语言服务器和通用 CLI 必须以登记的 Capability Module/Pack 进入目录、经镜像兼容性与前置条件校验并冻结；Agent 不得在 Job 内任意安装 LSP/CLI 或以未准入命令静默降级，CLI 输出只能作为 Evidence/Fact 输入。
- **决策来源**：工具二进制和 JSON-RPC 面是供应链与执行权限边界，不能由任务内容任意改变。
- **实现状态**：as-built（首期模块/CLI）；其它语言服务器与后续工具保持目录缺失时 fail closed。
- **代码入口**：[LSP admission](../../apps/scheduler/src/domains/language-server-capability/admit.ts)、[CLI admission](../../apps/scheduler/src/domains/cli-capability/admit.ts)、[能力契约测试](../../apps/scheduler/src/domains/language-server-capability/language-server-capability.test.ts)。
- **验证证据**：`pnpm ci:unit:language-server`、`pnpm ci:unit:capability-pack`、`pnpm ci:images`。

### FR-CAP-008 能力选择证据审计

- **规范要求**：精确版本/hash 的配置选择、拉取、声明使用和独立结果应分别呈现；不得将 Job 成功、模型反馈或组合成功解释为单能力有效性，不建立第二经验账本。
- **实现状态**：#778 A 部分实现；离线报告关联本项目未撤销 Skill 与配置 Pack，实际使用、独立质量、成本归因和在线推荐仍未实现。
- **代码入口**：[离线证据报告](../../agent-harness/capability-evidence/report.mjs)。
- **验证证据**：`pnpm ci:unit:project-knowledge` 的合成行为测试；数据库导出与真实模型评测未执行。

### FR-CAP-006 Plan 协议的当前边界

- **规范要求**：系统若接收 Plan/PlanResult，必须版本化保存并校验 goal、任务、依赖、完成策略和预算；在尚未实现 Plan 驱动 Worker 派发前不得把 PlanResult 当作替代 Hub 收敛或 Job 终态。
- **决策来源**：长期协议可以被发现和记录，但不能与当前生产主路径混淆。
- **实现状态**：进行中；代码记录 Phase 1 Plan/Result，当前不会从该 operation 派发 Worker 或改变 Hub convergence。
- **代码入口**：[Plan protocol](../../apps/scheduler/src/domains/plan-protocol/application.ts)、[Plan tests](../../apps/scheduler/src/plan-protocol.test.ts)、[设计边界](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:plan-protocol`、`pnpm ci:integration:plan-protocol`；人工核对 PlanResult 不绕过 Hub/Job 状态机。

### FR-KNOW-001 项目知识的受治理生命周期

- **规范要求**：项目 Memory/Skill 必须保持稳定身份和不可变版本；草稿、候选和评测输入不得进入普通 Job 目录。整理必须由有来源的当前 Job 请求，经 maker 提案、独立 case×arm Job 试验、evaluator 与 reviewer 审查后才可原子激活；失败、缺证或未知效果不得晋升，旧 active 保留。每阶段只读取冻结且适合其 audience 的输入，实际使用须留下 usage/feedback 与持久 receipt；治理方法的项目 Skill 版本只影响后续 work，不得修改平台硬门。
- **决策来源**：Agent 只能提案，Scheduler 拥有权限、预算、证据、结算和恢复；详见[项目知识专题](../PROJECT_KNOWLEDGE.md)。
- **实现状态**：#752 独立试验分支已接线，schema v61；领域集成测试使用构造的 Job/Attempt 与证据，真实沙箱运行和模型效果尚无本条验收证据，不能推定通过。
- **代码入口**：[知识域](../../apps/scheduler/src/domains/project-knowledge/)；[schema 基线](../../database/schema.sql)；[Control 契约](../../packages/shared-types/src/project-knowledge.ts)。
- **验证证据**：`pnpm ci:unit:project-knowledge`、配置独立 `TEST_DATABASE_URL` 后 `pnpm ci:integration:project-knowledge`；真实沙箱和长期模型效果需 #777 独立试验记录，离线协议/预检已提供；不改变 #752 已完成的实现验收范围。

### FR-KNOW-002 跨项目 Skill 精确授权

- **规范要求**：项目知识默认私有；来源项目有 `projects:write` 权限的管理者只能授予接收项目已审批的精确 Skill 版本。授权不得审批草稿/候选、扩及未来版本，亦不得传递来源 Memory、Evidence、凭据或执行权限。Job 创建时冻结精确目录，读取时与当前版本/授权撤销及全局源和项目禁用的不可逆 epoch、源 instance 身份取交集；重新启用或重新授权不得扩大旧 Job 的冻结范围。
- **决策来源**：发现目录不是授权，跨项目复用只能以最小范围、可撤销的内容许可实现；详见[项目知识专题](../PROJECT_KNOWLEDGE.md)。
- **实现状态**：#752 独立试验分支已实现精确 grant、批准版本校验、冻结目录和读取复核；真实多副本和生产权限试验尚未执行。
- **代码入口**：[授权策略](../../apps/scheduler/src/domains/project-knowledge/grant-policy.ts)、[目录冻结](../../apps/scheduler/src/domains/project-knowledge/catalog-snapshot.ts)、[全局源快照](../../apps/scheduler/src/job-skill-catalog.ts)。
- **验证证据**：`pnpm ci:integration:project-knowledge`；人工以两个项目核对未审批版本拒授、旧 Job 不见新授权、撤销后拒读（生产环境未执行）。

### FR-CANVAS-001 Canvas 过程图与只读节点

- **规范要求**：Canvas 必须保存 root、Intent、Fact、Finding、Job 节点及有向边和 durable revision；Agent/Web 不得提交节点坐标或直接改写过程状态，坐标和投影由服务端/Web 布局逻辑生成。
- **决策来源**：Canvas 是过程真相，布局提示不能成为业务状态写入口。
- **实现状态**：as-built；节点/边变化写入 revision/change log，Web 读取投影。
- **代码入口**：[Canvas schema](../../database/schema.sql)、[Canvas routes](../../apps/scheduler/src/domains/canvas/routes.ts)、[Canvas sync](../../apps/web/src/canvas-sync.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:canvas-lifecycle`、`pnpm ci:unit:graph-references`。

### FR-CANVAS-002 有界 graph_query 与引用集

- **规范要求**：Canvas 查询必须按 Job scope、脱敏规则、调用次数和字节预算返回有界结果；每次结果必须标记截断/省略和 `referable_ids`，不得提供任意 `canvas_id`/`project_id` 越权查询。
- **决策来源**：上下文按需读取降低泄露和上下文失控风险，引用集是提交决策的可验证边界。
- **实现状态**：as-built；每 Job 默认最多 40 次、累计 512000 bytes，单类查询还有 hard cap。
- **代码入口**：[Graph Query](../../apps/scheduler/src/graph-query.ts)、[shared graph schemas](../../packages/shared-types/src/index.ts)、[Graph budget tests](../../apps/scheduler/src/graph-budget.test.ts)。
- **验证证据**：`pnpm ci:unit:graph-references`、`pnpm ci:integration:graph-references`。

### FR-CANVAS-003 durable 变更与广播账本

- **规范要求**：Canvas 节点/边变化必须进入 durable change log；向运行中 Worker 广播必须先记录 planned，再记录 injected/failed/unknown，不得因进程崩溃把未知投递当作已成功或自动重复注入。
- **决策来源**：实时 bus 只能加速，数据库和 evidence 才能补读和审计。
- **实现状态**：as-built；`canvas_broadcasts` 保存 effect_id、payload sha 和投递状态。
- **代码入口**：[Canvas updates](../../apps/scheduler/src/canvas-updates.ts)、[Canvas delta](../../apps/scheduler/src/canvas-delta.ts)、[broadcast contract](../../apps/scheduler/src/domains/canvas/broadcast-contract.ts)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:unit:web-facts`、`pnpm ci:unit:canvas-facts`。

### FR-CANVAS-004 人工消息两阶段 ACK

- **规范要求**：人工消息必须区分 planned/injected/acknowledged/unknown/failed；`injected` 只表示写入 Agent 输入，ACK 必须来自显式 `ack_human_message` operation，普通文本不得隐式确认。
- **决策来源**：运输成功不等于模型读取和处理成功，人工介入必须可追踪。
- **实现状态**：as-built；消息与 ACK 有独立时间戳和审计字段。
- **代码入口**：[human messages](../../apps/scheduler/src/domains/canvas/human-messages.ts)、[schema](../../database/schema.sql)、[Web message tests](../../apps/web/src/human-messages.test.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:web-facts`、`pnpm ci:integration:canvas-facts`。

### FR-ART-001 Artifact 作为内部写入真相

- **规范要求**：`emit_fact`/`emit_finding` 必须先写入版本化 Artifact，再投影 Canvas Fact/Finding；Artifact 必须包含 kind、schema_version、claims、evidence、relations 和 provenance，不能只保存 maker 文本。
- **决策来源**：内部真相需要版本、结构化声明、证据关系和来源，外部投影可按产品需要演进。
- **实现状态**：as-built；同一 artifact key 的新写入 supersede 旧 revision。
- **代码入口**：[Artifact model](../../apps/scheduler/src/domains/artifacts/model.ts)、[Artifact persistence](../../apps/scheduler/src/domains/artifacts/persist.ts)、[Artifact schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:finding-protocol`、`pnpm ci:integration:canvas-facts`。

### FR-ART-002 Artifact 关系与项目边界

- **规范要求**：Artifact claim/evidence/relation 必须使用受约束类型、ordinal 和摘要引用；关系只能指向同项目已有 Artifact，不得自指或跨项目挂接。
- **决策来源**：证据图必须可检查，关系范围不能突破租户隔离。
- **实现状态**：as-built；应用层和数据库约束共同阻止非法关系。
- **代码入口**：[Artifact persistence](../../apps/scheduler/src/domains/artifacts/persist.ts)、[schema constraints](../../database/schema.sql)、[Artifact tests](../../apps/scheduler/src/domains/artifacts/artifacts.test.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:finding-protocol`。

### FR-ART-003 Artifact 与投影状态分离

- **规范要求**：Artifact 的 submitted/superseded、Fact 的 verification_status、Finding 的 verify_status/disposition 和 Report 状态必须各自独立；投影失败不得改写内部 Artifact 或其历史版本。
- **决策来源**：不同状态由不同责任方拥有，合并会让报告或人工处置反向污染事实。
- **实现状态**：as-built；跨域状态在各自表和事务边界中维护。
- **代码入口**：[Artifact model](../../apps/scheduler/src/domains/artifacts/model.ts)、[Finding state matrix](../../apps/scheduler/src/finding-state-matrix.ts)、[报告实现](../../apps/scheduler/src/report.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:bounded-contexts`。

### FR-FACT-001 结构化 Fact 契约

- **规范要求**：Fact 必须从受治理 Control operation 写入 Canvas，携带明确标题/描述、来源 Job/Attempt、结构化观察或验证字段和可选 Artifact/Evidence；不得把普通文本 verdict 当作 Fact。
- **决策来源**：Verify 和 Report 只能消费可定位、可校验的观察证据。
- **实现状态**：as-built；事实节点与来源 Job 关联并支持 keyset 分页。
- **代码入口**：[Fact contract](../../apps/scheduler/src/domains/canvas/fact-contract.ts)、[Fact routes](../../apps/scheduler/src/domains/canvas/facts.ts)、[Canvas schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:canvas-facts`。

### FR-FACT-002 Fact 证据信任态独立

- **规范要求**：Fact 必须拥有独立的 `unverified/verifying/verified/rejected/needs_human` verification_status；人工更新 Fact 状态不得改写 Finding 的 verify_status 或 disposition，报告数量门禁只计入 verified Fact。
- **决策来源**：证据可信度与命题是否确认是不同维度。
- **实现状态**：as-built；数据库检查约束只允许 Fact 节点携带该字段。
- **代码入口**：[Fact verification](../../apps/scheduler/src/domains/canvas/fact-verification.ts)、[Fact UI](../../apps/web/src/FactDetailPanel.tsx)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:canvas-facts`、`pnpm ci:unit:web-facts`。

### FR-FACT-003 Fact 引用、来源和证据链

- **规范要求**：Verify 使用的每个 Fact 引用必须解析到真实 Canvas Fact，检查 finding 归属、source Job/role ownership、subject revision 与内容完整性；Artifact 四表缺行不能被误判为唯一悬空条件。
- **决策来源**：证据链既要阻断悬空/自证，也要保持 Artifact 与 Canvas Fact 的职责分离。
- **实现状态**：as-built；`used_fact_ids` 解析失败会进入 rework/阻断。
- **代码入口**：[Fact evidence trace](../../apps/scheduler/src/fact-evidence-trace.ts)、[Verify gate](../../apps/scheduler/src/verify-fact-gate.ts)、[trace tests](../../apps/scheduler/src/fact-evidence-trace.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:canvas-facts`、`pnpm ci:integration:finding-protocol`。

### FR-FIND-006 Finding 协议与系统重算

- **规范要求**：Finding 必须按冻结 protocol 选择 profile/category/severity/evidence/impact；受支持的 CVSS 3.1/4.0 vector 必须由 Scheduler 重算分数和 severity，Agent 提供的分数不得直接成为真相。
- **决策来源**：Finding 是风险投影，评分策略和允许 profile 必须由平台治理。
- **实现状态**：as-built；默认 profile 为 `security.vulnerability`，默认不强制评分但可按 protocol 配置。
- **代码入口**：[Finding protocol](../../apps/scheduler/src/finding-protocol.ts)、[Finding shared types](../../packages/shared-types/src/index.ts)、[协议测试](../../apps/scheduler/src/finding-protocol.test.ts)。
- **验证证据**：`pnpm ci:unit:finding-protocol`、`pnpm ci:integration:finding-protocol`。

### FR-FIND-001 结构化 Fact 进入 Finding

- **规范要求**：工作角色提交的结构化事实进入 Canvas 后，符合条件的发现必须落为 Finding；普通文本 verdict 不得计入 Verify 门禁。Fact 证据信任态与 Finding Verify 分责，Verify 不得重读 maker 结论当作证据。
- **决策来源**：Fact/Finding 分责是验证链路的边界，Finding 不能由 maker 文本直接确认。
- **实现状态**：as-built；Fact verification 与 Finding projection 使用独立状态和结构化输入。
- **代码入口**：[Fact verification](../../apps/scheduler/src/domains/canvas/fact-verification.ts)、[Finding verification](../../apps/scheduler/src/domains/finding-verification/)、[Finding state matrix](../../apps/scheduler/src/finding-state-matrix.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:finding-protocol`、`pnpm ci:integration:finding-protocol`。

### FR-FIND-002 Finding 唯一性与证据引用

- **规范要求**：同一 Job 的 Finding 必须以稳定 fingerprint 保留来源幂等；不同 Job/任务必须保留独立来源，保留来源 Job、Artifact、Canvas node 和 evidence_refs；不允许用标题文本替代 canonical Finding UUID 或跨项目引用。
- **决策来源**：来源、Verify、Report 和人工处置依赖稳定身份；#770 评审要求跨任务关联不得提前抹去独立来源。
- **实现状态**：as-built（#770 A）；Job+fingerprint 唯一索引和 canonical UUID 校验已落地；提交幂等与来源身份独立，同来源内容冲突拒绝，历史记录保留。
- **代码入口**：[Finding schema](../../database/schema.sql)、[Finding trace](../../apps/scheduler/src/finding-trace.ts)、[Graph reference validation](../../apps/scheduler/src/graph.ts)。
- **验证证据**：`pnpm ci:unit:finding-protocol`、`pnpm ci:unit:graph-references`、`pnpm ci:integration:finding-protocol`。

### FR-FIND-003 Verify 状态与人工处置分离

- **规范要求**：Finding 的 `verify_status` 必须与人工 `disposition` 独立维护；`confirmed_vuln` 只有在 verify_status=confirmed 时允许，人工误报/修复/归档不得反向改写技术验证态。
- **决策来源**：技术事实、业务处置和人工责任属于不同状态机。
- **实现状态**：as-built；非法组合返回稳定 `confirmed_vuln_requires_verify`。
- **代码入口**：[Finding state matrix](../../apps/scheduler/src/finding-state-matrix.ts)、[Finding disposition](../../apps/scheduler/src/finding-disposition.ts)、[Finding routes](../../apps/scheduler/src/domains/finding-verification/routes.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:finding-protocol`、`pnpm ci:integration:verify-eligibility`。

### FR-FIND-004 Finding 协作内容受约束

- **规范要求**：Finding 评论、外部链接、证据追踪和报告入口必须按 Finding project scope 授权并受字节/URL 长度约束；渲染必须将内容视为纯数据，不得执行 raw HTML/JS。
- **决策来源**：协作信息是外部不可信输入，既要可追踪又要防 XSS 和跨项目泄露。
- **实现状态**：as-built；OpenAPI scopes、长度约束与纯文本渲染已接线。
- **代码入口**：[Finding routes](../../apps/scheduler/src/domains/finding-verification/routes.ts)、[schema](../../database/schema.sql)、[Markdown/UI](../../apps/web/src/MarkdownView.tsx)。
- **验证证据**：`pnpm ci:unit:authz`、`pnpm ci:unit:web-facts`、`pnpm ci:integration:finding-protocol`。

### FR-FIND-005 Finding 状态投影与查询

- **规范要求**：系统必须提供按 project、profile、severity、verify_status、disposition 查询 Finding、证据链和项目汇总的管理 API；查询结果不得把 Research priority 或 Fact verification 状态混写成 Finding 技术状态。
- **决策来源**：管理面需要可筛选的风险对象，维度独立才能正确解释结果。
- **实现状态**：as-built；Finding、Fact、Research 各自投影字段。 #770 切片 B 在现有项目页接通游标分页与服务端多选/字面文本查询，列表和汇总共用筛选口径；资产/版本特征与跨任务关系尚未交付。
- **代码入口**：[OpenAPI Finding operations](../../apps/scheduler/src/openapi.ts)、[Finding summary](../../apps/scheduler/src/domains/finding-verification/project-findings-summary.ts)、[数据库索引](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:finding-protocol`、`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:web-facts`。

### FR-VERIFY-006 Fact-first 确认门禁

- **规范要求**：Verify/直接确认必须共用 versioned `fact_first` 策略，只消费结构化 Fact、Artifact、Evidence 和独立 Evaluation，不得从 maker 文本推断 confirmed；缺 supporting Fact、冲突、失败来源或 subject revision 不匹配必须阻断。
- **决策来源**：确认结论必须由独立、可复核的证据驱动。
- **实现状态**：as-built；策略 ID 为 `fact_first`、版本 1。
- **代码入口**：[Fact-first gate](../../apps/scheduler/src/verify-fact-gate.ts)、[Verify tests](../../apps/scheduler/src/verify-fact-first.test.ts)、[Verify eligibility tests](../../apps/scheduler/src/verify-eligibility.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:verify-eligibility`。

### FR-VERIFY-001 Scheduler 派生独立 Verify Job

- **规范要求**：关注级别内的 Finding 必须由 Scheduler 派生 `verify_finding` Job 进行独立复核；证据不足、冲突或版本不匹配时 Finding 不得被确认为 `confirmed`。
- **决策来源**：验证必须与产生 Finding 的工作角色解耦，避免 maker 自证。
- **实现状态**：as-built；Verify 路由与收口路径由 Scheduler 派生独立 Job。
- **代码入口**：[Verify](../../apps/scheduler/src/verify.ts)、[Finding verification](../../apps/scheduler/src/domains/finding-verification/)、[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:verify-eligibility`；人工核对无独立 Verify Job 时不能 confirmed。

### FR-VERIFY-002 高风险 Finding 的证据配对

- **规范要求**：`security.vulnerability`、`security.misconfig`、`security.secret` 的 confirmed 必须具备至少一个独立 review、一个合格 test 和空的 required missing；CTF/general 等未强制 profile 的配对缺口可作为 advisory，不得伪造为空。
- **决策来源**：安全 profile 需要独立复核与测试，其他场景保留事实契约的灵活性。
- **实现状态**：as-built；pair requirement 按 profile 计算，非安全 profile 保留 advisory。
- **代码入口**：[Verify gate](../../apps/scheduler/src/verify-fact-gate.ts)、[evidence chain](../../apps/scheduler/src/verify-evidence-chain.ts)、[gate tests](../../apps/scheduler/src/verify-gate-590.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:finding-protocol`。

### FR-VERIFY-003 used_fact_ids 解析与禁止自证

- **规范要求**：每个 `used_fact_id` 必须 EXISTS 解析到当前 Canvas Fact，Finding 归属与 source Job 必须有效且不得等于 Finding 原始 Job；悬空、跨 Finding、同源自证必须进入 rework/required missing。
- **决策来源**：只校验 payload 形状会允许伪造证据，来源 Job 不能为命题制造者本身。
- **实现状态**：as-built（#590 叠层）；悬空引用不会因缺 Artifact 行而误判。
- **代码入口**：[Verify gate resolver](../../apps/scheduler/src/verify-fact-gate.ts)、[evidence trace](../../apps/scheduler/src/fact-evidence-trace.ts)、[verify evidence tests](../../apps/scheduler/src/verify-evidence-chain.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:verify-eligibility`。

### FR-VERIFY-004 Verify Job 业务轮次与基础重试分离

- **规范要求**：Finding Verify 必须为每个业务验证轮次保存独立 round，并限制同一 Finding 同时最多一个活跃 Verify Job；Job 基础设施重试不得伪造新的业务 verdict 或覆盖旧证据。
- **决策来源**：验证轮次表达业务语义，Attempt 重试表达基础设施语义，二者生命周期不同。
- **实现状态**：as-built；`jobs_one_active_verify_per_finding` 和 round 唯一约束已落地。
- **代码入口**：[Verify routes](../../apps/scheduler/src/domains/finding-verification/routes.ts)、[schema](../../database/schema.sql)、[verification lifecycle tests](../../apps/scheduler/src/verify-confirmation-lifecycle.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:verify-eligibility`、`pnpm ci:unit:bounded-contexts`。

### FR-VERIFY-005 Verify 终态与无进展收口

- **规范要求**：Verify 必须将通过、否定、冲突、证据不足、不可判定和需人工映射为明确终态/缺项；否定 evidence 只能在完整结构化证据和成功来源 Job 下进入 refuted，冲突进入 inconclusive，不得用 needs_human 混淆。
- **决策来源**：终态决定 Hub、Report 和人工动作，错误映射会产生虚假确认或无限循环。
- **实现状态**：as-built；无进展默认护栏来自 `DEEPSONAR_MAX_NO_PROGRESS_ROUNDS` 默认 2。
- **代码入口**：[Fact-first follow-up](../../apps/scheduler/src/verify-fact-gate.ts)、[Finding state matrix](../../apps/scheduler/src/finding-state-matrix.ts)、[Verify terminal](../../apps/scheduler/src/verify-terminal.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:convergence-recovery`。

### FR-RSCH-001 Finding 语义去重

- **规范要求**：Research 必须以有界批次产生 canonical anchor、dedupe cluster、重复理由和保留全部来源 Finding 的映射；不得删除候选或修改 Finding 的 verify_status、severity、disposition。
- **决策来源**：研究排序辅助注意力，不能成为技术验证或人工处置的隐式写入者。
- **实现状态**：as-built；批次默认 8、最多 8 批，研究失败只记录 run。
- **代码入口**：[Research policy](../../apps/scheduler/src/domains/finding-research/policy.ts)、[Research application](../../apps/scheduler/src/domains/finding-research/application.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:finding-research`、`pnpm ci:integration:finding-research`。

### FR-RSCH-002 相对优先级而非严重度

- **规范要求**：Research priority 必须表示相对注意力排序并记录 model/prompt revision/reason；不得把 priority_score 写成 severity 或 Verify 门禁，也不得改变报告收敛条件。
- **决策来源**：排序是研究辅助维度，风险严重度和证据门禁有独立责任方。
- **实现状态**：as-built；排序理由明确说明不改 verify/severity/report。
- **代码入口**：[Research ranking](../../apps/scheduler/src/domains/finding-research/policy.ts)、[state matrix](../../apps/scheduler/src/finding-state-matrix.ts)、[Research tests](../../apps/scheduler/src/research-knownness-coverage.test.ts)。
- **验证证据**：`pnpm ci:unit:finding-research`、`pnpm ci:integration:finding-research`。

### FR-RSCH-003 研究失败隔离主事务

- **规范要求**：Research 写失败必须保存失败 run/错误并通过 savepoint 隔离，不得回滚主 Finding/Report 写入；失败结果必须在 API/画布上可见。
- **决策来源**：研究是可选增强，不能因模型/事务异常丢失已成立的事实或报告。
- **实现状态**：as-built；`runFindingResearchBestEffort` 使用 savepoint。
- **代码入口**：[Research best effort](../../apps/scheduler/src/domains/finding-research/application.ts)、[Research integration test](../../apps/scheduler/src/domains/finding-research/finding-research.integration.test.ts)。
- **验证证据**：`pnpm ci:unit:finding-research`、`pnpm ci:integration:finding-research`、`pnpm ci:unit:bounded-contexts`。

### FR-RPT-001 Task Report 冻结输入与版本

#775 A 将同 Canvas/项目 Plan 审计与明确操作员判据绑定纳入冻结报告。绑定需版本校验、成功 Job/Attempt 与实际留存 Evidence；撤销、过期、冲突和预算不足不得提升为满足。整体完成仍 unknown，模型 done/complete 不构成满足证明；详见 [实现范围](../PLAN_GAP_PROJECTION.md)。

- **规范要求**：Finding 确认后必须能生成冻结输入的 Finding Report；Canvas 收敛后必须能生成带 `report-input.json` 和 SHA-256 的版本化 Task Report。相同输入幂等复用，输入变化追加版本；报告投影失败不得改写内部 Fact/Finding/Artifact，覆盖门必须按精确 Finding ID 核对章节。
- **决策来源**：报告是投影，不应改变产生它的事实；版本和摘要是可重建、可审计的交付身份。
- **实现状态**：as-built；相同成功输入返回已有版本，失败/进行中同输入可复用版本。#767 报告片将完整任务契约/摘要、来源快照、研究准入/技术状态与判据缺口纳入冻结输入与 hash，变化追加版本。新报告统一确定性正文；无独立目标评审权威时有契约保持 blocked，无契约明确 not_assessed；技术数据仅作附录，模型不得覆盖目标结论。历史无投影输入不回写，见[报告防误报](../TASK_OUTCOME_REPORT.md)。
- **代码入口**：[Report implementation](../../apps/scheduler/src/report.ts)、[Report version](../../apps/scheduler/src/task-report-version.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:bounded-contexts`、`pnpm ci:integration:report-download`。

### FR-RPT-002 Finding Report 独立轨

- **规范要求**：单 Finding Report 必须绑定一条 Finding 和冻结输入，拥有独立版本/状态/markdown hash；不得推进 Canvas Root 或改写 Finding verify_status。
- **决策来源**：单项交付和任务级汇总有不同触发与失败边界。
- **实现状态**：as-built；`finding_reports` 与 `task_reports` 双轨保存。新 Finding Report 同样冻结目标投影并使用确定性正文，保留技术来源；不因单条 Finding 技术 confirmed 推导任务目标或提交资格达标。
- **代码入口**：[Report implementation](../../apps/scheduler/src/report.ts)、[Finding report routes](../../apps/scheduler/src/domains/report-convergence/routes.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:integration:finding-report`、`pnpm ci:unit:verify-eligibility`。

### FR-RPT-003 报告失败有界恢复

- **规范要求**：Task Report Job 终态失败时必须最多自动重试一次，超过预算必须把 Root 收口为 `report_failed` 并提供显式 retry 入口；不得用无限重试掩盖失败。
- **决策来源**：报告生成是可重试外部效果，但无限重试会阻塞任务并制造重复版本。
- **实现状态**：as-built；`MAX_AUTOMATIC_REPORT_RETRIES = 1`。
- **代码入口**：[Report failure recovery](../../apps/scheduler/src/report-failure-recovery.ts)、[Report tests](../../apps/scheduler/src/report-failure-recovery.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:bounded-contexts`、`pnpm ci:integration:report-download`。

### FR-RPT-004 报告下载与格式投影

- **规范要求**：系统必须提供经 project/Finding scope 授权的 Markdown 和 SARIF 下载，下载内容只能由冻结 Report 输入和已持久化结果生成；不得把 SARIF 当作模型内部唯一真相。
- **决策来源**：人和工具需要不同交付格式，内部 Artifact/Fact/Finding 仍需保留。
- **实现状态**：as-built；Task Report 提供 Markdown/SARIF，Finding Report 提供 Markdown。#767 目标投影为 contracted/invalid 时 SARIF results 为空并保留评价原因；无契约路径保留技术 confirmed 结果并标记 technical-only/任务未评估。两者均不能计任务达标，空结果不表示无技术问题。
- **代码入口**：[OpenAPI report operations](../../apps/scheduler/src/openapi.ts)、[Report routes](../../apps/scheduler/src/domains/report-convergence/routes.ts)、[下载测试](../../apps/scheduler/src/report-download.openapi.test.ts)。
- **验证证据**：`pnpm ci:unit:report-download-openapi`、`pnpm ci:integration:report-download`、`pnpm ci:unit:web-report-download`。

### FR-IMG-001 可信运行时镜像目录

- **规范要求**：运行时镜像必须来自平台目录，版本必须具备不可变 digest、contract/platform/tool/scan/signature 证据和 trusted 状态；Agent、Hub、任务内容不得提交任意 OCI 引用。
- **决策来源**：镜像是执行供应链和权限边界，产品身份与不可变版本必须分离。
- **实现状态**：部分达标；准入状态和 digest 约束在目录与 Job snapshot 中保存，签名/SBOM 结果取决于 trust policy 与 registry evidence；未启用签名策略时官方 catalog 可为 `signature: skipped`，真实验证仍需部署证据。
- **代码入口**：[runtime image schema](../../database/schema.sql)、[image routes](../../apps/scheduler/src/domains/runtime-image/routes.ts)、[registry contract](../../apps/scheduler/src/runtime-image-registry-contract.ts)。
- **验证证据**：`pnpm ci:unit:runtime-images`、`pnpm ci:unit:image-admission`、`pnpm ci:unit:runtime-registry`。

### FR-IMG-002 镜像准入、通道与 readiness

- **规范要求**：镜像发布/启用必须经扫描、批准、通道 evidence 和平台兼容性检查；启动 warmup 或通道 pull 未就绪时，Job 创建/派发必须返回可重试的 `runtime_image_not_ready`，不得使用未核验镜像。
- **决策来源**：目录存在不代表当前宿主或通道可执行，readiness 必须区别准备中、不可用和错误。
- **实现状态**：as-built；同 digest 通道重试最多使用一次额外 pull attempt，失败保持 fail closed。
- **代码入口**：[runtime image readiness](../../apps/scheduler/src/runtime-image-readiness.ts)、[pull/reconcile](../../apps/scheduler/src/runtime-image-reconcile.ts)、[image tests](../../apps/scheduler/src/runtime-image-readiness.test.ts)。
- **验证证据**：`pnpm ci:unit:runtime-images`、`pnpm ci:integration:runtime-image-channels`、`pnpm ci:unit:runtime-registry`。

### FR-IMG-003 Job 镜像解析与快照冻结

- **规范要求**：Hub 只能从本轮实时可用目录选择 image_key；Scheduler 必须检查 project 可见性、CLI 兼容性、trusted version 和平台，随后冻结 digest；Dispatcher 只能 inspect 冻结 ref，不得执行期回读目录或拉取任意 tag。
- **决策来源**：选择和执行之间不能产生供应链漂移，Job 历史必须追溯到当时 digest。
- **实现状态**：as-built；项目只能收紧可见集合，Job snapshot 不改写。
- **代码入口**：[Hub image capability](../../apps/scheduler/src/hub-runtime-image-capability.ts)、[image boundary policy](../../apps/scheduler/src/domains/role-runtime-snapshot/runtime-image-boundary-policy.ts)、[OpenAPI](../../apps/scheduler/src/openapi.ts)。
- **验证证据**：`pnpm ci:unit:runtime-images`、`pnpm ci:integration:hub-runtime-image`、`pnpm ci:unit:bounded-contexts`。

### FR-IMG-004 镜像拉取账本和回收

- **规范要求**：镜像拉取、重试、重启中断和本地 GC 必须有持久任务/证据；重启不得自动 resume 未知 pull，GC 只能删除 DB ref 账本确认且无受保护 Job/容器引用的 immutable ref，不得运行无边界 prune。
- **决策来源**：镜像 pull 是外部效果，回收错误会破坏在途或回滚所需资源。
- **实现状态**：as-built；pull task 重启标记 interrupted，自动估算和重试范围由源码限定。
- **代码入口**：[pull timeout](../../apps/scheduler/src/runtime-image-pull-timeout.ts)、[GC](../../apps/scheduler/src/runtime-image-gc.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:runtime-images`、`pnpm ci:smoke:opensandbox-reconcile`、`pnpm ci:unit:runtime-cleanup`。

### FR-CRED-001 凭据加密存储与安全投影

- **规范要求**：Provider/Git/OCI credential 必须由 Scheduler 加密保存，管理 API 只能返回受控 metadata/配置投影；长期 secret 不得进入 Job snapshot、Sandbox、Canvas、Evidence、日志或 transfer 普通数据。
- **决策来源**：凭据是内核资产，模型和执行沙箱只应获得短期、最小化的引用。
- **实现状态**：as-built；ciphertext/nonce/auth_tag 落库，secret 读取与管理响应分离。
- **代码入口**：[credentials schema](../../database/schema.sql)、[credential projection](../../apps/scheduler/src/domains/credential/projection.ts)、[secret projection](../../apps/scheduler/src/credential-secret-projection.ts)。
- **验证证据**：`pnpm ci:unit:credential-compatibility`、`pnpm ci:integration:credential-delete`、`pnpm ci:unit:authz`。

### FR-CRED-002 Provider/model catalog 与兼容性

- **规范要求**：Hub 选择 Provider/model 必须来自当前 Job 可见、active 且 CLI 兼容的 catalog；Provider 健康、模型目录和 alias policy 必须在快照解析时校验，不兼容或未知值必须 fail closed。
- **决策来源**：凭据、模型、CLI 和镜像是组合约束，不能由 prompt 绕过目录。
- **实现状态**：as-built；model catalog 默认不允许未知 alias passthrough。#757 的 readiness 与 Job 共用凭据先行解析：Provider/model/项目授权先筛候选，唯一账号决定 CLI，Hub 显式 CLI 保持硬约束；跨 CLI 多候选以项目/全局显式偏好消歧，种子 NULL 不构成偏好。白名单读取不自动种 ID，显式不可用引用要求管理员修复，不扩大授权。
- **代码入口**：[Provider adapter](../../apps/scheduler/src/domains/provider-adapter/catalog.ts)、[model admission](../../apps/scheduler/src/domains/provider-adapter/model-catalog-admit.ts)、[resolve credential](../../apps/scheduler/src/domains/provider-adapter/resolve-credential.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:credential-compatibility`、`pnpm ci:unit:provider-settings`、`pnpm ci:integration:role-config`（#757 假凭据与隔离数据库，含 readiness/快照一致性和历史快照不变）。

### FR-CRED-003 Model Gateway 唯一出口

- **规范要求**：真实模型请求必须经 Scheduler-owned Model Gateway/受控 proxy，Job 只持短期 token；Gateway 必须按 Job deadline、allowed_models、请求/Token 额度和脱敏规则转发，不得把长期 Provider key 注入 Sandbox。
- **决策来源**：模型请求是外部副作用和计费边界，统一出口才能限额、审计和撤销。
- **实现状态**：as-built；用量写入追加式 `job_usage_ledger`，不保存 prompt/completion/headers。
- **代码入口**：[Gateway](../../apps/scheduler/src/gateway.ts)、[Gateway guard](../../apps/scheduler/src/domains/provider-adapter/gateway-guard.ts)、[Gateway tests](../../apps/scheduler/src/gateway-usage.test.ts)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:credential-compatibility`、`pnpm ci:unit:runtime-sandbox`。

### FR-CRED-004 Token 额度与终态撤销

- **规范要求**：Job Gateway token 和 Control capability token 必须具有独立身份、有效期、请求/Token额度和撤销原因；Job 进入任何终态后必须撤销，不得跨 Job 复用。
- **决策来源**：不同调用面需要不同最小权限，终态后继续访问会形成迟到写入和费用泄露。
- **实现状态**：as-built；`job_tokens` 与 `job_capability_tokens` 分表维护。
- **代码入口**：[Gateway token lifecycle](../../apps/scheduler/src/gateway.ts)、[platform token store](../../apps/scheduler/src/domains/platform-api/tokens.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:capability-pack`、`pnpm ci:unit:job-lifecycle`。

### FR-CRED-005 Agent CLI 适配器边界

- **规范要求**：新 Job 只能使用当前登记的治理 CLI adapter（Claude Code、Pi、DSH）及其受支持配置；每个 adapter 必须有 runtime、session archive、Web parser、测试和原始归档路径，不支持的 CLI/config 必须 fail closed。
- **决策来源**：CLI 方言和归档结构是运行时契约，静默 fallback 会损坏执行和查看。
- **实现状态**：as-built（当前新执行集合）；历史归档 viewer 兼容不构成新运行时能力。
- **代码入口**：[CLI adapters](../../packages/runtime-sandbox/src)、[Agent CLI 文档](../AGENT_CLI_RUNTIME_ADAPTERS.md)、[adapter tests](../../apps/scheduler/src/agent-cli-convergence.test.ts)。
- **验证证据**：`pnpm ci:unit:credential-compatibility`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:web-session-viewer`。

### FR-WEB-001 六个任务工作台视图与 URL 真相

- **规范要求**：Web 必须提供 overview、canvas、facts、findings、jobs、report 六个一级视图，当前视图由 URL `tab` 决定；后台刷新不得强制切换用户视图，缺省必须进入 overview。
- **决策来源**：任务工作台需要稳定导航、可分享 URL 和刷新后上下文一致。
- **实现状态**：as-built；旧研究地图/运行别名只解析到 canonical key，不改变当前六视图。
- **代码入口**：[workbench tabs](../../apps/web/src/task-workbench/task-workbench-tabs.ts)、[workbench shell](../../apps/web/src/task-workbench/TaskWorkbenchShell.tsx)、[tab tests](../../apps/web/src/task-workbench/task-workbench-tabs.test.ts)。
- **验证证据**：`pnpm ci:unit:web-facts`；人工直接打开含 `tab`、筛选和选中对象的 URL 后刷新核对状态。

### FR-WEB-002 Canvas 只读投影与可见布局

- **规范要求**：Web Canvas 必须只消费服务端节点/边投影和布局提示，不能提交坐标或修改过程真相；可见投影、增量 cursor gap、搜索和展开必须有明确空态/错误态。
- **决策来源**：布局是展示层，Canvas/API 才是过程事实；读图预算和网络恢复需被用户看见。
- **实现状态**：as-built；可见投影使用 ELK/固定列策略；全图权威 layout_revision 仍暂缓，不写成当前能力。
- **代码入口**：[Canvas view](../../apps/web/src/CanvasView.tsx)、[layout](../../apps/web/src/layout.ts)、[Canvas sync](../../apps/web/src/canvas-sync.ts)。
- **验证证据**：`pnpm ci:unit:web-facts`、`pnpm ci:integration:canvas-lifecycle`；人工核对断线、空图和 cursor gap。

### FR-WEB-003 Fact/Finding/Job 详情和人工动作

- **规范要求**：Web 必须分别展示 Fact 证据信任态、Finding verify/disposition/证据链、Job Attempt/Session/工具流/人工消息/用量，并为需要权限的动作显示稳定错误；不得用一个“成功”标签合并这些状态。
- **决策来源**：不同状态机的责任方不同，用户需要知道执行完成、证据成立和业务处置是否分别完成。
- **实现状态**：as-built；工作台 Overview/Trace 明确区分 report stale、Fact conflict 和 Job 状态。
- **代码入口**：[Fact panel](../../apps/web/src/FactDetailPanel.tsx)、[Finding detail](../../apps/web/src/FindingDetailPanel.tsx)、[Job panel](../../apps/web/src/JobDetailPanel.tsx)。
- **验证证据**：`pnpm ci:unit:web-facts`、`pnpm ci:unit:verify-eligibility`；人工分别操作 Fact/Finding/Job 并核对不串写。

### FR-WEB-004 报告版本与交付状态

- **规范要求**：Web Report 视图必须展示当前/历史版本、生成状态、过时提示、失败/重试和 Markdown/SARIF 下载错误，不得在没有 succeeded Report 时显示“已交付”。
- **决策来源**：报告是独立投影且输入变化可使旧版本过时，UI 不能把生成请求当交付成功。
- **实现状态**：as-built；ReportPanel 使用版本选择和异步上下文 guard。
- **代码入口**：[Report panel](../../apps/web/src/ReportPanel.tsx)、[report view model](../../apps/web/src/report-views.ts)、[Report tests](../../apps/web/src/report-panel-state.test.ts)。
- **验证证据**：`pnpm ci:unit:web-report-download`、`pnpm ci:unit:web-facts`、`pnpm ci:integration:report-download`。

### FR-DEV-001 设备接入经 Broker 与租约

- **规范要求**：物理设备必须经 device broker 暴露为可租借 endpoint，设备租约必须绑定 Job/Attempt、独占并落库审计；沙箱不得直连或持有设备长期凭据。
- **决策来源**：设备是高风险外部资源，Broker 和租约是隔离、授权、回收的边界。
- **实现状态**：as-built（Phase 1）；当前受支持 transport/独占要求由代码校验。
- **代码入口**：[Device application](../../apps/scheduler/src/domains/device/index.ts)、[device schema](../../database/schema.sql)、[broker client](../../apps/scheduler/src/domains/device/broker-client.ts)。
- **验证证据**：`pnpm ci:unit:device-lease`、`pnpm ci:integration:device-lease`、`pnpm ci:smoke:device`。

### FR-DEV-002 创建时冻结设备需求并重新授权

- **规范要求**：Job 创建必须把合法 device_requirement、rig、transport、项目 opt-in 和 allow_egress 冻结到 snapshot；申请租约时必须重新验证目录/配置，缺失或不兼容必须 fail closed，不得回落到其它 rig/transport。
- **决策来源**：执行期配置可能改变，设备需求和出网是安全前置条件。
- **实现状态**：as-built；当前仅实现明确登记的 transport 和独占租约。
- **代码入口**：[Device snapshot freeze](../../apps/scheduler/src/domains/device/application.ts)、[device shared types](../../packages/shared-types/src/index.ts)、[device tests](../../apps/scheduler/src/domains/device/device.test.ts)。
- **验证证据**：`pnpm ci:unit:device-lease`、`pnpm ci:integration:device-lease`。

### FR-DEV-003 设备终态、过期与审计

- **规范要求**：Job 终态、Lease 过期或人工强制释放必须幂等归还 Broker 租约、把设备置回 idle/相应状态并追加 device_events；释放失败必须可观测且由 Broker TTL/Reaper 兜底。
- **决策来源**：设备泄漏会阻塞后续任务，外部 Broker 失败不能让数据库永远保持 leased。
- **实现状态**：as-built；释放和过期各有统一入口与 append-only 事件。
- **代码入口**：[Device release](../../apps/scheduler/src/domains/device/application.ts)、[device routes](../../apps/scheduler/src/domains/device/routes.ts)、[device schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:device-lease`、`pnpm ci:integration:device-lease`、`pnpm ci:unit:job-lifecycle`。

### FR-ASSET-001 Shared Asset scope 与 CAS

- **规范要求**：shared asset 必须声明 platform/project/finding scope、origin、logical key、版本和 SHA-256 CAS Blob；finding asset 必须与 Finding 同项目，key 必须拒绝绝对路径、`.`/`..`、反斜杠和控制字符。
- **决策来源**：资产可能是 PoC、证书、二进制或报告附件，需内容寻址和项目/Finding 隔离。
- **实现状态**：as-built；数据库 trigger、key/MIME/size 校验共同约束 scope。
- **代码入口**：[Shared asset application](../../apps/scheduler/src/domains/shared-assets/application.ts)、[shared asset schema](../../database/schema.sql)、[BlobStore](../../apps/scheduler/src/blob-store)。
- **验证证据**：`pnpm ci:unit:shared-assets`、`pnpm ci:integration:shared-assets`。

### FR-ASSET-002 Agent 发布必须持有有效 Lease

- **规范要求**：Agent origin 的 Asset 版本只能由仍处于 running、持有效 lease、拥有 sandbox 的 Job 发布；Job 终态或 Lease 过期后的迟到发布必须拒绝，不得覆盖 immutable key。
- **决策来源**：迟到回调可能来自已取消沙箱，必须阻止越过终态的写入。
- **实现状态**：as-built；应用锁和数据库 trigger 双重检查。
- **代码入口**：[Shared asset publish guard](../../apps/scheduler/src/domains/shared-assets/application.ts)、[schema trigger](../../database/schema.sql)、[shared asset tests](../../apps/scheduler/src/shared-assets.test.ts)。
- **验证证据**：`pnpm ci:unit:shared-assets`、`pnpm ci:integration:shared-assets`、`pnpm ci:unit:job-lifecycle`。

### FR-ASSET-003 Job 资产选择和只读挂载冻结

- **规范要求**：Job 必须按 project/Finding scope 解析当前 asset versions，计算 selection revision，记录 `job_shared_asset_versions` 并以只读路径挂载；进行中 Job 不得因后续资产版本变化而漂移。
- **决策来源**：执行需要稳定材料，资产更新应影响下一次 Job 而不是当前快照。
- **实现状态**：as-built；mount path 固定在 `/workspace/.deepsonar/shared/` 下。
- **代码入口**：[Asset selection](../../apps/scheduler/src/domains/shared-assets/application.ts)、[runtime sandbox volume](../../packages/runtime-sandbox/src/shared-assets-volume.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:shared-assets`、`pnpm ci:integration:shared-assets-volume`、`pnpm ci:unit:runtime-sandbox`。

### FR-XFER-001 `.deepsonarpack` 导出格式和校验

- **规范要求**：应用级 transfer 必须使用带 manifest、format/version、当前 schema_version、模块清单和 `checksums.sha256` 的 `.deepsonarpack`；导出文件必须按路径排序并计算内容/包 SHA-256。
- **决策来源**：跨实例导入需要可验证的来源、版本和完整性，不能依赖 pg_dump 或隐式数据库结构。
- **实现状态**：as-built；manifest 绑定源码导出的 `SCHEMA_VERSION`。
- **代码入口**：[Pack implementation](../../apps/scheduler/src/transfer/pack.ts)、[Transfer routes](../../apps/scheduler/src/domains/transfer/routes.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:test:transfer-schema`、`pnpm ci:unit:credential-compatibility`、`pnpm ci:integration:transfer-export`。

### FR-XFER-002 Transfer 脱敏与范围

- **规范要求**：导出必须按 project/platform scope 和 preset 授权，凭据只允许 excluded/metadata，环境变量敏感 key、token、password、API key、cookie 和类 secret value 必须过滤；导出不得包含 sandbox/runtime 状态或长期密钥。
- **决策来源**：数据包可离开原实例，需保留配置可迁移性而不泄漏秘密。
- **实现状态**：as-built；credential 仅保留逻辑引用和 metadata。
- **代码入口**：[Transfer sanitize](../../apps/scheduler/src/transfer/sanitize.ts)、[export contract](../../apps/scheduler/src/transfer/export-request.ts)、[transfer tests](../../apps/scheduler/src/transfer/sanitize.test.ts)。
- **验证证据**：`pnpm ci:unit:credential-compatibility`、`pnpm ci:integration:transfer-export`；人工解包检查不含 secret plaintext。

### FR-XFER-003 Import fail closed 与路径边界

- **规范要求**：导入必须拒绝错误 schema、过高 format major、缺 manifest/checksum、checksum mismatch、Zip Slip、超文件数/单项/总解压大小和未知模块；应用前必须支持 preview/显式 apply，不能自动迁移旧契约。
- **决策来源**：导入是外部文件写入和配置变更，必须先完整验证再应用当前契约。
- **实现状态**：as-built；当前 schema 不匹配直接返回 `BAD_SCHEMA_VERSION`。
- **代码入口**：[Pack reader](../../apps/scheduler/src/transfer/pack.ts)、[Import application](../../apps/scheduler/src/transfer/import.ts)、[import tests](../../apps/scheduler/src/transfer/import-findings.test.ts)。
- **验证证据**：`pnpm ci:test:transfer-schema`、`pnpm ci:unit:credential-compatibility`、`pnpm ci:integration:transfer-export`。

## 3. 非功能需求

### NFR-SEC-001 身份、scope 与最小权限

- **规范要求**：所有管理路由必须按认证主体、scope、project/resource ownership 执行最小权限检查；项目 Token 不得签发全局/跨项目权限，Control token 不得访问管理面。Job Token/Control API 必须拒绝读写其它项目的 Canvas、Finding、凭据和资产。
- **决策来源**：多项目隔离和 Agent/人类职责分离是平台安全前提。
- **实现状态**：as-built；OpenAPI scope 与 route surface 有 characterization 对账。
- **代码入口**：[auth](../../apps/scheduler/src/auth.ts)、[platform claims](../../apps/scheduler/src/domains/platform-claims)、[event authorization test](../../apps/scheduler/src/domains/event-ingestion/authorization.integration.test.ts)、[authorization tests](../../apps/scheduler/src/authorization-boundaries.integration.test.ts)。
- **验证证据**：`pnpm ci:unit:authz`、`pnpm ci:integration:authz-boundaries`、`pnpm ci:integration:users-auth`。

### NFR-SEC-002 不可信目标与沙箱隔离

- **规范要求**：被审计代码、Prompt、Finding 内容、CLI 输出和模型输入必须按不可信数据处理；Sandbox 必须一次性隔离、按冻结网络策略运行，PoC/Verify 不得直接获得 Scheduler 数据库或长期凭据。
- **决策来源**：Prompt injection、恶意 HTML/JS 和生成 PoC 都可能主动攻击执行环境。
- **实现状态**：as-built；网络和 sandbox limits 在快照中校验，完整真实环境安全性仍需人工部署验收。
- **代码入口**：[sandbox runtime](../../packages/runtime-sandbox/src)、[OpenSandbox config](../../packages/runtime-sandbox/src/opensandbox.ts)、[安全设计](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:runtime-sandbox`、`pnpm ci:gate:opensandbox-config-schema`、`pnpm ci:smoke:opensandbox`；人工核对真实部署网络/挂载。

### NFR-SEC-003 Secret 脱敏、日志和审计红线

- **规范要求**：日志、events、audit_logs、Evidence 和 usage ledger 不得保存 Authorization/Cookie/Provider key/Job token 或完整 prompt/completion；可见错误只能返回脱敏摘要和形状。
- **决策来源**：审计可见性不能以复制长期秘密和客户源码为代价。
- **实现状态**：as-built；audit_logs append-only，Gateway usage 只保存计费维度和受控计数。
- **代码入口**：[schema audit comment/trigger](../../database/schema.sql)、[evidence redaction](../../apps/scheduler/src/evidence.ts)、[gateway ledger](../../apps/scheduler/src/gateway.ts)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:authz`、`pnpm ci:unit:credential-compatibility`；人工抽查日志与 evidence。

### NFR-SEC-004 镜像与模块供应链

- **规范要求**：第三方镜像及需要物化为执行模块的二进制必须经过可信源、digest、扫描、签名/SBOM/工具契约和管理员提升后才能进入 Job；Skill 源按独立的 trusted/enabled/content-hash 规则治理；撤销/禁用必须阻止新 Job，历史快照保留引用用于审计。
- **决策来源**：执行环境和 Skill 本身可携带供应链风险。
- **实现状态**：部分达标；目录状态和 Job digest 冻结已落地，签名策略可配置且官方 catalog 可能记录 `signature: skipped`，这不等于已验证；Skill 源治理不等同于镜像签名/SBOM，真实 registry 证据需部署验收。
- **代码入口**：[runtime registry contract](../../apps/scheduler/src/runtime-image-registry-contract.ts)、[image admission](../../apps/image-admission/src)、[skill source policy](../../apps/scheduler/src/domains/project-skill-allowlist/policy.ts)。
- **验证证据**：`pnpm ci:unit:image-admission`、`pnpm ci:unit:runtime-registry`、`pnpm ci:unit:startup-gate`。

### NFR-SEC-005 输入渲染与控制面反注入

- **规范要求**：管理 Web 必须将 Finding/Asset/CLI 文本作为数据渲染并限制 HTML；Control API 必须以 schema/operation/token 校验而不是解析自然语言、CLI 输出或伪造 MCP 调用。
- **决策来源**：用户材料和目标仓库可能包含主动注入内容。
- **实现状态**：as-built；普通文本不产生语义事件。
- **代码入口**：[Web Markdown view](../../apps/web/src/MarkdownView.tsx)、[Control input](../../apps/scheduler/src/control-input.ts)、[platform control tests](../../apps/scheduler/src/platform-control-skill.test.ts)。
- **验证证据**：`pnpm ci:unit:web-facts`、`pnpm ci:smoke:control-api`、`pnpm ci:unit:bounded-contexts`。

### NFR-SEC-006 Token 有效期与撤销传播

- **规范要求**：认证会话、API Token、Job token、Capability token 和设备租约必须有可校验的有效期/撤销状态；Job 取消、终态或权限变更后，迟到请求必须拒绝且不能写入新的事实/资产。
- **决策来源**：权限不能因网络延迟继续有效，迟到回调是常见越权路径。
- **实现状态**：as-built；终态撤销和 running lease guard 已接线。
- **代码入口**：[auth token policy](../../apps/scheduler/src/token-policy.ts)、[capability tokens](../../apps/scheduler/src/domains/platform-api/tokens.ts)、[Job capability revocation test](../../apps/scheduler/src/job-capability-revocation.test.ts)。
- **验证证据**：`pnpm ci:unit:authz`、`pnpm ci:unit:executor-real`、`pnpm ci:integration:device-lease`。

### NFR-REL-001 pg_notify 调度唤醒与 Lease

- **规范要求**：调度必须主要依赖 `pg_notify('deepsonar_jobs')` 唤醒，兜底轮询默认关闭；Lease 由 Scheduler 续期与判定，不得信任 Agent 自报存活。
- **决策来源**：实时唤醒减少无界轮询，Lease 判定必须由平台掌握。
- **实现状态**：as-built；notify/lease 路径已接线，默认值不等于可用性或恢复时间目标。
- **代码入口**：[Scheduler 配置](../../apps/scheduler/src/config.ts)（`LEASE_TTL_SEC` 默认 120、`DEEPSONAR_DISPATCH_POLL_SEC` 默认 0）、[Dispatcher](../../apps/scheduler/src/dispatcher.ts)、[Job lifecycle](../../apps/scheduler/src/domains/job-lifecycle/application.ts)。
- **验证证据**：`pnpm ci:unit:dispatch-limits`、`pnpm ci:unit:job-lifecycle`、`pnpm ci:integration:dispatch-limits`；人工核对无 notify 时仅使用显式轮询配置。

### NFR-REL-006 写操作幂等与去重

- **规范要求**：所有可重复的 Control/数据库写入以及外部效果账本写入必须使用 idempotency、event 或 effect identity，并在数据库唯一约束、事务或明确的外部幂等协议中实现幂等；进程内 cache 不得成为跨副本的权威身份。对不支持安全幂等或效果未知的外部动作必须以 `unknown`/`replay_policy=never` 处理；重放不能重复计入事件预算、版本或外部资源。
- **决策来源**：HTTP、Worker、Broker 和数据库重试都可能重复到达；进程重启或多副本会使进程内 cache 失去权威性。
- **实现状态**：部分达标并存在实现违约；Event、Attempt Effect、Report version 和 asset version 有持久身份约束，但当前 Control API 的 `idempotencyCache` 是进程内缓存，尚未构成跨副本 durable receipt；未知外部效果仍按 `unknown`/`never` 禁止自动重放。
- **代码入口**：[schema uniqueness](../../database/schema.sql)、[platform registry](../../apps/scheduler/src/domains/platform-api/registry.ts)、[Control API routes](../../apps/scheduler/src/domains/platform-api/routes.ts)、[Attempt application](../../apps/scheduler/src/domains/job-attempt/application.ts)、[event ingestion](../../apps/scheduler/src/domains/event-ingestion/application.ts)。
- **验证证据**：`pnpm ci:integration:event-ingestion`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:job-lifecycle`。

### NFR-REL-002 运行时机制默认值

- **规范要求**：机制参数默认值必须与配置源码一致，且仅作为运维预期，不得写成可用性 SLO：`DEFAULT_AUDIT_TIMEOUT_SEC=18000`、`DEFAULT_VERIFY_TIMEOUT_SEC=10800`、`PROVISION_TIMEOUT_SEC=300`、`LEASE_TTL_SEC=120`、`REAPER_INTERVAL_SEC=30`、`DEEPSONAR_JOB_STALL_SEC=900`（0 关闭）、`DEEPSONAR_WAITING_HUMAN_TIMEOUT_SEC=1800`（0 关闭）。端到端恢复时间、吞吐量和可用性目标未定义/尚未验证。
- **决策来源**：源码参数是机制边界，不能替代场景化质量证据。
- **实现状态**：as-built（参数存在）；质量达标证据尚未验证。
- **代码入口**：[Scheduler config](../../apps/scheduler/src/config.ts)、[stall policy](../../apps/scheduler/src/domains/job-lifecycle/stall-policy.ts)。
- **验证证据**：`pnpm ci:unit:docs-freshness`、`pnpm ci:unit:job-lifecycle`；人工读取部署环境并在 `04-quality-attributes.md` 场景中单独验收。

### NFR-REL-007 Lease、Reaper 与取消竞态

- **规范要求**：Lease 续期、Reaper、取消、超时和迟到回调的每次持久状态转移必须使用 Job/Attempt 的锁序、状态条件更新或 CAS 保护；外部资源清理可以在数据库事务外执行，但必须携带 effect identity 并通过幂等补偿与状态再核对收口。重复调用必须返回稳定结果，不得 resurrect 终态 Job。
- **决策来源**：调度器和外部执行器的时序不可靠；数据库锁只保护持久状态，不能把外部网络清理错误地描述为同一事务。
- **实现状态**：部分达标；Reaper 和取消路径使用事务、锁序与状态条件更新，外部清理通过独立幂等入口回收；跨事务清理与 Canvas/Job 并行竞态仍需按具体 effect identity 做人工核查。
- **代码入口**：[Job lifecycle recovery](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[attempt cancellation](../../apps/scheduler/src/domains/job-attempt/provision-cancellation.ts)、[recovery tests](../../apps/scheduler/src/recovery-issue186.integration.test.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:recovery`、`pnpm ci:smoke:opensandbox-reaper`。

### NFR-REL-003 运维重试投影

- **规范要求**：`timeout`/`orphan` 只有在没有待结算效果且策略允许时，才可向操作员提示“可安全重试”；否则必须停在 `needs_confirmation`，不得推荐 `retry_same_session`。
- **决策来源**：运维 UI 的可重试提示必须服从 Effect 账本和未知效果门禁。
- **实现状态**：as-built（Web 投影）；安全重试条件由 Job/Attempt 效果状态决定。
- **代码入口**：[任务工作台重试投影](../../apps/web/src)、[Effect ledger](../../apps/scheduler/src/domains/job-attempt/application.ts)、[RepairFeedback](../../packages/shared-types/src/repair-feedback.ts)。
- **验证证据**：`pnpm ci:unit:web-facts`、`pnpm ci:unit:recovery`；人工核对 pending/unknown 时不出现 `retry_same_session`。

### NFR-REL-008 未知外部效果禁止猜测重放

- **规范要求**：任何 `effect_pending`/`unknown` 或进程崩溃后无法证明未开始的外部效果必须停止自动重放，进入 orphan/对账/人工路径；只有显式标记 safe 且满足应用前置条件的动作才可重试。
- **决策来源**：Unknown 是事实状态而非普通 transient error，猜测重放会造成重复副作用。
- **实现状态**：as-built；默认 replay policy 为 `never`。
- **代码入口**：[Effect schema](../../database/schema.sql)、[Job recovery](../../apps/scheduler/src/domains/job-lifecycle/application.ts)、[recovery integration](../../apps/scheduler/src/recovery-issue186.integration.test.ts)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:integration:recovery`、`pnpm ci:smoke:opensandbox-reconcile`。

### NFR-REL-004 Durable 事件、Evidence 和补读

- **规范要求**：语义事件必须落库，原始运行流必须进入可寻址 Evidence 冷存储，实时 stream-bus 只能作为非权威投递；跨副本无法读取共享 BLOB 时必须显式返回 unavailable/4415，不得伪造完整流。
- **决策来源**：实时通道会丢消息，补读需要权威来源和拓扑可见性。
- **实现状态**：as-built；evidence 补读和 `visibility=unavailable` 已有路径。
- **代码入口**：[evidence stream](../../apps/scheduler/src/evidence.ts)、[query planes](../../apps/scheduler/src/query-planes.ts)、[stream routes](../../apps/scheduler/src/domains/stream/routes.ts)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:web-facts`；人工验证多副本无共享卷。

### NFR-REL-005 Report/Research 失败隔离

- **规范要求**：Report 和 Research 的可选投影失败必须持久化失败原因、保留主事实并使用有界恢复；不得通过回滚外层事务或无限 retry 丢失/重复核心结果。
- **决策来源**：交付增强失败不应破坏已确认事实，恢复必须可观察、可停止。
- **实现状态**：as-built；Report 自动重试 1 次，Research 使用 savepoint。
- **代码入口**：[report recovery](../../apps/scheduler/src/report-failure-recovery.ts)、[research best effort](../../apps/scheduler/src/domains/finding-research/application.ts)、[report tests](../../apps/scheduler/src/report-failure-recovery.test.ts)。
- **验证证据**：`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:finding-research`、`pnpm ci:integration:finding-research`。

### NFR-PERF-001 Graph Query 硬预算

- **规范要求**：Graph Query 必须使用源码定义的单类 hard cap 和 Job 总预算；不得用“大图完整注入”替代查询预算。当前默认 Job 总预算为最多 40 次、512000 bytes，单类上限以 `GRAPH_QUERY_LIMITS` 为准。
- **决策来源**：上下文与查询资源必须有可计算上限，防止大图和恶意节点放大成本。
- **实现状态**：as-built；源码实际值为 index 50、node ids 20、node body/evidence 8192 chars、edges 200、findings 30、intents 50、overview 2048 chars。
- **代码入口**：[config graph limits](../../apps/scheduler/src/config.ts)、[shared limits](../../packages/shared-types/src/index.ts)、[graph tests](../../apps/scheduler/src/graph-budget.test.ts)。
- **验证证据**：`pnpm ci:unit:graph-references`、`pnpm ci:integration:graph-references`；人工核对配置变更仍受上限约束。

### NFR-PERF-002 Control 事件窗口预算

- **规范要求**：语义事件必须使用固定窗口和独立桶计数；默认窗口为 60 秒，progress/standard/terminal 默认上限为 30/120/8，配置值必须经源码边界归一化，不得用吞吐猜测替代配置。
- **决策来源**：终态/人工事件需要为进度噪声保留预算。
- **实现状态**：as-built；预算超限返回 retry metadata 且重放不重复占用。
- **代码入口**：[event rate policy](../../apps/scheduler/src/domains/event-ingestion/rate-limit.ts)、[rate limit schema](../../database/schema.sql)、[rate tests](../../apps/scheduler/src/domains/event-ingestion/rate-limit.test.ts)。
- **验证证据**：`pnpm ci:unit:event-rate-limit`、`pnpm ci:integration:event-rate-limit`。

### NFR-PERF-003 Sandbox 资源边界

- **规范要求**：Sandbox resource override 必须不超过平台 ceiling；CPU、memoryMiB、pidsLimit 的解析边界必须分别为 0.25–64、256–131072、64–32768，当前 server fallback 为 2 CPU/2048 MiB/512 pids，并启用 capDropAll/noNewPrivileges。
- **决策来源**：资源预算和进程隔离是多租户可靠性与安全的共同边界。
- **实现状态**：as-built；项目只能收紧平台值，未知字段拒绝。
- **代码入口**：[sandbox limits](../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.ts)、[sandbox tests](../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.test.ts)、[runtime sandbox](../../packages/runtime-sandbox/src)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:dispatch-limits`。

### NFR-PERF-004 Gateway/Evidence 有界传输

- **规范要求**：Gateway 请求体和重试、Evidence 流读取/解压/记录/保留必须遵守源码硬上限；Gateway body limit 必须为 16 MiB、最多 3 次尝试、重试延迟上限 2 秒，Evidence 预算超限必须截断并标记，不得无界缓冲。
- **决策来源**：上游和压缩流都可能提供恶意大输入，边界必须在 host 侧执行。
- **实现状态**：as-built；无独立 SLA，只有上述代码/配置边界。
- **代码入口**：[Gateway constants](../../apps/scheduler/src/gateway.ts)、[Evidence limits](../../apps/scheduler/src/evidence.ts)、[stream tests](../../apps/scheduler/src/evidence-stream.test.ts)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:recovery`、`pnpm ci:unit:runtime-sandbox`。

### NFR-OBS-001 审计、指标和状态可查询

- **规范要求**：所有安全相关配置、权限决定、Job/Attempt 状态、Control 事件、外部效果和设备/镜像动作必须有可查询审计或指标；audit_logs 必须 append-only，指标不得包含秘密或客户原文。
- **决策来源**：发生故障或争议时必须能区分提案、接受、执行、结算和终态。
- **实现状态**：as-built；管理面提供 audit/metrics/Job 详情查询。
- **代码入口**：[audit routes](../../apps/scheduler/src/domains/audit/routes.ts)、[audit implementation](../../apps/scheduler/src/audit.ts)、[metrics](../../apps/scheduler/src/metrics.ts)。
- **验证证据**：`pnpm ci:unit:authz`、`pnpm ci:unit:scheduler-characterization`、`pnpm ci:unit:dashboard-overview`。

### NFR-OBS-002 Evidence stream 可见性与截断说明

- **规范要求**：Evidence/session/stream API 必须返回可见性、截断、游标、来源和 digest/record 预算信息；不可补读时必须明确 unavailable 或稳定 WS 错误，不得让前端显示完整但不真实的日志。
- **决策来源**：用户需要知道当前数据是实时、补读、截断还是拓扑不可见。
- **实现状态**：as-built；过程流有压缩/解压/保留上限和 visibility 分支。
- **代码入口**：[Evidence](../../apps/scheduler/src/evidence.ts)、[stream routes](../../apps/scheduler/src/domains/stream/routes.ts)、[Web LiveStream](../../apps/web/src/LiveStream.tsx)。
- **验证证据**：`pnpm ci:unit:recovery`、`pnpm ci:unit:web-facts`；人工核对跨副本和超预算状态。

### NFR-OBS-003 稳定错误 code 与人类消息

- **规范要求**：API/Control/RepairFeedback 错误必须提供稳定 `error_code`、可读但脱敏的 message、retryability/next action；不得把堆栈、凭据、Provider 原文或不可信输入原样交给模型或浏览器。
- **决策来源**：客户端和模型需要按类别修复，运营需要可搜索的错误身份。
- **实现状态**：as-built；RepairFeedback 与 ControlInputError 共享脱敏 shape 规则。
- **代码入口**：[Control input](../../apps/scheduler/src/control-input.ts)、[platform registry error schema](../../apps/scheduler/src/domains/platform-api/registry.ts)、[HTTP validation tests](../../apps/scheduler/src/http-validation-error.test.ts)。
- **验证证据**：`pnpm ci:smoke:control-api`、`pnpm ci:unit:capability-pack`、`pnpm ci:unit:authz`。

### NFR-EVO-001 机器契约和版本化

- **规范要求**：Capability Pack、Agent Runtime Profile、Artifact、Finding protocol、Transfer manifest、Report input 和 RepairFeedback 必须带 schema/protocol/version 或 fingerprint；契约变化必须更新 source、测试和追溯条目。
- **决策来源**：可插拔能力和历史证据需要确定的解释版本，不能靠当前代码猜测。
- **实现状态**：as-built；现行契约均有显式版本/哈希字段；未来协议未默认启用。
- **代码入口**：[shared types](../../packages/shared-types/src)、[Agent runtime profile](../../apps/scheduler/src/agent-runtime-profile.ts)、[Transfer pack](../../apps/scheduler/src/transfer/pack.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:test:transfer-schema`、`pnpm ci:unit:docs-freshness`。

### NFR-EVO-002 插件可替换而内核边界稳定

- **规范要求**：新增业务能力、Skill、CLI、镜像和交付投影必须复用现有 Job/Attempt、Control API、sandbox、Evidence、审计和结算边界；不得建立第二执行通道或把内核资源策略下沉给插件。
- **决策来源**：可组合性只应扩展业务方法，安全/资源/副作用边界必须长期稳定。
- **实现状态**：as-built（已有能力遵守边界）；未实现的任务/会话 Pack 生命周期仍是后续目标。
- **代码入口**：[Capability Pack](../../apps/scheduler/src/domains/capability-pack)、[runtime adapters](../../packages/runtime-sandbox/src)、[设计摘要](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:bounded-contexts`；人工审查新增能力不注册第二执行器。

### NFR-EVO-003 CLI/Viewer 接入完整性

- **规范要求**：新增治理 CLI 必须同时提供 runtime adapter、session archive adapter、Web viewer parser、契约测试和原始归档下载；不完整接入不得作为新 Job 默认值。
- **决策来源**：只接通启动而没有归档/查看会丢失执行真相。
- **实现状态**：as-built（当前治理 CLI）；历史归档只读路径不扩展新运行时。
- **代码入口**：[CLI adapter docs](../AGENT_CLI_RUNTIME_ADAPTERS.md)、[runtime adapters](../../packages/runtime-sandbox/src)、[session viewer](../../apps/web/src/session-viewer)。
- **验证证据**：`pnpm ci:unit:runtime-sandbox`、`pnpm ci:unit:web-session-viewer`、`pnpm ci:unit:credential-compatibility`。

### NFR-OPS-001 健康、就绪与调度门禁

- **规范要求**：Scheduler 必须区分 liveness、readiness 和 runtime-image warmup；镜像/依赖未准备好时服务可保持 live 但不得启用 Dispatcher，错误必须可查询并有界退避。
- **决策来源**：容器存活不等于可安全执行，错误就绪会把资源问题扩大为 Job 失败。
- **实现状态**：as-built；启动 gate、健康端点和 image readiness 分层。
- **代码入口**：[readiness](../../apps/scheduler/src/readiness.ts)、[image warmup](../../apps/scheduler/src/runtime-image-warmup.ts)、[readiness tests](../../apps/scheduler/src/readiness.test.ts)。
- **验证证据**：`pnpm ci:unit:startup-gate`、`pnpm ci:unit:runtime-cleanup`、`pnpm ci:smoke:opensandbox-prod`。

### NFR-OPS-002 Reaper 与运行时超时配置

- **规范要求**：Reaper、Lease、provision、Job、waiting_human 和 stall 必须使用可配置且有边界的秒数；没有源码/配置依据的延迟、吞吐和 SLA 不得写入规格。当前 Lease TTL 默认 120 秒、Reaper 间隔默认 30 秒、provision 默认 300 秒、waiting_human 默认 1800 秒、Job stall 默认 900 秒。
- **决策来源**：运维调节需要真实配置出处，避免把未验证的 SLA 当承诺。
- **实现状态**：as-built；超时和停滞条件由 Scheduler 判定，实际环境负载不在本文宣称范围。
- **代码入口**：[config](../../apps/scheduler/src/config.ts)、[runtime knobs](../../apps/scheduler/src/runtime-knobs.ts)、[stall policy](../../apps/scheduler/src/domains/job-lifecycle/stall-policy.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:dispatch-limits`、`pnpm ci:unit:runtime-cleanup`；人工对照部署 env。

### NFR-OPS-003 发布与文档保鲜

- **规范要求**：涉及架构边界、schema、接口、镜像和发布的变更必须同步更新需求/矩阵/视图/ADR，并在发版前核对 schema 版本、命令、链接、已删机制残留和 as-built 语义；不得把未执行的 CI/真实沙箱验收写成通过。
- **决策来源**：架构文档是治理入口，过期文档会让 Agent 采用已删除或越权路径。
- **实现状态**：as-built（机检覆盖版本/命令/链接/残留；语义仍需人工核查）。
- **代码入口**：[AGENTS release gate](../../AGENTS.md)、[docs freshness](../../apps/scheduler/src/docs-freshness.test.ts)、[architecture README](./README.md)。
- **验证证据**：`pnpm ci:unit:docs-freshness`、`pnpm ci:unit:file-size`、`git diff --check`；人工逐条核对代码与视图。

## 4. 外部接口需求

### IR-011 管理 API、Control API 与 WebSocket

- **规范要求**：系统必须以 OpenAPI 描述管理面 HTTP 路由和 scope，以 Job-scoped OpenAPI/HTTP Control API 描述 Agent operation，并以一次性 ticket 建立 WebSocket/terminal 流；接口 surface、scope 和内部例外必须与注册路由一致。
- **决策来源**：不同调用者需要不同认证、契约和补读语义，不能用一个模糊 API 面覆盖。
- **实现状态**：as-built；路由注册与 OpenAPI 有 characterization gate。
- **代码入口**：[OpenAPI](../../apps/scheduler/src/openapi.ts)、[route surface manifest](../../apps/scheduler/src/route-surface.manifest.ts)、[platform API routes](../../apps/scheduler/src/domains/platform-api/routes.ts)。
- **验证证据**：`pnpm ci:unit:authz`、`pnpm ci:unit:scheduler-characterization`、`pnpm ci:smoke:control-api`。

### IR-001 Scheduler Runtime Adapter 与 Model Gateway

- **规范要求**：OpenSandbox/SandboxRunner 的创建、销毁、列表和状态同步必须经 Scheduler runtime adapter；沙箱不得持有长期 Provider 密钥；模型请求必须经 Scheduler-owned Model Gateway 与短期 Job token。
- **决策来源**：外部执行器和 Provider 都是不可信外部效果，Scheduler 需要统一凭据、预算、审计和清理。
- **实现状态**：as-built；runtime adapter 和 Gateway 是唯一受治理出口，长期密钥不写入快照/沙箱。
- **代码入口**：[runtime-sandbox](../../packages/runtime-sandbox/src)、[Scheduler runtime adapter](../../apps/scheduler/src/runtime.ts)、[Gateway](../../apps/scheduler/src/gateway.ts)、[Provider 凭据解析](../../apps/scheduler/src/domains/provider-adapter/resolve-credential.ts)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:smoke:opensandbox`；人工核对 Sandbox/Provider 请求不绕过 Scheduler。

### IR-002 Model Provider 与 Gateway

- **规范要求**：Provider 的上游协议必须只由 Gateway adapter 访问，Sandbox 通过短期 Job token 和受控 proxy 发请求；超时、network/http retry 必须受 Job deadline 和 Gateway 上限约束。
- **决策来源**：Provider 是外部不确定系统，平台需要统一凭据、计费、重试和审计。
- **实现状态**：as-built；Gateway 使用 16 MiB body limit、最多 3 attempts、2 秒 retry max delay。
- **代码入口**：[Gateway](../../apps/scheduler/src/gateway.ts)、[Provider adapter](../../apps/scheduler/src/domains/provider-adapter)、[gateway tests](../../apps/scheduler/src/gateway-retry.test.ts)。
- **验证证据**：`pnpm ci:unit:executor-real`、`pnpm ci:unit:credential-compatibility`；真实 Provider 端到端需部署凭据后人工执行。

### IR-003 OpenSandbox 与 Worker Node

- **规范要求**：Scheduler 必须通过受治理 OpenSandbox/Worker Node adapter 创建、监视、取消和清理 Sandbox；节点注册、heartbeat、endpoint、capacity 和 sandbox lease 必须写入 Worker registry，Scheduler 不得把 Worker 当作第二状态真相。
- **决策来源**：执行资源可能远程、多副本或短暂不可用，控制面需要可替换 adapter 和持久节点目录。
- **实现状态**：as-built；节点 catalog 在 Postgres，OpenSandbox key 仅驻留 Scheduler 内存并持久化 fingerprint。
- **代码入口**：[Worker registry](../../apps/scheduler/src/domains/worker-nodes/registry.ts)、[OpenSandbox adapter](../../packages/runtime-sandbox/src/opensandbox.ts)、[worker routes](../../apps/scheduler/src/domains/worker-nodes/routes.ts)。
- **验证证据**：`pnpm ci:unit:runtime-cleanup`、`pnpm ci:unit:runtime-sandbox`、`pnpm ci:smoke:opensandbox-api`、`pnpm ci:smoke:opensandbox-dispatch`。

### IR-004 OCI Registry 与运行时发布清单

- **规范要求**：镜像目录同步和发布必须从受信 Release/registry 读取不可变 manifest/index/descriptor，并保留 channel、digest、platform 和 inspect evidence；任一配置目的地校验失败必须 fail closed。
- **决策来源**：镜像标签可漂移，发布闭环需要可重复的多平台证据。
- **实现状态**：as-built（代码/工作流契约）；真实 registry 通道证据需在适用发布验收中核对。
- **代码入口**：[runtime registry contract](../../apps/scheduler/src/runtime-image-registry-contract.ts)、[release docs](../RELEASE_RUNTIME_IMAGES.md)、[registry harness](../../agent-harness/test-runtime-registry-generator.mjs)。
- **验证证据**：`pnpm ci:unit:runtime-registry`、`pnpm ci:unit:runtime-images`、`pnpm ci:images`。

### IR-005 Device Broker/Rig

- **规范要求**：设备外部接口必须由 broker 根据冻结 requirement 申请/释放，返回 transport、endpoint 和短期 lease 投影；Scheduler 必须校验返回 transport 与需求一致并在落库冲突时归还 Broker 租约。
- **决策来源**：Broker 是不可信外部进程，设备独占性最终由数据库和释放补偿保证。
- **实现状态**：as-built（Phase 1 支持边界）；Broker 实机可用性不由单元测试推定。
- **代码入口**：[Device broker client](../../apps/scheduler/src/domains/device/broker-client.ts)、[Device application](../../apps/scheduler/src/domains/device/index.ts)、[device schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:device-broker`、`pnpm ci:integration:device-lease`、`pnpm ci:smoke:device`。

### IR-006 shared asset BlobStore 与 Evidence 本地事实边界

- **规范要求**：shared asset Blob 必须通过受治理的 BlobStore fs/s3 抽象读写并以 URI/SHA 引用；Evidence、Session 和 Report 必须继续使用各自的执行事实/报告读取路径并暴露可见性、游标和 digest，不得把它们泛化为 shared asset BlobStore，也不得把本地路径当成跨副本事实。
- **决策来源**：shared asset 是可复用内容，Evidence/Session 是按 Attempt 保存的执行事实，Report 是冻结投影；三者的所有权、补读和跨副本可见性不同，混用会制造第二事实来源。
- **实现状态**：部分达标；shared asset 已有 fs/s3 BlobStore 与内容寻址边界，Evidence 仍由 `BLOB_DIR` 下的本地 Evidence store 直接读写，Session/Report 也保留各自 reader；跨副本不可见路径需按部署拓扑核验。
- **代码入口**：[shared asset application](../../apps/scheduler/src/domains/shared-assets/application.ts)、[Evidence local store](../../apps/scheduler/src/evidence.ts)、[query planes](../../apps/scheduler/src/query-planes.ts)、[shared asset docs](../SHARED_ASSET_BLOB_STORE.md)。
- **验证证据**：`pnpm ci:unit:shared-assets`、`pnpm ci:integration:shared-assets-volume`、`pnpm ci:unit:recovery`；人工分别核对 shared asset BlobStore 与 Evidence/Session/Report reader，验证无共享 BLOB 时返回 unavailable（验证入口，本次行为测试未执行）。

### IR-007 Git Skill Source

- **规范要求**：Skill source 同步必须由 Scheduler 受控浅克隆、扫描和缓存 `SKILL.md`/commands，运行 Job 只能读取已缓存且 trusted+enabled 的 selector/content hash，不得在任务执行时任意访问 Git 网络。
- **决策来源**：Skill 源是外部供应链，运行期网络访问会破坏快照和审计。
- **实现状态**：as-built；内容在 sync 时缓存，Job 内拉取不重新访问 Git。
- **代码入口**：[skill source routes](../../apps/scheduler/src/domains/skill-source/routes.ts)、[skill source tests](../../apps/scheduler/src/skill-source-sync.test.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:startup-gate`、`pnpm ci:unit:capability-pack`、`pnpm ci:integration:platform-api`。

### IR-008 Prometheus/Health 观测端点

- **规范要求**：系统必须提供健康、就绪和 metrics 端点，端点返回的指标/状态只含受控计数、错误类别和组件 readiness，不得输出 token、Provider secret、完整 prompt 或沙箱原文。
- **决策来源**：运维探针和监控系统需要机器可读状态而不是秘密副本。
- **实现状态**：as-built；health/readiness/metrics 路由已注册并有 route surface 约束。
- **代码入口**：[system routes](../../apps/scheduler/src/domains/system/routes.ts)、[metrics](../../apps/scheduler/src/metrics.ts)、[readiness](../../apps/scheduler/src/readiness.ts)。
- **验证证据**：`pnpm ci:unit:runtime-cleanup`、`pnpm ci:unit:scheduler-characterization`、`pnpm ci:unit:authz`。

### IR-009 GitHub Release 与部署证据

- **规范要求**：运行时镜像发布必须在 GitHub Release/tag、工作流 checkout SHA、OCI descriptor/catalog 和部署 digest 之间保留可核对链路；任何一环缺证据不得宣称发布闭环完成。
- **决策来源**：产品版本、源码、镜像和部署结果是不同外部效果，必须逐一核验。
- **实现状态**：as-built（流程约束/脚本）；本规格不声称当前环境已执行某次发布验收。
- **代码入口**：[release runbook](../RELEASE_RUNTIME_IMAGES.md)、[release harness](../../agent-harness/test-reverse-release-evidence.mjs)、[发布硬门](../../AGENTS.md)。
- **验证证据**：`pnpm ci:unit:runtime-registry`、`pnpm ci:images`；人工核对 tag、workflow head_sha、双平台 manifest 和部署 inspect。

### IR-010 Platform Release Discovery

- **规范要求**：Scheduler 平台更新发现必须只读取可信运行时 registry 的可选 `platform` block/legacy `platform_version`，比较当前平台版本与 schema 版本并持久化 latest check；更新查询必须受 admin scope 保护，网络/契约错误必须记录 `check_error`，不得由发现路径执行升级或改变运行时镜像。
- **决策来源**：平台发现是只读运维投影，不能把 release catalog 读取误写成升级副作用，也不能在 registry 缺省时伪造版本。
- **实现状态**：as-built（#745 只读发现/持久化/管理查询）；Release workflow 写入 platform digest 的闭环仍由 IR-009 发布证据约束，不在本条冒充已完成。
- **代码入口**：[platform-updates discovery](../../apps/scheduler/src/domains/platform-updates/discovery.ts)、[model/store/routes](../../apps/scheduler/src/domains/platform-updates/)、[runtime registry contract](../../apps/scheduler/src/runtime-image-registry-contract.ts)、[OpenAPI](../../apps/scheduler/src/openapi.ts)、[schema](../../database/schema.sql)。
- **验证证据**：`pnpm ci:unit:control-plane-platforms`、`pnpm ci:unit:runtime-registry`、`pnpm ci:unit:authz`；人工核对 registry 缺失、版本相同、可用更新和 check_error 四种投影。

### IR-012 宿主补丁自动升级与签名授权

- **规范要求**：无人值守升级默认关闭，只有明确启用的宿主策略及维护窗口允许新一代操作；目标须为同 major/minor 的向前稳定补丁、相同 schema 与 DDL 指纹，完整预检无阻断、计划无风险。三个平台镜像的签名须绑定官方 Release workflow、tag、commit、版本、schema 和完整目标集合；失败不得降级为无签名执行。
- **决策来源**：#740 P2；用户授权产品实现及隔离测试，并于 2026-10-22 明确批准正式 tag 发布 job 的短期 OIDC 签名；没有授权开启真实定时任务或升级现网。
- **实现状态**：策略、签名验证和既有维护状态机已完成隔离验收；正式 tag 的生产 keyless 发布已接线，仅签名 job 新增 id-token:write，验签成功才发布。每版正例以 Release 证据为准，宿主调度仍默认未启用。签名信任根和验证器由宿主显式钉死，不从待验证清单取信任设置。
- **代码入口**：[自动策略](../../deploy/platform-upgrade-auto-policy.mjs)、[自动状态机](../../deploy/platform-upgrade-auto.mjs)、[宿主接线](../../deploy/platform-upgrade-auto-host.mjs)、[签名验证](../../deploy/platform-upgrade-signature.mjs)、[签名运维](../../deploy/UPGRADE_AUTOMATION.md)。
- **验证证据**：`pnpm ci:unit:platform-upgrade-maintenance`；临时密钥验签与生产 Fulcio/Rekor 身份验收分别记录，不能互相替代。同目标恢复依赖持久授权和实际激活回执；回滚及结果不明不自动开启新一代。

## 5. 设计约束

### CON-001 四层真相和唯一副作用执行者

- **规范要求**：PostgreSQL/API 必须拥有管理/审计真相，Canvas 必须拥有过程真相，Sandbox/Evidence 必须拥有执行真相，Scheduler 必须是唯一有副作用的执行者；模型、插件、Web 不得直接改数据库、容器、凭据、Job snapshot 或终态。
- **决策来源**：职责边界是系统可验证性的基础，避免第二状态机和隐式副作用。
- **实现状态**：as-built；各 bounded context 通过应用事务和 route registrar 组合。
- **代码入口**：[设计摘要](../../DESIGN.md)、[架构细则](../ARCHITECTURE.md)、[Job state write inventory](../../apps/scheduler/src/job-state-write-inventory.test.ts)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:scheduler-characterization`；人工按状态写入清单审查新增入口。

### CON-002 当前契约不向后兼容

- **规范要求**：删除或修订契约时必须同步删除旧 schema/API/UI/运行时路径；不得保留双读双写、fallback、shim、legacy mode 或自动旧配置转换。旧输入不满足当前契约时必须 fail closed；不可变历史快照/Evidence/审计记录不作为新运行时兼容输入。
- **决策来源**：兼容层会让权限、schema 和语义出现双重真相。
- **实现状态**：部分达标；当前导入 schema mismatch 和不支持 CLI 都 fail closed、历史结果只读保留，升级离线预检复用 当前持久默认组合的 credential-first 解析并认证已存密文（覆盖边界见 [部署说明](../../deploy/README.md)）；但 runtime registry contract 仍保留 schema v1 兼容解析、旧 `image_ref` 投影和历史 digest alias（D-07），不能把物理清扫前的实现写成全量 as-built。
- **代码入口**：[设计不向后兼容](../../DESIGN.md)、[升级配置预检](../../apps/scheduler/src/platform-upgrade-preflight.ts)、[Transfer schema validation](../../apps/scheduler/src/transfer/pack.ts)、[runtime CLI boundary](../../apps/scheduler/src/transfer/sanitize.ts)。
- **验证证据**：`pnpm ci:unit:platform-upgrade-preflight`、`pnpm ci:unit:deploy-ps1`、`pnpm ci:test:transfer-schema`、`pnpm ci:unit:credential-compatibility`、`pnpm ci:unit:docs-freshness`；人工检查新代码没有兼容 shim。

### CON-003 单一 schema 基线

- **规范要求**：`database/schema.sql` 必须是唯一 schema 基线且与 `SCHEMA_VERSION` 同步；改表必须修改基线、bump 版本并重建/验证，不得添加启动时增量 ALTER 链或按旧版本隐式迁移。
- **决策来源**：稳定列、外键、唯一约束和权限骨架需要可审计的单一来源。
- **实现状态**：as-built（单一基线纪律）；受控维护升级已新增只读计划、身份隔离与候选重建模块，宿主与受管 SSH 已接线，最终 schema 61 → 62 组合镜像的隔离演练已有通过记录，具体范围见下述验证证据。维护授权不允许清除未审批配置或回滚激活后的合法写入；计划绑定源/目标 DDL 指纹，源库冻结保全，见 [ADR 0008](adr/0008-maintenance-candidate-upgrade.md)。
- **代码入口**：[schema version](../../apps/scheduler/src/schema-version.ts)、[schema rebuild](../../apps/scheduler/src/schema-rebuild.ts)、[database baseline](../../database/schema.sql)、[维护升级状态机](../../deploy/platform-upgrade-maintenance.mjs)、[候选库管理](../../deploy/platform-upgrade-candidate.mjs)、[只读计划](../../apps/scheduler/src/platform-upgrade-schema-plan.ts)。
- **验证证据**：`pnpm ci:unit:migrations`、`pnpm ci:unit:docs-freshness`、`pnpm db:rebuild -- --plan`；[维护故障注入](../../deploy/platform-upgrade-maintenance.test.mjs) 与 [候选库实测](../../apps/scheduler/src/platform-upgrade-schema-integration.test.ts) 已有隔离证据，schema 61 → 62 的 16 项 Compose 场景及独立知识后台停写场景已通过并清理，包含单机、多节点、回滚恢复、中断续做及排空阻断。历史输入版本、隔离环境与未执行项见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)；这些记录不代表当前提交重跑通过，也不证明 Windows Docker 全流程或真实模型效果。

### CON-004 API-only Control 面

- **规范要求**：真实 Job 的语义事件和平台能力必须通过 Job-scoped HTTP Control API 注册 operation；不得提供 MCP/普通文本/控制文件回退通道来绕过 operation allowlist、token、schema、事件/效果幂等或审计。已实现的 durable event/effect receipt 与进程内 HTTP 优化必须在语义上区分。
- **决策来源**：单一受治理控制面才能保证相同的鉴权、失败反馈和事件/效果账本语义；当前 HTTP 进程内 cache 只作优化，不能泛化为 durable receipt。
- **实现状态**：as-built；平台控制 Skill 只描述 HTTP/OpenAPI 和 Bearer/Idempotency-Key。
- **代码入口**：[platform API](../../apps/scheduler/src/domains/platform-api)、[control routes](../../apps/scheduler/src/domains/platform-api/routes.ts)、[trusted kernel](../AI_NATIVE_TRUSTED_KERNEL.md)。
- **验证证据**：`pnpm ci:smoke:control-api`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:canvas-facts`。

### CON-005 Job scope、快照和覆盖优先级

- **规范要求**：所有 Agent 读取、能力选择、凭据/镜像解析和 graph query 必须受当前 Job project/canvas scope 与冻结 snapshot 限制。对支持覆盖的 runtime knobs，配置优先级为 Job > role/project > platform > env；role/project 不能放宽 platform ceiling，env 仅作引导回退，`provisionTimeoutSec` 只在 platform/env 解析。能力、凭据、镜像和 graph scope 由各自 snapshot/admission 规则冻结，不套用通用配置覆盖语义。
- **决策来源**：执行中读取可变全局配置会破坏历史可解释性和租户隔离。
- **实现状态**：as-built；scope、预算、脱敏和 snapshot identity 在应用层重验；配置覆盖实现存在上述按 knob 差异。
- **代码入口**：[runtime knobs](../../apps/scheduler/src/runtime-knobs.ts)、[runtime knob tests](../../apps/scheduler/src/runtime-knobs.test.ts)、[graph query](../../apps/scheduler/src/graph-query.ts)、[snapshot application](../../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)、[credential resolver](../../apps/scheduler/src/domains/provider-adapter/resolve-credential.ts)、[image boundary](../../apps/scheduler/src/domains/role-runtime-snapshot/runtime-image-boundary-policy.ts)。
- **验证证据**：`pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:graph-references`、`pnpm ci:integration:authz-boundaries`、`pnpm ci:unit:dispatch-limits`；人工分别验证 runtime knob 与能力/凭据/镜像 admission，不把低层配置误当权限上界。

### CON-006 读图按需且有界

- **规范要求**：Hub 启动输入只能包含任务目标和有界 Canvas 骨架/小图投影，大图必须通过当前 Job 的只读 `graph_query` 按需读取；角色 Agent 只能读取其 Job scope、角色快照和 operation 允许的任务/证据上下文，不得默认获得整张 Canvas 或能力目录。所有 graph 查询必须有调用/字节预算，耗尽时返回可修复反馈。
- **决策来源**：上下文成本、数据泄漏和引用校验需要由平台控制而不是靠模型自律。
- **实现状态**：as-built；Graph Query 有 overview/index/node/edges/findings/evidence/intents 分层。
- **代码入口**：[graph query](../../apps/scheduler/src/graph-query.ts)、[graph budget tests](../../apps/scheduler/src/graph-budget.test.ts)、[设计摘要](../../DESIGN.md)。
- **验证证据**：`pnpm ci:unit:graph-references`、`pnpm ci:integration:graph-references`、`pnpm ci:smoke:hub`。

### CON-007 Fact、Artifact、Finding、Verify 与 Report 分责

- **规范要求**：Artifact 必须是内部写入真相，Fact 必须是证据，Finding 必须是风险投影，Verify 必须只消费结构化证据，Research 只能做去重/相对排序，Report 必须是冻结输入投影；任何域不得用自身状态覆盖另一域的责任字段。
- **决策来源**：避免“Finding 文本=事实”“Research 排名=严重度”“Report 成功=Verify confirmed”等语义混淆。
- **实现状态**：as-built；核心状态机和表结构分离，Research/Report 有失败隔离。
- **代码入口**：[DESIGN Artifact/Verify/Report](../../DESIGN.md)、[state matrix](../../apps/scheduler/src/finding-state-matrix.ts)、[report](../../apps/scheduler/src/report.ts)。
- **验证证据**：`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:finding-research`。

### CON-008 供应链和凭据由内核持有

- **规范要求**：Sandbox、Agent、Hub、Skill、任务内容不得选择任意或未准入镜像、安装任意或运行期动态二进制、读取长期凭据或扩大网络；受治理的 Job-scoped Skill discovery/pull 和已预物化模块仍可在平台准入边界内使用。所有供应链、凭据、设备、资源和外部 Effect 必须由 Scheduler/平台目录准入并写入审计。
- **决策来源**：业务插件可替换，内核安全/资源/副作用边界不可下沉。
- **实现状态**：as-built（任意/未准入动态安装被拒绝）；能力声明不能扩大 platform_tools、credentials、image、allow_egress 或 project scope，受治理 pull 仍需 Job token、trusted source 和 content hash。
- **代码入口**：[runtime image boundary](../../apps/scheduler/src/domains/role-runtime-snapshot/runtime-image-boundary-policy.ts)、[CLI admission](../../apps/scheduler/src/domains/cli-capability/admit.ts)、[extension admission](../../apps/scheduler/src/domains/extension-materialization/admit.ts)、[credential resolver](../../apps/scheduler/src/domains/provider-adapter/resolve-credential.ts)、[device application](../../apps/scheduler/src/domains/device/application.ts)。
- **验证证据**：`pnpm ci:unit:capability-pack`、`pnpm ci:unit:cli-capability`、`pnpm ci:unit:runtime-images`、`pnpm ci:unit:credential-compatibility`；人工核对 `installRequested`、npm/npx/pip/remote install 和 governed `pull_skill` 的差异。

### CON-009 历史真相不可变

- **规范要求**：已创建 Job 的 snapshot、Attempt、Evidence、Audit、Artifact revision、Report input/version 和导入来源必须保持可追溯；新契约变化只能影响新运行时，不得静默重写历史结果或按当前配置解释旧证据。
- **决策来源**：审计、回归和发布证据依赖历史不可变身份。
- **实现状态**：as-built；版本/sha/快照字段和 supersede 语义已落地。
- **代码入口**：[schema history columns](../../database/schema.sql)、[Report version](../../apps/scheduler/src/task-report-version.ts)、[Transfer pack](../../apps/scheduler/src/transfer/pack.ts)。
- **验证证据**：`pnpm ci:unit:job-lifecycle`、`pnpm ci:unit:verify-eligibility`、`pnpm ci:integration:transfer-export`。

### CON-010 本规格与追溯矩阵必须可机检

- **规范要求**：每个需求 ID 必须在本文件恰好定义一次并在追溯矩阵恰好一行；矩阵列必须非空，引用只能指向已定义 ID，视图/ADR/代码/测试链接必须是仓库内真实相对 Markdown 链接或可复现命令。
- **决策来源**：需求、架构决策、代码入口和验证证据需要稳定可检索，防止文档漂移。
- **实现状态**：as-built；本 PR 已提供完整正文和矩阵，`pnpm ci:unit:docs-freshness` 已作为机检入口运行通过；后续视图/ADR 变更仍须复跑该门禁。
- **代码入口**：[architecture README](./README.md)、[docs architecture gate](../../apps/scheduler/src/docs-architecture-gate.ts)、[docs freshness tests](../../apps/scheduler/src/docs-freshness.test.ts)。
- **验证证据**：`pnpm ci:unit:docs-freshness`；人工检查定义覆盖、矩阵一一对应、Windows/POSIX 路径归一化和链接目标。

## 6. 关键链路（用于评审和人工验收）

### 6.1 成功任务至报告

`POST /projects/{id}/tasks` 创建 Canvas（FR-TASK-001）→ Scheduler 派发首个 Hub Job（FR-TASK-002），并在 Job 创建时冻结快照（FR-JOB-009）→ Hub 读取有界图并提交受治理 Intent（FR-HUB-002、FR-HUB-003、FR-HUB-005）→ Scheduler 领取 Job/Attempt、准入镜像/能力/凭据并启动 Sandbox（FR-JOB-001、FR-JOB-002、FR-IMG-003、FR-CAP-004、FR-CRED-003）→ Agent 通过 Control API 写 Fact/Artifact/Finding 并 mark done（FR-CTRL-004、FR-ART-001、FR-FACT-001、FR-FIND-001）→ `finalizeJob` 派生 Verify/Research/Report（FR-JOB-003），按 Fact-first 门禁收敛（FR-VERIFY-001、FR-VERIFY-004）→ Research 记录去重/priority（FR-RSCH-001、FR-RSCH-002）→ Report Job 生成带 SHA 的冻结输入和版本投影（FR-RPT-001、FR-RPT-003）→ Web 展示报告版本与下载（FR-WEB-004）。可核对入口为 `pnpm ci:integration:job-lifecycle`、`pnpm ci:integration:finding-protocol`、`pnpm ci:integration:report-download`；这些是验证入口，本次未声称均已执行通过。

### 6.2 越权拒绝与 RepairFeedback

Agent 使用当前 Job token 调用 `validate_composition`、`graph_query` 或 `submit_hub_decision`，经过 shared schema、handler、application transaction 三层检查（FR-CTRL-007、FR-CTRL-008、CON-004）。若 selector 未知、引用未见、项目/版本/权限/预算不合法，Scheduler 返回稳定 error code 和脱敏 RepairFeedback（FR-CTRL-001、FR-CTRL-002、FR-CTRL-003、FR-CTRL-005、FR-CTRL-006），不执行副作用、不扩大 Job scope；模型应重新读取目录/当前状态并用新 revision/Idempotency-Key 修正。可核对入口为 `pnpm ci:unit:capability-pack`、`pnpm ci:unit:graph-references`、`pnpm ci:integration:platform-api` 和 `pnpm ci:smoke:control-api`。

### 6.3 超时、崩溃与未知效果

Job Attempt 先写 effect intent/账本，外部 provision/执行可能在 `effect_pending` 或 `unknown` 窗口崩溃（FR-JOB-004、FR-JOB-005）。只有无 sandbox 且无迟到效果的 provision 失败可结算为 `never_started`（FR-JOB-006）；启动 reconcile 仅在 preparing 且无效果时回到 pending，其它情况进入 orphan/对账（FR-JOB-007）。Reaper 对 timeout、stall、lease expiry、waiting_human timeout 走有界恢复（FR-JOB-008、NFR-REL-002），数据库终态由事务条件原子判定，外部 cleanup 在事务外按 effect identity 幂等补偿；未知效果不得自动 replay，运维投影不得推荐 `retry_same_session`（NFR-REL-003、NFR-REL-008）。可核对入口为 `pnpm ci:unit:recovery`、`pnpm ci:integration:recovery`、`pnpm ci:smoke:opensandbox-reconcile`、`pnpm ci:smoke:opensandbox-reaper`；真实 OpenSandbox、多副本和 Broker 验收仍需人工环境证据。

## 7. 事实核查边界

本文件已以 `DESIGN.md`、`docs/ARCHITECTURE.md`、`database/schema.sql`、`apps/scheduler/src/openapi.ts`、现行 bounded context 代码和 package.json 测试脚本逐项反查。测试命令只表示验证入口，不表示本次执行通过；未连接真实 Provider、OpenSandbox、registry、device broker、多副本共享 BlobStore 或 GitHub Release 的项目环境，不在本 PR 声称已验证范围内。长期设计（完整 Proposal/Receipt/Settlement、Plan 驱动派发、全图权威布局、任务/会话 Pack 生命周期）若在代码中只有 Phase 1/骨架，会保留“进行中/暂缓”状态，不写成 as-built。
