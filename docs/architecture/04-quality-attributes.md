# 04 质量属性与可验证场景

> 状态：**as-built**（#741）。把系统质量属性写成可观察场景，并映射到现有护栏、指标和测试；不承诺未定义的 SLA。
> 同步日期：2026-10-31

质量属性以“刺激—响应—度量—验证”表达。表中的护栏是代码或配置的拒绝/限流/超时边界，不能理解为可用性、延迟、吞吐或恢复时间 SLA。当前仓库没有对外发布的 Scheduler uptime、端到端延迟、Provider 可用性或 MTTR 目标；这些未知项只能通过运行指标和运营观察评估。

## 场景矩阵

| 属性 | 刺激 | 期望响应 | 可观察度量 | 现有验证入口 |
| --- | --- | --- | --- | --- |
| 认证与授权 | 无效管理 token、错误项目 scope 或未经允许的 Control operation | 在语义副作用提交前拒绝；入口与事务层都保留去凭据审计和稳定错误类别 | `deepsonar_api_auth_failed_total`、操作拒绝审计、Control 输入警告 | `ci:unit:bounded-contexts`、[`route-surface.test.ts`](../../apps/scheduler/src/route-surface.test.ts)、[`openapi.test.ts`](../../apps/scheduler/src/openapi.test.ts) |
| 输入完整性 | 语义事件包含未知字段、坏 UUID、越界文本或不可见引用 | 共享 schema 严格拒绝，返回脱敏 RepairFeedback；不写部分语义结果 | `deepsonar_control_input_warnings_total`、事件拒绝和 `deepsonar_event_rate_limited_total` | [`authorization.integration.test.ts`](../../apps/scheduler/src/domains/event-ingestion/authorization.integration.test.ts)、[`control-input.test.ts`](../../apps/scheduler/src/control-input.test.ts)、`ci:integration:platform-api` |
| 幂等 | 任一 Control operation POST 重复提交，或同一 Idempotency-Key 改变 operation/input | 所有 operation POST 都要求 UUID key；同 key 同输入返回接口层已有结果，冲突得到 409；只读 operation 只依赖请求缓存/冲突检查，语义 mutating operation 才由事件 dedup、业务唯一约束或 effect settlement 防止重复事实 | 接口缓存、事件 dedup、Job event sequence、effect settlement、唯一约束 | [`event-ingestion.integration.test.ts`](../../apps/scheduler/src/domains/event-ingestion/event-ingestion.integration.test.ts)、[`platform-api.integration.test.ts`](../../apps/scheduler/src/domains/platform-api/platform-api.integration.test.ts) |
| 预算与背压 | Hub/Agent 查询超过图查询字节、调用、引用或事件速率预算 | 拒绝/限流并保留可修正反馈；模型重新读取有界投影或进入人工路径 | `deepsonar_graph_yaml_chars_total`、`deepsonar_event_rate_limited_total`、Hub budget exhausted | [`graph-budget.test.ts`](../../apps/scheduler/src/graph-budget.test.ts)、[`graph-query.test.ts`](../../apps/scheduler/src/graph-query.test.ts)、[`graph-reference.test.ts`](../../apps/scheduler/src/graph-reference.test.ts) |
| 执行隔离 | Job 需要受限镜像、网络、凭据或设备 | Dispatcher 只使用冻结快照，经准入、租约和沙箱策略创建 Attempt；越界在 provisioning 前失败 | `deepsonar_sandbox_provision_seconds_sum/count`、`deepsonar_sandbox_provision_failed_total`、`deepsonar_sandbox_cleanup_failed_total`、device lease 状态 | [`runtime-image-contract-selftest.test.ts`](../../apps/scheduler/src/runtime-image-contract-selftest.test.ts)、[`sandbox-limits.test.ts`](../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.test.ts)、[`device.test.ts`](../../apps/scheduler/src/domains/device/device.test.ts)、`ci:images` |
| 故障恢复 | Scheduler 崩溃、lease 过期、沙箱句柄迟到或 settlement 缺失 | 无效果的 preparing 阶段可回到 pending；已发出或不明效果进入 unknown/orphan 对账；不自动重放未知效果 | orphan/unknown effect、`deepsonar_sandbox_cleanup_failed_total`、Job duration | [`job-lifecycle.integration.test.ts`](../../apps/scheduler/src/domains/job-lifecycle/job-lifecycle.integration.test.ts)、[`rerun.test.ts`](../../apps/scheduler/src/domains/job-control/rerun.test.ts)、[`convergence-recovery.integration.test.ts`](../../apps/scheduler/src/convergence-recovery.integration.test.ts) |
| 取消与超时 | 用户取消、执行超时、等待人工超时或迟到回调 | 状态 CAS 防止复活；安全清理重复可执行；迟到事件被拒绝或成为审计记录 | cancelled/timeout/orphan、`deepsonar_sandbox_cleanup_failed_total`、audit logs | [`task-execution-control.integration.test.ts`](../../apps/scheduler/src/task-execution-control.integration.test.ts)、[`job-lifecycle.test.ts`](../../apps/scheduler/src/domains/job-lifecycle/job-lifecycle.test.ts) |
| 事实与验证隔离 | Agent 提交 Fact/Finding，证据不足或 Verify 失败 | Artifact/Finding 先按结构化数据落库；Verify 只消费 Fact/Evidence，进入 rework、needs_human、refuted 或 inconclusive | verification rounds、Finding verify_status、Fact verification_status | [`artifacts.integration.test.ts`](../../apps/scheduler/src/domains/artifacts/artifacts.integration.test.ts)、[`verify-eligibility.integration.test.ts`](../../apps/scheduler/src/verify-eligibility.integration.test.ts)、[`verify-evidence-chain.test.ts`](../../apps/scheduler/src/verify-evidence-chain.test.ts)、[`verify-terminal.test.ts`](../../apps/scheduler/src/verify-terminal.test.ts) |
| 操作员见证身份与跨任务强关系（#819） | Finding 缺失、过期、撤销或冲突的 identity source/mapping，跨项目选择，来源变化，或 worker/查询超出边界 | 只有认证平台管理员可写；source/mapping 用项目 scope 与 CAS；当前读和持久 worker 重核 Finding/source/identity 指纹；失效、冲突或截断进入 `stale`/`blocked`，不输出正向完整关系 | identity/relation status、`read_status`/`read_reason`、`stale_results_omitted`、`quality_gate_status`、`published` | [`identity.test.ts`](../../apps/scheduler/src/domains/project-finding-research/identity.test.ts)、[`relation-api.test.ts`](../../apps/scheduler/src/domains/project-finding-research/relation-api.test.ts)、[`relation.integration.test.ts`](../../apps/scheduler/src/domains/project-finding-research/relation.integration.test.ts)、[`relation-http.integration.test.ts`](../../apps/scheduler/src/domains/project-finding-research/relation-http.integration.test.ts)、`ci:unit:finding-research`、`ci:integration:finding-research` |
| Pi 观测记忆边界（#815） | 显式 opt-in Job 使用已准入 Pi/OM；后台请求、配置漂移、quota/transient、permission/unknown/protocol、Session 归档或镜像身份异常 | 只能走冻结 Gateway 与独立 workload；主/后台有限额度显式分配；经内核证实未启动且持久结算才可降级，ledger `pending`/`unknown`、权限、协议和 provider 5xx 必须硬失败；历史 preview/download 先脱敏且不改 immutable metadata | workload usage、pending/unknown、撤销状态、RPC frame/worker 结果、archive projection bytes/SHA/ContentDigest；质量/成本收益保持 `unknown` | 实际本地构建镜像的 canonical RPC、独立生产 guard 正负例和版本准入/适配器回归见 [RPC 专题](../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；请求前 transport、持久结算及防冒充见 [Gateway 专题](../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)；最终组合 CI、发布通道/平台与 registry/catalog 仍另验 |
| 独立程序资格（#822） | 缺少独立评审、程序材料替代/撤销、Finding/Attempt/证据变化、有效结论冲突，或历史读取不完整 | 当前资格重新投影；`not_assessed`/`blocked` 保留缺口；只有认证且获授权并与 maker 隔离的操作员评审可产生当前 `eligible`；不改写技术 Verify、任务判据或执行授权 | eligibility status/gaps、append-only `audit_logs`、材料/评审历史与失效原因 | [`program-eligibility`](../../apps/scheduler/src/domains/program-eligibility/)、[`program-eligibility.ts`](../../packages/shared-types/src/program-eligibility.ts)、`ci:unit:verify-eligibility`、`ci:integration:verify-eligibility`、`ci:unit:authz` |
| 研究隔离 | Finding Research batch 失败或重复运行 | savepoint 记录研究失败而不回滚主 Finding/Report 写入；相同输入幂等 | research run 状态、cluster/canonical/priority 版本 | [`application.test.ts`](../../apps/scheduler/src/domains/finding-research/application.test.ts)、[`finding-research.integration.test.ts`](../../apps/scheduler/src/domains/finding-research/finding-research.integration.test.ts) |
| 报告投影 | 生成输入冻结后发生新事实，或报告生成失败 | 旧投影保持不变，输入变化追加版本；失败进入 report 状态，不改写内部事实 | `deepsonar_report_auto_retry_total`、`deepsonar_report_root_settled_total`、report status、input/output hash | [`report-convergence.characterization.test.ts`](../../apps/scheduler/src/domains/report-convergence/report-convergence.characterization.test.ts)、[`report-failure-recovery.test.ts`](../../apps/scheduler/src/report-failure-recovery.test.ts)、[`task-report-version.test.ts`](../../apps/scheduler/src/task-report-version.test.ts) |
| 多副本证据可见性 | Web/WS 请求落到没有本地 Evidence 文件的副本 | 返回 visibility unavailable，并按协议关闭过程流；不把实时总线当作权威补读 | stream visibility、WS 关闭码、stream queue | [`evidence-stream.test.ts`](../../apps/scheduler/src/evidence-stream.test.ts)、[`process-stream-boundary.test.ts`](../../apps/scheduler/src/process-stream-boundary.test.ts) |
| 文档可维护性 | 版本、脚本、链接或已删机制在文档漂移 | 文档 freshness gate 失败，发布前修复 | docs freshness 输出 | `ci:unit:docs-freshness`、人工 as-built 对照 |

## 注意力成本的验证边界（#830）

NFR-UX-001 的权威定义在 [DESIGN](../../DESIGN.md#核心理念优化人的注意力)，开发评审与具体正反例见 [工程规范](11-engineering-specs.md#11-注意力成本评审830)。评审观察需要用户关注的事项、解除阻塞所需步骤、重复问题、状态/风险/证据是否可理解；不把减少消息数当作独立成功指标。当前交付是设计原则、开发约束与人工评审依据，没有新增自动通知行为，也没有节省比例、认知负担或效果收益的测量结论。安全、权限、失败可见性和实际验收要求继续成立。

## 身份、资格与质量门

程序资格的工程闭环已经接入，但它是操作员对已登记材料和当前 Finding/Verify/Evidence 的可追溯见证；它不认证外部官方规则、站点所有权或自然人/模型之间的物理独立性，也不授予目标执行或自动提交权限。资格 `eligible`、技术 `confirmed` 和任务判据满足仍是不同状态，边界见 [FR-FIND-008](01-system-specification.md#fr-find-008-独立程序资格评审) 与 [ADR-0010](adr/0010-program-eligibility-authority.md)。

#819 的身份 manifest、mapping 和强关系 worker 是已接线的工程机制，但质量门仍关闭：实现固定以源码中的 `STRONG_RELATIONS_PUBLISHED` 与 `STRONG_RELATION_QUALITY_GATE_STATUS` 为准（见 [`identity.ts`](../../apps/scheduler/src/domains/project-finding-research/identity.ts)），当前为 `false` 与 `not_evaluated`，管理读接口不暴露 suppressed relation。SQL/public schema/read 仍结构性关闭发布，尚无受治理阈值预注册、独立评审、评估准入及晋升/撤销实现；仅补独立数据不能自动启用生产建议。独立人工标签、按问题家族/资产隔离的调参集与留出集，以及查看留出结果前冻结的阈值尚未提供；因此不能把 CI、合成断言或操作员 attestation 写成强关系质量通过，也不发布生产建议。

2026-10-31 的最新根验证已通过完整 Finding Research 集成及其他分范围套件，分母与来源集中见[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md#v063-集成证据范围2026-10-31)，较早 runner 超时记录不再表示当前整套待验。#815 本地实际镜像 RPC、生产 guard 与请求前 transport/持久结算均有直接证据；schema rebuild/restore 也已完成。当前 PR 远端 CI、最终 main CI 和发布证据未完成，较早 `e23c3b4f` 的 CI 不能替代。#819 的独立质量输入仍缺失，不由工程通过数豁免。

## 护栏值与 SLA 的边界

图查询的累计额度、单次响应/分页、事件窗口、并发、provision/lease/stall/waiting_human 和修复额度都是可核对护栏；具体默认与上限只引用 [`config.ts`](../../apps/scheduler/src/config.ts)、[`graph-query.ts`](../../apps/scheduler/src/graph-query.ts)、[用量限制](../USAGE_LIMITS.md)及共享契约，不在本视图复制可变数值。Pi 记忆在有限 Job 总额下另要求显式主/后台分配，不允许隐含比例；冻结总额不限时仍不限，不能把这一配置语义解释为成本收益或容量结论。

护栏不表示请求成功时限、持续可用率、Provider 成功率、跨副本传播时间或人工响应时间。实际运行应结合 [`metrics.ts`](../../apps/scheduler/src/metrics.ts) 中的队列、失败、时长、Gateway、沙箱和清理指标判断。未来 SLA 必须单独批准和验证。

## 验证策略

行为测试优先于 typecheck：Control、Job 生命周期、Finding Research、Canvas fact、Web fact 和镜像信任各有对应单元/集成/Smoke 入口。CI 的 Test wiring ratchet guard 检查 `*.test.ts` 是否被脚本接线；CI 是否调用每个脚本以 `.github/workflows/ci.yml` 为准。本文没有把未运行的命令宣称为已通过，完成本次文档变更后只执行文档、链接、diff 和适用的 gate 检查。

## 知识效果研究证据（#777）

FR-KNOW-001 的状态机测试不证明模型收益。[离线研究协议](../../agent-harness/knowledge-live/STUDY.md) 冻结家族分组、样本 hash、独立 oracle 和质量硬门，模板逐例保留分母/失败/成本。当前观测分母为零，真实模型闭环 pending；任何低成本或模型自评均不能抵消关键质量退化。
