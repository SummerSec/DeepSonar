# 自动沉淀实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 在既有用户授权内连续执行。

**Goal:** 成功任务自动登记有来源的知识整理，支持精确历史补做，并接入Barry全局Skill源。
**Architecture:** 复用project_knowledge_work及CAS；终态短事务登记、Dispatcher异步冻结输入，管理入口复用同一幂等函数。
**Tech Stack:** TypeScript、PostgreSQL、Fastify、GitHub Actions。
**Spec:** ../specs/2026-11-09-knowledge-auto-trigger-design.md

## Global Constraints

- 不改历史快照，不恢复终态token，不绕过独立评测，不创建另一执行通道。
- 只在Actions执行测试/构建/typecheck；本地不运行。
- 不修改用户主工作区现有改动；GitHub使用Barry04。

## Review Focus

- 并发自动/手工触发不得创建重复预算链。
- 知识Job及其trial不得再次触发知识根链。
- CAS失败、空来源和未知外部效果保留可解释结果，不回滚主业务终态。
- 跨项目管理身份、撤权及历史Attempt不越界。
- 全局源按用户选择使用公开 HTTPS 仓库和现有同步机制，不增加私有 Git 凭据通道。

### Task 1: 自动登记与输入准备

Files: domains/project-knowledge/automatic.ts、automatic.integration.test.ts、requests.ts、core.ts、project-knowledge-scheduler.ts、domains/project-knowledge/work.ts、knowledge-wake.ts与集成回归、schedule-wake.ts。
- [ ] 先写数据库行为测试，覆盖上述触发、幂等、隔离和停止条件；通过Actions运行红绿验证。
- [x] 实现终态savepoint登记、异步来源准备、未准备work领取过滤和有界错误处理。
- [x] 主线程审阅diff；新增测试接到已有知识集成Actions入口。
- [ ] 核对最终 SHA 的无来源剩余批次、防普通任务自唤醒和 Agent 自由文本原因隔离回归。

### Task 2: 管理预览与补做

Files: domains/project-knowledge/automatic-routes.ts、routes.ts、openapi.ts、管理API回归。
- [x] 项目范围GET预览、最多5个Job的POST补做，复用Task1函数；写入可审计且重复幂等。
- [x] 对跨项目、无权限、未知字段、未成功Attempt和已有work补充回归。

### Task 3: 全局Skill源与运行平台

- [x] 用户明确选择公开，使用既有HTTPS同步、候选CAS和epoch校验审批Barry源；23模块已trusted+enabled，新Job冻结目录已核对包含该源。
- [x] 抽查最近10个成功业务Job均有Fact、最新Attempt成功且无未结算效果；通过现有共享资产与任务API提交首条有界补做，已有真实request_project_knowledge持久回执及work。补做生成 Memory 草稿，独立试验缺 Evidence，修订后达到原累计运行预算而 blocked；未激活，不重置预算重跑。

### Task 4: 文档与交付

- [x] 同步FR-KNOW及追溯、运行时/接口/安全视图、PROJECT_KNOWLEDGE、DESIGN与索引。
- [ ] 独立审查最终diff，push Barry功能分支并在Actions运行完整适用验证，保留最新SHA证据。
- [ ] 区分代码交付、运行平台已接入、补做已提交/完成、知识激活和未验证质量。
