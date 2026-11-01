# 0010. 程序资格由授权操作员独立评审并绑定当前证据

> 状态：**已采纳**
> 决策日期：2026-10-31
> 同步日期：2026-10-31
> 来源：#822；本轮实现与边界复核
> 关联需求：FR-FIND-008 / FR-TASK-007 / NFR-SEC-001

## 背景

技术 Verify、研究候选准入和任务判据评价具有不同的 authority。它们不能证明某个 Finding 符合某个程序的提交条件。既有 `operator_supplied` 规则由任务创建者提供，也不能直接成为平台信任的程序来源。#822 要求可查询的独立资格评审，不扩大执行授权或新增执行通道。

## 决策

- 程序材料必须由有相应管理权限的操作员显式准入；平台范围要求未绑定项目的管理员，项目范围必须遵守 actor 的项目边界。该准入是可追溯的操作员见证，不认证外部官方签名、站点所有权或规则 URL 的真实内容。
- 评审者身份与权限必须取自认证 actor。Agent/internal actor、viewer 和已识别的 Finding maker 不得批准；请求体不得自报 reviewer 或资格状态。这里认证的是平台主体和已知来源隔离，不认证自然人或模型之间的物理独立性。
- 每条评审必须绑定 Finding Artifact revision/source digest、来源和 Verify Attempt、当前确认轮次、受治理目标及基线、程序材料版本与摘要、证据指纹、理由和时间。技术确认、严重度、关键词或普通规则评审不得单独产生 `eligible`。
- 材料登记、替代、撤销和评审复用现有 append-only `audit_logs`。当前资格是对这些记录及现有 Job/Artifact/Verify/Evidence 的只读投影；不得重写历史、改变技术 Verify 或生成第二执行通道。
- 评审写入必须按 Canvas、材料生命周期、Job/Finding/证据顺序串行化并重读输入。独立查询使用一致的只读数据库快照；已有报告事务保持 Canvas 输入锁和材料共享锁。幂等响应不得绕过项目授权。
- 材料撤销、版本替代、Attempt 或来源变化、证据变化、有效评审冲突、历史损坏和读取预算不足必须阻断当前正向结论。超出批量投影预算的 Finding 必须显式报告缺口。

## 状态

2026-10-31 采纳并实现。实现入口为 [程序资格域](../../../apps/scheduler/src/domains/program-eligibility/)，机器契约为 [shared schema](../../../packages/shared-types/src/program-eligibility.ts)。当前工程证据和信任限制见 [专题](../../PROGRAM_ELIGIBILITY.md)。未执行生产任务或真实模型质量试验。

## 后果

- 当前有效结论可以追溯到具体主体、材料和证据，旧批准不能在来源变化后继续代表当前资格。
- 操作员必须对准入材料和评审判断负责。平台不代替外部程序核验，也不自动提交漏洞。
- 有效批准和拒绝并存时保持阻断；不采用最后写入覆盖前一结论。
- 验收入口为 `pnpm ci:unit:verify-eligibility`、隔离 PostgreSQL 下的 `pnpm ci:integration:verify-eligibility`，以及 `pnpm ci:unit:authz` 的真实路由面与 scope 检查。命令是验证入口，不表示每次文档同步都已执行。

## 替代方案

- 从技术 `confirmed` 或任务规则满足直接推出资格：缺少独立主体和当前程序适用性，拒绝。
- 让 Agent 在 Control API 自报资格通过：不能跨越模型提案与可信评审的边界，拒绝。
- 新增资格执行器或第二套 Job 生命周期：现有管理准入、审计和投影足以表达该能力，不采用。
- 覆写 Finding 或旧评审上的资格字段：无法保留来源变化和历史责任，拒绝。
