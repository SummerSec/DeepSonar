# #1074 人工等待显式让位实现计划

目标是在严格 FIFO 中默认保留人工等待占位，用户显式让位后允许下一项执行，原请求回复保存后只回队尾一次，轮到时通过既有续做准入创建唯一后继。

用户已确定行为、实现方式、写集和 Actions 验证方式，本计划直接执行。

- [x] 数据及队列。schema 75 增加 yielded 状态与持久让位记录，绑定 mutation_id、原 item、request/revision、回复和回队条目。保留 created_at/started_at 完成代际。复用 claim advisory 锁及 Canvas→Job→Attempt→request 锁序，同事务审计。
- [x] 正常入口。共享严格输入契约、jobs:control 项目路由、OpenAPI、Web 队列显式按钮与已让位投影。只接受单一安全人工等待，拒绝其他活动工作、未决效果、过期与治理阻塞。
- [x] 回复及续做。回复持久化后同事务回队尾，泵重入可对账。续做仍核断点、退出、预算、授权和未知效果。只有无 active、未暂停且当前队首可取得席位，不抢占下一任务。
- [x] 回归和文档。既有 SQL/HTTP 套件加入完整 A→让位→B→A 回复→B 完成→A 唯一后继及竞争、暂停、取消、过期、未知效果。接既有 workflow，更新需求追溯、运行时/数据/API 和队列专题。
- [ ] 交付。仅静态差异检查后提交至 Barry04 fork，向 SummerSec/main 提 PR，Refs #1074，持续处理最终 SHA 全部适用 Actions，不合并。

实现选择。使用独立让位表保留幂等历史，条目 ID 只在回队尾时更新，创建时间不变。首片仅支持一个 Canvas 中唯一人工等待，其他组合明确拒绝。原生 Session 与历史接续由其他切片负责。

验证。本地仅阅读、静态检查和 git diff --check。所有测试、数据库重建、build、typecheck 在 GitHub Actions 执行。
