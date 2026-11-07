# Agent 错误反馈与执行恢复（#903）

> 状态：as-built；#930 与 #928 已合入 main 616d7a36，工程证据见下文，后续 SHA 另验
> 同步日期：2026-11-06

这是 [完成回执](REPAIR_FEEDBACK_DONE_REPAIR.md)的生命周期扩展。设计取舍见 [ADR 0016](architecture/adr/0016-repair-execution-generations.md)。#911 已合入 Knowledge/Skill 分类透传；#919（#913）已合入仅在宿主接受完成后识别结构化 Gateway 拒绝的运行器处理。本次不重复这两片，也不把工程证据写成真实模型试验。

## 宿主生命周期

同 Job 的修复次数、revision、token 根与已知/未知用量累计保留。`resume` 保留原冻结快照且拒绝身份漂移；`rerun-current` 重新核对当前配置和目标授权。存在拒绝历史时，两者仅在旧效果全部结算、原期限未到、预算仍允许且未暂停/接受完成时追加新代际。锁顺序为 Canvas → Job → Attempt；与旧 effect intent 写入、Dispatcher 领取互斥。 pending 转换意外返回空结果时抛错回滚整个事务，再在事务外映射业务拒绝；批量恢复不得跳过失败成员并提交其他成员。隔离 SQL 触发器故障注入覆盖该回滚边界。

恢复事务在旧快照仍可用时调用共享 `inspectGatewayRequestBudget`，通过全部只读门后再调用 `ensureGatewayRequestBudget`，把完整原请求策略保存在内核 `control_receipt`，包括从未签发 token 的 workload。普通无修复回执的恢复也执行该步骤；批量先检查所有成员，再写入。历史策略缺失/非法保持明确拒绝，rate-limit、dedup、policy receipt 与 pending 转换共同回滚。Gateway mint/admission 消费策略回执已由 #928 与 #930 联合合入；请求上限的组合工程证据见下文，不由单独保存回执推定。

`rerun-current` 保留原已授权 Pi 扩展选择并重新经过当前镜像/扩展准入。创建与恢复共用 `job-runtime-freeze.ts`，按平台配置一致重冻 quota、runtime knobs、profile 和 launch；较大的新配置不会授权提高旧 Job 持久请求策略。

### 创建入口补齐与缺损快照诊断（#943 / #948）

2026-11-06 核对 `c0809b3e`：task retry、自动 Hub、Verify、人工补证及两类 Report 直接插入 resolver 快照，缺少完整 runtime freeze；普通 Intent/PlanTask 已冻结，不重复改造。本切片在原事务内调用共享冻结器，冻结结果与 `jobs.timeout_sec` 保持一致；retry 在清空旧画布前冻结，插入故障回滚旧任务，不另开创建事务。网络、设备、种子、共享资产和完成/验证门不放宽。

预算错误继续使用 `GATEWAY_REQUEST_BUDGET_INVALID`，缺损 knobs 在管理恢复响应增加 `missing_fields` 与 `next_action=inspect-job-recovery`；Web 展示字段和核对历史的责任，不冒充额度耗尽或账号错误。旧快照仍先于新配置接受预算历史校验，缺损快照、未结算/未知效果不会因空 token/receipt 查询被补冻；恢复闭环的可信未执行证据仍由 #943 跟踪，不能以本切片关闭整单。#948 的 Pi allowance/request 其他错误也未据此宣布解决。

回归扩展现有 `task-retry-hub-snapshot.integration.test.ts`、`job-rerun.integration.test.ts`、Gateway 预算集成及 Web 测试：检查真实 HTTP 创建/retry/Hub 唤醒的完整冻结、覆盖来源及预算准入，注入 retry INSERT 故障验证回滚，缺字段恢复拒绝无历史写入。入口为 `pnpm ci:integration:recovery`、`pnpm ci:integration:platform-api`、`pnpm ci:unit:dispatch-limits`、`pnpm ci:unit:credential-compatibility`；最终 SHA 的 GitHub Actions 尚待执行，本机不运行测试、构建或 typecheck。


恢复准入与 Gateway 使用共享 main token allowance：OM 的已结算后台用量不消耗 main reserve；同 Job 已有 OM token 历史时，即使 `rerun-current` 不再选择 OM，也保留 workload 计费隔离和历史有限上限。未启用过 OM 的 Job 继续使用全 Job token 额度。此隔离不豁免旧后台 pending/unknown effect：建立新代际前仍须全部结算。请求次数上限是独立约束，不因本 token allowance 修正而扩大。 allowance 将尚无账本的 pending reservation 返回为 `JOB_TOKEN_USAGE_PENDING`，不冒充 unknown 或零成本；未知/缺失结算仍返回 `JOB_TOKEN_USAGE_UNKNOWN`。两者均不授予新代际。

代际事件保存 `supersedes_attempt_id`、`previous_chain_status=superseded` 和唯一下一 `target_attempt_no`。待领取时 owner 为空，不能用于模型调用；领取后 Gateway 和完成门共同解析相同 owner。原负回执/费用不修改，模型调用继续归因到原 repair receipt；新完成提案使用累计下一 revision。原 key 查询和传输重放保持原结果，不把历史 next_action 当成当前许可。手动入口的成功只表示已入队；完成必须等新 Attempt 通过完成门和终态结算。

已启动 stale Recovery Hub 用原 grant 提交 `release_stale` 后正常结束；读取新投影不扩大旧 grant。退出动作不对账、不改变目标状态。原 Hub 存在未知效果时，后继 Hub 仍不能获得执行权；新 wake 继续消耗原根额度和期限。

## 人工等待超时与未结清效果（#946）

2026-11-06 核对 `c0809b3e`：人工等待已有独立配置和最近 human 事件时钟；但定向对账报告残留时，旧路径只追加“先对账”的文案，随后仍把 Job 写成 failed/human_timeout。本切片在 Job → Attempt 锁下执行检查：有残留或本轮有结算进展保留 waiting_human；最终 UPDATE 还要求该 Job 的全部效果为 settled，覆盖对账扫描排除的 active Attempt 和 planned 效果。被阻断的 Job 不进入 Reaper 的终态返回列表，因此不触发 human_timeout 计数、终态清理或 Canvas 失败推进。

不刷新原 deadline、预算、token 或 Attempt，不自动重放/结算未知效果，不改 Finding、Report 或已接受人工请求。人工等待仍可被已有显式取消/回复流程处理；本切片不证明所有回复恢复路径已满足效果门。`human_messages.delivered_at` 表示人给 Agent 的消息已注入，不是 Agent 请求已经投递给人的证据；“实际通知投递后计时”未在此实现，#946 保持开放。

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
