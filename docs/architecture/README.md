# DeepSonar 系统架构设计

> 状态：**as-built 文档基线（#741；#752 独立试验分支同步）**。覆盖现有实现与工程约束；暂缓能力及证据缺口单独列出，不构成新增运行时承诺。
> 同步日期：2026-10-29

面向内部开发者和编码 Agent。先读 [DESIGN](../../DESIGN.md) 摘要，再按需求或主题定位；本目录不改变产品行为。需求组织参考 ISO/IEC/IEEE 29148，视图借鉴 arc42 / C4，关注点分离参考 ISO/IEC/IEEE 42010；这不是标准符合性认证。

平台维护升级的当前决策见 [ADR 0008](adr/0008-maintenance-candidate-upgrade.md)：基础机制已有代码，受管节点和显式回滚恢复正在接线，最终真实端到端验收未完成；不能把该决策等同于 #740 全部交付。

#757 凭据先行解析已同步到 [FR-CRED-002](01-system-specification.md#fr-cred-002-providermodel-catalog-与兼容性)、[运行时视图](06-runtime-view.md#凭据与-cli-解析757)、[数据架构](08-data-architecture.md)、[接口规范](09-interface-specs.md)及追溯矩阵；测试入口表示可复验方法，运行结果以 PR 验收记录为准。


#770 A 来源身份独立写入与历史保留规则见[数据架构](08-data-architecture.md#finding-来源身份770-a)，对应 FR-FIND-002；关联建议仍为后续切片。

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
| CLI 与运行上下文 | [CLI adapters](../AGENT_CLI_RUNTIME_ADAPTERS.md)、[runtime context](../AGENT_RUNTIME_CONTEXT.md)、[profiles](../AGENT_RUNTIME_PROFILES.md) | §8.1–8.2 | 专题保留权威，03/05/09 引用 |
| 镜像与部署 | 07；[镜像目录契约](../RUNTIME_IMAGE_REGISTRY_CONTRACT.md)、[部署](../ONE_CLICK_DEPLOYMENT.md) | §8.3、§9 资源 | 已迁入概览，专题保留细则 |
| 资源阈值与性能 | 04；[config](../../apps/scheduler/src/config.ts) | §9.2、§12 | 已迁入；不沿用旧默认值清单 |
| 安全与隔离 | 10；[设备边界](../DEVICE_ACCESS.md)、[共享资产](../SHARED_ASSET_BLOB_STORE.md) | §9.1 | 概览已迁入，专题保留细则 |
| 项目 Memory / Skill | 01 中 FR-KNOW；05–10 相关视图；[项目知识专题](../PROJECT_KNOWLEDGE.md) | 本期新增 | #752 分支实现与验证范围分开记录；专题拥有工作流和字段细则 |
| 风险、路线与取舍 | 12、ADR；[长期提案](../AI_NATIVE_TRUSTED_KERNEL.md) | §10、§13–16 | 旧开工顺序与 MVP 结论只作历史 |
| 工程与发布 | 11；[发布硬门](../RELEASE_RUNTIME_IMAGES.md)、AGENTS 执行摘要 | §17.5 | 入口已迁入，发布专题与执行红线保持有效 |

[旧 ARCHITECTURE](../ARCHITECTURE.md) 本期保留，每个一级章节附迁移标记；不再作为新实现的独立事实入口。未被本目录覆盖的新问题应先回到源码核实，不从历史草图推导现行承诺。DESIGN、AGENTS/CLAUDE 保留高密度摘要，不替代本表的细则所有权。

## 3. 状态与编号

每篇文档前 12 行必须有 `> 状态：...` 与 `> 同步日期：YYYY-MM-DD`。同步日期是最近核对该文档事实的日期，不是措辞编辑日期。文档级 as-built 不代表所有关联测试在当前环境通过；具体未完成能力和验证缺口必须显式标注。

视图编号不重排；需求按 `FR-域-NNN`、`NFR-属性-NNN`、`IR-NNN`、`CON-NNN` 分类。功能域在 01 中定义，TASK 包含任务编排，独立证据与资产边界不能隐含混入 Finding。非功能属性为 SEC、REL、PERF、OBS、EVO、OPS；域按稳定责任分组，不按每个文件创建前缀。

需求以三级标题定义，格式为 `### ID`（可附中文标题）（例如查找 FR-JOB-001）；正文引用相同 ID 不算重复定义。每条记录规范要求、决策来源（含理由）、代码入口、实现状态和验证证据。ID 发布后不改作他义、不复用；本次保留 #744 首批编号的原有含义，新增需求使用未占用编号。废弃需求保留「实现状态：已废弃」及取代者，并登记到 `docs-freshness.test.ts` 的 `DEPRECATED_REQUIREMENT_IDS`；门禁要求登记条目持续保持废弃状态，不能重新激活或删除。历史引用不恢复旧运行时契约。

追溯矩阵使用五列表格：需求 ID、架构视图、ADR、代码入口、验收。首列是裸 ID，每个定义恰好一行；不适用 ADR 填 `—`，验收不能留空。无自动测试时写明确人工核查步骤及尚未执行状态。矩阵不复写需求正文。ADR 允许编号有空缺，禁止复用；回填日期与原决策日期分开。

配置默认值只证明护栏存在。质量目标、测量环境、测量方法和运行证据分别记录；未定义的 SLA 不编造数值。接口参数与默认值尽量引用机器契约，避免多处抄写。

## 4. 维护与验证

1. 功能、领域规则、API、schema、状态机、运行时、权限或废弃契约变化时，执行[开发文档同步 Skill](../../.agents/skills/architecture-doc-sync/SKILL.md)，在同一变更中更新受影响的需求、关系、视图和摘要。无文档影响可以不改，但必须说明核查范围和理由。
2. 新架构取舍或推翻旧决定才新建 ADR；已采纳正文保留历史，状态链接到替代决定。本次六条回填不新增决策。
3. `pnpm ci:unit:docs-freshness` 检查路径、脚本、已删机制、状态日期、需求定义与引用、矩阵覆盖、ADR/Skill 入口和 AGENTS/CLAUDE 同步。文件链接检查不验证标题锚点、网络 URL 可达性、代码符号或语义；人工核查这些内容。
4. `pnpm ci:unit:file-size` 检查门禁代码体量，新增测试继续走现有 docs-freshness 脚本及 CI；按变更面运行行为测试。不能用文档门禁代替越权、恢复、幂等的行为测试。
5. 发版前仍按 AGENTS 的发布文档保鲜硬门，逐项核对语义和发布证据；文档存在不等于镜像或 Release 成功。

## 5. 实施记录

#742 已交付索引骨架，#744 已交付首批三条链路规格与追溯。本次 #741 后续交付十二视图、追溯矩阵、六条 ADR、开发 Skill、逐章迁移标记和追溯/跨平台门禁。验证入口见 [11](11-engineering-specs.md)，本次执行结果以 PR 的验证记录为准。没有修改产品运行时行为、数据库基线或对外 API。

#770 C 特征投影的字段来源、恢复和未完成的 D 质量门见[专题](../PROJECT_FINDING_RESEARCH.md)；对应 FR-FIND-007。
