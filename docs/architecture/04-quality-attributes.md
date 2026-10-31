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
| 研究隔离 | Finding Research batch 失败或重复运行 | savepoint 记录研究失败而不回滚主 Finding/Report 写入；相同输入幂等 | research run 状态、cluster/canonical/priority 版本 | [`application.test.ts`](../../apps/scheduler/src/domains/finding-research/application.test.ts)、[`finding-research.integration.test.ts`](../../apps/scheduler/src/domains/finding-research/finding-research.integration.test.ts) |
| 报告投影 | 生成输入冻结后发生新事实，或报告生成失败 | 旧投影保持不变，输入变化追加版本；失败进入 report 状态，不改写内部事实 | `deepsonar_report_auto_retry_total`、`deepsonar_report_root_settled_total`、report status、input/output hash | [`report-convergence.characterization.test.ts`](../../apps/scheduler/src/domains/report-convergence/report-convergence.characterization.test.ts)、[`report-failure-recovery.test.ts`](../../apps/scheduler/src/report-failure-recovery.test.ts)、[`task-report-version.test.ts`](../../apps/scheduler/src/task-report-version.test.ts) |
| 多副本证据可见性 | Web/WS 请求落到没有本地 Evidence 文件的副本 | 返回 visibility unavailable，并按协议关闭过程流；不把实时总线当作权威补读 | stream visibility、WS 关闭码、stream queue | [`evidence-stream.test.ts`](../../apps/scheduler/src/evidence-stream.test.ts)、[`process-stream-boundary.test.ts`](../../apps/scheduler/src/process-stream-boundary.test.ts) |
| 文档可维护性 | 版本、脚本、链接或已删机制在文档漂移 | 文档 freshness gate 失败，发布前修复 | docs freshness 输出 | `ci:unit:docs-freshness`、人工 as-built 对照 |

## 护栏值与 SLA 的边界

以下是实现中可调整、可测试的护栏示例：图查询累计调用/字节额度默认不限，显式正整数配置才限制，单次投影大小与分页硬上限仍生效；事件窗口 60 秒内进度/普通/终态分别受 30/120/8 限制；默认 provisioning 超时 300 秒、lease TTL 120 秒、stall 900 秒、等待人工 1800 秒；全局并发默认 20、项目并发默认 5、provisioning 默认 2；模型修复预算由 RepairFeedback 宣布。它们来自 [`config.ts`](../../apps/scheduler/src/config.ts)、[`graph-query.ts`](../../apps/scheduler/src/graph-query.ts) 和 shared types，表示保护边界或默认值。

这些数字不表示“请求必须在某时限内成功”、持续可用率、Provider 成功率、跨副本传播时间或人工响应时间。实际运行应结合 [`metrics.ts`](../../apps/scheduler/src/metrics.ts) 中的队列、失败、时长、Gateway、沙箱和清理指标判断。若未来定义 SLA，应在相应产品/运维契约中单独批准和验证，不能从本表推导。

## 验证策略

行为测试优先于 typecheck：Control、Job 生命周期、Finding Research、Canvas fact、Web fact 和镜像信任各有对应单元/集成/Smoke 入口。CI 的 Test wiring ratchet guard 检查 `*.test.ts` 是否被脚本接线；CI 是否调用每个脚本以 `.github/workflows/ci.yml` 为准。本文没有把未运行的命令宣称为已通过，完成本次文档变更后只执行文档、链接、diff 和适用的 gate 检查。

## 知识效果研究证据（#777）

FR-KNOW-001 的状态机测试不证明模型收益。[离线研究协议](../../agent-harness/knowledge-live/STUDY.md) 冻结家族分组、样本 hash、独立 oracle 和质量硬门，模板逐例保留分母/失败/成本。当前观测分母为零，真实模型闭环 pending；任何低成本或模型自评均不能抵消关键质量退化。
