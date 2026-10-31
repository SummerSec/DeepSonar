# 任务下发验收矩阵（#767）

> 状态：实现与验收盘点；已有能力与剩余正向验收分列，运行结果以关联 PR/CI 记录为准。
> 同步日期：2026-10-31

原 issue 要求按场景明确目标、范围、授权、材料与完成条件，并在创建/派发前发现不满足的前置条件。后续 #794、#796、#797、#798 分别补充目标相关研究候选、报告防误报、来源隔离判据评审及非 Finding 交付。下表不把源码或测试入口存在等同于本次已运行通过。

## 原始下发要求

| 验收面 | 已有实现/证据入口 | 能力或验收缺口 | 产品决策 |
| --- | --- | --- | --- |
| 管理入口可发现指南、共用规则与场景模板 | deepsonar-management SKILL 与 task-dispatch/whitebox/blackbox references；共享 task-contract 模板 | 交付前核对指南链接、非审计工程样本及重新下发错误分类 | 无需扩大功能范围 |
| 版本、快照、原始需求与字段级反馈 | task-contract.ts、任务创建 API/Web/CLI；task-contract 与 task-intent 测试 | 汇总同意图不同入口、字段顺序及表达的既有验收证据；结构检查不证明自然语言理解 | 无 |
| 可选契约与无契约入口 | 无契约明确 unassessed；显式契约统一基本完整性，outcome 不绕过 | 不能声称所有入口都已强制标准化 | 可选是原设计；强制迁移需另行决策，**不是本 issue 必须消除的关闭阻碍** |
| 凭据、网络与创建后变化 | task-contract-preflight.ts 重读当前可信信息；相关单测/集成 | 验收凭据撤销、项目边界、当前出网与 rerun，不把创建时通过沿用到派发 | 无 |
| 身份、租户、资源、目标写权限 | 未核验身份/目标 write 和必要前置条件 fail closed，声明不授权 | 尚无可信应用身份/写授权适配器；不能把“获准测试租户完整 save→publish→trigger”标为完成 | 需选择可信授权来源、支持的目标及低风险核验方式 |
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
| 高标准安全提交候选 | 已有规则材料身份与声明筛选、技术 Verify 和通用判据评审 | 适用攻击链、knownness 对目标版本的适用性及独立程序资格仍未形成完整正向闭环；eligible 不可由 severity/相似词推导 | 资格 authority 与适用程序范围需明确；不自动提交漏洞 |
| #775 完成门 | 已有 operator_attestation、verified Fact、Plan 判据与 complete 门；#795 增加持久接纳回执 | 新评审不得自动变成 Plan authority；接纳回执不是执行完成 | 已接可选显式 goal_review 关联，不新增 authority、不替代原绑定 |

## Plan 关联边界与实际验收

操作员显式选择目标评审与 Plan 判据，不按索引自动映射，也不因 criteria_satisfied 自动完成。原 operator_attestation 与 verified Fact 路径保持有效；一旦绑定引用 goal_review，必须持续核验其来源、版本和有效性，不能在评审失效后静默退回无关联绑定。字段与来源规则见[Plan 关联](PLAN_GAP_PROJECTION.md#可选目标评审关联767)。

## 可离线收口与范围外

可离线收口：将原 checkbox 对应到测试/PR 证据；验证创建→冻结→Finding 或 Fact result→评审→报告；验证 Plan 关联失效、显式映射与旧绑定路径；验证技术 confirmed/未知规则/相似文本不会推导资格；同步需求追溯、架构视图与文档索引。

真实模型验收已由用户豁免，效果与奖励收益未验证不构成交付阻碍，也不能宣称收益。Pi 输出修复、核心 Job 状态机重构、审计覆盖率看板、自动重试引擎、自动提权或外部漏洞提交不因本矩阵进入范围。可信适配器和资格正向闭环缺口须明确保留，不用负向拒绝测试替代其完成证据。

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

### 2026-10-31 单元层复核（基线 `b655bed1`）

在 v0.6.1 发布提交上重跑可离线单元入口，刷新上表中单元层的计数。**本次未运行需要 `TEST_DATABASE_URL` 的集成套件，也未调用真实模型**，因此只更新单元证据，不改变「跨切片端到端验收」仍待数据库集成的事实。

| 范围 | 本轮实测 |
| --- | --- |
| 任务契约、意图、结果与目标评审（`ci:unit:task-intent` 的 Scheduler 部分，17 个文件） | 121/121 |
| Plan 协议、判据、决策与目标评审绑定（`ci:unit:plan-protocol` 的 Scheduler 部分） | 34/34 |
| Web：`plan-gap-report`、`task-intent`、`task-contract-editor` | 19/19 |
| 报告防误报与版本：`report-failure-recovery`、`report-numeric-fidelity`、`task-report-version` | 33/33 |
| Finding 研究：`ci:unit:finding-research`（7 个文件） | 42/42 |
| Canvas Fact：`ci:unit:canvas-facts`（9 个文件） | 44/44 |
| Verify 资格与 Fact-first：`ci:unit:verify-eligibility`（14 个文件） | 157/157 |

七组共 450 项、0 失败。其中报告三套与 `ci:unit:verify-eligibility` 的文件列表重叠 33 项，去重后为 417 项。这表示本基线的**离线单元面是干净的**，不表示任何端到端或效果结论。

复现说明：本地 `@deepsonar/shared-types` 的 `dist` 早于本基线，未重建时 `tsx --test` 会因缺少新导出而误报模块错误；需先 `tsc -p packages/shared-types/tsconfig.json`。该差异只影响本地复现，不改变 `ci:unit:*` 入口定义。

仍未汇总、需要数据库的项保持开放：引用失效与跨范围回归、零 Finding / 失败来源 / 未执行 / 部分覆盖与预算的端到端回归，以及独立程序资格正向闭环。这些不以本轮单元计数替代。


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

### 可信权限适配器仍需的输入

下一片若推进真实身份/写授权正向核验，需明确目标系统、租户/资源边界、权威只读身份与动作权限接口、权限撤销/过期规则，以及对应脱敏 fixture。不能用任务声明、公开元数据或凭据存在替代这些权威事实；在输入与适配器未落实前保持未核验并阻塞依赖步骤，不声称原 issue 的获授权完整动态链已验收。

## 证据追踪修复（基于 #803）

管理 Finding evidence-trace/详情诊断精确绑定 Artifact source_event 与来源 Attempt，在当前来源约束下使用宿主实际字节检查、exact URI 和共享 8MiB 预算，不用 manifest 声明冒充 observed。execution_assurance=not_attested；runtime_claim_structured 与 retained_bytes_verified 分离，runtime_proof=false，replay.kind=evidence_integrity_check。该修复不执行命令，不改 Verify/Plan/eligibility/历史。真正独立复现与攻击链未完成；Verify runtimeProof 仍 Agent 声明，knownness helper 未运行时接入，不是 novel 权威。前片通过数不作为本片证据，验收范围见[专题](EVIDENCE_TRACE.md)。

证据追踪本片实际证据：真实 route/SQL 11/11（已含于 `ci:integration:verify-eligibility` 12/12），verify 单元 157 + authz 78 = 235，完整 build 通过；helper 真实 FS 3 项已计入 157。覆盖来源/范围/角色、共享预算、超量/非法引用、鉴权和历史不变，见[测试](../apps/scheduler/src/fact-evidence-trace.integration.test.ts)。最终 Scheduler TypeScript、docs 10/10 与 file-size 10/10 已通过；helper 已实测拒绝 Job 内外符号链接，仍为 3 项，不重复增加总数。宿主命令 receipt 是一种后续实现方案，不是原 issue 指定的必需机制；可复核攻击链与有来源范围/时间/适用性的 knownness 查验仅适用于对应高标准安全成果。未满足这些成果判据时不能推出 novel/eligible，不能把它们强加给所有工程任务。未改 Verify 判决 consumer，不把诊断完整性当独立复现。


## 需求归属与停止扩张边界

本表对照 [#767 原始章节及用户后补要求](https://github.com/SummerSec/DeepSonar/issues/767)，区分需求和本仓库后来提出的实现方案；文档中的待办本身不能新增关闭条件。

| 项目 | 需求归属 | 收口边界 |
| --- | --- | --- |
| 指南、场景模板、原始需求、版本快照、跨入口反馈及重新下发指导 | 原 issue §一至§五必需 | 已有离线验收入口，按既有证据核对；不要求理解任意自然语言 |
| 当前凭据、身份/租户/资源与动作授权；获准 save→publish→trigger 正向样本 | 原 issue §三、§五必需 | 负向阻塞不是正向支持；至少需一个目标系统、租户/资源/动作、可信只读判权来源、撤销规则与脱敏 fixture，不要求通用主动探测引擎 |
| 目标相关候选、非 Finding 交付、独立判据评审、报告及 #775 完成门 | 用户后补要求 | 已有实现与离线证据分别在 #794/#796/#797/#798/#800；不重复列为待开发，不默认增加全局人工门 |
| 可复现证据、适用攻击链、knownness 目标版本适用性与独立资格评审 | 用户后补的高标准安全成果要求 | 仅针对要求此类成果的任务；需授权目标与基线、必要前提/步骤/效果判据、指定查验来源与时间范围、规则材料及评审责任。未知仍为未知，有限未命中不等于 novel |
| 宿主命令执行 receipt | 后续工程方案，非指定的关闭机制 | RuntimeHost 可复用底层执行，但当前无普通任务命令级治理 operation；新增调用契约/权限/幂等与证明绑定须单独设计，不把 CLI 工具日志或 REA agent_reported_observation 升格 |
| 无契约强制迁移、通用秘密扫描、不同人/模型身份认证 | 未被当前任务统一要求 | 可选契约按原要求保留 unassessed；更严格项目准入另行决策，不作为当前默认关闭阻碍 |
| 真实模型效果/奖励收益、自动恢复引擎、覆盖率看板、核心状态机重构 | 用户豁免或原明确排除 | 不为关闭 #767 扩建，不宣称未验证效果 |

宿主来源依据：[RuntimeHost 接口](../packages/runtime-sandbox/src/runtime-host.ts)只返回底层进程结果；[REA 归档接纳](../apps/scheduler/src/domains/cli-capability/rea-cli-fact.ts)明确标记 agent_reported_observation；[Control schema](../packages/shared-types/src/index.ts)没有通用复现命令 operation。只读追踪的 not_attested 因此继续保留，不能靠新增字段消除。

本轮仅核对范围与来源，不运行目标命令、不新增执行入口、不扩大 capability/凭据/网络授权。缺业务输入不阻碍独立离线工程，但不能以新添通用执行器或无限延伸待办替代原始正向验收。
