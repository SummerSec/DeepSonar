# 0012. Plan v2 通过现有 Hub Intent/Job 路径执行

> 状态：**已采纳**
> 原决策日期：2026-10-31（由 `4e74b913`、`464ea681` 提交时间核对）
> 同步日期：2026-10-31
> 来源：#775；执行型 Plan v2、目标 CAS、依赖输出和停止语义
> 关联需求：FR-TASK-006、FR-CAP-006、FR-HUB-002、FR-HUB-003、FR-HUB-005、FR-JOB-009、FR-JOB-013、FR-CRED-002、FR-IMG-003

## 背景

历史 Plan v1 能保存目标、任务、依赖、完成策略和预算，并支持有界的单步补证/路线记录，但不能直接成为 Worker 派发器。把模型的 `PlanResult.complete` 或一段 Artifact 文本当作执行结果，会绕过用户目标、Job/Attempt、真实留存证据、Verify 和报告完成门。#775 需要支持多轮、有界依赖执行，同时保留现有 Hub Intent admission、快照和副作用记账边界。

## 决策

- 新的 Control/ingestion/运行时 Plan 写入只接纳 `v:2` execution contract；v1 Plan/Result、历史事件和旧审计可读取，但不是新执行的兼容 fallback。v1 replay 迁移作为独立工作进行，不能把历史回放写成 v2 多轮执行验收。
- 用户目标由有权限的操作员通过 `PATCH /tasks/{canvasId}` 的 `plan_objective.expected_revision` CAS 创建或修订。Scheduler 在 Canvas 行锁内保存目标 ID/revision、完整 CompletionPolicy、生命周期预算、输入 SHA 和状态；模型不能改变 goal、completion、budget，也不能用新标题、key 或路线理由重置已消耗 lifetime task/round/no-progress/unknown-effect 账本。
- v2 `submit_plan` 必须带 `execution_route` CAS，显式绑定 Plan owner、objective ID/revision、期望路线 revision 和当前 Plan SHA。同一目标 revision 内已派发 task 的字节身份保持不变，只能调整尚未派发的 task；并发路线由 Scheduler 选择一个成功 revision，原事件、快照、Job、Attempt、Artifact、Evidence 和报告保持不可变。
- Scheduler 先对完整路线做 Hub Intent admission，再在同一 semantic ingestion 事务中复用现有 Intent materializer 创建普通 Worker Job。所有 task 都必须通过 Canvas canonical 引用、角色、运行时镜像、CLI、Provider/model、Finding/Verify、网络、快照和共享资产等既有准入；任一延迟 task 被拒绝时不留下部分 child Job。Plan 不建立第二队列、第二控制通道或第二 Job 生命周期。
- `depends_on` 只在当前目标 revision 的前置 Job 与最新 Attempt 成功时释放。输出必须来自 submitted 且未 superseded 的 Artifact/Finding/Fact，并由对应 Attempt 的真实 semantic event 绑定；Artifact 与事件中的严格 `plan.output` extension 必须一致，精确标识 objective/revision、task、task SHA 并覆盖全部 `expected_outputs`。每项输出关联的 Evidence 还必须通过当前 Attempt 路径、finalized manifest、长度和实际 SHA 检查。这个绑定只证明工程来源和字节留存，不是语义完成 authority。
- `max_tasks`、`max_rounds`、`max_parallel_tasks` 和 `max_no_progress_rounds` 由用户目标授权并跨路线、owner、key 与目标 revision 累计。取消、超时、失败、缺失输出、无进展、预算耗尽、依赖失败和 unknown external effect 都持久写入停止状态；历史 unknown effect fail closed。完整限制以 [`plan.ts`](../../../packages/shared-types/src/plan.ts) 和 [`objective.ts`](../../../apps/scheduler/src/domains/plan-protocol/objective.ts) 为准，不在 ADR 复制可变默认值。
- 只有当前目标所有 task 的必要输出齐全，并且完整、当前、未截断的必要判据均有正向 operator authority，且通过既有 Verify/Report/Task 完成门时，Scheduler 才能写入 complete。`PlanResult.complete`、done-only、Artifact binding 或模型文本都不能授予语义完成权威。
- 后置 Hub/Report admission 仍在 savepoint 内处理。目标授权 grant 拒绝时回滚本批新 Job、保留前驱 terminal result 并暂停 Canvas；Plan 依赖 admission 使用 `target_authorization_grant_invalid` 持久停止，不撤销前驱已证明输出。未知效果、待结算回执或无效执行投影均不得猜测重放或重置。

## 状态

2026-10-31 已接入 shared Plan v2 schema、用户目标 CAS、路线 CAS、Hub Intent materializer、依赖输出检查、留存证据检查、持久停止和历史 v1 拒绝。代码入口为 [`plan.ts`](../../../packages/shared-types/src/plan.ts)、[`objective.ts`](../../../apps/scheduler/src/domains/plan-protocol/objective.ts)、[`execution.ts`](../../../apps/scheduler/src/domains/plan-protocol/execution.ts)、[`execution-output.ts`](../../../apps/scheduler/src/domains/plan-protocol/execution-output.ts) 和 [`side-effects.ts`](../../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)。专题说明见 [`PLAN_GAP_PROJECTION.md`](../../PLAN_GAP_PROJECTION.md) 与 [`PLAN_BOUNDED_INTENT_DESIGN.md`](../../PLAN_BOUNDED_INTENT_DESIGN.md)。

核对 `2773050a` 时，工程执行投影可先记录 `stop_reason=complete` / objective `status=completed`，任务收敛仍须另过当前正向操作员判据；该工程字段不是本决策所述的语义完成。2026-10-31 复核确认 `applyHubPlanAdapter`、`persistPlanAudit`、副作用 writer 与 pure legacy `adapt*` helper/type/export 已物理删除；普通 HubIntent 仍走原 handler，不制造新的 v1 `plan_protocol`，不可变 v1 与 `hub_intent_adapter` 审计仅作为历史读取解析。上述实现状态不改变本 ADR 的决策段。

本地补充核验见[验收矩阵](../../TASK_DISPATCH_ACCEPTANCE.md)：v2 replay 的报告 provenance 为 dirty 的非 HEAD 提交，不能作为 `5619154f` 精确最终验收，也不是 17 个独立测试；terminal/bootstrap、schema rebuild/restore 与 core `finalizeJob` 的终态 401 断言均已留证。最终组合 CI 仍待核对，终态结论不外推到所有 drain/Reaper 路径。

## 后果

- Plan 可以按用户明确的目标和有限 lifetime 预算推进有依赖的普通 Job，同时复用成熟的引用、镜像、凭据、网络、Attempt、Evidence 和审计边界。
- 真实 Attempt 留存字节和 `plan.output` 关联成为依赖释放的工程门，但不会把来源绑定误写成语义质量证明；操作员的当前正向判据和既有 Verify/Report 门仍是完成 authority。
- 目标修订不会抹掉历史，旧目标输出不能满足新目标；无进展、未知效果和 admission 拒绝会停住路线，可能需要操作员修复目标或环境后重新声明。
- 隔离 PostgreSQL/fake Worker 夹具可以验证控制原子性、依赖、CAS、停止与重建边界；真实模型效果、生产部署、独立人工标注集、留出集和预冻结质量阈值仍未由此验证。工程 CI 通过不等于质量验收通过。

## 替代方案

- 继续把 v1 PlanResult 当作 Worker 派发或完成信号：会绕过用户目标 CAS、依赖、Attempt/Evidence 和现有 Intent admission，拒绝。
- 为 Plan 建立专属队列、执行器或权限 token：产生第二执行通道和新的未知效果边界，拒绝。
- 用 Artifact 存在、Fact verified、done summary 或模型 `complete` 释放依赖/完成：只能证明部分来源或提案，缺少真实留存和 operator semantic authority，拒绝。
- 允许路线/目标用新 key 隐式覆盖或重置预算：破坏历史不可变、并发 CAS 和 lifetime 约束，拒绝。

## 验证边界

当前单元与 PostgreSQL 集成入口由根 `package.json` 的 `ci:unit:plan-protocol`、`ci:integration:plan-protocol` 覆盖，具体测试见 `plan-execution*.integration.test.ts`、`plan-objective*.test.ts`、`plan-revision.integration.test.ts` 和相关 Intent/输出测试。需以精确 PR head 的 CI 结果核对接线、数据库前置条件和未跳过状态；本 ADR 不声称本轮已完成最终组合 CI、生产执行或模型/人工质量验收。v2 replay 的本地证据与 provenance 限制见[验收矩阵](../../TASK_DISPATCH_ACCEPTANCE.md)。
