# 删除项目任务队列（#1180）

> 状态：队列专属实现已删除，普通调度与历史保留；最终 SHA GitHub Actions 待验，不表示已发布或升级。
> 同步日期：2026-11-21

## 当前决定与范围

#1180 取代 #1018 的项目任务串行队列需求。队列界面、创建选项、管理 API、共享类型、请求/响应专属字段、OpenAPI、权限与路由映射，以及 Scheduler 的资格判定、占位、推进、对账、重试和人工续做依赖均已删除；数据库基线删除全部队列专属表、索引、序列、约束，相应专属存储、配置与测试移除。不以默认关闭、隐藏界面、开关、双读双写或兼容返回保留旧契约。

原功能按完整任务串行授予资格，普通并发按 Job 限制资源，两者粒度不同。本次是用户明确的产品简化决定，不是已证实的并发计算缺陷。减少一套控制入口、顺序与阻塞原因，不新增替代队列、设置或通知；注意力收益尚未实测。

## 保留的调度与任务行为

任务统一使用既有 Scheduler。全局、项目、Provider、凭据、模型、Agent CLI 并发及 provisioning 限制继续生效；达到上限的 pending Job 等待额度释放，保留跨项目公平领取、事务锁、租约、幂等及唯一执行归属。多个任务可在既有额度内执行，不再等另一个任务整体完成或人工回复；不保证完整任务 FIFO 顺序。

普通任务创建、定时启动、任务自身暂停/取消、归档、重试、报告再生成和人工续做保留。删除队列不提前触发定时任务，不撤销任务或项目的暂停，不复活取消任务，不自动重跑历史 Job，不重放未知效果。历史 Canvas、Job/Attempt、Evidence、报告、审计、冻结快照及累计预算保持原有事实和权限。

人工请求、晚回复保存、检查点、可信退出/资源回收、唯一后继和原预算链继续使用[人工续做](HUMAN_CONTINUATION.md)准入。人工等待无需占位或显式让位；回复保存不等于执行，仍须核验任务暂停、取消、授权、原期限、效果和额度。

## 升级安全

schema 79 在受控重建中，仅对旧队列 paused=true 的非成功条目投影任务暂停，包含无活动 Job 的 active 条目及已封存待续做的 waiting_human；仅 claimed/provisioning/running 的 Canvas 排除投影。已有 execution_control.paused=true 的控制内容原样保留，其余命中任务设置 execution_control.paused=true。已确认失败且旧队列已恢复者不再暂停，原本可执行的待办交普通调度。删除功能不构成启动同意，暂停任务以后沿既有任务继续执行入口恢复。

数据库沿用唯一 schema 基线、备份和受控重建，旧库或结构漂移启动仍 fail closed。具体版本以 [schema-version.ts](../apps/scheduler/src/schema-version.ts) 与 [schema.sql](../database/schema.sql) 为准。无法识别旧队列结构时在破坏性操作前明确拒绝，不猜测暂停意图。停止意图只在 [schema-rebuild.ts](../apps/scheduler/src/schema-rebuild.ts) 删除旧结构前保全到候选库，不延续旧队列语义，新运行时不读取旧表。

运行中任务保留执行身份，不因去队列化创建新 Job/Attempt 或重复领取。任务本体、历史结果、冻结快照、Evidence、报告、审计及人工请求/回复不作为队列专属数据删除。备份、plan 无写入、失败回滚及其它重建前置条件保持，详见[数据库说明](../database/README.md#删除项目任务队列的重建安全1180)。

## 决策与验收边界

当前需求为 [FR-TASK-008](architecture/01-system-specification.md#fr-task-008-删除项目任务队列并统一普通调度)，决策见 [ADR 0026](architecture/adr/0026-remove-project-task-queue.md)。[ADR 0019](architecture/adr/0019-project-task-queue.md) 保留原决策并标记被取代，ADR 0022 仅 FIFO 占位/让位部分被取代，其余人工续做边界保留。旧实施计划只作历史。[PR 1204](https://github.com/SummerSec/DeepSonar/pull/1204) 防止丢失旧停止意图的保护目标由 [PR 1208](https://github.com/SummerSec/DeepSonar/pull/1208) 的暂停投影与未知结构提前拒绝共同承接，不采用一律禁止删除旧结构的方案。本文件沿用原专题位置说明删除和验收，不构成旧功能支持。

最终提交须在现有 Actions 中验证：

- UI、创建/列表/API 无队列入口或专属字段，旧控制路由和存储不再属于当前契约；旧输入不得获得兼容成功响应。
- 同项目多任务按普通并发领取，上限外等待、释放后继续；多 Scheduler 不超发、不重复启动。
- 普通创建、定时、任务暂停/取消、重试、报告和人工续做无回退；前一任务人工等待不额外阻塞其它任务。
- 旧基线夹具覆盖 manual/failure/cancelled/running/ordinary/acknowledged/task_pause，以及已封存 waiting_human 的暂停投影；验证仍暂停/可执行分类、已有任务暂停原文、Job 冻结数据、events 与 audit 一致，以及运行中不重复领取。
- 删除全部专属结构，重建失败回滚、plan 不写入；文档保鲜、需求追溯、API/路由归属和测试接线一致。

入口沿用 pnpm ci:unit:docs-freshness、pnpm ci:unit:file-size、pnpm ci:unit:bounded-contexts、pnpm ci:unit:migrations、pnpm ci:unit:dispatch-limits、pnpm ci:integration:dispatch-limits、pnpm ci:unit:web-facts、pnpm ci:integration:recovery、pnpm ci:integration:platform-api 和 pnpm ci:integration:finding-report。套件接线与新增场景通过是两回事，实际结果只认最终 SHA Actions。所有测试、构建、typecheck 仅 Actions 执行；本地只核对源码和静态差异，未执行数据库重建或生产操作。最终 SHA Actions 待验。
