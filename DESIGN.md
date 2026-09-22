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


### 4.0 Skill / 模块源控制面（#603 首片）

**平台是控制面**：项目通过 `project_skill_sources` 启用 Skill 源白名单（对标 `project_runtime_images` / CLI·Provider 白名单）。未启用的源不可进入本项目 Job 快照。CLI × Provider × 镜像 × Skill 从已启用集合自由组合；角色不是主绑定面。

**Hub / Job 运行时选型**：业务 Skill 不因 RoleConfig 为空而默认注入。Agent/Worker 在 Job 内通过 `list_available_skills` / `search_skills` 自主选择，再调用 `pull_skill` 拉取并读取 `SKILL.md`；Hub 不需要预先把 Skill 写入 Intent。平台只允许 trusted+enabled 源，拉取操作仍受当前 Job 的 token、预算、网络和审计边界约束。

**Job 快照冻结**：创建时冻结 `module_selectors`、digest、模块内容 hash 与 missing；物化只认快照。Job 创建后的 skill_source sync **不影响**进行中 Job，只影响下一 Job。

**平台控制 Skill**：`deepsonar-control` 仍对真实 Job **强制注入**，不可被业务 RoleConfig 同名覆盖，也不计入项目 Skill 源白名单。

**RoleConfig `modules_json` 为过渡态 / 缺省建议**：仍可勾选，但候选必须 ⊆ 项目白名单；`expandModules` / role-runtime-snapshot 路径在项目范围 fail-closed。迁移：首次读取项目 Skill 设置时，把历史 RoleConfig selector 引用的源种子为启用，禁止静默丢配置。

**非目标（本片）**：移除 RoleConfig 模块 UI、完整 Hub Intent Skill 选择器、重写 Capability Pack（#447/#604）。

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
Agent 运行中拉取业务 Skill 使用 `list_available_skills`、`search_skills`、`pull_skill`；这些操作返回并校验具体模块文件，但不改变 Job 的平台权限边界。

发现不是授权。Scheduler 仍按项目范围、Job 快照、平台工具 allowlist、镜像兼容性和网络策略决定可执行集合。模型不能用 Manifest 扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。

Job 创建时冻结运行配置和平台控制边界；业务 Skill 不再依赖 RoleConfig selector 预先物化。Agent 可在运行中从 trusted+enabled 目录搜索并通过 `pull_skill` 拉取具体 Skill，拉取时重新校验 selector、内容 hash、Job token、预算和网络策略。Skill 只能影响当前任务的方法，不得扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。当前尚未实现 task/session Pack 的持久化生命周期、Pack 评估晋升和跨任务经验推荐；不要在代码或文档中把这些未来能力写成已存在。

### 4.1.1 Language Server Capability Modules

语言服务器是受治理的 **Capability Module**（契约 `deepsonar.language-server-capability/v1`），不是 Agent 可随意拉取的二进制。Hub 只能从能力目录提出已登记模块（首期 `language-server.clangd`）；Scheduler 校验镜像兼容性与前置条件（如 `compile_commands.json`）后，把 id / version / image_key / config_fingerprint 冻结进 Job 快照。Agent **不得**在任务内 `apt`/`npm` 安装 LSP，也不得把未准入的 raw `clangd` 命令当作静默降级路径；不可用时返回结构化 `capability_unavailable`。受控 LSP Adapter（有界操作，禁止自由 JSON-RPC）已落地于 `agent-harness/language-server-adapter.mjs`；其它语言服务器与镜像内安装仍为后续切片。Hub 可通过 Intent 的 `language_server_capability_id` 提案并冻结进 Job 快照。

### 4.1.2 General CLI Capability Pack

通用 CLI 工具同样是受治理的 **Capability Module**（契约 `deepsonar.cli-capability/v1`，#611）。Phase 1 登记 `text.search.rg`、`json.query.jq`、`source.control.git`、`file.inspect.file`、`evidence.hash.sha256sum`、`execution.timeout`、`archive.extract` 等；`file.discovery.fd` / `yaml.query.yq` / `patch.diff` 已进目录但默认不可用（镜像钉死 follow-up）。Hub 通过 Intent `cli_capability_ids` 提案；Scheduler `admitCliCapabilities` 校验后冻结 `cli_capabilities` 与 pack fingerprint。CLI 输出固定 `is_finding: false`，只作 Evidence/Fact 输入。`curl` 与 binutils 专项工具不纳入本基础包。

### 4.1.3 Agent Runtime Profile（#613 phase 1）

Agent Runtime Profile 的机器契约是 `deepsonar.agent-runtime-profile/v1`，定义于 `packages/shared-types/src/agent-runtime-profile.ts`。它把现有 Provider Credential、RoleConfig 和三种已准入 CLI adapter 的最终运行投影统一为一个只读、无密钥的 Job snapshot 部分：`provider_ref`、`model_ref`、`reasoning_effort`、`context_window_tokens`、`extensions`、`system_prompt_ref`、`env_refs`、严格命名空间的 `native_options` 和 `profile_fingerprint`。

Profile 复用现有配置解析和物化路径，不建立第二个 Provider Gateway 或执行通道。Scheduler 在 Job 创建时生成它；`system_prompt_ref` 只保存角色配置标识、版本和摘要 hash，`env_refs` 只保存环境变量名称及来源，Credential secret、Provider 原文和环境变量值不进入 Profile。`native_options` 只允许 `claude_code`、`pi`、`dsh` 三个已登记命名空间，并按当前 adapter 的最小受支持字段投影。

配置解析继续遵守 **全局默认 → 项目 → 角色 → 任务 → Job** 的固定优先级；运行中的 Job 只消费 `agent_snapshot_json.runtime_profile` 和现有冻结配置。Provider、模型目录、Credential 健康状态、Agent CLI 与镜像兼容性仍由现有 Scheduler 校验负责；不支持的 CLI 或配置必须在现有 snapshot resolution 错误边界 fail-closed，不能 silent no-op。三种 adapter 的实际启动和配置文件物化仍由 `packages/runtime-sandbox` 的既有 adapter registry 执行。

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

Hub 只能提出工作角色 Intent；`verify_finding` 与 `report` 是 Scheduler 派生的系统 Job。一个 Canvas 同时最多一个活跃 Hub。Hub 启动时只获得有界画布骨架（小图可获得完整小投影），需要细节时自主调用当前 Job 的只读 `graph_query`；平台只校验 Job scope、查询预算、脱敏和已见引用。Hub 只能引用当前画布中已经投影的 canonical UUID，Finding 绑定必须使用数据库 Finding UUID；字段名、别名、跨画布 ID 和占位符都会被拒绝。

真实 Job 注入固定的 `deepsonar-control` Skill。Skill 只说明能力发现、OpenAPI、Bearer 和 Idempotency-Key；不动态授予权限。三类当前新执行 CLI 为 Claude Code、Pi、DSH；历史 Codex/OpenCode 归档仍可只读查看，不作为新执行的默认 adapter。

## 6. Finding、Verify、Research 和报告

### 6.1 Verify

review/test/worker 的复核结果必须作为结构化 Fact 提交，至少引用 `finding_id`、`subject_revision`、`ownership`、`expected`、`actual` 和 `outcome`。Scheduler 校验项目/画布归属、版本和 Fact 间冲突；普通文本 verdict 不计入门禁。

确认策略冻结为可版本化的 **Fact-first**（`strategy_id=fact_first`，当前 `strategy_version=1`）：门禁、必需缺项、advisory 缺项与确认理由由同一路径计算；直接确认与 `verify_finding` 收口共用该结果。v1 以结构化 supporting Fact 为确认硬门——不强制所有领域提供独立 review + runtime_test 配对或动态 PoC（CTF 等场景可直通）。`buildEvidenceSnapshot` 的 review/test 配对缺口在 CTF/general 下记为 **advisory**，不得在 `confirmed` 时仍写入 `missing_evidence` 必需项。冲突、来源 Job 失败、错误 `finding_id` / `subject_revision` 仍为必需阻断。历史确认记录若无策略版本字段，标记为 legacy/unversioned，不静默改写为已通过新策略。

**#590 叠层（与 #576 对齐）**：每个 `used_fact_ids` 必须在确认前 EXISTS 解析到真实 Fact（finding 归属、ownership、来源 Job ≠ Finding 原始 Job）；悬空引用一律阻断并 rework——缺 Artifact 四表行仍不单独构成悬空（#577）。对 `security.vulnerability` / `security.misconfig` / `security.secret`，独立 review≥1、合格 test≥1、`missing_evidence == []` 为 confirmed 必要断言，配对缺口升为 **required_missing**，不得抹空 missing 放行。`emit_finding` 可选 `impact`（`attacker_entry` / `victim_resource` / `impact_flow` / `preconditions` / `known_issue_refs` / `impact_waiver`）；上述安全 profile 的 confirmed 要求非空 `impact_flow` 或显式 `impact_waiver`，并需 `attempted_refutation` 与合格 test 的 `artifact_refs`。建议项目协议将 `security.vulnerability` 列入 `require_scoring_for_profiles`（默认保持空列表以兼容现有 Agent）；location/summary 中的 TODO/crbug/CVE 自动打 `known_issue` 标签。

确认记录可经只读 `fact_evidence_trace`（#577）按 `used_fact_ids`→`canvas_nodes` Fact 解析来源 Job/Attempt、目标 revision、可选 Artifact/Evidence 与内容完整性摘要；缺 Artifact 四表行不表示悬空。`runtime_digest`/`exit_code`/产物 sha256 与 Hub 唤醒用 `evidence_signature`/`gate_fingerprint` 分离；文本 expected/actual 本身不是运行证明。摘要不符在观测可得时阻断确认；`fact_first` v1 默认不强制 runtime_proof。

安全漏洞研究（profile `security.vulnerability`）可另启用可冻结证明契约 `security.vulnerability.proof` v1（#578）：要求固定 revision、受影响组件、攻击者控制点、前置条件、入口→危险操作可达路径，以及静态（文件位置+片段摘要+路径依据）或动态（运行证明）证据；TODO/注释/危险函数存在/单纯行号命中不能单独满足；缺工具/目标/设备降为 inconclusive；Verify 只消费 Fact，不重审源码。该契约默认不启用，以免把通用 fact_first 改成强制动态 PoC。

Verify 只消费允许的 Fact、Artifact、Evidence 和独立 Evaluation，不重读 maker 结论作为证据（#399）。证据不足、冲突、版本不匹配或主体变更时，Finding 保持未确认，Hub 可按 advisory/必需缺项派发补证。`minVerifySeverity` 只决定自动验证和收敛范围，不会删除低于阈值的 Finding。

Hub 证据等待唤醒以证据签名 / 门禁指纹边沿触发；**从未有过 review/test 证据的 pending Finding** 即使签名未变也计入唤醒（签名门只防「已有证据但无进展」的重复轮）。关注级别内 `inconclusive` 若在 Hub 自驱停滞时仍未收口（默认连续 ≥`INCONCLUSIVE_ESCALATE_AFTER_HUB_ROUNDS`=2 轮，或与 stalled pending 一并停机），升级为 `needs_human` 并创建 human Action，同时在画布 convergence / root `body_json` 写入 `paused_reason=verify_unclosed:…`，禁止静默停机。

Fact `verification_status`（证据可信度）、Finding `verify_status`（技术验证）和 Finding `disposition`（人工处置）是三个独立状态机。人工不能直接把 Finding 写成 `confirmed`，也不能把 rejected Fact 直接升为 verified。

### 6.2 Research

上游 review/test 可输出正向论据、替代解释、保护条件、反例与未决假设（#579，`research.hypothesis_loop` v1）。「未找到反证」不能自动变成 confirmed；相同输入指纹不得无限再派；反驳后的新假设必须带父命题派生关系。Verify 仍只消费允许的 Fact，不在研究策略中写 verify_status。
已知性与覆盖（#581）：known issue 在 pinned revision 仍受影响时不得自动降级；HEAD 复查不抹掉旧适用性；覆盖率须有可解释分母，Finding 数不能冒充全量覆盖。


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

每个 Job 领取建立 Scheduler-owned Attempt。外部动作先写 `job_attempt_effects` 的 intent/`effect_pending`，观察到结果后再写 settlement。启动对账按 Attempt phase 和 effect 分类：只有尚未开始且无效果的准备阶段可以回到 `pending`；未知效果统一进入 `orphan`，清理 Token、沙箱、画布同步和租约，禁止自动重放。Attempt 终态收口时，从未绑定 `sandbox_id` 且未观察到迟到沙箱的失败 provision 记为 `settled`（outcome `never_started`，证明无外部后果），不得留 `unknown`；超时路径若已观察到迟到 sandbox handle（或 late destroy 失败），以及沙箱已启动后的中断、timeout/cancel/orphan，与 `agent_run` 未证实窗口，仍是 `unknown`。`replay_policy` 不因这次结算改变。

取消、超时、迟到回调、容器创建和销毁都走幂等路径。`timeout/orphan` 只有在没有待结算效果且策略允许时才可安全重试；否则必须让操作员确认。Job resume 使用创建期冻结快照，`rerun-current` 才重新解析当前配置并完整重冻，身份漂移返回 `SNAPSHOT_STALE`。

## 8. 配置、快照和运行时

**提示词组合（#594 首片）：** 业务提示词按 `prompt.composition` v1 解析与预览：平台必需协议始终纳入且不可被业务层覆盖；业务覆盖顺序为 **任务派发 → 项目 RoleConfig → 全局角色/能力默认**。Hub Intent 可通过可选 `role_prompt` 提供任务级角色业务提示词覆盖；Scheduler 只将其冻结到新建 Worker Job，不写回持久化 RoleConfig。组装结果记录各层版本、内容摘要与注入通道（`system_prompt` / `instruction_files` / `user_message`）；CLI 不支持的通道必须拒绝，不得把普通消息追加展示为已替换 system prompt。自然语言不能扩大工具、网络或凭据权限。Attempt 应冻结组装摘要；「修订重派 / 原输入重跑 / 当前配置重跑 / Hub 重新规划」语义区分，后续切片落 API。

配置优先级为 **Job > 角色/项目 > 平台 > env 引导**。项目只能收紧全局并发上限，不能放宽安全硬门。Job 执行只认创建时的 `agent_snapshot_json`，不在 Dispatcher 运行时回退到最新 RoleConfig。

**凭据资产、角色引用与快照生效是三条边界（#626）：** Provider Credential 是秘密资产（创建 / 轮换 / 测试 / 健康）；`role_credentials` 是 RoleConfig 对 Credential 的引用（绑定 / 换绑 / 迁移）；`effect=new_jobs_only | refresh_pending` 是 Job 快照治理，只属于绑定域提交。账号 CRUD 不能要求走完角色勾选和生效步骤。`POST /credentials/batch-bind` 是绑定域 API，不是账号管理向导。运行中与终态快照永远冻结；`refresh_pending` 仅刷新 pending，且必须显式选择。发现 API / 模型目录结果不是授权。Readiness 把账号健康/连通测试修到 `/settings/credentials`，把未绑定、绑定歧义和 CLI 不兼容修到 `/agents?tab=bindings`；`normalizeFix` 不能因为 action 仍是 `role_config` 就把绑定域 href 改写成角色注册表。

运行时由 `packages/runtime-sandbox` 的 `SandboxRunner` / `RuntimeHost` 抽象，当前有 Noop 和 OpenSandbox 实现。每个 Job 使用新的 `/workspace`、独立可写 HOME、冻结的 CLI/provider/model、治理后的 Gateway、镜像 key + digest、工具清单和网络策略。Pi 快照的 `model` 是 CLI `--model` 接受的目录 id，`pi_provider` 是已认证 `models.json` 路由；`deepsonar/<id>` 只表示 Provider 路由，adapter 必须映射为 `--provider <route> --model <id>` 后再启动。目录 id 在多个已认证路由间有歧义且无法唯一确定时，快照解析 / claim 启动在 provision 前以 `PI_MODEL_UNAVAILABLE` 失败。real Job 的模型请求经 Scheduler-owned Model Gateway（实现注释中的历史 §6.3）；长期 Provider 密钥不进入 Job 快照、Session 或工作区。

**Model Gateway 目录校验与 alias 语义（#570）：** 解析顺序为 RoleConfig.model → Credential `settings_config` → Agent CLI 内置默认（如 Claude Code → `claude-opus-5`）。若凭据 `model_catalog_json` 非空，冻结快照前把解析结果与目录比对：不在目录则 fail-closed，中文错误列出可选项。空目录视为探测软降级，不拦 Job。显式 alias 直通可关闭校验：RoleConfig `allow_model_catalog_passthrough=true`，或平台 env `DEEPSONAR_ALLOW_MODEL_CATALOG_PASSTHROUGH=true`。角色/settings 未指定 model 时，快照冻结 `upstream_model = "cli-default:<name>"`（详情页展示「未指定 → CLI 默认 …（经凭据 alias 转发，实际模型不可观测）」）；运行时 concurrency / Gateway 出站会剥掉 `cli-default:` 前缀。`job_usage_ledger.model` 仍记请求协议值；`model_catalog_match` 标注是否命中目录；可选 `upstream_reporting_model` 尽力从上游响应读取，无字段不强行伪造。

运行镜像必须来自已准入市场。第三方镜像先经 `apps/image-admission` 扫描、批准和项目启用；Agent 不能提交任意 OCI 地址。镜像和平台版本分开管理，执行永远使用不可变 digest，不使用可变 `latest`。出网权限在 Canvas/Job 快照中冻结，禁止出网的沙箱只能通过固定 Gateway 访问模型。

每个官方运行镜像还必须携带与最终工具清单绑定的离线工具手册，固定入口为 `/opt/deepsonar/manuals/index.json`。手册逐项覆盖 Agent 可见工具、包装脚本和能力入口，说明选型、前置条件、调用、输出边界、失败分类、组合流程、证据与版本限制；从基础镜像继承的工具也必须在最终镜像中展开。构建与镜像门禁校验手册摘要和工具覆盖，Worker 启动上下文只注入索引位置并按需读取章节。手册是操作资料，不授予额外工具、网络、凭据或副作用权限。

## 9. 读图、事件与证据

`buildGraphSnapshot` 按 `GraphScope` 生成有字符预算的 YAML：`hub`、`agent`、`verify`、`report` 看到的内容不同；Job 节点不进入 YAML。Verify scope 隐藏 maker 的 title/summary/severity，只给主体、location 和证据引用。长期方向是让模型用 Job-scoped 查询按需获取节点、邻域、证据和冲突，逐步减少全图投影，但不能改变 Canvas、events 和 Evidence 的权威性。

语义 `events` 是唯一可触发控制副作用的账本；原始过程流写入本机 evidence/冷存储；WS `stream-bus` 只作实时投递。广播账本 `canvas_broadcasts` 记录 `planned`、`injected`、`failed`、`unknown`；`injected` 只证明写入 CLI 输入通道，不证明 Agent 已读。

人工消息进入 durable inbox ledger，附件先写共享资产再按 message UUID 注入 `/workspace/.deepsonar/inbox/`。`injected` 与显式 ACK 分离；waiting-human 回复会关闭旧 Attempt、恢复 Job 为 pending 并重新唤醒 Dispatcher。普通文本、Session 标题和节点名称都不能伪造 ACK。

Session 查看器按 CLI 方言解析 reasoning、message、tool call/result、usage 和广播注入，保留原始归档下载。Session usage 与 Gateway `job_usage_ledger` 是两套口径，不互相冒充定价或对账结果。实时流丢失时只能补读已落盘 evidence；另一 Scheduler 副本没有共享文件系统时必须报告不可见。

## 10. 前端信息架构

一级导航是态势、项目、Agent、Agent 市场和镜像。平台设置把治理域拆开：`/settings/credentials` 只管理 Provider 账号资产；`/agents?tab=bindings` 是角色凭据绑定与生效策略；`/agents?tab=roles` 是角色注册与指令/工具配置。三个入口可互相链接，不共享账号向导 step machine，也不能用一次「应用」同时完成账号保存、角色勾选和快照刷新。

项目内日常路径为任务工作台：

1. **总览**：目标、当前阶段、活跃工作、人工介入、质量和下一步动作；
2. **研究地图**：Finding cluster、canonical anchor、priority 与语义关系；
3. **事实证据**：Fact、Artifact、验证状态、证据边和来源；
4. **任务发现**：本任务 Finding、Verify 状态、disposition 和追踪入口；
5. **任务运行**：Job、Attempt、Session、流、广播和用量；
6. **报告**：任务工作台报告 tab 仍展示 Finding Report、Task Report、版本、输入 checksum 和正文。项目侧「风险与报告」统一台（`/projects/:id/findings`，`?panel=reports` 切报告区）复用同一 `ReportDeliverable` 投影（可阅读 / 生成中 / 失败 / 尚未生成 / 已过时），任务只作上下文，不默认展开；旧 `/projects/:id/reports` redirect 到合并页。

选中的 `tab` / `panel` 写入 URL，后台刷新不能强制切换视图。Canvas 是高级审计视图，默认只读；节点布局由服务端 elkjs 计算。列表筛选使用服务端分页和可搜索多选；不同维度按 AND，同一维度按 OR。项目账本与「风险与报告」是独立项目视图，不塞进任务工作台的运行列表。

## 11. 安全与授权硬门

- 被审计代码、仓库内容、外部事件和模型输入均视为不可信，必须防 prompt injection、路径越界和凭据外泄。
- API Token、Job capability token、Model Gateway token 和 Provider 凭据分离；Token 只存 hash，Job 终态撤销。
- Job 控制 operation 由 shared Zod schema、宿主 handler、event-ingestion 事务三层校验；未知字段默认拒绝，不 strip 后部分写入。
- capability/role、节点 UUID、Finding 绑定、镜像 key、项目 scope、状态和预算都必须在当前 Job/Canvas 上重新验证。
- Control API 不写 Agent 可写控制文件，不从普通 CLI 输出或伪造 MCP tool call 推断事件。
- 镜像、sandbox、Gateway、Provider 和事件流都采用 fail-closed；不知道外部效果时不重放。
- 审计日志 append-only；过程流、Session、运行产物和错误反馈不得泄露长期密钥或完整 Provider 响应。
- 物理设备接入走 broker（沙箱不直连设备），设备按不可信输入对待，设备租约与授权细节见 [DEVICE_ACCESS.md](docs/DEVICE_ACCESS.md)。rig 端点与入站凭据只来自平台配置（`DEEPSONAR_DEVICE_BROKER_URL` / `DEEPSONAR_DEVICE_RIGS`），`devices.rig_id` 只存归属标识（schema v50），不存地址与密钥。

## 12. 当前状态与开放演进

| 方向 | 当前状态 | 下一步 |
| --- | --- | --- |
| Artifact-first（#444） | Phase 1 已落地，Artifact 为内部写入真相，Finding 为投影 | 扩展 Claim/Evidence/Evaluation/Projection，清理双重事实源 |
| RepairFeedback（#446/#453/#449） | Phase 1 已落地，Control API 严格拒绝路径已接线；Web 对现有 Job error / effect ledger 另做只读四类投影 | Proposal/Receipt/Settlement、统一 Completion Gate |
| Capability Pack（#447/#459） | Manifest、Job 级发现和快照 selector/digest 已落地；目录发现仍需严格受冻结 selector/digest 上限约束 | live catalog 漂移门禁、task/session 生命周期、准入评估、临时组合、经验推荐 |
| Plan / 模型主导收敛（#443） | 当前仍由 Hub Intent + 硬护栏运行 | PlanTask、模型完成声明、预算化验证和回放 |
| Finding Research（#448） | 语义去重、canonical anchor、相对 priority 已落地 | 更强评估集、跨任务聚类和人工反馈闭环 |
| Quality / Replay

人工标注审计回归集（#580）：变更模型/prompt/策略前相对冻结基线对比；人工标签为真值，平台 confirmed 不是独立真值；缺少 PoC ≠ 误报；门禁区分质量退化与环境失败，不发明准确率承诺。
（#445/#456） | 只读指标与 Hub replay 基线已落地，经验召回为空 | Experience、成本感知计划和策略评估 |
| 任务工作台（#449/#451/#454） | 总览、研究地图、事实、发现、运行、报告视图已落地；Job/Finding 错误的只读 `RepairFeedback` 投影；timeout/orphan 无效果账本时不得标可安全重放，也不得推荐 `retry_same_session`，未知外部效果停在 `needs_confirmation` | 研究地图投影、统一详情抽屉、视觉重设计、服务端 overview/actions 聚合 |
| 项目报告工作台（#484 / #561） | Phase 1 已落地：统一 `ReportDeliverable` 投影；#561 并入项目「风险与报告」台（`/findings` + `?panel=reports`，旧 `/reports` redirect）；任务工作台报告 tab 与下载 API 不变 | URL 筛选排序、详情抽屉、视觉层级、摘要按需加载（PR 2–PR 5） |
| 真实设备接入（#494/#495，多 rig #505 后续） | Phase 1 已落地：device broker 把物理设备暴露为可租借网络端点（沙箱不直连设备），租约绑 Attempt、项目 opt-in + 任务级授权、`device_events` 审计、Reaper 回收过期租约；多 rig 准入（平台按 `devices.rig_id` 分组整集推送、按需 rig 选 broker 端点，schema v50）与平台设备视图也已落地；细节见 [DEVICE_ACCESS.md](docs/DEVICE_ACCESS.md) | 真机 rig 验收、Phase 2 hdc/串口/电源控制、跨 rig 调度（一个 Job 只用一个 rig 的设备）、同 rig 多设备池的策略 |

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
| `database/schema.sql` | 唯一 schema 基线；当前主线 v53 |
| `deploy` / `agent-harness` | 部署、镜像、冒烟与运行时验证 |

实现入口：

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：完整架构、威胁模型、存储和状态机细节；
- [`docs/README.md`](docs/README.md)：专题文档和 as-built 状态索引；
- [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期内核/插件协议、Crash Matrix 和实施路线；
- [`database/schema.sql`](database/schema.sql)：唯一数据库基线；
- `/api/openapi.json`：当前 HTTP API；
- [`AGENTS.md`](AGENTS.md)：编码 Agent 的操作纪律。
