# #775 B/C：通过现有 Intent 的有界补证与执行型 Plan（设计与实现对照）

> 状态：**设计目标与实现对照**。B 的一次补证首片与持久接纳响应恢复已合入；#775 C/v2 已完成用户目标 CAS、现有 Hub Intent/Job 派发、依赖执行、多轮路由和停止条件接线。真实模型效果未验证，本批不要求真实模型验收。
> 同步日期：2026-10-31

当前新写入与执行仅接纳 Plan v2。下文 B/v1 的提交流程、单步补证和路线修订是历史设计与交付记录；历史记录可读，不能继续执行，也不能通过旧输入兼容启用。当前执行与本批验证以文末 C/v2 为准。

## 基线与交付边界

实现基线为 main `0841f827`，已含 A 审计可见性 #782、操作员判据/留存证据绑定 #785、B 首片 #791 与设计对照 #786。本切片补 B 的 Plan 成功接纳回执恢复，并在独立 v2 合约中接入执行型路线；B 的每 Canvas 单步预算仍不改变。

#791 的 [B 实现范围](https://github.com/SummerSec/DeepSonar/blob/1c04804e364e7c55522857c1f060bf9f308ace81/docs/PLAN_GAP_PROJECTION.md#b既有-intent-上的一次补证) 是一次补证行为说明；本文保留 B 设计边界，并在文末记录 C/v2 的当前实现。不能通过修改措辞将仍未实现的语义质量或真实效果验收视为已完成。

[Plan](../packages/shared-types/src/plan.ts) 已有目标、CompletionPolicy、依赖、预算、结果与审计。v1 `submit_plan` / `submit_plan_result` 本身不直接派发；#791 的首次显式 `submit_plan` 还启用当前 Canvas 的决策/自动完成门禁。[Hub 决策处理](../apps/scheduler/src/domains/event-ingestion/side-effects.ts) 才通过既有 Intent 派发，且派发前重做引用、角色、镜像与快照校验。B 不使 submit_plan 单独执行，也不新增第二套 Plan/Job/执行引擎。v2 的执行型 `submit_plan` 是明确的新版本契约：Scheduler 在同一事件事务中调用同一个 Hub Intent materializer，仍不建立第二执行通道。

首片 B 的可验收闭环限定为：既有任务 → 读取一个目标的当前缺口 → 一个有界补证 Intent → 既有 Job/Attempt/Evidence → 再读缺口并明确停止/等待人工。原设计上界为每个目标版本一次；#791 首片采用更严格的 **每 Canvas 至多一次**，换 Plan、内容版本、Job、标题或 Idempotency-Key 都不能重置。按版本重置 B 预算不是已实现能力。首片不支持递归换方法、多层依赖调度或持续自适应；这些是 B 首片的历史边界，不是 v2 的输入兼容层。

## 目标和来源身份

最小目标引用为 `plan_job_id + canonical raw Plan SHA`；判据复用 CompletionPolicy 的 `completion` / `output-N`，不让调用者额外写一份完成标准。它说明“该计划的这版判据”，不自动证明计划等于用户全部需求。

实现现状的输入身份来自已保存 Canvas title/target_json（排除 convergence 运行记账）、被引用 Artifact revision、Job/Attempt 冻结快照和留存 Evidence 内容；它不是另一个用户目标修订协议。不存在的目标代码 commit、外部环境版本或账号授权不得由模型补造。缺少完成所需基线时可提补证或 needs_human，不能宣布 complete。原 Plan 绑定无需 task_contract；可选目标评审关联要求同契约及持续有效来源，见[关联边界](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。#770 项目关联不参与证据与授权。

A 的 operator_attestation 是操作员语义评价，不能升级为模型评价器。B 可因已有证据不足而派发工作；若要提出有证据的 complete，则必须读取完整、非截断且全部必要判据均为当前授权 satisfied 的判据集合，并仍通过原有 Finding/Verify/Task 完成门。没有可用语义权威时停止为 needs_human；不能用 raw PlanResult 的 complete 绕过。

### complete 的完整真值表

complete 采用正向允许规则，不能只列少数禁止态：必须覆盖冻结 CompletionPolicy 的全部必要判据（completion 与所有 required_outputs），逐项为 **satisfied**，且该满足来自当前有效、明确授权的语义评价。criterion 集合为空、未知格式、分页未读完、任意截断或缺项都不允许 complete；不得挑选一个满足的子集代替全部判据。服务端最终事务重新读取完整集合，不能仅信模型已读页面。

| 当前必要判据状态 | complete | 后续提案 |
| --- | --- | --- |
| 全部 satisfied，且权威/版本/来源/完整性门均通过 | 仅可提案；仍须原有 Finding/Verify/Task 完成门通过 | 原完成路径，不直接改状态 |
| unbound | 拒绝 | continue（预算内）或 needs_human |
| insufficient（包括 inconclusive 评价） | 拒绝 | continue（预算内）或 needs_human |
| contradicted | 拒绝，即使反驳本身具有语义权威 | continue（预算内）、blocked 或 needs_human |
| conflict | 拒绝 | 补反证或人工处理 |
| stale | 拒绝 | 重读当前版本，显式重新评价 |
| blocked | 拒绝 | 记录前置条件，不推断阴性 |
| unknown/缺项/空集合/截断 | 拒绝 | 补读或 needs_human |

`observation=negative` 与 `assessment=satisfies` 是两个独立维度：只有“所执行的测试未观察到指定现象”本身是该判据需要的结果，且授权评价明确 satisfies，才可满足该判据；negative 字面量从不自行打开完成门。contradicts/inconclusive 也是有来源的语义评价，但均不是正向完成授权。

## 契约扩展位置

#791 已在现有 `plan.ts` 内定义版本化 **PlanDecisionBasis**，由现有 HubDecisionPayload/HumanPayload 引用；它只有依据/版本元数据，不复制 PlanTask、CompletionPolicy、PlanResult 或 Intent 的工作字段。首次元数据形态使用显式 `v:1`；若实际实现需要给现有 Plan/PlanResult 本体新增字段，必须按原契约升级其 literal 版本，禁止偷偷扩展现有 v1。旧数据仅作为不可变历史读取，不作为新运行时兼容输入。

以下保留设计概念字段；不能将它直接当作当前 API schema。#791 的 `plan_basis` 将 objective_ref 展开为 plan_job_id/plan_sha256/criterion_id，另要求 expected_task_input_sha256、expected_projection_sha256；当前只有 rationale，没有独立 unresolved 字段。若需要结构化 unresolved，仍须后续契约与测试，不声称已交付。

设计概念字段：

| 字段 | 用途与约束 |
| --- | --- |
| objective_ref | 当前 Canvas 的 plan_job_id、raw Plan SHA 和 criterion_id；必须服务端解析 |
| expected_revision | 最近已接纳决策的 semantic event ID；首次为被引用 Plan 事件 ID，不能用时间戳排序 |
| source_refs | 至多 4 个 canonical Fact ID 与当前来源 SHA；零个引用表示尚无证据，不能表示阴性 |
| outcome | 复用 continue / complete / blocked / needs_human 词汇；不是 Job 终态 |
| rationale / unresolved | 有界理由与未决项；模型文本只是提案 |
| expected_gain | 继续时说明一个 Intent 预期补哪个缺口；不是预算豁免 |

`continue` 必须伴随恰好一个既有 Intent；其它 outcome 不得携带工作。Intent.from 必须包含已声明且当前 Job 已见的 canonical 节点，并通过已有引用预算和范围检查。`blocked` / `needs_human` 使用既有停止/人工处理路径及审计，不直接写 Finding 或 Task 终态。大 payload_file 在宿主解析后按同一完整 schema 校验，不允许外层和文件内双写依据。

设计目标是模式不可绕过。#791 的实现触发点是 **首次显式 submit_plan 即启用 Canvas 门禁**，并非等下一次 Hub 创建才启用；最早 Plan 事件固定目标 Job，首次接纳依据再固定 Plan 内容与任务输入身份。后续 Hub 创建时附带 Scheduler 派生的 plan_context，但最终授权始终读取持久事件与当前来源，不能仅信启动快照。省略 plan_basis 不能退回普通决策；无显式 Plan 的任务仍走既有路径。普通 request_human 保持可用，防止读取预算耗尽后无法停止。

## 有界只读入口

扩展当前 Job 的 `graph_query` 只读查询：初始 L0/overview 只提供有界 handle；`kind=plan_objective` 在当前 Job scope 内独立于已接受 Plan 读取 `items[0]` 完整持久化 objective tuple，并带 canonical event revision。它不提供 selectors、cross-scope 或 wholeGraph；预算或 input hash 不满足时必须如实失败，不能把部分 tuple 当作完整依据。先校验当前 Job 的 Canvas/project 和工具白名单，才允许加载依据；不允许使用 Management API token 或绕到新的模型通道。

首片一次最多 4 个判据、4 个 Fact；沿用 Job graph 字节/引用预算。记录当前 Job 已见引用，禁止跨任务检索结果直接充当证据。返回截断或 unavailable 时，complete 必须拒绝；continue 可在明确缺口与授权范围内请求一个补证 Intent。实际留存字节由 Scheduler 的有界验证器核对，模型只按需读取证据内容。

## 持久化与原子性

优先复用 `events` 的 immutable semantic event 与当前 PlanAuditRecord。目标 ID 已是 Job 主键；决策 revision 使用事件行 ID。服务端从该目标的已接纳事件重建 latest revision / 是否已消耗一次补证，不从进程缓存或 prompt 判断。当前 head 必须完整查询，不可用“最近 32 条”报告展示窗口作并发权威。若该查询不能在现有索引上有界完成，须单独评审最小目标/修订表与 schema rebuild，而不能静默引入第二份权威 JSON 指针。

设计要求以 Canvas 为首锁，若需跨多个 Job 锁则按稳定顺序组织，避免 A 审查发现的 Canvas/Job 反序。#791 当前最终事件事务先锁 Canvas 与当前 Job，再对 Plan owner 取共享锁；同 Canvas 写入由首锁串行化。这不表示已经实现任意多 Job/Fact/Artifact 的通用稳定排序锁协议。preflight 只解释错误；最终事务必须重验 scope、expected_revision、Plan SHA、来源 SHA、当前 Job 状态、unknown effect、工具/角色/镜像准入、剩余预算及重复无进展。任一拒绝不得插入 Intent、Job、接纳审计或修改当前目标 head。

设计要求事务内先完成所有准备校验，再经既有 Intent 路径原子写入唯一 child Job 与接纳事件。#791 已实现该事务边界；child payload 保存 Scheduler-owned Plan Job/SHA 与决策事件关联，判据/理由可追溯到事件，不改写旧 Job 快照；取消仍走既有生命周期。不同 key 不能重置单步预算，同 expected_revision 并发提案只有一个接纳。

**持久接纳回执（as-built）：**带 plan_basis 的 submit_hub_decision/request_human 复用 events.control_receipt，绑定 Job、原 Attempt、operation、key、冻结 snapshot、原请求与展开内容摘要，保存不可变成功响应。先在事务外执行数据库 preflight，再以 Canvas→Job 锁序准备本地预留并保存回执；最终事件 ingestion 仍是 revision、预算、Intent/child 与权限的唯一原子结算点。回执不推进目标 head，也不代表 child 已创建。

GET 原 operation 的 receipt_key 始终只读；进程缓存丢失或 handler 注销后仍可恢复原成功响应。完全相同 POST 仅在原 Attempt 活动且租约有效时尝试恢复本地提案，不新建执行器；Hub 有 unknown effect 时不恢复，人工停止仍允许。payload_file 首次有界展开并完整校验；live handler 重试必须匹配原文件内容，无 handler 仅按原请求身份读响应。异输入、异 operation、原 key 被普通事件/完成/知识操作占用均拒绝；最终语义事件必须匹配回执内容和 Attempt。普通非 Plan 操作仍保留各自原有幂等边界。

不能把现有“裁剪至 maxIntentsPerDecision”当作 B 的接受方式：首片恰好一项，预算不足明确拒绝，禁止部分派发。补证上限和业务停止理由分别记账；maxHubRounds、Job token/时间预算、项目并发/配额仍有效，不跨任务借预算。

## 一次补证后的收口

完成关联通过现有 Job/Attempt 和 Canvas Intent 状态重建。既有 Hub 编排被再次触发时继承目标/决策版本，并按 graph_query 重读当前来源；不另建轮询器或 force Hub 循环。Verify 补证仍交给原有复验路径，不能设置 hub_followup 绕开其收口。

成功执行只使新来源“可供评价”，不直接满足判据；操作员或现有独立评价契约缺席时返回 needs_human。工具失败、账号/环境缺失、预算耗尽、取消、超时和 unknown effect 都保留原因，不转阴性；未知外部效果不自动重放。一次补证无进展后停止，不允许换标题、换 Idempotency-Key 或新建 Hub Job 重置当前 Canvas 的单步预算。

## 离线样本目标与证据边界

| 场景 | 预期可观察结果 |
| --- | --- |
| 正例与真实执行阴性 | 真实 retained bytes 与来源版本可追溯；结论依赖明确语义评价，非模型口头声明 |
| 未执行、环境/账号缺失 | unbound/blocked/needs_human，有未决原因，无阴性或成功断言 |
| 补证成功 | 一条 Intent、一条 child Job，经原路径产生 Artifact/Fact/Evidence；重读后可评价 |
| 换方法提案 | 仅在本次单步预算未消耗且既有能力允许时接纳；不可扩权 |
| 冲突、证据过期、目标变化 | complete 拒绝，旧报告不改写；补证必须引用当前版本 |
| 重复、并发、重启 | 持久 head 与原接纳响应重读；inline/file、清缓存/注销 handler、未结算回执恢复、并发修订与最多一个 child 均有离线 DB 回归 |
| 取消、超时、unknown effect | 沿既有生命周期停止，不自动重放副作用，不误报阴性 |
| 非法/跨项目/跨 Canvas/未见引用 | preflight 和最终事务均拒绝，无部分派发 |
| 非法依赖/越权能力/超额预算 | 复用已有检查，明确拒绝，不裁剪后假装全部接纳 |
| 无进展且已补证一次 | 明确停止/人工处理；不得重置目标版本或换标题继续循环 |

测试必须通过真实隔离 PostgreSQL 的控制 API → ingestion → Intent/Job → fake Attempt/retained bytes → graph projection；仅单元 mock 或手写数据库断言不算补证闭环。合成 fixtures 使用固定目标与来源字节、逐例记录 expected/observed，不使用真实模型或生产服务。CI 必须实际调用新增单元和 DB 入口，最终对精确 PR head 检查终态。

#791 的精确 head `1c04804e` 已通过 [ci](https://github.com/SummerSec/DeepSonar/actions/runs/40910039012) 与 [双架构 Reverse](https://github.com/SummerSec/DeepSonar/actions/runs/40910038950)。Plan 的三项 PostgreSQL 回归涵盖 Control → 实际 Intent 子 Job → 假 Worker 留存文件/emit_fact → 真实终态结算 → 既有自动 Hub 唤醒 → 重读来源 → 人工停止；另有实际字节、操作员绑定、全判据读取后通过 Control 提交 complete 的正向样本。首次省略依据、自动报告绕过、并发、过期版本、预算重置与 unknown effect 有回归证据。上述证据不宣称本表所有业务样本均已逐例完成，不覆盖真实模型收益；持久回执的新增回归见下文。

## 真实效果验收和剩余工作

离线样本只证明来源、决策检查、调度原子性与恢复边界。真实模型效果未验证，不声称质量或收益提升。独立人工标注、来源隔离的质量评审与其他非模型质量验收不由本批工程测试替代。

本切片扩展 plan-decision.integration.test.ts，使用两组 inline/file 业务样本验证：已持久接纳但 ingestion 前失败、无 handler 只读原结果、unknown effect 阻止恢复、原 Attempt 恢复一次、同 key 改输入/文件/operation 冲突与最终 CAS。executor 竞态测试覆盖预留不结算、旧 preflight 不覆盖、同事件 ID 普通调用不能绕过预留及失败释放。测试模拟重启后的内存缓存和 handler 丢失，不声称重新启动真实模型或恢复其会话。

未派发路线修订的 v1 已实现边界、版本字段与恢复行为见[路线修订](PLAN_GAP_PROJECTION.md#未派发路线修订)。它不开放用户目标变更或追加 B 补证预算。

## C/v2 当前实现对照

以下是 #775 C 的 as-built 结论，使用 `plan.v=2` 执行型协议；Control、ingestion 和运行时工具 schema 均拒绝 v1 新提案。objective 内部 `v:1` 等字段只作读取 metadata，提交的 Plan 严格为 `v:2`；历史 Plan/Result 和自动 Intent 适配审计仍可读取，不能成为执行 fallback。

- 授权用户在 `PATCH /tasks/{canvasId}` 以 `plan_objective.expected_revision` 做 CAS，持久保存目标 ID/revision、完整 CompletionPolicy、生命周期预算、输入 SHA 和状态。历史 Job、Attempt、semantic event、Artifact、Evidence 与报告保持不可变；新 revision 不重置已消耗任务数、轮数、无进展计数或 unknown-effect 账本。
- v2 Plan 必须携带显式 `execution_route` revision，并把目标 ID/revision、Plan owner、当前路线 revision 和当前 Plan SHA 放进严格协议。模型只能调整路线与未派发 task，不能修改用户目标、完成判据或预算；并发路线提交由 Scheduler CAS 选择一个成功者。
- 整条路线先复用既有 Hub Intent 准入；即使越权 task 尚未 ready，也会拒绝整个提案，不留下部分 child Job。ready task 再经同一个 materializer 复核 Canvas canonical 引用、普通角色、镜像/CLI/Provider/model、Finding/Verify、中央网络冻结、快照和共享资产。没有 Plan 专属队列或第二执行通道。
- 读取预算或输入 hash 不满足时，提交失败并保留明确原因，不以部分目标/Plan 响应继续派发。
- `depends_on` 要求当前用户目标 revision 的前置 Job 及最新 Attempt 成功。当前未拒绝的 Fact/Finding 必须投影自 submitted、未 superseded Artifact，并关联该 Attempt 的真实 semantic event。Artifact 和事件中的严格 `plan.output` extension 必须一致：`v:2`、objective ID/revision、task ID/SHA 与覆盖的精确 expected_outputs 名称；全部必要输出均须覆盖。留存文件复用有界验证器核对当前 Attempt 路径、finalized manifest、长度及实际 SHA。该关联证明输出来源与留存，不证明语义质量。
- owner/child 的终态、取消、超时、Reaper、Reconcile 和镜像撤销路径会重建状态。旧目标 revision 的 Job 保持历史身份并占用 lifetime 预算；其迟到回调可以释放并发槽位，但旧输出永远不能满足新目标的依赖或完成。相同目标版本内的已派发 task 在路线修订中保持字节一致。历史 unknown effect 仍 fail closed。
- `max_tasks`、`max_rounds`、`max_parallel_tasks` 和 `max_no_progress_rounds` 跨 key、路线、owner 与用户目标修订累计。取消、超时、失败、缺失输出、无进展和 unknown effect 均持久停止。当前路线执行投影完成后，Task/Hub complete 仍须全部必要判据的当前正向操作员评价及既有 Finding/Verify/report 门；PlanResult/done 不授予语义完成权威。
- v2 Plan/Result 已经 ingestion 成功接纳时，真实执行器允许 Hub 以原 mark_job_done 协议结束本轮，不要求再提交一个派发 Intent。此状态只由成功语义写入设置；未经接纳的 Hub 仍须原决策协议。

当前代码入口为 `packages/shared-types/src/plan.ts`、`apps/scheduler/src/domains/plan-protocol/execution.ts`、`execution-output.ts` 与 `apps/scheduler/src/domains/event-ingestion/side-effects.ts`。本批直接 Node/tsx 在各套件独立 CREATE/DROP 的真实 PostgreSQL 上跑通 Control→ingestion→准入 Intent/Job→fake Attempt/留存字节→graph projection；bootstrap fixture 仅用 HTTP objective 读取结果构造首个 v2 提案，并观测到恰好一个就绪 Worker；执行、停止、CAS、判据、独立评审和历史拒绝共 8 个 SQL 套件、16 项测试通过。新增套件的全局脚本/CI 接线由主集成方完成；尚未声称远端 CI 通过。真实模型、生产部署、人工语义质量与模型收益未验证。
