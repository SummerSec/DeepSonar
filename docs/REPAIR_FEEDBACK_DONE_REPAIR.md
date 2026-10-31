# mark_job_done 持久修正回执（#776 B）

> 状态：实现中；以独立 PR 的测试和评审结果为验收依据。真实模型理解质量未评测。
> 同步日期：2026-10-31

B 切片只处理 `mark_job_done`，复用 Control HTTP、语义 `events`、Job/Attempt 与既有效果边界。没有第二执行通道，没有新表或 schema bump，不自动重跑 Job。A 的冻结矩阵见 #776 对应 A PR；C0/C1 的限定扩展见下文，原 issue 收口范围见 [验收矩阵](REPAIR_FEEDBACK_ACCEPTANCE.md)。

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

Job 状态、租约、时间预算、Attempt 取消与快照重新校验；未知外部效果须先对账，不得通过修正清空账本。合法完成的接受回执预留一次 terminal 额度；最终 done 在 Job 锁内核对宿主接受回执、Attempt、派生事件身份及规范化 payload 摘要后复用该名额，不重复计费；拒绝回执消耗 standard 额度，普通事件耗尽不能阻断合法完成。确定回滚的限流返回 429/退避，不能冒充未知提交。事件与请求数预算继续生效。独立 repair-token 的累计熔断见下节；跨 operation 的 accepted_effects 汇总未交付。接收回执不能授予新权限或修改镜像准入。

本切片通过同一运行会话内的 Control HTTP 响应交付反馈，未引入新的 stdin、Shell 控制文件或通用重试引擎。跨进程查询持久回执不等于恢复原模型会话；DSH 不支持持久 resume 时仍明确停止。保留 #766 可信父子谱系和父等待子任务语义；不修改 #768 framing、控制事件保留或 evidence 保存失败的结论。

## 独立修正 token 用量与额度

`DEEPSONAR_REPAIR_MAX_TOKENS` 未设置、空白或显式 0 时不限；显式 1–2000000 的整数才限制，非法显式配置拒绝启动。新修正链将无限冻结为数值 0；历史回执的 null/缺失仍禁止新增修正模型请求，不追溯改写。首个持久拒绝回执冻结 `repair_token_limit`，之后配置改变、换 Gateway token 或进程重启不重置它；另一 Attempt 不得继续原修正链，Gateway 在出站前以 REPAIR_ATTEMPT_CHANGED 停止。正常首次模型请求与不调用模型的本地修正不增加修正成本。

归属规则是**首个拒绝提交之后，在 Job 锁内准入的 Gateway 请求**。触发拒绝的先前请求不追溯收费。宿主把 `repair_receipt_ref` 和当前剩余额度预留写入原 `gateway_model_request` effect 的 intent；聚合对应 `job_usage_ledger`，不新建收费表、不重复扣账。原管理 Job 详情中的 effect intent 与 usage ledger 可按 Attempt/effect 关联。此处成本单位是 token，不推导金额、费率或真实模型恢复率。

Gateway 与拒绝/接受回执使用同一 Job 锁。一次修正请求占用剩余额度，未结算时不准入第二次请求；结算事务失败留下 pending，unknown、缺 usage、not_reported 不视为零。反馈投影提供 `usage_status`、`known_tokens` 与可空 `remaining_tokens`；未知或无限时不广告 `remaining_budget.tokens=0`；无限的 `limit_tokens=0`、`remaining_tokens=null`，用量仍照常记账。严格已知零用量仍可继续。额度耗尽、取消、租约/时间失效、完成已接受都会阻止继续调用；新完成提案也拒绝未结算/未知/耗尽的修正链，旧 key 仍读取原回执。

只接受 OpenAI Chat/Completions、Responses、Anthropic Messages 协议根位置的完整 usage（JSON/SSE），不扫描 assistant/tool 正文或模型自报。缓存按协议处理：Anthropic 缓存另加，OpenAI 缓存已在 input 中。帧/JSON 超过 1MiB、总流超过 16MiB、截断、缺终态、非法计数、未知协议或错误结果均保留未知。原宽松解析 helper 不再用于 Gateway 持久用量；正常请求若有内部重试，也不能把此前尝试的未知成本归零。

现有 Provider 配置入口 `INFERENCE_WIRE_PROTOCOLS` 的三种协议（anthropic-messages / openai-completions / openai-responses）均有严格解析夹具。自定义兼容服务若缺少协议根计数、结束事件或返回不支持的 envelope，响应仍可传回，但用量为未知，不能广告已结算。没有单独的 Provider“失败请求确定未收费”契约；普通请求 503→200 时即使前一个错误正文自报零，也保留最后 200 业务响应和观测用量，把整个 effect 的成本标 unknown，首次完成被既有效果门拒绝，Job 不因此直接改成 failed。单次完整成功响应的权威零计数可结算并正常完成；准入前拒绝则没有发起新请求，不制造收费记录。这些区别由真实 loopback 回归验证。

修正 Gateway 请求以及显式设置 Job 总 token 额度的普通请求最多一次上游尝试，禁止隐藏的潜在收费重试；普通无限额度请求保留既有有界重试。显式有限额度的输出上限由宿主限制到剩余 token；无限时保留调用者的输出参数，Chat SSE 请求开启 usage 返回，n/best_of 多候选与批量 prompt 在出站前拒绝。已有 `job_tokens.max_tokens` 若明确设置，则普通与修正准入均核对整个 Job 的原 usage ledger，未知总用量停止，较小总额度优先；Job 请求数、事件与时间上限仍有效。当前 executor 不自动设置 Job `max_tokens`；默认不限，显式正数才熔断，新 token 的 0 归一为 NULL，历史零额度不重写。

**边界：这是累计结算后的熔断，不是精确的调用前总成本保证。** 输入/缓存 token 只有上游响应后才能确认，单次已准入请求仍可能超出剩余额度；保留实际超额计数并阻止后续请求/修正完成，不截断账本或伪装成功。若产品要求绝对不超额，需要额外受信的调用前输入计数/计价契约；当前不以字符数或模型自报代替。该精度限制与默认不限的策略分开记录。

离线 `gateway-repair-budget.integration.test.ts` 调用真实 Gateway/Control HTTP、隔离 PostgreSQL 与 loopback 合成上游，覆盖累计、旧 key 重放、换 token/新 Gateway 子进程、并发预留、配置冻结、已知零/未知、耗尽/超额、总额度、取消/租约/超时、结算写失败及单次上游尝试。`gateway-repair-usage.test.ts` 覆盖协议、缓存、伪造正文、重复累计快照与截断。测试分别接入现有 `ci:integration:platform-api` 和 `ci:unit:executor-real`；不调用真实模型或生产系统。

## 人工请求与完成提交的并发边界（B2）

`request_human` 的异步预检结束后，执行器再次核对完成预留和已接受的 human/done/Hub 状态，再保存人工请求。这样，预检等待期间完成提案已经 commit 并释放预留时，迟到人工请求仍被拒绝；两个人工请求并发预检时，后接受者也不能覆盖先接受者。匹配事件身份的 abort 才能释放完成预留，未知结果仍保留预留。

`submit_hub_decision` 也在异步预检后重新检查人工请求和已接受的 Hub 槽位，拒绝迟到的冲突或覆盖；Hub 与 done 仍允许共存，最终事件保持 Hub 在 done 之前。该复查由 Hub 等待期间 human 先接受、双 Hub 交错，以及等待期间完成提交的离线测试覆盖。

`executor-real-terminal-race.test.ts` 调用真实 `executeReal`、其注册的 Control handler、完成门及终态事件选择，以有界 barrier 固定交错。数据库预检/写入、运行器传输和 Evidence 是离线替身；这不等于真实 HTTP/数据库并发、实际 CLI 或模型验收。持久回执事务仍由 B1 的 PostgreSQL 集成测试覆盖。测试接入 `pnpm ci:unit:executor-real`，在独立 Node module-mock 进程运行。

## 受 scope 约束的引用刷新指引（C0）

只有 `submit_hub_decision` 的 `model_correctable/invalid_node_ref` 拒绝会附加指引。宿主以已鉴权 principal 的 Job 身份生成 `current_state_ref`，且必须同时有绑定 Canvas 与当前 token 的 `graph_query` 权限；不采纳 handler 提供的 URL、动作或效果账本。缺少前提时不提供链接，明确停止猜测并走既有人工/失败路径，不自动授权。

链接指向现有 operation：GET 只描述 Schema，POST `{"kind":"overview"}` 才读取当前 Job 的有界图投影，后续可按需查询并使用 `referable_ids` 修正后以新 key 重提。查询自身仍检查 token、Job scope、allowlist 和预算；旧指引不能绕过后续收紧的权限。图查询没有统一 revision/version lease，读取后并发变化仍可能使重提失败；已见引用、当前画布归属和最终业务/证据门继续重新校验。C0 不新增 Hub 持久 revision/修正计数，不编造 `accepted_effects`，也不承诺完整完成门或模型恢复率。

`reference-refresh.integration.test.ts` 使用真实 Fastify 注入、短期 token、隔离 PostgreSQL、`executeGraphQuery`、实际 Hub 已见引用解析与数据库预检。夹具 handler 只返回预检结果，不运行真实 executor/CLI，也不结算 Hub 副作用。测试证明跨 Job/项目和伪造 canvas 输入被拒绝、恶意 details 不成为指引、无权限/Canvas 不获得链接，以及已查询后删除的引用仍被拒绝；合法引用仍不能绕过缺少证据的完成门。


## Hub complete 的有界缺失项反馈（C1）

`submit_hub_decision.complete` 仍使用既有 `evaluateAnalysisCompleteGate`。预检或最终写入被该门拒绝时，错误保持 `invalid_payload`、路径 `complete`，`repair.expected.kind` 为 `analysis_complete_gate`。投影只依据门结果的已知 blocker 格式生成 `observed_counts`：`active_work`、`no_role_work`、`finding_not_converged`、`missing_verification_round`、`missing_human_blocker`、`open_round`、`other`。未知格式只计入 `other`，不回显原文；不输出 Finding/轮次 ID、标题、issue 文本或证据正文。

每类计数上限为 `count_cap: 1000`，超过时 `count_capped: true`。`counts_scope: gate_observations_not_inventory` 明确这些是门返回的观察计数，不是完整工作清单；例如既有未关闭轮次查询有 `LIMIT 5`，未在此修改。`expected.action` 要求按当前授权补充工作、验证证据或人工处理，禁止改写结论凑门，缺失项解决后新 key 重提。固定字段与标量使反馈大小有界，不放宽通用 handler details 白名单。

预检通过并不锁定状态；最终 ingestion 仍运行相同完成门，期间新增的活跃工作等会使提交失败并回滚。C1 同时替换最终拒绝中原来拼接的自由标题/issue 文本，属于反馈脱敏，不改变收敛条件、Verify 技术确认、权限或未知效果规则。该反馈不编造 `accepted_effects`，不新增 Hub 持久 revision/修正预算或状态，不扩展为通用完成门；本 issue 限定 C 的验收范围见验收矩阵。

`completion-feedback.integration.test.ts` 使用真实 Fastify 注入、Job token、隔离 PostgreSQL、原预检与最终 `ingestEvent`。门证据由数据库夹具构造，不代表真实模型产物或独立技术验证质量。测试覆盖各缺失类别、超过 1000 项的截断、原 open-round 查询的观测上限、跨项目/Job/引用拒绝，以及预检后状态变化导致最终回滚。满足原门后真实事件可落地、相同事件重放不重复，root 进入 `analysis_complete` 而 Hub Job 保持 `running`；不将此称为 Job 终态结算。单元测试验证固定大小、确定顺序无关投影及未知 blocker 脱敏，分别接入现有 `ci:unit:capability-pack` 和 `ci:integration:platform-api`。

## 验收边界

行为验证必须包含首次拒绝后接受、旧 key 重放、冲突/旧 revision、响应丢失、重启、预算耗尽、取消/租约失效、未知效果、scope 和数据库写失败。实际通过项以 PR 记录为准，本文件不把规划当作通过证据。

运行器合成测试仅证明协议行为；真实模型是否理解反馈、恢复率及人工介入率未测；按当前交付要求，这些质量实验不是实现验收门。本切片不调用真实模型或生产服务。C0/C1 仅覆盖引用指引与既有 Hub complete 门的缺失项投影；通用产物/证据门、Hub 持久修正链和全错误交叉矩阵属于后续可选扩展，不作为本 issue 限定实现的无限验收范围。

代码：[回执事务](../apps/scheduler/src/domains/event-ingestion/completion-receipt.ts)、[Control 组装](../apps/scheduler/src/domains/platform-api/completion.ts)、[路由](../apps/scheduler/src/domains/platform-api/routes.ts)、[平台控制 Skill](../apps/scheduler/src/platform-control-skill.ts)。

三CLI的活动会话内离线协议验证见 [CLI 矩阵](REPAIR_FEEDBACK_CLI_MATRIX.md)；真实模型及跨进程完成恢复仍未验收。
