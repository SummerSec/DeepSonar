# 架构决策记录（ADR）

> 状态：**as-built（#741 PR 5 历史回填）**。首批六条 ADR 只回填已有定案，不新增决策；历史原决策日期未在本次工作中核实，正文注明回填日期。
> 同步日期：2026-10-15

ADR 记录**已定案**的架构决策及其理由，让「为什么这样建」不再只留在 issue 讨论和索引表格里。目录总览与维护流程见 [`../README.md`](../README.md)。事实仍以 [`docs/architecture/README.md`](../README.md)、相关架构视图、代码、schema、OpenAPI 和测试为准；`DESIGN.md` 与 [`docs/README.md`](../../README.md) 提供摘要和专题状态。

---

## 1. 何时需要 ADR

满足任一条即应新增 ADR（与改动在同一 PR 中）：

- 改变内核与插件 / Agent 的职责边界，或改变信任边界与跨边界校验点；
- 改变数据真相分层、schema 纪律、状态机或接口契约的基本形态；
- 刻意拒绝一个看似合理的方案（例如增量迁移链、兼容层），且该拒绝需要长期生效；
- 推翻或收窄既有 ADR。

纯实现细节、可在单个模块内逆转的选择、以及仍在讨论中的方案不写 ADR；讨论中的方案留在 issue。

---

## 2. 编号与文件名

- 文件名：`NNNN-kebab-case-title.md`，`NNNN` 为四位数字，从 `0001` 起全局递增。
- **编号不复用、不重排**；被取代或废弃的 ADR 保留原文件，只更新「状态」。
- 标题用一句话陈述决策本身（例如「schema 单一基线 + 重建，不做增量 ALTER 链」），而不是问题。
- 新增 ADR 时同步更新本文件 §4 索引；落地对应需求后在 `traceability.md` 中引用 ADR 编号。

---

## 3. 状态

| 状态 | 含义 |
|------|------|
| **提议** | 已起草，待评审；不得作为实现依据 |
| **已采纳** | 现行决策；实现与文档必须遵守 |
| **已废弃** | 不再适用，且没有替代决策；正文保留，写明废弃原因与日期 |
| **被 NNNN 取代** | 由更新的 ADR 替代；正文保留，链接到取代者，取代者反向链接本条 |

已采纳的 ADR 正文视为不可变记录：后续只允许更新「状态」、补充链接或修正笔误；决策内容变化必须新开一条 ADR 取代旧条目。

**回填纪律**：回填历史决策时只记录已定案的结论及其来源（issue / PR / 代码），不借回填新增或修改决策。

---

## 4. 索引

| 编号 | 决策 | 状态 | 来源 |
|------|------|------|------|
| [0001](0001-no-backward-compatibility.md) | 不向后兼容，废弃契约 fail closed | 已采纳（历史回填） | [`DESIGN.md`](../../../DESIGN.md) / #690 |
| [0002](0002-schema-baseline.md) | schema 单一基线 + 重建，不做增量 ALTER 链 | 已采纳（历史回填） | #34 / [`database/schema.sql`](../../../database/schema.sql) |
| [0003](0003-api-only-control.md) | 语义控制写入只走 Job-scoped Control API | 已采纳（历史回填） | #100 / #135 / #145 / #152 |
| [0004](0004-fact-and-finding-verification.md) | Fact 证据信任态与 Finding Verify 分责 | 已采纳（历史回填） | #387 / [`verify.ts`](../../../apps/scheduler/src/verify.ts) |
| [0005](0005-event-evidence-stream.md) | events / evidence / stream-bus 三职责，bus 非权威 | 已采纳（历史回填） | #388 / [`process-stream-policy.ts`](../../../apps/scheduler/src/process-stream-policy.ts) |
| [0006](0006-runtime-image-admission.md) | 运行镜像统一由平台目录准入，Job 冻结 digest | 已采纳（历史回填） | #674 / #676 / #691 / [`runtime-images.ts`](../../../apps/scheduler/src/runtime-images.ts) |
| [0007](0007-paused-upgrade-recovery.md) | 同 schema 升级回滚保留数据库并保持暂停 | 已采纳 | #740 / #747 |

---

## 5. 模板

复制下面的模板新建 `NNNN-kebab-case-title.md`，各节均为必填；不适用时写「无」并说明原因。

```markdown
# NNNN. <一句话陈述决策>

> 状态：**提议 | 已采纳 | 已废弃 | 被 NNNN 取代**
> 决策日期：YYYY-MM-DD
> 同步日期：YYYY-MM-DD
> 来源：#<issue> / #<PR> / <代码入口>
> 关联需求：FR-… / NFR-… / CON-…

## 背景

要解决的问题、约束条件与驱动力。只写事实与约束，不写结论；引用代码、schema、OpenAPI 或 issue 作为出处。

## 决策

我们决定 <做什么>。用「必须 / 不得」陈述可检验的规则，并写明适用范围与边界。

## 状态

当前状态及其变更历史（日期 + 原因）。被取代时链接到取代者。

## 后果

- 正面：<获得什么>
- 负面 / 代价：<放弃什么、引入什么约束或债务>
- 验收：<哪些测试、CI gate 或人工核查保证决策被遵守>

## 替代方案

逐条列出被考虑过的方案，以及不选的理由。
```
