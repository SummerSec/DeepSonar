# DeepSonar Design

> **状态**：当前主线 as-built 执行摘要与演进边界（实现状态、工程验收与未交付质量项严格分离）
> **同步日期**：2026-11-27
> **事实入口**：本文为架构执行摘要；详细规格与专题按 [架构归属表](docs/architecture/README.md) 定位，专题状态见 [`docs/README.md`](docs/README.md)，长期 AI-native 演进方案见 [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)。实现事实以代码、[`database/schema.sql`](database/schema.sql)、OpenAPI 和测试为准；规范违约记录为缺陷，不改写规范迎合 bug。
>
> **质量验收与范围边界（2026-11-01 范围决定）**：按 [`AGENTS.md#豁免范围`](AGENTS.md#豁免范围)，独立人工质量标注、问题家族/资产隔离调参与留出集、后续质量门、Host 外部证据认证/当前证书、CAS 晋升和公开强关系建议暂缓，不作为本阶段 PR 合并、工程 Issue 收口或发布前置条件；工程验收以最终 SHA 在 GitHub Actions 的全部适用检查实际全绿为准。质量效果如实保持 `unknown` / `not_evaluated`，强关系保持 `published=false`；**工程完成不等于质量通过**。

---

## 目录

1. [设计判断与核心理念](#1-设计判断)（含[核心理念：优化人的注意力](#核心理念优化人的注意力)、[不向后兼容](#不向后兼容)）
2. [四层真相与职责](#2-四层真相与职责)（含任务契约、目标授权与成果评审分层）
3. [核心实体](#3-核心实体)
4. [AI-native 能力模型](#4-ai-native-能力模型)（Skill 控制面、Capability Pack、Runtime Profile、Pi OM、Plan v2、[4.3 失败反馈与修正](#43-失败反馈与修正)）
5. [当前执行闭环](#5-当前执行闭环)
6. [Finding、Verify、Research 与报告](#6-findingverifyresearch-和报告)
7. [Job、Attempt、调度与恢复](#7-jobattempt-和恢复)（含全局暂停、维护升级、历史库回收与 OpenSandbox 熔断）
8. [配置、快照与运行时](#8-配置快照和运行时)（含凭据先行解析、透明 Model Gateway、DSH/Pi/Claude 与镜像治理）
9. [读图、事件、过程流与人工续做](#9-读图事件与证据)
10. [前端信息架构](#10-前端信息架构)
11. [安全与授权硬门](#11-安全与授权硬门)
12. [当前状态与开放演进](#12-当前状态与开放演进)
13. [实现硬约束](#13-实现硬约束)
14. [仓库地图与事实入口](#14-仓库地图与事实入口)

---

## 1. 设计判断

DeepSonar 的产品形态是 **「可信执行内核 + 可组合能力」**：模型负责理解目标、选择能力、提出计划、读取状态、修正错误和判断业务收敛；内核负责把这些提案变成有权限、有预算、有证据、有账本的执行。

- **一切皆插件的边界**：插件化仅适用于业务能力、角色组合与交付投影。**沙箱、凭据、镜像准入、Job/Attempt、租约、并发、资源预算、幂等、副作用结算、审计与未知外部效果永远属于可信内核**；插件不得通过第二套控制通道绕过这些边界。
- **能力组合替代静态角色配置**：现有角色（`explore`、`analyze`、`review`、`test`、`code`、`audit`）是内置 Capability Pack 的默认组合；Pi 等 CLI 的已注册扩展属于受准入的角色能力插件，最终非敏感引用冻结进 Job 快照（`RoleConfig.pi_extensions` 已于 #690 删除）。
- **主执行环路**：`Canvas` 即任务；Hub 根据图状态提出 Intent，Scheduler 准入并创建 Job，Worker 在一次性沙箱中执行，结构化事实进入 Canvas，Verify、Research 与 Report 推动结果收敛。

### 核心理念：优化人的注意力

**在授权、安全、正确性与可追溯性成立的前提下，用尽可能少的人类注意力，交付尽可能多的有效成果。**

注意力成本包括理解状态、补充信息、切换任务、判断风险、作出决定和验收结果的总负担。需求与设计必须说明减少了什么人工负担，以及新增设置、通知、决策和维护的代价；已有能力足以满足时先复用，不为展示自主性增加概念、Agent 或流程。

界面与沟通优先呈现可行动的决定、实质阻塞、风险变化和可验收成果；正常运行与重复状态合并展示，证据和执行详情按需展开并保留审计。既有授权内可自行核实和完成的事项先自行处理；必须提问时说明缺失输入、影响和需要的具体决定，不机械重复索取有效授权。

少打扰不能靠隐瞒失败、把不确定性转嫁给用户、默认扩权、自动批准/合并或降低验证要求实现。执行结束、草稿、未知状态分别按其真实证据表达，不冒充目标达成、交付或通过。本节是原则的单一权威定义；[工程评审问题与正反例](docs/architecture/11-engineering-specs.md#11-注意力成本评审830)说明落实方式，[NFR-UX-001](docs/architecture/01-system-specification.md#nfr-ux-001-人的注意力与可行动交互)登记需求与验收。可行动人工请求用结构化指导减少用户猜测操作和反复澄清，同时增加请求填写与阅读成本，预期收益尚无实测数据。

### 不向后兼容

所有设计只支持当前目标契约，不为旧版本或旧设计保留向后兼容。删除旧设计时同步删除对应的 schema、API、UI 和运行时路径，不保留双读双写、fallback、shim、legacy 模式、旧配置转换或兼容窗口。旧配置无法满足新契约时 fail closed，要求按新契约重新配置，不得自动迁移以延续旧语义。

已创建 Job 的冻结快照、Evidence、审计记录和历史结果是不可变历史事实，不作为新运行时的兼容输入。代码中尚未删除的旧路径必须标为实现债务，不能写成受支持的设计（例如 Provider 账号到 RoleConfig 的旧绑定路径已在 #690 物理删除）。

---

## 2. 四层真相与职责

| 层 | 唯一职责 | 真相 | 不能做什么 |
| --- | --- | --- | --- |
| **PostgreSQL / API** | 管理与审计 | 项目、Canvas、Job、配置、权限、账本 | 不把模型文本当状态 |
| **Canvas** | 过程编排与观察 | root、Intent、Fact、Artifact、Finding、Job、边和广播 | 不由 Agent 提交坐标或直接改状态 |
| **Sandbox / Evidence** | 执行与原始证据 | 进程、工具、Session、产物、运行流 | 不保存长期凭据，不成为控制队列 |
| **Scheduler** | 副作用唯一执行者 | claim、状态迁移、派生 Verify/Report、结算、清理 | 不替模型做领域推理 |

**固定原则**：本地库是管理真相，画布是过程真相，沙箱是执行真相，调度器是唯一有副作用的执行者。Web 是管理平面，画布是只读投影；真实 Job 的语义写入只能来自按 Job 授权的 Control API。

### 任务契约、目标授权与成果评审分层（#767 / #822）

- **版本化任务契约（`task_contract`）**：共享 schema 与场景模板统一 API、Web 与管理 CLI 的结构化输入，Canvas 保存解析后契约与模板版本，同时继续支持自由文本输入。
- **目标授权（`deepsonar.target-authorization/v1`）**：由宿主配置的只读 authority 核验（当前适配器限定 `reference-http/v1`），精确绑定认证 principal、租户/角色/资源、动作、前提、任务契约与 authority revision。密钥仅留宿主；无密钥 grant 追加到系统 `audit_logs`，供子 Job 与系统 Job 继承并在 provision 前及重跑时重验；缺失、过期、撤销或未知条件以不可重试 `target_authorization_grant_invalid` 拒绝，不执行目标写操作、不授予额外出网权限。详见 [FR-TASK-006](docs/architecture/01-system-specification.md#fr-task-006-版本化任务契约与派发前校验)、[ADR 0011](docs/architecture/adr/0011-trusted-target-authorization.md)、[验收矩阵](docs/TASK_DISPATCH_ACCEPTANCE.md)。
- **成果与资格分层**：将研究候选（`admitted_for_research`）、技术验证（Verify）、任务判据评价（`goal_review`）、程序规则复核（`program_rule:<ruleid>`，仅复核 `operator_supplied` 材料）与操作员程序资格（[#822](docs/PROGRAM_ELIGIBILITY.md)）严格分层，各自保留独立 authority，互不替代，也不以 Finding 数量或 severity 计目标完成。工程 delivery 与合法 `negative_result` 使用 Fact 的 `task.result` Artifact，无需强造 Finding；无契约任务保持 `unassessed`。详见[结果评审](docs/TASK_RESULT_REVIEW.md)、[首片边界](docs/TASK_OUTCOME_ADMISSION.md)、[评审边界](docs/TASK_GOAL_REVIEW.md)。

---

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
| `Project` | 资产范围、配置、凭据绑定与项目级权限边界。 |
| `Canvas` | 一任务一画布；`kind=standard` 为普通任务，`kind=compose` 为带冻结 Finding 种子的组合任务。 |
| `Intent` | Hub 对下一步工作的提案：角色/能力、完整 prompt、引用节点、预算与可选运行时镜像。 |
| `Job` | 一次受调度的沙箱执行（Hub、工作角色、Verify 或 Report）；状态由 Scheduler 判定。 |
| `Attempt` | Job 的一次领取与执行尝试；持有快照身份、沙箱身份、取消标记与效果账本。 |
| `Artifact` | 版本化内部写入真相，保存 kind、schema version、claims、evidence、relations 与 provenance。 |
| `Fact` | 工作角色提交的结构化观察或验证证据；拥有独立的 `verification_status`。 |
| `Finding` | Artifact 的可查询安全投影，保留 profile、category、severity、scoring、tags、`evidence_refs` 等领域字段。 |
| `Finding research` | 对 Finding 做语义去重、canonical anchor 与相对优先级；不改变技术验证与报告门禁。 |
| `Report` | Task Report 与 Finding Report 均为冻结输入后的版本化 Projection；SARIF 仅作为人类交付导出投影。 |

**不可混写原则**：Artifact 是内部写入真相，Finding 是对外风险对象，Fact 是观察与证据。

---

## 4. AI-native 能力模型

### 4.0 Skill 与模块源控制面（#603 / #691 / #953 / #954 / #960）

- **平台控制面**：平台 `trusted + enabled` Skill 源默认进入项目 Job 快照可见集合；`project_skill_sources` 只保留显式停用这类收紧。CLI × Provider × 平台镜像 × Skill 从信任基线自由组合（已移除 `image_strategy` / `role_runtime_images`）。官方镜像平台默认可用（`deepsonar-base` 永不可停用）；第三方镜像经平台绑定 `visible_project_ids` 后项目可启用。
- **平台控制 Skill 隔离**：`deepsonar-control` 对真实 Job **强制注入**，不可被 RoleConfig 同名覆盖，不计入项目 Skill 白名单。
- **运行时自主拉取与快照冻结**：业务 Skill 不因 RoleConfig 为空而默认注入；Agent 在 Job 内调用 `list_available_skills` / `search_skills` / `pull_skill` 按需拉取，受当前 Job token、预算、网络和审计边界约束。Job 创建时冻结 `module_selectors`、digest、模块内容 hash 与 missing；后续源同步不影响在途 Job。RoleConfig `modules_json` 为过渡态缺省建议，候选必须 ⊆ 项目白名单。
- **源保鲜、候选审批与就地登记（#953 / #954 / #960）**：
  - 手动/启动/周期同步共用跨实例 session advisory lock，clone/scan/CAS 后仅暂存候选，不直接改 live 目录、trust/enabled、撤销 epoch 或 RoleConfig；仅当前 `trusted+enabled` 的同一 live hash 健康核验可前移 `synced_at`。
  - 全局管理员按精确候选 hash、expected epoch 与 source instance 审批后原子发布并写审计；批准并启用对所有未显式停用该源的项目生效。项目限定令牌仅可改本项目启停。
  - 新鲜度以已批准目录 `synced_at` 为准（[`skill-freshness.ts`](apps/scheduler/src/skill-freshness.ts)）；未成功核验时 API 为 `null`、Prometheus 为 `+Inf`。陈旧/候选提示与 `source_update_pending` 不进 `catalog_hash`，不改变权限。详见[数据](docs/architecture/08-data-architecture.md#skill-源已批准目录与候选960)、[接口](docs/architecture/09-interface-specs.md#全局-skill-源候选审批960)、[IR-007](docs/architecture/01-system-specification.md#ir-007-git-skill-source) 与[前端状态推导](apps/web/src/skill-source-readiness.ts)。

### 4.1 Capability Pack、工具模块与项目知识

- **Capability Pack（`deepsonar.capability-pack/v1`）**：定义于 [`packages/shared-types/src/capability-pack.ts`](packages/shared-types/src/capability-pack.ts)，声明 `id`/版本/scope/不可变 `sha256`、输入输出 schema、`platform_tools`、出网、预算、`correctable`/replay 策略与可选 evaluator。已落地只读目录投影与 Job 级发现操作（`list_capabilities` / `search_capabilities` / `describe_capability` / `validate_composition` / `preview_materialization`）；`deepsonar-management` 亦可被发现。**发现不是授权**，模型不得借 Manifest 或 `pull_skill` 扩大工具、凭据、镜像、`allow_egress` 或项目范围。task/session Pack 持久化生命周期、评估晋升与跨任务推荐尚未落地。
- **Language Server 模块（`deepsonar.language-server-capability/v1`）**：首期登记 `language-server.clangd`，经 Hub `language_server_capability_id` 提案并由 Scheduler 校验镜像与 `compile_commands.json` 前置后冻结进快照；受控有界适配器位于 `agent-harness/language-server-adapter.mjs`。禁止 Agent 任务内安装或静默回退 raw `clangd`，不可用返回 `capability_unavailable`。
- **General CLI 模块（`deepsonar.cli-capability/v1`，#611 / #718）**：登记 `rg`/`jq`/`git`/`file`/`sha256sum`/`timeout`/`archive.extract` 等基础工具（`fd`/`yq`/`patch.diff` 默认不可用），以及 `deepsonar-reverse` 专属的 `binary.rea.cli`（钉死 REA CLI + Ghidra，CLI-only，见 [REA 专题](docs/REA_CLI_CAPABILITIES.md)）。Hub 通过 `cli_capability_ids` 提案，Scheduler 准入冻结；CLI 输出固定 `is_finding: false`，仅作 Evidence/Fact 输入。
- **项目知识 Memory / Skill（#752 / #777 / #778 / #903 / #1197 / ADR 0024）**：
  - 项目 Memory 与 Skill 具有不可变版本、独立 6×2 试验/审查与持久 receipt/work；项目 Skill 默认私有，来源项目仅可授权指定精确版本（不含来源 Memory/Evidence 或未来版本）。Job 冻结目录与实时撤销取交集，禁用后重启用不恢复旧 Job 权限。
  - **自动积累与会话收尾**：成功任务终态登记知识来源元数据，Dispatcher 按 [ADR 0024](docs/architecture/adr/0024-project-knowledge-batching-admission.md) 在项目行锁内按积累量/等待时长/冷却间隔与连续空产出停发门控触发自动整理；`record_knowledge_feedback` 仅记录持久反馈（`{usage_ref, state:"recorded"}`）。授权业务 Agent 亦可在原 Job 会话收尾提交有证据的 Memory/Skill 建议，由有写权限操作者在画布末尾节点择一送独立评测（[#1197](docs/PROJECT_KNOWLEDGE.md#任务会话收尾1197)）。
  - **条件建议与离线工具**：`suggest_project_skills` / `record_skill_choice` 提供当前项目 Skill 精确版本条件匹配与选择声明（[Skill 建议专题](docs/SKILL_SUGGESTIONS.md)）；离线能力证据审计见 [`agent-harness/capability-evidence/README.md`](agent-harness/capability-evidence/README.md)，离线适用 preflight 见 [`agent-harness/capability-applicability/README.md`](agent-harness/capability-applicability/README.md)，独立研究协议见 [`agent-harness/knowledge-live/STUDY.md`](agent-harness/knowledge-live/STUDY.md)。真实模型知识收益仍为 `unknown` / 未实测。详见 [PROJECT_KNOWLEDGE.md](docs/PROJECT_KNOWLEDGE.md)（含 [拒绝反馈切片](docs/PROJECT_KNOWLEDGE.md#knowledgeskill-拒绝反馈903-切片)）。

### 4.1.3 Agent Runtime Profile（#613）与 Pi 会话观测记忆（#815）

- **Agent Runtime Profile（`deepsonar.agent-runtime-profile/v1`）**：定义于 [`packages/shared-types/src/agent-runtime-profile.ts`](packages/shared-types/src/agent-runtime-profile.ts)，作为只读无密钥 Job 快照部分统一投影 `provider_ref`、`model_ref`、`reasoning_effort`、`context_window_tokens`、`extensions`、`system_prompt_ref`、`env_refs`、`native_options`（仅 `claude_code` / `pi` / `dsh` 三命名空间）与 `profile_fingerprint`。不建第二 Gateway，不存凭据值或环境变量值；不支持配置在 snapshot 解析边界 fail closed。
- **受治理 Pi 会话观测记忆（`pi-observational-memory`，#815）**：锁定 canonical npm 版本与受审 wrapper 指纹并进入镜像 fingerprint，校验镜像 OM 专属下限（[`pi-extensions.ts`](packages/shared-types/src/pi-extensions.ts)）。内核签发独立 workload 凭据，Gateway 区分主任务与 memory 归因、按显式总/主/后台限额记账并在终态撤销全部 workload token；仅内核证实未启动且持久结算零用量/`never_started` 的 transient 允许可见降级（不退请求次数），协议/权限/未知效果硬失败。历史预览/下载在截断发送前脱敏。记忆仅作上下文，不构成 Fact、Evidence 或完成 authority。详见 [FR-CAP-009](docs/architecture/01-system-specification.md#fr-cap-009-受治理-pi-会话观测记忆)、[ADR 0013](docs/architecture/adr/0013-governed-pi-memory.md)、[Gateway 专题](docs/PI_OBSERVATIONAL_MEMORY_GATEWAY.md) 与 [RPC 专题](docs/PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。

### 4.2 Plan（v2）

- **严格 v2 契约（#775）**：新执行仅接收 [`Plan v2`](packages/shared-types/src/plan.ts)；v1 与 `hub_intent_adapter` 仅保留于不可变历史审计只读解析，旧适配代码已物理删除。授权用户以 CAS 写入 Canvas objective、完成策略与有限预算（初始创建携带 objective 时绑定最终冻结后的 Canvas/root 输入 SHA）；模型只能提出与当前 objective/revision 一致的路线，不能重写目标或重置 lifetime 计数。
- **多轮推进与依赖核验**：在累计任务、轮次、并行与无进展护栏内支持多轮重规划；已消费的 continue 语义事件按绑定 owner/Canvas/Plan 身份的持久水位去重。普通自动 Hub 唤醒不复活 `status=stopped` 的 objective（Finding 评论 `request_hub` 亦明确拒绝唤醒）。PlanTask 复用既有 Hub Intent admission，依赖就绪须核对当前成功 Attempt、来源事件、未替代 Artifact、`plan.output` 关联与宿主留存字节/hash；`plan_execution.stop_reason=complete` 仅表示工程路线条件满足，**最终完成仍要求操作员全判据授权与完成门**。详见 [ADR 0012](docs/architecture/adr/0012-plan-v2-execution.md)、[Plan 重建规则](docs/PLAN_GAP_PROJECTION.md#多轮推进重启与停止)。
- **按需读图与预算门控**：Hub 初始只读有界 L0/overview，通过 `graph_query(kind=plan_objective)` 按需获取完整持久化 objective tuple（预算或 hash 不满足直接失败）。用量额度采用显式配置（普通请求、修正 token、验证轮数、图查询与 LSP 未配置不限，显式正数生效，详见 [USAGE_LIMITS.md](docs/USAGE_LIMITS.md)）；Gateway 额度跨 token/Attempt 累计，OM 与主请求上限取历史与当前有限值最小值（[透明网关预算](docs/MODEL_GATEWAY_TRANSPARENCY.md#预算与-om-迁移)）。
- **内核平台门禁非成功出口（#1002 P0-3）**：Reaper 对内核证实的 stopped objective 或完成修正次数/已知 token/原 deadline 耗尽的活动 Hub 提供受控非成功终止出口，保留已接受人工等待与同伴/报告阶段共享状态，不把 unknown 用量或销毁当作成功。详见 [AGENT_REPAIR_LIFECYCLE.md](docs/AGENT_REPAIR_LIFECYCLE.md#kernel-平台门禁出口1002-p0-3)。

### 4.3 失败反馈与修正

**所有供 Agent 调用的平台 API 遵循同一原则**：请求违规且可修正时，平台拒绝本次调用，在工具响应中明确告知错因、约束与重提方式，允许当前 Agent 继续执行已授权步骤；单次可修正错误不得触发任务阻塞、终止或转人工，依赖该结果的步骤须等成功回执推进。

| 类别 | Scheduler 行为 | 模型能否修正 |
| --- | --- | --- |
| `model_correctable` | 返回字段级反馈，允许同 Session 用新 revision/Idempotency-Key 重新提案 | 可以 |
| `transient_retryable` | 按已证安全策略有界退避或恢复，保持幂等语义 | 通常可以 |
| `unknown_external_effect` | 停止自动重放，转对账、`orphan` 或人工处理 | 不能猜测 |
| `permanent_failure` | fail closed，要求权限、配置、版本或快照修复 | 需外部修复 |

- **契约与脱敏**：`RepairFeedback`（`packages/shared-types`）至少包含 `category`、`code`、`operation`、`path`、`message`、`expected`、形状化脱敏 `observed_shape`（禁回显凭据/Provider 原文/不可信输入）、`current_state_ref`、`accepted_effects`、`idempotency_key`、提案/修正次数、剩余预算与 `next_action`。预算耗尽明确进入 `blocked` 或 `needs_human`。
- **完成回执、修正预算与诊断（#776 / #951）**：`mark_job_done` 在原 Control 通道保留持久拒绝/接受回执与 revision（`persisted_deferred` ≠ 效果结算）；C0/C1 分别提供 Hub 无效引用 scoped 刷新指引与完成门缺失项有界投影；完成拒绝可冻结独立 repair-token 限额（未配置/0 不限，Gateway 在 Job 锁内预留并遇未知用量停止，见 [REPAIR_FEEDBACK_DONE_REPAIR.md](docs/REPAIR_FEEDBACK_DONE_REPAIR.md) 与[验收矩阵](docs/REPAIR_FEEDBACK_ACCEPTANCE.md)）。缺 done 诊断按受权限保护的 Evidence 记录当前可归属产出与原回执状态，不推定责任或授予成功/重放（[#951](docs/AGENT_REPAIR_LIFECYCLE.md#完成失败诊断候选951)）。
- **边界**：`accepted` 语义为 durable receipt；`effect_pending` / `unknown` / `replay_policy=never` 严禁自动重放。基线缺口见 [REPAIR_FEEDBACK_BASELINE.md](docs/REPAIR_FEEDBACK_BASELINE.md)。

---

## 5. 当前执行闭环

```text
创建 Project / Canvas（可选 task_contract / device requirements / initial objective）
        ↓
Hub 读取有界 graph scope 投影（按需 graph_query）并提交 Intent / Plan v2
        ↓
Scheduler 做目标授权、权限、引用、预算、凭据/CLI、镜像与能力 admission
        ↓
Job → Attempt → provision → running → 一次性沙箱（强注 deepsonar-control）
        ↓
Control API：progress / fact / artifact / finding / human / done（三层校验 + durable receipt）
        ↓
finalizeJob：Verify、Research、下一轮 Hub 或 Report（savepoint 保护）
        ↓
Task Report / Finding Report / SARIF 导出 / 人工处置
```

- Hub 仅能提出工作角色 Intent，`verify_finding` 与 `report` 为 Scheduler 派生系统 Job；单 Canvas 同时最多一个活跃 Hub。
- Hub 仅可引用当前画布已投影的 canonical UUID 与数据库 Finding UUID；字段名、别名、跨画布 ID 与占位符均拒绝。
- 当前治理新执行 CLI 为 **Claude Code、Pi、DSH**；历史 Codex/OpenCode 归档仅供只读查看。

---

## 6. Finding、Verify、Research 和报告

### 6.0 项目 Finding 来源身份、查询与检索（#770 / #819）

- **来源身份（#770 A）**：使用 `(job_id, fingerprint)`，独立于 Control 幂等键；不同 Job 相同文本保留独立 Finding/Artifact，不继承验证或处置，同来源内容冲突直接拒绝。见[数据架构](docs/architecture/08-data-architecture.md#finding-来源身份770-a)。
- **项目交付查询（#770 B）**：服务端多选/文本筛选与游标分页，汇总与列表共用筛选条件并同步 URL。见[接口规格](docs/architecture/09-interface-specs.md#finding-项目查询770-切片-b)。
- **特征、词法检索与离线评估（#770 C/D / #819）**：Scheduler 维护可重建特征与持久词法候选账本（读取时复查双端来源与权限，失效即隐藏，不确认同问题或传播处置）；离线评估工具见 [PROJECT_FINDING_EVALUATION.md](docs/PROJECT_FINDING_EVALUATION.md)，特征研究见 [PROJECT_FINDING_RESEARCH.md](docs/PROJECT_FINDING_RESEARCH.md)。独立人工标注/留出阈值、Host 外部验证证书与强关系公开均未交付（`STRONG_RELATIONS_PUBLISHED=false`），保留 [FR-FIND-007](docs/architecture/01-system-specification.md#fr-find-007-可重建特征与关联质量边界)、[FR-FIND-009](docs/architecture/01-system-specification.md#fr-find-009-操作员见证身份与跨任务关联) 与 [ADR 0014](docs/architecture/adr/0014-operator-finding-identity.md) 边界。

### 6.1 Verify

- **结构化 Fact 门禁**：review/test/worker 复核结果须作为结构化 Fact 提交（含 `finding_id`、`subject_revision`、`ownership`、`expected`、`actual`、`outcome`）；普通文本 verdict 不计入门禁，Verify 不读 maker 文本自述（#399）。
- **版本化 Fact-first 策略（`strategy_id=fact_first`，v1）**：直接确认与 `verify_finding` 共用同一门禁路径；一般/CTF 场景 review+test 配对缺口记为 `advisory`，不写进 `missing_evidence`；冲突、来源失败、错误 `finding_id`/`subject_revision` 为必需阻断；无版本历史记录标 `legacy/unversioned`。
- **安全 Profile 强制断言（#590 / #576 / #578）**：
  - `used_fact_ids` 须在确认前 EXISTS 解析到合法真实 Fact（归属、ownership、来源 Job ≠ Finding 原 Job）；悬空引用阻断并 rework。
  - `security.vulnerability` / `security.misconfig` / `security.secret` 的 `confirmed` 要求独立 review≥1、合格 test≥1（含 `artifact_refs`）、`missing_evidence == []`、`attempted_refutation` 及非空 `impact_flow`（或显式 `impact_waiver`）；location/summary 中的 TODO/crbug/CVE 自动打 `known_issue` 标签。
  - 可选冻结证明契约 `security.vulnerability.proof` v1（默认关闭）：要求固定 revision、攻击者控制点、前置条件、可达路径及静态或动态证据，缺工具/目标/设备降为 `inconclusive`。
- **证据留存追踪与用途投影（#1019）**：确认记录的 `fact_evidence_trace` 通过 Artifact `source_event` 精确绑定来源 Attempt 并核验留存真实字节（`execution_assurance:not_attested` / `retained_bytes_verified`，不执行命令，详见 [EVIDENCE_TRACE.md](docs/EVIDENCE_TRACE.md)）；Fact 展示区分过程观察、关联证据与实际采纳证据（[事实用途](docs/EVIDENCE_TRACE.md#事实用途与待处理投影1019)）。
- **三独立状态机与收敛保护（#890 / #1133 / #1206）**：
  - Fact `verification_status`、Finding `verify_status` 与人工 `disposition` 相互独立；人工不可直接改 `confirmed` 或把 rejected Fact 升为 `verified`。人工 `disposition=duplicate` 须绑定同项目 `duplicate_of`，单列聚合不改写 `verify_status`（#1206）。
  - 具有 `findings:write` 权限的操作者可对 `needs_human` 的 Finding 以 CAS 显式记录无定论技术收口（新增终结轮次并同事务写审计，见[人工结束技术验证](docs/architecture/09-interface-specs.md#人工结束技术验证1133)）；补证入口复用画布设备要求冻结，无进展刹车尊重配置开关（[运行时规则](docs/architecture/06-runtime-view.md#verify-补证无进展开关1133)）。
  - Hub 证据唤醒按门禁指纹边沿触发（从未有过证据的 pending 必唤醒）；停滞未收口按原因分类收敛（#890）：预算/取消/停滞/陈旧/未知原因归 `inconclusive`（未知计入 `deepsonar_verify_policy_gap_total`），仅能力边界升级 `needs_human`，并写入 `paused_reason=verify_unclosed:…`，禁止静默停机。

### 6.2 Research

- **假设循环与已知性（#579 / #581）**：`research.hypothesis_loop` v1 支持正向论据、替代解释、保护条件、反例与父命题派生；「未找到反证」≠ `confirmed`。known issue 在 pinned revision 仍受影响时不得自动降级；覆盖率须有可解释分母。
- **只读辅助层**：Scheduler 按有界批次做语义聚类，维护 canonical anchor、重复关系、`dedupe_reason` 与相对 `priority_score`（注意力分配而非 severity），不改 `verify_status`、severity 或报告收敛。写失败须显式记录并用 savepoint 隔离，不得回滚主 Finding/Report 写入；读取入口 `GET /canvases/:id/finding-research`。

### 6.3 Projection

Finding 变为 `confirmed` 后生成冻结输入的 Finding Report，Canvas 收敛后生成版本化 Task Report；相同输入幂等、输入变化追加版本，失败不改写内部事实。Task Report 覆盖门逐项核对精确唯一 Finding ID 位于正确状态二级章节，缺项/错栏/重复/数值失真时由冻结输入生成确定性完整模板（不受模型 `summary` 字节上限限制）。

---

## 7. Job、Attempt 和恢复

```text
pending → claimed → provisioning → running → succeeded
                         │             ├→ waiting_human → pending
                         └─────────────└→ failed / timeout / cancelled / orphan
```

### 7.1 调度、认领与配额（#1118 / #1123 / #1180）

- **统一调度（删除项目任务队列，#1180）**：已彻底移除项目任务队列（schema 79，无兼容分支），所有任务统一受 Scheduler 与六档并发控制（全局/项目/Provider/凭据/模型/Agent CLI）。详见 [PROJECT_TASK_QUEUE.md](docs/PROJECT_TASK_QUEUE.md) 与 [ADR 0026](docs/architecture/adr/0026-remove-project-task-queue.md)。
- **默认不限配额与跨项目公平领取（#1118 / #1123）**：全局 `null` 不限、项目 `null` 继承、项目 `0` 暂停（显式正数与环境变量保留，见[调度配额](docs/architecture/06-runtime-view.md#默认不限的调度配额1123)）。跨项目采用项目服务序号与有界 keyset 候选页公平领取（[公平领取](docs/architecture/06-runtime-view.md#持久跨项目公平领取1118)），按 `advisory lock → 排序 Canvas → project → Job → Attempt` 取锁并重核暂停/scope/配额，忙锁候选不耗槽位。`pg_notify('deepsonar_jobs')` 为主唤醒，`SKIP LOCKED` 遇临时锁竞争时合并一次延后唤醒，不退化为轮询（[认领唤醒](docs/architecture/06-runtime-view.md#行锁竞争后的认领唤醒)）。

### 7.2 效果账本、对账、清理与完成恢复（#871 / #874 / #899 / #903 / #945 / #946 / #1002）

- **Attempt 与效果账本**：外部动作先写 `job_attempt_effects`（`effect_pending`），观察结果后写 settlement；`unknown` 或 `replay_policy=never` 禁止自动重放。仅明确宿主证据证明未调用外部创建才可结算为 `never_started`（缺少 `sandbox_id` 不足以证明）。
- **周期对账与人工等待保护（#874 / #946）**：内置周期对账仅自动结清有确凿账本/节点证据的在途效果（`gateway_model_request`、`canvas_delivery`），`undecided` 维持 `unknown`、绝不重放；`interrupted` 不入终态枚举，`agent_run` 保持未知。Reaper 判 `waiting_human` 超时前先定向对账，有未结清效果或本轮有进展时不记 `human_timeout`（[#946](docs/AGENT_REPAIR_LIFECYCLE.md#人工等待超时与未结清效果946)）。
- **历史效果人工结清（#899 / #1002 P1-9）**：CLI（[deploy/README.md](deploy/README.md#未知效果的人工结清899)）与管理 API `POST /jobs/:id/effects/:effectId/settlement`（[单条效果结清](deploy/README.md#管理-api-的单条效果结清1002-p1-9)）允许管理员以书面证据结清历史非活动 Attempt 效果；拒绝覆盖旧证据、不自动入队、不改 `replay_policy` 或预算。
- **终态撤销、共享卷锁与文件投影（#871 / #945）**：
  - `finalizeJob` 同事务撤销 Job/model/Control token 并写审计；终态后派生 Hub/Report 在 savepoint 内核验目标 grant，拒绝时暂停 Canvas 而不回滚前驱终态。
  - 共享卷受同 Job 独立 PG session 生命周期锁与最新 Attempt fence 保护，使用 generation 卷名，清理前重验所有权（[SHARED_ASSET_BLOB_STORE.md](docs/SHARED_ASSET_BLOB_STORE.md#跨-attempt-共享卷生命周期871)）。
  - Task/Finding Report 精确输入字节随 SQL 原子提交，领取后、runtime IO 前再投影文件；纯 DB 冲突重试保留原始 SQLSTATE，不含文件 IO 或未知效果重放（[#945](docs/architecture/08-data-architecture.md#report-输入与文件投影945)）。
- **完成恢复与重试前检（#874 / #903 / #1126 / #1236）**：完成恢复 v1 仅允许 Scheduler 冻结授权的精确对账/停止提案进入原事务（[REPAIR_FEEDBACK_DONE_REPAIR.md](docs/REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)）；Web 恢复面板按当前动作与权限结论优先展示，技术诊断默认折叠（[#1126](docs/architecture/05-building-blocks.md#job-恢复提示1126)）。清空重试先做确认前检查展示历史保留原因，实际提交仍在事务内按当前状态重验（[#1236](docs/architecture/09-interface-specs.md#清空重试的确认前检查1236)）。Job `resume` 沿用冻结快照，`rerun-current` 才重解当前配置并重冻（身份漂移返回 `SNAPSHOT_STALE`）。
- **OpenSandbox 创建熔断与鉴权探针（#1046 / #1119）**：进程内熔断以真实 provision/create 5xx 驱动（窗口、半开单名额 canary、指数退避上限及 episode 归因隔离，日志仅留允许名单失败码，不截断保存错误原文）；生产/远程 Worker/K8s 共用同一鉴权 List 探针；熔断状态独立于重放权限，未知效果继续禁自动重放。详见 [OPENSANDBOX_1_2_UPGRADE.md](docs/OPENSANDBOX_1_2_UPGRADE.md#创建熔断与鉴权管理探测1119--1046) 与 [ADR 0015](docs/architecture/adr/0015-governed-completion-recovery.md)。

### 7.3 全局暂停、平台版本发现与维护升级（#740 / #842 / #1124）

- **全局暂停领取**：`POST /platform/claims/pause` 持久化到 `global_settings` 单例行（缺失 fail closed 视作暂停），仅阻断新 `pending → claimed` 不杀在途；`GET /platform/claims` 报告在途与全库 `effect_pending`/`unknown`（三者归零即排空，`waiting_human` 单列）。
- **不可变平台镜像部署契约**：Compose 强制要求 `DEEPSONAR_SCHEDULER_IMAGE` / `DEEPSONAR_WEB_IMAGE` / `DEEPSONAR_IMAGE_ADMISSION_IMAGE=<registry>/<name>@sha256:<digest>` 与显式 `DEEPSONAR_VERSION`（`DEEPSONAR_IMAGE_TAG` 已物理删除）；registry 通道由 `deploy/platform-release-catalog.mjs` 单点定义（`github`/`dockerhub`/`aliyun-acr`），cosign 验签恒用 `registry_refs.github`（#842）。
- **维护模式候选库重建与历史库回收**：跨 schema 升级进入维护模式，停写排空、冻结源库并验证备份后重建候选库，配置离线预检校验密钥与全量凭据 AES-GCM；激活前/后恢复边界分明，无人值守默认关闭。历史候选库回收（#1124 B）提供默认预览与显式审批执行，保留当前库、最近恢复源及未决引用（[GENERATION_GC.md](deploy/GENERATION_GC.md)）。详见 [deploy/README.md](deploy/README.md)、[UPGRADE_REHEARSAL.md](deploy/UPGRADE_REHEARSAL.md) 与 [ADR 0008](docs/architecture/adr/0008-maintenance-candidate-upgrade.md)。
- **发布恢复边界**：仅复用绑定 GitHub 原运行/成功阶段/artifact 摘要的冻结载荷与原签名回执，默认分支恢复身份与原 tag 发布身份分离，不重建镜像、不移动 tag、不重签名（[恢复身份与原发布证据](docs/RELEASE_RUNTIME_IMAGES.md#恢复身份与原发布证据)）。

---

## 8. 配置、快照和运行时

### 8.1 配置优先级、提示词组合与凭据先行解析（#594 / #690 / #697 / #757 / #914 / #966 / #1002 / #1078）

- **优先级与只收紧**：固定 **Job > 角色/项目 > 平台 > env 引导**；项目对 `sandbox_limits` / `platform_tools` / `runtime_knobs` 只取 min/AND 收紧，不放宽安全硬门（#697）。所有创建入口（含 retry、自动 Hub、Verify、补证、Report）统一冻结 `agent_snapshot_json`，缺损历史快照不自动回退当前配置，仅在可信无效果前提下允许显式 `rerun-current`（[#943/#948](docs/AGENT_REPAIR_LIFECYCLE.md#创建入口补齐与缺损快照诊断943--948)）。
- **提示词组合（`prompt.composition` v1，#594）**：平台必需协议恒纳入不可覆盖；业务顺序为 **任务派发 → 项目 RoleConfig → 全局默认**；记录各层版本、摘要与注入通道（CLI 不支持则拒绝），自然语言不扩权。
- **账号 × CLI 排他绑定与凭据先行解析（#690 / #757 / #1078）**：
  - `llm_provider` 必须声明排他 `agent_cli`（写入、项目目录、候选解析、快照/readiness 四层 fail closed）；`role_credentials` / `batch-bind` 已删。
  - Scheduler 先按项目作用域、active、Provider、模型与显式白名单筛选凭据，再由凭据决定 CLI；多账号池按三层（凭据/模型/Provider）最小余量比例降序、在途数升序等规则排序，全满则冻结等待并合并唤醒，不计排队时间为执行超时；无法消歧返 `provider_credential_multi_match`，失效白名单返 `provider_credential_allowlist_stale`。详见[运行时视图](docs/architecture/06-runtime-view.md#凭据与-cli-解析757)。
  - 账号模型准入只认 `settings_config_json` 按 CLI 方言解析的模型清单（探测 `model_catalog_json` 不授选模权，应急直通仅平台 env 或管理员级项目 allowlist 授权）；项目默认模型与创建诊断见 [#966](docs/architecture/09-interface-specs.md#项目默认模型与创建冲突966)。
- **凭据引用保护与安全删除（#914 / #925 / #1002 P1-7A）**：凭据删除与项目设置/OCI 扫描共用凭据行锁，活动引用与未结束 Job 阻止删除（[凭据引用保护](docs/architecture/09-interface-specs.md#项目凭据引用保护914-切片)）；删除事务先撤销全部 Gateway token 再删秘密，保留历史 token/usage ledger 身份与已用额度（[删除凭据与历史预算](docs/MODEL_GATEWAY_TRANSPARENCY.md#删除凭据与历史预算1002-p1-7a)）。
- **数据库重建身份与 ACL 保全（#757 / #1002 P1-6 & P2-13）**：旧库跨 v60 重建执行角色身份复核，仅管理员显式 `--reset-role-identity` 重置（[database/README.md](database/README.md#v60-角色身份复核757)）；直接重建同事务保存并恢复 `public` 有效 ACL、默认授权与列级 grant option（[重建授权保全](database/README.md#重建授权保全1002-p2-13)）；Canvas/Finding 级联外键补全前导列索引（[节点引用索引](database/README.md#canvas-节点引用索引1002-p1-6)）。

### 8.2 Model Gateway 透明传输与凭据防泄（#923 / #1032 / #1082 / #1097 / #1230 / #1252）

- **透明原字节传输（#923 / ADR 0017）**：新 Job 冻结非秘密 provider 配置摘要（支持 secret-only 轮换，目标或业务头变更拒绝）；已授权请求保持原方法/路径/头/body，认证、目标、framing 与逐跳连接策略（[#1097](docs/MODEL_GATEWAY_TRANSPARENCY.md#managed-proxy-的逐跳连接策略1097)）由内核控制，响应/SSE 原字节流式转发，usage 旁路观察。Pi 与 DSH 通过原生/锁版本 SDK hook 逐次协商预算；Claude Code 保留启动/resume 原生上限，运行中余额不足直接拒绝提示（用户已接受此限制）。
- **结算时序、用量诊断与同 Job 恢复（#1002 P1-9 / #1082 / #1230 / #1252）**：
  - 结算回执按同 Job、原 token、请求 ID、workload 与 `gateway_model_request` 唯一持久身份查询（[#1230](docs/architecture/09-interface-specs.md#model-gateway)）；未压缩 Responses SSE 完成块有界暂存至上游结束与账本落盘（[#1252](docs/MODEL_GATEWAY_TRANSPARENCY.md#responses-完成尾部与结算时序1252)）；最终用量与安全形态诊断保留 ≤2 KiB 无秘密摘要（[#1082](docs/MODEL_GATEWAY_TRANSPARENCY.md#anthropic-最终用量与安全形态诊断1082)）。
  - Gateway 503 仅在内核证实未启动时允许降级；Pi 同 Job 失败恢复仅对无内容且具 scoped Kernel `no-start` 证明的失败消费创建期冻结恢复许可，不退额度、不改 `never` replay policy（[Job-scoped 模型恢复](docs/MODEL_GATEWAY_TRANSPARENCY.md#job-scoped-model-recovery-1002-p1-9)）。
- **凭据出口替换（#1032）**：Pi 主执行/OM 与 DSH 在 SDK 出口及 Claude PostToolUse 对已登记受管凭据做精确替换，Gateway 原字节守卫与拒绝审计继续兜底（[普通文本凭据出口](docs/MODEL_GATEWAY_TRANSPARENCY.md#普通文本凭据出口1032)）。详见 [MODEL_GATEWAY_TRANSPARENCY.md](docs/MODEL_GATEWAY_TRANSPARENCY.md) 与 [ADR 0017](docs/architecture/adr/0017-transparent-gateway-settlement.md)。

### 8.3 运行时适配器、沙箱与镜像治理

- **三大 CLI 适配器边界（[`packages/runtime-sandbox`](packages/runtime-sandbox)）**：
  - 平台控制操作采用 HTTP bootstrap 消除与 CLI 原生工具的提示歧义（[#1094](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#平台-operation-的-http-bootstrap1094)）；运行器失败保留结构化终态与进程/传输来源，严禁因已接受完成吞掉真实非零失败（仅 #1045 精确完成拒绝退出码窄例外，见 [runner failure provenance](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#runner-failure-provenance-919)）。
  - **Pi**：目录 ID 路由歧义在 provision 前以 `PI_MODEL_UNAVAILABLE` 失败；单次模型错误先等进程内部重试并按消息回滚失败输出（[#1072](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#pi-单次模型失败与内部重试边界1072)）；请求失败保留脱敏阶段/原因分类（[#1083](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#pi-请求失败诊断与分类1083)）；截断恢复（`length`）走同 Session 有界查询/压缩/短反馈而非通用 nudge（[PI_MODEL_BUDGET_RECOVERY.md](docs/PI_MODEL_BUDGET_RECOVERY.md)）；大输出按预算脱敏落盘并在 manifest 确认后支持按 hash + JSON Pointer 回读（[PI_RPC_PAYLOAD_LIMITS.md](docs/PI_RPC_PAYLOAD_LIMITS.md)）。
  - **DSH**：锁定 `@deepseek-ai/dsh@0.2.1-rc.2` 完整 npm closure，唯一入口 `dsh --profile`（`deepsonar` profile 禁用 spine/UI/遥测/外部发现，Standard 用 native tools，PTC 用 `run_code`）；仅归档 `session.v4.jsonl`（历史 v0–v3 只读兼容）；有活跃子代理时不提前触发完成门；跨进程持久 resume 不支持，返回 `CONTEXT_RESUME_UNSUPPORTED`。
  - **OpenSandbox 与 PTY（#1002 / #1088 / #1092 / #1143）**：SDK 1.2 + `wakeRetryEnabled=false` 保留 Scheduler 恢复权，托管 Docker 资源预检由 init gate 核验（[OPENSANDBOX_1_2_UPGRADE.md](docs/OPENSANDBOX_1_2_UPGRADE.md)）；provision 失败在清理前写有界无秘密 `job.provision_failed` 审计；PTY 仅凭有效退出帧判定退出码（[#1088](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#opensandbox-pty-退出诊断1088)），进度消费协作让出事件循环保障 WebSocket Pong（[#1092](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#进度消费与-websocket-保活1092)），PTY 清理先撤旧凭据再有界销毁重核（[#1143](docs/AGENT_CLI_RUNTIME_ADAPTERS.md#pty-清理事实与精确对账1143)，自动恢复由 [#1181](https://github.com/SummerSec/DeepSonar/issues/1181) 跟踪）。
- **镜像准入、退休、手册与运维（#724 / #726 / #754 / #952 / #964 / #979 / #992）**：
  - 镜像须来自已准入市场、按不可变 digest 执行；第三方经 `apps/image-admission` 扫描批准。基础镜像 CLI/OM npm closure、Debian 快照与原生资产按固定摘要冻结构建（[ADR 0018](docs/architecture/adr/0018-frozen-base-build-inputs.md)）；DSH/Pi OM 启动前核对镜像内治理代码（[#979](docs/RUNTIME_IMAGE_GOVERNANCE_979.md)）。
  - 退休镜像由共享精确 key 策略阻断回流、登记、启用与新执行，历史快照不改写（[#952/#964](docs/DEPRECATIONS.md#软件拒绝边界9642026-11-07-核对)）。
  - 每个官方镜像须携带覆盖全部可见工具的离线手册 `/opt/deepsonar/manuals/index.json`（仅作操作资料，不扩权）；`deepsonar-mobile` 默认 `rust-asc` CLI（[RUNTIME_TEST_TOOLCHAINS.md](docs/RUNTIME_TEST_TOOLCHAINS.md)）。
  - `deploy.sh` / `deploy.ps1` 成功门须核对入口健康 JSON 的 `ok=true` 与 `ready=true`（#726）；镜像拉取与远端节点对账如实记录 `attempts` / `unsupported`（[runbook](docs/runbooks/runtime-image-pull-partial-failure.md)）。

---

## 9. 读图、事件与证据

- **按需与分层读图**：`buildGraphSnapshot` 按 `GraphScope`（`hub`/`agent`/`verify`/`report`）生成有字符预算的 YAML（Job 节点不入 YAML；Verify scope 隐藏 maker title/summary/severity）；Hub 可按需调用有预算、有 scope 的 `graph_query`。
- **语义事件 vs 过程流（#388）**：`events` 是唯一可触发控制副作用的账本；原始过程流写本机 evidence NDJSON/manifest，确认点为 `JobEvidenceWriter.appendNormalized` 落盘完成（排序/去重键 `attempt_id:seq`）；`stream-bus` 仅进程内实时投递。跨副本无共享 `BLOB_DIR` 时明确 `visibility=unavailable` / WS `4415`。
- **广播账本与 Session 查看器**：`canvas_broadcasts` 记录 `planned`/`injected`/`failed`/`unknown`；`injected` 仅证明写入 CLI 输入通道，ACK 必须来自显式受治理 operation。Session 查看器按 CLI 方言解析并保留原始归档下载；Session usage 与 Gateway `job_usage_ledger` 为独立口径，互不冒充。
- **人工消息、可行动请求与断点续做（#1011 / #1012 / #1074 / #1180 / #1182 / #1223）**：
  - 人工消息进 durable inbox ledger，附件写共享资产后按 UUID 注入 `/workspace/.deepsonar/inbox/`；新 `request_human` 强制要求严格 `guidance` 对象（[可行动人工请求](docs/architecture/09-interface-specs.md#可行动人工请求2026-11-09)），Agent 提问前须先在已授权范围内有界核对资源并复用有效答案（[#1182](docs/HUMAN_CONTINUATION.md#提问前核对已授权资源1182)）。
  - `waiting_human` 与累计执行时钟分离等待、封存与执行：超时仅记 `overdue` 并经可信清理关闭旧 Attempt（`#1011` 由对账 loop 重入校验归属后收口）；晚回复先持久化，经原检查点、权限、任务暂停、预算与效果准入后恢复业务文件（清单 v2 仅 `0600`/`0700`）与已 ACK 决定，按能力矩阵使用 structured 或绑定受限原生会话续做（断点凭据来源按受管精确集合脱敏保护，[#1223](docs/HUMAN_CONTINUATION.md#断点凭据候选的来源1223)）。旧暂停队列中的已封存 `waiting_human` 在 schema 79 重建时保全为任务暂停。详见 [HUMAN_CONTINUATION.md](docs/HUMAN_CONTINUATION.md) 与 [人工等待修正链交接](docs/AGENT_REPAIR_LIFECYCLE.md#人工等待修正链交接1012)。

---

## 10. 前端信息架构

- **一级导航**：态势、项目、Agent、Agent 市场、镜像。治理域拆为 `/settings/credentials`（Provider 账号）与 `/agents?tab=roles`（角色职责/指令/工具）。项目工作区不单设镜像页签，由项目设置跳往平台 `/images?project_id=` 统一管理（#1020）；项目 Provider 默认账号显式选择、不重复建账号编辑器（[#914](docs/architecture/09-interface-specs.md#项目默认-provider-账号选择914)）。
- **任务工作台六个固定一级视图**（选中 `tab` / `panel` 写入 URL，后台刷新不得强制切换）：
  1. **总览**：目标、当前阶段、活跃工作、人工介入、质量与下一步动作；
  2. **研究地图**：Finding cluster、canonical anchor、priority 与语义关系；
  3. **事实证据**：Fact、Artifact、验证状态、证据边与来源；
  4. **任务发现**：服务端筛选与游标分页（URL 持久化）、中文技术验证状态、disposition 与追踪入口（[#1199](docs/architecture/09-interface-specs.md#任务发现的状态显示与筛选1199)）；
  5. **任务运行**：Job、Attempt、Session、过程流、广播与用量；
  6. **报告**：Finding Report 与 Task Report 版本、checksum 与正文。项目侧「风险与报告」统一台（`/projects/:id/findings`，`?panel=reports`）复用同一 `ReportDeliverable` 投影（旧 `/projects/:id/reports` 重定向）。
- **Canvas 与列表约束**：Canvas 为只读高级审计视图，前端用 elkjs 布局（超阈值/失败退固定列；服务端 `x/y` 仅 hint，全图服务端布局按 #148 暂缓，见 [12-risks-and-tech-debt.md](docs/architecture/12-risks-and-tech-debt.md#31-全图服务端权威布局148)）。列表用服务端分页与可搜索多选（跨维度 AND、同维度 OR）。

---

## 11. 安全与授权硬门

- **不可信输入假定**：被审计代码、仓库内容、外部事件、物理设备与模型输入均不可信，防 prompt injection、路径越界与凭据外泄。
- **凭据与 Token 分离**：API Token、Job capability token、Model Gateway token、Provider 凭据四类分离；Token 仅存 hash，Job 终态同事务撤销。
- **三层严格校验**：Control API 经 shared Zod schema、宿主 handler、event-ingestion 事务三层校验；未知字段默认拒绝，不 strip 后部分写入；节点 UUID、Finding 绑定、镜像 key、项目 scope、状态与预算均在当前 Job/Canvas 重验。
- **单一受控通道**：不写 Agent 可写控制文件，不从普通 CLI 输出或伪造 MCP tool call 推断语义事件；镜像、sandbox、Gateway、Provider 与事件流均 fail closed；未知外部效果禁止自动重放。
- **沙箱清理与共享资产边界**：自动清理须以本库 Job/Attempt 与 sandbox 绑定证明归属；共享资产 guest 挂载唯一且显式只读（[运行时视图](docs/architecture/06-runtime-view.md#自动清理归属与共享资产只读探针307-评审补齐)）。
- **审计与脱敏**：审计日志 append-only；过程流、Session、产物与错误反馈禁泄长期密钥或完整 Provider 响应。
- **物理设备接入**：走 broker 网络端点（沙箱不直连设备），租约绑定 Attempt 并受 Reaper 回收；rig 端点与入站凭据仅来自平台配置（`DEEPSONAR_DEVICE_BROKER_URL` / `DEEPSONAR_DEVICE_RIGS`），`devices.rig_id` 仅存归属标识。任务工作台与快捷创建均复用设备需求冻结与按角色重授权（[#1211](docs/DEVICE_ACCESS.md#1-现状代码事实)）。详见 [DEVICE_ACCESS.md](docs/DEVICE_ACCESS.md)。

---

## 12. 当前状态与开放演进

| 方向 | 当前状态（as-built） | 开放演进 / 待补边界 |
| --- | --- | --- |
| 架构治理（#741） | 编号规格、十二视图、追溯矩阵、[ADR 索引](docs/architecture/adr/README.md)与文档同步 Skill 已接入 CI 门禁 | 语义一致性与可变数字仍须人工逐条复核 |
| Artifact-first（#444） | Phase 1 落地：Artifact 为内部写入真相，Finding 为投影 | 扩展 Claim/Evidence/Evaluation/Projection，清理双源 |
| RepairFeedback（#446/#776） | Control 严格拒绝、完成回执/revision、独立 repair-token 额度与 Web 只读四类投影已落地 | 通用 Completion Gate、完整 Proposal/Receipt/Settlement |
| Capability Pack（#447/#603/#611） | Manifest、Job 级发现、Skill 源候选审批、LSP/CLI 模块与快照冻结已落地 | live catalog 漂移门禁、task/session Pack 生命周期、评估晋升与推荐 |
| Pi 会话观测记忆（#815） | 受审 wrapper、独立 workload 凭据、Gateway 归因/额度与脱敏预览已合入主线 | 真实模型质量与成本收益 `unknown` |
| Plan v2（#443/#775） | 用户 objective CAS、lifetime 预算、多轮推进、留存输出核验与 Reaper 非成功出口已落地 | 模型规划收益 `unknown`；完成仍独立受操作员判据门控 |
| 项目知识（#752/#1197/ADR 0024） | 不可变版本、6×2 独立试验、条件建议、自动积累门控与会话收尾沉淀已落地 | 真实模型闭环与知识复用收益未实测（`unknown`） |
| Finding Research（#448/#770/#819） | 语义聚类、来源身份、项目筛选、可重建特征、词法候选与操作员身份/关系账本已落地 | 独立人工标注/留出质量门、Host 外部证据证书、CAS 晋升与公开强关系暂缓（`published=false`） |
| Quality / Replay（#445/#580） | 只读指标与 Hub replay 基线已落地；人工标签为质量真值 | Experience、成本感知计划与冻结基线对比 |
| 任务与报告工作台（#449/#561） | 六视图工作台、「风险与报告」统一台、恢复面板与重试前检已落地 | 研究地图增强、统一详情抽屉、服务端 overview 聚合 |
| 平台升级与运维（#740/#1124） | 全局暂停、不可变 digest 契约、维护模式候选库重建、历史库回收与受管 SSH 已落地 | P3 Web 发起升级未实现；正式发布签名以对应 Release 证据为准 |
| 真实设备接入（#494/#505/#1211） | device broker 租约、多 rig 准入、任务创建冻结与补证继承已落地 | 真机 rig 验收、Phase 2 hdc/串口/电源、跨 rig 调度 |
| CI 治理与成本（#836/#972/#992） | Draft/Ready 分层、五片 gate、Reverse 子套件分流、构建输入冻结与只读成本观测已落地 | PR→main 同 tree 结论复用未实现，详见 [CI 验收记录](docs/CI_COST_ACCEPTANCE_992.md) |

> 未来实现须先更新本表与专题文档，明确区分 as-built、进行中与提案；不得凭旧 Issue、历史 `*_PLAN.md` 或角色名称推断现状。

---

## 13. 实现硬约束

1. **先读本文、[架构归属表](docs/architecture/README.md)与相关专题，再读代码**；文档漂移回写文档，实现违约登记缺陷。功能与边界变更必须执行 [文档同步 Skill](.agents/skills/architecture-doc-sync/SKILL.md)。
2. **骨架进定列、内容进 JSONB**：状态机、幂等键、外键与权限骨架用定列，开放内容用 JSONB。改表只能修改 [`database/schema.sql`](database/schema.sql)、bump `SCHEMA_VERSION`、执行重建并验证，禁止增量 ALTER 链。
3. **共享 Zod 契约单源**：前后端与事件 payload 共用 `packages/shared-types`；新增 operation 必须配齐合法/非法夹具、宿主重验、事务回滚与冒烟测试。
4. **新增 CLI 五件套同步**：runtime adapter、Session archive adapter、Web Session viewer、测试与原始归档下载缺一不可。
5. **能力优先做 Capability Pack**：不新增固定角色分支，不建第二执行通道，必须复用既有 Job/Attempt/effect、Control API、沙箱与审计。
6. **统一失败反馈与不可重放底线**：可修正失败返回 `RepairFeedback`，`accepted` 具 durable receipt 语义，未知外部效果严禁自动猜测重放。
7. **模型零直权**：模型不可提交坐标、镜像 digest、凭据、终态或未授权项目引用；所有外部与模型输入按不可信处理。
8. **行为测试覆盖边界**：禁止以 `typecheck` 替代行为验证；按影响面补齐 `ci:unit:*`、`ci:integration:*`、`ci:smoke:*`、`ci:images` 与前端契约测试。
9. **发版前文档保鲜硬门**：改 `CHANGELOG.md` / 打 `v*` tag / 建 Release 前，必须通过 [`AGENTS.md`](AGENTS.md#发布前的文档保鲜发版硬门) 的全套文档保鲜清单（含可变数字核对基线）；未通过不得发版。展开见 [工程规范](docs/architecture/11-engineering-specs.md) 与 [发布流程](docs/RELEASE_RUNTIME_IMAGES.md)。

---

## 14. 仓库地图与事实入口

| 路径 | 职责 |
| --- | --- |
| `apps/scheduler` | Fastify API、Dispatcher、Hub、Job 生命周期、Verify、Research、Report、Model Gateway |
| `apps/web` | React 管理控制台、任务工作台、Canvas、Finding、Job 与 Session viewer |
| `apps/image-admission` | 第三方 OCI 镜像扫描与准入 |
| `packages/shared-types` | 共享 Zod 契约、Capability Pack、Plan v2、RepairFeedback、Runtime Profile |
| `packages/runtime-sandbox` | Noop/OpenSandbox 执行器、CLI adapter、Session 归档 |
| `database/schema.sql` | 唯一数据库 schema 基线（当前集成编号以 [`schema-version.ts`](apps/scheduler/src/schema-version.ts) 为准，不代表发布版本） |
| `deploy` / `agent-harness` | 生产部署、维护升级、镜像打包、冒烟与运行时契约验证 |

**延伸阅读**：

- [`docs/architecture/README.md`](docs/architecture/README.md)：系统规格、信任边界、十二架构视图、追溯矩阵与 ADR 索引（旧 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 仅留历史对照）；
- [`docs/README.md`](docs/README.md)：全部专题文档与 as-built 状态索引；
- [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期可信内核协议、Crash Matrix 与演进路线；
- [`apps/scheduler/src/openapi.ts`](apps/scheduler/src/openapi.ts)（运行时 `/api/openapi.json`）：当前 HTTP API 契约；
- [`AGENTS.md`](AGENTS.md)：编码 Agent 协作、CI 与验证纪律。
