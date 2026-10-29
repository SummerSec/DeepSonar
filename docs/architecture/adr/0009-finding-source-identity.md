# 0009. Finding 来源身份与跨任务关联分离

> 状态：**提议（#770 A 独立 PR 待评审）**
> 决策日期：2026-10-29（实现方案日期；合并前未采纳）
> 同步日期：2026-10-29
> 关联需求：FR-FIND-002

## 背景

项目级 fingerprint 提前去重会在 Artifact 创建前丢弃另一 Job 的同文本发现，阻止项目研究保留独立来源。本次不改变 Job scope、Verify 或人工处置，也不实现项目关系算法。

## 提议

Control 提交幂等独立于来源身份。保留现有 profile/title/location/rule_id fingerprint 作为 Job 内来源键，数据库唯一约束为 `(job_id, fingerprint)`，Artifact key 同时带 Job UUID。相同来源内容摘要不一致时拒绝，而不是生成隐式修订；完整规则见[数据架构](../08-data-architecture.md#finding-来源身份770-a)。保留历史 UUID、归属、状态和旧 Artifact key，不能补造被旧去重丢失的来源。

## 后果和替代方案

跨 Job 可保留相同文本的独立证据和状态；Canvas 可能有更多语义重复项，由研究层表达。现有协议没有显式 source_key 或修订操作，title/location 等变化会形成新来源，暂不承诺同 Job 跨版本修订。只给指纹加 Canvas ID 仍会吞掉同任务不同 Job 的独立来源，因此不采用。以 event_id 直接当来源则把每次不同提交键都当新发现，不能区分原来源重复提交，因此不采用。完整显式 source_key+revision 协议留给独立评审。

## 验证

现有 Artifact 集成套件覆盖同提交并发重放、同源新提交键、内容冲突、同任务/跨任务独立 Job、Artifact 修订链独立以及状态不继承。schema baseline/rebuild 流程验证旧 UUID、Artifact key、Verify/disposition 保留；此验证不证明历史来源已补全或关联质量达标。
