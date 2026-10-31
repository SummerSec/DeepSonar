# 用量额度的默认语义

> 状态：as-built；离线行为验收见对应 PR，不代表生产或真实模型效果验收。
> 同步日期：2026-10-31

用量预算默认不限，只有显式配置才限制。env 未设置或空白是未配置，0 是不限，正整数是有限额度；非法显式值拒绝启动，离线升级预检返回阻塞字段错误，不静默回落无限。已有数据库规则、Job 快照、回执与使用账本不迁移、不清零。新建数据库的 global_settings seed 同步采用无限 Hub/Verify 轮数；不修改表结构或 schema 版本，不覆盖已有库规则。

| 用量 | 默认 / 显式规则 | 实现入口 |
| --- | --- | --- |
| 普通模型请求数 | `DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` 默认 0；正数上限 1000000；沿 Job > role > project > platform > env 物化冻结，role/project 只能收紧平台上限 | `config.ts`、`runtime-knobs.ts`、`gateway.ts` |
| Job 总 token | 新 token 未设或 0 存 NULL 不限；正整数才限制；历史已存 0 保留原有零额度语义 | `gateway.ts` |
| 修正 token | `DEEPSONAR_REPAIR_MAX_TOKENS` 默认 0，正数上限 2000000；首次拒绝冻结 0 为无限，正数为有限；历史 null/缺失保持关闭 | `domains/event-ingestion/repair-token-budget.ts` |
| Hub 总轮数 | `DEEPSONAR_HUB_MAX_ROUNDS` 默认 0；支持 `unlimited`，正数上限 10000 | `config.ts` |
| Finding 验证轮数 | `maxVerificationRounds` 默认 0；显式 1–20 限制，非法值拒绝；无进展检测单独保留 | `core.ts`、`verify.ts` |
| 图查询累计调用/字节 | `DEEPSONAR_GRAPH_QUERY_MAX_CALLS` / `DEEPSONAR_GRAPH_QUERY_MAX_BYTES` 默认 0；返回剩余值 null 表示不限，继续记录使用量；已 blocked 的会话不解封 | `graph-query.ts` |
| LSP / CLI 能力调用 | 缺失或 0 不限，正数上限 10000；内置目录不再默认有限；LSP adapter 执行显式调用上限，CLI 字段目前为声明，不冒充已执行计数 | `language-server-adapter.mjs`、能力目录与共享 schema |
| 内置 Capability Pack token | 不填 `max_tokens`，保留显式声明能力；不是新增的消费计量器 | `domains/capability-pack/catalog.ts` |
| Plan 用量预算 | 可选字段，无默认额度；本次不宣称未接线字段已实现消费熔断 | `packages/shared-types/src/plan.ts` |

无限不是未知：修正 `limit_tokens=0` 且 `remaining_tokens=null` 表示无限，`usage_status` 继续区分 known/pending/unknown；pending 或未知外部效果仍须停止并对账。有限 token 上限是结算后的累计熔断，单次输入/缓存成本可能超额；保留实际账本，不承诺精确的调用前费用上界。

以下是独立安全或协议边界，保持有效：权限与项目 scope、租约/Attempt/取消/超时、并发与沙箱容量、单响应/帧/证据保存大小、事件窗口速率、防无进展与递归失控、基础设施有界重试。完成拒绝最多 8 次属于同 Session 防循环；Hub 单决策 Intent 数是扇出容量。Plan 单次补证门属于尚未开放多步执行的实现边界，不能用删除该门冒充多步能力已交付。它们均不代表业务目标已经完成。

Verify 基础设施失败另用已有 `maxAutoRetries`（默认 6）限制连续恢复：初次失败之后最多六次重试，第七次连续失败收口为 `inconclusive`，不再 force Hub。计数来自已完成的持久 round；任一次成功执行（包括业务 verdict 为 rework）重置连续失败段，不使用累计业务轮数。取消仍立即停止，不回写历史 round。

需求与追溯沿用配置优先级、Model Gateway、Graph Query、Verify、Capability 的既有需求，不新建并行配置体系。相关行为入口接入现有 dispatch-limits、executor-real、graph-references、capability-pack、verify 与 platform-api CI；详情以 PR 的已执行命令及结果为准。
