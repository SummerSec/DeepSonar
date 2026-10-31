# 06 运行时视图

> 状态：**as-built**（#741；#767/#775 同步）。描述任务从入口到报告的正常链路，以及越权、超时、取消、重启、未知效果和人工路径。
> 同步日期：2026-10-31

运行时主线由 Scheduler 编排，Hub 和 Agent 都通过有界上下文和 Job-scoped Control 操作参与。Canvas 是过程/观察真相，Artifact 是结构化内部写入真相，Evidence 是沙箱执行与原始证据真相，报告是冻结输入后的投影；不能用制造者文本互相替代。Job/Attempt 状态的完整规则见 [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](../ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md)。

## 凭据与 CLI 解析（#757）

`resolveProviderCredentialForJob` 是 readiness 与 Job 创建共同使用的解析入口，需求见 [FR-CRED-002](01-system-specification.md#fr-cred-002-providermodel-catalog-与兼容性)。解析先限于本项目或全局的 active Provider 账号，以及独立的项目 CLI / 凭据白名单，再校验 Provider 协议与模型要求；不能先用系统 CLI 种子筛掉唯一有效账号。

1. Hub 的 Provider/model 需求、项目默认模型和全局角色模型按既有优先级形成模型要求；模型按每张凭据的 CLI 方言核对配置清单。
2. Hub 显式 CLI 是硬约束，与候选冲突继续 `provider_credential_cli_mismatch`（`permanent_failure`）；不能通过改选 CLI 绕过排他绑定。
3. 唯一候选直接决定 CLI。只有跨 CLI 多候选才用项目 `default_agent_cli` > 全局 RoleConfig 显式 CLI 作软偏好；全局种子 NULL 不构成偏好，用户显式 `claude-code` 构成偏好。项目默认凭据只在剩余候选内查找，不能绕过模型/CLI/授权条件；仍不唯一时返回 `provider_credential_multi_match`，提示收窄需求或由管理员配置默认凭据。
4. 未配置凭据白名单时动态读取当前作用域候选，不在读取时写入 ID。显式白名单及默认凭据的删除、停用或不可访问引用返回 `provider_credential_allowlist_stale`（`permanent_failure`），RepairFeedback 指向管理员修复名单；既不扩大授权，也不把权限修复交给模型。
5. 选中的账号、CLI、Provider/model 按原规则进入新 Job 快照。账号 × CLI 1:1、并发计账和 Gateway 密钥隔离不变；不修改任何已有 Job 快照或镜像准入。

实现入口：[凭据解析](../../apps/scheduler/src/domains/provider-adapter/resolve-credential.ts)、[快照组装](../../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)、[readiness](../../apps/scheduler/src/readiness.ts)。

## 正常链路

```mermaid
sequenceDiagram
    actor U as 用户/Web/API
    participant C as Canvas/Task
    participant H as Hub
    participant S as Scheduler
    participant J as Job/Attempt
    participant K as Job Control
    participant A as Agent/Control
    participant V as Verify
    participant R as Research
    participant P as Report

    U->>S: 创建项目任务（管理认证、项目 scope）
    S->>C: 创建 root/Intent 和过程索引
    S->>J: 创建 hub_reason Job，冻结候选配置
    S->>H: claim、Hub 读取有界图投影
    H->>S: submit_hub_decision（完成或受限 intents）
    S->>J: 为 intent 创建 Job，claim 并创建 Attempt
    S->>J: provisioning：校验镜像、网络、凭据、设备和预算
    S->>J: 记录 effect_pending，创建/绑定沙箱并 settling
    J->>A: 激活 capability token，开始 Agent 运行
    A->>S: graph_query + discovery 或 Control operation（Plan v2/Result）
    S->>K: 入口校验后在事务内再次校验 scope、引用、版本、预算、状态和幂等
    S->>C: 写事件、Canvas 投影、Artifact/Finding
    S->>V: 依据 Fact/Evidence 执行 Verify round
    V-->>S: mark_job_done verdict=confirmed/refuted/rework/needs_human
    S->>R: 对冻结 Finding 输入执行语义研究
    R-->>S: cluster/canonical/relative priority 或显式失败
    S->>P: 依据冻结输入生成版本化 Task/Finding Report
    P-->>U: 报告投影、证据索引和审计状态
```

任务入口创建 Canvas 根和 Hub Job；Hub 不直接写 Job 终态，而是提交经过引用和预算校验的意图。Dispatcher 按冻结快照领取 Job、创建唯一 active Attempt、登记 provisioning/agent 外部效果，并在 Agent 结束后由 Scheduler 收敛。所有 Control operation 先由 [`executor-real.ts`](../../apps/scheduler/src/executor-real.ts) 和 Control registry 做入口校验；只读 discovery 返回有界投影，不进入 event-ingestion 语义事件事务。改变语义或外部效果的 operation 再由 event-ingestion 在持久化事务中锁 Job 并重复检查角色、scope、引用、状态和协议；非法输入会回滚该事务的所有副作用。Plan v1 的历史记录只读，`submit_plan`/`submit_plan_result` 的新写入和执行只接纳 v2：授权用户先以 Canvas `plan_objective.expected_revision` 做目标 CAS，模型再以 `execution_route` 做路线 CAS；Scheduler 在同一事件事务中复用既有 Hub Intent materializer 计算 ready task、校验完整路线并创建普通 Worker Job，不建立第二队列或执行通道。`emit_fact`/`emit_finding` 的 side-effects 会调用 Artifact model/persistence，再绑定 Canvas Fact/Finding；Artifact 的 source operation 和绑定关系由 [`side-effects.ts`](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts) 保存。Verify 只消费 Fact、Artifact、Evidence 和独立 Evaluation。Research 只写其语义结果，Report 只把冻结输入投影给用户。

### 任务契约与目标授权派发门（#767）

显式契约在创建前校验，必要条件阻塞返回 409 且不建任务；通过后规范化并保存到 Canvas 和新 Job 冻结快照。契约自声明不构成当前授权。契约请求写目标或声明需要可验证目标身份时，Scheduler 只使用宿主配置的 `deepsonar.target-authorization/v1` 只读 authority：请求绑定当前项目、`reference-http/v1` 目标、认证主体、tenant/role/resource、精确动作链、必需前置条件、原始内容 SHA、规范化契约 SHA、派生 revision 和 authority freshness；response 必须逐项复述并 allow 全部动作、满足全部前置条件，且返回有效 authority revision/expiry。secret、URL、authority ID 和动作链不来自任务、Canvas、Job 或模型。

成功判定只生成 secret-free snapshot，并在创建 Job 的事务中写入 Scheduler-owned `audit_logs` 的 `task.target_authorization` grant。Dispatcher 在 sandbox provisioning 前按冻结 revision 重新检查；`resume-frozen`/`rerun-current` 在中断 Attempt、撤销 grant 或转回 pending 前检查。child/system follow-on Job 只能从该审计账本继承与权威 Canvas 内容/契约一致的 grant；Canvas metadata 不能替代 host grant。配置漂移、缺失/改变 grant、撤权、过期、身份/目标/动作/前置条件或 binding 不匹配均 fail closed；不可重试的 `target_authorization_grant_invalid` 不创建 sandbox、不重放目标动作。

Hub/Report follow-on admission 在 savepoint 内处理该拒绝：回滚本批新 Job，保留前驱已写入的 terminal result，并把 Canvas convergence 持久暂停；Plan v2 依赖 admission 使用同一错误持久停止，不撤销前驱已证明输出。详细协议见 [目标授权专题](../TARGET_AUTHORIZATION.md) 和 [ADR-0011](adr/0011-trusted-target-authorization.md)。若契约不能安全表达写入目标，不自动把原目标降级为只读；由创建者重新下发明确的较窄目标。

## 项目知识工作链（#752 分支）

普通 Job 从冻结目录按需搜索、读取 Memory 或拉取 Skill，实际使用生成稳定 usage_ref；有可读来源或反馈证据时可请求整理。Scheduler 创建独立 work/Canvas，依次分派 maker、按 case×arm 分离的 trial Job、evaluator 与 reviewer；这些都是现有 Job/Attempt/沙箱路径，不新增模型执行者，也不触发业务 Hub/Report。trial 只得到相应 arm 和 stage audience 的输入，发布共享资产 JSON 并以 `emit_fact` 引用其版本/hash，评测读取实际 Evidence；缺环境、证据或终态异常保持 `needs_eval`/阻断，不以文字结论晋升。审查通过才在事务中切 active 指针；失败或重启依持久 assignment/receipt 恢复，未知外部效果不自动重放。项目治理 recipe 在 work 创建时冻结，修订仅进入下一 work。详细状态和预算见[项目知识专题](../PROJECT_KNOWLEDGE.md)。现有集成测试使用构造的 Job/Attempt 与 Evidence，未证明真实沙箱或模型效果。

## 非正常路径

| 触发 | Scheduler 响应 | 结果和后续 |
| --- | --- | --- |
| 无效 token、Job 不属于项目、operation 不在 allowlist、不可见节点或坏 schema | 所有 operation 先做 token/operation/schema 检查；mutating operation 的 event-ingestion 事务内再次锁 Job、检查 scope/引用/语义状态，失败时回滚整笔副作用；401/403/409/422 按错误类别返回，模型可修正项带 RepairFeedback | 不提交部分事实或外部效果；永久越权不可通过重试修复 |
| 同一 Idempotency-Key 重复且输入相同 | 所有 operation POST 都要求 UUID key；只读 operation 使用接口层缓存/冲突检查，mutating operation 还由事件/effect durable dedup 保护 | 调用方可安全读取接口结果；同 key 不同 operation/input 返回冲突 |
| 事件窗口或图查询预算耗尽 | 429 或预算错误，反馈当前状态和剩余预算 | 用新的有界查询/延迟重试修复；不扩大 Job scope |
| provisioning 在外部效果开始前已知失败 | 记录失败并按已知可重试策略决定新 Attempt；Job 进入失败或受控 retry | 只有明确安全的 provisioning 重试允许继续；不重复未知外部效果 |
| effect intent 已写但外部结果未知（例如沙箱句柄/销毁回执缺失） | Attempt effect 标记 `unknown`，Job 进入 orphan/对账路径，保留 effect id | **禁止自动重放未知效果**；由对账或人工确认后采取下一步 |
| 用户取消或 deadline 超时 | 以状态 CAS 收敛 Job/Attempt，停止 lease，撤销 token，执行可重复清理 | 迟到回调不能复活 Job；清理自身若未知也保留 unknown 记录 |
| Scheduler 重启 | preparing 且没有 effect 的 Job 可回 pending；已发 intent、未结算或有外部句柄的 Attempt 走 unknown/orphan | Reaper/reconcile 先对账再清理；不能把“没有日志”当作“没有效果” |
| Agent 调用 `request_human` | 执行器在异步预检前后检查完成预留及终态互斥，防止等待期间已接受完成或人工请求后再覆盖；记录 human message，Job 进入 `waiting_human`；人工回复另走 ACK operation | ACK 与 injected 分离；有回复可回 pending，等待人工预算超时由 Reaper 将 Job 置为 `failed` 并以 `human_timeout` 记因 |
| Verify 等待证据、回到 rework 或进入 needs_human | Verify 域拥有 round 状态；Agent 的合法 verdict 是 `confirmed`、`rework`、`needs_human` 或 `refuted`，Scheduler 可按收敛政策把结果记录为 `inconclusive` | 不以 Agent 总结替代证据门；不可判定结果显式保留 |
| Research 失败 | 在研究 run 中记录失败；savepoint 不回滚主 Finding/Report | 可重新发起有界研究，但不能修改 Verify、严重性或 Fact 状态 |
| Report 失败或输入变化 | 保留旧成功版本，记录当前版本失败或追加新版本 | 报告投影失败不改写内部 Artifact/Finding/Evidence |

Attempt 的 `job_attempt_effects` 先 `effect_pending` 后 settlement，只有代码明确标记为安全的清理效果可重放；未知效果始终需要对账或人工。控制流和清理路径必须写审计并释放设备租约、共享资产卷、token 和沙箱资源。

Gateway 503 仅在内核明确证明请求尚未启动时可降级；`unknown` 或 `pending` 必须硬失败，provider 5xx 文案不构成外部效果 authority。

## 有界读取和语义事件

真实执行器按 `hub`、`agent`、`verify`、`report` scope 构造不同的服务端图快照；Hub 的启动指令明确要求在增量到达后重新调用 `graph_query(overview)`，Worker/Verify/Report 使用各自的任务快照和证据输入。初始 L0/overview 只提供有界 handle；`graph_query(kind=plan_objective)` 是完整 Job-scoped、独立于已接受 Plan 的读取，返回 `items[0]` 持久化 objective tuple，不提供 selectors、cross-scope 或 wholeGraph。预算或 input hash 不满足时明确失败，不写入部分 Plan 读取证明。所有 `graph_query` 都受 kind、引用、脱敏和单次投影硬上限限制；累计字节/调用额度默认不限，只有显式正整数配置时限制。完整响应（包括引用和元数据）超过 [graph-query.ts](../../apps/scheduler/src/graph-query.ts) 的单次响应硬上限 时先拒绝，不写入任何计数、引用或 Plan 读取证明；已接受响应按最终序列化字节计数，反馈剩余字节可保守少报几个字节以避免自引用计数。证据预览不授权被截断的 Fact 引用。该上限只约束单次响应，不限制跨成功查询累积的已见引用集合，也不约束完整 Canvas 加载内存。返回投影会记录本轮可见引用，不能凭猜测提交节点 ID。语义事件必须通过 shared Zod schema、入口 handler 和 event-ingestion 事务三层校验；CLI 文本、伪造工具调用、Shell 控制文件和管理 API 猜测不构成事件。实现入口是 [`executor-real.ts`](../../apps/scheduler/src/executor-real.ts) 和 [`graph-query.ts`](../../apps/scheduler/src/graph-query.ts)。

平台暂停领取的排空判定同时检查在途 Job 与所有 Attempt（包括已终结 Attempt）的 `effect_pending` / `unknown` 外部效果；Attempt 结束不是效果已结算的证明，全部结算前保持 `pausing`（FR-JOB-004 / FR-JOB-006 / FR-JOB-010）。


## 维护升级与业务执行的交界

普通平台暂停仍允许入队；[维护升级](adr/0008-maintenance-candidate-upgrade.md) 增加真正的数据库身份隔离。顺序是只读核验 → 暂停/排空 → 旧身份 NOLOGIN 与会话清退 → 验证备份 → 候选重建 → preparing 服务与节点验证 → 激活。不能通过中止 Job 来伪造排空。目标 preparing 状态关闭业务 HTTP/WebSocket 与后台任务，世代或版本不匹配也保持关闭；数据库隔离仍是旧节点不能写入的依据。

中断续做读取固定目标 journal，重复步骤前核对实际回执。激活前失败回源并保持暂停；激活成功或结果不明时不允许自动回旧数据。维护状态机、宿主/受管 SSH 和显式恢复领取已有实现；schema 61 → 62 的 16 项 Compose 场景及独立知识后台停写场景已通过并清理。具体历史基线与隔离环境见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)，不能据此推定 Windows Docker 全流程、断电或真实模型验证已完成。

## Pi 大输出捕获（#765）

RPC 按[帧与保存预算](../../packages/runtime-sandbox/src/pi-rpc-output.ts)有界扫描；受支持大事件在 workspace 与 Attempt evidence 保存完整脱敏 JSON 后，才生成文本预览。控制字段保留，错误响应不得变成成功；恢复进程共享运行级保存预算，写盘、超额与损坏明确失败并记录 capture_complete=false。元数据与 hash 范围见 [CLI 契约](../AGENT_CLI_RUNTIME_ADAPTERS.md#pi-大输出与证据765)，真实生产重跑未验证。

## Pi 会话观测记忆（#815）

只有能力组合显式选择已注册 OM 时，新 Job 才冻结插件/配置/模型；Scheduler 物化受审 wrapper 的字面配置 loader，并签发与 main 分离的 `observational_memory` Gateway token。`requires_egress=false` 不放宽业务网络，`requires_gateway=true` 要求所有后台模型调用走冻结路由。当前 Session 的私有配置与身份守卫拒绝环境覆盖、配置漂移及切换/分叉，不回读最新设置。

新 Job 的 `freezePiExtensions` 从 Scheduler 选定 `runtimeImage.image_version` 执行 [shared registry](../../packages/shared-types/src/pi-extensions.ts) 的 OM 专属下限，缺失/非法/旧 metadata 拒绝，历史冻结快照不重写。[runtime-adapters](../../packages/runtime-sandbox/src/runtime-adapters.ts) 在 Pi 启动/恢复及首个 prompt 前执行独立 [内容 guard](../../packages/runtime-sandbox/src/pi-memory-image-guard.ts)；缺少 canonical package/entry/wrapper 时不启动 `runAsync`/RPC。实际本地镜像正负例、canonical RPC 与回归证据集中见 [RPC 专题](../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。

有限 Job 总额要求显式主/后台分配且不超额；总额不限时不推导百分比。Gateway 按全部 token 历史累计，在 Job 锁内预留并结算；pending/unknown 保守阻断后台，单次上游尝试不自动重放未知效果，终态撤销全部 workload token。只有精确已知 quota 或 `effect_status=not_started` transient 可让 wrapper 发出可见 diagnostic 并交回 native compaction；权限、协议、snapshot、pending/unknown 和任何 extension_error 保持硬失败。

后台请求只有在内核严格确认请求前 transport 失败、且持久写入零用量和 effect `never_started` 后才返回 `503 gateway_transient/not_started`；请求次数不退还，settlement 失败保留 pending/unknown 并返回 409，provider JSON/SSE/refusal 不能伪造该分类。详见 [Gateway 专题](../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。

有界 recall、新 Session/RPC 大帧归档与 viewer 脱敏保留控制身份，memory 不贡献 Fact/Evidence/完成 authority。历史 HTTP preview/download 已在截断/发送前按 Pi header/manifest 独立脱敏，immutable archive metadata 不变，projection bytes/SHA/Content-Digest 另报，相关集成已通过。实际本地 base 镜像 canonical RPC 和独立生产 guard 已验，证据见上述 RPC 专题；最终组合 CI、发布通道/平台和 registry/catalog 仍另验，质量/成本收益 unknown。源码见[wrapper](../../agent-harness/pi-observational-memory-governed.ts)、[共享脱敏策略](../../packages/shared-types/src/pi-observational-memory-redaction.ts)与[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。Runtime、历史归档和 Web 复用该浏览器安全策略；Node 流式缓冲留在 runtime-sandbox，Web 隔离镜像无需复制运行时源码。

## DSH 子代理与完成门（#766）

对应 FR-CRED-005。DSH 父会话 idle 时若仍存在受认证谱系下的活跃子代理，不触发完成门、催促或 shutdown。只有对应 `subagent.finished` 结束该轮子代理活动；子 idle 不是完成依据，恢复 running 会重新计入活动。全部子代理完成后等待父会话接收结果并再次 idle，再按原完成回执契约结算。父错误、Job 超时与取消仍可终止运行。验证入口是现有 `ci:unit:runtime-sandbox` 中的 `runtime-dsh-recovery.test.ts`（新版真实协议回放）及 CI 的 DSH Cordis Docker smoke。

## Plan 单步决策（#775 B 历史只读）

B 首片的既有 Hub Intent 可携带 `plan_basis`，绑定当前 Plan/任务输入/证据/事件 revision；`graph_query(plan_gap)` 保存有界已读证明，补证仍沿既有 Intent → Job/Attempt/Evidence 路径，完成需要全部判据当前正向操作员授权。持久接纳回执只用于恢复原响应，不启动新执行。历史 v1 Plan/Result 可供审计和投影读取，但新的 Control 写入不再以 v1 作为执行输入；v1 未派发路线修订也只保留历史回放边界。详见 [Plan 范围](../PLAN_GAP_PROJECTION.md#b既有-intent-上的一次补证)。

## 目标约束传播与候选准入（#767）

所有已有契约执行统一基本完整性和整契约摘要绑定；冻结与压缩保留约束段。先持久观察 Fact/Artifact，再对研究候选逐判据检查；至少一项验收贡献不是整体完成。赏金追加规则筛选不替代独立资格。候选继续既有技术 Verify，unknown/不符拒绝 Finding；拒绝不会自动保存未提交观察。详见[通用标准与研究候选](../TASK_OUTCOME_ADMISSION.md)。

Plan 接纳采用事务外 preflight → Canvas/Job 锁内本地 prepare 与持久回执 → 原 Attempt commit；最终事件仍经既有 ingestion 结算。缓存或 handler 丢失可读原响应，不启动新执行。 详见 [持久化边界](../PLAN_BOUNDED_INTENT_DESIGN.md#持久化与原子性)。

## 目标结果与 Plan 显式关联（#767）

Task result 通过 emit_fact 写入版本 Artifact；delivery/negative_result 可由隔离来源 Job 评审，blocked/not_executed 仅留缺口。报告重核最新来源、实际字节与完整评价集合。Plan 可选关联已接线：操作员显式选择任务判据，接纳后失效仍阻止最终完成；持久接纳不是执行结算。详见[结果评审](../TASK_RESULT_REVIEW.md)、[Plan 关联](../PLAN_GAP_PROJECTION.md#可选目标评审关联767)及[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## 程序规则附加评审（#767）

程序规则附加评审复用普通 goal_review Job 与既有 Artifact/Evidence，不增加执行通道；仅 supplied bounty Finding，program_rule:<ruleid> 与通用目标 criteria 分开。报告按同 Finding/整契约重核完整规则评价集合，失效/冲突/预算不足不得提升。详见[评审](../TASK_GOAL_REVIEW.md)与[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

Plan 的 supplementation_execution 从已提交 continue 决策及完整 child/Intent/Attempt 关联重建一次补证生命周期；接纳回执不算执行，后续 Hub 不算补证 child。 见 [Plan 执行投影](../PLAN_GAP_PROJECTION.md#一次补证的执行投影)。

## Plan v2 执行（#775 C）

本节“执行完成”专指 `plan_execution.stop_reason=complete` 和 objective `status=completed` 的工程投影：依赖输出条件已经满足，不授予任务语义完成。后续 Hub/Report 仍由 `criteriaAuthorizeCompletion` 和当前来源重验阻断未获操作员正向授权的收敛。

授权用户通过 `PATCH /tasks/{canvasId}` 提交 `plan_objective.expected_revision` CAS，Scheduler 在 Canvas 行锁内保存目标 ID/revision、完整 CompletionPolicy、生命周期预算、输入 SHA 和状态。模型只能提交与当前用户目标恒等的 v2 Plan；`submit_plan` 必须带 `execution_route` CAS，目标 revision、路线 revision、Plan SHA 和已派发 task 的字节身份都要匹配。用户目标修订、路线重提或新 Idempotency-Key 不能重置已消耗的 lifetime task/round/no-progress 预算，也不能让旧目标 Job/Attempt 的输出成为新目标依赖。

Scheduler 先对完整路线做 Hub Intent admission，再在同一 event-ingestion 事务中调用现有 Hub Intent materializer；任一延迟 task 越权或快照/镜像/CLI/Provider/model/Finding/Verify/网络/共享资产检查失败，整条提案拒绝，不留下部分 child Job。Plan v2 没有专属队列或第二执行通道，普通 Hub/Worker Job 仍使用既有 Job/Attempt 生命周期。

`depends_on` 只有在前置 Job 与最新 Attempt 成功、当前目标 revision/task SHA 匹配、submitted 且未 superseded 的 Artifact/Finding/Fact 保持有效，并且 Artifact 与对应 semantic event 的严格 `plan.output` 绑定覆盖全部 `expected_outputs` 时才释放。每项输出还必须由当前 Attempt 的实际留存 Evidence 通过路径、finalized manifest、长度和 SHA 校验；这只是工程上的来源/留存关联，不是语义完成 authority，单独的 done、PlanResult 或 Artifact 绑定不能释放依赖。

Scheduler 将取消、超时、失败、缺失输出、无进展、预算耗尽和 unknown external effect 持久写入停止状态；未知效果 fail closed。只有当前目标全部 task 输出齐全，并通过完整、当前、正向且由操作员授权的必要判据，以及既有 Verify/Report/Task 完成门，才能收敛为 complete；`PlanResult.complete` 只是模型提案。target authorization grant 在后置 Hub/Report admission 中失效时，savepoint 回滚该批新 Job、保留前驱 terminal result 并暂停 Canvas；Plan 依赖 admission 使用同一 `target_authorization_grant_invalid` 持久停止，不撤销前驱已证明输出。

当前实现入口为 [`plan.ts`](../../packages/shared-types/src/plan.ts)、[`objective.ts`](../../apps/scheduler/src/domains/plan-protocol/objective.ts)、[`execution.ts`](../../apps/scheduler/src/domains/plan-protocol/execution.ts)、[`execution-output.ts`](../../apps/scheduler/src/domains/plan-protocol/execution-output.ts) 和 [`side-effects.ts`](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)。离线/隔离 PostgreSQL 夹具可验证 CAS、依赖、留存字节、停止和历史拒绝；v2 replay 的分项结果与 dirty provenance 限制见[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)，不能写成 `5619154f` 精确最终验收，也不是 17 个独立测试。最终组合 CI、真实模型、生产部署、独立人工质量集和冻结留出阈值未由此替代。

2026-10-31 的 terminal/bootstrap 回归已通过；其中 `finalizeJob` core 终态事务把 Job/model token、Control token、audit 与终态收口放在一起，终态后实际 HTTP 请求为 401，`gateway-token-revocation.ts` 复用调用方 Job 锁且不吞失败。该核验只覆盖这条 finalizeJob 路径，不推断所有 drain/Reaper 清理路径。schema rebuild/restore 的完整本地夹具证据见[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## Plan 未派发路线修订（#775 v1 历史）

该 v1 路线修订仅作为不可变历史记录读取；当前路线修改使用上文 v2 `execution_route` CAS。历史事件、快照和回执不改写，未知效果、待结算回执或失效目标都不能借旧协议恢复执行。详见[路线生命周期](../PLAN_GAP_PROJECTION.md#未派发路线修订)。
