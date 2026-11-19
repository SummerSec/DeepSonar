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
- `queue-operation` 无 content 的固定 enqueue/dequeue 可省略。含正文的 enqueue 仅在单一排队提示依次出现 dequeue、正文完全相同的后续 user 记录时视为已消费。未消费、正文不一致、重叠排队或未知操作返回 `unverified_queued_prompt` 使用 structured，保留原始归档供核查。
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

## 回复、准入与运行

沿用 POST /canvases/:id/messages（tasks:write 与原项目隔离），target.kind=request 必须携带 request_id 和 expected_revision，message_id 是客户端幂等 UUID。相同 ID/目标/版本/正文/附件返回原消息，改正文或附件返回 409；旧版本或其他请求不能解除新一轮等待。

回复先保存为 answered，返回 202/reply_state=reply_saved。即使准备中、暂停、缺文件或预算不足，回复仍持久存在，不要求重复输入。202 只证明保存，UI 通过 human_continuation 和 execution_state 展示后续阻塞。generic job/hub 消息和「忽略」都不能直接恢复 waiting_human。

既有 reconciliation 有界公平轮转扫描 answered 请求，核文件、旧执行退出/回收、最新 Attempt、冻结身份、目标实时授权、FIFO 席位、任务暂停、全部效果/用量和累计预算。全部通过才在同一 Canvas→Job→Attempt→请求事务写 Scheduler-owned human_continuation 事件、唯一下一 attempt_no 并转 pending。有 rejected-completion root 时还用原 repair_generation 授权精确新 owner，保持原 deadline 和额度；无 root 仍有独立续做归属事件。

Dispatcher 在 provision 和 agent_run 前再核对确切 successor 与文件；开始前重新核冻结身份，目标授权仍走现有实时门。取消、过期、文件丢失或 owner 漂移不能空白启动。原 token 被撤销，旧执行不能收到新请求的回复。新执行通过原 inbox 注入消息并显式 ack_human_message；已保存、已注入、已 ACK 与已完成分别记账，注入 unknown 不自动再发。

structured 模式恢复验证后的业务文件、原问题、用户回复和有界文件索引，再依既有 Hub/Canvas 按需读取当前事实/计划。满足上述受限条件的 Pi/Claude 可导入主会话文字，DSH 使用 structured。只有新执行的合法完成门和结算证明完成。

启动提示只携带待处理回复的引用与状态，正文只经 inbox 投递，unknown 投递不从启动提示旁路再发。已 ACK 的历史可作为只读上下文供显式后继恢复使用，不再次投递。同 Job 累计已 ACK 的不可变附件单独校验并恢复到各消息原 inbox 路径，启动索引列出这些历史输入；上限 256 个、单文件 8 MiB、总计 64 MiB，超限明确阻断，不静默丢弃较早轮次输入。待处理回复附件仍只随原投递入口提供。完成门要求当前回复已 ACK，否则返回可修正反馈；已知失败后的单 Job resume 重核原断点并追加下一 owner，不被首次 target_attempt_no 永久锁定。更换配置和任务批量恢复不能绕过断点身份门。

## 预算与边界

有效执行时间由 job_execution_clocks 从首个受理 human 的原运行区间累计；可信回收且在途 Gateway 效果/用量结算后暂停，等待期间仍有未决模型调用则保守继续计时。资源释放后的时钟收敛独立于回复，以持久化的退出、回收与最后 Gateway 结算/用量观察时间的较晚值关闭区间；用户尚未回复、轮询延迟或 Scheduler 停机不会在结清后额外扣时。jobs.started_at 保留本次实际开始时间用于停滞检测，execution_deadline_at 单独保存原剩余有效时间与 repair 硬期限的较早值；Control token、Gateway、完成/Plan 门与 Reaper 共同使用它。排队和纯人工等待不耗有效执行时间，重复清理不重复扣时。请求数、主/repair token、修正次数与 Plan lifetime 沿原账本，unknown 不按零消耗，原 repair deadline 不延长。

封存等待保留当前 FIFO 占位，不占活跃执行槽。暂停/取消/归档和授权撤销仍由既有门控制。普通 failed 历史无合法新断点不自动续做。历史失败关联新 Job、FIFO 让位和文件权限恢复由独立切片验收，补充回复的专用编辑体验仍为剩余范围。

## 注意力成本与验收

维护预检直接重核断点过期时间，避免后台清理尚未执行时把已过期的 ready 记录当作可安全维护的等待任务。隔离 PostgreSQL 回归覆盖合法封存、过期窗口、退出证明缺失、沙箱残留、未决效果、旧 Control token 与新 Attempt 归属，接既有 `pnpm ci:unit:migrations`。本次最终 SHA 的 Actions 待验。

| 触发 | 用户看到 | 需要的动作 | 失败反馈 |
| --- | --- | --- | --- |
| 当前请求 open | 完整问题、保存状态、超时仍可答 | 原位置回复一次 | 保存失败保留草稿与幂等 ID |
| 回复已保存但未准入 | 已保存及固定 blocker | 修复所指条件 | 不要求重新粘贴回复，不承诺已运行 |
| 历史终态请求 | 只读问题及历史 | 无恢复按钮 | 不把历史接受当当前权限 |

本片回归接既有 Actions 的 ci:unit:bounded-contexts、ci:unit:web-facts、ci:integration:platform-api 和恢复/生命周期套件；同时核 OpenAPI、schema、文件体量与文档保鲜。仅 Actions 执行测试/build/typecheck；本地只静态核对和 git diff --check。HTTP/PG 与可控 RuntimeHost 支撑工程状态机证据，不证明真实模型理解、原生恢复率、生产效果或 SLA。

## 项目队列显式让位（#1074 第 8 节）

默认人工等待保留席位。用户可在项目队列显式暂存让位，限单一已安全封存的人工等待。回复持久保存事务内原子回队尾一次，保留原完成代际。未轮到、项目暂停或其他任务仍 active 时只保存回复；轮到后沿原断点、授权、退出、效果和预算准入创建唯一后继。状态、API 与验证边界见[队列专题](PROJECT_TASK_QUEUE.md#人工等待显式让位1074)。
