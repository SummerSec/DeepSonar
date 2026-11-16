# 项目知识按项目积累与连续失败停发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少无产出自动知识任务，保留来源、评测和可追溯性。
**Architecture:** 从审计与现有 work 推导项目级积累/冷却/连续失败策略，collector 和 Dispatcher wake 共用查询，在项目行锁下重验。知识页显示原因。
**Tech Stack:** TypeScript、PostgreSQL、React、GitHub Actions。
**Spec:** ../specs/2026-11-16-project-knowledge-batching-design.md

## Global Constraints

- 最少 4 个来源或最老来源等待 24 小时，自动批次间隔 24 小时，连续 2 次无产出停止。
- 候选扫描 32 条，冻结原始输入最多 19 条；不扩预算、不改历史、不部署。
- 所有测试、build、typecheck 仅 GitHub Actions。GitHub 使用 Barry04。

## Review Focus

- 来源 retry 到期、批量阈值与冷却组合不能造成过期 wake 热循环。
- 并发 collectors、CAS 准备期间新失败，以及未知提交不能重复建批次。
- 伪造审计、无提案 completed、治理 hash 改变不能解除停发。
- 被输入上限挤出的来源不能丢失或被标为已采集。
- 显式请求与独立评测/预算边界不因自动策略收紧被删除或绕过。

## Tasks

- [x] 先添加真实数据库回归：少量来源不立即建 work；连续两批失败后新来源仍保留且没有 wake。接到已有 project-knowledge Actions 入口；未独立运行红灯阶段，最终实现统一在 Actions 验证。
- [x] 新增 collection-policy.ts 统一 SQL；修改 collector.ts 和 knowledge-wake.ts；扩大有界候选扫描并跳过放不下的来源。更新已有场景 fixture 的明确等待时间。
- [x] 知识 activity 返回 collection 状态，已有 React 面板呈现状态和下次时间，补充项目隔离和停发展示测试。
- [ ] 同步 FR-KNOW、trace、runtime/接口视图、专题、ADR 和索引。
- [ ] 独立评审，处理发现，最终 head 的核心与适用专项在 Actions 验证；遵守重大调度行为变更的人工合并边界。

## Execution record

2026-11-16：基于 origin/main 4de76ccb；仅静态检查在本机执行。用户已明确授权上述修复方向，具体阈值为实现选择。
