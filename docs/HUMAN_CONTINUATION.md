# 人工等待的断点与续做（#1074）

> 状态：as-built 代码契约；最终提交的 GitHub Actions 验收另验
> 同步日期：2026-11-19
> 需求：FR-JOB-008、FR-CTRL-006；决策：[ADR 0022](architecture/adr/0022-human-continuation.md)

人工等待超过响应阈值只记 overdue，Job 保持 waiting_human。有权限的用户可在 Job 详情读取完整问题并「回复并继续」。2026-11-11 的两个历史 failed Job 不自动复活，也不据历史回执重放外部效果。此实现不部署现场，不更换用户运行配置。

## 原生会话受限导入（#1074 独立切片）

Scheduler 在旧 Attempt 证据归档后、文件封存前读取该 Attempt 唯一主会话，核对 job、attempt、session、归档 bytes/SHA-256 和冻结快照。仅支持 Pi 1.5.2 的 v3 JSONL 与 Claude 2.1.312 的主会话 JSONL。投影后的内容在原 request 的 checkpoint blob 下保存，精确身份、摘要、能力结果和原因写入原 Attempt 的 state_json.human_session。到期与删除复用原 request 的文件清理。没有新增数据库表或公开 API。

能力矩阵由 runtime-sandbox 的 nativeHumanSessionCapability 拥有。Pi/Claude 为 supported + restricted_conversation，表示可导入符合条件的文字历史。DSH 明确 unsupported + structured，原因是 adapter 没有持久 resume 协议。未核对版本、没有归档、压缩/分支/上下文编辑、OM 记忆状态、格式或摘要不满足条件时记录具体原因并使用 structured。已绑定的导入 blob 缺失、损坏或身份变化则拒绝执行。

导入保留会话和消息 ID，将工具提案/结果转换为历史文字。旧 system 消息、思考签名、扩展状态、私有配置、路径来源和待执行工具调用被排除。受管秘密按原执行的精确值过滤，同时复用人工请求的结构化秘密投影，含旧 Control 路径、身份或秘密标记的文本行排除。新沙箱重新生成当前 Control/Gateway token、系统提示、配置和冻结扩展，仅导入主会话文字。新 Attempt 先持久化导入的 session 身份，再调用现有 adapter.resume；Pi get_state 和后续会话观测必须匹配，所有原预算/准入继续生效。

消息正文中的图片和未知内容块返回 `unverified_session_content_block`，使用 structured 并保留原因。仅明确的 thinking/redacted_thinking 思考块可排除，不能静默丢弃未知上下文后仍声明原生导入成功。

归档 JSON 解析后先在字符串叶子上按原始受管秘密的完整值替换，再做通用脱敏，防止多行秘密被首行改写后残留正文。PostgreSQL capture→load 回归覆盖未加引号的多行私钥文本。

导入上限 8 MiB、20,000 行。固定 Pi 原生链接入核心 base 镜像 smoke，固定 Claude 原生链接入 Reverse Claude request-budget acceptance，均使用隔离网络与合成 Provider，检查旧 home→归档→过滤→新 home→原生恢复及旧身份不再进入请求。SQL 绑定/跨身份拒绝接入既有 platform-api 集成测试。当前实现等待最终 SHA Actions，生产续跑未执行。

### 固定格式核对与受限范围

Pi 1.5.2 的 `dist/main.js` 按路径打开 `SessionManager.open`，v3 header 的 id 是会话身份。`dist/migrations.js` 会先移动 agent 根目录内的 JSONL，因此导入和原生夹具均使用 `sessions/--workspace--/` 子目录。已保留的消息重接 parentId，未知记录、自定义扩展、压缩和分支拒绝原生导入。

Claude 2.1.312 Linux x64 固定 npm 包的原生二进制内含版本化源码。核对 transcript storage 的 `appendRequestReplay`、`last-prompt` 读取和附件转换器 `nLe`/`_ft` 后，逐类处理如下。

- `api-request-shape`、`api-request-blob`、`api-request` 保存旧请求的 system/tools/messages 重放诊断，全部排除。`atis-latch` 是旧会话请求锁存，`cost-state` 是 CLI 显示与本地成本状态，也排除。平台预算继续使用原账本。
- `tools-used` 由 transcript writer 从 `j_().names()` 写入，读取时恢复旧 conversationToolsUsed 集合，用于工具使用清单和请求头。旧工具状态排除，新执行重新记录工具使用；工具提案与结果的历史文字仍由对应消息保留。
- `queue-operation` 仅已核对无 content 的 enqueue/dequeue 可省略。含正文或未知操作无法证明任务提示已消费，返回 `unverified_queued_prompt` 使用 structured，保留原始归档供核查。
- `last-prompt` 可以选择 leaf 或清空上下文。只有 leaf 与已核对线性链一致才可省略，rewound、不同 leaf 或显式清空使用 `transformed_context_requires_structured`。
- 附件不是普通元数据。已核对的 `environment`、`model`、`deferred_tools_delta`、`agent_listing_delta`、`skill_listing`、`total_tokens_reminder`、`session_context`、`date`、`remote_session_change` 是旧执行配置、能力、额度和环境提示，随新执行重建。`prompt_snapshot` 在固定转换器中不产生消息，保存旧系统提示和工具快照，排除。
- 文件、排队指令、已调用 Skill 和未知附件可能含任务上下文，明确返回 `unverified_context_attachment` 并使用 structured。保留附件链的 UUID 校验后重接导入文字的 parentUuid，不能无提示吞掉未知语义。

原生验收还覆盖合成上游实际发出 Bash 工具调用，通过隔离 HTTP 宿主夹具接受 `request_human`，在工具结果返回前停止 CLI。断言原归档有 tool call 且无 tool result，再投影至新 home，恢复后调用新身份的 ACK 夹具。旧等待接受次数必须为 1，新系统提示和 Provider 身份生效。HTTP 夹具证明原生工具协议与该中断位置，真实 Scheduler 的持久回复、ACK 和完成门由 PostgreSQL 集成回归另外验证。

## 持久记录与封存

schema 73 新增 human_requests 和 job_execution_clocks；human_messages 以 request_id/request_revision 精确关联请求。human 事件、请求、waiting_human 和 preparing 意图在同一原语义事务保存。历史事件仍不可变；Canvas 节点和 UI 不是恢复 authority。

真实执行在 CLI 退出后、Dispatcher finally 销毁沙箱前保存断点。宿主在启动 CLI 前记录 Linux 沙箱 PID/start-time 基线，封存时排除宿主命令及祖先进程，暂停观察到的本轮新进程。另以 Linux inotify 在发现文件候选前建立目录监视，覆盖整个扫描/读取区间；修改、新文件、目录变化、事件溢出或监视失效均阻断本次保存，不把有限 PID 扫描本身当作一致性证明。复制后只有监视明确通过、所有 hash 核对且原沙箱可信销毁后才可 ready。仅适用于隔离 Linux 沙箱，不提供主机进程扫描入口。

文件先扫描路径、大小和 SHA-256，再读取并核对。符号链接目录、硬链接与特殊文件拒绝；平台注入文件、控制目录、CLI 私有配置、凭据缓存与敏感路径不保存。与已知受管秘密匹配的文件阻断封存；这不保证任意用户文件不存在未知秘密。上限为 256 文件、单文件 8 MiB、总计 64 MiB，封存 60 秒超时。hash 寻址文件保存到已有 BLOB_DIR 下 human-checkpoints/request_id/hash，读取必须重新校验，跨副本不可见不视为空恢复。

manifest 绑定 Job、Attempt、请求、冻结快照摘要和 structured 模式。销毁沙箱必须由原 worker/Attempt 精确归属证明；随后原子撤销旧 Gateway/Control grants、结算确切 agent_run、记录 process_exited_at/resources_released_at、关闭旧 Attempt 为 interrupted 并暂停有效执行时钟，Job 保持 waiting_human。失败提交保留原 owner/effect/lease，现有恢复循环重核，不用 interrupted 反推销毁成功。未决的其他外部效果不被这一步结算。

Dispatcher 正常 finally 立即回收等待资源；重启后现有 reconciliation 在 manifest 可用、封存 blocked 或准备超过 90 秒时执行相同回收。人工等待回收不会把 Scheduler 仍在途的 Gateway 请求仅因沙箱销毁改成 unknown：保留原 pending 效果由原请求结算，未知效果仍需对账且不重放。保存失败也有界回收并保留具体 blocker；不无限保留沙箱。设备租约/共享资产沿既有 finally 和 Reaper 清理。waitingHumanSec 的 0 关闭 overdue 计时；它不关闭必要的有限封存/资源清理。

断点保留 30 天。现有循环在删除文件前先持久标记 HUMAN_CHECKPOINT_EXPIRED，删除失败继续重试，不能保持 ready 后静默删文件。请求和历史证据不随断点文件过期而抹除；无法续做时明确显示原因。

## 普通业务文件的权限契约

文件清单使用 manifest v2，每个文件必须携带 `mode`，只接受 `0600`（所有者读写）或 `0700`（所有者读写执行）。捕获时按 `0600 | (source_mode & 0100)` 投影，只保留所有者执行能力。原始权限位不存储，组和其他用户的访问位以及 setuid、setgid、sticky 位全部舍弃。原先可由所有者直接运行的 `./script` 因此可在恢复后继续执行。

v1、缺少 mode 或其他权限值均拒绝恢复。正常加载入口对不符合清单契约的记录返回稳定码 `HUMAN_CHECKPOINT_IDENTITY_CHANGED`，与准入检查保持一致。已经冻结的旧清单与历史证据保持原样，不能自动补字段或重写历史来取得恢复资格。该契约通过已有 JSON manifest 保存，无 SQL schema 变更。

恢复在新 Linux 沙箱中、Agent 启动前执行。全部业务路径先逐层用目录文件描述符与 `O_NOFOLLOW` 检查，拒绝越界、秘密和平台目录、符号链接、硬链接及特殊文件，预检通过才上传。上传后重新安全打开普通文件，核对大小与 SHA-256，再通过 `fchmod` 设置精确权限并核验结果。目录只按需创建为 `0700`，现有目录不执行 chmod。Python 脚本与分批 JSON argv 均经 shell 安全引用，文件名中的引号或命令替换符号仅作为数据传递。任一步失败均阻断 Agent 启动。

真实 Linux 文件回归执行生产扫描与恢复脚本，覆盖 capture → upload → chmod → 直接执行 shell 文件的往返，并核对非法 mode、旧版本、路径注入、秘密路径、符号链接、硬链接和上传内容损坏拒绝。进程静止与目录监视另由既有回归覆盖。测试接现有 `ci:unit:bounded-contexts`，普通恢复入口接线由 `ci:integration:platform-api` 覆盖，最终 SHA Actions 结果单独验收。

## 回复、准入与运行

沿用 POST /canvases/:id/messages（tasks:write 与原项目隔离），target.kind=request 必须携带 request_id 和 expected_revision，message_id 是客户端幂等 UUID。相同 ID/目标/版本/正文/附件返回原消息，改正文或附件返回 409；旧版本或其他请求不能解除新一轮等待。

回复先保存为 answered，返回 202/reply_state=reply_saved。即使准备中、暂停、缺文件或预算不足，回复仍持久存在，不要求重复输入。202 只证明保存，UI 通过 human_continuation 和 execution_state 展示后续阻塞。generic job/hub 消息和「忽略」都不能直接恢复 waiting_human。

既有 reconciliation 有界公平轮转扫描 answered 请求，核文件、旧执行退出/回收、最新 Attempt、冻结身份、目标实时授权、FIFO 席位、任务暂停、全部效果/用量和累计预算。全部通过才在同一 Canvas→Job→Attempt→请求事务写 Scheduler-owned human_continuation 事件、唯一下一 attempt_no 并转 pending。有 rejected-completion root 时还用原 repair_generation 授权精确新 owner，保持原 deadline 和额度；无 root 仍有独立续做归属事件。

Dispatcher 在 provision 和 agent_run 前再核对确切 successor 与文件；开始前重新核冻结身份，目标授权仍走现有实时门。取消、过期、文件丢失或 owner 漂移不能空白启动。原 token 被撤销，旧执行不能收到新请求的回复。新执行通过原 inbox 注入消息并显式 ack_human_message；已保存、已注入、已 ACK 与已完成分别记账，注入 unknown 不自动再发。

structured 模式恢复验证后的业务文件、原问题、用户回复和有界文件索引，再依既有 Hub/Canvas 按需读取当前事实/计划。满足上述受限条件的 Pi/Claude 可导入主会话文字，DSH 使用 structured。只有新执行的合法完成门和结算证明完成。

启动提示只携带待处理回复的引用与状态，正文只经 inbox 投递，unknown 投递不从启动提示旁路再发。已 ACK 的历史可作为只读上下文供显式后继恢复使用，不再次投递。同 Job 累计已 ACK 的不可变附件单独校验并恢复到各消息原 inbox 路径，启动索引列出这些历史输入；上限 256 个、单文件 8 MiB、总计 64 MiB，超限明确阻断，不静默丢弃较早轮次输入。待处理回复附件仍只随原投递入口提供。完成门要求当前回复已 ACK，否则返回可修正反馈；已知失败后的单 Job resume 重核原断点并追加下一 owner，不被首次 target_attempt_no 永久锁定。更换配置和任务批量恢复不能绕过断点身份门。

多轮等待同时恢复本 Job 累计已 ACK 的文字回复、请求引用和 ACK 摘要，按消息保存顺序写入当前请求 inbox 下只读的 `acknowledged-history.json`，启动提示提供读取路径。该历史最多 256 条、序列化后最多 1 MiB，准入扫描与执行前重核均检查上限，超过时返回 `HUMAN_CHECKPOINT_HISTORY_LIMIT` 并保留已保存的新回复。历史不包含尚未 ACK 或投递未知的消息，不产生新的投递或 ACK，不替代当前授权核验。正文从持久消息账本恢复，避免仅恢复较早轮次附件却遗漏文字决定。

## 预算与边界

有效执行时间由 job_execution_clocks 从首个受理 human 的原运行区间累计；可信回收且在途 Gateway 效果/用量结算后暂停，等待期间仍有未决模型调用则保守继续计时。资源释放后的时钟收敛独立于回复，以持久化的退出、回收与最后 Gateway 结算/用量观察时间的较晚值关闭区间；用户尚未回复、轮询延迟或 Scheduler 停机不会在结清后额外扣时。jobs.started_at 保留本次实际开始时间用于停滞检测，execution_deadline_at 单独保存原剩余有效时间与 repair 硬期限的较早值；Control token、Gateway、完成/Plan 门与 Reaper 共同使用它。排队和纯人工等待不耗有效执行时间，重复清理不重复扣时。请求数、主/repair token、修正次数与 Plan lifetime 沿原账本，unknown 不按零消耗，原 repair deadline 不延长。

封存等待保留当前 FIFO 占位，不占活跃执行槽。暂停/取消/归档和授权撤销仍由既有门控制。普通 failed 历史无合法新断点不自动续做；原生 Session 继续和补充回复的专用编辑体验另按对应切片核验，不冒充本片已交付。

## 注意力成本与验收

维护预检直接重核断点过期时间，避免后台清理尚未执行时把已过期的 ready 记录当作可安全维护的等待任务。隔离 PostgreSQL 回归覆盖合法封存、过期窗口、退出证明缺失、沙箱残留、未决效果、旧 Control token 与新 Attempt 归属，接既有 `pnpm ci:unit:migrations`。本次最终 SHA 的 Actions 待验。

| 触发 | 用户看到 | 需要的动作 | 失败反馈 |
| --- | --- | --- | --- |
| 当前请求 open | 完整问题、保存状态、超时仍可答 | 原位置回复一次 | 保存失败保留草稿与幂等 ID |
| 回复已保存但未准入 | 已保存及固定 blocker | 修复所指条件 | 不要求重新粘贴回复，不承诺已运行 |
| 历史终态请求 | 只读问题及历史 | 无恢复按钮 | 不把历史接受当当前权限 |

本片回归接既有 Actions 的 ci:unit:bounded-contexts、ci:unit:web-facts、ci:integration:platform-api 和恢复/生命周期套件；同时核 OpenAPI、schema、文件体量与文档保鲜。仅 Actions 执行测试/build/typecheck；本地只静态核对和 git diff --check。HTTP/PG 与可控 RuntimeHost 支撑工程状态机证据，不证明真实模型理解、原生恢复率、生产效果或 SLA。

## 历史 failed 显式续做与原预算链

管理接口 `POST /jobs/:id/continuations` 要求 jobs:control 和原项目归属，严格接收 mutation_id、request_id、expected_revision 与 reply（message_id、body、attachment_version_ids）。首先按消息 ID 和原请求版本幂等保存回复，再独立事务准入。原终态请求保持 closed，拒绝续做仍保留回复。相同输入重试返回同一新 Job，不能覆盖原回复。

仅 failed 的当前合法检查点、可信退出和资源回收、完整冻结请求策略与全部主/OM 消费账本、原累计时钟允许续做。缺失检查点、账本、时间证据、未知效果、已接受完成、过期和剩余额度耗尽返回稳定 409。原生会话能否接续仍依对应适配器的精确身份门。Verify、Report、verification_followup、goal_review 和知识分配带独立 Job owner，当前返回 CONTINUATION_ASSIGNMENT_OWNER_UNSUPPORTED，不能复制其分配到新身份。历史事件不能拼成检查点。

schema76 的 jobs.budget_owner_job_id 指向第一 Job，第一 Job 的 budget_execution_job_id 指向唯一当前执行者。job_continuations 保存直接前驱、源 Attempt/请求/版本、检查点摘要、原回复、新接收回复及 mutation。原 failed、快照、历史回执和消费记录保持来源身份，新 Token、Effect、Usage、ACK 和完成回执属于新 Job。预算从整条可信链的现有账本累计，不复制余额。单条/批量修正预算读取共用原根，列表仍保持三次批量 SQL。

原 root 行先于执行 Job、Attempt、请求和 Token 加锁，管理与 Canvas 语义操作先取 Canvas，dispatch admission advisory 在管理和领取之前。Gateway 准入/结算、完成门和执行前检查使用同一 root owner。交接和持久恢复审计同事务提交。被替代的执行不能 resume/rerun 或再获得执行权限，迟到结算仍记录原实际身份。硬删除和 wipe retry 保留整条预算证据。

累计有效执行时钟留在原 root，新 Job 使用剩余有效时间。原 rejected-completion 的绝对 deadline 与修正次数/revision 沿链累计，后继交接不能延长。Plan 同 Canvas/objective 的全部已派发 Job 计入 lifetime_tasks_dispatched，新 continuation 另扣一名额。仅可信直接后继覆盖该 task 当前执行投影，原 failed 仍保留计数。停止目标不自动重开。

202 只表示新 Job 已排队，响应含 source_job_id、job_id、budget_owner_job_id、execution_reply_id 与 mutation_id。新增接口减少重新录入回复的负担，同时要求显式选择历史请求和版本。回归通过原 ci:integration:platform-api 调用历史场景，测试/build/typecheck 仅在 Actions，最终组合 SHA 验收单独登记。

## 完整验收对照（2026-11-19）

本次静态核对以 main `2664b134`、已合并 PR #1075 和本次文字历史修复为依据。#1075 的最终候选 Actions 记录在其 PR 中，本次最终 SHA 仍须独立验收。以下“已实现”表示找到正常调用路径和代码，只有实际 Actions 结果才能证明相应工程回归通过。#1074 保持开放。

1. **超过响应期限后晚回复**。已实现 overdue、持久请求、有限封存、可信销毁后 interrupted、Job 保持 waiting_human 和唯一后继 Attempt。依据 `dispatcher-human-wait.ts`、`human-checkpoint.ts` 和 `human-continuation.integration.test.ts`。停止失败与未决效果继续阻断，响应阈值 0 关闭 overdue 而不关闭资源回收。已有隔离 SQL/HTTP/可控宿主回归，真实生产等待未执行。

2. **多轮请求、重复回复和并发竞争**。已实现 request/revision、同 UUID 同内容幂等、不同内容拒绝、旧请求不能解除新等待、原 token 撤销和新 owner 检查。依据 `domains/canvas/human-messages.ts`、`rerun.ts`、`human-continuation-admission.ts`。两轮等待与双击有回归，任意崩溃点和每种取消/封存交错尚无穷尽证据。本 PR 补累计已 ACK 文字与原问题恢复，待最终 Actions。

3. **主额度与计时**。已实现本 Job 跨 Attempt 的主/repair token、请求数、修正代际与有效执行时钟累计，未知 usage 不按零，原 repair deadline 保持。依据 `human-continuation-clock.ts`、`repair-admission.ts` 和 `gateway-request-budget.ts`。现有回归覆盖迟到结算、两轮等待和已知失败后第 3 次执行。独立绝对业务硬期限及单独追加预算的管理操作没有作为完整新契约交付，不能用普通回复扩额。

4. **Pi 原生会话**。底层 adapter 已有 `persistentSessionResume=true`、精确 `sessionFile` 检查及 `--session`，运行器也有同沙箱错误后的受治理 resume。依据 `packages/runtime-sandbox/src/runtime-adapters.ts`、`runtime-agent.ts` 及其测试。人工等待路径只恢复 structured 文件和上下文，没有把 Session 归档导入新沙箱并绑定新身份后调用原生恢复。可独立补齐受限导入、格式/版本/身份校验及固定版本原生 Actions 链，无需生产权限。现有源码不证明人工等待后的原生恢复已通过。

5. **Claude 原生会话与 DSH**。Claude adapter 已有 `--resume`，归档器能发现主/子会话，但人工后继没有跨沙箱导入接线。Pi/Claude 的 supported、unsupported、missing_archive 人工续做结果矩阵尚未交付。DSH adapter 明确 `persistentSessionResume=false`，不能把其 JSONL 导出视作可恢复状态。可独立补 capability/阻断投影与 Claude 导入验证，真实供应商认证或计费模型试验另需对应外部输入/授权。

6. **历史 failed 显式关联 continuation Job**。未实现 issue 第 10 节要求的新关联 Job、source_job/source_attempt/request/checkpoint 与跨 Job 原预算根。当前 `rerun.ts` 支持的是已经有合法断点且后继已知失败时，同 Job 再建 Attempt，不能替代历史失败新 Job。需要独立 schema/API/预算归属切片，当前不存在可安全复用的完整跨 Job 预算根。实现与隔离夹具在本任务授权内，生产历史导入、追加预算和现场续跑需各自明确授权。缺失断点不得合成。

7. **项目 FIFO**。默认等待保留队首、后继不能抢占已经实现。依据 `domains/project-task/task-queue-model.ts`、`task-queue-store.ts` 和 `human-continuation-admission.ts`。尚无“暂存并让下一项先做”的专用管理入口、让位审计与回复后排队尾闭环。现有 enqueue 对 active 条目直接返回，不构成让位。可独立实现显式让位与队尾恢复，须同时修正目前仅允许 active membership 续做的准入，补 A 等待→B 执行→A 回队尾的 SQL/HTTP 竞争回归。开发已授权，实际改变生产队列另行授权。

8. **维护预检**。已实现两层判断。`domains/platform-claims/model.ts` 的排空不因 waiting_human 标签单独阻塞，pending/unknown 效果仍阻塞。`schema-rebuild.ts` 的 `readActiveJobs` 仅对 ready、可信退出/回收、最新 interrupted owner、无效果/旧 grants/worker 与设备 lease 的等待豁免，`platform-upgrade-schema-plan.ts` 复用它。封存 blocked 或缺证据的等待仍阻塞。该豁免有代码，未找到覆盖人工断点完整组合的专项重建回归，可独立补 fixture。文件/blob 在目标副本可读与 hash 正确不由数据库预检证明，实际维护执行不在本次授权内。

9. **工作文件完整恢复**。已实现有界普通文件的路径/大小/hash manifest、受管秘密阻断、危险链接/特殊文件拒绝、进程停驻和内核目录变更监视，恢复重新校验 blob 并写入原相对路径。已 ACK 附件单独累积。依据 `human-checkpoint-files.ts`、`human-checkpoint-process.ts`、`human-checkpoint-mutation.ts`。尚未保存执行权限、空目录等文件系统属性，也没有任务级“必需文件清单”证明被排除的文件对续做不必要。当前不能宣称完整文件系统原样恢复。普通文件权限保全及真实宿主多文件往返可独立补，放开私有控制目录或秘密保存需要新边界设计。

10. **断点过期、损坏与跨副本**。已实现 30 天先标 blocked 再删、文件缺失/hash 错误拒绝，泵循环保留明确 blocker，旧回复已保存。未提供跨副本 blob 复制或任意保留期后恢复保证，现有本地 BLOB_DIR 读取失败会阻断。可独立补多副本不可见与删除/读取竞争夹具，存储部署调整和真实删除另行授权。

11. **设备与资源**。正常 Dispatcher finally 释放设备租约，恢复准入拒绝残留 pending/active device lease，后继仍走原 provision/设备准入。依据 `dispatcher.ts`、`human-continuation-admission.ts`。暂无人工等待→设备释放→版本变化→重新准入的专用全链证据，可独立补可控执行端夹具。真实设备接管或实际外部操作另需授权。

12. **可读请求、API 和界面**。已实现独立于首批事件分页读取最新完整人工事件，终态历史不提示继续等待，回复先保存与后续阻塞区分，原请求 guidance 直读。依据 `job-human-request.ts`、`domains/platform-api/completion-state.ts`、`apps/web/src/JobHumanRequestPanel.tsx`。补充回复的专用编辑/有序恢复体验仍未交付。完整请求历史按 request_id 列表/直读契约与全部 blocker 的用户可读说明仍需逐项补齐，不能由最新请求详情推定已经完成。

13. **完整工程验收**。已接正常请求→封存→销毁→晚回复→文件恢复→inbox→ACK→合法完成的 SQL/HTTP/可控 RuntimeHost 链，以及既有文件/进程回归。尚缺 issue 要求的固定原生 CLI 跨沙箱人工续做、历史新 Job 预算根、FIFO 让位、完整文件属性与维护人工等待专项链。全部在 GitHub Actions 执行。真实模型理解/恢复率、生产重跑、部署与历史失败任务操作均未验证。

后续可独立切片依次为原生恢复能力/导入验证、历史新 Job 预算根、FIFO 显式让位、文件属性与维护/设备恢复夹具。当前 PR 仅交付累计文字历史保全，不能据其 CI 全绿关闭完整 issue。涉及新增安全边界或预算授权的未决设计先给可审查方案，现有权限内的实现与隔离验证继续由 Agent 负责。

## 项目队列显式让位（#1074 第 8 节）

默认人工等待保留席位。用户可在项目队列显式暂存让位，限单一已安全封存的人工等待。回复持久保存事务内原子回队尾一次，保留原完成代际。未轮到、项目暂停或其他任务仍 active 时只保存回复；轮到后沿原断点、授权、退出、效果和预算准入创建唯一后继。状态、API 与验证边界见[队列专题](PROJECT_TASK_QUEUE.md#人工等待显式让位1074)。
