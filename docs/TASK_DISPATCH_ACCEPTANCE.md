# 任务下发验收矩阵（#767）

> 状态：实现与验收盘点；已有能力与剩余正向验收分列，运行结果以关联 PR/CI 记录为准。
> 同步日期：2026-10-30

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

本轮已验证 content_schema_version:2 旧摘要拒绝边界：manual_verification/verification_status 排除于执行摘要，但 rejected 与 Plan verified 仍独立生效；旧 v1 摘要不自动转换、历史不回写、旧 assignment 不改绑，失效时重新产出结果与评审。#797/#798 尚未合并部署不代表无版本影响。


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

上述完整链直接覆盖[真实路由测试](../apps/scheduler/src/task-plan-review.integration.test.ts)，终态竞态回归见[terminal-race 测试](../apps/scheduler/src/executor-real-terminal-race.test.ts)。构建仍待主线程最后 Scheduler TypeScript 步骤确认，未在此提前记为通过。
