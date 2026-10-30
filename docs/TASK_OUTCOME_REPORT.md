# 任务目标报告防误报（#767 后续片）

> 状态：确定性报告与结构化来源复核；无通用独立目标评审 authority，不提供目标达标或提交资格的正向判定。
> 同步日期：2026-10-30

本片接续[通用任务标准与研究候选准入](TASK_OUTCOME_ADMISSION.md)，防止报告把研究候选或技术 confirmed 写成任务成果。它不是独立语义评价器，不新增 Evaluation 协议、执行通道、Plan 完成门或自动评审 Job。独立复核、可复现证据、适用攻击链、knownness适用性、提交资格和 #775 整体闭环仍需后续交付。

## 冻结输入与来源

[TaskOutcomeReport](../apps/scheduler/src/task-outcome-report.ts) 进入 Task Report 和 Finding Report 的冻结输入，包含：

- `mode: contracted | unassessed | invalid`；主完整 `contract` 与服务端整契约 `task_contract_sha256`；
- `contract_basis: canvas | source_job`：任务报告以 Canvas 为主，单 Finding 报告以该来源 Job 的冻结契约为主；`current_canvas_contract_sha256` 单独保留当前 Canvas 摘要用于冲突检查；
- `source_contracts`：同主契约摘要仅保留 hash 引用；不同摘要可附完整 contract/criteria，保留来源差异；
- `criteria`：仅保存派生判据 `id` 与 `assessment: not_assessed`，按 ID 在完整契约定位目标、范围、证据、排除与验收文本，共享顶层缺口；不能只选候选已声明贡献的子集代替任务要求；
- 每条 Finding 的 `research_admission`、`technical_status`、`goal_assessment`、资格状态与 `gaps`；
- 整体 `goal_assessment`、`submission_eligibility`、`gaps` 与 `truncated`。

同一 hash 的完整契约只保存一次，不在各判据或来源引用中重复正文；原始来源规则不会为压缩预算而删去。单 Finding 报告只读取该 Finding 的来源契约，不加载整个 Canvas 所有 Job 契约。该去重避免约 19.5KB 的合法契约因重复投影挤爆约 40KB 的单 Finding 输入预算；这不是提高预算或隐藏截断。

来源复核检查当前项目/Canvas、来源 Job、Finding/Artifact/node 对应关系、事件与来源 Attempt。来源 Attempt 必须成功且仍是该 Job 最新 Attempt；此前成功而后来已重跑的来源不能冒充当前有效依据。Fact 引用同样检查关联 Artifact、来源事件、成功且最新的 Attempt、当前来源 Job 状态及 Fact 未被拒绝。Artifact 已替代、引用失效、原准入依据与 raw_json 声明不一致、版本不符或跨范围均显式保留缺口。

这些检查证明结构与来源条件，**不证明 Fact 在语义上满足判据**。研究准入重核不能升级为独立目标复核。Canvas 删除契约后，来源 Job 的冻结契约仍参与投影并标记缺失/不一致；即使尚无 Finding，已存在来源契约也不能被当作从未启用标准。读取有界，超限写入 truncated 与缺口，不宣称完整覆盖。

投影纳入既有 report-input 摘要计算；当前依据变化导致新报告输入及新版本，不回写历史报告。历史已冻结且没有该投影的输入保持原样，不补造当时的评审结论。

## 无正向语义权威时的状态

| 输入情况 | 报告判断 | 含义 |
| --- | --- | --- |
| 有契约（含来源 Job 留存契约） | mode=contracted，goal_assessment=blocked | 无通用独立目标评审依据；准入或技术确认不能替代它 |
| 契约损坏或作用域不可用 | mode=invalid，goal_assessment=blocked | 依据无效，不能退回无契约路径 |
| 当前及来源都无契约 | mode=unassessed，goal_assessment=not_assessed | 旧入口未评估，不能声称达到统一标准 |

有契约的必要判据均保留，不因 Agent 声明 matches、Fact 存在或技术 confirmed 而变成 satisfied。候选的结构化准入可以是 admitted_for_research，但目标评价仍 blocked；缺口明确包含独立目标评审尚不可用。非赏金资格为 not_applicable，赏金 `submission_eligibility` 为 not_assessed；not_applicable 也不是任务达标。

## 确定性正文与技术附录

所有新报告输入都带投影，统一由[确定性渲染](../apps/scheduler/src/report-outcome-projection.ts)生成正文，包括无契约的明确 unassessed。模型输出不得覆盖目标评价或凭空生成完成结论。任务文本、技术记录和原声明以转义后的引用数据呈现，不能通过 Markdown/HTML 把正文改写成正向结论。

任务身份、标题、目标、有效协议与范围/网络策略保存在确定性上下文附录；即使无契约、零 Finding 或无 Plan 也保留。技术详情、验证轮次、证据引用和数值仍保存在技术数据附录及原记录中，明确不计为任务达标成果。技术状态不会因此被删除或改写；内部 Finding/Fact/Artifact 与人的 disposition 继续独立。

## SARIF 边界

有契约或 invalid 的报告不把未评估任务候选导出为达标结果：SARIF `results` 为空，properties 保留目标评价、摘要、缺口及资格原因。空结果表示没有可由该评价路径确认的目标成果，不表示系统无漏洞或技术 Finding 不存在。

无契约路径保留既有技术 confirmed 的 SARIF 导出，但 properties 明确 technical-only 和任务未评估；这类结果也不计任务达标。历史无投影输入不重写，不能把历史技术导出追认为当时已做目标评审。

## 验收与未完成项

行为验收应覆盖：技术 confirmed 不计目标完成；伪造 raw_json authority 无效；来源 Job/Artifact/node/events/Attempt 失效；当前 Fact 撤销；Canvas 删除/修改契约；无 Finding 的来源快照；截断；模型正文/Markdown 注入无法覆盖结论；Task/Finding 报告及 SARIF 的一致边界；投影变化生成新版本；近契约上限的单 Finding 输入去重后仍保留全部源规则与判据。实现入口与测试见 [来源投影测试](../apps/scheduler/src/task-outcome-report.test.ts)和[报告正文测试](../apps/scheduler/src/report-numeric-fidelity.test.ts)，实际运行结果以 PR 记录为准。

本片完成报告防误报，不完成独立评审写入、可提交资格正向判定或 #775 整体目标收敛。无契约入口仍有迁移缺口。用户明确无需真实模型验收，不以模型/生产试验作为交付门；真实效果未验证，不能承诺质量收益。
