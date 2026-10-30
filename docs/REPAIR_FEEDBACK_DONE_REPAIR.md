# mark_job_done 持久修正回执（#776 B）

> 状态：实现中；以独立 PR 的测试和评审结果为验收依据。真实模型理解质量未评测。
> 同步日期：2026-10-29

B 切片只处理 `mark_job_done`，复用 Control HTTP、语义 `events`、Job/Attempt 与既有效果边界。没有第二执行通道，没有新表或 schema bump，不自动重跑 Job。A 的冻结矩阵见 #776 对应 A PR；C0/C1 的有限扩展及尚未交付的完整 C 边界见下文。

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

Job 状态、租约、时间预算、Attempt 取消与快照重新校验；未知外部效果须先对账，不得通过修正清空账本。合法完成的接受回执预留一次 terminal 额度；最终 done 在 Job 锁内核对宿主接受回执、Attempt、派生事件身份及规范化 payload 摘要后复用该名额，不重复计费；拒绝回执消耗 standard 额度，普通事件耗尽不能阻断合法完成。确定回滚的限流返回 429/退避，不能冒充未知提交。已有总 token 与事件预算仍适用，**独立 repair-token 成本核算与跨 operation 的 accepted_effects 汇总未交付**，不能宣称满足 #776 的全部预算验收。接收回执不能授予新权限或修改镜像准入。

本切片通过同一运行会话内的 Control HTTP 响应交付反馈，未引入新的 stdin、Shell 控制文件或通用重试引擎。跨进程查询持久回执不等于恢复原模型会话；DSH 不支持持久 resume 时仍明确停止。保留 #766 可信父子谱系和父等待子任务语义；不修改 #768 framing、控制事件保留或 evidence 保存失败的结论。

## 人工请求与完成提交的并发边界（B2）

`request_human` 的异步预检结束后，执行器再次核对完成预留和已接受的 human/done/Hub 状态，再保存人工请求。这样，预检等待期间完成提案已经 commit 并释放预留时，迟到人工请求仍被拒绝；两个人工请求并发预检时，后接受者也不能覆盖先接受者。匹配事件身份的 abort 才能释放完成预留，未知结果仍保留预留。

`executor-real-terminal-race.test.ts` 调用真实 `executeReal`、其注册的 Control handler、完成门及终态事件选择，以有界 barrier 固定交错。数据库预检/写入、运行器传输和 Evidence 是离线替身；这不等于真实 HTTP/数据库并发、实际 CLI 或模型验收。持久回执事务仍由 B1 的 PostgreSQL 集成测试覆盖。测试接入 `pnpm ci:unit:executor-real`，在独立 Node module-mock 进程运行。

## 受 scope 约束的引用刷新指引（C0）

只有 `submit_hub_decision` 的 `model_correctable/invalid_node_ref` 拒绝会附加指引。宿主以已鉴权 principal 的 Job 身份生成 `current_state_ref`，且必须同时有绑定 Canvas 与当前 token 的 `graph_query` 权限；不采纳 handler 提供的 URL、动作或效果账本。缺少前提时不提供链接，明确停止猜测并走既有人工/失败路径，不自动授权。

链接指向现有 operation：GET 只描述 Schema，POST `{"kind":"overview"}` 才读取当前 Job 的有界图投影，后续可按需查询并使用 `referable_ids` 修正后以新 key 重提。查询自身仍检查 token、Job scope、allowlist 和预算；旧指引不能绕过后续收紧的权限。图查询没有统一 revision/version lease，读取后并发变化仍可能使重提失败；已见引用、当前画布归属和最终业务/证据门继续重新校验。C0 不新增 Hub 持久 revision/修正计数，不编造 `accepted_effects`，也不承诺完整完成门或模型恢复率。

`reference-refresh.integration.test.ts` 使用真实 Fastify 注入、短期 token、隔离 PostgreSQL、`executeGraphQuery`、实际 Hub 已见引用解析与数据库预检。夹具 handler 只返回预检结果，不运行真实 executor/CLI，也不结算 Hub 副作用。测试证明跨 Job/项目和伪造 canvas 输入被拒绝、恶意 details 不成为指引、无权限/Canvas 不获得链接，以及已查询后删除的引用仍被拒绝；合法引用仍不能绕过缺少证据的完成门。


## Hub complete 的有界缺失项反馈（C1）

`submit_hub_decision.complete` 仍使用既有 `evaluateAnalysisCompleteGate`。预检或最终写入被该门拒绝时，错误保持 `invalid_payload`、路径 `complete`，`repair.expected.kind` 为 `analysis_complete_gate`。投影只依据门结果的已知 blocker 格式生成 `observed_counts`：`active_work`、`no_role_work`、`finding_not_converged`、`missing_verification_round`、`missing_human_blocker`、`open_round`、`other`。未知格式只计入 `other`，不回显原文；不输出 Finding/轮次 ID、标题、issue 文本或证据正文。

每类计数上限为 `count_cap: 1000`，超过时 `count_capped: true`。`counts_scope: gate_observations_not_inventory` 明确这些是门返回的观察计数，不是完整工作清单；例如既有未关闭轮次查询有 `LIMIT 5`，未在此修改。`expected.action` 要求按当前授权补充工作、验证证据或人工处理，禁止改写结论凑门，缺失项解决后新 key 重提。固定字段与标量使反馈大小有界，不放宽通用 handler details 白名单。

预检通过并不锁定状态；最终 ingestion 仍运行相同完成门，期间新增的活跃工作等会使提交失败并回滚。C1 同时替换最终拒绝中原来拼接的自由标题/issue 文本，属于反馈脱敏，不改变收敛条件、Verify 技术确认、权限或未知效果规则。该反馈不编造 `accepted_effects`，不新增 Hub 持久 revision/修正预算或状态，不代表完整 C 已交付。

`completion-feedback.integration.test.ts` 使用真实 Fastify 注入、Job token、隔离 PostgreSQL、原预检与最终 `ingestEvent`。门证据由数据库夹具构造，不代表真实模型产物或独立技术验证质量。测试覆盖各缺失类别、超过 1000 项的截断、原 open-round 查询的观测上限、跨项目/Job/引用拒绝，以及预检后状态变化导致最终回滚。满足原门后真实事件可落地、相同事件重放不重复，root 进入 `analysis_complete` 而 Hub Job 保持 `running`；不将此称为 Job 终态结算。单元测试验证固定大小、确定顺序无关投影及未知 blocker 脱敏，分别接入现有 `ci:unit:capability-pack` 和 `ci:integration:platform-api`。

## 验收边界

行为验证必须包含首次拒绝后接受、旧 key 重放、冲突/旧 revision、响应丢失、重启、预算耗尽、取消/租约失效、未知效果、scope 和数据库写失败。实际通过项以 PR 记录为准，本文件不把规划当作通过证据。

运行器合成测试仅证明协议行为；真实模型是否理解反馈、恢复率、修正轮数、额外 token/时间成本及人工介入率必须独立评测。本切片不调用真实模型或生产服务。C0/C1 仅覆盖引用指引与既有 Hub complete 门的缺失项投影；完整产物/证据门、Hub 持久修正链和各 CLI 的完整行为验收仍需后续交付。

代码：[回执事务](../apps/scheduler/src/domains/event-ingestion/completion-receipt.ts)、[Control 组装](../apps/scheduler/src/domains/platform-api/completion.ts)、[路由](../apps/scheduler/src/domains/platform-api/routes.ts)、[平台控制 Skill](../apps/scheduler/src/platform-control-skill.ts)。

三CLI的活动会话内离线协议验证见 [CLI 矩阵](REPAIR_FEEDBACK_CLI_MATRIX.md)；真实模型及跨进程完成恢复仍未验收。
