# 0022. 以持久来源审计驱动有界项目知识批次和隔离评测

> 状态：**已采纳**；共享工作树实现待最终 SHA Actions，未合并、未部署。
> 决策日期：2026-11-11
> 同步日期：2026-11-11
> 来源：用户本轮明确授权自动项目整理；[collector](../../../apps/scheduler/src/domains/project-knowledge/collector.ts)、[工作链](../../../apps/scheduler/src/domains/project-knowledge/work.ts)。
> 关联需求：FR-KNOW-001、FR-KNOW-002、NFR-UX-001。

## 背景

[0021](0021-knowledge-source-preview.md) 在 2026-11-09 收敛为成功来源元数据登记与历史只读预览，暂缓项目批处理、整链 token 预算和 schema 变化。本轮用户明确授权自动项目整理与积累/复用可见性。来源数、候选数、生效数和模型反馈属于不同证据层；自动整理仍需沿既有 Job/Attempt、权限、预算、CAS 与审计边界执行。

## 决策

1. 本决定仅取代 0021 的“项目批量整理暂缓”限制。保留原来源元数据登记和历史预览只读边界；旧 `knowledge:auto:` work 仍不自动推进，不恢复旧快照或重置预算。整链 token 预算和 schema 改动仍不在本轮范围。0021 正文保留为历史决定，当前取代关系在本条与 ADR 索引登记。
2. Dispatcher 的既有 tick 与 knowledge-wake 必须读取 durable 未处理来源审计；collector 每批最多 4 个来源 Job、合计 19 个来源输入（Fact、Evidence 及其授权资产），再可附加一个冻结 governor。collector 在项目已有非旧自动 pending/running work 时不得再准入批次；不将其宣称为全部显式请求的新唯一约束。
3. 来源正文/CAS 准备必须在短 SQL 事务外执行。项目行锁下复核项目、最新成功 Attempt、冻结权限、来源/hash、未结算效果、已处理记录和 governor，再同事务写入 work 与逐来源采集链接。source_registered 仅是元数据；source_collected 表示纳入整理，包含排队，不能表示激活。超大/失权/未知效果等永久拒绝必须留下 skipped error 审计并停止坏源热重试。逐来源链接持久保存 registration_id/work_ref/attempt_id/input_count/manifest_sha256，摘要绑定该来源的冻结 manifest，不在审计中复制正文。
4. 自动批次所有阶段及全部 trial 的创建期快照必须收紧已准入 stage 工具、关闭出网，清角色预加载 skills/modules/MCP/命令/子 Agent/指令与共享资产；trial 再清空普通知识目录，独立分配 case×arm 输入，只注入专用试验 Skill。不得扩大角色原 allowlist，不得改写旧 Job 快照。
5. 非 reuse 的行为评测必须覆盖六类 case×两个 arm 的全部 12 次独立试验；创建时为 evaluator/reviewer 预留 2 个 Job，仍受累计 32 Jobs/1800 秒/2 次候选修订约束。每例 task_inputs 必须显式选择同一冻结任务材料，不自动复制全部来源或把原结论、候选正文、治理方法当共同答案；rubric 只给 evaluator/reviewer。引用可读性由代码验证，语义可比性与答案泄漏由审查核对，不能冒充模型质量已验证。
6. 真实试验发布必须取得资产版本/hash 回执并绑定 Evidence、Job/最新成功 Attempt 和 case×arm。candidate target 及全部安全组必须 pass；target comparator 的 fail 允许作为对照观察，retire 的目标 arm 为 without。unexecuted、缺项、重复、缺证或未知效果不得激活。治理 hash 改变时旧 work 阻断，历史结果/快照和预算不迁移。
7. activity 只作严格项目范围的只读投影。来源登记、采集/跳过、候选、生效、拉取和模型反馈分别计数；usage 的消费项目和 owner_project_id 都必须是当前项目。反馈 success 只陈述模型报告，保留 provenance，不宣称真实收益、成功率或质量认证。

实现字段和完整流程以[项目知识专题](../../PROJECT_KNOWLEDGE.md)、[快照隔离](../../../apps/scheduler/src/domains/project-knowledge/job-isolation.ts)、[评测](../../../apps/scheduler/src/domains/project-knowledge/evaluation.ts)、[结算](../../../apps/scheduler/src/domains/project-knowledge/settlement.ts)与 [activity](../../../apps/scheduler/src/domains/project-knowledge/activity.ts)为事实入口。

## 状态

2026-11-11：用户明确扩大到自动项目批量整理，采纳本决定；0021 关于批处理暂缓的限制在该范围内被取代。当前共享工作树包含 collector、隔离试验、真实版本回执与只读可见性实现，测试入口已接线但本轮 Actions 尚未运行。未执行真实模型验证、合并或部署，质量收益保持 unknown/not_evaluated。

## 后果

单条准备故障不得永久消费同批正常来源。瞬态准备失败使用既有审计记录代次/下次时间，30 秒退避、最多 3 次，再明确跳过；仍由同一 knowledge-wake 驱动。trial 必须保留可信 Control Skill，共存组取得同一中性平台 Memory，清除业务配置/扩展并重冻连接配置及启动配置。反馈/修订输入须包含精确目标和上一轮诊断，避免新 Job 在失去旧会话后盲目重试。

- 减少逐 Job 人工整理与状态猜测；紧凑汇总、阻塞链接和按需展开复用现有知识页刷新，不新增通知、设置或轮询。具体注意力成本见[专题表格](../../PROJECT_KNOWLEDGE.md#注意力成本)，尚无收益实测。
- 自动执行消耗既有预算；独立矩阵有真实 Job 成本。坏源停止自动重试，可能需要原来源问题修复和后续明确处理，不能暗中放宽权限或重建旧批次。
- 无新 schema 或经验账本；现有审计、manifest、assignment、receipt 和 usage 承担来源与使用追溯。`assignment.source_mode`标识项目批次，评分输入以`evaluation:proposal:<id>`绑定revision/input_digest/plan及reviewer的behavior，audience排除trial。
- 验收入口为 Actions 中的 `pnpm ci:unit:project-knowledge`、`pnpm ci:integration:project-knowledge`、`pnpm ci:unit:web-facts`、路由/权限与文档门禁。[behavior-policy 单测](../../../apps/scheduler/src/domains/project-knowledge/behavior-policy.test.ts)独立保护允许对照失败与candidate/安全失败、unexecuted/重复缺项拒绝的边界。collector/activity/闭环与隔离回归为合成或替身工程证据，不能替代独立真实模型收益研究。本轮未运行任何测试、构建或 typecheck。

## 替代方案

以下是本次决策的替代分析，不追认为历史讨论记录：

- 继续只登记来源：保留了低执行成本，但无法满足本轮明确授权的自动整理目标。
- 每个成功来源立即创建一条模型链：增加并行与重复整理成本，不符合本轮合批和预算边界。
- 无知识组的 target 也必须 pass 才能激活：无法观察候选帮助解决基线失败任务的差异；改为允许 comparator target fail，所有安全组和目标 arm 仍必须通过。
- 给 trial 全量来源、完整治理 Skill 和评分答案：削弱隔离与可比性；使用显式共同材料、分 arm 内容与独立 rubric。
- 新建来源/经验表或历史执行 API：现有审计和工作链足以承载本轮需求，额外 schema 与执行通道不在范围。
