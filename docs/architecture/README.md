# DeepSonar 系统架构设计

> 状态：**as-built 与规范索引**。#871/#873/#874 在已合入主线收敛；历史工程验收、后续最终 SHA 检查、暂缓质量与正式发行分开，不以代码存在宣称通过。
> 同步日期：2026-11-08
> **v0.6.3 本轮范围（2026-11-01）**：独立质量验证/人工标注与家族/资产分离调参留出、后续质量门、Host 外部证据认证/当前证书、CAS 晋升及公开强关系建议均暂缓，不作为本轮 PR、工程 issue 收口或发布前置条件。现有规格/ADR 不删，已实现工程、测试与权限/CAS/不可变/发布抑制边界不减；最终 SHA 的现有 GitHub Actions 适用检查必须实际全绿，全部测试/构建/typecheck 仅在 Actions 执行。质量仍 `unknown` / `not_evaluated`、强关系 `published=false`；历史质量条款不表示本轮追加卡点。见[最新范围决定](<../../AGENTS.md#豁免范围>)。

面向内部开发者和编码 Agent。先读 [DESIGN](../../DESIGN.md) 摘要，再按需求或主题定位；本目录不改变产品行为。需求组织参考 ISO/IEC/IEEE 29148，视图借鉴 arc42 / C4，关注点分离参考 ISO/IEC/IEEE 42010；这不是标准符合性认证。

#1002 P2-13 的直接重建有效 ACL/default 保全及基线/原对象权限同事务发布映射 [CON-003](01-system-specification.md#con-003-单一-schema-基线)、[数据视图](08-data-architecture.md#直接重建的授权保全1002-p2-13)与[数据库说明](../../database/README.md#重建授权保全1002-p2-13)；不代替受控维护的 runtime 身份 fence，不修改角色或扩大 PUBLIC CREATE，最终 SHA Actions 待验。

平台维护升级的当前决策见 [ADR 0008](adr/0008-maintenance-candidate-upgrade.md)：宿主、受管 SSH 节点和显式回滚恢复已接线；schema 61 → 62 的 16 项 Compose 场景及独立知识后台停写场景已通过并清理。具体基线与隔离环境见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)；Windows Docker 全流程、断电及真实模型验证不能由这些记录推定，P3 Web 发起仍未实现，不能把该决策等同于 #740 全部交付。

#914 的 #925 服务端切片同步[项目凭据引用保护切片](09-interface-specs.md#项目凭据引用保护914-切片)至 FR-CRED-002、运行时/数据/安全视图及追溯矩阵；scope 过滤与删除/设置事务回归复用现有 credential-delete CI 入口，#929 已补齐默认账号选择与修复导航；工程证据见[发布基线](../RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)。

#966 补齐项目显式默认模型和任务创建冲突诊断，继续使用现有 settings/RepairFeedback 与模型优先级；见 [FR-CRED-002](01-system-specification.md#fr-cred-002-providermodel-catalog-与兼容性)、[接口与注意力成本](09-interface-specs.md#项目默认模型与创建冲突966)。不自动选模、不改历史快照，最终 SHA Actions 待验。

#757 凭据先行解析已同步到 [FR-CRED-002](01-system-specification.md#fr-cred-002-providermodel-catalog-与兼容性)、[运行时视图](06-runtime-view.md#凭据与-cli-解析757)、[数据架构](08-data-architecture.md)、[接口规范](09-interface-specs.md)及追溯矩阵；测试入口表示可复验方法，运行结果以 PR 验收记录为准。


#770 source identity and lexical/weak candidates remain separate from #819 strong-relation quality. The agreed schema67 protocol/freeze/exposure, immutable SQL observations/report reconstruction/structural review-revoke engineering merged via #831 and passed at fdb55a01 in Actions; [data](<08-data-architecture.md>), [runtime](<06-runtime-view.md>), [interfaces](<09-interface-specs.md>), [security](<10-security-and-trust-boundaries.md>) and [quality](<04-quality-attributes.md>) map FR-FIND-007/009 to [ADR 0014](<adr/0014-operator-finding-identity.md>). Host verification, current certificates/CAS promotion and guarded publication remain missing, and genuine independent quality inputs unverified; published=false/not_evaluated. #819 closed within the agreed engineering scope, not for full strong-relation quality delivery. The integration record below and [evaluation status](<../PROJECT_FINDING_EVALUATION.md>) distinguish accepted engineering, subsequent repair/final-main checks and deferred human quality; [risks](<12-risks-and-tech-debt.md>) retain only real gaps.


#767 可选任务下发契约已同步到 [FR-TASK-006](01-system-specification.md#fr-task-006-版本化任务契约与派发前校验)、接口/运行时/数据视图及追溯矩阵；可选自由文本、未知条件拒绝与质量评测限制见[下发指南](../../skills/deepsonar-management/references/task-dispatch.md)。

研究候选完整性、目标判据、技术 Verify、独立程序资格及 Plan 完成 authority 分层；admitted_for_research 不表示完成或 eligible，无契约仍 unassessed。#767 可信只读 authority/grant 继承及实时重核见 [FR-TASK-006](01-system-specification.md#fr-task-006-版本化任务契约与派发前校验)与 [ADR 0011](adr/0011-trusted-target-authorization.md)。#775 当前 v2 objective CAS、lifetime 预算、多轮依赖任务复用 Hub Intent admission，持久 continue 事件消费水位避免回调/重启重计，该工程切片已通过下述 `fdb55a01` 主线 Actions，输出关联只证明工程来源，见 [FR-CAP-006](01-system-specification.md#fr-cap-006-plan-协议的当前边界)和 [ADR 0012](adr/0012-plan-v2-execution.md)；普通 Hub 的 v1 writer 已于 2026-10-31 物理删除，immutable v1 audit 仍可读；较早本地 normal→all7negative→normal 报告只作历史，不能覆盖后续修复 SHA。

#815 Pi 会话观测记忆的注册/冻结、Gateway workload/账本与 wrapper/RPC 工程已进入根工作树，见 FR-CAP-009 和 [ADR 0013](adr/0013-governed-pi-memory.md)。有限总额必须显式分配，不推导百分比。实际本地 base 镜像的 canonical RPC、独立生产内容 guard 正负例及封装/OM 专属版本准入/适配器回归已通过，完整身份、场景和分母集中见 [RPC 专题](../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；历史 Session HTTP 脱敏与 Gateway 已知请求前 transport/持久结算、防冒充也已核验，见 [Gateway 专题](../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。工程组合已通过下述 `fdb55a01` 主线 Actions，但发布通道/平台及最终 registry/catalog 闭环尚未完成，不能以本地 image ID 宣称发布或质量/成本收益。

#830 将[注意力原则](../../DESIGN.md#核心理念优化人的注意力)集中定义在 DESIGN；开发入口和贡献指引复用[工程评审与示例](11-engineering-specs.md#11-注意力成本评审830)，映射 NFR-UX-001、03/04/11 与追溯矩阵。仅落实设计/开发约束，不新增运行时、UI、权限或收益承诺。

OpenSandbox 1.2 source upgrade maps IR-001/003 to 06/07/08/10 and the [upgrade record](../OPENSANDBOX_1_2_UPGRADE.md): explicit SDK `wakeRetryEnabled=false`, unchanged direct deployment and kernel recovery; local SDK unit verification is not pinned-server/live/native or final-SHA CI acceptance.

#871/#873 的数据库事务重试、Canvas-first 锁序与跨 Attempt 共享卷边界见[运行时](06-runtime-view.md#数据库锁序共享卷与完成恢复871873874)及[资产专题](../SHARED_ASSET_BLOB_STORE.md#跨-attempt-共享卷生命周期871)。#874 的持久宿主恢复、去重 Hub 和严格对账/停止决策见 [FR-CTRL-010](01-system-specification.md#fr-ctrl-010-完成未知效果的受治理恢复)、[ADR 0015](adr/0015-governed-completion-recovery.md)及[专题](../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)。已合入主线已接回归入口，main 616d7a36 工程验收见[发布基线](../RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)；后续 SHA 另验；显式恢复的新执行代际与 stale Hub 退出见 [#903 生命周期](../AGENT_REPAIR_LIFECYCLE.md)，最终 SHA 工程验收单独记录。

#923 将模型数据面与结算确认分离，关联 FR-CRED-003/004、FR-CAP-009 和 NFR-PERF-004；[透明传输专题](../MODEL_GATEWAY_TRANSPARENCY.md)拥有原始字节、HTTP 边界、预算拒绝及 OM 查询契约，[ADR 0017](adr/0017-transparent-gateway-settlement.md)记录迁移。#928 已合入 main 616d7a36，工程证据见[发布基线](../RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)；后续 SHA 另验。

#954/#960 的全局 Skill 源修复映射 [IR-007](01-system-specification.md#ir-007-git-skill-source)、[FR-CAP-003](01-system-specification.md#fr-cap-003-受治理-skill-拉取)、[FR-KNOW-002](01-system-specification.md#fr-know-002-跨项目-skill-精确授权)：sync 只候选、全局管理员精确 hash+epoch 审批、跨实例同源锁、旧 Job CAS/撤销边界不变。schema68 的已批准/候选元数据见[数据](08-data-architecture.md#skill-源已批准目录与候选960)，管理授权与全局启用影响见[接口](09-interface-specs.md#全局-skill-源候选审批960)，健康观测/既有画布节点 warning 见[运行时](06-runtime-view.md#skill-源检查审批与-job-观察954960)。回归已编写接线但本次未运行，本地测试/构建/typecheck/DB 均未执行，最终 SHA Actions 待验；[风险](12-risks-and-tech-debt.md#skill-源修复与剩余证据边界960)只保留实际证据缺口，不把已修复核心重新列作未来设计。

#992 对应 NFR-OPS-003：既有五片 gate、Reverse 实际消费路由和只读 attempt 成本观测归属[工程规范](11-engineering-specs.md#4-测试分层与实际接线)；真实故障/原生重跑与三组同形文档对照已通过，记录见 [CI 验收](../CI_COST_ACCEPTANCE_992.md)。不新增跨提交通过结论复用，main/发布保障不变。#992 输入冻结前置切片的 npm closure、快照/原生资产身份见 [CI 构建输入](../CI_COST_ACCEPTANCE_992.md#6-基础构建输入冻结992前置切片)、[运行时](06-runtime-view.md#基础镜像构建输入992-前置切片)、[信任边界](10-security-and-trust-boundaries.md)和 [ADR 0018](adr/0018-frozen-base-build-inputs.md)；源码接线尚待最终 SHA Actions 原生验收，复用仍未实现。

## 1. 阅读路径与目录

| 文件 | 回答的问题 | 状态 |
| --- | --- | --- |
| [01 系统规格](01-system-specification.md) | 必须满足哪些功能、质量、接口和约束？ | as-built 基线；逐需求声明实现状态 |
| [02 上下文与范围](02-context-and-scope.md) | 系统与谁交互，什么不属于系统？ | as-built |
| [03 约束与原则](03-constraints-and-principles.md) | 谁拥有真相和执行权限？ | 现行规范 |
| [04 质量属性](04-quality-attributes.md) | 如何观察安全、恢复和性能，哪些指标尚无证据？ | 现行机制与验证场景 |
| [05 构件视图](05-building-blocks.md) | 应用、包和领域怎样分工？ | as-built |
| [06 运行时视图](06-runtime-view.md) | 正常、拒绝与故障链怎样推进？ | as-built |
| [07 部署视图](07-deployment-view.md) | 服务如何部署，镜像和存储有哪些前提？ | as-built 拓扑；实机验收另计 |
| [08 数据架构](08-data-architecture.md) | 数据、证据、事件和版本由谁维护？ | as-built |
| [09 接口规范](09-interface-specs.md) | 管理与 Job 控制入口如何授权、拒绝和去重？ | as-built |
| [10 安全与信任边界](10-security-and-trust-boundaries.md) | 不可信输入跨界时在哪里校验？ | as-built |
| [11 工程规范](11-engineering-specs.md) | 变更怎样验证、同步文档和发布？ | 现行规范 |
| [12 风险与技术债](12-risks-and-tech-debt.md) | 哪些能力暂缓，哪些事实仍需验证？ | 持续维护 |
| [追溯矩阵](traceability.md) | 需求如何对应视图、决策、代码和验收？ | 全量需求索引 |
| [ADR](adr/README.md) | 既有决策与升级恢复边界为什么成立？ | 回填记录与当前决策 |

- 新成员：DESIGN → 02 → 03 → 05 → 06 → 按需专题。
- 实施变更：01 中受影响需求 → 追溯矩阵 → 相关视图 / 专题 → 代码、schema、OpenAPI、测试。
- 安全评审：10 → 09 → 07 → 拒绝与未知效果链。
- 架构变更：03 与相关 ADR → 需求影响 → 实现和验证；使用[文档同步 Skill](../../.agents/skills/architecture-doc-sync/SKILL.md)。

## 2. 权威归属与迁移表

区分三种权威：**代码/schema/OpenAPI/测试描述可观察的实现事实；已采纳 ADR 与约束描述规范要求；测试运行、实机记录描述验证证据。** 文档描述错误时修文档；实现违反既有约束时记录缺陷、影响和待修复项，不能通过修改需求把缺陷合法化。本次不借文档整理修改运行时。

每个主题只有一个展开正文所有者，摘要和索引允许简述并链接。01 定义需求；追溯矩阵只维护关系；视图说明协作；下表指定的专题继续拥有其细则，避免复制两份契约。机器字段以源码契约为准。

| 主题 | 权威正文 / 细则 | 旧 ARCHITECTURE 章节 | 迁移状态 |
| --- | --- | --- | --- |
| 系统范围与角色 | 02；03 | §1–2、§15 | 概览已迁入，旧文历史对照 |
| 实体与数据真相 | 08；schema | §3 实体、§6、§17.1–17.4 | 已迁入，字段不复制 SQL 草图 |
| 生命周期与恢复 | 06；[Attempt 实现](../../apps/scheduler/src/domains/job-attempt/index.ts) | §3 状态机、§4、§8 图循环、文末资格与排序 | 已迁入，细节回到代码和行为测试 |
| 构件与依赖 | 05；[bounded contexts / 锁序](../ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | §4.4、§5、§11 | 构件地图已迁入；锁序专题保留权威 |
| API 与修复 | 09；[OpenAPI](../../apps/scheduler/src/openapi.ts) / shared-types | §7、§8 控制通道 | 已迁入；字段由机器契约维护 |
| CLI 与运行上下文 | [CLI adapters](../AGENT_CLI_RUNTIME_ADAPTERS.md)、[runtime context](../AGENT_RUNTIME_CONTEXT.md)、[profiles](../AGENT_RUNTIME_PROFILES.md)、[Pi RPC 大载荷](../PI_RPC_PAYLOAD_LIMITS.md) | §8.1–8.2 | 专题保留权威，03/05/09 引用；#990 完整归档/索引/Pointer 回读归 06/08/09/10，NFR-REL-004/NFR-SEC-003，最终 SHA Actions 待验，sender/冻结 knobs/80 MiB E2E 未交付 |
| Pi 模型预算与截断恢复 | FR-CRED-002、FR-JOB-009/013/014、IR-002；06/08/09；[预算与恢复专题](../PI_MODEL_BUDGET_RECOVERY.md) | 本期新增 | #958 声明/配置/实际 CLI 分层、不可变快照和同 Session 有界恢复；最终 Actions 待验，真实容量未知 |
| 镜像与部署 | 07；[镜像目录契约](../RUNTIME_IMAGE_REGISTRY_CONTRACT.md)、[部署](../ONE_CLICK_DEPLOYMENT.md)、[发布契约](<../RELEASE_RUNTIME_IMAGES.md>) | §8.3、§9 资源 | 已迁入概览；FR-IMG-001/002 的 OH Fuzz 匹配工具链与 fresh/reuse 原生 sanitizer 回归见发布专题，实际执行结果单独留证 |
| OpenSandbox upgrade / resource init | IR-001/003、NFR-PERF-003; 06/07/08/10/12; [upgrade/resource record](../OPENSANDBOX_1_2_UPGRADE.md), [canonical pins](../../packages/runtime-sandbox/src/opensandbox-version.ts) | Historical versions retained | SDK/direct ingress/recovery unchanged; #1002 P2-11 same-Engine init rejects unsupported/unknown declarations, final-SHA Actions pending; per-container/remote enforcement remains D-10 |
| 资源阈值与性能 | 04；[config](../../apps/scheduler/src/config.ts) | §9.2、§12 | 已迁入；不沿用旧默认值清单 |
| Canvas 节点引用索引 | FR-TASK-004、CON-003；08；[数据库说明](../../database/README.md#canvas-节点引用索引1002-p1-6) | 任务 retry 仍为单事务 | #1002 P1-6 外键前导索引；SQL 计划/HTTP 回滚隔离与基线重建接现有 Actions，最终 SHA 待验，不证明现场容量或延迟 |
| Model Gateway 透明传输 | [透明传输契约](../MODEL_GATEWAY_TRANSPARENCY.md)、[OM 结算](../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)；06/08/09/10 | 历史代理描述不作为现行契约 | #923 单次原始传输、准入拒绝与 scoped 持久确认；#1002 凭据删除保留 token/账本与历史额度，最终 SHA Actions 待验 |
| 安全与隔离 | 10；[设备边界](../DEVICE_ACCESS.md)、[共享资产](../SHARED_ASSET_BLOB_STORE.md) | §9.1 | 概览已迁入，专题保留细则 |
| 全局 Git Skill 源发布与新鲜度 | IR-007、FR-CAP-003/FR-KNOW-002；[候选数据](08-data-architecture.md#skill-源已批准目录与候选960)、[审批接口](09-interface-specs.md#全局-skill-源候选审批960)；06/10 | 旧 §8.4 仅历史对照 | #960 schema68：既有 live 不迁移，sync 只候选，精确 hash+epoch 显式批准；旧 Job 不改，健康检查与 pending 分离；最终 Actions 待验 |
| 项目 Memory / Skill | 01 中 FR-KNOW；05–10 相关视图；[项目知识专题](../PROJECT_KNOWLEDGE.md) | 本期新增 | #752 分支实现与验证范围分开记录；专题拥有工作流和字段细则 |
| 可信目标执行授权 | FR-TASK-006；06/09/10；[ADR-0011](adr/0011-trusted-target-authorization.md)、[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md) | 本期新增 | 只读 authority、immutable grant、中央继承、实时重核；不执行目标动作 |
| 管理员单条效果见证 | FR-JOB-005；06/08/09/10；[部署说明](../../deploy/README.md#管理-api-的单条效果结清1002-p1-9) | #1002 P1-9 | admin 与同项目/Job/Attempt 准入，精确重试、不覆盖已结清证据；不补写 unknown 用量、不退还预算或入队；现有 recovery 的实际 HTTP/SQL 回归已接，最终 SHA Actions 待验 |
| Plan v2 有界执行 | FR-CAP-006、FR-HUB-002/003/004/005；06/08/09；[ADR-0012](adr/0012-plan-v2-execution.md)、[Plan 专题](../PLAN_GAP_PROJECTION.md) | 本期新增 | 当前写入只接收 v2；objective CAS、lifetime 预算与实际输出来源；writer 已物理删除（2026-10-31），历史本地 replay/negative gate 保留原范围，本轮工程已随 #831 Actions 验收，后续修复 SHA 另验 |
| Pi 会话观测记忆 | FR-CAP-009、FR-IMG-003、FR-JOB-009/013、FR-CRED-003/004；05/07/10/12；[ADR-0013](adr/0013-governed-pi-memory.md)、[集成专题](../PI_OBSERVATIONAL_MEMORY_INTEGRATION.md)、[镜像/RPC 证据](../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收) | 本期新增 | 与项目知识分责；本地实际镜像 RPC、独立生产内容守卫与 OM 专属版本准入已验，本轮工程已随 #831 Actions 验收，后续修复 SHA/正式发布通道/平台与收益另计 |
| 操作员身份与强关系工程 | FR-FIND-007/009；04/08/09/12；[ADR-0014](adr/0014-operator-finding-identity.md)、[研究专题](../PROJECT_FINDING_RESEARCH.md) | 本期新增 | 来源登记/CAS/失效与持久计算，以及协议/freeze/暴露、实际 SQL 观察/报告和结构性 review/revoke 工程已接线；外部真实性和独立质量不由管理员准入证明。约定工程已随 #831 Actions 验收；独立质量、Host 证书/CAS 晋升/公开强关系按本轮范围暂缓，保持 unknown/not_evaluated、published=false；后续修复 SHA 的适用检查仍须另验 |
| 独立程序资格 | FR-FIND-008；08/09/10；[资格专题](../PROGRAM_ELIGIBILITY.md)、[ADR-0010](adr/0010-program-eligibility-authority.md) | 本期新增 | 操作员材料准入、评审与当前投影；不代替技术 Verify 或目标执行授权 |
| 风险、路线与取舍 | 12、ADR；[长期提案](../AI_NATIVE_TRUSTED_KERNEL.md) | §10、§13–16 | 旧开工顺序与 MVP 结论只作历史 |
| 工程与发布 | 11；[发布硬门](../RELEASE_RUNTIME_IMAGES.md)、AGENTS 执行摘要 | §17.5 | 入口已迁入，发布专题与执行红线保持有效 |

[旧 ARCHITECTURE](../ARCHITECTURE.md) 本期保留，每个一级章节附迁移标记；不再作为新实现的独立事实入口。未被本目录覆盖的新问题应先回到源码核实，不从历史草图推导现行承诺。DESIGN、AGENTS/CLAUDE 保留高密度摘要，不替代本表的细则所有权。

#952/#964 的退休镜像软件拒绝映射 FR-IMG-001/002/003/004，见[部署视图](07-deployment-view.md#镜像准入和运行时路径)、[接口](09-interface-specs.md#退休运行镜像964)及[下线专题](../DEPRECATIONS.md#软件拒绝边界9642026-11-07-核对)。统一精确 key，原目录校验与当前产品投影分开；历史事实不重绑。回归已接现有 CI，最终 SHA Actions 待验，未执行运营清理。

## 3. 状态与编号

每篇文档前 12 行必须有 `> 状态：...` 与 `> 同步日期：YYYY-MM-DD`。同步日期是最近核对该文档事实的日期，不是措辞编辑日期。文档级 as-built 不代表所有关联测试在当前环境通过；具体未完成能力和验证缺口必须显式标注。

视图编号不重排；需求按 `FR-域-NNN`、`NFR-属性-NNN`、`IR-NNN`、`CON-NNN` 分类。功能域在 01 中定义，TASK 包含任务编排，独立证据与资产边界不能隐含混入 Finding。非功能属性为 SEC、REL、PERF、OBS、EVO、OPS、UX（人的注意力成本）；域按稳定责任分组，不按每个文件创建前缀。

需求以三级标题定义，格式为 `### ID`（可附中文标题）（例如查找 FR-JOB-001）；正文引用相同 ID 不算重复定义。每条记录规范要求、决策来源（含理由）、代码入口、实现状态和验证证据。ID 发布后不改作他义、不复用；本次保留 #744 首批编号的原有含义，新增需求使用未占用编号。废弃需求保留「实现状态：已废弃」及取代者，并登记到 `docs-freshness.test.ts` 的 `DEPRECATED_REQUIREMENT_IDS`；门禁要求登记条目持续保持废弃状态，不能重新激活或删除。历史引用不恢复旧运行时契约。

追溯矩阵使用五列表格：需求 ID、架构视图、ADR、代码入口、验收。首列是裸 ID，每个定义恰好一行；不适用 ADR 填 `—`，验收不能留空。无自动测试时写明确人工核查步骤及尚未执行状态。矩阵不复写需求正文。ADR 允许编号有空缺，禁止复用；回填日期与原决策日期分开。

配置默认值只证明护栏存在。质量目标、测量环境、测量方法和运行证据分别记录；未定义的 SLA 不编造数值。接口参数与默认值尽量引用机器契约，避免多处抄写。

## 4. 维护与验证

1. 功能、领域规则、API、schema、状态机、运行时、权限或废弃契约变化时，执行[开发文档同步 Skill](../../.agents/skills/architecture-doc-sync/SKILL.md)，在同一变更中更新受影响的需求、关系、视图和摘要。无文档影响可以不改，但必须说明核查范围和理由。
2. 新架构取舍或推翻旧决定才新建 ADR；已采纳正文保留历史，状态链接到替代决定。0009 仍是提议，0010 仍已采纳；0011–0014 分别记录目标授权、Plan v2、Pi 记忆和操作员身份，不改写前两条的决策段。
3. `pnpm ci:unit:docs-freshness` 检查路径、脚本、已删机制、状态日期、需求定义与引用、矩阵覆盖、ADR/Skill 入口和 AGENTS/CLAUDE 同步。文件链接检查不验证标题锚点、网络 URL 可达性、代码符号或语义；人工核查这些内容。
4. `pnpm ci:unit:file-size` 检查门禁代码体量，新增测试继续走现有 docs-freshness 脚本及 CI；按变更面运行行为测试。不能用文档门禁代替越权、恢复、幂等的行为测试。
5. 发版前仍按 AGENTS 的发布文档保鲜硬门，逐项核对语义和发布证据；文档存在不等于镜像或 Release 成功。

## 5. 实施记录

#742 已交付索引骨架，#744 已交付首批三条链路规格与追溯。本次 #741 后续交付十二视图、追溯矩阵、六条 ADR、开发 Skill、逐章迁移标记和追溯/跨平台门禁。验证入口见 [11](11-engineering-specs.md)，本次执行结果以 PR 的验证记录为准。没有修改产品运行时行为、数据库基线或对外 API。

#767 后续目标证据链见[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)：研究候选、非 Finding 结果、来源隔离评审、确定性报告和可信目标授权已接线；可选 Plan 关联保留原操作员 authority。对应 FR-TASK-006/007、FR-RPT-001；程序资格另见 FR-FIND-008 与 [#822 专题](../PROGRAM_ELIGIBILITY.md)，Plan v2 执行与完成门分别核验。

FR-FACT-003 的[Finding 证据追踪](../EVIDENCE_TRACE.md)修复管理诊断的来源与字节完整性，不改变 Verify verdict 或赋予执行/资格 authority。

#770 C 特征投影的字段来源、恢复和未完成的 D 质量门见[专题](../PROJECT_FINDING_RESEARCH.md)；对应 FR-FIND-007。

#778 当前 Job 的条件建议与选择回执已同步 FR-CAP-003 / FR-CAP-008、构件/接口/数据/安全视图；[专题](../SKILL_SUGGESTIONS.md)列出非模型验收矩阵及未评估的效果、平台源和 Pack 范围。

2026-11-01 集成证据：[#831](https://github.com/SummerSec/DeepSonar/pull/831) 在最终 PR 检查全绿后合并至 `fdb55a01b1e02b5b9078586923a8d506ce5bb096`；该主线的六个适用 Actions 工作流全绿，包含真实 schema67 重建和备份恢复，本轮工程 issue 已收口。较早 schema66/SDK-only 和本地记录只作历史，不能覆盖后续修复。OpenHarmony Fuzz 在正式 Release 的新构建失败，当前修复映射 FR-IMG-001/002、07 部署视图及既有 ADR 0006，增加匹配工具链与 fresh/reuse 双原生架构行为证据；[发布专题](<../RELEASE_RUNTIME_IMAGES.md#openharmony-specialist-ci-contract>)区分有限诊断、最终修复 SHA 验收和正式发行。v0.6.3 尚未正式发布，v0.6.2 保持不可变；独立质量、Host 证书/晋升/公开强关系建议按本轮决定暂缓，不把工程全绿写成质量通过。
