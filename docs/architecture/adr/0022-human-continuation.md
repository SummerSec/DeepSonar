# 0022. 持久人工请求与有界结构化续做

> 状态：已采纳；最终 SHA Actions 结果单独登记
> 决策日期：2026-11-12
> 同步日期：2026-11-12
> 来源：#1074；需求 FR-JOB-008、FR-CTRL-006

## 决策

扩展 [ADR 0016](0016-repair-execution-generations.md) 的修复 owner 交接：人工响应阈值仅为 overdue，Job waiting_human 可没有活动 Attempt。原执行封存、可信销毁、效果结算与回复接纳为独立事实，Scheduler 继续拥有全部 authority。

专属请求与累计执行时钟进入 schema；同事务接受事件/请求/等待，有限保存与原 Dispatcher/Reaper 回收，失败明确 blocked。只有固定作用域、内容摘要可验证的文件断点可使用；控制文件和旧凭据不得恢复。30 天保留到期先撤销可恢复状态再删文件。

回复先持久化，随后经原恢复准入写唯一 human_continuation 代际和 pending，新 Attempt 在执行前重核。原 repair root 存在时继续使用 ADR 0016 的 owner 和硬 deadline，累计 token/request/repair 账本不重置。忽略不授权，取消不复活，未知效果不重放。

本次只实现显式 structured 新会话模式；原生 CLI Session 续接必须另有 adapter/镜像实证。保存的 Session 不是原生恢复证明。完整契约与剩余范围见[人工续做专题](../../HUMAN_CONTINUATION.md)。

## 取舍与验证

保留当前 FIFO 占位，避免晚回复跳过顺序；等待释放执行资源。宿主文件/进程检查失败时拒绝续做，不能以空工作区替代。历史 failed Job 不静默改变终态或取得新额度。新增元数据不是第二个执行器或自动换配置重试。

验证使用既有 Actions、隔离 PostgreSQL、HTTP、可控 RuntimeHost；工程状态机与真实模型/生产/容量结论分别报告。

## #1074 第 8 节的显式 FIFO 让位扩展（2026-11-19）

用户已决定默认保留人工等待占位，只在显式「暂存并让下一项先做」时释放。此扩展对 ADR 0019 的人工等待保留位置增加明确的操作员例外。schema 75 持久记录决定与请求版本，回复保存事务原子回队尾一次，保留完成代际。轮到且无其他 active 时，既有续做准入授予席位和唯一后继。多等待暂未支持，所有治理、授权、断点、效果和预算门保持。工程验收以最终 SHA Actions 为准，见[队列专题](../../PROJECT_TASK_QUEUE.md#人工等待显式让位1074)。

## 历史 failed 新 Job 与原预算链扩展（2026-11-19）

用户已授权在合法检查点与完整原始账本成立时，显式关联新 Job。schema 76 复用第一 Job 作为预算 owner，独立指向唯一当前执行 Job，job_continuations 绑定直接前驱、源 Attempt、请求版本、检查点摘要和新旧回复。执行权限、账本与回执保留实际 Job 身份，原额度、修正次数和硬期限持续累计。

历史回复先独立幂等保存，交接与决策审计同事务。管理操作采用 claim advisory→Canvas→全部预算根→成员 Job→Attempt→request 锁序，Gateway 准入/结算先根后成员。缺证据、未知效果和不受支持的专属分配稳定拒绝。Plan 新 Job 占原 max_tasks 剩余名额，只有精确来源归因且原目标/路线仍有效的失败停止允许受治理恢复。受限原生会话通过同一 continuation 绑定寻找原归档，执行身份属于新 Job。原生边界见 [ADR 0024](0024-restricted-human-session-import.md)。
