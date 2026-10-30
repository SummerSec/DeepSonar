# 项目 Finding 特征与关系研究（#770 C）

> 状态：**C 实现待评审；D 仅合成行为验证，质量门未通过，不发布关系建议**。
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

Scheduler 现有维护 gate 注册/停止 worker；事务持有维护行共享锁并校验 runtime 身份。没有进程内通知依赖或外部效果。批次与检查点原子提交，进程中断回滚后从持久游标重试；running 是事务内状态，对外通常看到 pending，不能推断模型正在工作。相同输入摘要不重复写特征、不刷新 processed_at。完整扫描成功后原子切换活动 generation，并在 30 秒后开始下一轮有界扫描以补偿漏通知。内部 `requestFeatureRebuild` 创建新代、清零失败预算，不暴露新的用户写 API；运维命令 `pnpm finding-features:rebuild -- --project-id <UUID>` 必须提供显式 DATABASE_URL，并复查维护身份、schema 和项目。规则版本变更也创建新代，回滚版本不直接复活旧代。

来源读前后计算摘要，保存前重查；读取时再次核对当前 Finding、Artifact、Evidence 和提取器版本。源变更/Artifact Evidence 元数据删除立即呈 stale；Finding 删除级联移除投影。旧 worker 与重建通过项目 work 行锁串行化，不能覆盖新 generation。旧代投影保留作派生历史，当前读只认活动代且必须匹配当前来源；运维可加 `--prune-inactive` 显式清理非活动、非构建代，每次最多 500 行，由类型要求调用方提供事务，持续持有 work 行锁直到删除完成，防并发切换。没有自动无限保留承诺；达到 500 行时可再次执行清理。

`GET /findings/:id` 增加 `project_research_features` 元数据：pending/succeeded/failed/stale、重建中、提取器版本、处理时间、有限错误代码、声明字段覆盖、权威身份不足与 `quality_gate_not_evaluated`。沿用当前 `findings:read` 和项目范围，撤权由每次请求的现有鉴权立即拒绝；不返回证据正文或跨任务标题/计数。这只证明 Finding 与 Artifact Evidence 元数据的新鲜度；任意 evidence_refs 指向的冷文件字节、共享资产撤权或外部 URI 有效性尚未接入权威解析。它们不能作为当前关联证据，D 上线仍需单独完成该有效性边界。普通 Job 的 Control/graph scope 未改变。此切片尚未添加 Web 特征状态面板。

## D 的可验证范围与停止条件

`model.ts` 的候选排序限制最多扫描 1000 个**调用方已提供的候选**、返回 K≤50，并显式报告截断。这是离线词法排序函数，不是 PostgreSQL 召回实现，不能据此声称数据库候选扫描或召回率已验证。不兼容的提取器或规范化版本不参与排序，返回版本排除计数；逐对比较降为信息不足，不把旧版特征解释为冲突或相似。逐对策略支持“仅相似/明确冲突/信息不足”；强同问题/同根因类别保留但 v1 永不输出。不同版本仍需根因延续证据；A≈B、B≈C 不生成 A=C 或连通分组。

D 的持久关系边、数据库召回、前端关系展示和人工纠正尚未接线。继续前需要权威目标/版本/根因来源映射、可审查样本、阈值以及实际候选查询计划/性能；当前只交付检索和 C 特征基础，不把“未自动合并”作为质量指标。

## 验证入口

- `pnpm ci:unit:finding-research`：合成行为夹具，覆盖中文、未知、冲突、版本、传递性反例和预算；不是人工标注数据。
- `pnpm ci:integration:finding-research`：显式 `TEST_DATABASE_URL`，覆盖持久检查点/并发、维护停止、重建切换、重试预算、来源与 Evidence 失效、权限与撤权。
- `pnpm ci:probe:project-finding-features`：显式 `TEST_DATABASE_URL`，自行创建/删除隔离库，对 1k/10k/100k 合成 Finding 的 20 条批次采样并输出 EXPLAIN、索引大小、运行环境。该探针不测真实关系质量或线上 SLA。
- schema64 遵守基线 + rebuild；验证 v63→64 备份、回填及恢复，保留原 Finding UUID、来源摘要和 Verify/disposition。


## 本次合成规模探针（2026-10-29）

PostgreSQL 16 Alpine、本地容器、Node 24.19.0/x64；环境报告 Intel Xeon Platinum 8573C、5 个逻辑 CPU。1k/10k/100k 三个独立项目顺序写入同一临时库，三分之一 summary 缺失，无权威目标身份、无 Evidence。每规模 10 个 20 行批次，p50/p95 为 nearest-rank（n=10 的 p95 即最大值），包含提取/读写、不含两秒轮询等待；缓存与本机资源结果不能外推线上 SLA。源码 seek EXPLAIN 位于该项目接近末尾的游标。

| 项目 Finding 数 | 批次 p50 / p95 ms | seek 实际返回/过滤行 | 累计 scan 索引 bytes |
| --- | --- | --- | --- |
| 1,000 | 35.60 / 67.75 | 20 / 0 | 81,920 |
| 10,000 | 22.83 / 30.31 | 20 / 0 | 745,472 |
| 100,000 | 22.80 / 30.91 | 20 / 0 | 6,979,584 |

三个计划均为 findings_project_scan_idx 的 Index Only Scan。索引大小是累积库中所有规模的总值，不是单项目值。实际 worker 每两秒最多处理一个 20 行批次，单个 100k 项目完成一遍至少约 2.8 小时，另有查询/重试/多项目竞争；这不是候选召回或线上吞吐验收。完整原始结果见[探针证据](evidence/770-feature-probe.json)。
