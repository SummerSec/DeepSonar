# #775 B：通过现有 Intent 完成一次有界补证（设计）

> 状态：**设计提案，未实现**。本 PR 只固定下一片的范围、契约归属和验收样本，不证明 B 已交付或模型收益。
> 同步日期：2026-10-29

## 基线与交付边界

核对 main `9cb1524a`，以及独立草稿 [#782](https://github.com/SummerSec/DeepSonar/pull/782)（A 审计可见性）、[#785](https://github.com/SummerSec/DeepSonar/pull/785)（A 操作员判据/留存证据绑定）。这两片尚未合并；以下引用是后续实现依赖，不把其能力冒充 main as-built。

[Plan](../packages/shared-types/src/plan.ts) 已有目标、CompletionPolicy、依赖、预算、结果与审计。`submit_plan` / `submit_plan_result` 当前只记账；[Hub 决策处理](../apps/scheduler/src/domains/event-ingestion/side-effects.ts) 才通过既有 Intent 派发，且派发前重做引用、角色、镜像与快照校验。B 不使 submit_plan 单独执行，也不新增第二套 Plan/Job/执行引擎。

首片 B 的可验收闭环限定为：既有任务 → 读取一个目标的当前缺口 → 一个有界补证 Intent → 既有 Job/Attempt/Evidence → 再读缺口并明确停止/等待人工。每个目标版本最多接纳一次补证派发；首片不支持递归换方法、多层依赖调度或持续自适应。未证明收益前不进入 C。

## 目标和来源身份

最小目标引用为 `plan_job_id + canonical raw Plan SHA`；判据复用 CompletionPolicy 的 `completion` / `output-N`，不让调用者额外写一份完成标准。它说明“该计划的这版判据”，不自动证明计划等于用户全部需求。

输入基线从现有 Canvas/task 冻结输入、被引用 Artifact revision、Job/Attempt 快照和留存 Evidence 内容身份取得；不存在的目标代码 commit、外部环境版本或账号授权不得由模型补造。缺少完成所需基线时可提补证或 needs_human，不能宣布 complete。无需 #767 新 task_contract，#770 项目关联不参与证据与授权。

A 的 operator_attestation 是操作员语义评价，不能升级为模型评价器。B 可因已有证据不足而派发工作；若要提出有证据的 complete，则必须读取非截断、无 stale/blocked/conflict 的当前判据集合，并仍通过原有 Finding/Verify/Task 完成门。没有可用语义权威时停止为 needs_human；不能用 raw PlanResult 的 complete 绕过。

## 契约扩展位置

提议在现有 `plan.ts` 内定义一个版本化 **Plan 决策依据**，由现有 HubDecisionPayload 引用；它只有依据/版本元数据，不复制 PlanTask、CompletionPolicy、PlanResult 或 Intent 的工作字段。首次元数据形态使用显式 `v:1`；若实际实现需要给现有 Plan/PlanResult 本体新增字段，必须按原契约升级其 literal 版本，禁止偷偷扩展现有 v1。旧数据仅作为不可变历史读取，不作为新运行时兼容输入。

最小元数据：

| 字段 | 用途与约束 |
| --- | --- |
| objective_ref | 当前 Canvas 的 plan_job_id、raw Plan SHA 和 criterion_id；必须服务端解析 |
| expected_revision | 最近已接纳决策的 semantic event ID；首次为被引用 Plan 事件 ID，不能用时间戳排序 |
| source_refs | 至多 4 个 canonical Fact ID 与当前来源 SHA；零个引用表示尚无证据，不能表示阴性 |
| outcome | 复用 continue / complete / blocked / needs_human 词汇；不是 Job 终态 |
| rationale / unresolved | 有界理由与未决项；模型文本只是提案 |
| expected_gain | 继续时说明一个 Intent 预期补哪个缺口；不是预算豁免 |

`continue` 必须伴随恰好一个既有 Intent；其它 outcome 不得携带工作。Intent.from 必须包含已声明且当前 Job 已见的 canonical 节点，并通过已有引用预算和范围检查。`blocked` / `needs_human` 使用既有停止/人工处理路径及审计，不直接写 Finding 或 Task 终态。大 payload_file 在宿主解析后按同一完整 schema 校验，不允许外层和文件内双写依据。

计划感知模式由 Scheduler 在创建 Hub 时冻结；该模式下不能通过省略元数据退回普通 Hub 决策来绕过版本/预算限制。尚未加入该模式的普通任务保持现有路径，不能将全平台既有任务默认为“已验收的目标规划”。

## 有界只读入口

扩展当前 Job 的 `graph_query` 只读查询，按需读取一个 objective 的版本、判据、绑定状态、来源 ID 与未决原因。先校验当前 Job 的 Canvas/project 和工具白名单，才允许加载依据；不允许使用 Management API token 或绕到新的模型通道。响应给出 canonical event revision，不能只返回模型可伪造的 SHA 文本。

首片一次最多 4 个判据、4 个 Fact；沿用 Job graph 字节/引用预算。记录当前 Job 已见引用，禁止跨任务检索结果直接充当证据。返回截断或 unavailable 时，complete 必须拒绝；continue 可在明确缺口与授权范围内请求一个补证 Intent。实际留存字节由 Scheduler 的有界验证器核对，模型只按需读取证据内容。

## 持久化与原子性

优先复用 `events` 的 immutable semantic event 与当前 PlanAuditRecord。目标 ID 已是 Job 主键；决策 revision 使用事件行 ID。服务端从该目标的已接纳事件重建 latest revision / 是否已消耗一次补证，不从进程缓存或 prompt 判断。当前 head 必须完整查询，不可用“最近 32 条”报告展示窗口作并发权威。若该查询不能在现有索引上有界完成，须单独评审最小目标/修订表与 schema rebuild，而不能静默引入第二份权威 JSON 指针。

锁顺序统一 **Canvas → 相关 Jobs（稳定 ID 顺序）→ Fact/Artifact**，避免 A 审查发现的 Canvas/Job 反序。preflight 只解释错误；最终事务必须重验 scope、expected_revision、Plan SHA、来源 SHA、当前 Job 状态、unknown effect、工具/角色/镜像准入、剩余预算及重复无进展。任一拒绝不得插入 Intent、Job、接纳审计或修改当前目标 head。

事务内先完成所有准备校验，再经既有 Intent 创建路径写入唯一 child Job 与现有事件/回执。child payload 只保存 Scheduler-owned 目标/判据关联，不改写旧 Job 快照；取消仍走既有生命周期。事件幂等沿用当前 durable receipt；相同 Idempotency-Key 重试返回原结果。不同 key 但相同目标版本/补证语义不得重复派发；同 expected_revision 并发提案只有一个接纳。

不能把现有“裁剪至 maxIntentsPerDecision”当作 B 的接受方式：首片恰好一项，预算不足明确拒绝，禁止部分派发。补证上限和业务停止理由分别记账；maxHubRounds、Job token/时间预算、项目并发/配额仍有效，不跨任务借预算。

## 一次补证后的收口

完成关联通过现有 Job/Attempt 和 Canvas Intent 状态重建。既有 Hub 编排被再次触发时继承目标/决策版本，并按 graph_query 重读当前来源；不另建轮询器或 force Hub 循环。Verify 补证仍交给原有复验路径，不能设置 hub_followup 绕开其收口。

成功执行只使新来源“可供评价”，不直接满足判据；操作员或现有独立评价契约缺席时返回 needs_human。工具失败、账号/环境缺失、预算耗尽、取消、超时和 unknown effect 都保留原因，不转阴性；未知外部效果不自动重放。一次补证无进展后停止，不允许换标题、换 Idempotency-Key 或新建 Hub Job 重置这一目标版本的预算。

## 必须先通过的离线样本

| 场景 | 预期可观察结果 |
| --- | --- |
| 正例与真实执行阴性 | 真实 retained bytes 与来源版本可追溯；结论依赖明确语义评价，非模型口头声明 |
| 未执行、环境/账号缺失 | unbound/blocked/needs_human，有未决原因，无阴性或成功断言 |
| 补证成功 | 一条 Intent、一条 child Job，经原路径产生 Artifact/Fact/Evidence；重读后可评价 |
| 换方法提案 | 仅在本次单步预算未消耗且既有能力允许时接纳；不可扩权 |
| 冲突、证据过期、目标变化 | complete 拒绝，旧报告不改写；补证必须引用当前版本 |
| 重复、并发、重启 | durable head/回执重建；最多一个 child，不重复消耗或回滚既有事实 |
| 取消、超时、unknown effect | 沿既有生命周期停止，不自动重放副作用，不误报阴性 |
| 非法/跨项目/跨 Canvas/未见引用 | preflight 和最终事务均拒绝，无部分派发 |
| 非法依赖/越权能力/超额预算 | 复用已有检查，明确拒绝，不裁剪后假装全部接纳 |
| 无进展且已补证一次 | 明确停止/人工处理；不得重置目标版本或换标题继续循环 |

测试必须通过真实隔离 PostgreSQL 的控制 API → ingestion → Intent/Job → fake Attempt/retained bytes → graph projection；仅单元 mock 或手写数据库断言不算补证闭环。合成 fixtures 使用固定目标与来源字节、逐例记录 expected/observed，不使用真实模型或生产服务。CI 必须实际调用新增单元和 DB 入口，最终对精确 PR head 检查终态。

## 真实效果验收和剩余工作

离线样本只证明来源、决策检查与调度原子性。真实执行质量需另获授权的受控模型试验，在冻结任务基线逐例比较目标遗漏、错误完成、无进展轮数、人工介入、证据充分性及 token/时间，报告分母，不预设提升比例。没有这些结果不能进入 C 或关闭 #775。

本设计没有新增可运行接口、schema、Job 终态或模型调用；OpenAPI 仍描述当前 as-built，待实现 PR 同步正式字段和 FR-RPT-001 / FR-FACT-002 追溯与运行证据。后续实现应先落只读 graph_query 元数据及 receipt/CAS 样本，再接唯一 Intent 链路；两个子片都通过，才能声称 B 的一次补证闭环交付。
