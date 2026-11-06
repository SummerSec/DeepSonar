# 0016. Scheduler 授权修复执行代际与 stale Hub 退出

> 状态：已采纳；实现提交的 Actions 结果单独登记
> 决策日期：2026-11-05
> 同步日期：2026-11-05
> 来源：#903；关联需求 FR-CTRL-006 / FR-CTRL-009 / FR-CTRL-010 / FR-JOB-006

## 决策

本决策扩展 [ADR 0015](0015-governed-completion-recovery.md) 中“不提供新 Attempt 继续执行”的 v1 边界及 action 集合，不改写其历史决策，也不建立第二套重试引擎。

- 手动 resume/rerun-current 以及任务级批量恢复在 Canvas → Job → Attempt 锁内核对当前授权、快照和修复准入。存在旧 rejected completion 时，任何未结算效果（包括旧 agent_run）、未知用量、已接受完成、暂停或耗尽预算都阻止新代际，且不先改变状态。中断旧 Attempt 不是执行退出证据。
- 安全准入后在同一事务追加 Scheduler-owned `control_receipt/subtype=repair_generation`，标记旧链 superseded，绑定唯一的下一 `attempt_no`、原修复根和原 deadline。Dispatcher 的既有领取创建该 Attempt；代际事件本身不是已执行或已恢复成功的回执。没有该事件的换 Attempt 仍拒绝。无需新表或 Job 状态。
- Gateway 与完成门共同使用同一代际 owner。最早负回执、所有旧 key/revision/result、原修复 token policy、累计用量和 Job 级修正次数保持不变；新代际不会取得一套新额度。合法新提案使用 Job 累计的下一 revision，最终仍经过原语义 ingestion 和终态结算。Dispatcher/Reaper 使用保留的原期限。
- 历史回执查询与当前 `execution_state` 分开；读回执不执行 handler、不消耗次数，也不授予当前执行许可。Web 只消费宿主投影，不从 failed 或错误字符串推断“同会话安全重试”。
- 启动后的 stale Recovery Hub 可使用自己原冻结 grant 提交 `release_stale`，经原 Control/语义事务接纳后正常完成。该动作不修改目标、对账或扩展 grant。原 Hub 干净退出后 Scheduler 才可按新证据与剩余 wake/期限授权替代 Hub；旧 Hub 的 unknown 效果仍阻断替代。
- 未知 handler 异常按 unknown_external_effect 处理；仅已证明 handler 尚未执行的 unavailable 可作瞬态重试。已接受 human/done 的互斥拒绝携带接受事实与停止/等待建议。

## 验证与限制

对应 [#903 审计矩阵](../../AGENT_REPAIR_LIFECYCLE.md)区分当前实现、回归入口和精确 SHA 的运行证据。HTTP/PG、假上游和模拟 CLI 不能证明模型理解或真实恢复率。本变更不恢复生产历史任务、不调用真实模型、不实现 #834。
