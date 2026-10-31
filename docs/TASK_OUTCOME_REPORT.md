# 任务目标报告防误报（#767 后续片）

> 状态：确定性报告与结构化来源复核；接入来源隔离的普通 Job 判据评审，不认证不同人/模型；不提供整体完成或提交资格授权。
> 同步日期：2026-10-30

本片接续[通用任务标准与研究候选准入](TASK_OUTCOME_ADMISSION.md)，防止报告把研究候选或技术 confirmed 写成任务成果。报告消费[来源隔离的普通 Job 评审](TASK_GOAL_REVIEW.md)，不自行生成语义评价，不新增执行通道或 Plan 完成门。当前来源隔离不认证不同人/模型；适用攻击链、knownness、提交资格和 #775 整体闭环仍需后续交付。

## 冻结输入与来源

[TaskOutcomeReport](../apps/scheduler/src/task-outcome-report.ts) 进入 Task Report 和 Finding Report 的冻结输入，包含：

- `mode: contracted | unassessed | invalid`；主完整 `contract` 与服务端整契约 `task_contract_sha256`；
- `contract_basis: canvas | source_job`：任务报告以 Canvas 为主，单 Finding 报告以该来源 Job 的冻结契约为主；`current_canvas_contract_sha256` 单独保留当前 Canvas 摘要用于冲突检查；
- `source_contracts`：同主契约摘要仅保留 hash 引用；不同摘要可附完整 contract/criteria，保留来源差异；
- `criteria`：仅保存派生判据 `id` 与 `assessment`（satisfied/contradicted/insufficient/conflict/not_assessed），按 ID 在完整契约定位目标、范围、证据、排除与验收文本，共享顶层缺口；不能只选候选已声明贡献的子集代替任务要求；
- 每条 Finding 的 `research_admission`、`technical_status`、`goal_assessment`、资格状态与 `gaps`；
- 整体 `goal_assessment`、`submission_eligibility`、`gaps` 与 `truncated`。

同一 hash 的完整契约只保存一次，不在各判据或来源引用中重复正文；原始来源规则不会为压缩预算而删去。单 Finding 报告只读取该 Finding 的来源契约，不加载整个 Canvas 所有 Job 契约。该去重避免约 19.5KB 的合法契约因重复投影挤爆约 40KB 的单 Finding 输入预算；这不是提高预算或隐藏截断。

来源复核检查当前项目/Canvas、来源 Job、Finding/Artifact/node 对应关系、事件与来源 Attempt。来源 Attempt 必须成功且仍是该 Job 最新 Attempt；此前成功而后来已重跑的来源不能冒充当前有效依据。Fact 引用同样检查关联 Artifact、来源事件、成功且最新的 Attempt、当前来源 Job 状态及 Fact 未被拒绝。Artifact 已替代、引用失效、原准入依据与 raw_json 声明不一致、版本不符或跨范围均显式保留缺口。

这些检查证明结构与来源条件，**不证明 Fact 在语义上满足判据**。研究准入重核不能升级为独立目标复核。Canvas 删除契约后，来源 Job 的冻结契约仍参与投影并标记缺失/不一致；即使尚无 Finding，已存在来源契约也不能被当作从未启用标准。读取有界，超限写入 truncated 与缺口，不宣称完整覆盖。

投影纳入既有 report-input 摘要计算；当前依据变化导致新报告输入及新版本，不回写历史报告。历史已冻结且没有该投影的输入保持原样，不补造当时的评审结论。

## 判据评价与整体完成分开

报告复核宿主冻结的普通 Job 评审记录，满足来源、当前成功 Attempt、无未知效果、自有 Fact 与本 Attempt 留存字节/hash 条件后，才贡献逐判据评价。运行中的提交只绑定，不直接变成正向结果。普通 Fact 不需先人工置 verified；没有新增全局人工评审门。详见[评审来源与证据](TASK_GOAL_REVIEW.md)。

逐判据区分 satisfied、contradicted、insufficient、conflict、not_assessed。只有 entire_criterion 的正向评价可贡献 satisfied，Agent 候选声明 matches、Fact 存在或技术 confirmed 本身不够。不同来源有效相反评价保留 conflict，不最后写覆盖；过期/失效记录留 gaps，不贡献正向。未覆盖判据仍未完成。

整体 goal_assessment 为 blocked、not_assessed、partially_satisfied 或 criteria_satisfied。criteria_satisfied 仅表达当前判据集合的评价，不是任务/Plan 完成授权；整体完成仍 not_assessed，归 #775。无契约入口仍 unassessed；invalid 契约不得降级为已评估。有赏金模式在没有独立程序资格投影时保持 submission_eligibility=not_assessed，非赏金为 not_applicable；#822 只在当前 Finding、可信程序材料、证据和独立评审仍有效时投影 eligible/ineligible/blocked，二者都不等于目标完成。

完整评审原文留 Artifact，报告 review_records 为紧凑来源引用，判据通过 review_indexes 关联；单 Finding 最多 20 条、Task 最多 100 条，截断不宣称正向完整结论。来源不同 Job 只证明执行来源隔离，不认证不同人/模型。

## 确定性正文与技术附录

所有新报告输入都带投影，统一由[确定性渲染](../apps/scheduler/src/report-outcome-projection.ts)生成正文，包括无契约的明确 unassessed。模型输出不得覆盖目标评价或凭空生成完成结论。任务文本、技术记录和原声明以转义后的引用数据呈现，不能通过 Markdown/HTML 把正文改写成正向结论。

任务身份、标题、目标、有效协议与范围/网络策略保存在确定性上下文附录；即使无契约、零 Finding 或无 Plan 也保留。技术详情、验证轮次、证据引用和数值仍保存在技术数据附录及原记录中，明确不计为任务达标成果。技术状态不会因此被删除或改写；内部 Finding/Fact/Artifact 与人的 disposition 继续独立。

非 Finding 的工程交付、有界负结果和 blocked/not_executed 已按[执行结果评审](TASK_RESULT_REVIEW.md)接入；它们不改变技术 Finding 的定义。宿主声明绑定核验与执行是否成功分开，失败 Job 的声明仍可显示阻塞/未执行及来源缺口，不贡献正向成果。来源、评审和报告共用 8MiB 证据预算，预算不足或截断不得宣称判据满足。报告将声明种类与判据评价分开，未执行不能显示成负结果，负结果不能自动显示成整体完成。本片不把新评审转换为 #775 的 operator_attestation 或 verified Fact authority。

## SARIF 边界

有契约或 invalid 的报告不把未评估任务候选导出为达标结果：SARIF `results` 为空，properties 保留目标评价、摘要、缺口及资格原因。空结果表示没有可由该评价路径确认的目标成果，不表示系统无漏洞或技术 Finding 不存在。

无契约路径保留既有技术 confirmed 的 SARIF 导出，但 properties 明确 technical-only 和任务未评估；这类结果也不计任务达标。历史无投影输入不重写，不能把历史技术导出追认为当时已做目标评审。

## 验收与未完成项

行为验收应覆盖：技术 confirmed 不计目标完成；伪造 raw_json authority 无效；来源 Job/Artifact/node/events/Attempt 失效；当前 Fact 撤销；Canvas 删除/修改契约；无 Finding 的来源快照；截断；模型正文/Markdown 注入无法覆盖结论；Task/Finding 报告及 SARIF 的一致边界；投影变化生成新版本；近契约上限的单 Finding 输入去重后仍保留全部源规则与判据。实现入口与测试见 [来源投影测试](../apps/scheduler/src/task-outcome-report.test.ts)和[报告正文测试](../apps/scheduler/src/report-numeric-fidelity.test.ts)，实际运行结果以 PR 记录为准。

报告防误报现已接入普通 Job 的来源隔离评审写入与逐判据展示；不完成不同人/模型独立性认证或 #775 整体目标收敛。#822 的程序资格投影是独立的受治理 operator review，不由普通目标评审、Agent 声明、技术 confirmed 或 `program_rule_review` 单独推导。无契约入口按原可选设计保持未评估，不是必须迁移的关闭阻碍。用户明确无需真实模型验收，不以模型/生产试验作为交付门；真实效果未验证，不能承诺质量收益。


## 独立程序规则投影

`findings[].program_rule_review` 将赏金程序规则与通用目标 criteria 分开，status 为 `not_assessed/partially_satisfied/rules_satisfied/blocked`，保留逐规则评价、证据 `review_indexes` 与规则来源摘要。聚合匹配同一 Finding 和完整冻结契约，不跨候选借用正例；全部通用目标判据满足不等于程序规则已复核。冲突、失效、unknown、截断或证据预算不足 fail closed。

requirement satisfied 表示满足要求，exclusion satisfied 表示未命中排除；规则未知不能推导满足。`rules_satisfied` 只针对操作员提供材料，不能单独改变 `submission_eligibility`；官方真实性、当前授权、攻击链、可复现性与 knownness 适用性不是这个结构化投影自动证明的事实。


程序规则投影在整份报告累计最多 100 条 Finding×rule 判据。超限时全部 `program_rule_review` 为 blocked、criteria 为空，并记录 `program_rule_projection_limit_exceeded`；不能保留先处理 Finding 的正向结论。可改看按 Finding 限定范围的报告，不把有界投影解释成完整任务覆盖。

规则证据失效且没有当前有效替代 review 时，该规则为 insufficient，程序规则整体 blocked。符合当前来源与证据要求的重新评审可恢复评价，不因历史失效记录永久阻塞；历史仍保留可追溯，不静默改写旧报告。

## 独立程序资格投影（#822）

程序规则投影与程序资格不是同一层。资格 API 和 append-only `audit_logs` 评审记录见 [程序资格评审](PROGRAM_ELIGIBILITY.md)。当前投影必须同时绑定当前 Finding Artifact revision/source digest、当前 Verify confirmed round、来源 Job 冻结契约中的受治理 target/baseline、当前证据指纹、可信程序材料的 program/version/source hash，以及由认证请求 actor 冻结的独立 reviewer identity、permission、时间和理由。

只有显式授权 operator 才能写入资格评审；Agent/internal actor、viewer、Finding maker 自批准、客户端 payload 中伪造的 reviewer、缺证据、规则版本/目标不匹配、材料撤销或历史截断均 fail closed。历史评审保留并可查询；当前 Finding、证据或材料变化会重新计算 projection，结果为 `not_assessed`、`eligible`、`ineligible` 或 `blocked`。技术 `confirmed` 不会单独改变资格，资格也不会改写技术状态或创建新的执行通道。
