# 项目知识闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 本轮按仓库默认分工委派不相交文件，主线程负责调度与整合。

**Goal:** 修复知识激活链路，接通按项目自动整理，并展示实际复用与反馈。

**Architecture:** 复用现有 Dispatcher、work、CAS、Job、独立评测审查与 usage；来源队列与批次关联复用审计元数据，不改变 schema。管理接口只投影当前事实。

**Tech Stack:** TypeScript、PostgreSQL、Fastify、React、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-11-project-knowledge-closed-loop-design.md`

## Global Constraints

- 不改历史快照/回执；不扩大权限/预算；未知效果不重放；独立评测审查保留。
- 所有测试、构建、typecheck 仅 Actions；本地仅静态读取与 `git diff --check`。
- GitHub 采用 Barry04；分支 `feat/project-knowledge-closed-loop`；不合并、不部署。

## Review Focus

- 并发收集/重启必须保持同一批次、同一来源只消费一次。
- 来源快照与当前内容变化、归档/未知效果须重新核验。
- without 组不泄漏候选，但不能缺少共同任务材料。
- 同 key 资产发布不得创建第二版本或返回虚假成功。
- UI 统计不是质量认证，旧项目响应不能显示在新项目。

## Task 1: 资产发布回执（worker，独占 executor 与相关测试）

- [ ] 先补真实工具返回与幂等/拒绝回归。
- [ ] 保留 createSharedAsset 返回的版本/hash，通过既有 Control 响应返回。
- [ ] 静态核对权限、lease、错误和重复提交；接入原 Actions 测试入口。

## Task 2: 项目收集与可运行试验（主线程，独占 work/automatic/collector/knowledge-wake）

- [ ] 先补项目批次并发、来源变更与来源到 work 的 PostgreSQL 回归。
- [ ] 实现事务外 CAS 准备、事务内重核与去重，连接 Dispatcher 唤醒。
- [ ] 统一各组任务输入，保持候选/基线隔离，补工程闭环及后续读取/反馈证据。
- [ ] 不复活历史自动 work 或耗尽/未知 work，超界来源显式阻塞。

## Task 3: 进度与复用投影（worker，独占 activity API 与 Web）

- [ ] 先补项目权限、分页与统计隔离回归。
- [ ] 新增 activity 只读摘要/工作分页；UI 显示来源、生效、使用、反馈、阻塞及详情链接。
- [ ] 主线程接 routes/auth/OpenAPI/route manifest/管理 Skill 引用与测试接线。

## Task 4: 文档、独立审查与 Actions（主线程整合）

- [ ] 新 ADR 取代仅来源预览决策的当前限制，同步 FR-KNOW-001、运行时/接口/安全/数据视图、trace、专题、DESIGN 和索引。
- [ ] 抽查 worker diff，独立审查权限/生命周期/并发/预算与事实口径，修复明确缺陷。
- [ ] `git diff --check`；提交推送 Draft PR 触发 Actions，修复失败后转 Ready 执行完整验收。
- [ ] 区分工程检查、未部署及未运行真实模型效果；不伪造激活或收益。
