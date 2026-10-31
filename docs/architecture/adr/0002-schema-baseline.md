# 0002. PostgreSQL 只维护单一 schema 基线并通过重建演进

> 状态：**已采纳（历史回填）**。本文记录既有 schema 纪律，不新增迁移策略。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[Issue #34](https://github.com/SummerSec/DeepSonar/issues/34)；实现核验见 [`database/schema.sql`](../../../database/schema.sql)、[`migration-runner.ts`](../../../apps/scheduler/src/migration-runner.ts)

## 背景

DeepSonar 的状态机、权限和审计表之间有大量外键、唯一性、部分索引和触发器约束。增量迁移链会让不同部署持有不同中间结构，并增加回滚、空库启动和跨版本恢复的隐性分支。当前仓库把完整公共结构写在 [`database/schema.sql`](../../../database/schema.sql)，并由 [`schema-version.ts`](../../../apps/scheduler/src/schema-version.ts) 暴露当前主线版本。

## 决策

1. `database/schema.sql` 是唯一 schema 基线，`SCHEMA_VERSION` 必须与基线中 `schema_meta` 的版本一致。
2. 空库在 Scheduler 持有 reserved connection 和 advisory lock 时原子套用基线；非空库必须通过版本和表/列结构校验。
3. 版本或结构不匹配时 fail closed；不提供增量 ALTER 升级链。运维需先备份，再使用仓库的 rebuild 工具按列交集回填并校验序列。
4. 稳定状态、幂等键、外键、权限骨架和查询不变量进入定列；易变内容进入 JSONB；类型字段用字符串而非 PostgreSQL enum。
5. 修改表结构必须同时修改基线、递增版本、更新受影响代码/文档并运行适用的 rebuild 与迁移测试。

## 状态

当前状态为已采纳。本文件于 2026-10-15 回填，原始决策日期未核实。`migration-runner` 的当前实现没有迁移账本，也不会把旧版本自动升级到 [`schema-version.ts`](../../../apps/scheduler/src/schema-version.ts) 导出的当前主线版本；结构漂移会拒绝启动。若将来需要改变演进策略，应新开 ADR 记录取代关系。

## 后果

- 正面：空库、运行时和测试使用同一结构来源；结构漂移在启动时暴露，数据约束集中可审查。
- 代价：结构变更需要备份和重建，长时间在线迁移需要在外部运维流程中安排；不能依赖 Scheduler 静默修复旧库。
- 运维要求：`pnpm db:rebuild -- --plan` 只生成计划；只有完成备份和人工检查后才能 `pnpm db:rebuild -- --apply`。
- 验收：[`migration-runner.test.ts`](../../../apps/scheduler/src/migration-runner.test.ts) 覆盖基线版本、空库套用、版本不匹配、结构漂移、并发启动和错误基线；[`schema-rebuild.test.ts`](../../../apps/scheduler/src/schema-rebuild.test.ts) 与集成测试覆盖重建回填和序列处理。

## 替代方案

以下替代方案是本次回填的当前分析，不代表未经核实的历史讨论：

- 使用带序号的增量迁移文件：可减少一次重建，但增加中间结构和启动分支，难以保持本仓库的基线可重放性，因此不选。
- 启动时按表结构自动猜测并补列：会掩盖数据丢失和权限约束漂移，无法提供可审计的恢复边界，因此不选。
- 只比较版本数字而不比较表/列结构：版本文件可能被错误修改，不能发现手工漂移，因此不选。
