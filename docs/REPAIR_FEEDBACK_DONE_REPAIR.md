# mark_job_done 持久修正回执（#776 B）

> 状态：实现中；以独立 PR 的测试和评审结果为验收依据。真实模型理解质量未评测。
> 同步日期：2026-10-29

本切片只处理 `mark_job_done`，复用 Control HTTP、语义 `events`、Job/Attempt 与既有效果边界。没有第二执行通道，没有新表或 schema bump，不自动重跑 Job。A 的冻结矩阵见 #776 对应 A PR；引用与完整完成门扩展属于 C。

## 协议

POST 原 `operations/mark_job_done` 需要 UUID `Idempotency-Key` 与 `X-DeepSonar-Proposal-Revision`：首次 revision 为 0，修正使用反馈要求的下一 revision 和新 key。同一提交的传输重试保留 key、revision 和 payload；缺少 revision 明确拒绝，不静默补 0。显式事件 ID 必须等于 key。

回执记录保存 input digest、原 key、revision、Attempt 和快照身份、原 HTTP 结果；无效正文不落库。原 key 始终是 HTTP 幂等身份；宿主 `control_receipt` 与最终 `done` 分别使用绑定 Job/key 的不同确定性 event ID，避免不同 Job 复用同 key 时碰撞全局去重。Agent 不能通过事件提交接口伪造 receipt。完成与项目知识 mutation 在同一 Job 锁事务内双向检查持久 key 归属；不同 operation 不能因使用不同派生 event ID 而复用同 key。该检查不宣称其它所有 operation 已有通用持久幂等账本。

| 阶段 | 权威动作 | 对外含义 |
| --- | --- | --- |
| schema/业务拒绝 | Job 锁内保存有界拒绝反馈与计数 | 未接受该完成提案，按反馈修正 |
| prepare | 原运行时纯校验，尚不设置内存 done | 不执行外部效果 |
| persisted_deferred | 数据库提交接受回执 | 已持久接收提案；不是 Job succeeded 或效果已结算 |
| 本地接收 | 原活动 Attempt 的执行器恢复完成提案 | 不启动新 CLI/Attempt，不证明模型已读 |
| 后续结算 | 既有 terminal bundle / Scheduler 生命周期 | 仍受 Hub、人工处理、取消和效果边界约束 |

读取原结果：`GET /control/v1/jobs/:jobId/operations/mark_job_done?receipt_key=<原UUID>`。无 query 时仍描述 operation。查询要求原 Job 当前 capability 与 operation allowlist，不能跨项目/Job；Job 终态后 Control token 不再有效，由已授权管理面读取既有事件记录。响应丢失先查原 key；GET 只读不会恢复执行器的本地完成门。若原 Job 仍活动且查到 persisted_deferred，调用者必须保留原 key/revision/payload 再 POST，让原活动执行器幂等接收，不能新建提案或重放外部效果。原会话/handler 不可用时保留回执并停止。回执缺失不能证明外部效果不存在。

## 恢复与停止

拒绝计数存于语义事件，进程内 Map 清空不重置。最多保存 8 次拒绝，首次拒绝也计入；耗尽后不能再提交新完成提案。重复旧 key 原结果不再消耗额度，同 key 改内容/revision、旧 revision、另一 Attempt 接续均拒绝。正常首次有效提交仍只需一次 HTTP。

Job 状态、租约、时间预算、Attempt 取消与快照重新校验；未知外部效果须先对账，不得通过修正清空账本。合法完成的接受回执消耗 terminal 保留额度（最终 done 按既有路径另计一次）；拒绝回执消耗 standard 额度，普通事件耗尽不能阻断合法完成。确定回滚的限流返回 429/退避，不能冒充未知提交。已有总 token 与事件预算仍适用，**独立 repair-token 成本核算与跨 operation 的 accepted_effects 汇总未交付**，不能宣称满足 #776 的全部预算验收。接收回执不能授予新权限或修改镜像准入。

本切片通过同一运行会话内的 Control HTTP 响应交付反馈，未引入新的 stdin、Shell 控制文件或通用重试引擎。跨进程查询持久回执不等于恢复原模型会话；DSH 不支持持久 resume 时仍明确停止。保留 #766 可信父子谱系和父等待子任务语义；不修改 #768 framing、控制事件保留或 evidence 保存失败的结论。

## 验收边界

行为验证必须包含首次拒绝后接受、旧 key 重放、冲突/旧 revision、响应丢失、重启、预算耗尽、取消/租约失效、未知效果、scope 和数据库写失败。实际通过项以 PR 记录为准，本文件不把规划当作通过证据。

运行器合成测试仅证明协议行为；真实模型是否理解反馈、恢复率、修正轮数、额外 token/时间成本及人工介入率必须独立评测。本切片不调用真实模型或生产服务。C 的引用刷新、完整产物/证据门和各 CLI 的完整行为覆盖仍需后续交付。

代码：[回执事务](../apps/scheduler/src/domains/event-ingestion/completion-receipt.ts)、[Control 组装](../apps/scheduler/src/domains/platform-api/completion.ts)、[路由](../apps/scheduler/src/domains/platform-api/routes.ts)、[平台控制 Skill](../apps/scheduler/src/platform-control-skill.ts)。
