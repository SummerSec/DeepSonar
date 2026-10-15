# 01 系统规格（SRS）

> 状态：**起草中（#741 PR 2）**。本文件首批只贯通三条关键链路的需求；其余域（IMG / CRED / WEB / RSCH / DEV / CAP 扩展等）按后续 PR 补齐。as-built 条目已与 `DESIGN.md`、代码、`database/schema.sql`、OpenAPI 核对；冲突以代码为准，实现违约单独登记，不改写规范要求使其合法化。
> 同步日期：2026-10-15

本文件是 DeepSonar 的系统规格权威正文（参考 ISO/IEC/IEEE 29148）。每条需求有稳定 ID，供评审、Agent 与追溯矩阵直接引用。

## 0. 阅读约定

### 0.1 需求条目结构

每条需求以三级标题定义 ID（机检只认此定义格式）：

```markdown
### FR-JOB-001
```

正文固定五段：

| 字段 | 含义 |
|------|------|
| **规范要求** | 系统「必须 / 不得」做到什么（规范，不是实现摘要） |
| **决策来源** | issue / PR / `DESIGN.md` / ADR（尚未回填的 ADR 写「待 ADR」） |
| **实现状态** | `as-built`（已与代码核对）/ `进行中` / `暂缓` / `已废弃` |
| **代码入口** | 主要实现文件或 API 路径（链接优先，不抄字段表） |
| **验证证据** | 测试、CI gate 或人工核查方法；没有自动验证时写明人工方法与「尚未验证」 |

### 0.2 冲突判定

发现规格与代码不一致时，先判定类别，再行动：

| 类别 | 含义 | 本期动作 |
|------|------|----------|
| **文档漂移** | 规范仍正确，文档过时 | 回写本文件与追溯矩阵 |
| **实现违约** | 代码违反已采纳规范 | 登记缺陷 / issue；**不得**改规范使越权或错误合法化 |
| **尚未决策** | 无权威规范 | 标 `暂缓` 或开 ADR；不凭空写度量目标 |

### 0.3 度量值纪律

非功能数值只写代码或配置中真实存在的默认值 / 上限，并注明出处（如 `apps/scheduler/src/config.ts`）。没有依据的写「未定义」或「尚未验证」。配置默认值（lease / stall / timeout）是机制参数，**不能**单独证明可用性或恢复时间达标。

### 0.4 本批范围（三条关键链路）

1. **任务创建 → Hub → Job / Attempt → 结果与报告**
2. **非法或越权提案 → 拒绝与 RepairFeedback**
3. **超时、崩溃或未知外部效果 → 恢复、对账与清理**

域前缀归属说明见 [`README.md`](README.md) §4.2（Canvas / Fact / Artifact / Device / 资产不在本期一律新设前缀）。

### 0.5 已废弃 ID

本期无已废弃需求 ID。废弃时保留条目并标注取代者，同时把 ID 登记进 `docs-freshness.test.ts` 的 `DEPRECATED_REQUIREMENT_IDS`，禁止复用。

---

## 1. 链路一：任务创建 → Hub → Job / Attempt → 结果与报告

### FR-TASK-001

- **规范要求**：系统必须允许在活跃项目下创建任务；每次创建必须对应一张任务画布（Canvas），并把目标、可选调度、网络 / 设备 / runtime profile 等任务级约束写入画布目标，不得在已归档项目上新建任务。
- **决策来源**：`DESIGN.md` §3 / §5；Management API 任务创建路径。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/domains/project-task/routes.ts`](../../apps/scheduler/src/domains/project-task/routes.ts)（`POST /projects/:id/tasks` → `ensureCanvasForTask`）
- **验证证据**：项目任务相关集成测试；OpenAPI Management 路径；人工：归档项目返回 409。

### FR-TASK-002

- **规范要求**：任务创建在可立即调度时，必须派发首个 `hub_reason` Job（或按调度配置延迟启动）；Hub 是任务图上的决策者，不得跳过 Hub 直接由用户 API 伪造工作角色执行闭环。
- **决策来源**：`DESIGN.md` §5；Cairn 式图语义。
- **实现状态**：as-built
- **代码入口**：同 `FR-TASK-001` 内 `createJob({ type: "hub_reason", ... })`；[`apps/scheduler/src/domains/hub-orchestration/`](../../apps/scheduler/src/domains/hub-orchestration/)
- **验证证据**：任务创建后存在 `hub_reason` Job；`readiness` 要求存在 `hub_reason` 角色。

### FR-HUB-001

- **规范要求**：同一 Canvas 同时最多一个活跃 Hub Job；`verify_finding` 与 `report` 必须由 Scheduler 派生，不得由 Hub Intent 直接扮演。
- **决策来源**：`DESIGN.md` §5。
- **实现状态**：as-built
- **代码入口**：Hub 编排与 `finalizeJob` 派生路径（[`apps/scheduler/src/core.ts`](../../apps/scheduler/src/core.ts) `finalizeJob`；[`apps/scheduler/src/domains/event-ingestion/side-effects.ts`](../../apps/scheduler/src/domains/event-ingestion/side-effects.ts)）
- **验证证据**：Hub / 收敛相关集成测试（如 `convergence-recovery.integration.test.ts`）；人工：画布上不应出现并行活跃 `hub_reason`。

### FR-HUB-002

- **规范要求**：Hub 只能提出工作角色 Intent（角色 / 能力 / prompt / 引用 / 预算 / 可选运行时镜像）；权限、引用合法性、预算、镜像与能力 admission 必须由 Scheduler 判定。模型不得通过 Intent 扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。
- **决策来源**：`DESIGN.md` §1 / §4.1 / §5；内核边界。
- **实现状态**：as-built
- **代码入口**：事件摄入侧 Intent 处理与 admission（`event-ingestion/side-effects.ts`）；能力准入各 `admit*.ts`。
- **验证证据**：Intent / 能力准入单测与集成测试；越权字段必须被拒绝（见链路二）。

### FR-HUB-003

- **规范要求**：Hub 只能引用当前画布已投影的 canonical UUID；Finding 绑定必须使用数据库 Finding UUID。字段名、别名、跨画布 ID、占位符必须拒绝。
- **决策来源**：`DESIGN.md` §5。
- **实现状态**：as-built
- **代码入口**：Hub Intent 校验与 compose 作用域断言（`assertComposeScopedHubIntent` 等）。
- **验证证据**：Hub / compose 相关测试；人工：伪造 UUID 被拒。

### FR-JOB-001

- **规范要求**：每个被调度的沙箱执行必须是一个 Job；Job 状态权威在 Scheduler，状态集合必须覆盖 `pending → claimed → provisioning → running → (waiting_human) → succeeded | failed | timeout | cancelled | orphan`，Agent 自报不得单独决定终态。
- **决策来源**：`DESIGN.md` §7；`database/schema.sql` jobs 约束。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/domains/job-lifecycle/`](../../apps/scheduler/src/domains/job-lifecycle/)；[`apps/scheduler/src/dispatcher.ts`](../../apps/scheduler/src/dispatcher.ts)
- **验证证据**：`job-lifecycle` 测试；`job-state-write-inventory.test.ts`；schema 检查约束。

### FR-JOB-002

- **规范要求**：每次成功领取（claim）必须建立 Scheduler 拥有的 Attempt；Attempt 持有快照身份、沙箱身份、取消标记与效果账本，不得把 prompt / Provider 原文写入 Attempt 账本。
- **决策来源**：`DESIGN.md` §7；[`job-attempt/model.ts`](../../apps/scheduler/src/domains/job-attempt/model.ts)。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/domains/job-attempt/`](../../apps/scheduler/src/domains/job-attempt/)；dispatcher claim 路径。
- **验证证据**：`job-attempt` 单测 / 集成测试；账本字段白名单。

### FR-JOB-003

- **规范要求**：Job 成功收口（`finalizeJob`）后，Scheduler 必须按画布状态派生 Verify、Research（若启用）、下一轮 Hub 或 Report，不得依赖 Agent 自行创建系统 Job。
- **决策来源**：`DESIGN.md` §5–§6。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/core.ts`](../../apps/scheduler/src/core.ts) `finalizeJob`；[`apps/scheduler/src/verify.ts`](../../apps/scheduler/src/verify.ts)；[`apps/scheduler/src/report.ts`](../../apps/scheduler/src/report.ts)
- **验证证据**：`finalizeJob` / canvas convergence / finding-report 集成测试。

### FR-FIND-001

- **规范要求**：工作角色提交的结构化事实进入 Canvas 后，符合条件的发现必须落为 Finding；普通文本 verdict 不得计入 Verify 门禁。Fact 证据信任态与 Finding Verify 分责（#387）：Verify 不重读 maker 结论当证据。
- **决策来源**：`DESIGN.md` §6.1；#387。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/domains/canvas/fact-verification.ts`](../../apps/scheduler/src/domains/canvas/fact-verification.ts)；finding / verification 域。
- **验证证据**：`fact-verification` 测试；Verify 相关集成测试。

### FR-VERIFY-001

- **规范要求**：关注级别内的 Finding 必须由 Scheduler 派生 `verify_finding` Job 进行独立复核；证据不足、冲突或版本不匹配时 Finding 不得被确认为 `confirmed`。
- **决策来源**：`DESIGN.md` §6.1；#399 / #590。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/verify.ts`](../../apps/scheduler/src/verify.ts)；[`apps/scheduler/src/domains/finding-verification/`](../../apps/scheduler/src/domains/finding-verification/)
- **验证证据**：Verify 门禁测试；安全 profile 确认门相关测试。

### FR-RPT-001

- **规范要求**：Finding 确认后必须能生成冻结输入的 Finding Report；Canvas 收敛后必须能生成版本化 Task Report。相同输入幂等，输入变化追加版本；生成失败只更新报告行，不得回写 Finding 状态。报告覆盖门必须按精确 Finding ID 核对章节，不得用标题词代替覆盖。
- **决策来源**：`DESIGN.md` §6.3。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/report.ts`](../../apps/scheduler/src/report.ts)
- **验证证据**：`finding-report.integration.test.ts` 等；人工：缺 ID 时确定性模板补齐。

### NFR-REL-001

- **规范要求**：调度必须主要依赖 `pg_notify('deepsonar_jobs')` 唤醒；兜底轮询默认关闭。lease 由 Scheduler 续期与判定，不得信任 Agent 自报存活。
- **决策来源**：`DESIGN.md` §7；`config.timeouts`。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/config.ts`](../../apps/scheduler/src/config.ts)（`LEASE_TTL_SEC` 默认 **120**；`DEEPSONAR_DISPATCH_POLL_SEC` 默认 **0**）；dispatcher lease 续期。
- **验证证据**：配置默认值源码断言；dispatcher 单测。恢复时间目标：**未定义**（lease 默认值不证明 RTO）。

---

## 2. 链路二：非法或越权提案 → 拒绝与 RepairFeedback

### FR-CTRL-001

- **规范要求**：Agent 控制面必须 API-only（无 MCP / 文本回退通道）。对 Zod / 权限 / 工具不允许 / 作用域失败的严格拒绝路径，必须返回版本化 `RepairFeedback`，不得只返回无结构错误字符串了事。
- **决策来源**：`DESIGN.md` §4.3 / §12；#100 / #135 / #446；待 ADR-0003。
- **实现状态**：as-built（Phase 1；完整 Proposal/Receipt/Settlement 仍为演进项）
- **代码入口**：[`packages/shared-types/src/repair-feedback.ts`](../../packages/shared-types/src/repair-feedback.ts)；[`apps/scheduler/src/domains/platform-api/repair.ts`](../../apps/scheduler/src/domains/platform-api/repair.ts)
- **验证证据**：`platform-api` 测试 / 集成测试；`repair-feedback.test.ts`。

### FR-CTRL-002

- **规范要求**：`RepairFeedback.category` 必须区分至少：`model_correctable`、`transient_retryable`、`unknown_external_effect`、`permanent_failure`。可修正失败必须给出可行动的 `next_action` / 期望形状信息；`unknown_external_effect` 不得暗示模型可猜测重放。
- **决策来源**：`DESIGN.md` §4.3；#446。
- **实现状态**：as-built
- **代码入口**：`repair-feedback.ts`（`REPAIR_FEEDBACK_CATEGORIES`、`repairCategoryForControlFailure`）
- **验证证据**：类别枚举契约测试；Control 拒绝映射测试。

### FR-CTRL-003

- **规范要求**：`observed_shape` 只允许类型、长度、计数等形状信息，**不得**把凭据、Provider 原文或不可信输入正文复制进模型上下文。
- **决策来源**：`DESIGN.md` §4.3；`describeObservedShape`。
- **实现状态**：as-built
- **代码入口**：`packages/shared-types/src/repair-feedback.ts` `describeObservedShape`
- **验证证据**：单测覆盖形状描述；人工：拒绝响应无 secret 原文。

### FR-CAP-001

- **规范要求**：能力发现（目录 / Manifest）不是授权。Scheduler 必须按项目范围、Job 快照、平台工具 allowlist、镜像兼容性与网络策略决定可执行集合；pack / Skill / CLI / LSP 不得拥有第二执行通道。
- **决策来源**：`DESIGN.md` §1 / §4.1；#447 / #603 / #611。
- **实现状态**：as-built
- **代码入口**：`domains/capability-pack/`、`cli-capability/`、`language-server-capability/`、`extension-materialization/` 的 admit 路径；Control `lint` / `resolve` 类操作。
- **验证证据**：各 capability admit 测试；越权 egress / tool 拒绝用例。

### CON-001

- **规范要求**：Scheduler 是副作用的唯一执行者（claim、状态迁移、派生系统 Job、结算、清理）。Agent / Pack / Skill 只提案，不得绕过 Scheduler 直接改库、起沙箱或持有长期凭据。
- **决策来源**：`DESIGN.md` §1–§2；实现硬约束。
- **实现状态**：as-built
- **代码入口**：架构边界（apps 分层）；Control API 与 dispatcher。
- **验证证据**：授权边界集成测试（`authorization-boundaries.integration.test.ts`）；人工架构评审。

### CON-002

- **规范要求**：平台不向后兼容废弃契约：删除的字段 / 机制必须 fail closed，不得保留静默回退路径「先能跑再说」。
- **决策来源**：`AGENTS.md` / `DESIGN.md`「不向后兼容」；#690；待 ADR-0001。
- **实现状态**：as-built（原则）；具体机制以各删除 PR 为准。
- **代码入口**：`docs-freshness` 已删机制残留扫描；相关删除 PR。
- **验证证据**：`pnpm ci:unit:docs-freshness` DEAD_TOKENS；各删除契约测试。

### NFR-SEC-001

- **规范要求**：跨项目访问必须拒绝。Job Token / Control API 作用域不得读写其它项目的画布、Finding、凭据或资产。
- **决策来源**：`DESIGN.md` §11；授权硬门。
- **实现状态**：as-built
- **代码入口**：auth / event-ingestion authorization；`authorization-boundaries.integration.test.ts`
- **验证证据**：跨项目拒绝集成测试。若发现实现放行，登记**实现违约** issue，不改本条。

---

## 3. 链路三：超时、崩溃或未知外部效果 → 恢复、对账与清理

### FR-JOB-004

- **规范要求**：任何外部动作（provision、agent_run、destroy 等）在调用外部系统前，必须先把 intent 写入 `job_attempt_effects` 且状态为 `effect_pending`；观察到结果后再写 settlement。禁止「先外部调用、后补账本」。
- **决策来源**：`DESIGN.md` §7；`job-attempt` 模型。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/domains/job-attempt/application.ts`](../../apps/scheduler/src/domains/job-attempt/application.ts)
- **验证证据**：`job-attempt/application.test.ts`（effect_pending → settled/unknown）。

### FR-JOB-005

- **规范要求**：当外部效果无法证明未发生（`effect_pending` / `unknown`，含崩溃、超时、取消后的未证实窗口）时，系统必须将该 Attempt / Job 标为不可自动重放路径（通常 `orphan` 或 `unknown`），清理 Token、沙箱、画布同步与租约，**禁止**自动猜测重放。`replay_policy` 不因本次结算被改宽。
- **决策来源**：`DESIGN.md` §4.3 / §7。
- **实现状态**：as-built
- **代码入口**：`job-attempt/application.ts`；[`apps/scheduler/src/reconcile.ts`](../../apps/scheduler/src/reconcile.ts)；Web 对 timeout/orphan 的 RepairFeedback 投影（不得推荐 `retry_same_session`）。
- **验证证据**：`application.test.ts`「重启看到 effect_pending…不自动重放」；任务工作台投影相关测试。

### FR-JOB-006

- **规范要求**：若 provision 失败且从未绑定 `sandbox_id`、也未观察到迟到沙箱，必须记为 `settled` 且 outcome `never_started`（证明无外部后果），不得留 `unknown`。一旦观察到迟到 sandbox handle（或 late destroy 失败），或沙箱已启动后的中断 / timeout / cancel / orphan，以及 `agent_run` 未证实窗口，仍必须按未知外部效果处理。
- **决策来源**：`DESIGN.md` §7；`provisionNeverStartedSettlement`。
- **实现状态**：as-built
- **代码入口**：`job-attempt/model.ts`；`application.ts` / 集成测试。
- **验证证据**：`application.integration.test.ts`；`application.test.ts` timeout/cancelled/orphan 用例。

### FR-JOB-007

- **规范要求**：Scheduler 启动时必须在 dispatcher / reaper 启动前完成 `reconcileOnBoot`：回收孤儿容器与共享资产卷；仅当 Attempt 仍在 `preparing` 且无效果记录时可回到 `pending`；provision 未知效果与 running 中断必须 orphan 并清理，禁止与新调度交错留下半终态。
- **决策来源**：`DESIGN.md` §7；`reconcile.ts` 文件头约定（JOB-04）。
- **实现状态**：as-built
- **代码入口**：[`apps/scheduler/src/reconcile.ts`](../../apps/scheduler/src/reconcile.ts)；[`apps/scheduler/src/index.ts`](../../apps/scheduler/src/index.ts) 启动顺序。
- **验证证据**：`executor-real.test.ts` 源码契约（调用 `reconcileOnBoot`）；recovery 集成测试。

### FR-JOB-008

- **规范要求**：Reaper 必须由 Scheduler 判定超时、stall、orphan 与 `waiting_human` 超时；不得信任 Agent 自报。取消、超时、迟到回调、容器创建与销毁必须走幂等路径。
- **决策来源**：`DESIGN.md` §7；`config.timeouts`。
- **实现状态**：as-built
- **代码入口**：dispatcher / reaper 路径；`config.ts` 超时项。
- **验证证据**：reaper / recovery 相关测试；配置默认值见 `NFR-REL-002`。

### NFR-REL-002

- **规范要求**：下列机制参数的默认值必须与配置源码一致（可作为运维预期，**不是**可用性 SLO）：
  - `DEFAULT_AUDIT_TIMEOUT_SEC` = **18000**（5h）
  - `DEFAULT_VERIFY_TIMEOUT_SEC` = **10800**
  - `PROVISION_TIMEOUT_SEC` = **300**
  - `LEASE_TTL_SEC` = **120**
  - `REAPER_INTERVAL_SEC` = **30**
  - `DEEPSONAR_JOB_STALL_SEC` = **900**（0 关闭）
  - `DEEPSONAR_WAITING_HUMAN_TIMEOUT_SEC` = **1800**（0 关闭）
  - 端到端恢复时间 / 吞吐量 / 可用性目标：**未定义** / **尚未验证**
- **决策来源**：[`apps/scheduler/src/config.ts`](../../apps/scheduler/src/config.ts) `timeouts`。
- **实现状态**：as-built（参数存在）；质量达标证据：**尚未验证**
- **代码入口**：`config.ts`
- **验证证据**：读取配置源码；质量场景验收留给 `04-quality-attributes.md`（PR 5）。

### NFR-REL-003

- **规范要求**：`timeout` / `orphan` 仅在没有待结算效果且策略允许时，才可向操作员提示「可安全重试」；否则必须停在需确认（`needs_confirmation`），不得推荐 `retry_same_session`。
- **决策来源**：`DESIGN.md` §7 / §12 任务工作台行；#449。
- **实现状态**：as-built（Web 投影）
- **代码入口**：任务工作台 RepairFeedback 投影（Web）；Scheduler effect ledger。
- **验证证据**：工作台相关测试 / 人工核查投影文案。

### IR-001

- **规范要求**：与 OpenSandbox（或当前 `SandboxRunner` 实现）的创建 / 销毁 / 列表必须经 Scheduler runtime 适配层；沙箱不得持有长期 Provider 密钥；模型请求经 Scheduler-owned Model Gateway 与短期 Job Token。
- **决策来源**：`DESIGN.md` §8；runtime-sandbox 包。
- **实现状态**：as-built
- **代码入口**：`packages/runtime-sandbox`；`apps/scheduler/src/runtime.js` / gateway。
- **验证证据**：executor-real / OpenSandbox 相关测试；凭据不进入快照的契约测试。

### CON-003

- **规范要求**：数据库采用单一 schema 基线 + 重建，不做增量 ALTER 链；主线版本以 `SCHEMA_VERSION` / `database/schema.sql` 为唯一数字权威。
- **决策来源**：#34；`AGENTS.md`；待 ADR-0002。
- **实现状态**：as-built
- **代码入口**：`database/schema.sql`；`apps/scheduler/src/schema-version.ts`；`pnpm db:rebuild`
- **验证证据**：`docs-freshness` schema 主线字面量检查；db rebuild 流程。

---

## 4. 本批未覆盖（显式延期）

下列前缀与主题保留完整规格最终范围，但**本 PR 不定义需求条目**，避免以文件篇幅代替链路可用性：

- `FR-RSCH` / `FR-IMG` / `FR-CRED` / `FR-WEB` 及大部分 `FR-CAP` 细项
- Device（真实设备租约）、共享资产 BlobStore、`.deepsonarpack` 导入导出的专章（归属见 README §4.2）
- 质量属性场景化（刺激-响应-度量）→ PR 5 `04-quality-attributes.md`
- 完整接口字段表 → 以 OpenAPI / shared-types 为准，PR 5 `09-interface-specs.md` 只引用

