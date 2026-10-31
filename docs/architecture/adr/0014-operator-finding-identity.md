# 0014. 操作员见证身份用于 Finding 关联但不宣称外部官方真实性

> 状态：**已采纳**
> 决策日期：2026-10-31
> 同步日期：2026-10-31
> 来源：#819 / `2773050a30a882e4b7c64955853662ddec06ec9d`
> 关联需求：FR-FIND-009 / FR-FIND-007；程序资格边界见 FR-FIND-008

## 背景

#770 A 将 Finding 的来源身份限定在 `(job_id, fingerprint)`，保留跨 Job 的独立来源，但不定义跨任务的资产、版本和根因身份。#819 需要在同一项目内计算 `same_problem` 与 `same_root_cause_different_instance`，而这些关系不能从 title、summary、location、任务目标、相似文本或自由格式 evidence 推导。实现因此引入平台管理员登记的 typed identity manifest、不可变 source revision、字段 mapping 和 Scheduler-owned 的可重建关系计算。

#822 已建立操作员对程序材料和当前证据的独立评审边界，但其 `operator` 见证只认证平台主体、权限和当前绑定，不认证外部规则的官方签名、站点所有权，或自然人/模型之间的物理独立性。Finding identity 采用同一类可追溯见证时，必须明确它不是外部官方真实性证明，也不能替代 #822 的程序资格 authority。

## 决策

1. 身份 source 必须按项目和 Finding 归属由认证平台管理员通过 Management API 登记。manifest 只允许已知 `source_kind`、`source_ref`、`freshness_until` 和 digest-only 的身份字段；服务端计算内容摘要并记录认证主体。允许的字段、来源类型和机器形状以 [relation schema](../../../apps/scheduler/src/domains/project-finding-research/relation-schemas.ts) 和 [`database/schema.sql`](../../../database/schema.sql) 为准。
2. 身份比较区分六个强字段 `asset`、`tenant`、`environment`、`version`、`parameter`、`root_cause`，以及可在两边都已知时阻断关系的 `service`、`permission_boundary`。只有同项目、强字段当前有效且无冲突时才允许产生强关系；完整实例身份产生 `same_problem`，root cause 相同但实例不同产生 `same_root_cause_different_instance`，缺失/冲突/不一致必须保持 `insufficient_information` 或 `distinct`。
3. source revision 必须 append-only；source 修订和撤销使用当前 revision CAS。mapping 首次注册要求空的 expected version，remap/revoke 必须带最新 mapping version 和 reason。服务端解析当前 source revision、digest、metadata 和 freshness，调用方不得自报 provenance、source digest 或 identity digest。来源变化、过期、撤销、字段缺失、跨项目选择和历史截断必须在写入或当前读取时 fail closed。
4. 强关系只能是 Scheduler-owned 的可重建派生数据。`project_finding_relation_work`、`project_finding_relation_sources` 和 `project_finding_relations` 以 generation、source/identity fingerprint、rule version、检查点和 read 状态记录计算；worker 必须在维护身份 fence、事务一致读和有界批次内运行，失败不能改写 Finding、Artifact 或 source 真相。读取也必须按当前 Finding/source/identity fingerprint 重核并省略 stale 结果。
5. `authority_basis` 固定为 `platform_admin_attestation`，`independent_external_verification` 固定为 `false`。强关系质量门未完成前，`quality_gate_status` 固定为 `not_evaluated`，`published` 固定为 `false`，公开 Management API 不得通过查询参数暴露 suppressed relations。独立人工标签、按问题家族/资产隔离的调参集与留出集，以及查看留出结果前冻结的阈值，是强关系质量交付的前置条件；缺失时不发布生产建议。
6. Finding relation 的读接口只接受 `findings:read`，身份 source/mapping 的写接口只接受 `admin`，并遵守项目 scope；Job capability token 不得调用这些 Management 写接口。读取和计算的页面、Canvas、pair、worker 和 mapping-history 限制只以源码命名常量为准，见 [`relation-read.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation-read.ts)、[`relation-computation.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation-computation.ts) 和 [`identity-mapping-store.ts`](../../../apps/scheduler/src/domains/project-finding-research/identity-mapping-store.ts)。
7. 本决策不改变 [ADR-0009](0009-finding-source-identity.md) 的 **提议** 状态，也不重写已采纳的 [ADR-0010](0010-program-eligibility-authority.md)。操作员见证身份不认证外部官方来源，不产生程序 `eligible`，不授予目标写权限或自动提交权限；程序资格仍由 FR-FIND-008 的材料和独立评审投影决定。

## 状态

2026-10-31 采纳并在当前集成分支接线。schema 基线由 v65 推进到 v66；身份 source、不可变 revision、mapping CAS/失效、bounded current reads 和 durable worker 已有实现。固定历史 v62/v63/v64 数据与七张新 relation 表的 full rebuild/pg_dump/pg_restore 证据已通过且无 pending。当前 `STRONG_RELATIONS_PUBLISHED=false`、`quality_gate_status=not_evaluated`，因此工程闭环不等于关系质量或生产建议交付。质量门缺口见 [FR-FIND-009](../01-system-specification.md#fr-find-009-操作员见证身份与跨任务关联) 和 [质量属性](../04-quality-attributes.md#身份资格与质量门)。

## 后果

- 正面：跨 Job 的 Finding 可以在有来源、版本、freshness 和撤销历史的情况下保留独立身份；mapping/source 变化会使旧关系失效，当前读取不会把 stale 结果当作事实。
- 负面 / 代价：身份登记、CAS 修订、撤销和 freshness 维护增加操作员工作；历史不完整或读取超界时宁可 `blocked`/`stale`，不能给出关系建议；公开读接口在质量门打开前只提供状态和缺口。
- 信任边界：平台记录的是认证操作员的见证，不是外部系统真实性证明。#822 的程序资格、Finding 技术 Verify、任务判据和执行授权保持独立。

## 验证

工程行为入口包括 [`identity.test.ts`](../../../apps/scheduler/src/domains/project-finding-research/identity.test.ts)、[`relation-api.test.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation-api.test.ts)、[`relation-store.test.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation-store.test.ts)、[`relation.integration.test.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation.integration.test.ts) 和 [`relation-http.integration.test.ts`](../../../apps/scheduler/src/domains/project-finding-research/relation-http.integration.test.ts)，以及 `ci:unit:finding-research` / `ci:integration:finding-research`。2026-10-31 主线程已通过完整 Finding Research 集成及 schema rebuild/restore、CLI plan/apply/原库恢复，最新范围与分母集中见[验收矩阵](../../TASK_DISPATCH_ACCEPTANCE.md#v063-集成证据范围2026-10-31)；早期 runner 超时不再表示当前整套未完成。较早 `e23c3b4f` 的 CI 不代表当前组合，当前 PR/最终 main CI 与发布证据仍待完成。独立人工标签、家族/资产隔离 tuning/holdout 和预冻结阈值仍缺失，工程通过不改变 `published=false` / `not_evaluated` 的质量边界。

## 替代方案

以下为本次分析中不采用的方案，不伪称为历史已审议结论：

- 从 Finding 文本、词法相似度或任务目标猜测资产/版本/根因身份：无法提供可审计的权威来源，拒绝。
- 把 `platform_admin_attestation` 当成外部官方清单或规则签名：混淆平台主体与外部真实性，拒绝。
- 让 Agent/Job capability token 直接写身份或关系：突破 Management scope 和可信内核边界，拒绝。
- 在独立人工标签、隔离留出和预冻结阈值缺失时发布强关系：不能把工程门禁代替质量验收，拒绝。
- 将身份准入并入 #822 程序资格或改写 ADR-0009/ADR-0010：会混淆来源身份、程序资格和既有决策状态，拒绝。
