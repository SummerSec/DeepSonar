# Plan 只读缺口审计（#775 首片）

> 状态：部分实现；阶段 A 的审计可见性切片，非完整证据判据投影。B/C 与真实模型效果尚待实现/验收。
> 同步日期：2026-10-29

任务报告冻结输入的 `plan_gaps` 从同一 Canvas、同一项目且 type 不为 report 的 Jobs 读取现有 `plan_protocol` 审计。最多取最新 32 个 Job（created_at、id 确定性排序）；投影条目累计不超过 65,536 UTF-8 bytes，超限停止纳入并显式 `truncated`。排除任务/Finding 报告 Job 自身，避免报告产物反向成为分析来源；当前工具硬白名单拒绝 report 的 submit_plan，DB 回归同时验证这一拒绝与构造历史审计不影响 refresh 幂等。不读取项目关联，不引入表、派发入口或模型通道。无审计、非法审计和截断均不能解释为未执行或阴性。

每条审计保存来源 Job、审计来源、updated_at 和解析后内容 SHA-256，以及目标、CompletionPolicy、预期输出、依赖、裁剪情况、模型声明的 execution/outcome/termination 与未决问题。SHA 是快照身份，不是乐观锁 revision；Attempt 和判据到 Artifact/Fact/Evidence 的权威关联尚不可得，因此不伪造这些引用。`from` 仅展示为 proposed_input_refs，不表示当前 Job 已见证据或获授权。

当前协议没有机器可验证的判据证据绑定，所以所有完成判断是 `unknown`。即使模型写 done/complete、阴性或正例，平台也不据此满足判据。环境缺失、工具失败、预算耗尽、冲突、来源过期、重复无进展和 unknown effect 的样本均保持 unknown；这些是保守投影回归，不是证明平台已经检测这些原因或完成真实执行评测。

调度器在通过现有 Finding 覆盖/数值校验后的 Markdown 前置确定性缺口节（独立起始上下文，模型末尾未闭合注释/围栏不能吞掉该节），因此模型省略缺口节也不会省掉该说明。报告仍按冻结输入 hash 管理版本；旧报告不回写。新报告读取最新审计，但不声称具备源证据撤销的自动失效机制。原始 prompt 不进入该投影。审计中的文本仍为提案，不提升为验证事实。

新 Plan 替换当前审计时清空前一个结果与停止理由；历史语义事件仍保留。PlanResult execution 必须唯一引用当前 raw Plan 的 task_id，非法提交不写审计。这只是后续有界规划所需的一致性修复，不代表 B 的补证派发已接通。

## 验证与后续

`pnpm ci:unit:plan-protocol` 覆盖提案/事实区分、十类保守样本、快照重建、来源变化和旧结果清除；`pnpm ci:integration:plan-protocol` 覆盖真实 DB 的作用域、持久读取一致性、非法结果拒绝、新计划重置及原有不派发行为；`pnpm ci:unit:verify-eligibility` 覆盖最终报告附录。上述入口已在 CI 调用，实际通过情况见 PR。

阶段 A 仍需权威判据与证据来源/版本绑定、独立完成判断、证据过期/冲突计算和代表性任务回放。阶段 B 需扩展现有 Plan 版本及持久 revision 校验，通过既有 Intent 完成补证；阶段 C 需先取得固定样本改善证据再扩展有界规划。真实模型质量、遗漏/错误完成率、token/时间的逐例对照未运行。#775 不应因本片合并关闭，也不依赖 #767 新 task_contract。
