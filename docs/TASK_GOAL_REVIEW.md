# 来源隔离的任务判据评审（#767 后续片）

> 状态：普通 Job 评审记录与报告逐判据投影；不认证不同人/模型，不代替 #775 整体完成或赏金提交资格。
> 同步日期：2026-10-30

本片接续[研究候选准入](TASK_OUTCOME_ADMISSION.md)和[报告防误报](TASK_OUTCOME_REPORT.md)，允许既有普通 Job 提交有来源、有留存证据的判据评审。它隔离执行来源，不证明 reviewer 与 maker 是不同人、不同模型或组织上独立。所有判断仍须结合来源、证据、适用范围和限制解读，不能称为外部认证。

非 Finding 的工程交付与有界负结果已按[任务执行结果评审](TASK_RESULT_REVIEW.md)接入 Fact Artifact subject；无需构造漏洞 Finding。结果种类与判据评价分开，blocked/not_executed 不贡献成果；请求必须恰好指定 Finding 或结果 Fact 之一。

## 请求与宿主冻结

机器契约见 [task-goal-review.ts](../packages/shared-types/src/task-goal-review.ts)。普通 `/jobs` 创建的 `payload.goal_review` 或 `HubIntent.goal_review` 可请求：

```text
schema_version: 1
finding_id: <同项目研究候选 UUID，与 fact_id 二选一>
fact_id: <同项目 task.result Fact UUID，与 finding_id 二选一>
candidate_artifact_id: <所选 Finding 或 Fact 的 Artifact UUID>
task_contract_sha256: <整个冻结任务契约摘要>
criterion_ids: [<1–20 个冻结判据 ID>]
```

普通 `/jobs` 复用候选所在的同项目 Canvas，仍走既有角色、权限、镜像、Job/Attempt 准入，不建立独立评审执行通道。宿主生成 `snapshot.task_goal_review`，冻结 project/canvas、request、source_sha256、forbidden_job_ids、candidate_revision 和 assignment_sha256。候选 maker 与候选证据来源 Job 均不能评自己；只更换提案文字不能绕过来源隔离。用户提供请求不是用户可写宿主 assignment。重跑评审 Job 时重新检查当前权限与前置条件，但保留原 assignment 的来源绑定；不能借重跑静默改绑已变化的候选或证据来源。

## 通过既有 Fact 提交结果

结果位于 **`emit_fact.artifact.goal_review`**，不是顶层 goal_review。runtime 转发整个 artifact，由宿主验证并保存。除了既有 Fact 标题/描述，评审结果形状为：

```text
schema_version: 1
assignment_sha256: <宿主冻结 assignment 摘要>
criteria:
  - criterion_id: <请求中判据 ID>
    scope: entire_criterion
    assessment: satisfied | contradicted | insufficient
    expected: <完整判据期望>
    actual: <本次实际观察>
    rationale: <证据如何支持判断>
    limitations: [<未解决限制>]
    evidence_refs: [<评审 Job 自己提交的 Fact UUID>]
```

结果最多 20KB、20 条判据，每条最多 8 个 Fact 引用。satisfied 与 contradicted 均必须至少一项证明引用，satisfied 还要求 limitations 为空。无证据的否定或无法下结论应使用 insufficient，可不带引用并说明限制；来源隔离本身不能把主张升级为已证实否定。这些结构要求不自动证明文本真实。只允许 entire_criterion 的正向评价，候选对局部验收有贡献不能被写成整个判据满足。未覆盖的判据不算完成。

宿主持久化 Artifact kind `task.goal_evaluation`，使用保留命名空间 `task_goal_review`，key 为 `goal-review:job:attempt`。同内容重复提交幂等，不同内容冲突；不能由普通 artifact extensions 伪造宿主评审来源，也不自动覆盖其他 reviewer 的记录。全部原文留在 Artifact。

## 从绑定到可用评价

运行中提交先绑定 assignment、自己的 Fact 及当前 Attempt 留存文件元数据，不立即贡献正向判断。报告读取时重新核对完整来源、当前契约/候选版本、最新成功 Attempt、无 unknown/pending 外部效果、自有 Fact 对应的 Artifact/events，以及 manifest 中本 Attempt 文件与实际内容 hash。

普通 Fact 不需要人工先置 verified；本片没有新增全局人工批准门。当前来源或留存字节不满足核验时保留失效记录和 gaps，不贡献 satisfied；不能把没有文件、只有预期文本或过期 Attempt 当作复现证据。来源/证据/Attempt 变化后重新读取显式失效，不改写历史报告。

## 报告聚合与边界

逐判据可为 satisfied、contradicted、insufficient、conflict 或 not_assessed。不同 reviewer 的当前有效相反评价产生 conflict，不按最后写入覆盖；失效记录保留可查，但不参与满足、否定或冲突判断；历史无证据否定也须重验并标记失效。报告仅保存紧凑 review_records 引用，通过 review_indexes 关联判据，完整评审正文仍在 Artifact；单 Finding 最多 20 条、Task 最多 100 条，截断不得宣称正向完整结论。来源、评审与报告共享的 8MiB 留存证据读取预算耗尽、无法完整检查评价集合时，所有判据均显示 insufficient；不能仅保留先读到的正向评价而漏掉后续反证。

整体 goal_assessment 区分 blocked、not_assessed、partially_satisfied、criteria_satisfied。部分 satisfied 不是整体完成；即使 criteria_satisfied，也只表达当前判据评价集合，不是 Plan/任务完成授权。整体 Plan 完成仍 not_assessed，归 #775；赏金 submission_eligibility 不由本片推导。契约任务 SARIF 仍不作为达标成果导出，逐判据正向展示不改变最终交付策略。

## 验收与剩余范围

验证关注真实创建/Hub Intent 入口、宿主 assignment 不可伪造、maker/证据源不能自评、entire_criterion、幂等与冲突、当前成功 Attempt、unknown effects、实际留存字节/hash、无人工 verified 前提、失效保留、有效矛盾、截断及报告版本。测试入口见 [评审测试](../apps/scheduler/src/task-goal-review.test.ts)和[证据测试](../apps/scheduler/src/task-goal-review-evidence.test.ts)，实际 SQL、运行时转发与报告结果以 PR 验收记录为准。

不新增数据库表、Control operation、核心状态或执行通道。来源隔离不等于独立人/模型认证，也不自动完成目标适用性、knownness、赏金资格或 #775 整体闭环。用户免除真实模型验收，效果仍未验证，不以模型试验作为交付门槛。

## Plan 显式关联

操作员可在原 Plan Fact 绑定中选择 goal_review 来源及任务判据，明确其对 Plan 判据的自然语言覆盖，不按索引自动映射。原 verified Fact、jobs:control、operator_attestation 与全判据完成门保留；未选择关联的合法绑定不变，选择后须持续复核同契约及完整有效评价集合，失效不能静默退回无关联。详见[Plan 关联字段与来源](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。这不是赏金资格或新增所有任务人工门。

执行证据绑定采用 `content_schema_version:2`，摘要排除 `manual_verification` 与 `verification_status`，但 rejected 仍拒绝，Plan verified 授权另行校验。旧 v1 摘要可能失效，保留历史并严格拒绝，不自动转换；需重新产出结果/独立评审时，旧 assignment 不得静默改绑。此变更有部署版本边界，详见[Plan 来源版本](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。
