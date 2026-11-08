# Agent 错误反馈与执行恢复（#903）

> 状态：as-built；#930/#928 的历史 main 616d7a36 工程证据见下文；本分支 #1012 人工等待修正链交接已接线，后续最终 SHA Actions 待验
> 同步日期：2026-11-08

这是 [完成回执](REPAIR_FEEDBACK_DONE_REPAIR.md)的生命周期扩展。设计取舍见 [ADR 0016](architecture/adr/0016-repair-execution-generations.md)。#911 已合入 Knowledge/Skill 分类透传；#919（#913）已合入仅在宿主接受完成后识别结构化 Gateway 拒绝的运行器处理。本次不重复这两片，也不把工程证据写成真实模型试验。

## 宿主生命周期

同 Job 的修复次数、revision、token 根与已知/未知用量累计保留。`resume` 保留原冻结快照且拒绝身份漂移；`rerun-current` 重新核对当前配置和目标授权。存在拒绝历史时，两者仅在旧效果全部结算、原期限未到、预算仍允许且未暂停/接受完成时追加新代际。锁顺序为 Canvas → Job → Attempt；与旧 effect intent 写入、Dispatcher 领取互斥。 pending 转换意外返回空结果时抛错回滚整个事务，再在事务外映射业务拒绝；批量恢复不得跳过失败成员并提交其他成员。隔离 SQL 触发器故障注入覆盖该回滚边界。

恢复事务在旧快照仍可用时调用共享 `inspectGatewayRequestBudget`，通过全部只读门后再调用 `ensureGatewayRequestBudget`，把完整原请求策略保存在内核 `control_receipt`，包括从未签发 token 的 workload。普通无修复回执的恢复也执行该步骤；批量先检查所有成员，再写入。历史策略缺失/非法保持明确拒绝，rate-limit、dedup、policy receipt 与 pending 转换共同回滚。Gateway mint/admission 消费策略回执已由 #928 与 #930 联合合入；请求上限的组合工程证据见下文，不由单独保存回执推定。

`rerun-current` 保留原已授权 Pi 扩展选择并重新经过当前镜像/扩展准入。创建与恢复共用 `job-runtime-freeze.ts`，按平台配置一致重冻 quota、runtime knobs、profile 和 launch；较大的新配置不会授权提高旧 Job 持久请求策略。

### 人工等待修正链交接（#1012）

真实 `request_human` 接受后，`agent_run` 不因等待标签、执行器返回或数据库中断自动结清。Dispatcher 的 finally 先调用原 Runtime Adapter 的精确 sandbox destroy 并等待资源消失；只有成功后，在 Canvas → Job → 最新 Attempt → effect 锁内核对仍为 waiting_human、同一活动 Attempt/sandbox、未取消及该 Attempt 的持久 human 事件，才在同一事务先撤销旧 Gateway/Control grants、再结清本轮 effect_pending 的 agent_run，并记录 runtime_grants_revoked。撤销或结算失败全回滚；unknown、外来/已结清 run 及其他效果保持不变，历史 token 行、额度和账本不删除。不补写模型用量或结束人工等待。宿主退出证据与授权回复的代际准入是两步，后者仍检查原额度和全部未结清效果。

`POST /canvases/:id/messages` 的普通回复与既有 human-node ignore 入口复用同一续接函数。所有 waiting_human Job 都在 Canvas → Job → 全部 Attempts 锁内，先检查原冻结请求策略，再调用共享 `readRepairRequeueAdmission`；通过暂停、已接受完成、全部未结清效果和累计额度门后保存原策略、关闭旧 Attempt、原子撤销旧 Gateway/Control grants 并转 pending。只有修正根存在时才额外检查原修正期限与预算，并追加 `resume-frozen` 代际；普通无根等待不创建代际，也不能跳过通用安全准入。原冻结快照、回执、历史额度/费用和期限不重写；历史请求策略缺失/非法返回具体 409，不按当前配置补造。

同 message UUID 的读取在 Canvas 锁内串行化；相同回复和重复忽略只交接一次。准入拒绝通过原 `HumanInterventionError` 返回具体 409 error_code；消息、人工节点、代际和 Job/Attempt 变更在同一事务回滚。pending 转换意外没有结果时同样回滚，不提交只有代际而没有后继 Job 的半成品。恢复权限仍是原消息/忽略入口的权限，不借本修复授权新的执行范围或重放未知效果。

`repair-generation.integration.test.ts` 已加入真实 Control request_human → 受控 Runtime Adapter 的宿主清理函数 → HTTP 回复/忽略 → Dispatcher 领取与新 owner → Gateway 累计计费 → 完成门/终态结算，以及清理/撤销失败、未知效果、取消、旧 owner/外来 sandbox/无持久 human 事件拒绝，并发重复、额度/效果/暂停/原期限拒绝与 pending UPDATE 故障的全行回滚断言。新增无修正根的回复/忽略正例、累计真实 Gateway token 耗尽、请求/未知效果/未知用量/暂停/策略损坏及 pending CAS 拒绝，核对完整历史、消息和 grants 回滚；已编写不等于已执行。受控 destroy 证明 Scheduler 接线和 SQL 归属，不冒充实际 OpenSandbox 启停或完整真实 Dispatcher/CLI 运行。消息注入和显式 ACK 仍是两阶段；本回归的 ACK 调用领域 handler，不宣称真实模型已读取，也不冒充完整 Control ACK 传输端到端。运行器和上游为受控替身，最终 SHA 的 `pnpm ci:integration:recovery` Actions 待验，本机未运行测试/构建/typecheck。

### 创建入口补齐与缺损快照诊断（#943 / #948）

2026-11-06 核对 `c0809b3e`：task retry、自动 Hub、Verify、人工补证及两类 Report 直接插入 resolver 快照，缺少完整 runtime freeze；普通 Intent/PlanTask 已冻结，不重复改造。本切片在原事务内调用共享冻结器，冻结结果与 `jobs.timeout_sec` 保持一致；retry 在清空旧画布前冻结，插入故障回滚旧任务，不另开创建事务。网络、设备、种子、共享资产和完成/验证门不放宽。

创建冻结与缺字段诊断已由 #956 合入；这本身不授权旧 Job 恢复。#943 的后续可信显式恢复见下节，不能因为 empty token/receipt 或 failed 状态推定 no-start。#948 的 Pi allowance/request 其他错误不由本切片宣布解决。

回归扩展现有 `task-retry-hub-snapshot.integration.test.ts`、`job-rerun.integration.test.ts`、Gateway 预算集成及 Web 测试：检查真实 HTTP 创建/retry/Hub 唤醒的完整冻结、覆盖来源及预算准入，注入 retry INSERT 故障验证回滚，缺字段恢复拒绝无历史写入。入口为 `pnpm ci:integration:recovery`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:dispatch-limits`、`pnpm ci:unit:credential-compatibility`；最终 SHA 的 GitHub Actions 尚待执行，本机不运行测试、构建或 typecheck。


### 缺损快照的可信显式恢复（#943）

2026-11-07 源码核对（开发基线 main `551a2689`）：普通 mint、运行及 `resume` 仍只认旧冻结输入，缺损字段明确拒绝，不暗中加载当前 RoleConfig。单 Job `rerun-current` 是显式的新执行授权，重新冻结当前配置并重新检查 target authority、镜像、扩展及权限；它不是旧协议兼容或无条件重放。可信预算准入有两个独立来源：

- 完整、版本/宿主身份和确定性 event ID 均有效的 `gateway_request_budget` 内核回执，保留总/main/background 全部原策略，包括从未 mint 的 workload。与当前配置、全部历史回执和所有撤销/过期 token 的有限上限取交集；旧 knobs 若仍有合法请求上限也必须保留。损坏回执/残留非法上限不得忽略。
- 仅针对创建时整段缺失 `runtime_knobs` 的首次执行前失败：真实 Dispatcher 在任何 runtime IO 前执行预算检查，失败时以 Canvas → Job → Attempt 锁保存 `gateway_snapshot_preflight` 内核回执。写入时核对当前 claimed Job、唯一首次 active/preparing Attempt、未绑定资源、原完整快照摘要以及无 effect/token/capability/usage/其他事件历史；重复 checkpoint 不重复写。预算 preflight 拒绝不自动派新 Hub；独立 Verify 恢复事务仍关闭失败 round 并结算 Finding，但同样禁止此次收口触发 Hub。失败 Job/Attempt、节点及 Verify round 结算不应因下游当前配置无法解析而回滚，仍待显式恢复。恢复重验 Job/Attempt/snapshot 摘要、宿主身份、事件 ID 与完整空历史，不能把失败状态、空 token 查询、没有 sandbox ID 或 Provider 异常当作替代证明。

两条路径都在 Canvas → Job → 全部 Attempts 锁下只读预检；unknown/pending/planned effect、未知 token 用量、已接受完成、暂停、修正期限/次数或累计额度耗尽仍阻止入队。全部门通过后才在同一事务追加原生预算回执、撤旧 grant、安装新执行快照和转 pending；原 Attempt/回执/费用/修正链及 deadline 不重写、不补造。新 policy 更大或 0 不删除旧有限上限；更小交集已经耗尽则沿用 `REPAIR_REQUESTS_EXHAUSTED` 明确拒绝。

`resume` 的 `GATEWAY_REQUEST_BUDGET_INVALID` 仍带 `missing_fields`。只有核验上述 rerun-current 条件通过时，诊断返回 `next_action=rerun-current`；否则 `inspect-job-recovery`。诊断本身没有写入效果。显式恢复缺少完整可信预算或执行前证明时为 `GATEWAY_REQUEST_BUDGET_HISTORY_MISSING`，包括未部署此 checkpoint 的历史缺损 Job；不能为使它们恢复补造证明。Web 只展示宿主下一步，让用户明确选择，不增加轮询/通知/配置、不自动补冻或重跑、不跳转无关账号设置。批量 resume 仍按旧快照保守准入，不借单 Job 显式操作绕过全批事务。

实现入口为 [`gateway-request-policy.ts`](../apps/scheduler/src/gateway-request-policy.ts)、[`gateway-snapshot-no-start.ts`](../apps/scheduler/src/gateway-snapshot-no-start.ts)、[`dispatcher.ts`](../apps/scheduler/src/dispatcher.ts)、[`rerun.ts`](../apps/scheduler/src/domains/job-control/rerun.ts)和 [`useJobRerun.tsx`](../apps/web/src/useJobRerun.tsx)。遵循 [ADR 0016](architecture/adr/0016-repair-execution-generations.md) 与 [ADR 0017](architecture/adr/0017-transparent-gateway-settlement.md) 的现有回执/累计预算决定，不新增 schema、状态或执行通道。preflight no-start 不是 Gateway transport settlement、Agent ACK 或模型成功。

回归扩展既有 `job-rerun.integration.test.ts` / Web 测试：真实 Dispatcher 的执行前拒绝（runtime sentinel 不得调用）与 checkpoint helper 的持久去重 → 真实 HTTP 只读反馈 → 显式补冻 → 真实领取/新 Attempt → 生产 Gateway mint；完整历史预算恢复和原 Attempt/receipt 不变；无证明、错误宿主身份、快照变化、多 Attempt、pending/unknown effect 及撤销 token 的已耗尽上限拒绝后比较完整原状态。此链不调用上游模型，mint 成功不表示 Agent 完成。入口已接 `ci:integration:recovery` / `ci:unit:credential-compatibility`，最终 SHA Actions 待验；本机未运行测试/构建/typecheck，不声称生产旧 Job 已恢复或模型效果收益。

恢复准入与 Gateway 使用共享 main token allowance：OM 的已结算后台用量不消耗 main reserve；同 Job 已有 OM token 历史时，即使 `rerun-current` 不再选择 OM，也保留 workload 计费隔离和历史有限上限。未启用过 OM 的 Job 继续使用全 Job token 额度。此隔离不豁免旧后台 pending/unknown effect：建立新代际前仍须全部结算。请求次数上限是独立约束，不因本 token allowance 修正而扩大。 allowance 将尚无账本的 pending reservation 返回为 `JOB_TOKEN_USAGE_PENDING`，不冒充 unknown 或零成本；未知/缺失结算仍返回 `JOB_TOKEN_USAGE_UNKNOWN`。两者均不授予新代际。

代际事件保存 `supersedes_attempt_id`、`previous_chain_status=superseded` 和唯一下一 `target_attempt_no`。待领取时 owner 为空，不能用于模型调用；领取后 Gateway 和完成门共同解析相同 owner。原负回执/费用不修改，模型调用继续归因到原 repair receipt；新完成提案使用累计下一 revision。原 key 查询和传输重放保持原结果，不把历史 next_action 当成当前许可。手动入口的成功只表示已入队；完成必须等新 Attempt 通过完成门和终态结算。

已启动 stale Recovery Hub 用原 grant 提交 `release_stale` 后正常结束；读取新投影不扩大旧 grant。退出动作不对账、不改变目标状态。原 Hub 存在未知效果时，后继 Hub 仍不能获得执行权；新 wake 继续消耗原根额度和期限。

## 完成失败诊断候选（#951）

完成失败诊断已随 #963 合入并工程收口（2026-11-07 核对）；后续提交按各自最终 SHA Actions 另验，不改变完成门或已有 Job 状态。`executeReal` 在运行器异常、最终语义/runner 失败及本地未观察到 done 时，先向现有受权限保护的 normalized evidence stream 写一条版本化 `run.completion_diagnostic`，再完成归档和保留原失败；正常接纳完成不生成缺失完成诊断。缺 done 使用 `AGENT_COMPLETION_UNOBSERVED`，不把“未观察到”命名为 Agent 故意跳过，也不凭同现的预算/HTTP 错误推定平台责任。

诊断只含 Job/Attempt 身份、最后已持久化工具名称/结果类别/证据游标、宿主拒绝码，以及 Job/evidence/原 completion 回执引用。工具参数、返回正文、summary 和 transcript 尾部不复制进诊断或公开日志。`last_persisted_tool` 的时间为宿主看到持久化完成的时间，不是模型读取或执行 ACK。真实控制错误和运行器异常仍保留原抛出对象/错误分类。

只读统计通过 `artifacts.source_event_id` 与同 Job、同 Attempt 的事件关联 Artifact 版本记录和当前 Finding 投影；历史 Attempt 不能充作本轮产出。没有事件归属的 Job Artifact 独立记为未归属；报告表没有 Attempt 身份，`reports=null` 并说明不可归属，不假造本轮零报告。产出数量不是完成、Verify、效果结清或可重放的证明。

完成回执按原 Job/Attempt、冻结 snapshot digest 和内核 receipt identity 复核，只投影 key/revision/状态/拒绝码，不回显输入。区分未观察到持久回执、拒绝、接纳待结算、done 事件已持久化及未知；done 事件存在仍不是 Job 终态成功。读取/归档失败分别明确记 unavailable，不推断零费用、零产出或无提案；原回执不改写，不换 key 重发、刷新预算或增加 `succeeded_with_warning`/开关。下一步仅由有权用户检查原回执、证据及既有治理恢复门。

实现入口为 [诊断收集器](../apps/scheduler/src/completion-failure-diagnostic.ts)；接线复用 `pnpm ci:unit:executor-real` 与 `pnpm ci:integration:recovery`。单元、真实 executor 替身及隔离 PostgreSQL 回归覆盖异常保留、正常完成不误报、跨 Attempt 产出隔离、拒绝/接纳/事件状态和不可变原回执。这里的源码与断言不代表已执行通过；生产归因、全量记录覆盖及没有 Attempt 归属的报告统计仍未验证。

## 人工等待超时与未结清效果（#946）

2026-11-06 核对 `c0809b3e`：人工等待已有独立配置和最近 human 事件时钟；但定向对账报告残留时，旧路径只追加“先对账”的文案，随后仍把 Job 写成 failed/human_timeout。本切片在 Job → Attempt 锁下执行检查：有残留或本轮有结算进展保留 waiting_human；最终 UPDATE 还要求该 Job 的全部效果为 settled，覆盖对账扫描排除的 active Attempt 和 planned 效果。被阻断的 Job 不进入 Reaper 的终态返回列表，因此不触发 human_timeout 计数、终态清理或 Canvas 失败推进。

不刷新原 deadline、预算、token 或 Attempt，不自动重放/结算未知效果，不改 Finding、Report 或已接受人工请求。人工等待仍可被已有显式取消/回复流程处理；#946 当时不覆盖所有回复恢复路径。普通及修正根关联的回复/忽略共享准入候选见[交接](#人工等待修正链交接1012)，最终 SHA Actions 待验，不扩写为生产普通等待已验证。`human_messages.delivered_at` 表示人给 Agent 的消息已注入，不是 Agent 请求已经投递给人的证据；“实际通知投递后计时”未在此实现；#946 的未结清效果误判核心故障已工程收口，通知计时仍是独立未交付范围。

`pnpm ci:unit:job-lifecycle` / `pnpm ci:integration:job-lifecycle` 的既有入口增加未知效果、部分对账进展、active/inactive Attempt × planned/pending/unknown、多 tick 无变更、显式结算后正常到期的回归。仅合成 SQL/替身，最终 SHA GitHub Actions 待验；本机不运行测试、构建或 typecheck。

## 审计矩阵

下表“实现”指已合入源码及接线；不是未运行测试的通过结论。

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

本地只进行静态阅读与 `git diff --check`；测试、构建、typecheck 在 GitHub Actions。联合请求额度回归依赖 #928 consumer：真实创建/HTTP 恢复/Dispatcher 后首次 OM token 仍受旧 10/8/2 策略约束，并覆盖未签发任何 token、连续恢复和非法原策略整批拒绝。该联合代码已包含在下述 main 工程验收基线。新增恢复测试覆盖 OM main90/后台15/主上限100 的恢复与重新冻结最终结算、main 耗尽和旧后台 pending/unknown 的无变更拒绝，以及重冻后旧模型拒绝/新模型成功。使用隔离随机 PostgreSQL、假凭据、loopback 假上游和受控 runtime handler；真实 HTTP handler、预算、回执和最终 ingestion 属于工程覆盖，不是生产运行或真实模型理解。当前源码存在不等于最终 SHA 全绿。

界面复用已有 Job 诊断和恢复入口，不增加通知/配置；当前状态明确区分等待人、平台对账和可请求恢复。没有宿主许可时不显示“安全重试”，减少用户误判和重复点击；响应仍需服务端实时准入。


当前状态保留 `accepted_terminal=human` 的接受事实，并返回 `human_wait_kind` / `wait_owner`。credential 指向平台管理员修复，authorization 指向有权限的操作员；high_risk_action、business_decision 和 Finding 判断仍是明确人工决策。无类型历史只提示检查，不猜测需要回复 Agent。此分类不解除人工等待、不自动恢复、不授予授权。任务级批量恢复与单 Job 恢复共用实时目标授权预检；全批次通过后才改变 convergence、代际、Attempt 或 grants。

普通恢复即使从未产生 rejected completion，也必须通过暂停、所有旧未结算效果、已接受完成与累计模型额度的只读准入；只有修复 revision/deadline 依赖 repair root。无 root 的单 Job resume/rerun-current 与 sibling 批次负例验证拒绝不修改原状态。隔离数据库的第二 sibling 策略 INSERT 故障测试以非事务 sequence 作为到达见证，确认第一份策略回执及双方 dedup/rate-limit 写入后才抛错，再比较整批持久状态全部回滚；该测试的工程证据归属下述 main 验收基线。

无 repair root 的额度负例通过两个真实 loopback Gateway grant 累积结算：请求 4+4 达到主上限 8、token 10+10 达到主上限 20。resume、rerun-current、resume-session 均断言额度错误、没有额外上游调用且整批持久状态不变；未手工写费用账本或请求计数，工程证据归属下述 main 验收基线。

Hub 普通 Intent 和 PlanTask 创建也经过统一 `freezeJobRuntimeConfiguration`，不再把缺 runtime knobs 的 resolver 快照直接公开为 pending Job。`plan-execution.integration.test.ts` 使用真实 Control→ingestion 创建并检查完整 knobs/profile/launch，以及普通 Intent、PlanTask 图写入故障后的原子回滚；仅合成夹具，工程证据归属下述 main 验收基线。

专门 Hub Pi+OM 回归位于 `repair-generation.integration.test.ts`：正式 Control `submit_hub_decision` → 只读预检 → ingestion 以真实 resolver 创建 pending Worker，不回填快照；检查 10/8/2 配额、完整 knobs、profile 与 launch 一致。缺少有限分配、分配超过总额均在预检返回 `pi_om_configuration_invalid` / `permanent_failure`，指向平台管理员且禁止 Agent 扩额或换 key 自动重试；断言无 ingestion、子 Job、图或已接受语义效果。此合成覆盖归属下述 main 验收基线，不代表真实模型验证。

2026-11-06 工程证据：发布协调者已验收 main `616d7a3651c0e0b89d9457f4f435c02f51f8561b` 的核心与五项专项 Actions 日志，链接集中见[发布基线](RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)。后续提交仍须独立检查，不证明正式发布、生产或真实模型结果。
