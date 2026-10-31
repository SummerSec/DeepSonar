# 项目 Finding 特征与关系研究（#770 C）

> 状态：**C 实现与 D 检索/持久候选基础已随 #811 合入；强关系质量门未通过，不发布同问题建议**。
> 收口（2026-10-31）：**#770 按已交付切片关闭**，强关系（同问题 / 同根因不同实例）拆出 [#819](https://github.com/SummerSec/DeepSonar/issues/819) 独立跟踪并登记为暂缓设计。强关系未交付包含实现缺口——`compareFindingFeatures` 没有强关系输出分支，身份字段全部匹配时仍返回 `similar` / `lexical_overlap_only`。生产执行按 AGENTS.md「验收边界」豁免，但不覆盖本文「强关系验收最小外部输入」与各未验证项。
> 同步日期：2026-10-30

本切片依赖 #770 A 的独立 Job 来源身份，独立于 B 的项目查询增强。原 Finding、Artifact、Verify、人工处置和任务内 Research 都不由本投影改写。没有项目 Canvas、项目 Hub、模型调用、Job 跨任务接口或自动处置。

## 真实字段来源与质量门

| 特征 | 已核对来源 | v1 处理 |
| --- | --- | --- |
| Finding / Job / Canvas / Artifact 与修订 | `findings`、同项目 `jobs`/`canvases`、同 Job Artifact `revision` | 可追溯来源身份；不是问题身份 |
| profile / category / location | `FindingPayload` 与 Finding 投影 | 原始声明，保留 provenance，不升级成证据支持 |
| title / summary / location 文本 | Finding 字段 | Unicode NFKC 小写及词法线索；保留中文、路由和参数差异，不生成权威路由模板 |
| Evidence | `artifact_evidence` 的 ID、顺序、元信息及内容摘要 | 参与来源失效检测；不复制正文、URI 或证据引用到公开计算状态，不视为根因证明 |
| 资产 / 服务 / 环境 / 租户 / 权限边界 / 目标版本 / 参数 / 根因 | 当前协议无权威映射 | 一律 `null`，未知相等不表示相同 |

核查入口：`packages/shared-types/src/index.ts` 的 `FindingPayload`、`database/schema.sql` 的 Artifact/Evidence、`domains/role-runtime-snapshot/application.ts`、`core.ts` 与 `task-intent.integration.test.ts`。任务 `target` 是自由内容且执行中可编辑；冻结运行时配置描述 Provider、镜像和能力，不证明被测目标的历史 commit/部署环境。共享文件 ID、当前仓库 HEAD、文本标题都不能代替目标身份。

2026-10-30 复核 main `0841f827`：#767 新增冻结 `task_contract`，其中 targets 与 identity（tenant/role/resource）仍是用户声明；`task-contract-preflight.ts` 明确尚无可信应用身份探针。此切片不改任务契约，也不将这些声明提升为关联的权威身份。

以上为源码可获得性审查，不是用户历史数据抽样。合成夹具的权威身份覆盖率为 0，仅证明未知处理行为。未取得脱敏人工标注集、按问题家族/资产隔离的调参/留出集或预先确定的质量阈值，因此**不报告 recall@K、precision/recall、真实字段覆盖率或节省模型成本**。

## 持久投影与恢复

`project_finding_feature_scan` 保留项目注册扫描游标，每次最多 25 个项目；`project_finding_feature_work` 按项目持久保存 generation、活动代、Finding UUID 游标、状态、重试与到期时间；`project_finding_features` 保存输入摘要、提取器版本、provenance 和可重建特征。扫描使用 `(project_id,id)` 索引 seek，每批最多 20 条；Evidence 最多读取 129 条元数据，超过 128 条时明确失败，不默默发布截断来源。单 SQL 超时 3 秒，失败在 savepoint 外记账，最多 3 次、间隔 30 秒，之后停在 failed。

Scheduler 现有维护 gate 注册/停止 worker；事务持有维护行共享锁并校验 runtime 身份。没有进程内通知依赖或外部效果。批次与检查点原子提交，进程中断回滚后从持久游标重试；running 是事务内状态，对外通常看到 pending，不能推断模型正在工作。相同输入摘要不重复写特征、不刷新 processed_at。完整扫描成功后原子切换活动 generation，并在 30 秒后开始下一轮有界扫描以补偿漏通知。内部 `requestFeatureRebuild` 创建新代、清零失败预算，不暴露新的用户写 API；运维命令 `pnpm finding-features:rebuild -- --project-id <UUID>` 必须提供显式 DATABASE_URL，并复查维护身份、schema 和项目。规则版本变更也创建新代，回滚版本不直接复活旧代。旧提取器的 failed 工作由每次最多 25 项目的持久注册扫描恢复，不在执行队列选择条件中加入跨版本 OR；执行队列只读非 failed 的到期工作，以匹配既有部分索引。当前版本 failed 工作不会被该扫描重置为无限重试；大量项目下版本恢复可能需要走完一轮注册游标。

来源读前后计算摘要，保存前重查；读取时再次核对当前 Finding、Artifact、Evidence 和提取器版本。源变更/Artifact Evidence 元数据删除立即呈 stale；Finding 删除级联移除投影。旧 worker 与重建通过项目 work 行锁串行化，不能覆盖新 generation。旧代投影保留作派生历史，当前读只认活动代且必须匹配当前来源；运维可加 `--prune-inactive` 显式清理非活动、非构建代，每次最多 500 行，由类型要求调用方提供事务，持续持有 work 行锁直到删除完成，防并发切换。没有自动无限保留承诺；达到 500 行时可再次执行清理。

`GET /findings/:id` 增加 `project_research_features` 元数据：pending/succeeded/failed/stale、重建中、提取器版本、处理时间、有限错误代码、声明字段覆盖、权威身份不足与 `quality_gate_not_evaluated`。沿用当前 `findings:read` 和项目范围，撤权由每次请求的现有鉴权立即拒绝；不返回证据正文或跨任务标题/计数。这只证明 Finding 与 Artifact Evidence 元数据的新鲜度；任意 evidence_refs 指向的冷文件字节、共享资产撤权或外部 URI 有效性尚未接入权威解析。它们不能作为当前关联证据，D 上线仍需单独完成该有效性边界。普通 Job 的 Control/graph scope 未改变。异步特征状态尚未添加 Web 面板；下述词法检索为独立的当前来源读取。

## D 的可验证范围与停止条件

`model.ts` 的候选排序限制最多扫描 1000 个**调用方已提供的候选**、返回 K≤50，并显式报告截断。这是离线词法排序函数，不是 PostgreSQL 召回实现，不能据此声称数据库候选扫描或召回率已验证。不兼容的提取器或规范化版本不参与排序，返回版本排除计数；逐对比较降为信息不足，不把旧版特征解释为冲突或相似。逐对策略支持“仅相似/明确冲突/信息不足”；强同问题/同根因类别保留但 v1 永不输出。不同版本仍需根因延续证据；A≈B、B≈C 不生成 A=C 或连通分组。

D 的弱候选账本已接线，权威分区召回、强关系和人工纠正尚未接线。强关系继续前需要权威目标/版本/根因来源映射、独立标注样本、预定阈值与留出评估；不把“未自动合并”作为质量指标。下述当前声明文本检索与持久弱候选切片，不等待这些输入，也不冒充完整 D。

## 验证入口

- `pnpm ci:unit:finding-research`：合成行为夹具，覆盖中文、未知、冲突、版本、传递性反例和预算；不是人工标注数据。
- `pnpm ci:integration:finding-research`：显式 `TEST_DATABASE_URL`，覆盖持久检查点/并发、维护停止、重建切换、重试预算、来源与 Evidence 失效、权限与撤权。
- `pnpm ci:probe:project-finding-queue`：显式 `TEST_DATABASE_URL`，在独立库测 1k/10k/100k 项目的混合失败队列，比较旧/新执行选择与 25 项目注册扫描；不测候选关联质量。
- `pnpm ci:probe:project-finding-features`：显式 `TEST_DATABASE_URL`，自行创建/删除隔离库，对 1k/10k/100k 合成 Finding 的 20 条批次采样并输出 EXPLAIN、索引大小、运行环境。该探针不测真实关系质量或线上 SLA。
- schema64 遵守基线 + rebuild。[真实 v63 回归](../apps/scheduler/src/schema-rebuild-feature-fixture.ts) 从固定提交 `0841f8272ab1c9c64fdfeddba7aff53f2d5c856d` 读取完整 schema63，要求完整 Git 历史（CI fetch-depth: 0），不回退到当前 schema。升级前断言三张 feature 表及相关索引不存在；真实备份恢复和重建保留原 Finding UUID、来源摘要、Verify/disposition、节点/证据/事件；升级后验证扫描种子与派生删除后重建。它与 A 的 v62 Finding 形状夹具分别验证，不能互相替代。


## 本次合成规模探针（2026-10-29）

PostgreSQL 16 Alpine、本地容器、Node 24.19.0/x64；环境报告 Intel Xeon Platinum 8573C、5 个逻辑 CPU。1k/10k/100k 三个独立项目顺序写入同一临时库，三分之一 summary 缺失，无权威目标身份、无 Evidence。每规模 10 个 20 行批次，p50/p95 为 nearest-rank（n=10 的 p95 即最大值），包含提取/读写、不含两秒轮询等待；缓存与本机资源结果不能外推线上 SLA。源码 seek EXPLAIN 位于该项目接近末尾的游标。

| 项目 Finding 数 | 批次 p50 / p95 ms | seek 实际返回/过滤行 | 累计 scan 索引 bytes |
| --- | --- | --- | --- |
| 1,000 | 35.60 / 67.75 | 20 / 0 | 81,920 |
| 10,000 | 22.83 / 30.31 | 20 / 0 | 745,472 |
| 100,000 | 22.80 / 30.91 | 20 / 0 | 6,979,584 |

三个计划均为 findings_project_scan_idx 的 Index Only Scan。索引大小是累积库中所有规模的总值，不是单项目值。实际 worker 每两秒最多处理一个 20 行批次，单个 100k 项目完成一遍至少约 2.8 小时，另有查询/重试/多项目竞争；这不是候选召回或线上吞吐验收。完整原始结果见[探针证据](evidence/770-feature-probe.json)。


## 多项目工作队列探针（2026-10-30）

PostgreSQL16.15、本地容器、Node24.19.0/x64、Xeon8573C/5逻辑CPU。累计构造1k/10k/100k项目，1% pending、94%当前版本failed、5%旧版本failed，失败行比pending更早到期。每规模各一次 EXPLAIN ANALYZE BUFFERS，未禁用顺序扫描；这是计划反例与修复验证，不是p50/p95或线上吞吐承诺。

| 项目数 | 旧查询顺序扫描返回/过滤 | 新查询索引返回/过滤 | 旧/新执行ms | 新查询总 shared hit blocks |
| --- | --- | --- | --- | --- |
| 1,000 | 60 / 940 | 1 / 0 | 0.206 / 0.055 | 3 |
| 10,000 | 600 / 9,400 | 1 / 0 | 1.851 / 0.061 | 13 |
| 100,000 | 6,000 / 94,000 | 1 / 0 | 17.418 / 0.072 | 104 |

旧查询均 Seq Scan + Sort；新查询均使用 project_finding_feature_work_due，无 Sort。索引访问仍有MVCC/缓冲页成本，不能由返回1行声称物理扫描绝对恒定；锁争用和长期表膨胀尚未压测，生产选择保留3秒单SQL超时。队列索引大小分别16,384/16,384/65,536 bytes。

每次真实注册扫描返回25，窗口外恢复0，保留当前版本工作状态和重试预算，持久游标正确；窗口内分别恢复1/1/2个旧版本failed。late注册查询在1k规模使用projects_pkey Bitmap扫描49行后排序返回25，在10k/100k使用Index Only Scan返回25，不能把返回预算误写成所有计划只访问25行。原始分布、缓冲页、执行统计及计划见[工作队列探针](evidence/770-work-queue-probe.json)。

## 当前声明文本检索（#770 D 检索首片）

Finding 详情可主动请求 `GET /findings/:id/lexical-search`，在原详情中显示跨 Job 文本候选、匹配字段和来源 Finding/任务链接。只对真实声明文本计算词法相似，不确认资产、版本、环境、根因或证据有效性。不会保存关系边、生成组、传播 Verify/disposition 或自动触发任何 Job；现有异步特征 work 不承担这条同步检索。它不是 pg_trgm 全项目 top-K，也不是质量门已通过的关系建议。

查询先以 `(project_id,id)` seek 取得128条 Finding ID和1条lookahead，以 MATERIALIZED 窗口固定范围；再以 `LATERAL LIMIT 1 OFFSET 0` 按主键取得声明字段并核对同项目 Job/Canvas 来源链，避免普通 JOIN 展平为全表扫描、排除主体和同 Job、按 Unicode 词法线索返回最多25项。不会先排除无效/同 Job 再无限扫描补齐；全窗口无候选也能继续游标。每次仅排名本窗口，`rank_truncated` 明确窗口内25项截断，`next_cursor` 只前进来源窗口，未召回不等于明确不同。窗口内被截断的低排名项不是下一窗口；完整定位仍使用 B 的项目文本查询。128/25是工程预算，不是由人工标签选出的质量最优参数。

请求使用只读 repeatable-read 事务，每条SQL超时3秒；超时返回503 `SEARCH_BUDGET_EXCEEDED`，不返回部分候选。该超时不是整请求SLA；返回当前快照时刻和版本。只读取受限长度的 Finding title/location/summary/profile/category 等声明字段，全文、Evidence、raw_json和共享资产不进入候选响应。`lexical_digest` 是本次声明文本输入摘要，不等于 C 包含 Artifact/Evidence 的完整源摘要或证据完整性证明。cursor绑定项目、主体、主体摘要与规则版本；主体改变后返回409 `CURSOR_GAP`，客户端清除结果并提示从首窗口重查。候选自身改变会在下一请求按当前声明计算；这里没有持久关系新鲜度承诺。

| 读取内容 | 现有授权与限制 |
| --- | --- |
| 主体/候选声明、数量、匹配字段、UUID | 每次经过管理 Actor 的 `findings:read` 与项目限制；同项目完整来源链才参与排名，无新增任务级 ACL 假设 |
| 来源 Finding 跳转 | 原 Finding详情路由再次鉴权，不继承本次结果的授权快照 |
| 原任务链接 | 只含现有源ID；目标任务路由仍需原有 `tasks:read`，链接不授予读取权限 |
| Evidence / 共享资产 | 不读取、不复制，也不以摘要或匹配理由暴露；原入口分别复查其原有scope与授权 |
| 普通 Job | 不提供 Control operation，不扩展当前 Job/Canvas graph scope；Job capability不成为管理token |

Web只在主动检索后展示窗口；切主体、刷新、翻窗口和失败会清除旧结果，迟到请求不覆盖新主体。401/403不保留旧标题；409要求重新检索。来源跳转沿用现有URL中的finding选择，页面刷新会重新授权读取，不恢复缓存敏感结果。

强关系验收最小外部输入仍是：可证明的历史资产/租户/环境/版本映射与来源修订；脱敏、独立人工标注且按问题家族/资产分离的调参/留出样本；在查看留出结果前约定的质量阈值。已独立实现有界查询工程、读取状态、可重建候选账本及失效测试；不能用程序生成标签冒充独立真值。


## 词法检索规模探针（2026-10-30）

命令 `pnpm ci:probe:project-finding-lexical` 需要显式 `TEST_DATABASE_URL`，自动创建/删除独立临时库。PostgreSQL16.15、本地容器、Node24.19.0/x64、Xeon8573C/5逻辑CPU；1k/10k/100k来源项目累计写入同库，每条候选使用独立 Job/Canvas，另20%属于主体Job。中文/英文固定声明文本、无权威身份，没有人工标签。首窗口预热一次，每个首/末尾窗口各20次完整函数调用；p50/p95为nearest-rank第10/19项，包含事务、来源摘要和128窗口词法排名，但不含HTTP鉴权与传输。非冷缓存、非并发或线上SLA。

| 项目来源数 | 首窗口p50/p95 ms | 末尾窗口p50/p95 ms | 累计seek索引bytes |
| --- | --- | --- | --- |
| 1,000 | 9.138 / 13.115 | 8.157 / 8.641 | 90,112 |
| 10,000 | 7.814 / 9.843 | 7.838 / 10.375 | 925,696 |
| 100,000 | 10.151 / 17.153 | 10.383 / 14.482 | 9,216,000 |

六个完整查询计划均使用 `findings_project_scan_idx` Index Only Scan 返回129，声明读取主键查询129次，Job/Canvas在Memoize后95–111次索引查询，无Seq Scan，输出排序仅129行。总shared hit blocks依次1057/1039/1021/1033/1281/1370，read均0；不是只看CTE的LIMIT。早期普通JOIN和宽行CTE在1k下出现Seq Scan，最终采用ID窗口及禁止展平的有界主键查询。实际物理页数仍受MVCC、缓存、锁与分布影响，不能由行预算声称恒定资源。

Node整段探针（含建库/数据填充）的maxRSS为153,532KiB，用户/系统CPU约1.320/0.144秒；这是客户端资源，不是PostgreSQL峰值，数据库资源/冷缓存/并发压力尚未测量。完整样本、实际运行SQL的EXPLAIN、buffers和环境记录见[原始证据](evidence/770-lexical-search-probe.json)。此同步检索不新增后台积压；C worker既有吞吐限制仍适用。没有候选recall@K或关系precision/recall结论。


## 持久词法候选与代际失效（#770 D 后续切片）

schema65 新增 candidate_scan/work/sources/edges 四张派生表。注册扫描每次最多25项目，项目 work 行锁串行化 worker、重建和清理；每批最多5个来源，每个来源只排名项目最前128条来源窗口，最多选择25个跨 Job 候选。它没有权威分区，UUID 前窗口偏置明确存在，不是全项目 top-K；每批来源扫描检查点原子提交，完整项目扫描完成才切换活动代，30秒后可以开始下一代。双端 UUID canonical 排序及项目/代/双端主键消除反向重复，双端完整来源摘要、声明摘要和规则版本保留计算依据。只持久化 `similar` / `insufficient_information`，不输出同问题、同根因、传递分组或自动处置。

候选使用现有 Finding 与同项目 Job/Canvas 链、Artifact/Evidence 元数据来源协议。保存前对端点加共享锁并重查摘要；旧 worker 不能越过 work 行锁覆盖新代。每条 SQL 超时3秒，失败最多3次、间隔30秒；相同规则的失败预算不会自动重置。维护 gate 停止时批次回滚；版本更新由有界项目注册扫描恢复。Evidence 元数据超过128条明确失败，不能将截断来源当作完整来源。完整声明及内部输入摘要仍读取原文，行数限制和传输裁剪不是严格字节资源上限，也不是整批执行时限。

`GET /findings/:id/candidates` 及详情中的“已计算候选”沿用 `findings:read` 与项目授权。只读一致快照中重新核对双端当前来源、规则和来源链；来源或 Evidence 元数据变化立即隐藏旧候选，删除 Finding 级联删除派生记录。读端以双向端点索引各取26条，再合并最多26条；最多检查25条边，不因失效记录补扫。游标绑定主体完整输入、活动代、规则，变化返回409；读端只公开声明摘要，不公开内部 Evidence 摘要或证据引用。翻页可能得到空窗口但仍有下一页。主体自身计算状态和对端发现的有效边分别表达，stale 不代表所有 incoming 候选无效；成功零项与未计算、失败明确区分。Web 每次失败、撤权或切主体清空旧结果，来源跳转重新走原接口授权。

来源进度的128/25只描述主体自己的候选窗口；反向端点也可能发现该主体，故可见关系总量可以超过25。未召回不等于明确不同。冷文件字节、共享资产与外部 URI 的权威有效性未接入，此账本只使用声明文本作为匹配理由，不升级为证据支持。

运维 `pnpm finding-candidates:rebuild -- --project-id <UUID>` 要求显式 DATABASE_URL、当前 schema 与维护身份。`--prune-inactive` 在同一 work 锁下保留活动代/构建代，每次合计删除最多500条边及来源进度；旧代保留需运维按需重复清理，目前没有自动保留期策略。新代完整扫描期间继续返回旧活动代中仍有效的边。单100k项目以每批5条、每轮至少2秒等待计算，仅等待下界约11.1小时，另有特征批次、候选计算、多项目竞争和重试；不承诺低延迟全项目重算。

验证入口：`pnpm ci:integration:finding-research` 包含真实 PostgreSQL 并发锁竞争、停止/回滚、三次重试、来源与证据失效、游标、撤权、CLI 与处置不变；`pnpm ci:unit:finding-candidates-web` 使用真实 React/DOM 验证状态、分页、失败清空和迟到请求。[真实 v64→65 夹具](../apps/scheduler/src/schema-rebuild-candidate-fixture.ts) 从固定提交 `6a8ab4ad777df0c727b82b34834f43c99fbd7843` 获取没有候选表的完整旧 baseline，执行备份/严格恢复与重建，保留来源和 C 特征，再删除派生候选验证新代可重建。它不替代已有真实 v63 和 A 的 v62 回归。

## 持久候选工程探针（2026-10-30）

`pnpm ci:probe:project-finding-candidates` 使用隔离 PostgreSQL16.15、Node24.19.0/x64、本地合成数据。每个1k/10k/100k项目只预热一次并采样20个真实5来源提交批次，实际每规模105来源/2000条边；没有跑完100k项目全扫描。批次p50/p95 ms分别375.368/444.037、339.752/533.538、385.415/430.169；实测13.397/13.263/13.099来源每秒不包含2秒 tick 等待或HTTP，不能当作线上持续吞吐。36来源项目实际完整计算后读取20次，p50/p95为22.051/26.556ms。

来源首/末尾查询使用 Index Only Scan 返回5条；双端均有真实边的中间端点分页计划使用两个索引 Merge Append 返回26条，无全表扫描或排序，下一页也返回26条。完整 SQL 计划、buffers、索引大小与方法见[原始探针](evidence/770-candidate-probe.json)。这里只验证工程行为，没有独立人工标签，不报告召回率或强关系质量；权威历史身份映射、独立标注/留出集及预先约定阈值仍是完整强关系验收缺口。


## 非模型验收工具

标注导入、留出隔离、离线报告口径与待审阅阈值建议见[离线评估专题](PROJECT_FINDING_EVALUATION.md)。工具与合成夹具不代替独立人工标签，不宣称质量门通过。
