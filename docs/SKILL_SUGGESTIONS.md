# 当前 Job 的 Skill 条件建议

> 状态：#778 在线条件建议与选择声明实现；运行证据以对应 PR 的测试和 CI 为准。真实模型验收已按用户要求豁免，不代表收益已验证。
> 同步日期：2026-10-30

## 范围和含义

`suggest_project_skills` 在当前 Job 的冻结目录内比较**本项目 Skill 精确版本**的作者声明和运行条件。它只给条件匹配建议，不给效果优胜排名。`record_skill_choice` 记录 `select` / `reject` / `none` 与声明理由，复用 knowledge 事件、事务及持久 receipt。原 `pull_skill`、usage、feedback 和独立评测流程继续分别承担拉取、使用声明和结果证据的职责。

两个操作必须在全局角色配置显式设为 true，项目覆盖只能进一步收紧；空配置不启用它们。解析结果必须存在于当前 Job allowlist；本次不修改已有 RoleConfig 或 Job 快照，不自动启用建议。Skill、Pack、模型、镜像、项目、工具和网络权限不会因建议变化。平台源、跨项目 Skill 和 Pack 的适用性在本版本明确为未评估，仍走原有受控发现接口；不读取它们的内容、来源 Job、Memory 或质量样本来辅助本项目排序。模型推荐、Pack 自动晋级与组合效果归因不属于本实现。

## 契约与闭环

机器字段以 [shared schema](../packages/shared-types/src/project-knowledge.ts) 为准，通过现有 operation registry 生成 Job 动态 OpenAPI。

1. Skill 作者将严格的 `deepsonar.skill-applicability/v1` JSON 放入 `references/applicability.json`，随完整 Candidate 一起绑定不可变内容 hash。声明包含任务类型、输入种类、目标版本、runtime digest、所需工具、网络及最低时间/token 预算；缺失、非法或带未知字段的声明为 `unknown`。正文描述不参与条件判定。
2. Agent 调用 `suggest_project_skills`，提交 `target`、有界 `limit` 和 `offset`。目标字段标为 `caller_declared`，不从任务自由文本猜测，不把调用者说法变成已观察事实。宿主只从当前 Job/Attempt、冻结快照和服务端时间取运行条件。
3. 宿主校验冻结目录和完整 CAS，过滤当前权限及撤权，再检查条件。只有 compatible 条目进入候选，随后按精确身份稳定展示并截页；该顺序不是质量评分。授权目录超过读取上限时拒绝整次请求，不先截断目录冒充完整候选集。无匹配候选是正常空结果。`next_offset` 仅表示候选续页，`diagnostics_next_offset` 表示非匹配诊断续页，两者使用相同的有界 offset 参数，诊断不计入候选 total。
4. Agent 用返回的策略版本、context/catalog hash、相同 target/limit/offset 和精确 selector/content hash 记录选择。摘要是上下文绑定，不是授权签名；宿主重新计算当前建议，拒绝过期上下文或已不可选版本。选择事务锁定并复查当前版本，使用数据库实时钟检查锁等待后租约，不能沿用事务开始时间。回执保存本次重算依据和 Agent 的理由。
5. `select` 不生成 usage、不执行 Skill、不触发知识晋升。选择后仍须 `pull_skill`，该操作再次检查当前权限和 hash。实际拉取的 `usage_ref` 才能用于已有 `record_knowledge_feedback`。旧选择回执不恢复撤销权限。

没有与当前模型完整绑定的可靠剩余 token 预算，因此返回 `token_budget=unknown`；要求正 token 余额的 Skill 不能判为匹配。声明 `minimum_tokens=0` 仅表示该方法不要求这类预算，不证明整个 Job 不消耗 token。时间来自 Job 的 started_at/timeout_sec，未知或耗尽不判为匹配。条件匹配仍然不能证明输入资产确实存在或方法有效。

只读建议不产生新的曝光账本；`exposure=unknown`。选择回执保存的是宿主重算快照，不证明 Agent 之前看过哪一页。独立效果样本分母为 0，效果未知，历史 Job 成功和模型反馈均不参与排序。回执通过既有 Job 查询或管理面历史查询读取；未知外部效果沿用对账规则，不重放执行。

## 非模型验收矩阵

| 原 issue 关注点 | 当前可复验检查 | 保留边界 |
| --- | --- | --- |
| 精确版本、适用条件、证据、策略、最终选择 | CAS/hash、严格 sidecar、策略/context/catalog 绑定、choice receipt | 作者与调用者声明不变成独立事实 |
| 曝光/选择/拉取/使用/质量分离 | choice 不写 usage/work；pull 与反馈原链路独立；质量分母 0 | 曝光和独立质量没有伪造补值 |
| 权限、撤权、跨项目隔离 | Job/Attempt/lease/allowlist，读取后整批复查，选择提交再查，外国记录不进入候选/诊断/计数 | 跨项目与平台源建议未评估 |
| 负例、缺输入、不兼容、冷启动、恶意描述 | strict schema、无 sidecar、工具/网络/runtime/时间/token 条件，空集和上限回归 | 输入语义由调用者声明，未验证资产内容 |
| 固定对照、误选、遗漏、成本和分母 | [冻结合成夹具](../agent-harness/capability-applicability/online-fixtures/acceptance.json)，development/holdout 分开，零误选/零关键遗漏工程阈值 | 不估计业务质量、成本或时间收益，不据此默认启用 |
| 幂等、重启、撤销和策略回滚 | 原事件/receipt 去重、同键不同输入冲突、重新构建 application 读取相同结果、过期策略拒绝 | 回滚为移除后续 Job 授权；历史回执保留，不能恢复权限 |
| schema、OpenAPI、测试和 CI | shared schema 生成控制契约，既有 knowledge CI 运行新单元/集成测试 | 没有新增表或修改 SQL 基线，无 schema bump/rebuild |

冻结对照 baseline 是现有“发现但不自动建议”，因此 baseline 不作自动选择。新策略的合成误选分母是测试案例数、遗漏分母是已知匹配案例数；不能把 baseline 的不建议当成实际模型误用率。业务独立质量、模型 token、费用和真实任务耗时均未测量，分母 0；小样本不作 uplift 推断。真实模型验收豁免不取消权限、竞态和幂等测试。

## 验证入口

`pnpm ci:unit:project-knowledge` 执行规则、契约、固定合成对照及已有离线工具测试；`pnpm ci:integration:project-knowledge` 使用独立 `TEST_DATABASE_URL` 验证完整调用和数据库回执。后者为每例创建并清理随机临时库，不能使用业务数据库。两个脚本均在 `.github/workflows/ci.yml` 调用。

本次复用 FR-CAP-003 / FR-CAP-008 与既有 knowledge 事务；不增加执行器或 Experience ledger，也不改 #767/#775 的完成协议、#776 的 repair 预算或 #770 的 Finding 特征协议。

## 选择证据导出与阶段收口

[离线报告](../agent-harness/capability-evidence/README.md)的 v2 契约读取既有选择 receipt 和 knowledge 事件，按 Job 事件序号保留 select/reject/none 历史。只有策略、目录 hash 与精确候选身份有效时，才关联同 Job/Attempt 的 pull usage 及反馈 receipt。它保留理由存在标记和原 receipt 引用，不复制理由、target 或反馈正文；不能从同身份关联推断先后、因果或最终胜出选择。缺失事件来源不计数，缺失上下文绑定保留 unknown，撤权身份与外国项目结果不进入计数。

实际 PostgreSQL 回归执行仓库 export.sql 的只读可重复读事务，覆盖真实 runtime 声明、拉取、反馈、跨 Attempt、撤权、跨项目和来源损坏；相同输入可重建相同报告。只支持 v2，旧导出须重新生成，不提供转换兼容；数据库基线和运行时协议不变。

| 原 issue 阶段 | 当前工程交付及收口条件 |
| --- | --- |
| A：关联与质量报告 | 精确版本选择/拉取/反馈与来源引用已串联；曝光、独立质量、失败归因和收益未知，不能用自评补齐 |
| B：只读候选与受控选择 | 当前项目 Skill 条件建议、空结果、选择回执及二次授权验证；#802 提供运行时依赖 |
| C：对照与是否默认启用 | 冻结合成对照和权限/竞态/幂等回归；决定保持显式 opt-in。原要求是决定是否启用，不是强制默认开启 |
| D：模型推荐与 Pack 晋升 | 原 issue 的后续范围，本次不实施；平台源、跨项目与 Pack 仍使用已有受控发现，不伪造适用性或收益排序 |

真实模型验收已豁免，效果/成本未验证不单独阻止本次工程范围收口。#802/#810 已随 #811 合入，main 3964f738 的 CI 与 reverse-runtime 组合检查通过；#778 已按限定工程范围关闭。保持显式 opt-in，不声称业务效果已验收。
