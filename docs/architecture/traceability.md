# 追溯矩阵

> 状态：**起草中（#741 PR 2）**。本表只保存需求 ID 与架构视图 / ADR / 代码入口 / 测试或 CI gate 的**关系**；需求正文与实现状态以 [`01-system-specification.md`](01-system-specification.md) 为准，本文件不复写。覆盖范围随 PR 2 首批三条关键链路；后续 PR 增补行，不删历史 ID。
> 同步日期：2026-10-15

## 约定

| 列 | 含义 |
|----|------|
| 需求 ID | 必须在 `01-system-specification.md` 以 `### ID` 定义；本表首列只写 ID（可链到规格文件，不链锚点依赖） |
| 架构视图 | 计划中的视图文件或已有专题；未落地的写「计划：`NN-…`」 |
| ADR | 已采纳 / 待回填编号；无则「—」 |
| 代码入口 | 主要实现路径（相对仓库根） |
| 测试 / CI gate | 自动测试、`pnpm` 脚本或人工核查说明 |

机检（`pnpm ci:unit:docs-freshness`）：本表覆盖全部已定义需求 ID；悬空引用失败。ADR 允许留空号，不把连续编号当验收条件。

---

## 矩阵

| 需求 ID | 架构视图 | ADR | 代码入口 | 测试 / CI gate |
|---------|----------|-----|----------|----------------|
| FR-TASK-001 | 计划：`06-runtime-view.md`；摘要 [`DESIGN.md`](../../DESIGN.md) §3/§5 | — | `apps/scheduler/src/domains/project-task/routes.ts` | 项目任务集成测试；OpenAPI Management；人工 409 归档项目 |
| FR-TASK-002 | 计划：`06-runtime-view.md` | — | `apps/scheduler/src/domains/project-task/routes.ts`；`apps/scheduler/src/domains/hub-orchestration/` | 创建后存在 `hub_reason` Job；`readiness.ts` hub 角色检查 |
| FR-HUB-001 | 计划：`06-runtime-view.md` | — | `apps/scheduler/src/core.ts`（`finalizeJob`）；`apps/scheduler/src/domains/event-ingestion/side-effects.ts` | `convergence-recovery.integration.test.ts` |
| FR-HUB-002 | 计划：`03-constraints-and-principles.md`；`05-building-blocks.md` | 待 ADR-0003（API-only 相关） | `apps/scheduler/src/domains/event-ingestion/side-effects.ts`；各 `admit*.ts` | Intent / capability admit 测试 |
| FR-HUB-003 | 计划：`06-runtime-view.md`；`09-interface-specs.md` | — | Hub Intent 校验（含 `assertComposeScopedHubIntent`） | Hub / compose 作用域测试 |
| FR-JOB-001 | 计划：`06-runtime-view.md`；`08-data-architecture.md` | — | `apps/scheduler/src/domains/job-lifecycle/`；`apps/scheduler/src/dispatcher.ts` | `job-lifecycle` 测试；`job-state-write-inventory.test.ts` |
| FR-JOB-002 | 计划：`06-runtime-view.md`；`08-data-architecture.md` | — | `apps/scheduler/src/domains/job-attempt/` | `job-attempt` 单测 / 集成测试 |
| FR-JOB-003 | 计划：`06-runtime-view.md` | — | `apps/scheduler/src/core.ts`；`verify.ts`；`report.ts` | finalize / canvas-convergence / finding-report 集成测试 |
| FR-JOB-004 | 计划：`06-runtime-view.md`；`08-data-architecture.md` | 待 ADR-0008（锁序/事务边界，PR 5 可选） | `apps/scheduler/src/domains/job-attempt/application.ts` | `job-attempt/application.test.ts` |
| FR-JOB-005 | 计划：`06-runtime-view.md`；`10-security-and-trust-boundaries.md` | — | `job-attempt/application.ts`；`apps/scheduler/src/reconcile.ts` | 「effect_pending 不自动重放」单测；工作台投影测试 |
| FR-JOB-006 | 计划：`06-runtime-view.md` | — | `apps/scheduler/src/domains/job-attempt/model.ts`；`application.ts` | `application.test.ts`；`application.integration.test.ts` |
| FR-JOB-007 | 计划：`06-runtime-view.md`；`07-deployment-view.md` | — | `apps/scheduler/src/reconcile.ts`；`apps/scheduler/src/index.ts` | `executor-real.test.ts`（启动调用契约）；recovery 集成测试 |
| FR-JOB-008 | 计划：`06-runtime-view.md` | — | `apps/scheduler/src/dispatcher.ts`；`apps/scheduler/src/config.ts` | reaper / recovery 测试；`NFR-REL-002` 配置核对 |
| FR-FIND-001 | 计划：`06-runtime-view.md`；`08-data-architecture.md` | 待 ADR-0004（Fact / Verify 分责） | `apps/scheduler/src/domains/canvas/fact-verification.ts` | `fact-verification` 测试 |
| FR-VERIFY-001 | 计划：`06-runtime-view.md` | 待 ADR-0004 | `apps/scheduler/src/verify.ts`；`domains/finding-verification/` | Verify 门禁 / 安全 profile 测试 |
| FR-RPT-001 | 计划：`06-runtime-view.md` | 待 ADR-0007（Artifact-first，PR 5 可选） | `apps/scheduler/src/report.ts` | `finding-report.integration.test.ts` |
| FR-CTRL-001 | 计划：`09-interface-specs.md`；`10-security-and-trust-boundaries.md` | 待 ADR-0003 | `packages/shared-types/src/repair-feedback.ts`；`domains/platform-api/repair.ts` | `platform-api` 测试；`repair-feedback.test.ts` |
| FR-CTRL-002 | 计划：`09-interface-specs.md` | — | `packages/shared-types/src/repair-feedback.ts` | 类别枚举与 Control 映射测试 |
| FR-CTRL-003 | 计划：`10-security-and-trust-boundaries.md` | — | `repair-feedback.ts` `describeObservedShape` | 形状描述单测；人工无 secret 泄漏 |
| FR-CAP-001 | 计划：`05-building-blocks.md`；`03-constraints-and-principles.md` | — | `domains/capability-pack/` 等 admit 路径 | capability admit 测试 |
| CON-001 | 计划：`03-constraints-and-principles.md` | — | Scheduler 控制面与 dispatcher | `authorization-boundaries.integration.test.ts`；架构评审 |
| CON-002 | 计划：`03-constraints-and-principles.md` | 待 ADR-0001 | 各删除契约 PR；`docs-freshness` DEAD_TOKENS | `pnpm ci:unit:docs-freshness` |
| CON-003 | 计划：`08-data-architecture.md` | 待 ADR-0002 | `database/schema.sql`；`schema-version.ts` | docs-freshness schema 字面量；`pnpm db:rebuild` |
| NFR-REL-001 | 计划：`04-quality-attributes.md`；`06-runtime-view.md` | — | `apps/scheduler/src/config.ts`；dispatcher | 配置默认值源码核对 |
| NFR-REL-002 | 计划：`04-quality-attributes.md` | — | `apps/scheduler/src/config.ts` | 源码默认值；SLO **尚未验证** |
| NFR-REL-003 | 计划：`09-interface-specs.md`；Web 工作台 | — | effect ledger + Web RepairFeedback 投影 | 工作台投影测试 / 人工 |
| NFR-SEC-001 | 计划：`10-security-and-trust-boundaries.md` | — | auth / event-ingestion authorization | `authorization-boundaries.integration.test.ts` |
| IR-001 | 计划：`02-context-and-scope.md`；`07-deployment-view.md` | — | `packages/runtime-sandbox`；gateway | executor-real / OpenSandbox 测试；凭据不进快照契约 |

