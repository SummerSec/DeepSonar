# 架构决策记录（ADR）

> 状态：**历史回填与当前集成决策索引**。0001–0006 保留原回填；0009 仍提议、0010 已采纳，0011–0014 记录本批已定边界及各自未验收范围，不代表组合发布完成。
> 同步日期：2026-10-31

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
| [0008](0008-maintenance-candidate-upgrade.md) | 维护升级以身份隔离、候选库和激活回执保护写入 | 已采纳；接线及隔离 Compose 演练已有证据，范围见 [升级演练](../../../deploy/UPGRADE_REHEARSAL.md)；扩展 0007 的适用限制 | #740 / #747 / 用户维护授权 |
| [0009](0009-finding-source-identity.md) | Finding 来源身份与跨任务关联分离 | 提议；未在本次资格变更中改写原决策 | #770 |
| [0010](0010-program-eligibility-authority.md) | 程序资格由授权操作员独立评审并绑定当前证据 | 已采纳 | #822 / FR-FIND-008 |
| [0011](0011-trusted-target-authorization.md) | 只读 authority 与不可变 grant 约束目标执行授权 | 已采纳；实际目标写操作不由授权适配器执行 | #767 / FR-TASK-006 |
| [0012](0012-plan-v2-execution.md) | 用户 objective CAS 与 lifetime 预算约束既有 Intent 的 Plan v2 执行 | 已采纳；v1 历史只读，writer 已于 2026-10-31 物理删除；根本地 normal→all7negative→normal replay 与七故障负例门禁已核验；report provenance 为 dirty 的非 HEAD 提交，最终 combined CI 待核对 | #775 / FR-CAP-006 |
| [0013](0013-governed-pi-memory.md) | Pi 会话观测记忆受冻结策略、独立 Gateway workload 和有限额度治理 | 已采纳边界不变；实际本地 base 镜像 canonical RPC、独立生产 guard 与 OM 专属版本准入及 Gateway/Session 已验，集中见 [RPC 证据](../../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；最终 CI/发布证据待完成，质量/成本收益 unknown | #815 / FR-CAP-009 |
| [0014](0014-operator-finding-identity.md) | 操作员见证身份以不可变 manifest、CAS 和失效检查支持关系计算 | 已采纳工程边界；外部官方真实性未认证，独立质量未交付，强关系不发布 | #819 / FR-FIND-009 |

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

#770 A 的独立评审提议见 [0009 Finding 来源身份](0009-finding-source-identity.md)。
