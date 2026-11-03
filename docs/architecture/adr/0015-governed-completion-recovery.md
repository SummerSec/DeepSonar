# 0015. 完成未知效果以宿主事实、受治理对账和有界停止恢复

> 状态：**已采纳**（本轮实现取舍；最终 SHA 的工程验收另记）
> 决策日期：2026-11-03
> 同步日期：2026-11-03
> 来源：[#874](https://github.com/SummerSec/DeepSonar/issues/874) / [#871](https://github.com/SummerSec/DeepSonar/issues/871)
> 关联需求：FR-CTRL-010 / FR-JOB-005 / FR-JOB-006 / NFR-REL-007 / NFR-REL-008

## 背景

完成提案可能因 pending/unknown effect 或未知修正用量被拒绝。原 [持久完成回执](../../REPAIR_FEEDBACK_DONE_REPAIR.md)能保存负结果，但回执本身不授权对账、重放或启动新会话。只重复原错误会停滞；把未知当成瞬态并重跑会重复外部效果。Canvas/Job 并行写入和跨 Attempt 共享卷清理也要求恢复路径遵守统一所有权。

## 决策

- 原负回执不可改写。Scheduler 在同一 Job 锁事务中追加宿主恢复事实，复用 `events` / `event_dedup`；不增加 schema、Job 状态、执行队列或模型旁路。只写 Job 的事务不得顺带更新触发 Canvas 锁的投影。
- 恢复身份绑定原 project、Canvas、Job、Attempt 与冻结快照，独立于客户端 key。恢复 Hub 的授权只来自 Scheduler 冻结的 `trigger.recovery_refs`，节点 metadata、普通模型文本或模型自报证据都不能授予权限。
- `submit_hub_decision.recovery` 是严格独立分支，只允许 `reconcile_effects` 或 `stop`，使用 revision 与证据摘要 CAS；与 complete、intents、payload_file、plan_basis 互斥。shared schema、宿主 handler、event transaction 三层均重新校验 scope、token/lease、allowlist/grant 和预算。
- 对账只读取精确 effect 的既有宿主账本/闭合证据并执行纯数据库 settlement。原响应正文、自报零用量、`interrupted`、缺少或存在 `sandbox_id` 均不能证明效果未开始或资源已停止。终态 helper 不得仅因没有 sandbox 投影而制造 `never_started`；真实未开始须有明确宿主证据并显式结算。
- Reaper 复用原 timer 与 in-flight guard，以有界 keyset 扫描推进恢复。wake 身份与 Hub 插入同事务；失败 Hub 消耗同一额度，deadline 和 lifetime/token/repair 预算不得被新 key、新证据或重启延长。限额细节只在[恢复实现](../../../apps/scheduler/src/domains/job-attempt/recovery.ts)维护。
- 尚未启动的 directed Hub 若因证据/版本变化或原 deadline 而确定失效，只能在同一 Canvas 事务中核对真实 root/wake 与 dedup 绑定、锁定 Hub 并证明完全无 Attempt/effect/启动痕迹后收口；新证据必须重新消耗剩余额度并经过原准入，不修改旧 grant。已领取/运行/人工等待或其他 Hub 继续拥有其既有决策门。
- 未知效果归零只解除该阻塞，不批准完成。仅仍活动的原 Attempt 可用新 revision/key 重新提交，继续通过既有 Completion、Verify、Plan、人工和权限门；恢复不复活 failed/cancelled/timeout/orphan，不自动 succeeded，不覆盖用户 pause、真实 human/Verify wait 或未解决的活动 Hub。
- `stop` 在同一 Canvas → Job → Attempt 事务复用生命周期、Attempt/effect 和模型/Control token 收口，失败保持请求供后续 tick。外部 runner/volume cleanup 在事务外进行；共享资源按 Job 生命周期边界、当前/latest Attempt 和观察到的 generation 再核对，non-force 卷删除失败保持可观察。

本条收窄 FR-JOB-006 中历史上依赖“无 sandbox / 无迟到句柄”推断未开始的口径，不取代 [ADR-0003](0003-api-only-control.md)或 [ADR-0005](0005-event-evidence-stream.md)的 Control/事件所有权。

## 状态

v1 在本轮修复分支实现，测试与接线见 [完成回执专题](../../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)。最终 SHA 的 GitHub Actions 尚待验收，未执行的测试不能称为通过。

## 替代方案

以下为本次分析，不假冒历史讨论：

- 自动重跑原操作或重建 Attempt：不能证明没有外部效果，且会扩大原权限/预算，拒绝。
- 只以内存 Map 和定时器唤醒：重启丢失身份与额度，拒绝。
- 用 Canvas 节点作为恢复权威：节点是可重建投影，不能替代宿主事件与精确 effect 账本，拒绝。
- 每次错误直接要求人工：安全但丢失已有宿主证据可自动对账的范围；保留人工门而增加这个有界 v1，不承诺任意恢复。

## 后果与边界

增加的是去重的宿主状态与受治理选择，不是通用自主重试引擎。没有精确证据的效果仍 unknown；已退出会话/新 Attempt 的完整继续执行与真实模型恢复率仍未交付。活动原 Attempt 的修正与显式停止必须保持原门、审计、预算和资源 fencing。生产部署不在本轮验收范围内；质量、成本和 SLA 未测。

## 验证

对应需求与入口见 [追溯矩阵](../traceability.md)、[运行时视图](../06-runtime-view.md)、[安全视图](../10-security-and-trust-boundaries.md)及[专题](../../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)。必须覆盖真实 PostgreSQL 并发/CAS/回滚、旧锁序 40P01 负对照、原回执不可变、跨项目/Attempt/快照拒绝、重启/重复唤醒、预算/deadline、pause/human、精确用量与无资源投影负例。仅 Actions 运行测试/build/typecheck；测试存在不代表真实模型效果或正式发布完成。
