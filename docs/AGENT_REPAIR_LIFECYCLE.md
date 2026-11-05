# Agent 错误反馈与执行恢复（#903）

> 状态：实现与回归接线；最终 SHA 的 GitHub Actions 结果以 PR 为准，未执行项不能算通过
> 同步日期：2026-11-05

这是 [完成回执](REPAIR_FEEDBACK_DONE_REPAIR.md)的生命周期扩展。设计取舍见 [ADR 0016](architecture/adr/0016-repair-execution-generations.md)。#911 已合入 Knowledge/Skill 分类透传；#919（#913）已合入仅在宿主接受完成后识别结构化 Gateway 拒绝的运行器处理。本次不重复这两片，也不把工程证据写成真实模型试验。

## 宿主生命周期

同 Job 的修复次数、revision、token 根与已知/未知用量累计保留。`resume` 保留原冻结快照且拒绝身份漂移；`rerun-current` 重新核对当前配置和目标授权。存在拒绝历史时，两者仅在旧效果全部结算、原期限未到、预算仍允许且未暂停/接受完成时追加新代际。锁顺序为 Canvas → Job → Attempt；与旧 effect intent 写入、Dispatcher 领取互斥。

代际事件保存 `supersedes_attempt_id`、`previous_chain_status=superseded` 和唯一下一 `target_attempt_no`。待领取时 owner 为空，不能用于模型调用；领取后 Gateway 和完成门共同解析相同 owner。原负回执/费用不修改，模型调用继续归因到原 repair receipt；新完成提案使用累计下一 revision。原 key 查询和传输重放保持原结果，不把历史 next_action 当成当前许可。手动入口的成功只表示已入队；完成必须等新 Attempt 通过完成门和终态结算。

已启动 stale Recovery Hub 用原 grant 提交 `release_stale` 后正常结束；读取新投影不扩大旧 grant。退出动作不对账、不改变目标状态。原 Hub 存在未知效果时，后继 Hub 仍不能获得执行权；新 wake 继续消耗原根额度和期限。

## 审计矩阵

下表“实现”指当前分支源码及接线；不是未运行测试的通过结论。

| operation / 原因 × 当前状态 | 接受/未知效果与反馈 | 合法下一步 / 终止条件 | 实现与工程入口 |
| --- | --- | --- | --- |
| Control schema、字节、引用错误，活动合法会话 | model_correctable；不回显原文 | 按字段/约束修正；期限/lease/权限获胜 | shared RepairFeedback、platform-api routes；`pnpm ci:unit:capability-pack` / `pnpm ci:integration:platform-api` |
| key/revision/event-id 缺失或冲突 | 统一 repair 与 current_state_ref；冲突不能猜测原请求失败 | 缺头补头；冲突先读原回执，当前状态允许才作新提案 | completion HTTP integration；同上 |
| request_human、done、hub_decision 已接受后冲突 | accepted_terminal / accepted_effects；permanent_failure | 原提案结算或人工等待；不建议相冲突终态 | executor terminal-race、completion integration；`pnpm ci:unit:executor-real` |
| 同 key 三次重放、进程重启 | 原不可变 receipt/result，不增加 repair count | 读取当前 execution_state；新语义使用累计下一 revision | completion integration / crash；`pnpm ci:integration:platform-api` |
| failed / waiting_human 后手动 resume/rerun | Scheduler 新代际，与 Gateway/完成门共同归属 | 安全前提满足才入队；新提案仍需最终结算 | repair-generation integration；`pnpm ci:integration:recovery` |
| 新代际前旧 pending/unknown、用量缺失、预算/期限耗尽 | 状态变更前 blocker；无新 owner、无预算刷新 | 先治理对账；未知永不换 key 或新 Attempt 重放 | repair admission + Gateway budget；recovery/platform-api 集成 |
| 重复恢复、旧 callback/token、Reaper/取消/lease 竞争 | Job/Attempt fencing，旧 grant 撤销，旧回执可查 | 当前 owner 才可提交效果；不复活终态 | generation / job-attempt / event-ingestion / lifecycle 回归；`pnpm ci:integration:job-lifecycle` |
| 已启动 Recovery Hub 的 grant stale | recovery_stale；原 grant 可 release_stale | 干净退出后由 Scheduler 新授权；未知 Hub 效果阻断 | recovery HTTP/PG integration；`pnpm ci:integration:completion-recovery` |
| emit_* / Plan / request_human 内部 handler 抛错 | 通用 500/HANDLER_FAILED = unknown；原领域持久 receipt 优先 | 先查回执/当前状态和对账；不得自动重放；handler 未注册才 transient | platform-api HTTP、repair-feedback 单测；capability-pack/platform-api 集成 |
| 能力发现、Knowledge/Skill 生命周期或权限拒绝 | #911 保留 category/next_action；非 model_correctable | 当前授权/状态失败停止；内容修正不恢复权限 | project-knowledge runtime-feedback；`pnpm ci:integration:project-knowledge` |
| Claude Code / Pi / DSH | 实际 adapter + 合成协议、真实 Control/PG；接受完成处理由 #913 补齐 | 原活动执行内反馈；DSH 不承诺 persistent session resume | [CLI 矩阵](REPAIR_FEEDBACK_CLI_MATRIX.md)、executor terminal-race、runtime recovery suites |
| Web 错误建议 / 已结束会话 | 宿主 execution_state；无宿主投影时保守提示检查恢复 | request_recovery 是请求准入，不是自动继续/成功承诺 | task-actions/repair-feedback；`pnpm ci:unit:web-facts` |

现有回归覆盖多个入口的组合，不声称穷举所有 operation × 状态的笛卡尔积。生命周期、权限和未知效果门没有被错误分类放宽。内部故障实际发生在哪一层及是否已提交，必须以对应持久回执/effect 证据判定，不能仅凭 HTTP 500 推断没有效果。

## 验证边界与注意力成本

本地只进行静态阅读与 `git diff --check`；测试、构建、typecheck 在 GitHub Actions。新增恢复测试使用隔离随机 PostgreSQL、假凭据、loopback 假上游和受控 runtime handler；真实 HTTP handler、预算、回执和最终 ingestion 属于工程覆盖，不是生产运行或真实模型理解。当前源码存在不等于最终 SHA 全绿。

界面复用已有 Job 诊断和恢复入口，不增加通知/配置；当前状态明确区分等待人、平台对账和可请求恢复。没有宿主许可时不显示“安全重试”，减少用户误判和重复点击；响应仍需服务端实时准入。
