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
