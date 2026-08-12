# Agent Runtime Context 契约

本文档说明 #138 的上下文生命周期边界。它记录可审计的身份和变换摘要，不把模型上下文变成调度器的第二份 prompt 存储。

## 状态

每个真实 Agent Attempt 在启动前生成稳定的 `context_id`。状态包含：

- `context_revision`：变换链的单调版本；初始输入为 0。
- `adapter_id`、`adapter_version`、`runtime_identity`：冻结运行时身份。
- `transform_chain_digest`：变换 manifest 的链摘要。
- `transforms`：阶段、版本、输入/输出 digest、预算、来源和省略原因。
- `compaction`：压缩观测为 `observed`、`unknown` 或 `unsupported`。

状态关联当前 `attempt_id`，同时写入活动 `job_attempts.state_json.runtime_context` 和 Job 的 `payload_json.runtime_evidence.context`。两处写入在同一事务内完成，Job 详情 API 最多投影最近 16 个变换。原始 prompt、上下文正文、Provider 原始事件和密钥不进入该状态。

## 变换与压缩

Scheduler 记录初始输入、GraphScope、预算省略和摘要交接；每个阶段必须以前一阶段的输出 digest 为输入。`context.compacted` 事件必须携带完整 context/adapter/runtime 身份、当前链 digest、连续 revision、边界、输入 digest 和输出 digest。

同一 `event_id` 携带相同内容时重复处理无副作用。事件缺失身份或摘要、复用 ID 携带不同内容、revision 跳跃、输入链不一致或身份不一致都会拒绝。Provider 只提供不可验证的压缩提示时记录 `unknown`；适配器明确不支持时记录 `unsupported`，两者都不增加 revision。

## 恢复

首次运行时捕获稳定 `sessionId` 后建立实际会话身份绑定；恢复前必须匹配 `context_id`、revision、adapter/runtime 身份和变换链摘要。适配器需要额外查询时可提供身份查询回调，但实际身份缺失或匹配失败都拒绝恢复。禁止选择 latest、创建新会话或以静态快照代替实际身份。Pi 的恢复还必须使用并匹配 `get_state` 返回的精确 `sessionFile`。

## 可见性

Job 详情只展示身份、revision、digest、预算、省略计数、压缩观测和有限阶段列表。UI 不展示上下文正文；`unknown`/`unsupported` 是诊断状态，不应被解释为已发生或已完成压缩。
