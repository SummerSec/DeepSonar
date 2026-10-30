# Plan 缺口投影与操作员证据绑定（#775 A）

> 状态：部分实现；A 的审计可见性与操作员判据绑定可用，自动语义判定、代表性真实任务评测、B/C 尚待交付。
> 同步日期：2026-10-29

## 读取与报告

任务报告冻结输入 `plan_gaps` 从同 Canvas/项目、type 不为 report 的 Jobs 读取现有 `plan_protocol`。最多最新 32 个 Job，累计条目不超过 65,536 UTF-8 bytes；超限显式 `truncated`。不读取项目关联。原始 prompt 不进入投影；模型 `from` 只作为 proposed_input_refs，不代表证据或授权。新 Plan 清空旧结果，PlanResult execution 必须唯一引用当前 raw Plan task_id。

每条审计保存来源 Job、审计来源、updated_at 和审计内容 SHA，目标、CompletionPolicy、输出、依赖、裁剪及模型 execution/outcome/termination。另以规范化 raw Plan 内容 SHA 标识判据版本：`completion` 对应 completion.description，`output-N` 对应 required_outputs 的稳定位置（版本变化需重新确认）。这是内容身份，不是新派发协议，也不证明目标代码 commit、外部环境或用户需求的版本。

`GET /jobs/:id` 的 `plan_gaps` 提供该版本与判据文本供管理客户端选择；该入口只读审计，判据默认 unbound。`GET /canvases/:id/facts/:nodeId` 返回当前 `plan_criterion_source`（内容 SHA、来源 ID、eligible/原因）和最近 32 条 `plan_bindings` 审计（超限标记 truncated）。只有报告读取会重算绑定的当前有效性；历史绑定本身不声称仍有效。

## 明确的操作员评价

既有 Fact verification PATCH（jobs:control）可带 `plan_binding`，必须同时提交 verified 和非空 note。调用者显式选择 Plan Job/内容 SHA、criterion_id、当前证据 SHA、expected_binding_id（首次 null），并给出 assessment=satisfies/contradicts/inconclusive 与 observation=positive/negative/unspecified。note 作为 rationale 固定在该次审计内。授权操作员对“证据是否满足此判据”负责；平台只校验证据来源与内容身份，不从关键词、confidence、模型 done/complete 或 Fact verified 单独推断满足。

绑定复用 append-only `audit_logs` 的 `canvas.fact.plan_binding`，记录 binding_id、Plan/判据/来源内容 SHA、Fact 验证 epoch、来源 Job/Attempt/event/Artifact revision/Evidence IDs 和明确评价。Fact 行锁串行化并发修改，expected_binding_id 拒绝过期改写；相同完整决定重试幂等。所有 Fact 信任更新（包括不带绑定的撤销/重验）先锁 Canvas，与报告冻结串行化；带绑定时统一按 Canvas → Plan Job → Fact 锁序；Fact 查询显式 FOR UPDATE OF n，不隐式反向锁 Canvas。Plan 行共享锁防止确认时更换计划；审计写入和 Fact 信任更新同事务，审计失败整体回滚。不新增 schema、Job 终态、执行账本或模型通道。

## 来源与失效

Fact 的来源由 body.artifact_id → 当前 emit_fact Artifact → 同 Canvas/项目 Job → 语义事件 → Attempt 连接，不能依赖可能为空的 Fact.job_id。只接纳成功 Job 和成功 Attempt、未 superseded Artifact、无 pending/unknown 外部效果的来源。报告 Job 不能作为分析证据。

每 Fact 最多 8 个 Evidence，要求 URI 指向该 Job/Attempt 下的留存相对文件，finalized manifest 唯一条目、声明 SHA、文件长度与实际文件 SHA 一致。不访问任意 URI、远端服务或符号链接。每文件最多 2 MiB，manifest 最多 256 KiB；单次证据读取或整个报告共享 8 MiB 预算。缺文件、错误、超限等均产生不可用原因；不降级为满足或阴性。

重新读取时核对 Plan/判据、Fact/Artifact 内容、事件、冻结 Job/Attempt 快照、Evidence 与实际字节的内容版本，以及 Fact 人工验证 epoch。证据变更、撤销、重新确认或计划变更使旧绑定 stale/blocked；重新设为 verified 不会自动恢复旧绑定，需要显式再绑定。该版本只覆盖已保存实体，未保存的目标仓库/外部环境变化不能被系统自动识别；操作员必须将适用范围写入判据与 rationale。

每个判据最多合并最新 64 条 Fact 绑定，未知格式或截断 fail closed 为 insufficient；正反当前评价并存为 conflict，blocked/stale/insufficient 不能被正例隐藏。无绑定为 unbound，不等于“尚未执行”。整体 Plan/Task 完成判断仍为 unknown；阴性仅表示操作员对当前证据的明确 observation，不是平台自动证明不存在问题。Finding confirmed 仍由既有 Verify 规则判定。

报告将确定性缺口节前置到模型正文之前，避免正文损坏的 HTML 注释/代码围栏隐藏它。相同冻结输入幂等；刷新会读取当前有效性并形成新输入版本，旧报告不回写。没有新增自动轮询、自动重生成或派发。

## 验证与剩余范围

`pnpm ci:unit:plan-protocol` 覆盖原有提案边界、聚合/失效、真实留存字节与路径预算；`pnpm ci:integration:plan-protocol` 在隔离 PostgreSQL 覆盖管理 API 权限、作用域、并发 CAS、重试、撤销重验、内容/Artifact/Attempt 失效、审计失败原子回滚与持久重建。入口已接 CI；具体通过结果以 PR 为准。

这份合成样本证明来源检查，不是实际漏洞任务或真实模型收益评测。尚未自动识别未执行/执行中/环境缺失、独立推断语义充分性、建立用户目标 revision 或目标仓库 baseline。B 需复用版本化 Plan/Intent，在 canonical 引用、预算与审计下完成一个补证闭环；C 以固定真实样本改善证据为前提。未运行付费模型或生产试验，未验证遗漏率/错误完成率/token/时间改善，不能关闭 #775。实现不依赖 #767 新 task_contract。
