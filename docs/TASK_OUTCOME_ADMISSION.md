# 通用任务下发标准与研究候选准入（#767 / #794 首片）

> 状态：首片实现契约；基本完整性与结构化研究候选准入。高置信提交候选、独立资格评审及整体成果收敛未交付。
> 同步日期：2026-10-30

主轴是让不同创建者与入口提供一致的任务质量底线，并让研究候选关联用户目标。赏金是可选的附加严格筛选，不是默认任务类型。工程、一般审计与赏金模式通过本片检查后都只是**研究候选**，不代表目标达成、高置信度可提交成果或奖励资格。

## 通用任务完整性

已提供的 [TaskContract](../packages/shared-types/src/task-contract.ts) 在创建和派发时检查 `objective/targets/scope/evidence/acceptance` 的基本完整性；关键缺项阻塞，不再仅返回 warning。`exclusions` 明确不做什么；没有排除项可以为空，有声明时必须纳入候选评价。其他结构化提示与既有权限/凭据/网络门保持有效。

该规则不取决于 outcome：省略 outcome、task_defined 和 bounty_submission 都执行同一通用门。仍接受未提供整个 task_contract 的旧自由文本入口，但只返回 unassessed 提示，**不是统一标准已经覆盖所有入口**。这条迁移缺口不能解释为允许删除已启用契约来规避要求。字段齐全只证明必要声明存在，不证明自然语言一致性、条件真实或目标可执行。

## 整个冻结契约与研究候选

唯一机器来源是 [task-outcome.ts](../packages/shared-types/src/task-outcome.ts)。所有已有任务契约的 `emit_finding` 都需 `outcome_claim`：

- `task_contract_sha256`：服务端对整个规范化冻结任务契约计算的摘要，不只是赏金规则摘要；
- `target` 与可选 `baseline`：绑定当前契约中的目标与适用基线；
- `evidence_refs`：整体 Fact UUID 引用；
- `criterion_assessments`：逐项 `criterion_id/result/evidence_refs`，result 为 matches、does_not_match 或 unknown；
- 赏金模式额外提供 `rule_assessments`，按冻结程序规则声明结果与 Fact 引用。

通用判据由冻结契约派生：objective、scope、evidence 及每个 exclusion:N 必须评价；acceptance:N 至少一项 matches，表示研究候选对某项验收要求有贡献关联，**不表示全部任务判据已经满足**。应使用本 Job 给出的判据 ID，不自行猜测索引或复制一份完成标准。普通工程候选不强制安全攻击字段；安全 Finding 继续使用既有 FindingImpact 与 Verify 约束。

先通过既有 `emit_fact` 保存观察、Artifact 与 Evidence 引用，再提交 Finding。引用须为同项目、同 Canvas 的实际 Fact，且关联 Artifact；首片检查存在、身份、作用域及声明结果，不独立确认事实语义。拒绝 Finding 不会自动替调用者保存未提交的观察，不能把唯一证据只放在可能被拒的提案中。

| 结果 | Finding 入口行为 | 是否目标已达标 |
| --- | --- | --- |
| blocked：契约/版本/引用缺失或评价未知 | 拒绝 Finding，返回缺口；先补证或停止 | 否 |
| observation_only：明确不符合目标或命中排除 | 拒绝 Finding，保留已落库观察 | 否 |
| admitted_for_research：结构、版本、引用及贡献声明通过 | 创建研究候选，继续既有技术验证，保存依据 | 否 |

准入依据随 Finding raw_json 和 Artifact 保存，`submission_eligibility: not_assessed`。各角色使用冻结契约，输入压缩保留约束段。目标、范围、验收或附加规则变化都不能沿用旧整契约摘要；历史快照不回写。

## 可选赏金附加规则

outcome 显式选择 task_defined 或 bounty_submission，不能从正文关键词、项目名或严重度推断。task_defined 只是不套赏金规则，不能跳过通用完整性或研究候选门。

bounty_submission 的 `rules_status` 为 supplied 或 unknown；unknown 允许补证观察，但不接纳 Finding。supplied 必须有 rule_snapshot：schema_version、program_id、version、source、targets 和 rules。source 记录 `provenance: operator_supplied`、reference、sha256；targets 含 id/type/reference/baseline；rules 含 id/kind/description，kind 为 requirement 或 exclusion。

源材料 `source.sha256` 是操作员声明的材料身份，不是平台认证官方规则或当前授权；候选引用的 `task_contract_sha256` 是服务端整契约摘要，二者不能混用。基线字符串不证明可达性，规则声明不创建凭据或扩大网络/操作权限。逐规则筛选仅是附加前置门，不是独立提交资格判定。

## 后续高置信成果与 #775

高置信提交候选仍需独立复核、可复现证据、适用的攻击前提/链、knownness 的目标版本适用性、项目资格与报告收敛。不能用任意置信度数值阈值、severity、相似文本聚类、人工 disposition 或技术 confirmed 替代这些证据；不硬编码具体项目规则。

#767负责共同任务标准、目标契约与研究候选准入；#775负责当前目标版本的证据缺口、下一步、停止与整体报告收敛。用户目标版本、任务输入 SHA、Plan SHA、整契约 SHA 与代码 baseline 是不同身份。沿用已有 Plan/CompletionPolicy、Job/Attempt 和报告路径；既有完成门、预算及 unknown effect 约束保持有效，见 [Plan 设计与差额](PLAN_BOUNDED_INTENT_DESIGN.md)。研究候选有贡献不等于所有必要判据满足，unknown/blocked 不计成功。

## 验收与限制

可重复验收覆盖通用关键缺项、三种 outcome 选择不绕过、整个冻结契约变更、逐判据引用及贡献关联、跨项目/任务和缺失 Artifact、unknown/排除、赏金附加筛选、依据保存与冻结/压缩传播。具体运行结果见 PR，不把测试入口存在写成已运行。

未提供契约的入口迁移、高置信候选的独立证据与资格评审、#775整体报告接线及完整端到端验收仍有缺口，首片不能代表全部完成。用户已明确无需真实模型验收，不把模型或生产试验作为交付门槛；效果、提交接受率与奖励收益未验证，仍应如实说明。
