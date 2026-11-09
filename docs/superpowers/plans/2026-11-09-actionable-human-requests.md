# 可行动人工请求修复计划

> **For agentic workers:** 按本计划并行处理不重叠文件，主线程整合并独立审查。用户已明确要求一并修复；所有测试、构建和 typecheck 仅在 GitHub Actions 执行。

**Goal:** 人工待办完整说明需要用户做什么、怎样回复、回复后的计划，同一阻塞只显示一次。

**Architecture:** 新 `request_human` 必须提供严格 `guidance`（`question`、`required_action`、`reply_instructions`、`after_reply`），与完整 reason 一同保存。画布 L0 保持有界，Web 使用已有 L1 节点接口按需读取完整人工请求；Job 列表为等待人工项提供 Scheduler 当前恢复投影。按 Job 与人工节点关联去重，未决效果保留独立优先级，不把回复当成授权、消息 ACK 或执行成功。

**Tech Stack:** TypeScript、Zod、PostgreSQL、React；沿用现有 API、消息账本和恢复准入。

**Spec:** 本轮用户明确需求及 DESIGN 的 NFR-UX-001 注意力原则。

**Implementation base:** `origin/main` 的 `c25b8e1b`。创建 worktree 后发现原分支陈旧，已在任何实现编辑前快进至最新主线并重新核对；原目录及其未提交改动保持不动。

## Global Constraints

- 历史冻结请求保持不变；缺少指引时明确显示缺失，不凭摘要猜测。
- 新提案缺少指引必须 fail closed；不创建旧输入兼容或自动补写。
- 不向整张画布注入完整正文；详情失败可见、可重试，切换任务不串数据。
- 不改变权限、原预算、deadline、Attempt fencing、未知效果对账和消息 ACK 语义。
- 不混入原工作区改动；GitHub 使用本机 Barry04；不合并、不部署。

## Review Focus

- 指引放在第 500 字之后仍能完整展示；正文含长行、换行也可阅读。
- 同 Job 人工请求与等待投影只产生一个人工待办；未知效果不被去重吞掉。
- 历史请求、详情加载失败、任务切换及陈旧响应均不能产生虚假操作建议。
- 凭据/授权等待显示配置或安全引用要求，不能诱导在回复中粘贴秘密。
- 发送成功、Agent ACK、恢复准入及任务完成必须区分。

## Tasks

- [x] 严格契约与持久化：先补缺字段/空字段拒绝及完整保存回归，再更新 shared schema、Control 操作描述、Hub 注入、内置角色说明及现有行为 fixture。
- [x] 展示与回复：先补完整详情、失败/陈旧响应、关联去重与独立效果回归；再实现 L1 读取、指引展示、回复上下文和恢复语义说明。
- [x] 当前等待投影：沿用 readCompletionExecutionState 为 Job 列表 waiting_human 项提供当前建议；有界并发，列表/详情保持同一权威。
- [x] 文档同步：更新 FR-WEB-003、NFR-UX-001、Control 契约、追溯与 DESIGN/索引，记录注意力成本和历史请求边界。
- [ ] 独立代码评审、diff 检查、测试接线核对；创建 Draft PR 触发 Actions，修复实际失败，最后报告最终 SHA 与验证状态。

## Validation

GitHub Actions：ci:unit:canvas-facts、ci:unit:web-facts、ci:unit:executor-real、ci:integration:platform-api、ci:integration:canvas-facts、ci:unit:searchable-selects、ci:unit:file-size、ci:unit:docs-freshness 及变更所需全量适用检查。本地只运行非测试静态 diff/接线检查；本计划不宣称未执行的验证通过。

## 本轮证据

独立静态评审发现并修正了旧 fixture、未知效果排序、授权/凭据去重、长行显示及回复 ABA 回调竞态；新增 DOM 回归并接入 web-facts。本机仅执行 diff 检查、测试接线/文件行数检查和固定 Skill 文本哈希计算；没有运行测试、构建或 typecheck。最新提交的 Actions 结果在 PR Checks 单独记录，未合并、未部署。
