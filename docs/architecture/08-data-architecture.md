# 08 数据架构与真相流

> 状态：**as-built**（#741）。说明 schema 基线、核心实体、三类真相流和状态机；列定义以 `database/schema.sql` 与代码为准。
> 同步日期：2026-11-12

## 人工等待断点与累计时钟（#1074）

schema 74 仅新增列表索引 `jobs_project_created_idx (project_id, created_at DESC, id DESC)`，服务不带 `status` 的 Job 列表（#1136）。schema 73 新增 human_requests（原 human 事件/Attempt、revision、断点 manifest、退出/回收、回复与唯一 successor）和 job_execution_clocks（冻结时间预算、累计 active 毫秒和精确 owner）。human_messages 用请求与版本关联回复；accepted 事件、回复已保存、注入、ACK、完成分别记账。文件使用现有 BLOB_DIR 下有界 CAS，30 天到期先持久阻断再删除；不可见/缺失/hash 不符不视为空文件。请求表是管理当前状态，不覆盖历史事件。见[人工续做](../HUMAN_CONTINUATION.md)。

mark_job_done 修正回执复用 events 的宿主 control_receipt 语义事件、Job 锁、Attempt 关联与原 key/digest；不新建平行效果账本或修改 schema。回执与最终 done 分别派生 Job/key 范围内的不同事件身份，持久接受不代表结算，详见 [#776 B](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

## 完成恢复事实与证据（#874）

[恢复实现](../../apps/scheduler/src/domains/job-attempt/recovery.ts)沿用 `events` / `event_dedup`，不新增 schema、Job 状态或平行效果账本。Job/Attempt 绑定的恢复根由 Scheduler 生成，state/wake 事件只追加；revision 取持久 job sequence，原 deadline、wake 上限和累计预算不会因换 key、证据变化或重启重置。完整 scoped effect/ledger 证据在数据库中计算摘要，模型只读有界、脱敏投影；Canvas metadata 是可重建视图，不能作为恢复授权。

原 completion 负回执不可改写，对账请求的持久接纳也不表示 effect settled。精确 usage proof 必须匹配 project/Job/Attempt/effect；pending、not_reported、缺失用量及未知资源归属不推断为零。Job-only 回执事务不写 Canvas，恢复泵/application 按 Canvas-first 更新投影。决策、未来缺口与待执行验收见 [ADR 0015](adr/0015-governed-completion-recovery.md)、[FR-CTRL-010](01-system-specification.md#fr-ctrl-010-完成未知效果的受治理恢复)及[专题](../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)。

## 执行前证明与历史预算（#943）

沿用 `events.control_receipt` / `event_dedup` / job sequence，不新增表或状态。`gateway_snapshot_preflight` 由 Dispatcher 的执行前 checkpoint 保存，绑定 Job、唯一首次 Attempt 与完整旧 snapshot 摘要；它不是 Gateway transport settlement 或模型 ACK。恢复只读重验宿主身份/事件摘要及全量效果、token、usage 和后续事件，不能仅凭回执存在重放。完整 `gateway_request_budget` 回执独立保留未签发 workload 的原有限策略；新执行不删除/重写历史回执、Attempt、用量或 deadline，细则见[生命周期专题](../AGENT_REPAIR_LIFECYCLE.md#缺损快照的可信显式恢复943)。最终 SHA Actions 待验。

## Provision 诊断来源引用（#1002 P2-10）

沿用 append-only `audit_logs`，首次固定宿主诊断及原 `job_attempts.state_json.provision_failure_audit_id` 在同事务发布，引用重复不覆盖首份。只追加诊断来源，不改 snapshot、phase/status、effect/settlement/replay policy 或预算，不增加表/状态。Job GET 仅用有界合法引用做 audit 主键读取，重核 scheduler、项目/Job/Attempt 与 schema；不读取任意 audit 元数据，坏/外来/旧引用不猜测回填。诊断不是 no-start/用量证明或第二个效果账本。实现/SQL回归及边界见[专题](../OPENSANDBOX_1_2_UPGRADE.md#provision-失败诊断1002)，最终 SHA Actions 待验。

## Schema 基线纪律


## 人工等待让位持久身份（#1074）

schema 75 增加 project_task_queue_yields，绑定 mutation_id、原条目、请求 revision、消费回复和返回条目。membership 增加 yielded 状态，不参与队首选择。回复保存事务只更新序号及 queued 状态，保留 created_at/started_at 的完成代际。原请求唯一约束防止重复决定，审计和状态同事务。重建仍沿唯一基线与备份流程。
