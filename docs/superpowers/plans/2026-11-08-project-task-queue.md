# 项目任务串行队列实施计划

> For agentic workers REQUIRED SUB-SKILL superpowers:subagent-driven-development。按下面独立交付项执行并审查。

**Goal** 让同项目队列中的完整任务按 FIFO 串行执行。

**Architecture** 以 PostgreSQL 保存调度状态，统一使用 Scheduler claim 事务锁。队列只提供执行资格，现有 Job/Attempt、权限、效果与完成门继续决定执行真相。

**Tech Stack** PostgreSQL、TypeScript、Fastify、React。

**Spec** [项目任务队列](../../PROJECT_TASK_QUEUE.md)。

## 全局约束

- 项目单队列，成功后自动继续，失败或取消后明确继续，人工等待、暂停与未决效果占位。
- 入队与首 pending Job 同事务，当前任务内部并行 Job 维持原并发限制。
- schema 只更新基线与 SCHEMA_VERSION，通过 Actions 验证重建与行为。
- 各写入方分别拥有独立文件，主线程检查 diff、验证接线与审查结果后提交 PR。

## 独立交付项

- [x] schema、API 权限、创建与 Dispatcher 接线。
- [x] 有界队列模型、存储、失败恢复及 SQL 竞争回归接线（Actions 待验）。
- [x] 项目任务页入队与控制入口、错误反馈及 Web 回归接线。
- [x] 需求/追溯、数据/运行时/接口视图和索引同步。
- [x] 独立源码审查与差异/分支静态检查。
- [ ] PR 与最终 SHA 实际 GitHub Actions 验收。

## 审查重点

排队任务不得越序领取。当前任务的 Verify/Report、未知效果和人工等待必须保留位置。队列暂停不阻断当前任务内部的合法 Job。重试只能重新排尾，跨项目和无权限输入必须拒绝。任何无法确认的结束或效果都保留明确阻塞。
