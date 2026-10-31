# 任务下发验收矩阵（#767）

> 状态：当前集成实现与分范围证据盘点；可信授权及 Plan v2 已接线，最终组合验收和独立质量缺口仍显式保留。
> 同步日期：2026-10-31

原 issue 要求按场景明确目标、范围、授权、材料与完成条件，并在创建/派发前发现不满足的前置条件。后续 #794、#796、#797、#798 分别补充目标相关研究候选、报告防误报、来源隔离判据评审及非 Finding 交付。下表不把源码或测试入口存在等同于本次已运行通过。

## 原始下发要求

| 验收面 | 已有实现/证据入口 | 能力或验收缺口 | 产品决策 |
| --- | --- | --- | --- |
| 管理入口可发现指南、共用规则与场景模板 | deepsonar-management SKILL 与 task-dispatch/whitebox/blackbox references；共享 task-contract 模板 | 交付前核对指南链接、非审计工程样本及重新下发错误分类 | 无需扩大功能范围 |
| 版本、快照、原始需求与字段级反馈 | task-contract.ts、任务创建 API/Web/CLI；task-contract 与 task-intent 测试 | 汇总同意图不同入口、字段顺序及表达的既有验收证据；结构检查不证明自然语言理解 | 无 |
| 可选契约与无契约入口 | 无契约明确 unassessed；显式契约统一基本完整性，outcome 不绕过 | 不能声称所有入口都已强制标准化 | 可选是原设计；强制迁移需另行决策，**不是本 issue 必须消除的关闭阻碍** |
| 凭据、网络与创建后变化 | task-contract-preflight.ts 重读当前可信信息；相关单测/集成 | 验收凭据撤销、项目边界、当前出网与 rerun，不把创建时通过沿用到派发 | 无 |
| 身份、租户、资源、目标写权限 | `deepsonar.target-authorization/v1` 只读 authority、`reference-http/v1` 精确 save→publish→trigger/前提/版本核验；immutable grant 与中央继承、provision/rerun 重核 | 真实 SQL/HTTP 链含 test-only Worker；不代表生产目标动作已执行，不认证任意目标或通用探测 | 仅信任宿主配置 authority；缺失/变化 grant 以不可重试 `target_authorization_grant_invalid` 拒绝 |
| 白盒与只读场景 | 模板区分静态/动态，workspace_write 与目标 write 分离 | 核对已知漏洞与安全样本的契约/完成标准；环境不可用须保留限制，不要求必然 Finding | 无需通用主动探测引擎 |
| 秘密与权限上限 | 凭据使用引用；未知字段拒绝；契约只收窄权限 | 自由文本无通用秘密检测或语义授权认证，不能把结构拒绝说成能识别所有秘密 | 不新增未经要求的秘密扫描产品 |
| 失败后重新下发 | 管理指南区分错误、阶段和副作用；当前权限重验 | 验收不得因错误码机械整 Job 重跑；未知外部效果不重放 | 不实现通用自动恢复引擎 |

## 后续目标导向要求

| 验收面 | 已交付能力 | 剩余能力/验收 | 产品决策 |
| --- | --- | --- | --- |
| 研究候选与目标关联 | #794 全契约 SHA、逐判据 Fact、范围/排除与附加赏金规则；仅 admitted_for_research | 汇总引用失效、跨范围、未知与排除回归；不把候选计达标 | 无 |
| 报告防误报 | #796 确定性投影、冻结版本、来源重核与 SARIF 边界 | 跨切片端到端验收与架构同步 | 无 |
| 判据证据评审 | #797 普通 Job 来源隔离、当前 Attempt/字节、冲突/失效、预算保护 | 不认证不同人/模型；不等于提交资格 | 不默认要求外部人/模型认证 |
| 工程交付与合法负结果 | #798 task.result Fact Artifact；delivery/negative_result 可评，blocked/not_executed 保留缺口 | 汇总零 Finding、失败来源、未执行、部分覆盖与预算回归；负结果不是整体完成 | 无 |
| 高标准安全提交候选 | 已有规则材料身份与声明筛选、技术 Verify、通用判据评审；#822 增加操作员准入与独立资格投影 | 适用攻击链、knownness 对目标版本的适用性仍需对应依据；资格投影不认证外部官方规则，也不可由 severity/相似词推导 | 资格绑定具体程序/版本与当前证据；不自动提交漏洞 |
| #775 执行与完成门 | 当前 Plan v2 用户 objective CAS、lifetime 预算、多轮依赖执行、实际留存/输出关联与原操作员完成门；持久回执 | v2 回放已有本地 SQL/HTTP fixture 核验，最终组合 CI 待验；新评审/输出关联不自动变成 Plan authority | 复用已有 Hub Intent admission；不新增执行通道、不替代原绑定 |

## Plan 关联边界与实际验收

操作员显式选择目标评审与 Plan 判据，不按索引自动映射，也不因 criteria_satisfied 自动完成。原 operator_attestation 与 verified Fact 路径保持有效；一旦绑定引用 goal_review，必须持续核验其来源、版本和有效性，不能在评审失效后静默退回无关联绑定。字段与来源规则见[Plan 关联](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。

当前 v2 执行要求授权用户先以 CAS 确定 objective、完成策略和显式有限预算；objective 内部 `v:1` 等字段只作读取 metadata，提交的 Plan 严格为 `v:2`，不能作为执行 fallback；模型只能修订路线。lifetime 任务、轮次、并发及无进展计数不因新路线或 objective revision 重置。依赖就绪检查成功且当前的 Attempt、语义来源/Artifact、实际留存字节与期望输出关联；这些是工程条件，不是语义满足证明。完成仍需全部当前正向操作员判据与完整读取，见 [ADR 0012](architecture/adr/0012-plan-v2-execution.md)。初始 L0/overview 只给有界 handle，`graph_query(kind=plan_objective)` 是完整 Job-scoped 且独立于已接受 Plan 的只读读取；返回 `items[0]` 完整持久 objective tuple，不提供 selectors、cross-scope、wholeGraph，预算或 input hash 不满足时如实失败。

## 可离线收口与范围外

可离线收口：将原 checkbox 对应到测试/PR 证据；验证创建→冻结→Finding 或 Fact result→评审→报告；验证 Plan 关联失效、显式映射与旧绑定路径；验证技术 confirmed/未知规则/相似文本不会推导资格；同步需求追溯、架构视图与文档索引。

生产执行与真实模型试验无需进行，不宣称效果或奖励收益。独立人工标签、隔离调参/留出和预冻结阈值不在豁免内；#819 仍缺这些输入，强关系质量与生产建议未交付。核心 Job 重构、覆盖率看板、自动恢复/提权或外部漏洞提交不因本矩阵进入范围。可信适配器与独立资格现有工程及其定向正向证据分别记录，不能用早期负向测试替代当前实现，也不能扩张成任意目标/官方来源认证。

本轮已验证 content_schema_version:2 旧摘要拒绝边界：manual_verification/verification_status 排除于执行摘要，但 rejected 与 Plan verified 仍独立生效；旧 v1 摘要不自动转换、历史不回写、旧 assignment 不改绑，失效时重新产出结果与评审。#797/#798 已随本批合入，部署前仍须核对保存证据的版本。


[task-plan-review.integration.test.ts](../apps/scheduler/src/task-plan-review.integration.test.ts) 的真实路由/PostgreSQL 完整链已通过 9 项测试（含顶层套件）：delivery 与 negative_result 经评审、显式操作员映射、重新读取后仅完成一次；无映射的原绑定仍有效；错误身份/范围/判据拒绝；完整集合冲突拒绝；unknown effects/读取预算使已接绑定失效；旧证明摘要不得经现存映射获得 Plan authority；持久接纳后来源变更阻止结算且保留原回执。该验收不调用真实模型，不证明任意自然语言覆盖、所有动态授权链或赏金提交资格。组合 CI 结果以 PR 最终记录为准。


## 本轮组合验证记录

以下为本轮实际执行结果，主线程汇总于 2026-10-30；不表示生产或模型试验。命令入口定义见 [package.json](../package.json)。

| 入口/范围 | 结果 |
| --- | --- |
| `ci:integration:plan-protocol`（含 task-plan-review 完整链 9 项） | 12/12 |
| `ci:integration:authz-boundaries` | 83/83 |
| `ci:integration:platform-api` | 17/17 |
| `ci:unit:plan-protocol` | Scheduler 33/33；Web 7/7 |
| `ci:unit:task-intent` | Scheduler 113/113；Web 12/12 |
| `ci:unit:authz` | 78/78 |
| Executor 与 terminal-race 回归 | 75/75 + 11/11 |
| `ci:unit:docs-freshness` | 10/10 |

上述完整链直接覆盖[真实路由测试](../apps/scheduler/src/task-plan-review.integration.test.ts)，终态竞态回归见[terminal-race 测试](../apps/scheduler/src/executor-real-terminal-race.test.ts)。完整 `pnpm build`（含 Scheduler TypeScript 与 Web Vite）已通过；Web 仍提示现有大 chunk 警告。

### 2026-10-31 v2 回放、bootstrap/terminal 与 schema rebuild 追加核验

- **Plan v2 读取与回放。** 当前 Job 的 `graph_query(kind=plan_objective)` 已按上述边界独立于已接受 Plan 返回 `items[0]` 完整持久化目标 tuple；读取预算或 input hash 不满足时保留失败，不把部分响应当完整依据。bootstrap fixture 仅用该 HTTP 读取结果构造首个 v2 提案，并观测到恰好一个就绪 Worker，不将此 fixture 结果升格为所有 route 的协议约束。`C:\Users\sin\AppData\Local\Temp\deepsonar-work\parent-replay-status.json` 记录 normal → all7negative → normal 三次退出码均为 0；normal SQL/HTTP fixture 的 17 条 outcome/trace 全部匹配，7 种注入负例均完成并正确使 gate 失败。`artifacts/plan-replay/report.json` 虽为 `passed=true`/17 traces，但 provenance 是 dirty 的 `ba41a9f44e72e8aa8ccbb0ecba95e305645b52a7`，不是 HEAD `5619154f`，因此不能称为该 HEAD 的精确最终验收，也不是 17 个独立测试；最终组合 CI 仍待核对。
- **Bootstrap/terminal。** `C:\Users\sin\AppData\Local\Temp\deepsonar-work\terminal-bootstrap-regression.log` 为 12 passed、0 skipped，覆盖一个 bootstrap SQL fixture、普通 Hub 无新 v1 审计与 dependent execution/terminal rollback fixture、10 个 contract unit。已核验的 core `finalizeJob` 终态事务把 Job/model token、Control token、audit 和终态收口放在同一事务，终态后的实际 HTTP 请求断言 401；`gateway-token-revocation.ts` 复用调用方 Job 锁，不另取独立 Job 锁，也不吞掉失败。该结论不外推到所有 drain/Reaper 路径。
- **Schema rebuild。** `C:\Users\sin\AppData\Local\Temp\deepsonar-work\rebuild-full.stdout.log` 与 `rebuild-status.json` 记录 19 passed、0 failed、0 skipped（日志完成时间 19:56），含固定历史 v62/v63/v64 dump/pg_restore 恢复及七张新 relation 表。主线程还实际执行 CLI plan/apply，基线 v65→v66，包含真实 `pg_dump` 和备份恢复；最后恢复原始 v65 与一个项目。本地镜像/版本准入证据见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)，最终组合 CI 与发布通道/平台证据另验。

### 2026-10-31 单元层追加复核（历史基线 `b655bed1`）

`b655bed1` 是当时 v0.6.1 的发布准备提交；下面只保留该次历史测试范围，不陈述当前 tag/Release 状态。当前 v0.6.3 集成基线是用户确认已正式发布且不可变的 v0.6.2。

这一组是**追加**复核，不替换也不改写上文任何组合验收记录。**本轮未运行需要 `TEST_DATABASE_URL` 的集成套件，也未调用真实模型**；它只说明该基线的离线单元面通过，不证明当前 main 的数据库回归，也不推翻上文已记录的集成结果。

| 范围 | 本轮实测 |
| --- | --- |
| 任务契约、意图、结果与目标评审（`ci:unit:task-intent` 的 Scheduler 部分，17 个文件） | 121/121 |
| Plan 协议、判据、决策与目标评审绑定（`ci:unit:plan-protocol` 的 Scheduler 部分） | 34/34 |
| Web：`plan-gap-report`、`task-intent`、`task-contract-editor` | 19/19 |
| 报告防误报与版本：`report-failure-recovery`、`report-numeric-fidelity`、`task-report-version` | 33/33 |
| Finding 研究：`ci:unit:finding-research`（7 个文件） | 42/42 |
| Canvas Fact：`ci:unit:canvas-facts`（9 个文件） | 44/44 |
| Verify 资格与 Fact-first：`ci:unit:verify-eligibility`（14 个文件） | 157/157 |

七组共 450 项、0 失败。其中报告三套与 `ci:unit:verify-eligibility` 的文件列表重叠 33 项，去重后为 417 项。计数只对 `b655bed1` 成立：当前 main 已包含后续 Gateway、完成回执与 Verify 变更，旧基线计数不能代替新 main 的验收。

复现说明：本地 `@deepsonar/shared-types` 的 `dist` 早于本基线，未重建时 `tsx --test` 会因缺少新导出而误报模块错误；需先 `tsc -p packages/shared-types/tsconfig.json`。该差异只影响本地复现，不改变 `ci:unit:*` 入口定义。

本轮不重跑上文已通过的数据库集成项，因此既不新增也不推翻它们。此处记录该历史基线的缺口：可信目标授权正向接线，以及当时拆到 #822 的资格闭环；#822 当前实现与新增验收见文末及[专题](PROGRAM_ELIGIBILITY.md)。引用失效、跨范围、零 Finding 与预算等回归仍按各自验收范围核对，不以旧单元计数替代。


## 程序规则独立评审切片（基于 #800）

本片推进 supplied bounty Finding 的 `program_rule:<ruleid>` 独立规则评价和独立报告投影，复用现有 Job/Artifact/Evidence；不改变通用目标 criteria。验收须覆盖 requirement 与 exclusion 满足方向、错误主体/模式/规则 ID、同 Finding/整契约匹配、规则未覆盖、冲突/失效/预算不足，以及通用全部满足不自动令程序规则满足。结果只反映 operator_supplied 材料；尚无官方规则/当前授权认证或 eligible authority，不宣称 #767 完整闭环。前一节组合测试属于 #800，本片结果见下方定向验收记录，不沿用 #800 结果代替。

本片新增验收边界：报告 Finding×rule 累计最多 100 项，超限全部 program_rule_review blocked、criteria 清空并返回 program_rule_projection_limit_exceeded，不保留先前正例；按 Finding 限定报告可单独读取。无有效替代的失效规则评审 insufficient→blocked；当前有效重评可恢复。Plan goal_review_options 排除程序规则，禁止把新增规则 ID 当作通用判据映射。实现已接线，相应定向行为测试已通过，范围见下方验收记录。


### 程序规则切片实际验收

主线程本轮已执行：

| 可定位入口 | 结果与范围 |
| --- | --- |
| [task-goal-review.integration.test.ts](../apps/scheduler/src/task-goal-review.integration.test.ts) | 16/16；真实 PostgreSQL 与 POST /jobs 规则评审路径 |
| `ci:integration:plan-protocol` | 12/12 |
| `ci:unit:task-intent` | Scheduler 121/121、Web 12/12；包含程序规则报告 5 项 |
| `ci:unit:authz` | 78/78 |
| `ci:unit:plan-protocol` | Scheduler 33/33、Web 7/7 |
| `pnpm build` | 完整构建通过 |

本片 `ci:integration:authz-boundaries` 组合已通过 85/85，与 Plan 12/12 合计 97 项集成；上述单元合计 251 项（121+12+78+33+7）。task-goal-review 16 项与程序规则报告 5 项分别已包含在组合中，不重复加总；最终日志见 PR。没有运行真实模型或生产任务，上述结果不认证外部程序授权或提交资格。

### 可信权限适配器当前范围（2026-10-31）

原先缺失的正向核验已在 `f06c3ddf` / `198f4f72` 接入：宿主配置固定 authority URL/secret ref，只读协议绑定认证 principal、项目/租户/角色/资源、精确动作/必需前提、内容和契约摘要、配置/authority revision 及新鲜度；长期 secret 不进入快照、证据或报告。当前仅支持 `reference-http/v1` 的声明式目标，不把任意 URL 或任务声明当作权威。

无密钥 grant 在创建 Job 的事务内追加到系统 `audit_logs`，中央快照准入供子/系统 Job 继承，拒绝调用方伪造同名字段；provision 前及 rerun 再调用 authority。缺失/变化的 grant 返回不可重试 `target_authorization_grant_invalid`。前驱终态后 Hub/Report 的派生在 savepoint 中执行，拒绝会暂停 Canvas，保留前驱终态且不留下部分 Job。源码与拒绝条件见[授权域](../apps/scheduler/src/domains/target-authorization/)、[中央准入](../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.ts)和 [ADR 0011](architecture/adr/0011-trusted-target-authorization.md)。

正向 SQL/HTTP fixture 走真实任务创建、Control、子 Job 和 test-only Worker 的获准动作链；生产代码没有 fake 动作执行 hook。该证据验证工程闭环，不意味着已访问生产目标、执行真实写操作或证明任意目标适配器可用。

## 证据追踪修复（基于 #803）

管理 Finding evidence-trace/详情诊断精确绑定 Artifact source_event 与来源 Attempt，在当前来源约束下使用宿主实际字节检查、exact URI 和共享 8MiB 预算，不用 manifest 声明冒充 observed。execution_assurance=not_attested；runtime_claim_structured 与 retained_bytes_verified 分离，runtime_proof=false，replay.kind=evidence_integrity_check。该修复不执行命令，不改 Verify/Plan/eligibility/历史。真正独立复现与攻击链未完成；Verify runtimeProof 仍 Agent 声明，knownness helper 未运行时接入，不是 novel 权威。前片通过数不作为本片证据，验收范围见[专题](EVIDENCE_TRACE.md)。

证据追踪本片实际证据：真实 route/SQL 11/11（已含于 `ci:integration:verify-eligibility` 12/12），verify 单元 157 + authz 78 = 235，完整 build 通过；helper 真实 FS 3 项已计入 157。覆盖来源/范围/角色、共享预算、超量/非法引用、鉴权和历史不变，见[测试](../apps/scheduler/src/fact-evidence-trace.integration.test.ts)。最终 Scheduler TypeScript、docs 10/10 与 file-size 10/10 已通过；helper 已实测拒绝 Job 内外符号链接，仍为 3 项，不重复增加总数。宿主命令 receipt 是一种后续实现方案，不是原 issue 指定的必需机制；可复核攻击链与有来源范围/时间/适用性的 knownness 查验仅适用于对应高标准安全成果。未满足这些成果判据时不能推出 novel/eligible，不能把它们强加给所有工程任务。未改 Verify 判决 consumer，不把诊断完整性当独立复现。


## 需求归属与停止扩张边界

本表对照 [#767 原始章节及用户后补要求](https://github.com/SummerSec/DeepSonar/issues/767)，区分需求和本仓库后来提出的实现方案；文档中的待办本身不能新增关闭条件。

| 项目 | 需求归属 | 收口边界 |
| --- | --- | --- |
| 指南、场景模板、原始需求、版本快照、跨入口反馈及重新下发指导 | 原 issue §一至§五必需 | 已有离线验收入口，按既有证据核对；不要求理解任意自然语言 |
| 当前凭据、身份/租户/资源与动作授权；获准 save→publish→trigger 正向样本 | 原 issue §三、§五必需 | `reference-http/v1` 只读 authority 与真实 SQL/HTTP fixture 已接线；正向、撤销及版本漂移按本节定向证据核对，不要求通用探测或生产动作 |
| 目标相关候选、非 Finding 交付、独立判据评审、报告及 #775 完成门 | 用户后补要求 | 已有实现与离线证据分别在 #794/#796/#797/#798/#800；不重复列为待开发，不默认增加全局人工门 |
| 可复现证据、适用攻击链、knownness 目标版本适用性与独立资格评审 | 用户后补的高标准安全成果要求 | 仅针对要求此类成果的任务；需授权目标与基线、必要前提/步骤/效果判据、指定查验来源与时间范围、规则材料及评审责任。未知仍为未知，有限未命中不等于 novel |
| 宿主命令执行 receipt | 后续工程方案，非指定的关闭机制 | RuntimeHost 可复用底层执行，但当前无普通任务命令级治理 operation；新增调用契约/权限/幂等与证明绑定须单独设计，不把 CLI 工具日志或 REA agent_reported_observation 升格 |
| 无契约强制迁移、通用秘密扫描、不同人/模型身份认证 | 未被当前任务统一要求 | 可选契约按原要求保留 unassessed；更严格项目准入另行决策，不作为当前默认关闭阻碍 |
| 真实模型效果/奖励收益、自动恢复引擎、覆盖率看板、核心状态机重构 | 用户豁免或原明确排除 | 不为关闭 #767 扩建，不宣称未验证效果 |

宿主来源依据：[RuntimeHost 接口](../packages/runtime-sandbox/src/runtime-host.ts)只返回底层进程结果；[REA 归档接纳](../apps/scheduler/src/domains/cli-capability/rea-cli-fact.ts)明确标记 agent_reported_observation；[Control schema](../packages/shared-types/src/index.ts)没有通用复现命令 operation。只读追踪的 not_attested 因此继续保留，不能靠新增字段消除。

目标授权读取不运行目标命令、不新增执行通道、不扩大 capability/凭据/网络权限。fixture 中的 test-only 动作执行与生产代码分离；通用宿主命令 receipt 仍是未采纳的后续方案，不能把它列为本批必需关闭条件。

## #822 独立资格实现与定向离线验收（2026-10-31）

程序材料的管理准入和独立资格评审已实现，复用 append-only 审计与既有 Finding/Verify/Evidence，详见[资格专题](PROGRAM_ELIGIBILITY.md)、FR-FIND-008 和 [ADR-0010](architecture/adr/0010-program-eligibility-authority.md)。这是操作员见证的当前资格投影，不认证外部官方来源或不同自然人的物理独立性，也不授予目标执行权限。

本地定向 schema/model/routes/report 与既有任务报告共 35 项单元通过；真实隔离 PostgreSQL 路由/SQL 共 12 项通过，无跳过。覆盖真实管理 token/Job capability 分离、材料版本替代/撤销、当前证据及 Attempt 变化、无依据/越权/跨项目幂等重放、项目绑定管理员、有效评审冲突、Canvas 并发重验、历史不变和预算缺口。结果只证明这些工程行为；最终组合 CI 另验，未执行生产任务或业务模型试验。原有 goal_review/program_rule_review 本身仍不产生 eligible，不改写上文历史计数。

## v0.6.3 集成证据范围（2026-10-31）

下表记录本次主线程提供的定向结果，文档同步任务没有重跑产品行为测试；各组合有重叠，不求和。源码持续集成，结果不自动覆盖最终 SHA。

| 来源与范围 | 已有证据 | 尚不能推出 |
| --- | --- | --- |
| 较早 #822/#825 基线 `e23c3b4f` | 远端完整 CI `41186374980` 成功 | 当前 #767/#775/#819/#815 组合通过 |
| #767 授权链 | 组合定向 37 项，含实际 SQL/HTTP 链通过 | 任意目标或生产动作已验证 |
| #767/#775 集成后 | `ci:integration:plan-protocol` 完整脚本 18 pass/0 skip；Plan/graph 定向 125 pass；Web Plan/Session 定向 20 pass；v2 单一 SQL/HTTP fixture 的 outcomes/七故障 gate 与 provenance 限制见上文 | 当前 PR 远端完整 CI、最终 main CI 或质量收益 |
| #819 身份/关系 | `ci:integration:finding-research` 完整脚本 14 pass/0 skip，已取代较早 runner 超时的未完成记录 | 独立人工标签、家族/资产隔离 tuning/holdout 与预冻结阈值仍缺失；`STRONG_RELATIONS_PUBLISHED=false`、`quality_gate_status=not_evaluated`，强关系质量未交付 |
| Verify/Report 集成 | `ci:integration:verify-eligibility` 完整脚本 24 pass/0 skip；修正的 fixture 使用真实事务并断言实际 FindingReport、pending Job 及 hash，不再吞掉 `tx.savepoint` warning | 模型质量、任务语义完成或程序资格自动成立 |
| 权限与 Session 根回归 | 最新当前根的 `ci:integration:authz-boundaries` 87 pass/0 skip（含 Session）；`ci:unit:authz` 78 pass | 最终组合远端 CI 或任意外部目标授权 |
| #822 后续加固 | 操作员见证材料/多次评审、repeatable read 与证据失效已集成 | 独立外部官方来源真实性、不同自然人的物理独立性 |
| #815 与 schema/发布 | 实际本地 base 镜像的 installed canonical Pi/OM RPC、独立生产 guard 正负例及封装/版本准入/适配器回归已通过，身份、日志和分母集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；内核请求前 transport/持久零用量结算与防冒充见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)；schema rebuild/CLI plan/apply/原库恢复见上文 | 本地 image ID 不代表发布 OCI manifest/catalog digest；其他镜像/平台、最终组合 CI、发布及质量/成本收益仍另验 |

这些是主线程实际执行并独立核验的当前根分范围结果，套件与定向文件可能重叠，不求和。早期记录保留其历史范围，不再用超时或旧计数描述最新完整脚本状态。当前 PR 远端 CI、合并后最终 main CI 和 release 均未完成。

最终组合 CI、全部 issue 实现与全部 PR 绿灯完成后才可合并；合并后核对最终 main，再准备 v0.6.3。#819 独立质量缺口须明确完成或由用户认可后单独跟踪，不能用 CI 或文档隐藏。v0.6.2 正式发布保持不可变；未执行生产部署与真实模型试验。
