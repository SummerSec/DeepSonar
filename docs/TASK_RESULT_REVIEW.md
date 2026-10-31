# 非 Finding 任务交付与执行结果评审（#767）

> 状态：as-built；非 Finding 声明、来源隔离评审与确定性报告；不授权整体完成。
> 同步日期：2026-10-30

工程交付和有界负结果应能关联任务目标并接受证据评审，无需伪造漏洞 Finding。复用既有 `emit_fact`、版本化 Artifact、普通 Job 与判据评审；不新增执行通道，也不将所有技术观察升级为成果。

## 声明种类与评价维度

声明放在 `emit_fact.artifact.task_result`，严格区分以下种类。机器来源是 [TaskResultProposal](../packages/shared-types/src/task-result.ts)，未知字段拒绝。

| 种类 | 含义与必要上下文 | 不代表什么 |
| --- | --- | --- |
| delivery | 工程或其他交付，关联产物版本、目标/基线、判据与实际证据 | 存在文件或提交就已达标 |
| negative_result | 在明确目标/基线、执行方法和覆盖边界下获得的负结果，保留实际证据与限制 | 目标不存在问题、零 Finding 即成功 |
| blocked | 缺少权限、材料或环境等必要条件，记录阻塞与待补项 | 安全结论或完成成果 |
| not_executed | 明确哪些步骤未执行及原因 | 执行后未发现或未复现 |

种类描述交付或执行观察；`satisfied/contradicted/insufficient/conflict/not_assessed` 描述判据评价，两个维度不可替代。负结果可支持“调查并记录复现结果”这样的原始验收判据，但不能自动满足“修复缺陷”，也不能自动完成任务。blocked/not_executed 只保留缺口，不贡献成果。

## 声明与评审接口

```text
schema_version: 1
kind: delivery | negative_result | blocked | not_executed
task_contract_sha256: <整个冻结任务契约摘要>
target: <契约中的目标>
baseline: <可选；必须与契约基线一致>
criterion_ids: [<1–20 个冻结判据 ID>]
method: <执行方法或未执行步骤>
observed: <实际观察或阻塞情况>
limitations: [<限制与待补条件>]
evidence_refs: [<本 Job 本 Attempt 的证明 Fact UUID>]
```

声明最多 20KB，method/observed/target 等文本字段各最多 2000 字符，limitations 最多 20 条、evidence_refs 最多 8 项，判据和证据引用不得重复。delivery/negative_result 至少引用一项自己的当前 Attempt 证明；blocked/not_executed 必须有 limitation，可无证据。声明和评审 Artifact 不得互相作为执行证明，避免循环认证。typed declaration 只确定声明种类与来源，不认证方法确已执行或观察语义真实。

普通 `/jobs` 的 `payload.goal_review` 或 `HubIntent.goal_review` 使用既有请求，加上**恰好一个** `fact_id` 或 `finding_id`，并提供 `candidate_artifact_id`、整契约摘要及判据列表。fact_id 指向非 Finding 结果 Fact，其 Artifact 必须与请求一致；所评判据必须属于声明的 criterion_ids。delivery/negative_result 才可进入此评审，blocked/not_executed 保留缺口，不进入成果评价。

宿主保存 kind 为 `task.result` 的 Artifact，以及规范化 proposal 和来源/证据绑定。key 为 `task-result:<job_id>:<sha256(event_id)>`；复用同事件 receipt 的幂等行为，不新增结果修订协议或跨事件去重承诺。

## 冻结、来源与复核

声明关联来源 Job 的完整冻结任务契约摘要、目标、适用基线和判据引用。宿主验证同项目/Canvas 的 Fact/Artifact、版本、来源事件和 Attempt，而非接受 Agent 自报已核验。delivery 与 negative_result 的 Fact Artifact 作为来源隔离评审 subject；技术 Finding 继续走原研究准入和 Verify 路径。

复核沿用[任务判据评审](TASK_GOAL_REVIEW.md)的来源隔离、留存证据、冲突与失效边界。评审不得由交付 maker 或所用证据来源 Job 自评；来源、证据或最新 Attempt 变化后，旧评价不能静默改绑。空证据否定不构成 contradicted，预算不足不允许遗漏反证后保留完整满足结论。

来源加载、评审与报告共享 8MiB 留存证据读取预算；超限或截断 fail closed，不能只保留先读取的正向评价。声明元数据的宿主绑定核验与成功执行条件分开：失败 Job 仍可保留可信来源的 blocked/not_executed 声明，报告显示执行缺口；这不允许失败/过期/未知效果来源参与正向评价。

## 报告与 #775 边界

报告分别展示交付、执行观察、阻塞/未执行和逐判据缺口；零 Finding 不再被解释成没有任何交付，也不能解释成任务已完成。正文仍由确定性投影生成，原始材料通过可查询的 Fact/Artifact 引用保留。历史冻结报告不回写。

本片不改变 #775 的完成 authority。其当前判据接口使用 operator_attestation 与 verified Fact；新来源隔离评价不自动映射成该 authority，不自动置 Fact verified，也不自动完成 Plan。共享来源引用便于核对，不复制完成门。

## 验收与剩余范围

本片行为验收应覆盖：零 Finding 工程交付；有证据的有界负结果；未执行不能伪装负结果；blocked/not_executed 不贡献成果；跨项目/Canvas 与自评拒绝；契约/基线/Artifact/证据/Attempt 变更失效；有证据正反冲突；部分交付与未覆盖判据并存；预算/截断；报告版本与原 Finding 路径不回退。机器字段、入口、来源隔离与报告路径已接线；各项验收结果以 PR 的实际测试记录为准，不以文档替代行为证据。

未完成验收继续保留：

- 未提供契约按原可选设计保持 unassessed；是否提高准入要求属另行产品决策，不作为本 issue 必须迁移项。
- 目标身份/租户、写授权及必要前置条件的可信适配器；fail-closed 不代表获准动态链已验收。
- 高门槛安全提交候选的可复现证据、适用攻击链、knownness 对目标版本的适用性与独立程序资格。
- #775 的更广目标 revision/后续策略范围另行验收；本轮已接可选显式 Plan 关联，不自动映射评价 authority。
- 当前离线/数据库端到端证据覆盖明确样本，不代表任意目标或所有动态授权链；跨切片验收与未完成项见[矩阵](TASK_DISPATCH_ACCEPTANCE.md)。

用户已免除真实模型验收，不以模型或生产试验阻碍交付；质量效果、提交接受率和奖励收益仍未验证，不作收益承诺。

## Plan 显式关联

操作员可在原 Plan Fact 绑定中选择 goal_review 来源及任务判据，明确其对 Plan 判据的自然语言覆盖，不按索引自动映射。原 verified Fact、jobs:control、operator_attestation 与全判据完成门保留；未选择关联的合法绑定不变，选择后须持续复核同契约及完整有效评价集合，失效不能静默退回无关联。详见[Plan 关联字段与来源](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。这不是赏金资格或新增所有任务人工门。

执行证据绑定采用 `content_schema_version:2`，摘要排除 `manual_verification` 与 `verification_status`，但 rejected 仍拒绝，Plan verified 授权另行校验。旧 v1 摘要可能失效，保留历史并严格拒绝，不自动转换；需重新产出结果/独立评审时，旧 assignment 不得静默改绑。此变更有部署版本边界，详见[Plan 来源版本](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。
