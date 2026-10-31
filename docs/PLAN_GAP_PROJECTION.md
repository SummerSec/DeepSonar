# Plan 缺口投影与操作员证据绑定（#775 A）

> 状态：A 的审计可见性与操作员判据绑定可用；B/v1 保留只读历史，新写入/执行仅允许 C/v2。当前实现包含用户目标 CAS、统一 Hub Intent/Job 准入、留存输出依赖门、多轮路线修订和持久停止投影。真实模型与非模型语义质量未验证。
> 同步日期：2026-10-31

## 读取与报告

任务报告冻结输入 `plan_gaps` 从同 Canvas/项目、type 不为 report 的 Jobs 读取现有 `plan_protocol`。最多最新 32 个 Job，累计条目不超过 65,536 UTF-8 bytes；超限显式 `truncated`。不读取项目关联。原始 prompt 不进入投影；模型 `from` 只作为 proposed_input_refs，不代表证据或授权。新 Plan 清空旧结果，PlanResult execution 必须唯一引用当前 raw Plan task_id。

每条审计保存来源 Job、审计来源、updated_at 和审计内容 SHA，目标、CompletionPolicy、输出、依赖、裁剪及模型 execution/outcome/termination。另以规范化 raw Plan 内容 SHA 标识判据版本：`completion` 对应 completion.description，`output-N` 对应 required_outputs 的稳定位置（版本变化需重新确认）。这是内容身份，不是新派发协议，也不证明目标代码 commit、外部环境或用户需求的版本。

`GET /jobs/:id` 的 `plan_gaps` 提供该版本与判据文本供管理客户端选择；该入口只读审计，判据默认 unbound。`GET /canvases/:id/facts/:nodeId` 返回当前 `plan_criterion_source`（内容 SHA、来源 ID、eligible/原因）和最近 32 条 `plan_bindings` 审计（超限标记 truncated）。报告与 Job-scoped plan_gap 读取会重算绑定的当前有效性；历史绑定本身不声称仍有效。

## 明确的操作员评价

既有 Fact verification PATCH（jobs:control）可带 `plan_binding`，必须同时提交 verified 和非空 note。调用者显式选择 Plan Job/内容 SHA、criterion_id、当前证据 SHA、expected_binding_id（首次 null），并给出 assessment=satisfies/contradicts/inconclusive 与 observation=positive/negative/unspecified。note 作为 rationale 固定在该次审计内。授权操作员对“证据是否满足此判据”负责；平台只校验证据来源与内容身份，不从关键词、confidence、模型 done/complete 或 Fact verified 单独推断满足。

绑定复用 append-only `audit_logs` 的 `canvas.fact.plan_binding`，记录 binding_id、Plan/判据/来源内容 SHA、Fact 验证 epoch、来源 Job/Attempt/event/Artifact revision/Evidence IDs 和明确评价。Fact 行锁串行化并发修改，expected_binding_id 拒绝过期改写；相同完整决定重试幂等。所有 Fact 信任更新（包括不带绑定的撤销/重验）先锁 Canvas，与报告冻结串行化；带绑定时统一按 Canvas → Plan Job → Fact 锁序；Fact 查询显式 FOR UPDATE OF n，不隐式反向锁 Canvas。Plan 行共享锁防止确认时更换计划；审计写入和 Fact 信任更新同事务，审计失败整体回滚。不新增 schema、Job 终态、执行账本或模型通道。

## 来源与失效

Fact 的来源由 body.artifact_id → 当前 emit_fact Artifact → 同 Canvas/项目 Job → 语义事件 → Attempt 连接，不能依赖可能为空的 Fact.job_id。只接纳成功 Job 和成功 Attempt、未 superseded Artifact、无 pending/unknown 外部效果的来源。报告 Job 不能作为分析证据。

每 Fact 最多 8 个 Evidence，要求 URI 指向该 Job/Attempt 下的留存相对文件，finalized manifest 唯一条目、声明 SHA、文件长度与实际文件 SHA 一致。不访问任意 URI、远端服务或符号链接。每文件最多 2 MiB，manifest 最多 256 KiB；单次证据读取或整个报告共享 8 MiB 预算。缺文件、错误、超限等均产生不可用原因；不降级为满足或阴性。

重新读取时核对 Plan/判据、Fact/Artifact 内容、事件、冻结 Job/Attempt 快照、Evidence 与实际字节的内容版本，以及 Fact 人工验证 epoch。证据变更、撤销、重新确认或计划变更使旧绑定 stale/blocked；重新设为 verified 不会自动恢复旧绑定，需要显式再绑定。该版本只覆盖已保存实体，未保存的目标仓库/外部环境变化不能被系统自动识别；操作员必须将适用范围写入判据与 rationale。

每个判据最多合并最新 64 条 Fact 绑定，未知格式或截断 fail closed 为 insufficient；正反当前评价并存为 conflict，blocked/stale/insufficient 不能被正例隐藏。无绑定为 unbound，不等于“尚未执行”。整体 Plan/Task 完成判断仍为 unknown；阴性仅表示操作员对当前证据的明确 observation，不是平台自动证明不存在问题。Finding confirmed 仍由既有 Verify 规则判定。

报告将确定性缺口节前置到模型正文之前，避免正文损坏的 HTML 注释/代码围栏隐藏它。相同冻结输入幂等；刷新会读取当前有效性并形成新输入版本，旧报告不回写。没有新增自动轮询或自动重生成。B 的单步派发边界见下节。

## 验证与剩余范围

`pnpm ci:unit:plan-protocol` 覆盖原有提案边界、聚合/失效、真实留存字节与路径预算；`pnpm ci:integration:plan-protocol` 在隔离 PostgreSQL 覆盖管理 API 权限、作用域、并发 CAS、重试、撤销重验、内容/Artifact/Attempt 失效、审计失败原子回滚与持久重建。入口已接 CI；具体通过结果以 PR 为准。

这份合成样本证明来源检查，不是实际漏洞任务或真实模型收益评测。本切片已从既有持久来源重建一次补证的排队/准备/运行/终态；v2 执行链另有 Plan owner → Hub Intent/Job → fake worker 输出的数据库夹具。环境缺失没有统一可信事实字段，不能自动认证。独立语义充分性、目标仓库 baseline 和真实模型效果仍未验证；不能以离线样本替代质量验收。原绑定不依赖 task_contract；显式选择目标评审关联的绑定另须满足下述契约一致性。

## B：既有 Intent 上的一次补证

本节是 B/v1 的历史交付记录。当前 schema 拒绝 v1 新写入，历史 plan_gap 返回 `historical=true`、`supplementation_remaining=0`；旧 Plan、旧单步决策或旧路线修订不能派发或完成新执行。原安全人工停止与只读接纳回执恢复仍可使用。

显式 submit_plan 的持久事件与原文内容必须一致。graph_query(kind=plan_gap) 只读当前 Job 的同 Canvas/项目，分页最多 4 判据、4 Fact 来源，沿用调用/字节预算与已见 canonical 引用。宿主保存本 Job 对当前 projection SHA 已读的完整判据 ID；截断绑定不记作完整已读。依据不来自报告最新 32 条窗口或项目关系。

submit_hub_decision 的可选 plan_basis 是新版本化决策元数据，不是第二套派发契约。它绑定 Plan Job/SHA、criterion_id、最新已提交事件 revision、任务输入 SHA、当前 projection SHA、最多四个已读 Fact 内容版本，以及 outcome/rationale；continue 还要求 expected_gain。仅允许一个既有 Intent，继续使用当前角色、镜像、权限、引用与快照准入。最终事务持有 Canvas→Job 锁后重新核验版本，拒绝旧提案。首片不执行 Plan 依赖图。

首次显式 submit_plan 即启用该 Canvas 的完成/派发依据门禁，省略 plan_basis 或尚未接受首次依据不能绕过；按最早 Plan 事件固定目标 Job，首次提交同时保存用户输入摘要；第一次接纳依据固定完成依据，后续仅可显式修订未派发路线。每 Canvas 至多一次补证；更换标题、Job、Plan 或 Idempotency-Key 不重置预算。已有去重使相同事件不会再次写入；#795 已持久保存带依据提案的成功接纳回执，缓存丢失后可按原 key/输入读取原响应。恢复接纳不等于恢复或成功结算，最终事件仍重验当前来源与版本。后续 Hub 的 plan_context 由既有编排派生，不修改历史快照、不增加轮询或模型通道。

complete 要求所有必要判据非空、当前 satisfied、未截断，且每个绑定均为 operator_attestation/satisfies；Job 必须已读完该 projection 的全部必要判据，并声明全部贡献 Fact 的当前版本。unbound/insufficient/contradicted/conflict/stale/blocked/unknown/missing 均拒绝。中央自动完成/报告门禁也检查全判据，不能通过轮数耗尽绕过。报告被 Plan 阻塞时返回 plan_not_ready，不伪称 Finding 未收敛，也不 force 回弹另一个 Hub。任何同任务 unknown effect（或终态 Job 遗留 pending effect）阻止补证和完成，返回 unknown_external_effect，不自动重放。

blocked/needs_human 使用现有 request_human 的 business_decision；不新增 Job 终态。普通 request_human 保持可用，避免查询预算耗尽后无法停止。运行器延迟终态提交保留 plan_basis，最终落库再次校验。

来源 SHA 现在包含已保存 Canvas title/target_json（排除运行态 convergence 记账）的 task_input_sha256。已有 A 绑定须显式重新评价，不能静默延续旧内容身份；历史报告不改写。这不等于目标仓库 commit 或外部环境版本，未保存的信息仍未知。

本片测试分别覆盖真实 Control API→PostgreSQL Intent 派发/版本拒绝/一次预算/人工停止，以及实际留存字节→操作员绑定→Job-scoped 读取→Control complete。同一 Control API→真实 Intent→假 Worker 的实际留存文件/Fact→既有自动 Hub 唤醒→再次读取→人工停止样本已加入数据库回归；并发双提案仅一个提交，unknown effect 禁止补证。假 Worker 不调用模型；真实模型收益未验证且不作为本批验收前置，C 不启用。


## 可选目标评审关联（#767）

操作员可在既有 `plan_binding` 中显式提供 `goal_review`：

```text
review_artifact_id: <目标评审 Artifact UUID>
task_contract_sha256: <整个冻结任务契约摘要>
criterion_ids: [<显式选择的任务判据 ID>]
expected_review_sha256: <当前评审依据摘要>
```

这只是现有 operator_attestation 的附加来源约束，不是新 authority。操作员必须在 note 中负责判断所选任务判据是否覆盖该 Plan 判据的自然语言要求，不按索引、文本相似度或同名自动映射。原始 Fact 仍须 verified，原 jobs:control 权限、来源证据、版本/CAS 与完整 Plan 完成门均保留。未选择关联的合法绑定继续按原规则工作，不增加所有任务的人工门。

选择关联时 Plan owner 必须冻结同一完整契约。读取并核验相关评审的完整有效集合，不能只挑正向评审绕过矛盾；关联的契约、来源、证据、Attempt、评价或摘要变化使绑定失效，不得静默退回无关联绑定。评审与既有证据检查共用有界读取预算，不完整或超限保持不足。全部必要 Plan 判据仍须满足原 complete 门，单项任务 criteria_satisfied 不会自动完成 Plan。

执行证据绑定使用 `content_schema_version: 2`，摘要明确排除 `manual_verification` 与 `verification_status`，以免仅改变人工验证注释的操作破坏执行证明身份；Fact rejected 仍拒绝。Plan 所需 verified 授权独立检查，摘要稳定不代表权限或人工信任无需重验。

这是摘要身份的部署边界，不能宣称无兼容影响：旧 v1 摘要可能失效，按当前契约严格拒绝，保留历史记录且不回写，不自动转换或授予新 authority。必要时重新产出 task_result 与独立评审；旧 assignment 不得静默改绑。#797/#798 已随本批合入；部署前仍须核对实际保存的证据版本。

#795 的持久接纳回执只恢复原接纳结果与可恢复原 Attempt，不证明最终结算成功。接纳后关联评审失效时，最终完成门仍须拒绝；真实路由与 PostgreSQL 的[完整链测试](../apps/scheduler/src/task-plan-review.integration.test.ts)已通过 9 项（含顶层套件），覆盖 delivery/negative_result、原绑定、冲突/失效、旧摘要与接纳后失效；组合 CI 结果以 PR 最终记录为准。

程序规则附加评审不扩展 Plan 通用判据映射：`goal_review_options` 过滤 `program_rule:<ruleid>`，该 ID 不得作为目标判据映射到 Plan。程序规则满足仍不是 Plan 完成或提交资格授权。

## #775 C：执行型 Plan v2 闭环（as-built）

本节记录当前实现的 v2 语义。上文 B 的“单步”“每 Canvas 至多一次”和“C 尚未启用”均是 B 首片的历史边界；它们不描述 v2 的新执行协议，也不能作为 v2 的兼容输入。

### 用户目标与路线身份

授权用户通过 `PATCH /tasks/{canvasId}` 提交严格的 `plan_objective` CAS。服务端在 Canvas 行锁内递增 `objective.revision`，保存目标、CompletionPolicy、生命周期预算、目标输入 SHA 和状态；模型只能提交与当前目标的完整 goal/completion/budget 恒等的 v2 Plan。目标修订不会改写历史 Jobs、Attempts、事件、Artifact 或报告，也不会重置已消耗的任务数、轮数、无进展计数或 unknown-effect 账本。模型不能使用新标题、新 key、`next_goal` 或路线理由弱化用户标准或重置预算。

v2 `submit_plan` 必须携带 `execution_route` revision，显式绑定 `plan_job_id`、目标 ID/revision、期望路线 revision 和期望当前 Plan SHA；首次路线使用 expected route `0`，后续路线由 Scheduler 以 CAS 单调递增。v1 新写入一律拒绝。同一目标 revision 内已派发 task 的不可变 SHA 必须在后继路线中保留；仅未派发 task 可调整。用户 CAS 到新目标 revision 后，旧 Job 仍不可变且计入 lifetime 预算，旧输出不能作为新目标的前置结果。

### 现有 Intent/Job 路径与依赖释放

接纳 v2 Plan 后，Scheduler 在同一事件事务中计算 ready tasks，并调用 event-ingestion 的共享 Hub Intent materializer。它复用当前 Canvas 引用、角色、运行时镜像、CLI、Provider/model、Finding/Verify、快照、网络策略、共享资产、Intent 节点和边的准入与落库逻辑；Plan 不建立第二个 worker queue 或 Job 执行器。Plan task 的 scheduler-owned context 冻结目标/路线/task SHA、分发事件和依赖输出引用。

`depends_on` 只在前置 task 的 Job 和最新 Attempt 成功、当前目标 revision 与 task SHA 匹配、Fact/Finding 当前未拒绝、Artifact submitted 且未 superseded 时释放。Artifact 与该 Attempt 的 fact/finding 事件必须包含一致的严格 `plan.output` extension，精确覆盖该 task 的全部 expected_outputs；每项关联的留存 Evidence 还须通过路径、finalized manifest、长度与实际 SHA 校验。单纯的 Evidence 行、done-only、PlanResult、旧目标/Attempt、未知效果或不完整来源都不能释放。该关联只证明输出来源及留存，不能替代操作员语义完成授权。

### 多轮推进、重启与停止

每次 Plan owner 或 child Job 终态，以及取消、Reaper、Reconcile 和镜像撤销等生命周期收口路径，都会在原有事务内重建当前状态；重启不依赖进程缓存。旧目标 revision 的 child 回调只能释放其占用的并发槽位，不能用旧输出满足新依赖或完成新目标。历史记录不改写，历史 unknown effect 仍 fail closed。后继任务被撤权时，savepoint 原子撤销整批新派发并持久停止，不回滚前置 Job 已证明的终态成功。

Scheduler 按用户授权的 `max_tasks`、`max_rounds`、`max_parallel_tasks` 和 `max_no_progress_rounds` 控制生命周期。活动 Job 存在时不误判无进展；路线或目标真正变化且无可派发进展时累计无进展轮；达到预算、无进展、依赖失败、缺失结构化输出、任务终态失败或 unknown external effect 时持久写入停止原因。仅所有当前 task 的权威输出齐全，并满足当前 CompletionPolicy 的 positive authority，才可写入 `complete`；模型 `PlanResult.complete` 不能替代 Worker 输出、Verify 门或报告门。

当前 v2 接口、数据库链路和 fake-worker 夹具位于 `packages/shared-types/src/plan.ts`、`apps/scheduler/src/domains/plan-protocol/`、`apps/scheduler/src/domains/event-ingestion/side-effects.ts` 及 `plan-execution*.integration.test.ts`。本地未设置 `TEST_DATABASE_URL` 时，PostgreSQL 集成用例会安全跳过；已运行的离线 schema/typecheck 结果不能代替未运行的 DB/HTTP 结果。真实模型、生产部署和人工语义质量仍未验证。

## 一次补证的执行投影

`graph_query(kind=plan_gap)` 与冻结报告条目增加 `supplementation_execution`。范围固定为 `single_supplementation`；不向 PlanTask、用户全部目标或同项目其他任务推断执行覆盖，不改变判据 `state`、已见引用、决策 revision、projection_sha256 或预算。独立 `source_sha256` 仅标识该执行投影；报告刷新把来源变化纳入新冻结输入，旧报告不回写。

只认已提交 `hub_decision` 的 continue 依据，匹配 Plan ID/SHA、当前项目/Canvas、child.parent_job_id、Scheduler-owned plan_context 和 decision_event_id。接纳回执、后续 Hub 和不完整关联都不是派发证据。单步根或子 Job 超过一个时 bounded 查询标记 unknown/truncated，不挑一条掩盖异常。

| 状态 | 依据与限制 |
| --- | --- |
| not_dispatched | 没有当前目标的已提交补证决策；不证明整个目标尚未执行 |
| queued | pending/claimed；允许尚无 Attempt，不声称沙箱已执行 |
| preparing / running | provisioning/running 与最新 active Attempt 一致 |
| waiting_human | Job 等待人工；可附当前 Attempt 的 human 事件类别，authority 固定 agent_report |
| succeeded / failed / cancelled / timeout | Job 与最新 Attempt 终态一致；成功仅指执行生命周期 |
| unknown | 关联缺失/重复、版本不符、状态矛盾、上下文丢失或未知效果 |

同一 SQL 快照读取 child、最新 Attempt、Intent、human 来源和所有 Attempt 的未知效果，防止新 Attempt 成功遮蔽旧效果；归属冲突、终态 Attempt 或终态 Job 遗留 effect_pending 也保持 unknown。原始错误、凭据、模型理由不回显；只投影固定生命周期原因码，credential 等 human 类别是 Agent 报告，不认证环境缺失。既有 Fact/Artifact/Evidence 绑定独立提供证据来源；执行状态不能代替其语义评价或将失败表达为阴性。未新增表、派发器、外联或自动轮询。

## 未派发路线修订

本节仅保留历史 v1 语义；当前路线 CAS 使用上文 C/v2 合约，不再接纳本节的 v1 写入输入。

`submit_plan` 的 Plan v1 本体不变，envelope 新增可选严格 `revision`：`v:1`、`kind:route`、`plan_job_id`、`expected_revision`、`expected_plan_sha256`、`expected_task_input_sha256` 与非空 `rationale`。首次提交仍用 `{plan}`；替换已有 raw Plan 必须显式修订，不能用新 key 隐式覆盖。

修订仅允许改变 tasks/open_questions；goal、completion、assumptions、budget 必须规范化恒等，不能由模型声称“语义等价”后弱化判据。这是执行路线调整，不是用户目标版本协议。首次 Plan 在 owner 的既有 payload 保存 `plan_input_sha256`；任务 title/target（排除 convergence）改变即失效，即使用新摘要提交也不能悄悄重设目标。缺少冻结输入的历史 Plan 不可修订，不自动补造旧基线。

最终事务沿 Canvas→当前 Job→Plan owner 锁序，校验活动 Attempt/租约、冻结 operation 权限、同项目/Canvas、当前事件 head、Plan/输入摘要、未消耗的一次补证预算。待结算 Plan 接纳回执、unknown effect 或终态 Attempt 遗留 pending effect 均阻止修订；任务/引用预算不足明确拒绝，不裁剪。新计划仍只是审计提案，依赖执行和角色/镜像实际准入仍由原 Intent 派发门负责。

新语义 plan 事件保存请求、作者 Job/Attempt、原版本与理由；原 owner 的 plan_protocol 更新为当前投影，原 events、Job 冻结快照、已派发 child、历史报告不修改。后继同 Canvas Job 可在原权限范围内修订同一 owner。判据仍按完整 Plan SHA 绑定，路线改变会使旧绑定 stale，必须重新评价，不能迁移旧操作员授权。首次 human basis 的旧路线 SHA 不会永久锁死已合法修订的路线；用户输入基线与 Canvas 补证预算不变。

路线修订即时结算，直接以既有 semantic event 恢复 `receipt_status:committed` 响应，无第二账本。相同 key/内容 POST 或 `GET submit_plan?receipt_key=<UUID>` 在当前 capability 授权下可恢复结果，handler/进程缓存缺失也不重执行；同 key 异内容/operation 拒绝。这个结果不同于 Hub 的 persisted_deferred 接纳回执，不声称已派发或完成任务。

`ci:integration:plan-protocol` 接入 `plan-revision.integration.test.ts`，以隔离 PostgreSQL/Control HTTP 覆盖并发 CAS、重放/恢复、撤权与过期租约、范围与版本失效、预算/未知效果/待结算回执、历史不可变。B 首片的每 Canvas 一次补证预算仍不变；上面的 C/v2 是独立的执行型 Plan 合约，不把 B 的一次补证升级成隐式多步能力。

## 冻结离线回放

[控制回放基线](../agent-harness/plan-replay/README.md) 保存 #809 的 v1 单步场景；它是历史控制回归基线，不能当作当前 v2 多轮依赖的验收结果。当前 v2 由 Plan execution/stop/objective/revision 与独立评审集成夹具验证；旧回放脚本和全局 CI 接线仍需主集成方按新契约整理。目标遗漏、模型 token 与质量保持 unknown；真实模型效果未验证。
