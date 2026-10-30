# 任务成果模式与候选准入（#767 首片）

> 状态：首片实现契约；仅结构化候选准入，独立提交资格评审与目标整体收敛未交付。
> 同步日期：2026-10-30

任务目标决定什么是成果；发现技术弱点只是可能相关的观察。赏金任务需要符合指定项目规则、合规且有证据的可提交成果，不能用严重度、技术 confirmed、人工 disposition 或相似文本替代资格判断。首片提供目标声明、规则快照、角色上下文传播和 Finding 候选入口检查，**不证明候选已达到任务成果要求，不保证提交接受或奖励**。

## 契约与来源

唯一机器来源是 [task-outcome.ts](../packages/shared-types/src/task-outcome.ts)，由 [TaskContract](../packages/shared-types/src/task-contract.ts) 的可选 `outcome` 引用。模式显式选择，平台不从正文、项目名或关键词推断：

- `task_defined`：沿用任务定义的交付，不套赏金资格规则。
- `bounty_submission`：要求显式 `rules_status`。`unknown` 可以创建任务以补充材料和保留观察，但不能提交 Finding 候选；`supplied` 必须有 `rule_snapshot`。

规则快照包括 `schema_version: 1`、`program_id`、`version`、`source`、`targets` 和 `rules`。来源声明为 `provenance: operator_supplied`，记录用户授权选定材料的 `reference` 与 `sha256`。它是操作员提供的材料身份声明，不是平台认证官方规则、有效授权或实时适用性。目标含 `id/type/reference/baseline`；规则含 `id/kind/description`，kind 为 requirement 或 exclusion。声明不创建凭据、不扩大平台网络/身份/操作权限。

**两个摘要不得混淆：** `source.sha256` 是操作员提供的源材料摘要；`rule_snapshot_sha256` 是服务端对规范化规则快照计算的摘要，候选必须绑定本 Job 的该摘要。源材料 hash 不等于服务端抓取或验证过材料；基线字符串也不证明目标可访问。模板或规则修改不回写既有 Job 快照。

## 观察先落库，候选再准入

先通过既有 `emit_fact` 保存观察、Artifact 与 Evidence 引用，再调用 `emit_finding`。拒绝 Finding 不会自动代替调用者保存未提交的观察；不要把唯一证据只放在会被拒绝的 Finding 提案中。凭据仅引用，正文与材料不得带秘密。

赏金候选的 `outcome_claim` 包含：

- `schema_version: 1`、服务端给出的 `rule_snapshot_sha256`、`target_id` 和 `baseline`；
- `attack_prerequisites` 与 `impact_summary`；
- 整体 `evidence_refs`，以及每条 `rule_assessments` 的 `rule_id/result/evidence_refs`。

`result` 是 Agent 声明的 matches、does_not_match 或 unknown。每条规则都需评价及 Fact UUID 引用；引用必须是同项目、同 Canvas 的实际 Fact，并关联实际 Artifact。候选目标、基线、快照摘要须匹配冻结规则。事实存在/关联正确只证明引用身份，不证明内容支持声明，也不是独立评审。

| 结果 | Finding 入口行为 | 是否任务成果 |
| --- | --- | --- |
| blocked：规则未知、声明/引用缺失、引用越界或版本不符 | 拒绝 Finding，返回具体缺口；补证或停止 | 否 |
| observation_only：明确不符 requirement、命中 exclusion 或目标不在声明范围 | 拒绝 Finding；原观察保留，不能作为目标成果 | 否 |
| admitted_for_verification：结构、版本、引用与逐规则声明通过 | 创建候选并进入既有技术 Verify；保存准入依据 | 尚未判定 |

准入依据随 Finding `raw_json` 和 Artifact 保存，`submission_eligibility: not_assessed`。所有角色使用冻结成果上下文；输入压缩保留该约束段。research 应围绕规则与前提补证，但首片不执行外部项目查重、不独立判定规则语义、不以字符串相似度、severity 或内部 Research cluster 推导奖励资格。不得硬编码某个项目规则。

## 与 #775 的责任边界

#767 定义成果模式、规则身份和目标候选准入；#775 负责当前目标版本的证据缺口、下一步、停止与整体报告收敛。用户目标版本、任务输入 SHA、Plan SHA、规则快照 SHA、目标代码 baseline 是不同身份，不能互相冒充。沿用已有 Plan/CompletionPolicy、Job/Attempt 和报告路径，不另造状态机或第二执行通道。既有完成门、预算和 unknown effect 约束保持有效，见 [Plan 设计与差额](PLAN_BOUNDED_INTENT_DESIGN.md)。

后续仍需独立资格评价及其来源/版本、目标与报告完成门的接线、完整端到端验收。报告不得因为技术 confirmed 或候选通过而宣布赏金目标完成；未知与补证/blocked 不算成功。首片没有这些能力，不代表 #767/#775 整体关闭。

## 验收与效果边界

可重复验收覆盖模式区分、规则版本与摘要、输入顺序规范化、跨项目/任务及缺失 Artifact 引用、unknown/不符/排除、候选继续技术 Verify、依据保留与上下文压缩约束。具体执行结果以 PR 记录为准，不把测试入口存在写成已运行。

用户已明确所有 issue 均无需真实模型验收；不把付费模型或生产试验作为首片交付门槛。真实模型效果、提交接受率及奖励收益未验证，不能据此承诺质量提升。独立资格评审、报告收敛和端到端链路缺口是实现范围，不能因免除模型试验而宣称完成。
