# 完成修正的 CLI 离线矩阵（#776）

> 状态：离线协议验证；不代表真实 CLI 可执行程序或模型理解质量验收。
> 同步日期：2026-10-30

本切片复用 [B1 持久完成回执](REPAIR_FEEDBACK_DONE_REPAIR.md)，不改变运行时、预算、权限或恢复协议。三个适配器均调用生产 `runRealAgent`、adapter 和 JSONL framer；版本跟随 [适配器定义](../packages/runtime-sandbox/src/runtime-adapters.ts)。

## 流程与分母

| CLI | 首次有效 revision 0 | 拒绝、查询、修正 | 接受后响应丢失与恢复 | 无进展停止 | 次数耗尽 | CLI 退出与迟到输入 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| Pi | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| DSH | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |

每格使用独立 Job。拒绝后修正流程先拒绝超限 summary，读取拒绝回执，验证同 key 改内容及旧 revision 被拒绝，再以新 key/下一 revision 接受。响应丢失流程故意让受控 handler 的首次本地 commit 失败并丢弃 HTTP 响应：GET 只查到 persisted_deferred，完成门仍关闭；原 key/revision/payload 再 POST 后恢复，prepare 一次、commit 尝试两次。这是可控故障注入，不是 TCP 丢包或真实进程崩溃。

18 个流程是协议断言的分母（九个接受/恢复流程，九个预期停止流程），不是 18 次模型修复成功。每个流程限定 10 秒、一个进程、一次 prompt、同一 session；不得发生 nudge、restart 或 run.retrying。正常首次提交没有额外修复轮次。

停止流程在实际运行器收到合成非零退出后断言 failure、一个进程/一次 prompt、无 retrying；随后夹具调用生产 unregister 移除 handler，原拒绝回执仍可查/重放，迟到新提案被次数门或 HANDLER_UNAVAILABLE 拒绝，不能产生 accepted receipt。它不声称 CLI 自主理解了停止原因，也不把手动 handler 移除冒充完整 executor 崩溃。

## 真实与模拟边界

- **真实代码**：运行器、CLI adapter/framer、Control Fastify 路由、token/schema/幂等校验、PostgreSQL 回执与 revision 规则。
- **合成夹具**：[completion-runner-fixture](../apps/scheduler/src/domains/platform-api/completion-runner-fixture.ts) 生成对应协议记录并拆分输出 chunk；不是 CLI 录制或生产 transcript。HTTP 使用 Fastify.inject，无 TCP 服务；受控 handler 表示 prepare/commit 完成门，未替代或验收生产 executor。
- **独立证据**：[B2 实际 executeReal 交错测试](../apps/scheduler/src/executor-real-terminal-race.test.ts) 覆盖宿主状态互斥；不应与本矩阵拼成未经运行的完整端到端场景。
- **未覆盖**：模型是否理解反馈、真实工具执行、成本/恢复率、每个 CLI 的真实进程崩溃和重连、所有错误类型的完整交叉矩阵。

## 同会话与跨进程

本矩阵只在原活动进程内进行 Control HTTP 修正。Claude 的 stream-json resume、Pi 的 session 文件与身份检查由既有 [adapter tests](../packages/runtime-sandbox/src/runtime-adapters.test.ts) 和 [Pi recovery tests](../packages/runtime-sandbox/src/runtime-pi-recovery.test.ts) 分别验证，不据此声称本次完成提案跨进程恢复已验收。DSH 的 `persistentSessionResume=false` 与 `CONTEXT_RESUME_UNSUPPORTED` 由 [DSH recovery tests](../packages/runtime-sandbox/src/runtime-dsh-recovery.test.ts) 固定；不能把新 Job 重新下发说成恢复原会话。

## 执行入口

[completion integration](../apps/scheduler/src/domains/platform-api/completion.integration.test.ts) 已接入 `pnpm ci:integration:platform-api`，由主 CI gate 执行，需隔离 `TEST_DATABASE_URL`。缺数据库时测试跳过，不算通过。数据库使用当前 schema，新建随机测试库并结束后清理。本切片不增加 token 计费口径，不扩大 C 的引用/证据完成门。

完整 issue 的逐项判定、用户效果评测豁免和合入关闭条件见 [验收矩阵](REPAIR_FEEDBACK_ACCEPTANCE.md)。
