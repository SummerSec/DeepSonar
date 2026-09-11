# DeepSonar Design

> 当前 as-built 设计与演进边界。本文给 Agent、贡献者和运维人员先读。
>
> 权威顺序：代码、`database/schema.sql`、OpenAPI、测试 > 本文；专题文档状态见 [`docs/README.md`](docs/README.md)。长期 AI-native 方案见 [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)。

## 1. 设计判断

DeepSonar 的产品形态是“可信执行内核 + 可组合能力”。模型负责理解目标、选择能力、提出计划、读取状态、修正错误和判断业务收敛；内核负责把这些提案变成有权限、有预算、有证据、有账本的执行。

这意味着“一切皆插件”只适用于业务能力和交付投影。沙箱、凭据、镜像准入、Job/Attempt、租约、并发、资源预算、幂等、副作用结算、审计和未知外部效果永远属于内核。插件不能通过第二套控制通道绕过这些边界。

当前主路径是可运行的 Loop Graph：`Canvas` 是任务，Hub 根据图状态产生 Intent，Scheduler 创建 Job，Worker 在一次性沙箱中执行，结构化事实进入 Canvas，Verify、Research 和 Report 再将结果收敛。现有角色是内置 capability pack 的默认组合；未来可以由模型组合平台已经准入的能力，也可以在受治理范围内生成任务级临时组合。

## 2. 四层真相与职责

| 层 | 唯一职责 | 真相 | 不能做什么 |
| --- | --- | --- | --- |
| PostgreSQL / API | 管理与审计 | 项目、Canvas、Job、配置、权限、账本 | 不把模型文本当状态 |
| Canvas | 过程编排与观察 | root、Intent、Fact、Artifact、Finding、Job、边和广播 | 不由 Agent 提交坐标或直接改状态 |
| Sandbox / Evidence | 执行与原始证据 | 进程、工具、Session、产物、运行流 | 不保存长期凭据，不成为控制队列 |
| Scheduler | 副作用唯一执行者 | claim、状态迁移、派生 Verify/Report、结算、清理 | 不替模型做领域推理 |

固定原则：**本地库是管理真相，画布是过程真相，沙箱是执行真相，调度器是唯一有副作用的执行者。** Web 是管理平面，画布是只读投影；真实 Job 的语义写入只能来自按 Job 授权的 Control API。

## 3. 核心实体

```text
Project 1 ── * Canvas（任务；没有独立 tasks 表）
Canvas  1 ── * Intent / canvas_nodes / canvas_edges / canvas_broadcasts
Canvas  1 ── * Job
Job     1 ── * Attempt / events / effects / artifacts / evidence
Finding * ── 1 Project + Job + optional Canvas node + optional Artifact
Finding 1 ── * verification rounds
Canvas  1 ── * task reports / finding research runs / dedupe clusters
```

| 实体 | 当前语义 |
| --- | --- |
| `Project` | 资产范围、配置、凭据绑定和项目级权限边界。 |
| `Canvas` | 一任务一画布；`kind=standard` 为普通任务，`kind=compose` 为带冻结 Finding 种子的任务。 |
| `Intent` | Hub 对一个下一步工作的提案；包含角色/能力、完整 prompt、引用节点、预算和可选运行时镜像。 |
| `Job` | 一次受调度的沙箱执行，可能是 Hub、工作角色、Verify 或 Report。状态由 Scheduler 判定。 |
| `Attempt` | Job 的一次领取和执行尝试；持有快照身份、沙箱身份、取消标记和效果账本。 |
| `Artifact` | 版本化内部写入真相，保存 kind、schema version、claims、evidence、relations 和 provenance。 |
| `Fact` | 工作角色提交的结构化观察或验证证据；有独立的 Fact `verification_status`。 |
| `Finding` | Artifact 的可查询安全投影；保留 profile、category、severity、scoring、tags、evidence_refs 等领域字段。 |
| `Finding research` | 对 Finding 做语义去重、canonical anchor 和相对优先级；不改变技术验证和报告门禁。 |
| `Report` | Task Report 和 Finding Report 均是冻结输入后的版本化 Projection。 |

Artifact、Finding、Fact 的职责不能混写：Artifact 是内部写入真相，Finding 是对外风险对象，Fact 是证据与观察。SARIF 只在导出或交付给人类时投影，不承担模型内部全部表示责任。

## 4. AI-native 能力模型

### 4.1 Capability Pack

当前机器契约是 `deepsonar.capability-pack/v1`，定义于 `packages/shared-types/src/capability-pack.ts`。Manifest 至少描述：

- `id`、版本、scope、摘要和不可变 `sha256` digest；
- capability 名称、输入 schema、输出 Artifact schema；
- `platform_tools`、出网要求和其它权限；
- attempt/token/时间预算；
- `correctable` 与 replay 策略；
- 可选 evaluator。

当前已落地的是第一刀：内置 pack、已信任 Git skill module、RoleConfig 生成只读目录投影；Job 级只读发现操作为 `list_capabilities`、`search_capabilities`、`describe_capability`、`validate_composition`、`preview_materialization`。现有 `explore`、`analyze`、`review`、`test`、`code`、`audit` 作为内置 pack 继续工作，`deepsonar-management` 也可以作为平台能力包被发现。

发现不是授权。Scheduler 仍按项目范围、Job 快照、平台工具 allowlist、镜像兼容性和网络策略决定可执行集合。模型不能用 Manifest 扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。

Job 创建时冻结 capability selector、digest、模块内容 hash、缺失模块和运行配置；运行时物化只能使用这份快照。当前发现 API 会合并内置目录、已信任 skill source 和 Job 的 RoleConfig 投影，因此发现结果本身只是只读目录提示，不是授权。任何组合/物化路径都必须再以快照 selector/digest 为上限，不能把 Job 创建后的 source sync 当成这次执行的新权限；这条上限校验是继续收紧的实现门。当前尚未实现 task/session Pack 的持久化生命周期、Pack 评估晋升和跨任务经验推荐；不要在代码或文档中把这些未来能力写成已存在。

### 4.2 Plan

当前 Hub 仍以 Intent 驱动，长期目标是把 Intent 适配为 `PlanTask`，由模型声明目的、依赖、输入引用、期望输出、验证路径、完成理由和预算。平台验证 schema、canonical 引用、依赖环、权限、预算和可执行性；模型判断业务上继续、收敛、阻塞或请求人工。

`maxHubRounds`、follow-up 深度、token、wall time、并发和沙箱限制都是不同的护栏。它们可以阻止失控，但不能单独代替模型说明“为什么已经完成”。Plan 协议全面落地前，现有 Hub 和固定角色闭环仍是唯一生产主路径。

### 4.3 失败反馈与修正

插件、Control API、Plan、Artifact、Verify 和 Runtime Adapter 必须使用四类失败语义：

| 类别 | Scheduler 行为 | 模型能否修正 |
| --- | --- | --- |
| `model_correctable` | 返回字段级反馈，允许同 Session 重新提案 | 可以 |
| `transient_retryable` | 有界退避或恢复，保持幂等语义 | 通常可以 |
| `unknown_external_effect` | 停止自动重放，转对账、orphan 或人工 | 不能猜测 |
| `permanent_failure` | fail closed，要求权限、配置、版本或快照修复 | 需外部修复 |

`RepairFeedback` 是 `packages/shared-types` 的版本化契约，至少包括 `category`、`code`、`operation`、`path`、`message`、`expected`、脱敏 `observed_shape`、`current_state_ref`、`accepted_effects`、`idempotency_key`、提案/修正次数、剩余预算和 `next_action`。`observed_shape` 只允许类型、长度、计数等形状信息，不能把凭据、Provider 原文或不可信输入复制进模型上下文。

当前 Phase 1 已接入 Control API 的严格 schema/字节约束和标准错误路径。模型收到 `model_correctable` 后应重新读取能力目录、节点引用或当前状态，再以新的提案 revision 和 Idempotency-Key 提交。预算耗尽必须明确进入 `blocked` 或 `needs_human`，不能重复发送相同错误后静默结束。

`accepted` 的目标语义是 durable receipt。已有 Job/Attempt/effect 账本仍是事实边界：`effect_pending` 或 `unknown` 不是普通模型错误，`replay_policy=never` 时禁止自动猜测重放。完整 Proposal/Receipt/Settlement 和失败检查点仍是长期演进项。

## 5. 当前执行闭环

```text
创建 Project / Canvas
        ↓
Hub 读取 graph scope 投影并提交 Intent
        ↓
Scheduler 做权限、引用、预算、镜像和能力 admission
        ↓
Job → Attempt → provision → running → sandbox
        ↓
Control API：progress / fact / artifact / finding / human / done
        ↓
finalizeJob：Verify、Research、下一轮 Hub 或 Report
        ↓
Task Report / Finding Report / 人工处理
```

Hub 只能提出工作角色 Intent；`verify_finding` 与 `report` 是 Scheduler 派生的系统 Job。一个 Canvas 同时最多一个活跃 Hub。Hub 只能引用当前画布的 canonical UUID，Finding 绑定必须使用数据库 Finding UUID；字段名、别名、跨画布 ID 和占位符都会被拒绝。

真实 Job 注入固定的 `deepsonar-control` Skill。Skill 只说明能力发现、OpenAPI、Bearer 和 Idempotency-Key；不动态授予权限。三类当前新执行 CLI 为 Claude Code、Pi、DSH；历史 Codex/OpenCode 归档仍可只读查看，不作为新执行的默认 adapter。

## 6. Finding、Verify、Research 和报告

### 6.1 Verify

review/test/worker 的复核结果必须作为结构化 Fact 提交，至少引用 `finding_id`、`subject_revision`、`ownership`、`expected`、`actual` 和 `outcome`。Scheduler 校验项目/画布归属、版本和 Fact 间冲突；普通文本 verdict 不计入门禁。

Verify 只消费允许的 Fact、Artifact、Evidence 和独立 Evaluation，不重读 maker 结论作为证据。证据不足、冲突、版本不匹配或主体变更时，Finding 保持未确认，Hub 重新派发 review/test 补证。`minVerifySeverity` 只决定自动验证和收敛范围，不会删除低于阈值的 Finding。

Fact `verification_status`（证据可信度）、Finding `verify_status`（技术验证）和 Finding `disposition`（人工处置）是三个独立状态机。人工不能直接把 Finding 写成 `confirmed`，也不能把 rejected Fact 直接升为 verified。

### 6.2 Research

Research 是报告前的只读辅助层：Scheduler 按有界批次对 Finding 做语义聚类，维护 canonical anchor、重复关系、`dedupe_reason` 和相对 `priority_score`。priority 是注意力分配，不是 severity；它不改变 `verify_status`、Fact 门禁、Finding severity 或报告收敛。

Research 失败必须显式记录并保留候选 Finding。与 Finding/报告写入同一事务时，Research 使用 savepoint 隔离；研究写失败不能回滚已经接受的 Finding 或报告主路径。读取入口为 `GET /canvases/:id/finding-research`。模型、prompt revision、批次边界和运行状态进入 research run 账本。

### 6.3 Projection

Finding 变为 `confirmed` 后，Scheduler 生成冻结输入的 Finding Report；Canvas 收敛后生成版本化 Task Report。相同输入幂等，输入变化追加版本，生成失败只更新报告行，不改写 Finding 状态。SARIF 和其它外部格式是 Projection，不是内部写入真相。

## 7. Job、Attempt 和恢复

Job 状态为：

```text
pending → claimed → provisioning → running → succeeded
                         │             ├→ waiting_human → pending
                         └─────────────└→ failed / timeout / cancelled / orphan
```

Lease 和 Reaper 由 Scheduler 判定超时与孤儿，不能信任 Agent 自报。`pg_notify('deepsonar_jobs')` 是主要调度唤醒；可以关闭轮询。

每个 Job 领取建立 Scheduler-owned Attempt。外部动作先写 `job_attempt_effects` 的 intent/`effect_pending`，观察到结果后再写 settlement。启动对账按 Attempt phase 和 effect 分类：只有尚未开始且无效果的准备阶段可以回到 `pending`；未知效果统一进入 `orphan`，清理 Token、沙箱、画布同步和租约，禁止自动重放。

取消、超时、迟到回调、容器创建和销毁都走幂等路径。`timeout/orphan` 只有在没有待结算效果且策略允许时才可安全重试；否则必须让操作员确认。Job resume 使用创建期冻结快照，`rerun-current` 才重新解析当前配置并完整重冻，身份漂移返回 `SNAPSHOT_STALE`。

## 8. 配置、快照和运行时

配置优先级为 **Job > 角色/项目 > 平台 > env 引导**。项目只能收紧全局并发上限，不能放宽安全硬门。Job 执行只认创建时的 `agent_snapshot_json`，不在 Dispatcher 运行时回退到最新 RoleConfig。

运行时由 `packages/runtime-sandbox` 的 `SandboxRunner` / `RuntimeHost` 抽象，当前有 Noop 和 OpenSandbox 实现。每个 Job 使用新的 `/workspace`、独立可写 HOME、冻结的 CLI/provider/model、治理后的 Gateway、镜像 key + digest、工具清单和网络策略。real Job 的模型请求经 Scheduler-owned Model Gateway；长期 Provider 密钥不进入 Job 快照、Session 或工作区。

运行镜像必须来自已准入市场。第三方镜像先经 `apps/image-admission` 扫描、批准和项目启用；Agent 不能提交任意 OCI 地址。镜像和平台版本分开管理，执行永远使用不可变 digest，不使用可变 `latest`。出网权限在 Canvas/Job 快照中冻结，禁止出网的沙箱只能通过固定 Gateway 访问模型。

## 9. 读图、事件与证据

`buildGraphSnapshot` 按 `GraphScope` 生成有字符预算的 YAML：`hub`、`agent`、`verify`、`report` 看到的内容不同；Job 节点不进入 YAML。Verify scope 隐藏 maker 的 title/summary/severity，只给主体、location 和证据引用。长期方向是让模型用 Job-scoped 查询按需获取节点、邻域、证据和冲突，逐步减少全图投影，但不能改变 Canvas、events 和 Evidence 的权威性。

语义 `events` 是唯一可触发控制副作用的账本；原始过程流写入本机 evidence/冷存储；WS `stream-bus` 只作实时投递。广播账本 `canvas_broadcasts` 记录 `planned`、`injected`、`failed`、`unknown`；`injected` 只证明写入 CLI 输入通道，不证明 Agent 已读。

人工消息进入 durable inbox ledger，附件先写共享资产再按 message UUID 注入 `/workspace/.deepsonar/inbox/`。`injected` 与显式 ACK 分离；waiting-human 回复会关闭旧 Attempt、恢复 Job 为 pending 并重新唤醒 Dispatcher。普通文本、Session 标题和节点名称都不能伪造 ACK。

Session 查看器按 CLI 方言解析 reasoning、message、tool call/result、usage 和广播注入，保留原始归档下载。Session usage 与 Gateway `job_usage_ledger` 是两套口径，不互相冒充定价或对账结果。实时流丢失时只能补读已落盘 evidence；另一 Scheduler 副本没有共享文件系统时必须报告不可见。

## 10. 前端信息架构

一级导航是态势、项目、Agent、Agent 市场和镜像。项目内日常路径为任务工作台：

1. **总览**：目标、当前阶段、活跃工作、人工介入、质量和下一步动作；
2. **研究地图**：Finding cluster、canonical anchor、priority 与语义关系；
3. **事实证据**：Fact、Artifact、验证状态、证据边和来源；
4. **任务发现**：本任务 Finding、Verify 状态、disposition 和追踪入口；
5. **任务运行**：Job、Attempt、Session、流、广播和用量；
6. **报告**：Finding Report、Task Report、版本、输入 checksum 和生成状态。

选中的 `tab` 写入 URL，后台刷新不能强制切换视图。Canvas 是高级审计视图，默认只读；节点布局由服务端 elkjs 计算。列表筛选使用服务端分页和可搜索多选；不同维度按 AND，同一维度按 OR。项目账本和项目风险是独立项目视图，不塞进任务工作台的运行列表。

## 11. 安全与授权硬门

- 被审计代码、仓库内容、外部事件和模型输入均视为不可信，必须防 prompt injection、路径越界和凭据外泄。
- API Token、Job capability token、Model Gateway token 和 Provider 凭据分离；Token 只存 hash，Job 终态撤销。
- Job 控制 operation 由 shared Zod schema、宿主 handler、event-ingestion 事务三层校验；未知字段默认拒绝，不 strip 后部分写入。
- capability/role、节点 UUID、Finding 绑定、镜像 key、项目 scope、状态和预算都必须在当前 Job/Canvas 上重新验证。
- Control API 不写 Agent 可写控制文件，不从普通 CLI 输出或伪造 MCP tool call 推断事件。
- 镜像、sandbox、Gateway、Provider 和事件流都采用 fail-closed；不知道外部效果时不重放。
- 审计日志 append-only；过程流、Session、运行产物和错误反馈不得泄露长期密钥或完整 Provider 响应。

## 12. 当前状态与开放演进

| 方向 | 当前状态 | 下一步 |
| --- | --- | --- |
| Artifact-first（#444） | Phase 1 已落地，Artifact 为内部写入真相，Finding 为投影 | 扩展 Claim/Evidence/Evaluation/Projection，清理双重事实源 |
| RepairFeedback（#446/#453） | Phase 1 已落地，Control API 严格拒绝路径已接线 | Proposal/Receipt/Settlement、统一 Completion Gate |
| Capability Pack（#447/#459） | Manifest、Job 级发现和快照 selector/digest 已落地；目录发现仍需严格受冻结 selector/digest 上限约束 | live catalog 漂移门禁、task/session 生命周期、准入评估、临时组合、经验推荐 |
| Plan / 模型主导收敛（#443） | 当前仍由 Hub Intent + 硬护栏运行 | PlanTask、模型完成声明、预算化验证和回放 |
| Finding Research（#448） | 语义去重、canonical anchor、相对 priority 已落地 | 更强评估集、跨任务聚类和人工反馈闭环 |
| Quality / Replay（#445/#456） | 只读指标与 Hub replay 基线已落地，经验召回为空 | Experience、成本感知计划和策略评估 |
| 任务工作台（#451/#454） | 总览、研究地图、事实、发现、运行、报告视图已落地 | 过程探索、增量图查询和更紧凑的人机协同 |

未来实现必须先更新本表和相关专题文档，明确哪些是 as-built、哪些是进行中、哪些只是提案。不能用旧 Issue、历史 `*_PLAN.md` 或静态角色名称推断当前实现。

## 13. 实现硬约束

1. **先读本文和专题文档，再读代码**；冲突以代码、schema、OpenAPI、测试为准，并回写本文。
2. **状态机、幂等键、外键和权限骨架进定列；内容进 JSONB**。改表只能修改 `database/schema.sql`、bump `SCHEMA_VERSION`、重建并验证，不写增量 ALTER 链。
3. **共享 Zod 契约是前后端和事件 payload 的单源**。新增 operation 必须有合法/非法夹具、宿主重验、事务回滚和冒烟测试。
4. **新增 CLI 必须同步 runtime adapter、Session archive adapter、Web Session viewer、测试和原始归档下载**。
5. **新增能力优先做 Capability Pack**，不要新增固定角色分支；pack 不能拥有第二执行通道，必须使用现有 Job/Attempt/effect、Control API、沙箱和审计。
6. **任何可修正失败都必须给 RepairFeedback**；任何 `accepted` 都必须有 durable receipt 语义；未知外部效果禁止自动猜测重放。
7. **模型不可提交坐标、镜像 digest、凭据、终态或未授权项目引用**。模型看到的 prompt、Artifact、Finding 和外部输入都按不可信内容处理。
8. **测试必须覆盖行为边界**：只跑 typecheck 不算完成。按影响范围选择 `ci:unit:*`、`ci:integration:*`、`ci:smoke:*`、镜像检查和前端契约测试。

## 14. 仓库地图与事实入口

| 路径 | 职责 |
| --- | --- |
| `apps/scheduler` | Fastify API、Dispatcher、Hub、Job lifecycle、Verify、Research、Report、Gateway |
| `apps/web` | React 控制台、Task Workbench、Canvas、Finding、Job 和 Session viewer |
| `apps/image-admission` | OCI 镜像扫描与准入 |
| `packages/shared-types` | Zod 契约、Capability Pack、RepairFeedback |
| `packages/runtime-sandbox` | Noop/OpenSandbox、CLI adapter、Session 归档 |
| `database/schema.sql` | 唯一 schema 基线；当前主线 v48 |
| `deploy` / `agent-harness` | 部署、镜像、冒烟与运行时验证 |

实现入口：

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：完整架构、威胁模型、存储和状态机细节；
- [`docs/README.md`](docs/README.md)：专题文档和 as-built 状态索引；
- [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期内核/插件协议、Crash Matrix 和实施路线；
- [`database/schema.sql`](database/schema.sql)：唯一数据库基线；
- `/api/openapi.json`：当前 HTTP API；
- [`AGENTS.md`](AGENTS.md)：编码 Agent 的操作纪律。
