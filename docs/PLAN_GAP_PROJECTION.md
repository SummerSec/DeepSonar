# Plan 缺口投影与操作员证据绑定（#775 A）

> 状态：部分实现；A 的审计可见性与操作员判据绑定可用，B 单步决策、假执行闭环及持久接纳回执已接线；可选目标评审关联已接线，不提供自动语义判定。真实模型效果未验证且已豁免验收，C 未启用。
> 同步日期：2026-10-29

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

这份合成样本证明来源检查，不是实际漏洞任务或真实模型收益评测。尚未自动识别未执行/执行中/环境缺失、独立推断语义充分性、建立用户目标 revision 或目标仓库 baseline。B 需复用版本化 Plan/Intent，在 canonical 引用、预算与审计下完成一个补证闭环；C 以固定真实样本改善证据为前提。未运行付费模型或生产试验，未验证遗漏率/错误完成率/token/时间改善，不能关闭 #775。原绑定不依赖 task_contract；显式选择目标评审关联的绑定另须满足下述契约一致性。

## B：既有 Intent 上的一次补证

显式 submit_plan 的持久事件与原文内容必须一致。graph_query(kind=plan_gap) 只读当前 Job 的同 Canvas/项目，分页最多 4 判据、4 Fact 来源，沿用调用/字节预算与已见 canonical 引用。宿主保存本 Job 对当前 projection SHA 已读的完整判据 ID；截断绑定不记作完整已读。依据不来自报告最新 32 条窗口或项目关系。

submit_hub_decision 的可选 plan_basis 是新版本化决策元数据，不是第二套派发契约。它绑定 Plan Job/SHA、criterion_id、最新已提交事件 revision、任务输入 SHA、当前 projection SHA、最多四个已读 Fact 内容版本，以及 outcome/rationale；continue 还要求 expected_gain。仅允许一个既有 Intent，继续使用当前角色、镜像、权限、引用与快照准入。最终事务持有 Canvas→Job 锁后重新核验版本，拒绝旧提案。首片不执行 Plan 依赖图。

首次显式 submit_plan 即启用该 Canvas 的完成/派发依据门禁，省略 plan_basis 或尚未接受首次依据不能绕过；按最早 Plan 事件固定目标 Job，第一次接纳依据后再固定 Plan 内容与输入版本。每 Canvas 至多一次补证；更换标题、Job、Plan 或 Idempotency-Key 不重置预算。已有去重使相同事件不会再次写入；HTTP 进程缓存丢失后的旧版本请求会 fail closed，不保证返回原成功响应。此限制不是持久 HTTP receipt 已实现的声明。后续 Hub 的 plan_context 由既有编排派生，不修改历史快照、不增加轮询或模型通道。

complete 要求所有必要判据非空、当前 satisfied、未截断，且每个绑定均为 operator_attestation/satisfies；Job 必须已读完该 projection 的全部必要判据，并声明全部贡献 Fact 的当前版本。unbound/insufficient/contradicted/conflict/stale/blocked/unknown/missing 均拒绝。中央自动完成/报告门禁也检查全判据，不能通过轮数耗尽绕过。报告被 Plan 阻塞时返回 plan_not_ready，不伪称 Finding 未收敛，也不 force 回弹另一个 Hub。任何同任务 unknown effect（或终态 Job 遗留 pending effect）阻止补证和完成，返回 unknown_external_effect，不自动重放。

blocked/needs_human 使用现有 request_human 的 business_decision；不新增 Job 终态。普通 request_human 保持可用，避免查询预算耗尽后无法停止。运行器延迟终态提交保留 plan_basis，最终落库再次校验。

来源 SHA 现在包含已保存 Canvas title/target_json（排除运行态 convergence 记账）的 task_input_sha256。已有 A 绑定须显式重新评价，不能静默延续旧内容身份；历史报告不改写。这不等于目标仓库 commit 或外部环境版本，未保存的信息仍未知。

本片测试分别覆盖真实 Control API→PostgreSQL Intent 派发/版本拒绝/一次预算/人工停止，以及实际留存字节→操作员绑定→Job-scoped 读取→Control complete。同一 Control API→真实 Intent→假 Worker 的实际留存文件/Fact→既有自动 Hub 唤醒→再次读取→人工停止样本已加入数据库回归；并发双提案仅一个提交，unknown effect 禁止补证。假 Worker 不调用模型；真实沙箱/模型收益仍待单独验收，C 不启用。


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

这是摘要身份的部署边界，不能宣称无兼容影响：旧 v1 摘要可能失效，按当前契约严格拒绝，保留历史记录且不回写，不自动转换或授予新 authority。必要时重新产出 task_result 与独立评审；旧 assignment 不得静默改绑。#797/#798 在本批集成时尚未合并或部署，不消除该版本边界，部署前仍须核对实际保存的证据版本。

#795 的持久接纳回执只恢复原接纳结果与可恢复原 Attempt，不证明最终结算成功。接纳后关联评审失效时，最终完成门仍须拒绝；真实路由与 PostgreSQL 的[完整链测试](../apps/scheduler/src/task-plan-review.integration.test.ts)已通过 9 项（含顶层套件），覆盖 delivery/negative_result、原绑定、冲突/失效、旧摘要与接纳后失效；组合 CI 结果以 PR 最终记录为准。
