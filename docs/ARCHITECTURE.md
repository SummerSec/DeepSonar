# DeepSonar 项目方案（优化版）

> 版本：v1.1+（持续与代码对齐）  
> 日期：2026-07-31 起稿 · **2026-08-13 状态：as-built 主路径以本地库 / Web 建项目任务为准**  
> **阅读**：产品摘要先读仓库根 `DESIGN.md`；本文件为架构细则。冲突时以 **代码 + schema + OpenAPI + DESIGN** 为准。  
> 文档目录索引：[`docs/README.md`](README.md)。

**一句话（as-built）**：以**本地库为管理真相**（Web 直接建项目/任务；Plane 为**可选**集成），以任务画布为过程真相，以一次性沙箱为执行真相，以调度器为唯一副作用执行者；多角色 Agent 只提案，系统落地与记账。

> 下文部分章节仍保留早期「Plane 为主」叙述，仅作演进背景；**不要**再按「必须先接 Plane」实施。

---

## 1. 问题与目标

### 要解决什么

- 同时跑多个**代码扫描 / 白盒审计 / 验证**项目，需要统一看进度
- 单次运行过程（发现了什么、验没验、卡在哪）需要**可追溯的过程数据**，而不是只在聊天记录里
- Agent 需要能**派生下一步**（审计出洞 → 自动/半自动派验证），但不能失控乱起进程、乱建资源

### 非目标（第一期不做）

- 不做完整商业级红队平台 / 报告中心
- 不做全局一张超级画布
- 不让任意 Worker 直接操作 Docker / 直接改 Plane / 直接建画布
- 不一次接入所有 CLI（先 1 个）
- 不做多 Scheduler 实例横向扩展（单实例 + 数据库约束即可，见 §16）

### 成功标准（MVP）

1. 在 Plane 建一个审计项目 + 若干 Work Item，能被系统领取并跑完
2. 每个项目有一张画布；运行过程在画布上形成「任务节点 → 发现节点 → 验证节点」链
3. 审计 Agent 产出结构化 finding 后，系统能派生验证任务并写回同一张画布
4. 全程有并发限制、超时、失败可查；**调度器或沙箱崩溃后任务不悬挂**

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────┐
│  Plane（项目管理真相）                                      │
│  Project / Work Item / 状态 / 优先级 / 给人看的进度          │
└──────────────────────────┬──────────────────────────────┘
                           │ Webhook 或 轮询
┌──────────────────────────▼──────────────────────────────┐
│  Scheduler（调度与纪律）                                    │
│  队列 · claim · 限流 · 状态机 · Reaper · 规则引擎 · 回写     │
└───────┬─────────────────────────────┬───────────────────┘
        │ 起沙箱/跑 Agent              │ 结构化事件
┌───────▼──────────┐         ┌────────▼─────────┐
│  Runtime         │         │  Canvas Service  │
│  agentbox 沙箱    │         │  每项目一张画布   │
│  + Claude Code   │         │  节点/边/事件     │
└──────────────────┘         └──────────────────┘
```

### 四层职责（团队共识）

| 层 | 职责 | 不做 |
|----|------|------|
| **Plane** | 多项目、任务是否该做、完成与否、负责人 | 不存攻击图细节 |
| **Canvas** | 过程、发现、验证链、状态流转可视化 | 不负责起 Agent |
| **Scheduler** | 领任务、限流、起沙箱、执行提案、判超时、回写 | 不做业务推理 |
| **Agent** | 审计/验证等专业工作 + 调用白名单工具提案 | 不直接碰基建、不做派生决策 |

原则：

> **Plane = 管理真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**

---

## 3. 核心概念模型

### 3.1 实体关系

```
Plane.Project  1 ── 1  Canvas
Plane.WorkItem 1 ── * Job（调度任务，可重试）
Job            1 ── * Event
Job            1 ── * Canvas.Node（或一组节点）
Finding        * ── 1 Canvas.Node
Finding        可派生  Followup Job（verify 等，由规则引擎决定）
```

### 3.2 画布约定

- **每项目一张画布**（创建 Plane Project 时一并创建）
- **每次 Job** = 画布上的一个分组 / 子图，不是新画布
- 节点类型固定：

| node_type | 含义 |
|-----------|------|
| `root` | 项目根（目标、仓库、范围） |
| `job` | 一次运行（审计模块 / 验证…） |
| `finding` | 可疑/确认问题 |
| `note` | 过程说明 |
| `human` | 需人工 |

边类型：`child` / `produces` / `verifies` / `next`

**布局纪律**：节点坐标由**服务端 auto-layout 分配**——分层 DAG 布局用 **elkjs**（比 dagre 更适合"链 + 分支"结构），坐标在节点落库时算好写入 `canvas_nodes.x/y`。Agent 不能提案坐标；画布布局不在 Agent 权限内。前端只读渲染（`nodesDraggable=false`）。

#### 人工消息投递与两阶段 ACK

画布允许人类向 Hub 或 active `intent` / `job` / `report` 节点发送文字与多文件，但消息账本不是拓扑本体：`human_messages` 与 `human_message_attachments` 持久化原始正文、目标、不可变资产版本及投递状态；服务端另建 `human` 节点用于过程可视化，Web 的状态 panel、target badge 和详情均由独立 `GET /canvases/:id/messages` 轮询派生，不把消息字段合并进 L0/L1 topology 数据。

附件先通过项目共享资产 API 上传，key 使用消息 UUID 命名空间和安全文件名；只有整批上传成功，才用所有 `version_id` 创建消息。运行时校验 blob 摘要/字节数后，将不可变版本写入 `/workspace/.deepsonar/inbox/<message-id>/` 动态收件箱，再把正文、附件路径与显式 ACK 要求注入目标会话。部分上传失败不创建残缺消息；已上传资产留在项目资产账本中供审计。

投递语义是明确的两阶段协议：

1. `injected`：运行时已写入附件并把文字注入会话，UI 文案固定为“已注入会话，等待 Agent 确认”；这不是已读或已处理。
2. `acknowledged`：目标 Agent 通过受治理的 `ack_human_message` operation 显式确认，服务端记录 `acknowledged_at` 与可选 `ack_summary`，UI 才显示“Agent 已确认”。普通自然语言输出、Session 文本、节点状态和文件访问均不能推断 ACK。

`planned`、`unknown` 与 `failed` 保留真实未决/不确定性。消息发送和投递效果遵循 `replay_policy=never`：前端不静默重试 POST，Scheduler/重启恢复也不自动重放未知效果；再次发送必须由人类创建新的 message UUID。

### 3.3 Job 状态机与 Lease

```
pending → claimed → provisioning → running → succeeded
                                ↘ failed / timeout / cancelled / orphan
```

**Lease 机制（防悬挂，核心纪律）：**

- Job 进入 `running` 时写入 `lease_expires_at = now + LEASE_TTL`（默认 120s）
- 调度器经沙箱控制通道（agentbox-sdk）探测存活并续 lease；进程/通道断开即停续
- **Reaper**（调度器内置定时任务，默认每 30s 扫描）：
  - 发现 `status=running 且 lease_expires_at < now` → 标记 `orphan` → 强制销毁沙箱 → 按重试策略重入队或转 `failed` → 回写 Plane
  - 发现 `运行时长 > timeout_sec` → 标记 `timeout` → 同上回收
- **超时与孤儿由调度器判定，不信任 Agent 自报**。harness 上报 `done/failed` 是善意路径，Reaper 是兜底路径

### 3.4 Job Attempt、效果账本与启动恢复

`jobs` 是宏观生命周期，`job_attempts` 是一次具体执行的 Scheduler-owned 程序计数器。领取时在同一事务锁定 Job 并创建活动 Attempt，数据库部分唯一索引保证同一 Job 只有一个活动 Attempt。Attempt total state 只保留 phase、快照身份、资源/会话身份、取消标记和有界结果，不接受 Agent 直接写入。

每个可能产生外部副作用的动作都在 `job_attempt_effects` 记录 effect kind/id、intent、输入摘要与 `effect_pending`，观察到结果后写 settlement；所有 effect id/kind、JSON、错误文本均由应用层执行低基数和大小校验。默认 replay policy 为 `never`，进程崩溃或响应不确定时只能收口 `unknown`，不能凭 Promise 或重启自动重放。只有明确声明幂等的销毁动作可使用 `safe`。

provision 的 AbortSignal 和 runtime cancel 必须终止外部创建；取消事务先提交 Job/Attempt 终态，随后通知当前进程的 provision 句柄。dispatcher 在调用 provider 前再次校验 Job 仍为 `provisioning`，runtime 在安装 abort listener 后立即重检 signal，避免取消落在句柄注册或监听安装窗口时丢失。资源身份、效果 settlement 与 `jobs.sandbox_id` 在同一个数据库事务落账。Job 终态和 Attempt 终态也在同一事务提交。启动 reconcile 只将“Attempt 为 preparing 且没有效果记录”的 Job 重排；其余 provision 未知窗口标记 orphan，清理容器、共享卷、短期 Token、画布/报告和 Plane，避免重复创建。

启动 reconcile 对 running role Worker 采用批量恢复边界：生命周期层先把同次扫描命中的
Worker 全部置为 `orphan` 并收口旧 Attempt，资源与 Token 仍立即销毁，但不在启动阶段逐个
调用画布终态推进，因此不会生成一个时间更新的 Hub 抢占恢复入口。人工调用
`POST /tasks/:canvasId/resume-session` 且画布无活动 Job 时，Scheduler 先选出该画布全部
`scheduler_restart` / `provision_effect_unknown` 的 role Worker，按原 Job ID 原子状态机边
重新入队；Dispatcher 领取时创建下一 Attempt。旧 Attempt 与 `unknown`、
`replay_policy=never` effect 不修改、不自动重放。没有该批次时，入口才沿用单 Job 恢复或
显式 Hub 唤醒，并用响应 `action`、`jobs[]` 告知实际动作。

Issue #202 将“旧快照恢复”与“按当前配置重跑”拆成两个确定性动作。`POST /jobs/:id/resume`
只使用 Job 创建期冻结快照重新执行（同 Job ID、新 Attempt）；它仍解析当前完整配置，但只
比较受治理运行身份：CLI selector/上游模型、Credential ID/provider、runtime adapter
ID/version、DSH 模式、reasoning/context budget 与 runtime image key/digest/contract。
RoleConfig version、时间戳、catalog/content hash 和共享资产 revision 等非身份字段不参与
漂移判断。身份不同或当前配置无法解析时返回 `409 SNAPSHOT_STALE`，不得静默运行旧模型。
`POST /jobs/:id/rerun-current` 则在 Dispatcher claim admission advisory lock 下按
Canvas→Job 行锁顺序，复用 `resolveAgentSnapshotForJob`、任务网络策略与共享资产选择完整
重冻 `agent_snapshot_json`，随后原子转 `pending` 并只通知一次。两条动作都只接受
`failed/timeout/orphan/waiting_human`，清理 sandbox/lease/timestamps/error，保留
payload/parent/canvas、Intent/Fact/Finding 及旧 Attempt/effect；waiting_human 的旧活动
Attempt 收口为 interrupted，未确认 effect 保持 unknown，绝不跨沙箱续接 Session。
任务 `resume-session` 的启动中断批次与单 Job 默认沿用旧快照；任一 stale 时整批无副作用
拒绝并返回完整 `job_ids`，由操作者逐 Job 选择 `rerun-current`。

Issue #199 后，容器与共享资产卷另有不依赖 autoRemove 成功与否的周期 desired-state 对账。Agentbox destroy 先尝试 SDK 删除，但最终必须按容器 ID 执行单次 120 秒、最多 5 次的指数退避 force remove；只有 Docker 明确返回 no-such 才是幂等成功，其他错误必须抛给调用方并计指标。启动 reconcile 和 Reaper 运行期都从 DB 的 `claimed/provisioning/running` Job 与 active Attempt 推导应保留集合，不增加清理表；容器只接受同时具有 canonical UUID `deepsonar.job` / `deepsonar.attempt` 的双标签，卷只接受严格 `deepsonar-assets-<canonical Job UUID>` 名称并复核 local driver/scope 与可选受管标签。对账防重入，失败资源留到下一轮继续重试。任何 broad prune、仅凭模糊前缀删除容器或删除非 DeepSonar 资源均被禁止。

### 3.4 Agent 工具白名单（只提案）

| 工具名 | 谁可调用 | 调度器落地动作 |
|--------|----------|----------------|
| `emit_progress` | Worker | 更新 job 节点文案/进度 |
| `emit_fact` | Hub 可下发的非审计工作角色 | 增量建立 fact 节点与意图边 |
| `emit_finding` | audit Worker | 增量建立 finding 节点 + 落库（可带 `suggest_verify` 建议字段） |
| `submit_hub_decision` | hub_reason | 提交 complete 或 intents 提案 |
| `mark_job_done` | Worker | 结束节点 + 摘要 |
| `request_human` | Worker | 提交结构化 Finding 或平台阻塞 subject；Scheduler 校验后将 Job 转人工等待并建立 human 节点 |

**明确不在 Agent 权限内**（v1.1 收紧）：

- 派生验证的**决策**：`emit_finding` 只能携带 `suggest_verify: true/false` 建议，是否派生由调度器规则引擎唯一决定（见 §4.3）
- 画布节点坐标与布局
- `create_canvas` / `docker.*` / `plane.set_state`（状态由调度器在 claim/finish 时统一写）

---

## 4. 主流程（可执行路径）

### 4.1 项目初始化

> **本地库为唯一真相，Plane 为可选集成。** Web 直接创建：`POST /projects`（plane_project_id 可空）→ `POST /projects/{id}/tasks`（同事务建任务画布 + root + pending job）。

1. 默认：在 Web「项目」页新建本地项目（或 `POST /projects`）
2. 可选：在项目「设置 → Plane 集成」绑定 Plane Project；绑定后 Ready 状态的 issue 只需标题和自然语言描述即可被认领
3. 创建任务：Web 表单、`POST /projects/{id}/tasks`、Plane Ready issue，或 `POST /projects/{id}/events` 外部事件；所有入口都先创建 `hub_reason` Job

### 4.2 调度循环（MVP）

```text
loop:
  1. 任务入队：人工任务、Plane Ready issue 或幂等外部事件 → hub_reason 决策中枢
  2. 原子 claim（DB advisory lock 串行化配额判断）→ 读取 `global_settings.effective_rules` 的全局/每项目 cap，再按“Provider → Credential → Model ID → Agent CLI”检查资源配额 → 写 jobs 表 → pg_notify('deepsonar_jobs') 事件唤醒 dispatcher；规则更新也会 notify，后续 claim 热生效
  3. Canvas：创建/更新 job 节点（running）
  4. Runtime：起沙箱（agentbox-sdk），注入任务包、静态控制 Skill 与冻结 API operation allowlist
  5. 启动冻结的 Agent CLI；文本流经 Runtime Adapter 回传，语义事件经 Job 级控制 API 回传，调度器维护 lease
  6. 结束（正常回调 或 Reaper 判定超时/孤儿）：销毁沙箱；绑定了 Plane 的 job 尽力回写（失败只告警，不改本地终态）；Canvas 节点定格
  7. Hub 派发 audit 等角色；达到 `minVerifySeverity` 或未评分/未知 severity 的 Finding 自动进入多轮 verify，rework 强制回弹 Hub 补证；每条 Finding 进入 `confirmed` 时独立生成版本化 Finding Report；验证范围内 Finding 收敛为 confirmed/needs_human 后生成版本化任务总 Report
```

Canvas 级任务暂停是独立于 Hub convergence 和项目并发配额的 claim admission。控制对象保存在
`canvases.target_json.execution_control={paused,paused_at,paused_by,reason}`，不增加定列。
pause/start 事务先 `FOR UPDATE` 锁 Canvas；Dispatcher 对候选 Job 再以 `FOR SHARE` 锁定并重读
同一 Canvas，因此多 Scheduler 进程不会越过已提交的暂停门。暂停不取消沙箱或篡改 Job 终态：
`claimed/provisioning/running/waiting_human` 继续安全收尾，派生工作可作为 durable `pending`
保留但不能 claim。start 只清执行门禁并通知 `deepsonar_jobs`；不修改 `target_json.schedule`，
不把 failed/orphan/cancelled 恢复为 pending。只有本次确实解除暂停且无 pending/活动工作时，
才复用 Hub Canvas 锁与活动 Hub 去重门补一次仍有资格的 Hub。

### 4.3 审计 → 验证链（单一决策点）

1. `hub_reason` 根据目标派发 `audit` 等角色，审计角色输出结构化 Finding
2. Finding 只是待证实假设；Scheduler 按 `minVerifySeverity` 决定自动验证范围，低于阈值的不派生 Verify，且 Hub 对该 Finding 派发 review/test 会在任何 Job/节点副作用前稳定拒绝；缺失或未知 severity 保守验证，设置为 `info` 即严格全量模式
3. 派生前按 `fingerprint` 去重；Hub 的 review/test 若引用 Finding，必须只引用一个同画布 canonical Finding 节点，Scheduler 据此冻结 `jobs.finding_id` 与 `verification_followup`。多 Finding、映射歧义或 Verify trigger 错配使整次 Hub 决策回滚；analyze/explore 可保留多来源引用
4. 同一 Finding 同时最多一个活跃 verify，但允许在 Hub 补证后创建下一验证轮次
5. 调度器创建 verify Job，输入 = Finding 快照 + 与硬门同源的冻结 review/test 证据快照；画布只作辅助上下文
6. Verify Worker 只提交 `confirmed` / `rework` / `needs_human` 提案（兼容输入 `false_positive` 映射为 rework）；Scheduler 检查独立 review、完整 test、来源 Job 与冲突后才可写 confirmed
7. `rework` 或 Verify 失败强制回弹 Hub，且补证只派发 review/test；`confirmed` 可触发影响验收。
8. 验证范围内 Finding ∈ `{confirmed, needs_human}`、画布无活跃工作且 Hub complete 后，Scheduler 按确定性输入摘要派发任务总 Report。`task_reports` 以 `(canvas_id, version)` 版本化并限制每个画布最多一个活动版本；相同成功输入幂等，输入变化时追加版本，失败同输入重试复用版本。每版输入与产物写入独立 `vN` 目录，API 默认读取最新版本并提供历史列表。任务报告汇总全部 Finding，低于阈值项明确列为未自动验证，`needs_human` 保留在待人工章节，SARIF 仅包含 `confirmed`。
9. 每条 Finding 写入 `confirmed` 时，Scheduler 在独立 Report Job 路径派发 Finding Report：输入冻结为 `report-input.json` 并记录 SHA-256，`finding_reports` 以 `(finding_id, version)` 版本化且 `pending/generating` 期间只允许一个活跃版本。`POST /findings/:id/report` 可手动刷新/重试并创建下一版本；生成失败只标记报告失败，不回退或修改 Finding 状态。两条报告轨道互不替代。

### 4.4 Scheduler bounded contexts（Issue #37）

Scheduler 的领域代码通过 application/ports seam 拆分，PostgreSQL 仍是唯一执行状态权威；终态/恢复调用方把已开启的事务 client 传入 application，application 不自行开启嵌套事务，也不改变外层锁顺序。人工评论入口由该 bounded context 自己拥有一个明确的外层事务。六个执行领域为：

- `domains/job-lifecycle`：Job 状态迁移、claim、恢复、取消与重试的 CAS 写入；
- `domains/event-ingestion`：event envelope 校验、幂等、`job_seq`、固定窗口限流，以及由显式 ports 组合的 progress/fact/finding/Hub decision/done/human 语义副作用；
- `domains/hub-orchestration`：Hub 资格判断、证据快照 edge-trigger、idle/terminal 推进、人工评论唤醒、`maxHubRounds` 收口；
- `domains/finding-verification`：Finding 派生、证据附着、verification round、完成门与 rework/needs_human/confirmed 收口；
- `domains/report-convergence`：analysis complete 后的任务报告、Finding 报告、输入冻结与失败恢复；
- `domains/role-runtime-snapshot`：RoleConfig、Credential/CLI、skill/shared asset 与 runtime image 的建 Job 时冻结。

Hub 的每次资格检查先锁 `canvases`，再读取/锁定 waiting verification round；同一事务内才会写入 Hub Job、节点和 `next` 边。失败 Hub 会清除等待证据的 edge marker 并停在人工恢复边界，不递归生成相同快照的 Hub。`maxHubRounds` 只统计 `hub_reason.status = succeeded`，耗尽时复用 Verify 完成门；未通过完成门则设置 `auto_stopped`，不派发空图 Report。

`event-ingestion` 先解析目标 Canvas，按 Canvas → Job → 事件历史/领域记录的顺序加锁，并在同一事务中完成 dedup、`events` append 和语义副作用；任何校验或下游 service 失败都会连同配额与副作用整体回滚。Finding/Hub/Report/runtime snapshot 变化只通过注入的显式 service ports 发起，不由 event-ingestion 直接取得其他领域的可变全局状态。

`core.ts` 只保留既有调用方所需的兼容 facade、共享规则与 composition root；Hub 与事件副作用实现不再由 facade 承载。Finding verification、Report convergence 与 role/runtime snapshot 通过各自的 application/ports seam 暴露，legacy SQL adapter 仅用于保持既有数据库行为和外层事务边界。HTTP 业务 handler 已全部迁入 `domains/*/routes.ts`，顶层 `routes.ts` 仅安装共享鉴权/项目作用域 hook、Gateway，并组装各领域 registrar。route manifest 同时锁定 Fastify/OpenAPI surface，源码护栏禁止业务 handler 回流顶层。内部 cycle-dodging dynamic imports 已移除，跨域依赖通过静态 import 和显式 adapter 可审查。

**护栏**（同时是防注入措施，见 §9）：

- 每 Job 最大 followup 数 `MAX_FOLLOWUPS_PER_JOB`（默认 60）
- 派生深度上限 `MAX_FOLLOWUP_DEPTH`（默认 12；verify 的结果仍由规则引擎约束，不由 Agent 自行派生）
- 超出验证轮次、派生深度或 Hub 轮次护栏 → Finding 收口为 `needs_human` 并记录 human blocker；随后仍可进入报告的待人工章节

### 4.5 人工介入与恢复

- `request_human` 必须包含 `reason` 与结构化 `subject`。Finding subject 固定为 canonical `finding_id + subject_revision`，Scheduler 在事件事务内校验同项目、同画布及 `minVerifySeverity`；平台阻塞只接受 `authorization`、`credential`、`high_risk_action`、`business_decision` 四类。reason 只用于展示，禁止从自然语言反推 Finding 或绕过规则。校验通过后 Job 才转 `waiting_human`、Plane 标 Blocked 并建立 human 节点
- 人处理完后可调用 `POST /jobs/{id}/resume` 使用旧冻结快照重新入队；当前受治理身份漂移时返回 `SNAPSHOT_STALE`，改用 `POST /jobs/{id}/rerun-current` 按当前配置重冻。两者都是同 Job、新 Attempt，不跨已销毁沙箱恢复 CLI Session
- Finding 详情可调用 `POST /findings/{id}/verify` 强制新建 Verify round，或调用 `POST /findings/{id}/evidence-jobs` 新建绑定该 Finding 的 review/test 补证 Job。两类动作继续受 follow-up 深度、验证轮次、活动任务唯一性与终态约束，不修改历史 Job；若同画布 Hub 正在等待人工，则在同一事务恢复为 `pending`
- 若同画布等待的是 `hub_reason`，Finding 详情也可调用 `PATCH /findings/{id}/verify-status`，且请求只接受 `needs_human`。Scheduler 按 Canvas → Finding → Hub Job 顺序加锁，在同一事务关闭等待证据轮次、写 verification blocker、恢复 Hub 为 `pending` 并 `pg_notify`；`confirmed` 仍只有系统 Verify 能写
- 普通 Worker 的 `request_human` 表示 Job 暂停并等待恢复；Verify 不走该路径，而是用 verdict=`needs_human` 把 Finding 收口为可报告终态

恢复或重启后的每次执行均可在 Job 详情投影 Attempt、effect 和资源身份；`agent_run`、`agent_resume`、`cancel`、`timeout` 的效果记录用于区分可继续的同会话恢复和不可安全重放的未知窗口。

任务级继续入口不承诺跨容器续接 Session。启动中断 role Worker 的动作名为“重新执行中断
Job”：同 Job ID 保留图与审计身份，但使用新 Attempt 和全新沙箱。已销毁容器中的 Session
无法恢复时必须明确展示 capture error，禁止选择 latest、伪造 Session 或把 normalized stream
称为原始 Session。

---

## 5. 模块拆分与技术选型

| 模块 | 实现 | 说明 |
|------|------|------|
| **plane-adapter** | HTTP Client | 拉 Issue、改状态、评论；字段映射 |
| **scheduler-core** | 服务 + Postgres | jobs/events、claim、状态机、限流、Reaper、规则引擎 |
| **runtime-adapter** | agentbox-sdk（TwillAI, MIT） | provision/run/stop/delete；timeoutMs；networkMode 网络隔离；local-docker 起步，可切 e2b/Daytona 云端 |
| **canvas-service** | API + React Flow 渲染 | 节点边 CRUD；auto-layout；只读 WS 推送 |
| **agent-harness** | 沙箱内包装脚本 | 读任务 JSON、调 CLI、把工具调用转成 Event API、心跳 |
| **web-ui** | React + React Flow (@xyflow/react, MIT) | 打开某项目画布；链到 Plane |

### 技术栈（已定）

- **语言：全 TypeScript**。前端 React + React Flow，后端同语言可让 `shared-types`（job/event/finding schema）前后端单源复用，避免跨语言维护两份 schema
- DB：Postgres（`jobs` / `events` / `findings` / `canvas_nodes` / `canvas_edges`）
- 队列：第一期 DB 轮询（`SELECT ... FOR UPDATE SKIP LOCKED`）；量大再 Redis
- 画布：**React Flow（@xyflow/react，MIT）+ elkjs 服务端布局**。不选 tldraw（生产商用需付费授权）与 Excalidraw（canvas2d 无法嵌入 React 组件节点），理由见 §16
- 运行时：**agentbox-sdk（TwillAI，MIT）**——TS SDK，统一 API 驱动沙箱（local-docker 起步，可切 e2b/Modal/Daytona/Vercel）与 Agent（server 进程模式，`approvalMode: "auto"` 权限完全开放，沙箱即安全边界）。Agent CLI 五类可换：**claude-code（默认）/ opencode / codex / pi / dsh**；CLI、model 与非敏感 env_vars 只由 RoleConfig / Agents UI/API 管理，Job 创建时冻结快照，凭据按服务端 Credential 注入。`AGENT_MODE` 仍仅表示 fake/real 基础设施运行模式。事件经 SDK 控制通道回传，**不经沙箱网络**（见 §8）。已知风险：0.1.x 早期项目，靠 runtime-adapter 接口隔离，必要时 fork
- Plane：自托管 Community + API Token

暂不引入 Multica/ClawTeam，避免与 Plane 双看板；接口预留「执行器可替换」。

---

## 6. 数据表（MVP）

```text
projects
  id, plane_project_id, canvas_id, name, config_json, created_at
  -- canvas_id 为历史遗留（旧项目级画布），新项目画布按任务铸造（见 canvases）

canvases                              -- 0002 起：一任务一画布
  id, project_id, plane_issue_id, title, target_json, created_at
  -- 唯一约束: (plane_issue_id) WHERE plane_issue_id IS NOT NULL
  -- 同一 issue 重试复用同一画布；target_json 冻结任务内容、网络/Finding 协议及 kind
  -- compose 另冻结 1–8 条显式选择的 seed_findings 摘要；不增加 tasks/relations 表

jobs
  id, project_id, canvas_id, plane_issue_id, parent_job_id, finding_id,
  type, status, priority, payload_json, sandbox_id,
  lease_expires_at, heartbeat_at, timeout_sec,
  followup_depth, transcript_uri,
  error, started_at, finished_at, created_at
  -- 唯一约束: (plane_issue_id) WHERE status IN ('claimed','provisioning','running')
  -- canvas_id: 任务画布；verify job 继承父审计 job 的画布

events
  id, job_id, event_id, job_seq, type, payload_json, created_at
  -- 唯一约束: (job_id, event_id)  -- 幂等去重，重试/重连重放不产生重复副作用
  -- 排序: 自增 id = 全局序；job_seq = 调度器侧每 job 单调递增局部序（不信 created_at，时钟有偏差）
  -- 只放语义事件（progress/finding/done/human），原始事件流不进此表（见 §6.2）
  -- 按月原生分区，到期 DROP PARTITION（不 DELETE，避免死元组）

findings
  id, project_id, job_id, node_id, fingerprint, title, profile, category,
  severity, tags_json, evidence_refs_json, scoring_json,
  location, summary, suggest_verify, verify_status, raw_json, created_at
  -- 唯一约束: (project_id, fingerprint)  -- fingerprint = hash(profile + title + location + rule)
  -- schema v20：通用 Finding 协议字段；severity 可空，评分由 Scheduler 规范化

canvas_nodes
  id, canvas_id, job_id, node_type, title, body_json,
  x, y, w, h, status, created_at, updated_at
  -- 唯一约束: (canvas_id) WHERE node_type='root'  -- 每画布一个 root（任务根，body_json.target 为目标）

canvas_edges
  id, canvas_id, from_node_id, to_node_id, edge_type, created_at
  -- edge_type: child（任务 root→job）/ produces（job→finding）/ verifies（verify→finding）

canvas_changes
  canvas_id, revision, entity_type(node|edge|meta), entity_id,
  op(upsert|delete), projection_json, changed_at
  -- PK(canvas_id, revision)；canvases.change_revision 单调递增
  -- canvases.change_floor_revision 标记保留窗口；过旧 delta 游标必须回退 L0
```

要点：

- **画布以 nodes/edges 表为真相**（好查询、好索引、好并发）；tldraw document 只做读取时的物化组装，不存整文档
- `events.event_id` 由宿主从控制工具调用生成（UUID），**所有事件处理幂等**：重复 event_id 直接返回上次结果
- `findings.fingerprint` 是派生去重和画布合并展示的基础
- 画布 L0 通过 `GET /canvases/{id}/summary` 取得当前 `revision`，运行中用
  `GET /canvases/{id}/delta?since=<revision>` 读取 `(since, upper]` 的持久化变更。
  变更日志在同一 Postgres 事务内锁画布、推进 revision、写入事件时 projection 和
  tombstone；游标低于 `change_floor_revision` 时返回 `CURSOR_GAP`，客户端只重取
  有界 L0，不重复传输历史 `body_json`。

### 6.1 Finding Schema 对齐 SARIF 2.1.0

`findings` 表字段与 SARIF（OASIS 标准，Semgrep/CodeQL 等通用）保持映射，将来接入任何扫描器或导出报告零成本：

| findings 字段 | SARIF 字段（runs[].results[]） |
|---------------|-------------------------------|
| `title` | `message.text` |
| `profile` | `properties.deepsonar.profile`（通用领域/协议标识） |
| `category` | `properties.deepsonar.category` |
| `tags_json` | `properties.tags` |
| `evidence_refs_json` | `properties.deepsonar.evidence_refs` |
| `severity` (low/medium/high/critical) | `level`（note/warning/error）+ `properties.severity` 细分 critical |
| `scoring_json` | `properties.deepsonar.scoring`（CVSS 版本、向量、重算分数与状态） |
| `location` | `locations[0].physicalLocation.artifactLocation.uri` + `region.startLine` |
| `summary` | `markdown` 版 `message` / `fullDescription` |
| `fingerprint` | `partialFingerprints`（SARIF 原生概念，语义一致） |
| `raw_json` | 受治理的 SARIF/Finding 原文；Agent-facing MCP 不允许写入该内部字段 |
| 派生规则来源 | `ruleId` → 对应 job type / audit 规则名 |

`emit_finding` 的 payload 是 SARIF result 的受限子集，并扩展通用 `profile`、`category`、`tags`、`evidence_refs` 和可选 `scoring`。`profile` 缺省为
`security.vulnerability`，由任务冻结协议的 `allowed_profiles`/`mode` 约束；category、tags、evidence refs 均有长度和数量上限。`severity` 可省略；缺失或未知 severity 保守进入 Verify，已知 severity 是否自动验证由 `minVerifySeverity` 决定。`suggest_verify` 仅保留兼容语义，最终由规则引擎决策。

评分标准目前固定为 CVSS。Scheduler 对协议接受的 4.0 和 3.1 向量调用固定版本计算器（当前 `ae-cvss-calculator@1.0.13`）重算基础分、定性严重度和利用难度，忽略 Agent 报告分数对系统结果的覆盖（可保留作对比）。协议显式接受的未知未来版本不计算，保留版本、向量、metrics 和可选 reported score，标记 `unsupported_version`；未列入 `accepted_versions` 的版本直接拒绝。`scoring_json` 因而既是报告/筛选输入，也是未来版本兼容的原始承载。

schema v20 的 `0020_finding_protocol.sql` 为 `findings` 增加上述五个 JSON/文本字段、允许 `severity` 为 NULL，并建立 `(project_id, profile, category, verify_status)` 索引；fresh 基线和连续迁移保持同一结构。

### 6.2 存储分层（热/冷分离）

Agent 输入输出是无界数据（单次运行原始事件流可达数十 MB），**Postgres 只放可查询的语义数据**：

| 数据 | 存储 | 说明 |
|------|------|------|
| 原始事件流（text.delta、工具调用细节） | **冷**：每 job 一个 NDJSON 文件（gzip），`transcripts/{job_id}.ndjson.gz`；jobs 表存 `transcript_uri` | 只追加、极少查；SDK 事件流经调度器缓冲合并（每 2s 或 32KB 一批）后写入 |
| 语义事件（progress/finding/done/human） | **热**：events 表 | 小行、有索引，驱动调度与画布 |
| 超限语义 payload（> 固定 256 KiB UTF-8 JSON） | 在暂存/入库前以可重试控制错误拒绝；大正文改走共享资产或拆分语义事件 | 防 TOAST 大行拖垮扫描，且直接参数与 `payload_file` 无绕过差异 |
| findings / jobs / canvas | **热**：Postgres | 结构化业务数据 |
| PoC 产物、截图等 | 冷：blob 存储 | 同 transcript 通道 |

纪律：

- **events 表永不放原始 token 流**
- 冷存储 MVP = 文件系统卷；二期换 MinIO/S3 只改 `blob_uri` 解析层
- 库备份因此保持 MB 级；冷存储走文件级快照
- 保留策略：findings 永久；transcript 默认 90 天；events 表按月分区到期 DROP PARTITION
- finalized manifest 尚未落盘而 Scheduler 中断时，`GET /jobs/:id/evidence` 对
  `attempts/*/stream.ndjson` 生成最多 32 个条目的 synthetic/inflight manifest；可变 raw
  文件的 `sha256=null`，`finalized_at=null`，stream 端点仍按既有读取/解压/记录总预算提供
  过程证据。若沙箱已销毁，manifest 的 `capture_error` 明示 Session 归档不可恢复，
  `session_id=null`，不根据 Attempt 身份伪造文件。

### 6.3 索引与搜索策略

**只给确定会发生的查询建索引：**

```sql
jobs     (plane_issue_id) WHERE status IN ('claimed','provisioning','running')  -- 唯一，防双跑
findings (project_id, fingerprint)                                               -- 唯一，去重
events   (job_id, event_id)                                                      -- 唯一，幂等
jobs     (project_id, status, created_at DESC)                                   -- 列表
events   (job_id, id)                                                            -- 顺序读
findings (project_id, severity, verify_status)                                   -- 过滤
findings (project_id, profile, category, verify_status)                          -- 协议/分类过滤
canvas_nodes / canvas_edges (canvas_id)
findings GIN (title gin_trgm_ops), GIN (location gin_trgm_ops), GIN (summary gin_trgm_ops)  -- 子串搜索
```

语义事件的限流不扫描 `events`：`event-ingestion` 在既有 Canvas → Job 锁顺序下，先以
`event_dedup` 判重，再锁定每 Job 一行的 `job_event_rate_limits`，按固定窗口更新
`progress_count`、`standard_count` 或独立的 `terminal_count`。超过额度时抛出稳定
`event_rate_limited`（含 `retry_after_sec`、bucket、limit），并由外层事务回滚 dedup、
事件、节点、边和状态副作用；重复 `event_id` 直接返回 deduped，不占额度。计数行随
数据库保留，跨 Scheduler 进程/重启仍有效，窗口回拨不会倒退。`event-ingestion` side-effect application（`core.applySideEffects` 仅为兼容 facade）还会
按 Scheduler-owned Job 类型/冻结快照重算工具授权，并要求 Job 为 `status=running`；终态、
角色种类或快照工具不一致时回滚当前 dedup、额度、事件和图副作用。项目数据导入/恢复是
历史审计写入，可按 manifest 批量恢复既有 `events` 而不消耗运行时额度；恢复完成后的新
Job 事件仍必须经过本摄入硬门。

- **JSONB 不建 GIN 全索引**；某路径高频查询后按 §17.2 expand 提升为列再加索引
- 模糊搜索用 **pg_trgm** 而非 tsvector：CJK 分词不友好；trigram 对中英混排与代码路径子串（`auth/login.php:42`）都合适
- 冷数据（transcript）不建索引，按需 grep；语义搜索（向量库）二期再评估，不污染主库

**搜索能力分档：** 结构化过滤（B-tree）→ 子串模糊（pg_trgm）→ 历史运行内容（冷存储 grep）→ 语义搜索（二期）。搜索接口限长 + `statement_timeout` 防 ReDoS/慢查询。

### 6.4 API 与推送的读放大控制

- 列表接口不返回 payload/body 大字段；detail 才返回；blob 内容单独端点支持 Range
- WS 推送只推引用（`{node_id, version}`），客户端按需拉取
- `GET /canvas` 支持 viewport/bbox 参数 + 按 job 分组折叠按需展开
- 画布加载避免 N+1：nodes/edges 两次查询取全，前端组装

---

## 7. API 草图（调度对外）

**事件写入（仅调度器内部，不暴露给沙箱）**

- 事件由调度器消费 SDK 控制通道后自行落库：`{ event_id, type, payload }`
  - `type`: `progress` | `finding` | `done` | `human`
  - 幂等：同 `event_id` 重放不产生新副作用（SDK 重连重放场景）

**管理**

- `POST /projects`  新建本地项目（plane_project_id 可空；不再预建项目级画布）
- `GET/PATCH /projects/{id}`、`POST /projects/{id}/archive`  项目详情/改名/归档（归档=软删除，历史保留）
- `POST /projects/{id}/tasks`  创建任务（同事务建画布 + root + pending job）；`kind=standard` 禁止种子，`kind=compose` 必须提交同项目 1–8 个当前可代入的 confirmed `seed_finding_ids`
- `POST /tasks/{canvas_id}/pause` / `start`  幂等任务执行门禁（`jobs:control`）；返回 `execution_state`、收尾 `active_count`、`pending_count` 与 `changed`
- `POST /tasks/{canvas_id}/retry`  重试（新建 job 复用原画布）；compose 在 wipe 前重验冻结种子，stale/跨项目/已处置时返回 `COMPOSE_SEEDS_STALE` 且保留现有运行数据
- `PATCH /jobs/{id}/priority`（仅 pending 可改）
- `PUT/DELETE /projects/{id}/integrations/plane`、`POST .../plane/sync`  Plane 绑定/解绑/手动补跑
- `POST /projects/sync`  绑定 Plane 项目（兼容入口；画布随任务认领铸造）
- `GET  /projects/{id}/canvases`  任务画布列表（一任务一画布，带 rollup、`execution_state`、收尾/待领取计数及最近一次 job 状态/优先级）
- `GET  /canvases/{id}`  单任务画布节点/边；Canvas 元数据带同一执行控制投影
- `GET  /projects/{id}/canvas`（deprecated，仅兼容历史项目级画布）
- `GET /findings`  Finding 列表；支持 `severity`、`profile`、`category`、`verify_status`、`disposition`、`canvas_id` 过滤
- `GET /findings/{id}`  Finding 详情；返回协议字段、评分原文/规范化结果、验证轮次、来源事件和结构化 trace
- `POST /jobs/{id}/cancel`
- `POST /jobs/{id}/resume`  使用旧冻结快照重新执行；身份漂移时 `409 SNAPSHOT_STALE`
- `POST /jobs/{id}/rerun-current`  按当前配置完整重冻并重新执行，保留画布
- `POST /reconcile/run`（或定时）以 jobs 表为准修正 Plane 状态

**Plane → 系统**

- 轮询：`GET ready work items`（适配器实现）
- 或 Webhook：`issue.updated` → 入队（二期）

---

## 8. Agent 任务包与事件通道

调度器通过 agentbox-sdk 在一次性沙箱内以 server 进程方式拉起 Agent。每个 Job 都使用全新的 `/workspace`，任务内容只通过 Agent CLI 的 input 注入，不再生成 `task.json`，也不由 Scheduler 预下载或挂载代码。

系统按 Job 冻结快照动态组装：

- `/workspace/AGENTS.md` 与 `/workspace/CLAUDE.md`：平台边界、角色职责、结果契约与 RoleConfig 长期指令；两份文件由同一内容生成并保持逐字一致
- 平台内置且不可覆盖的静态 `deepsonar-control` Skill：只描述 capabilities/OpenAPI discovery、短期 Bearer Token、UUID `Idempotency-Key`、HTTP 错误处理与 API-only 规则；Skill 内容对所有 Job 相同，不携带动态权限清单
- Provider 项目配置文件，以及 agentbox setup 下发的 plugin/skill/command/MCP/subagent
- 非敏感环境变量、白名单 `env_keys`、按 Job 签发的短期模型凭据，以及只在执行期注入的短期平台 API capability token；两类 token 权限域与存储表完全分离
- 画布创建时冻结的 Finding 协议说明：模式、默认/允许 profile、CVSS 默认/接受版本和必评分 profile；运行中以协议名和来源显著标识
- Hub 生成的完整、自包含 Worker prompt，等价于 CLI 的非交互 `-p "prompt"` / input
- 已准入的不可变运行镜像快照：产品/版本 ID、`name@sha256:digest`、工具清单哈希和准入扫描 ID

Worker 不假设目标类型或固定路径。是否需要代码、网页、制品或其他材料，以及是否使用 git、curl、浏览器或已有文件，由 Worker 根据 prompt 自行决定。平台只控制项目默认/任务覆盖的 `allow_egress`；最终布尔值在创建画布时冻结，Hub 与 Worker 共用。该开关只控制目标网络能力；模型通道始终经 Scheduler Model Gateway 和 Scheduler-owned gateway proxy。允许出网时沙箱加入 `deepsonar-sandbox-gateway` NAT bridge；禁出网时只加入 `deepsonar-restricted` internal bridge。proxy 同时加入两网，但只转发固定 Scheduler 上游的 `/gateway` 与 `/control/v1/`，拒绝 CONNECT、任意目标和其他路径。

**平台控制 API-only**：所有治理 CLI 都由 Agent 使用自身 HTTP 工具调用 Job 级控制 API；Runtime Adapter 只驱动 CLI 协议，不代发 HTTP，也不注入或回退控制 MCP。调用最终汇入同一个运行中 Job semantic handler：

- SDK normalized event stream → 文本/进度 → `progress` 事件
- Scheduler 提供独立于管理 OpenAPI 的 Job 控制面：`GET /control/v1/jobs/:jobId/capabilities`、`GET /control/v1/jobs/:jobId/openapi.json` 与 `POST /control/v1/jobs/:jobId/operations/:operationId`。前两者和 OpenAPI paths 都按当前 capability token 的精确 operation allowlist 过滤；写调用要求 UUID `Idempotency-Key`，同 key 重放不得重复执行，跨 operation 重用返回冲突。
- 静态 `deepsonar-control` Skill 引导 Agent 先读取 capabilities/OpenAPI，再按冻结 operation 调用 HTTP API。Pi 运行时固定为 `pi --mode rpc --no-approve --no-extensions`，通过持久 JSONL framer 处理任意字节分块；只有 `agent_settled` 作为 Agent 侧静止信号，终态仍必须经过 `mark_job_done` 完成门。
- Job 进入真实执行时，Scheduler 从冻结的 `agent_snapshot_json.platform_tools` 签发独立短期 capability token，仅存 hash 并绑定 `job_id`、`project_id`、operation 列表和 TTL，通过 `DEEPSONAR_API_BASE_URL` / `DEEPSONAR_API_TOKEN` 注入 CLI 环境。它不复用 Credential/Model Gateway token，不写回 snapshot、workspace、运行清单、日志或 evidence，并在成功、失败、超时、取消或孤儿终态撤销；鉴权还要求 Job 仍在运行。
- API operation 不直接复制 `event-ingestion`：路由调用进程内注册的当前 Job runtime handler；只读 operation 返回冻结角色/资产目录，语义写 operation 复用 `onSemanticEvent`、payload_file/共享资产宿主读取、计数和 Hub/done 延迟终态，再进入 Scheduler 权威事务。直接参数与展开后的 `payload_file` 共用固定 256 KiB UTF-8 JSON 上限。Hub/Human 的副作用仍延迟到 Agent 退出后执行，但当前 Job、画布引用、角色、Finding 绑定和完成门在返回 `accepted` 前由只读权威事务预检，最终副作用事务再次校验。API 返回 `accepted` 只表示 Scheduler 已接收通过同步校验的输入；HTTP 错误统一返回可重试稳定错误码并要求 Agent 修正请求，不允许切换控制传输。
- 宿主先用不含 Scheduler-owned 字段的 `ControlEventEnvelope` 严格校验（Fact 不得带 `intent_node_id`，Finding 不得带 `raw`），再转换为内部 `EventEnvelope`；`event-ingestion` side-effect application（`core.applySideEffects` 仅为兼容 facade）仍在写入前再次校验，并以 `jobs.type`/冻结快照重算工具、角色 kind，要求 Job 仍为 `running`。需要数据库的 referable/role/verification 业务约束在同一 ingest 事务中执行，失败抛稳定 `ControlInputError` 并回滚 dedup、rate-limit、event、节点和边；HTTP 响应同步返回最终接收或稳定拒绝结果。
- `emit_finding` 只允许 Agent-facing 的严格 Finding 子集；profile/category/tags/evidence refs/scoring 由共享 Zod schema 限界，`raw`、协议修改、验证派生和最终 severity/score 均为 Scheduler-owned。Scheduler 在摄入事务中按画布快照归一化 profile、重算支持的 CVSS、保留允许的未知版本原文，再做 fingerprint 去重和自动 Verify。
- 非 JSON/未知 runtime 行、伪造的控制 MCP tool call 和 Agent 对 `.deepsonar/control-*` 控制文件的尝试只产生固定分类告警/指标（不记录原文），跳过后继续解析后续合法行；平台控制 telemetry 仅保留 operation/调用标识与输入 shape/count，非控制工具保持既有可观测性；不恢复可写事件文件队列。
- CLI stderr 不参与终态或语义事件推断。Runtime 在任意 SDK chunk 边界上对短期 Job Token 做流式精确脱敏，再以 `runtime.stderr` 写入 normalized evidence；单次运行累计最多 1 MiB，达到上限写 `runtime.stderr.truncated` 后停止采集。`jobs.error` 继续只保存短尾摘要，完整有界诊断只从鉴权 evidence 端点读取。
- 每个 Job 将 `HOME` 固定为独立可写的 `/workspace/.deepsonar-home`，不信任镜像继承的 `/root`；各 Agent CLI 默认使用自身位于 `HOME`/XDG 下的标准用户目录（Claude Code 为 `~/.claude`、Codex 为 `~/.codex`），只有不遵循标准目录的 CLI 才由受治理 Runtime Adapter 显式覆盖。原始 Session 归档复用同一 `HOME`，读回内存后立即清理，随后再销毁一次性沙箱
- Session 归档按 CLI 方言独立读取：Claude Code、Codex、Pi、DSH 使用本次沙箱的受治理本地 session artifact；OpenCode 使用 `opencode export <sessionId>` vendor export，受 32 MiB 上限约束。malformed 的 session identity/path、导出/读取错误或超限显式失败；Web 查看器分别解析五类格式并保留原始归档下载
- 启动中断导致容器先于归档销毁时，只暴露已写入的 normalized stream synthetic manifest；
  Session 显式 `capture_error`，不能用数据库中的 session identity 冒充归档，也不能跨新
  Attempt 复用已销毁沙箱。
- 数据库在新 Fact/Finding 节点提交后发出 `deepsonar_canvas_events` 通知；调度器实时回查节点正文，并用 `Agent.attach(...).sendMessage(...)` 向同一画布仍在运行的其他 Agent CLI 追加增量消息。追加消息只提供新任务数据，不改变冻结角色、网络或工具权限。仅当 Job 冻结能力 `incrementalMessages=true` 时订阅（Claude Code / Pi / DSH；Codex / OpenCode 不追加）。每次投递写入 `canvas_broadcasts`（`planned`→`injected`|`unknown`），`injected` 仅表示平台已调用 sendMessage 成功，不表示模型已读。画布广播徽标与连线是账本派生 overlay，不写入 `canvas_nodes` / `canvas_edges`；Job Session 的广播条目来自 CLI 持久化文本，只是旁证，同样不是 ACK。查询 `GET /canvases/:id/broadcasts`。产品摘要见 `DESIGN.md` §4.2
- 终态后销毁该 Job 的独立沙箱；不创建或清理控制事件文件队列
- 沙箱内不注入调度器数据库、管理 API 凭据或长期 Provider 密钥；`settings_config_json` 的无密钥结构仅在当前 Job 物化为 CLI 配置文件，endpoint 统一改写到 Gateway 并注入短期模型 Job token。平台控制 API 只注入另一枚按 operation 限权的短期 token；二者均随终态撤销并随一次性沙箱销毁
- lease 由调度器根据控制通道存活状态维护；SDK 通道中断由 Reaper 按 lease 判定

### 8.1 Agent Runtime Context 生命周期（#138）

真实 Agent 的上下文不是调度器可以直接读取的 prompt 缓存，而是由 Scheduler、Runtime Adapter 和 Provider 共同形成的执行状态。Scheduler 在启动 Agent 前为当前 Attempt 生成稳定的 `context_id`，并以 `context_revision` 和摘要链记录输入变换：初始输入、GraphScope 投影、字符预算省略、摘要交接以及已明确观测到的 Provider 压缩。每个变换只持有输入/输出 digest、版本、预算、来源和有界省略说明，不保存 prompt、模型上下文或 Provider 原文。

上下文状态同时写入活动 `job_attempts.state_json.runtime_context` 和 `jobs.payload_json.runtime_evidence.context`。前者与 `attempt_id` 绑定并在同一数据库事务中更新，后者保留其他运行证据字段。状态、变换链和压缩事件均有数量/字节上限；Job 详情 API 只投影最近的有界摘要，并单独投影最后一次已观测压缩的 event、boundary、budget、omission 和 source，避免诊断方反向扫描完整 manifest。

Runtime Adapter 只有在收到包含完整上下文身份、revision、链 digest、边界及输入/输出 digest 的 `context.compacted` 事件时才上报已观测压缩。重复事件按 `event_id` 幂等，乱序、跨 Attempt、链不一致或身份不一致直接拒绝。Provider 仅暴露开始/结束标记，或适配器声明不支持时，状态分别标为 `unknown`/`unsupported`，不能伪造 revision 或输出 digest。

任何同会话恢复都必须使用首次运行时已经观测并绑定的会话身份，与当前持久状态逐字段匹配；适配器需要额外查询时可提供 `getResumeContextIdentity`，但实际身份缺失、revision/链 digest 不一致均 fail closed，不得使用 latest 或新会话。Pi 还必须传递并匹配精确的 `sessionFile`。恢复身份和诊断不包含原始上下文内容。

### 8.2 Agent 配置体系（RoleConfig）

配置按“全局缺省 → 项目覆盖 → Job 冻结快照”生效，不存在旧 Profile 回退：

| 层 | 位置 | 内容 |
|----|------|------|
| 存储 | `role_configs` / `role_credentials` / `role_config_files` / Credential `settings_config_json` | RoleConfig 保存 CLI、模型覆盖、`context_window_tokens` 客户端预算、长期指令、env、模块、skill、command、MCP、subagent、平台工具开关与 Credential 引用；Provider-owned reasoning 与 CLI/DSH profile 只存在 Credential 配置；DSH 规范档位及模型 `reasoningEfforts` 映射随 Credential 冻结，运行时由固定提交的 `dsh-reasoning-settings` 修正 Subagent 继承；全局 RoleConfig 保存可信镜像绑定 |
| 决策 | 全局 RoleConfig + 项目 RoleConfig + Credential `settings_config_json` + `projects.config_json.rules` + `projects.config_json` 镜像策略 | `RoleConfig.context_window_tokens` 优先于 Credential 顶层基准；reasoning 只读 Credential 顶层值；Claude Code 的 RoleConfig 模型可保留 `fable` / `sonnet` / `opus` / `haiku` CLI selector，但模型白名单、Gateway token 与模型并发门禁统一使用对应 `ANTHROPIC_DEFAULT_*_MODEL` 的实际上游 ID。Claude Code 物化为官方 `effortLevel` 四档，Codex 冻结为 `model_reasoning_effort`，Pi 冻结为 `--thinking`，OpenCode 冻结为 Provider 自定义 `--variant`，DSH 只接受 Pi-AI 规范档位且第三方 wire value 由模型 YAML 映射；字段为空时使用 Provider / CLI 默认。项目只覆盖确有差异的角色配置；规则控制 Hub 护栏与 Worker 出网默认值，项目镜像策略独立决定 Job 镜像来源 |
| 执行 | `jobs.agent_snapshot_json` | 建 Job 时必须冻结完整运行快照（含 CLI selector `model`、实际 `upstream_model`、Provider 配置文件与客户端上下文预算）；Executor 仅用 selector 启动 CLI，所有上游治理使用 `upstream_model ?? model`，不读取旧配置或为缺失快照降级 |

项目镜像策略不改表：`projects.config_json.image_strategy` 缺省为
`inherit_global`，该策略下每个 Job 角色的镜像只读取全局 RoleConfig 的
`runtime_image_key`，即使项目 RoleConfig 覆盖了 CLI、模型或其他字段；
`project_managed` 则只读取 `role_runtime_images` 的角色映射，缺项或 `null`
固定使用系统 `deepsonar-base`。非空 key 在项目设置写入时必须命中已启用、可信且符合
现有准入规则的 runtime image；最终解析的 immutable digest/ref 与工具清单仍只冻结在新 Job。

Finding 协议是同一配置层级中的独立规则：全局存于
`global_settings.rules_json.finding_protocol`，项目存于
`projects.config_json.finding_protocol`，任务请求的 `finding_protocol` 写入画布
`target_json`。`resolveFindingProtocol` 按任务 > 项目 > 全局覆盖（数组按层替换并去重），生成
`EffectiveFindingProtocol` 后在新画布创建事务中冻结；后续改设置不改写既有画布或 Job。只有 v20 以前未冻结的历史画布走兼容回退。

compose 的种子范围同样是任务级冻结输入，但只有人工任务创建入口拥有选择权限。Scheduler 在创建事务中校验 Finding 属于当前项目、技术态为 `confirmed` 且 disposition 为 `open|accepted|confirmed_vuln`，然后把内容写入 `target_json.seed_findings`：存在最新成功 Finding Report 时冻结其 Markdown，否则回退 Finding summary。随后创建 `job_id=NULL` 的只读 finding 投影节点。Graph 只暴露投影节点 UUID；入口 Hub 与由该投影派生的 Worker 通过 Scheduler 冻结的 Finding scope 获取共享资产。imported seed 不插入新 Finding、不进入本画布收敛门，也不生成 verification follow-up。

Credential 独立密钥列使用 AES-GCM；完整 `settings_config_json` 是服务端拥有的 CLI 配置源，管理 API 和 Web 只能看到 `[已保存密钥]` 投影。Job 创建时只冻结去除长期密钥后的配置结构；执行器物化 CLI 文件时统一改写为 Gateway endpoint 和短期单 Job token。RoleConfig 的 `env_vars` 仍只能保存非敏感值，调度器数据库、平台 API 凭据和长期 Provider 密钥不下发。

`context_window_tokens` 的合法范围统一为 1024–10000000，表示 CLI 客户端的上下文/自动压缩预算，而不是上游能力声明。模型目录只保存 Provider 返回的模型 ID；Provider 是否开放某个长上下文变体、账号是否有权限、模型真实硬上限仍由上游决定，配置更大的客户端预算不会提升它们。物化落点为 Codex `model_auto_compact_token_limit`、OpenCode 模型 `limit.context`、Pi `models.json.contextWindow`；Claude Code 当前没有受支持的绝对窗口落点，只把值冻结进 Job 快照供审计和 UI 展示，不伪造设置。

**Model Gateway 上游纪律：** Scheduler 的上游单次超时默认 3,000 秒（`DEEPSONAR_GATEWAY_UPSTREAM_TIMEOUT_MS=3000000`），但每次 attempt 都受 Job `started_at + timeout_sec` 的绝对截止时间约束，实际 timeout 为两者较小值；退避等待也不得跨过该截止时间。只有在 Scheduler 尚未向沙箱客户端发送响应头或响应体时，网络/超时与 HTTP `408/429/500/502/503/504` 才可最多执行 3 次 attempt，使用指数退避和 jitter；`400/401/403` 等永久错误不重试。取得最终 Response 后沿用流式直通，SSE 或普通响应体读取失败不触发重放。`job_tokens.used_requests` 仍按一次客户端请求只加一次；上游 attempt/retry/exhausted 指标只带 provider/reason 等低基数标签，禁止请求体、URL 和 Job ID。网络/超时耗尽固定返回 `502` 的 `upstream_unreachable`，最终上游 HTTP 状态和响应体原样透传。

每次 Gateway 请求写入 `job_usage_ledger`，通过 `attempt_id + effect_id` 幂等关联 Job Attempt；只保留 provider/model、请求序号、输入/输出/总 token 及 `settled|unknown|not_reported`，不落 prompt、响应正文、请求头和凭据。跨 chunk 的 SSE usage 只在完整记录边界解析并去重。响应已经发给 Worker 后账本写入失败不抛出未处理异常，同时递增低基数失败指标并留下 effect 对账线索。

并发治理服从单一的调度优先级：`global_settings.rules_json` 的 effective `maxGlobalJobs`（全局硬 cap）与 `maxJobsPerProject`（每项目硬 cap）先于 Provider，Provider 先于 Credential，Credential 先于该凭据下的 Model ID，Agent CLI 全局配额最后检查。项目可在 `projects.config_json.rules.maxConcurrentJobs` 把本项目 claim 预算收到不高于 `maxJobsPerProject` 的值（`0` 暂停新领取）；未设置则继承全局每项目上限。`.env` 中的 `MAX_GLOBAL_JOBS` / `MAX_JOBS_PER_PROJECT` 仅在全局规则缺失时作为启动默认；项目规则不能放宽全局硬 cap。Provider 与 Agent CLI 上限存于全局规则；Credential 的总上限 `max_concurrent` 和逐模型上限 `model_concurrency` 存于凭据公开元数据。模型可用性只认 Credential `settings_config` 声明的清单，旧 `allowed_model_ids` 字段读写均静默忽略。模型目录由调度器持有密钥并调用 Provider 模型列表接口获取，前端只能接收模型 ID 清单，不能读取长期密钥；Anthropic 兼容子路径按有序候选探测，仅 HTTP 404/405 允许剥离子路径后继续，鉴权、限流、网络、超时与上游错误均立即失败且不读取错误正文。

Provision admission 是数据库 claim 事务的一部分，而不是进程内 semaphore：effective `global_settings.maxConcurrentProvisioning` 先检查当前 provisioning 资源占用，超额 Job 保持 `pending`，不写入或消耗 `claimed_at`；槽位释放后调度器显式唤醒 pending 队列，重新 claim 并推进到 `running`。`.env` 的 `PROVISION_CONCURRENCY=2` 只在该全局配置缺失时作为 fallback，不能绕过数据库门禁，也不改变其他全局/项目/Provider/凭据配额。

平台控制 capability 也属于角色注册/RoleConfig：当前 UI 仍以平台工具 list 对每个 Agent 全量可选，开关随 Job 快照冻结。冻结 capability 只派生 API operation allowlist；关闭项不会出现在动态 `AGENTS.md` / `CLAUDE.md`、运行清单、capabilities 或动态 OpenAPI 中，执行器接收语义事件时还会再次校验授权。`event-ingestion` side-effect application（`core.applySideEffects` 仅为兼容 facade）是 fake/direct/recovery 路径的最终授权边界。仅 `mark_job_done` 是不可关闭的终态 capability；其余进度、事实、Finding、Hub 决策、人工请求与共享资产能力均可按全局缺省或项目覆盖启停。Job 离开 `running` 后的新语义事件稳定拒绝（历史导入/恢复批量写入既有 events 是唯一例外）。所有治理 CLI 的控制能力只走 HTTP API；冻结 adapter 缺少 `platformControlApi` 或 operation 时执行前 fail closed。Pi 恢复必须使用 `get_state` 返回的精确 `sessionFile`，不选择 latest。

### 8.3 可信运行镜像与独立市场

镜像市场是受治理的 OCI 目录，不是任意容器执行入口。`runtime_images` 表示产品身份，`runtime_image_versions` 表示不可变版本，`project_runtime_images` 表示项目显式启用/固定版本，`runtime_image_scans` 保留每次准入或复扫证据。

- 官方 `deepsonar-base` 供 explore/analyze/review/code/hub/report，`deepsonar-audit` 供 audit；两者以固定 digest 的 `node:22-bookworm-slim` 为底（满足当前 Claude Code 的 Node 版本要求），共用 `agent-harness/runtime-images.json` 版本/来源/摘要单一定义，本地 image DSL 与生产 Dockerfile 均消费该约束并由 CI 检测漂移。
- Base、Audit 与 Kali 官方运行时均固定安装 `@earendil-works/pi-coding-agent@0.84.1`，清单记录 npm `sha512` integrity；Docker 构建通过 `npm view ... dist.integrity` 实际核验该摘要后才安装。Pi 的 `models.json` 只写入 Gateway 地址与短期环境变量引用，长期 Provider 密钥不进入快照、工作区或 evidence。
- Base CI 对 DSH 执行不依赖 Provider 凭据的真实容器启动门禁：完整包闭包统一固定为 `0.1.0-rc.7`，避免 prerelease peer range 混装；无论本轮构建还是复用 `src-*` 镜像，都用平台 standard mode 的完整无 UI Cordis composition、`--network none` 和 packaged-bin 验证 JSON-RPC `initialize` 与干净 `shutdown`。这会让镜像中钉死插件的 Schema 校验全部真实运行；`agent-spine-demo` 的 `toolBash` 必须是对象或 `false`，bash 工具只由 spine 挂载一次；`dsh-subprocess-local` 以固定 integrity 显式安装并先于 `dsh-bash-local` 挂载。
- **镜像体积是准入硬门槛**：按角色拆包、`--no-install-recommends`、不安装重复 Agent SDK/CLI、构建后清理包缓存，并在断网冒烟中以 gzip 压缩分发包检查 `maxSizeMiB`、同时报告解压层大小。重型扫描器只进入专项镜像，不允许为了“可能用到”扩张默认 base。
- `deepsonar-kali-minimal`（市场名 Kali Test）仅是 test 的官方默认镜像：固定官方 `kali-last-release` digest，预装 Python 3.10–3.14、固定 digest 的 Temurin JDK 8/11/17（默认 17，不含 21）、固定官方 Apache Maven 3.9.16、Kali 仓库的 Go/Rust 与清单化审计 CLI；Maven 位于 `/opt/deepsonar/maven` 且不预置 `.m2` 缓存。不安装 `kali-linux-*` / `kali-tools-*` metapackage、GUI、桌面或默认工具全集。Python 运行时构建后禁止联网补装，Java/Python/Maven 均提供明确的版本化命令。系统 verify 默认使用最小 Base，需要专项工具时通过 RoleConfig 显式覆盖。
- Runtime-test Worker 只消费上述镜像内的预构建工具链，禁止在 Job 内冷装/下载 JDK、Maven、Gradle 或编译器；工具缺失时必须回传结构化 inconclusive/needs_human 证据。Java/Python/Go/Rust 的静态—动态能力和证据硬门见 [`RUNTIME_TEST_TOOLCHAINS.md`](./RUNTIME_TEST_TOOLCHAINS.md)。
- OpenHarmony 专项镜像均为 `project_opt_in`：`deepsonar-openharmony-test`（源码同步与构建）、`deepsonar-openharmony-audit`（Clang 静态分析 + ASan/UBSan 工具链，面向 OOB/UAF/提权类假设）、`deepsonar-openharmony-fuzz`（libFuzzer/AFL++ 动态验证）。三者均基于 `deepsonar-base`，不烘焙全量源码或板级固件；高危挖掘时由项目启用，并在 `project_managed` 的角色镜像映射中集中绑定 audit/test/verify，不改变全局默认。
- Chrome 专项镜像也全部为 `project_opt_in`，不改变任何全局默认：`deepsonar-chrome-audit` 只提供 git partial clone、Semgrep C++ 规则、Clang/LLVM 与 binutils 静态分析工具；`deepsonar-chrome-test` 使用 Debian bookworm-security snapshot 固定版本的 Chromium `151.0.7922.71-1~deb12u1`、Playwright Core 与 CDP，通过受治理的 `--no-sandbox --headless=new` wrapper 启动；`deepsonar-chrome-fuzz` 以固定的 depot_tools/V8 源码提交构建真实 `d8` 与 `v8_json_libfuzzer`，后者从 V8 的 `json_fuzzer` 源集链接 compiler-rt 的 libFuzzer main；V8 `15.1.206.10` 是与浏览器包独立但由 Chromium 151 DEPS 锁定的输入，并提供 clang/lld/compiler-rt/libFuzzer/AFL++。Chrome Fuzz amd64 按正常目标架构构建并执行实际 d8/libFuzzer smoke；arm64 在 x86 runner 上使用固定 Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装，真实 d8/libFuzzer smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，原生 smoke 通过前不得组装发布 index；若任一架构不能生成真实目标则 fail closed，不能用 Node 或 toy harness 冒充。
- Job 创建于 `core.ts` 时先按项目镜像策略选择来源：`inherit_global` 取全局 RoleConfig 镜像，若该全局 key 为空再按角色官方默认值解析；`project_managed` 对项目映射缺项或 null 固定取 Base，不再经过 test/audit 等角色默认镜像分流。最终立即冻结 digest；Dispatcher/Executor 只消费快照，不在执行期重新解析 tag。
- `image-admission` 是与 Scheduler 进程隔离的 Worker。它对 allowlist registry 的导入执行 digest 解析、可选 Cosign 验签、Syft SBOM、Trivy 漏洞/凭据扫描、ClamAV 恶意文件检查、setuid 枚举和断网硬化自检。官方 catalog 默认免签（digest 信任根）；仅当配置了公钥 `--key` 或 Cosign 3 keyless identity+OIDC issuer 时才 `verify`，缺参不得发出 keyless `verify`。扫描通过后第三方仍保持 quarantined，只有 `images:approve` 管理员能提升 trusted。
- 复扫失败的 trusted 版本自动 revoked，调度器/准入 Worker 会取消尚未完成的相关 Job 并精确回收它们的 sandbox ID。历史 Job 快照、Finding 和扫描记录不删除；新 digest 只进入 quarantined，不自动替换生产版本。
- 私有 registry 使用 `oci_registry` Credential，准入 Worker 仅在 `docker login --password-stdin` 时解密，不进入 Job Snapshot、Docker 参数、日志或 Agent 工作区。
- `runtime_data_layers` / `runtime_data_layer_versions` 为 Trivy/OSV 等离线库预留可版本化、只读、digest 准入模型；尚未准入的数据层不得挂载进运行沙箱。
- Shared Assets 使用 `shared_assets`（逻辑对象）+ append-only `shared_asset_versions` + SHA-256 `shared_asset_blobs`（CAS 元数据）分离内容与引用；字节经可插拔 **BlobStore**（`BLOB_STORE=fs|s3`）存放，逻辑键为 `shared-assets/sha256/<aa>/<sha256>`，**不**进入 PostgreSQL JSONB、画布或 Graph YAML。`fs` 落在 `BLOB_DIR`；`s3` 为任意 S3 兼容 API（AWS / MinIO / Garage / SeaweedFS / 云 OSS 等，**不锁定厂商**），Job 注入前 `materializeLocal` 到本地缓存。详见 [`SHARED_ASSET_BLOB_STORE.md`](./SHARED_ASSET_BLOB_STORE.md)。scope 为 `platform | project | finding`：项目资产自动选择，platform 仅在项目显式 opt-in 后选择，finding 仅对同项目且 Job 绑定该 `finding_id` 的 review/test/verify/report/Hub 链选择。
- Job 创建事务计算排序后的精确 version/hash/path 清单和 `shared_assets_revision`，写入 `agent_snapshot_json` 与 `job_shared_asset_versions`；后续资产更新不会改变已建 Job。prompt 只说明只读目录和 bounded catalog，不注入文件正文。Agent publish 只能从普通 `/workspace` 的单一已打开正则文件描述符做有界读取，拒绝 symlink、路径逃逸和平台运行/CLI 用户配置目录自复制；宿主执行前后校验 Job/lease/sandbox，数据库触发器再锁 Job 做原子终态门禁。Agent 不能 publish platform，也不能覆盖 human/platform key，自有 key 仅追加版本。
- Scheduler 为有资产的 real Job 创建带精确 Job 归属标签的本地 `deepsonar-assets-*` named volume，固定 digest 的 helper 从冻结 CAS 清单写入文件和 `catalog.json`，再固定以 `:ro` 挂载到 `/workspace/.deepsonar/shared`。运行时默认回退为 `docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`，`DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 可覆盖但必须是 immutable 的小写 64 位 sha256 OCI 引用。real 部署优先拉取同 registry/tag 的官方 `deepsonar-assets-helper` 并导出其 RepoDigest；该标签尚未发布时回退 busybox pin，失败即停止。运行时创建 helper 只使用 `--pull=never`，fake 不使用该 helper。CLI 的可写 `HOME=/workspace/.deepsonar-home` 位于该只读挂载父树之外，因此 Docker 创建 `.deepsonar` 挂载父目录时不会阻断 CLI 用户目录初始化。任意 host bind、任意 target 和 Docker 自动创建均被拒绝；provision 后再次检查实际 Mounts.Name 与 `RW=false`。dispatcher finally、Reaper 和启动 reconcile 删除失败时做 3 次指数退避；启动对账合并可信 label 与严格 `deepsonar-assets-<canonical UUID>` 名称扫描，经 Name/Driver/Scope/可选标签复核后也能回收无标签历史孤儿卷。对账完成后更新残留孤儿数量和最大年龄 gauge，清理失败单独累计 counter。
- 上传由 Scheduler 服务端计算 SHA-256，并在 scope 级 advisory transaction lock 内执行配额检查；内容类型与扩展名必须同时命中白名单，单文件与 scope 总额均受配置约束。归档只改变逻辑状态，历史版本与 Job 引用不删；CAS 垃圾回收只能在无 version/Job 引用并过保留期后执行。HTTP 目录和本地 `list_shared_assets` 均按 `limit/offset` 分页；真正的按需 fetch 需要独立可信 IPC，当前不开放写 socket 或控制文件。

Web 的 `/images` 是独立市场页，`/projects/:projectId/images` 是项目启用视图；新建任务仍只接收标题、内容和可选网络策略，不暴露镜像引用。

官方运行时市场只从固定 HTTPS 信任边界内的 GitHub Release `latest` 清单同步。Scheduler 启动时同步一次，并按 `DEEPSONAR_RUNTIME_REGISTRY_SYNC_SEC` 定时刷新；远端不可用时回退随部署内置的清单。正式发布清单存在版本时，环境变量镜像引用仅作为无版本场景的启动兜底，不能覆盖正式最新版本。同步后每个官方镜像只有清单首个版本保持 `promoted_at`，历史版本继续保留，供项目显式固定与既有 Job 不可变快照追溯。Issue #70 Slice B 的 v2 发布清单由 release workflow 以 ACR→GHCR→Docker Hub 顺序生成；每个已发布目的地必须通过真实 `docker buildx imagetools inspect` 并与 canonical digest 相等，`registry_evidence` 记录 inspect/provenance，配置目的地发布失败则清单生成 fail-closed。Slice C 将平台全局 `runtime_registry_channel`（新库默认 `aliyun-acr`）落库：`GET /runtime-images/registry` 返回 `selected_channel`，管理员通过 `PATCH /runtime-images/registry/channel`（`images:manage`）在 `github`、`dockerhub`、`aliyun-acr` 间切换；项目限定 token 被拒绝。选择严格过滤 Scheduler 宿主平台，平台元数据为空也明确 fail closed。real/local-docker 先提供 `/health` liveness，再后台准备 Base 及全局有效 Audit/Kali 集合；就绪前不启用 Dispatcher，失败保持 live 并有界退避重试。项目策略/绑定/通道变更缺图时返回 `202 preparing/saved:false`，异步任务完成后重试才提交；通道门禁覆盖当前项目托管映射与显式 pin，成功前旧通道保持有效。省略 `version_id` 仍跟踪最新可信版本。Dispatcher 只 inspect 冻结 ref，缺失以 `runtime_image_not_ready` 分类计入指标和失败原因，执行期不 pull。

本地 runtime image GC 只在 real/local-docker 且 `DEEPSONAR_RUNTIME_IMAGE_GC_INTERVAL_SEC>0` 时运行。候选必须来自 DB `runtime_image_versions` 与其 ref 账本，且 named immutable ref 的 digest 与版本 digest 一致；保护集合包含所有 `promoted_at` 版本、每产品按时间最近两版（当前 + 上一回滚版）、`project_runtime_images.selected_version_id`，以及 pending/claimed/provisioning/running/waiting_human Job 快照中的 `runtime_image_version_id`。删除前用精确 ancestor 检查全部容器，随后只执行不带 `-f` 的 `docker image rm <known-ref>`；Docker 竞态下的容器引用仍阻止删除。裸 digest、可变 tag、不一致 ref、Docker 检查失败均 fail closed；不调用 `docker image prune` / `docker system prune`，也不处理数据库目录外的服务镜像或第三方资源。

RoleConfig 不要求每个角色绑定市场镜像。空 `runtime_image_key` 表示“系统沙箱”：Scheduler 使用平台治理的最小 Base 底座创建沙箱，并在 Job 快照中记录其不可变 digest，但 RoleConfig 本身保持未绑定状态。Test 与 Audit 可默认绑定专项 Kali/Audit 镜像；其余内置角色默认使用系统沙箱。该选项不允许 Agent、Hub 或任务内容提供任意镜像引用。

发布清单的 `size_bytes` 来自不可变 OCI manifest/index 的压缩层描述符：分别汇总目标平台层大小，清单记录其中最大的平台大小，并保留各平台大小作为发布证据。该值不是本机解压后的 Docker 占用，避免不同构建机的本地 inspect 结果影响市场元数据。

### 8.4 Git 模块源（skill_sources）

Agent 的插件/skill 集中托管在 Git 仓库，每个 RoleConfig 按需勾选。数据库基线内置受信任且启用的 `DeepSonar-Skills`（`https://github.com/SummerSec/DeepSonar-Skills.git`，`main`），并使用由仓库 URL 派生的稳定 UUID；catalog 不固化到 schema，仍由受控同步接口获取并缓存：

- `POST /skill-sources/:id/sync`：浅克隆 → 扫描 `SKILL.md`（skill）与 `commands/*.md`（slash 命令）→ catalog（含文件内容）落库缓存
- 模块归属按最近含 `.claude-plugin/plugin.json` 的祖先目录分组（= 插件）
- RoleConfig 保存原始 selector：历史 `<source_id>:<module_id>`，以及 `<source_id>:plugin:<plugin_path>`（插件下全部 skill/command）和 `<source_id>:source:*`（整源）。快照时只在 trusted + enabled 的当前 catalog 上展开，和手写 JSON 合并（按 name 去重，手写优先），随 `agent.setup()` 下发到当次 Worker
- `module_selectors`、展开模块元数据、`module_content_hash`、`skill_revisions` 与结构化 `missing_modules` 一并冻结进 Job snapshot；后续 sync 只影响下一 Job，历史 Job 只消费快照内容。插件/整源 selector 会自动纳入 sync 后新增模块，旧的显式 module 列表不会。手写 `skills_json`/`commands_json` 对同 kind/name 的 catalog 模块具有确定性优先级，被屏蔽模块从最终 expanded 集合与 hash 排除并记录 `manual-override`
- selector 解析固定以 36 字符 source UUID 开头；插件/模块路径拒绝绝对路径、空段、`..` 与 URL 解码后的保留 `:`。未信任/禁用来源、缺失插件、空 catalog、手工覆盖和同一 skill/command 命名空间内的重复名称写入明确 missing；重复名称的全部冲突模块排除，不依赖 catalog 顺序覆盖写入
- catalog 与最终展开集合的内容哈希覆盖 plugin/name/description 与文件内容；Job 证据 manifest/runtime evidence/API 详情均保留 missing_modules，旧快照按空数组兼容。Runtime materializer 在 mkdir/upload 前对 command/subAgent/skill 名称及 skill 文件相对路径做 normalize/resolve 子树校验，路径穿越、绝对路径和控制字符直接拒绝
- 内容在 sync 时缓存，跑任务不再访问 Git —— 断网/私有网络也能跑

### 8.5 图语义与 hub 循环（Cairn 式自驱审计）

画布升级为 **fact-intent 二分图**（参考 Cairn 的 blackboard 架构）：agent 不直接决定下一步，只把发现写进画布；**hub agent 读整张图做决策**。

- 节点：`intent`（意图，与角色 job **1:1**，状态即认领态：pending=未认领 / running=进行中 / succeeded=已结论）、`fact`（事实，角色 agent 的产出）。Schema v31 为 Fact 增加独立 `verification_status` 定列（`unverified/verifying/verified/rejected/needs_human`），非 Fact 必须为 `NULL`；该状态不复用节点执行态，也不从证据 outcome 推断
- 边：`from`（被引用事实 → 新意图）、`to`（意图 → 产出事实；收敛时 事实 → root）
- Fact 过程真相由 `GET /canvases/{id}/facts` 提供服务端 keyset 分页及验证态、证据种类、Finding、来源 Job 筛选；`GET /canvases/{id}/facts/{nodeId}` 返回完整正文和最多一跳的有界 trace；`PATCH /canvases/{id}/facts/{nodeId}/verification` 记录人工结论与审计。结构化 Finding 证据仅在同项目、同画布、canonical Finding 和 `reviewed_by/tested_by` 边同时成立时投影，禁止解析 description 补关联
- **hub_reason**（job 类型，也是所有任务的统一入口）：输入 = 任务内容 + 服务端 `GraphScope=hub` 投影；需要派发时由 Hub 调用 `list_available_roles` 动态系统工具获取数据库角色，再通过 `submit_hub_decision` 提交 complete 或 intents；intent 的 `prompt` 必填并直接注入 Worker CLI，首次决策不得在没有执行证据时直接完成
- Hub 可下发工作角色输入 = 自包含 intent prompt + 服务端 `GraphScope=agent` 引用邻域；执行中每发现一个新事实就调用 `emit_fact`，一轮可产出多个增量事实并立即建立 fact 节点 + to 边；`audit` 则用 `emit_finding`
- **事件触发，无定时任务**：角色 job 的 `done` 事件 → `finalizeJob` → 同事务触发 hub（单画布同一时间最多一个活跃 hub；`maxHubRounds` 轮次上限防失控）
- 规则：`hubEnabled`（默认 true，per-project `config_json.rules` 或 `DEEPSONAR_HUB_ENABLED` 可覆盖关闭）、`maxHubRounds`、`maxIntentsPerDecision`；`allowEgress` 同样默认 true，任务创建时可覆盖并冻结到画布
- **角色注册表（Phase ② 已落地）**：`schema.sql` 只负责首次建库写入可编辑的内置模板，运行时以 `agent_roles` 为唯一真相。Hub 需要派发时主动调用 `list_available_roles` 平台工具；工具从数据库查询 `kind='role'`，再按项目 `config_json.roles.enabled` 过滤，不把角色清单预埋进 prompt，也不维护代码侧固定角色枚举。`submit_hub_decision` 落地时调度器用同一数据库边界再次校验，缺失、停用或 system/hub 角色会令整次决策失败，不做默认回退。默认模板包含 `audit/explore/analyze/review/test/code` 六个工作角色；所有 `kind='role'` 条目（包括内置模板）都可删除或新增。`verify/report` 为调度器专用系统角色，`hub_reason` 为唯一中枢，三者都不进入 Hub 可派发清单且不可删除，但职责描述和 RoleConfig 均可修改。其中 `audit` 产出 Finding，其余工作角色产出 Fact
- **角色颜色（Schema v16）**：`agent_roles.ui_color` 仅允许 `#RRGGBB`，由 Scheduler 在创建事务内持 `deepsonar_role_color_allocator` advisory lock，从非语义保留色的共享调色板分配；调色板耗尽后先用稳定、最大间距的 HSL 候选，再用覆盖完整 `2^24` 色域的确定性 RGB 置换，跳过保留色、已占用色和过暗颜色，色域真正耗尽才失败。删除角色会释放颜色，导入包里的颜色只是提示，保留色/冲突色/缺失色会在同一锁内重映射；system / hub 角色始终为 `NULL`。角色 Job 创建时把最终色冻结进 intent/job `body_json`，旧节点安全回退语义色；前端边 stroke/marker 取源节点最终色，`edge_type` 只控制 dash 与动画速度。
- **语义事件限流（Schema v17 / Issue #57）**：`job_event_rate_limits` 为每 Job 持久化固定窗口计数行；`progress`、普通语义事件与 `done`/`human` 终态控制事件使用独立预算。摄入事务在 dedup 后锁行并原子递增；超限是带 `event_rate_limited` 与 retry 元数据的全事务拒绝，重放不占预算。
- **事件触发任务**：`POST /projects/{id}/events` 接收 `source/event_type/event_id/data`；`project + source + event_id` 唯一，重复投递返回原画布和入口 Job，不重复执行
- Phase ③：elkjs 分层布局 + hint 注入（human 节点已入 hub 上下文 hints）

### 8.6 图上下文预算与读图作用域

调度器在服务端按 Job 类型生成分级图投影，不把整张过程图直接注入每个沙箱：

| Scope | 默认字符硬预算 | 注入内容 |
|-------|----------------|----------|
| `hub` | 48,000 | 全 Finding `verify_status` 索引、开放意图、事实索引、近期/触发相关摘要与 hints |
| `agent` | 16,000 | 自包含 prompt 作为独立主输入；图投影仅提供 intent 元数据、`from` 引用邻域与已确认背景 |
| `verify` | 24,000 | 目标 Finding 与相关验证证据短字段；硬门权威仍是冻结证据快照 |
| `report` | 8,000 | 目标与状态元数据；完整输入以 Scheduler 生成的 `report-input.json` 为准 |

预算由 `MAX_GRAPH_YAML_CHARS_HUB/AGENT/VERIFY/REPORT` 配置但由 Scheduler 强制执行。超预算时投影写入顶层 `truncated: true` 与 `omitted` 计数；返回的 `referableIds` 始终来自完整画布，供服务端校验 `intent.from`。每次投影的 scope、字符数、节点计数和截断状态写入 Job runtime evidence，并暴露为 Prometheus 计数器。

`report` Job 的 `payload_json.kind` 区分 `task_report` 与 `finding_report`。前者绑定画布 Root 的 `analysis_complete → reporting → succeeded` 生命周期并消费 Scheduler 生成的任务级 `report-input.json`；后者只绑定一条已确认 Finding，消费带 SHA-256 校验的冻结输入，不推进 Root，也不改变 Finding 的 `verify_status`。单 Finding 输入由 `MAX_FINDING_REPORT_INPUT_CHARS`（默认 40000）限制；截断时冻结 JSON 显式记录 `input_truncated`、预算与各类省略计数，Executor 在注入模型前再次执行同一上限。

---

## 9. 安全与资源策略

### 9.1 威胁建模：被审计代码 = 不可信输入

这是审计平台与普通 AI 工作流的本质区别：

| 威胁 | 对策 |
|------|------|
| 被审计代码中埋 **prompt injection**（注释诱导 Agent 乱提案、外泄源码） | 审计沙箱默认**断外网**；工具白名单收口；followup 频次/深度护栏（§4.3）；system prompt 中声明仓库内容均为不可信数据 |
| 目标内容或 Agent 伪造 Finding profile/评分、借未来 CVSS 版本绕过策略 | Finding 协议在画布冻结；Agent 只能调用严格 MCP 或同名 Job-scoped API operation 提案；Scheduler 重算 CVSS、按 accepted_versions 拒绝或原样留存未知版本，不能由 prompt 改写规则 |
| **PoC 由 Agent 生成**，验证 = 在沙箱执行半不可信代码 | verify 沙箱独立隔离、一次性、跑完即毁；出网白名单 |
| finding 内容含恶意 HTML/JS | finding 一律当纯数据存储；画布前端渲染防 XSS（不渲染 raw HTML） |
| 事件通道被滥用（伪造 finding、刷事件） | 事件不经沙箱网络，只走 SDK 控制通道；沙箱内无调度器凭据；payload schema 校验 + 大小上限 + 每 Job 持久化固定窗口速率限制 |
| 任务内容诱导 Agent 指定恶意镜像 | Hub 不输出镜像 ID；Scheduler 只从可信目录和 RoleConfig 解析并冻结 digest；未准入/未项目启用版本无法建 Job |
| 第三方镜像供应链投毒 | 独立准入 Worker + 固定 digest 扫描器 + 验签/SBOM/漏洞/凭据/恶意文件检查 + 管理员提升 + 周期复扫自动撤销；官方镜像每次扫描均按 `DEEPSONAR_IMAGE_REGISTRY` 选择同 digest 的已核验引用，缺少部署源证据时 fail closed，不回退其他 registry |

### 9.2 资源配置（MVP 默认）

| 项 | 配置建议 |
|----|----------------|
| 全局并发沙箱 | 4～8 |
| 单项目并发 | 1～2（`global_settings` 可调；项目不能放宽） |
| 默认超时 | audit 30–60min；verify 15–30min |
| Lease TTL | 120s，心跳 30s |
| 网络 | 项目默认 + 任务覆盖只得到一个 `allow_egress` 布尔值（Hub 与 Worker 共用）；模型请求始终经 `/gateway` 和固定 proxy，允许出网使用 `deepsonar-sandbox-gateway` NAT bridge，禁止出网使用 internal bridge + proxy |
| 工作区 | 每个 Job 使用全新可写 `/workspace`；Worker 自行决定是否获取代码或其他材料 |
| 密钥 | 仅调度器注入，不进画布正文 |
| 审计日志 | 所有语义 event 落库；原始流进冷存储；均可导出 |
| 敏感信息 | transcript 含客户源码、finding 可能含挖到的硬编码密钥 → 冷存储 at-rest 加密、访问走鉴权端点、finding 展示前密钥脱敏（gitleaks 规则） |

---

## 10. 演进与 as-built

MVP 分阶段 checklist 已过时（主路径早已落地：本地任务、Hub 闭环、Verify/Report、镜像市场、多 CLI 等）。

- **当前 as-built**：根目录 `DESIGN.md`、本文件与代码
- **开放演进**：GitHub Issues（`DESIGN.md` §11 索引）
- **部署**：[ONE_CLICK_DEPLOYMENT.md](./ONE_CLICK_DEPLOYMENT.md)、`deploy/README.md`

---

## 11. 目录结构

```text
deepsonar/
  apps/
    scheduler/          # Fastify 调度、Hub、Verify、Gateway
    web/                # React 工作台与画布
    image-admission/    # 第三方镜像准入 Worker
  packages/
    plane-client/       # 可选 Plane 集成
    runtime-sandbox/    # agentbox-sdk（local-docker / e2b / daytona）
    shared-types/       # zod 契约单源
  agent-harness/        # 镜像定义、指纹、冒烟
  deploy/               # Compose、一键脚本、运行时清单（见 deploy/README.md）
  database/schema.sql   # 唯一 schema 基线
  docs/
    ARCHITECTURE.md     # 本文档
    ONE_CLICK_DEPLOYMENT.md
```

---

## 12. 配置项清单

```text
PLANE_BASE_URL=
PLANE_API_TOKEN=
PLANE_READY_STATE=Ready

MAX_GLOBAL_JOBS=20             # global_settings 未配置时的启动默认
MAX_JOBS_PER_PROJECT=5         # global_settings 未配置时的启动默认
PROVISION_CONCURRENCY=2        # global_settings.maxConcurrentProvisioning 缺失时的 fallback；vfs 主机在 DB 中设为 1
PROVISION_TIMEOUT_SEC=900       # 生产 Compose 默认；覆盖 rootless vfs 的 4-8 分钟冷 create

DEFAULT_AUDIT_TIMEOUT_SEC=18000
DEFAULT_VERIFY_TIMEOUT_SEC=10800
LEASE_TTL_SEC=120
HEARTBEAT_INTERVAL_SEC=30
REAPER_INTERVAL_SEC=30

DEEPSONAR_HOST_DISK_PATH=/
DEEPSONAR_HOST_DISK_WARNING_PERCENT=85
DEEPSONAR_HOST_DISK_ERROR_PERCENT=90
DEEPSONAR_HOST_DISK_CHECK_INTERVAL_SEC=30
DEEPSONAR_RUNTIME_IMAGE_GC_INTERVAL_SEC=21600 # 0 关闭

AUTO_VERIFY_SEVERITIES=low,medium,high,critical
MAX_FOLLOWUPS_PER_JOB=60
MAX_FOLLOWUP_DEPTH=12
MAX_AUTO_RETRIES=6

DEEPSONAR_HUB_ENABLED=true
DEEPSONAR_HUB_MAX_ROUNDS=20
DEEPSONAR_HUB_MAX_INTENTS=6

SANDBOX_PROVIDER=local-docker
DOCKER_IMAGE_AUDIT=deepsonar-agent:latest
DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE=docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23

# Scheduler-authoritative semantic-event fixed-window budgets (Issue #57).
# progress and terminal/control events use independent buckets.
EVENT_RATE_LIMIT_WINDOW_SEC=60
EVENT_RATE_LIMIT_PROGRESS_PER_WINDOW=30
EVENT_RATE_LIMIT_STANDARD_PER_WINDOW=120
EVENT_RATE_LIMIT_TERMINAL_PER_WINDOW=8

BLOB_STORE=fs
BLOB_DIR=./data/blobs
# Shared-asset multi-node: BLOB_STORE=s3 + BLOB_S3_* (any S3-compatible API)
# BLOB_S3_ENDPOINT=http://127.0.0.1:9000
# BLOB_S3_BUCKET=deepsonar
# BLOB_S3_ACCESS_KEY_ID=
# BLOB_S3_SECRET_ACCESS_KEY=
# BLOB_S3_FORCE_PATH_STYLE=true
TRANSCRIPT_RETENTION_DAYS=90
EVENT_FLUSH_INTERVAL_MS=2000
EVENT_FLUSH_MAX_KB=32
SEARCH_STATEMENT_TIMEOUT_MS=3000
EVENTS_PARTITION_RETENTION_MONTHS=6
CANVAS_LAYOUT=auto
```

调度并发的运行时权威源是设置页或 `PATCH /global-settings` 写入的
`global_settings.rules_json`。有效值可通过 `GET /global-settings` 的
`effective_rules` 查看：包括 `maxGlobalJobs`、`maxJobsPerProject`、
`maxConcurrentJobs`（项目有效上限）与 `maxConcurrentJobsSource`。项目列表/详情额外返回
`active_jobs` / `max_concurrent_jobs` / `max_concurrent_jobs_source`。修改规则会发送
`pg_notify('deepsonar_jobs')`，无需重启即可影响后续 claim；已运行 Job 不会被强制终止。

---

## 13. 风险与对策

| 风险 | 对策 |
|------|------|
| Agent 胡写、死循环派生 | 白名单工具 + followup 频次/深度护栏 + 超限转人工 |
| 被审计代码 prompt injection | 见 §9.1 威胁建模（断网、白名单、payload 校验） |
| 沙箱/调度器崩溃任务悬挂 | Lease + 心跳 + Reaper（§3.3） |
| vfs 慢删造成僵尸容器/卷和旧镜像堆积 | destroy 有界重试 + 启动/周期 desired-state 对账；DB-known 非强制镜像 GC；`statfs` error 水位暂停新 claim，恢复后 notify |
| 事件重试产生重复副作用 | event_id 幂等 + finding fingerprint 去重（§6） |
| 事件顺序错乱（时钟偏差） | 自增 id 全局序 + job_seq 局部序，不信 created_at |
| 原始事件流撑爆数据库 | 热冷分层（§6.2）：语义事件入库，原始流进文件 |
| 大字段读放大 | 列表不含 payload、blob 单独端点、WS 只推引用（§6.4） |
| 备份体积失控 | 库内无原始流，pg_dump 保持 MB 级；冷存储文件级快照 |
| 敏感信息二次泄露（源码/密钥进 transcript 与 finding） | at-rest 加密 + 鉴权访问 + 展示前脱敏（§9.2） |
| 与 Plane 状态不一致 | 以 jobs 表为准；定时 reconcile |
| 画布节点爆炸 | 按 job 分组折叠；finding 按 fingerprint 合并展示 |
| CLI 输出不稳定 | Harness 强约束 JSON schema；失败可重试 1 次 |
| 双看板诱惑 | 明确 Plane 给人、不引入第二套 PM 直到有明确痛点 |

---

## 14. 开工顺序

1. 建仓库 + `docker-compose`（Postgres）
2. 按 §6 建表（**一次把 event_id / fingerprint / lease 字段建对**）
3. 实现 `jobs` 状态机 + 手动 `POST /jobs` + Reaper
4. Plane 适配器：list ready / update state
5. runtime 适配层：agentbox-sdk local-docker 最小封装
6. 假 Agent 脚本打通 Event → DB（含幂等重试演练）
7. 再挂真 CLI 与画布 UI

---

## 15. 结论摘要

| 决策 | 选择 |
|------|------|
| 项目管理 | **Plane** |
| 过程数据 | **每项目一张无限画布**（nodes/edges 表为真相） |
| 执行隔离 | **agentbox-sdk 沙箱**（local-docker 起步，可切云端 provider） |
| 调度 | **自研薄调度 + 状态机 + Lease/Reaper**（单实例） |
| Agent 智能 | **提案式工具**；派生决策收归规则引擎 |
| 可靠性 | **事件幂等 + finding 去重 + 崩溃可恢复** |
| 安全 | **被审计代码视为不可信输入**，沙箱默认断网 |
| MVP 范围 | 单 CLI、单审计类型、自动高危验证、画布可展示链条 |

按 **Phase 0 → 3** 做，就有一条可演示的闭环：**Plane 下发 → 沙箱审计 → 画布记过程 → 自动验证 → 状态回写**，且崩溃不悬挂、重试不重复、注入难失控。

---

## 16. 已知取舍（明确记录，避免后期争论）

- **单 Scheduler 实例**：MVP 假设单实例运行，claim 靠 DB 唯一约束兜底。多实例扩展时改用 `SELECT ... FOR UPDATE SKIP LOCKED` 竞争领取，接口不变
- **DB 轮询而非 Webhook/Redis**：延迟秒级可接受；二期再升级
- **画布不做多人协同编辑**：第一期只读展示 + 服务端写入；协同编辑是二期候选
- **verify 不直接派生下游**：Verify 只提交 verdict；Scheduler 依据硬门决定 confirmed、回弹 Hub 或 needs_human，并以多轮/深度/Hub 轮次护栏防止链式失控
- **运行时选 TwillAI/agentbox-sdk（MIT）**：TS SDK 统一驱动沙箱与 Agent，事件走控制通道不经沙箱网络（化解"审计沙箱断网"与"事件回调"的矛盾，沙箱内零凭据）。已知风险：0.1.x 早期项目（2026-07 仍活跃），靠 runtime-adapter 接口隔离，最坏情况 fork local-docker provider（代码薄）
- **沙箱内权限完全开放**（`approvalMode: "auto"`）：安全边界在沙箱层（断网/隔离/一次性），不在 Agent 层做二次权限收敛
- **用量账本**：`job_usage_ledger` 已记录按 Attempt/effect 关联的请求与 token 观察结果；额度缓存仍由 `job_tokens` 熔断，成本定价不在本阶段计算
- **不评估 Claude Agent SDK**：只用 CLI 路线（经 agentbox-sdk 的 claude-code provider）
- **不引入低代码 LLM 编排平台（Flowise / Dify / n8n / Langflow）**：它们是完整产品而非可嵌入组件，无法替代沙箱调度（不管容器生命周期、无 lease/reaper、无 Plane 同步），且会与 Claude Code CLI 的 agentic loop 重复、制造第二控制面；Flowise 另有默认无认证的安全记录问题（RAXE-2026-033）与被收购后的路线图不确定性。其画布 UI 底层即 React Flow，反向印证画布选型
- **画布引擎选 React Flow 而非 tldraw/Excalidraw**：画布本质是结构化节点-边图而非白板；React Flow（MIT）与 nodes/edges 表 1:1 映射、节点即 React 组件（finding 卡片可交互）；tldraw 生产商用有授权费用、Excalidraw 无法嵌入 React 节点。若二期需要手绘标注/多人白板协同，再单独评估 tldraw
- **全 TypeScript**：配合 React Flow 生态一套类型打通；若未来 CLI/沙箱层需要 Python 工具，通过容器内独立进程解决，不引入第二后端语言
- **迁移工具落地为手写 SQL + 轻量 runner（约 30 行）而非 Drizzle Kit**：SKIP LOCKED / 分区 / 部分索引等裸 SQL 友好、少一层 ORM 抽象；查询层用 postgres.js。纪律不变（顺序编号、启动自动 up、禁止手改库）

---

## 17. 扩展性与演进策略（改表不慌的依据）

### 17.1 稳定区 vs 自由区

| 稳定区（定列、加约束，几乎不变） | 自由区（JSONB 吸收变化） |
|----------------------------------|--------------------------|
| 状态机字段（status, lease, timeout） | `jobs.payload_json`（任务参数随类型变） |
| 幂等键（`event_id`、`fingerprint`） | `events.payload_json`（事件内容随类型变） |
| 外键骨架（project → job → event/finding/node） | `findings.raw_json`（SARIF 原文） |
| 时间戳、error | `canvas_nodes.body_json`、`projects.config_json` |

判断标准：状态机/去重/限流逻辑依赖的字段进列；"内容是什么"的字段进 JSONB。类型字段（`jobs.type`、`node_type`、`status`）一律用**字符串**，不用 Postgres enum——新增类型零迁移。

### 17.2 Schema 纪律（schema-only，无增量 migration）

- **唯一真相**：`database/schema.sql` + `SCHEMA_VERSION`；无 `database/migrations/`
- **启动行为**：空库原子套用基线；非空库校验 `schema_meta.version == SCHEMA_VERSION` 与表/列结构，不符 fail closed
- **改表**：直接改基线、bump 版本、**重建数据库**；不写增量 ALTER、不留旧结构 fallback
- 运维可将旧库备份后套最新基线，再按列名交集回填（`pnpm db:rebuild`）；Scheduler 启动路径仍 fail closed
- 跨环境复制项目配置用 `.deepsonarpack`，不是 schema 升级工具

### 17.3 事件格式版本化

`events.payload_json` 约定 `v` 字段（`{ v: 1, type: "finding", ... }`）。格式演进时：新事件用新版本号落库，**历史数据不回填**（事件 append-only，本就不该改），读取端按 `parsers[v][type]` registry 分发解析。

### 17.4 扩展场景验证（设计时已推演）

| 未来场景 | 改动面 | 需要重建库 |
|----------|--------|------------|
| 新增任务类型 / 节点类型 / 事件类型 | 字符串新值 + JSONB 新形状 + 应用层代码 | ❌ |
| 自由区字段高频查询（如 CWE 编号） | 改 `schema.sql` 加列 + bump 版本 | ✅ |
| 换沙箱 provider / 多 Scheduler 实例 | 适配层/领取逻辑，表不动 | ❌ |
| 状态机加状态 | status 新字符串值 | ❌ |

总原则：**表结构管"关系和不变量"，JSONB 管"内容"，版本号管"格式"，重建库管"物理变更"。** 真正危险的是把易变内容固化成列，§6 已规避。

### Issue #12 调度语义补充：资格与排序分离

`jobs.priority` 只保存 `fixedPriorityForJob` 生成的固定语义档位；Hub
轮次、父 Job 和 severity delta 均不得累加。调度器先判断图资格，再在
固定档位内按 `created_at, id` FIFO（Verify 档位仍保持
critical > high > medium > low/info）。`minVerifySeverity` 同时定义自动 Verify、
care/wait 门与收敛集合；明确低于阈值的 Finding 保持可审计但不创建 Verify
round/Job，也不阻塞 complete/Report。缺失或未知 severity 保守进入 Verify，
`minVerifySeverity=info` 保留严格全量模式。

证据不足时，`finding_verification_rounds.requirements_json` 写入
`eligibility = "waiting_evidence"`，Finding 的 `raw_json.verification_state`
同步记录同一资格；此时不创建可运行的 `verify_finding` Job。补证 Hub
在无活跃 Hub、普通角色或 `waiting_human` Job 后按证据快照至多唤醒一次，
证据齐全后复用该 round 绑定 Verify Job。
