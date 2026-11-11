# 人工等待的断点与续做（#1074）

> 状态：as-built 代码契约；最终提交的 GitHub Actions 验收另验
> 同步日期：2026-11-12
> 需求：FR-JOB-008、FR-CTRL-006；决策：[ADR 0022](architecture/adr/0022-human-continuation.md)

人工等待超过响应阈值只记 overdue，Job 保持 waiting_human。有权限的用户可在 Job 详情读取完整问题并「回复并继续」。2026-11-11 的两个历史 failed Job 不自动复活，也不据历史回执重放外部效果。此实现不部署现场，不更换用户运行配置。

## 持久记录与封存

schema 73 新增 human_requests 和 job_execution_clocks；human_messages 以 request_id/request_revision 精确关联请求。human 事件、请求、waiting_human 和 preparing 意图在同一原语义事务保存。历史事件仍不可变；Canvas 节点和 UI 不是恢复 authority。

真实执行在 CLI 退出后、Dispatcher finally 销毁沙箱前保存断点。宿主在启动 CLI 前记录 Linux 沙箱 PID/start-time 基线，封存时排除宿主命令及祖先进程，暂停观察到的本轮新进程。另以 Linux inotify 在发现文件候选前建立目录监视，覆盖整个扫描/读取区间；修改、新文件、目录变化、事件溢出或监视失效均阻断本次保存，不把有限 PID 扫描本身当作一致性证明。复制后只有监视明确通过、所有 hash 核对且原沙箱可信销毁后才可 ready。仅适用于隔离 Linux 沙箱，不提供主机进程扫描入口。

文件先扫描路径、大小和 SHA-256，再读取并核对。符号链接目录、硬链接与特殊文件拒绝；平台注入文件、控制目录、CLI 私有配置、凭据缓存与敏感路径不保存。与已知受管秘密匹配的文件阻断封存；这不保证任意用户文件不存在未知秘密。上限为 256 文件、单文件 8 MiB、总计 64 MiB，封存 60 秒超时。hash 寻址文件保存到已有 BLOB_DIR 下 human-checkpoints/request_id/hash，读取必须重新校验，跨副本不可见不视为空恢复。

manifest 绑定 Job、Attempt、请求、冻结快照摘要和 structured 模式。销毁沙箱必须由原 worker/Attempt 精确归属证明；随后原子撤销旧 Gateway/Control grants、结算确切 agent_run、记录 process_exited_at/resources_released_at、关闭旧 Attempt 为 interrupted 并暂停有效执行时钟，Job 保持 waiting_human。失败提交保留原 owner/effect/lease，现有恢复循环重核，不用 interrupted 反推销毁成功。未决的其他外部效果不被这一步结算。

Dispatcher 正常 finally 立即回收等待资源；重启后现有 reconciliation 在 manifest 可用、封存 blocked 或准备超过 90 秒时执行相同回收。保存失败也有界回收并保留具体 blocker；不无限保留沙箱。设备租约/共享资产沿既有 finally 和 Reaper 清理。waitingHumanSec 的 0 关闭 overdue 计时；它不关闭必要的有限封存/资源清理。

断点保留 30 天。现有循环在删除文件前先持久标记 HUMAN_CHECKPOINT_EXPIRED，删除失败继续重试，不能保持 ready 后静默删文件。请求和历史证据不随断点文件过期而抹除；无法续做时明确显示原因。

## 回复、准入与运行

沿用 POST /canvases/:id/messages（tasks:write 与原项目隔离），target.kind=request 必须携带 request_id 和 expected_revision，message_id 是客户端幂等 UUID。相同 ID/目标/版本/正文/附件返回原消息，改正文或附件返回 409；旧版本或其他请求不能解除新一轮等待。

回复先保存为 answered，返回 202/reply_state=reply_saved。即使准备中、暂停、缺文件或预算不足，回复仍持久存在，不要求重复输入。202 只证明保存，UI 通过 human_continuation 和 execution_state 展示后续阻塞。generic job/hub 消息和「忽略」都不能直接恢复 waiting_human。

既有 reconciliation 有界公平轮转扫描 answered 请求，核文件、旧执行退出/回收、最新 Attempt、冻结身份、目标实时授权、FIFO 席位、任务暂停、全部效果/用量和累计预算。全部通过才在同一 Canvas→Job→Attempt→请求事务写 Scheduler-owned human_continuation 事件、唯一下一 attempt_no 并转 pending。有 rejected-completion root 时还用原 repair_generation 授权精确新 owner，保持原 deadline 和额度；无 root 仍有独立续做归属事件。

Dispatcher 在 provision 和 agent_run 前再核对确切 successor 与文件；开始前重新核冻结身份，目标授权仍走现有实时门。取消、过期、文件丢失或 owner 漂移不能空白启动。原 token 被撤销，旧执行不能收到新请求的回复。新执行通过原 inbox 注入消息并显式 ack_human_message；已保存、已注入、已 ACK 与已完成分别记账，注入 unknown 不自动再发。

本片使用明确的 structured 新会话：恢复验证后的业务文件、原问题、用户回复和有界文件索引，再依既有 Hub/Canvas 按需读取当前事实/计划。CLI Session 仍按现有机制归档作证据，**未实现 Pi/Claude/DSH 原生会话恢复**，不声称跨进程 Session 原样续接。不得重放已接受业务效果；只有新执行的合法完成门和结算证明完成。

启动提示只携带待处理回复的引用与状态，正文只经 inbox 投递，unknown 投递不从启动提示旁路再发。已 ACK 的历史可作为只读上下文供显式后继恢复使用，不再次投递。完成门要求当前回复已 ACK，否则返回可修正反馈；已知失败后的单 Job resume 重核原断点并追加下一 owner，不被首次 target_attempt_no 永久锁定。更换配置和任务批量恢复不能绕过断点身份门。

## 预算与边界

有效执行时间由 job_execution_clocks 从首个受理 human 的原运行区间累计；可信回收且在途 Gateway 效果/用量结算后暂停，等待期间仍有未决模型调用则保守继续计时。资源释放后的时钟收敛独立于回复，以持久化的退出、回收与最后 Gateway 结算/用量观察时间的较晚值关闭区间；用户尚未回复、轮询延迟或 Scheduler 停机不会在结清后额外扣时。jobs.started_at 保留本次实际开始时间用于停滞检测，execution_deadline_at 单独保存原剩余有效时间与 repair 硬期限的较早值；Control token、Gateway、完成/Plan 门与 Reaper 共同使用它。排队和纯人工等待不耗有效执行时间，重复清理不重复扣时。请求数、主/repair token、修正次数与 Plan lifetime 沿原账本，unknown 不按零消耗，原 repair deadline 不延长。

封存等待保留当前 FIFO 占位，不占活跃执行槽。暂停/取消/归档和授权撤销仍由既有门控制。普通 failed 历史无合法新断点不自动续做；历史失败关联新 Job、原生 Session 继续和补充回复的专用编辑体验是剩余范围，不冒充本片已交付。

## 注意力成本与验收

| 触发 | 用户看到 | 需要的动作 | 失败反馈 |
| --- | --- | --- | --- |
| 当前请求 open | 完整问题、保存状态、超时仍可答 | 原位置回复一次 | 保存失败保留草稿与幂等 ID |
| 回复已保存但未准入 | 已保存及固定 blocker | 修复所指条件 | 不要求重新粘贴回复，不承诺已运行 |
| 历史终态请求 | 只读问题及历史 | 无恢复按钮 | 不把历史接受当当前权限 |

本片回归接既有 Actions 的 ci:unit:bounded-contexts、ci:unit:web-facts、ci:integration:platform-api 和恢复/生命周期套件；同时核 OpenAPI、schema、文件体量与文档保鲜。仅 Actions 执行测试/build/typecheck；本地只静态核对和 git diff --check。HTTP/PG 与可控 RuntimeHost 支撑工程状态机证据，不证明真实模型理解、原生恢复率、生产效果或 SLA。
