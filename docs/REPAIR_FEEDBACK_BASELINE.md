# RepairFeedback 冻结基线（#776 A）

> 状态：A 阶段合成契约回放；B 持久同会话闭环、C 引用/完成门扩展未交付。
> 同步日期：2026-10-29

核对 main `9cb1524a`（包含 #766）；#768 尚未合并，本切片不修改运行器、framing、DSH 生命周期或 schema。对应 FR-CTRL-001/002/005、风险 D-03。规范保持不变，缺失字段不是被豁免的要求。

## operation × error × accepted-effect × feedback × recovery

“无本次效果”不代表当前 Job 没有历史效果；缺少 receipt 不能推定效果不存在。

| operation / 错误 | 分类（当前） | 已接受效果依据 | 当前反馈 | 安全恢复 / 缺口 |
| --- | --- | --- | --- | --- |
| mark_job_done / summary >8192 UTF-8 bytes、类型、未知字段 | model_correctable | schema 拒绝在 handler 前；本次未执行 | path（未知字段无 path）、expected、shape、key | 修改语义用新 revision/key；revision/预算尚未持久化 |
| emit_fact / semantic payload >256KiB | model_correctable | payload 检查抛错；历史效果需另查 | 字节上限与实际大小 | 缩小/拆分，已接受部分不得重发；现有 repair-feedback.test.ts 覆盖 |
| submit_hub_decision / invalid_node_ref | model_correctable | 本次拒绝；既有事实不能从反馈推定 | 稳定 code/message；无当前状态引用 | 通过 Job-scoped graph_query 重读；当前反馈缺 current_state_ref |
| mark_job_done / verify 缺 verdict 或 rework 缺 missing_evidence | model_correctable | executor-real 在 recordFirstSemanticDone 前拒绝 | invalid_done/path；无结构化缺项或 accepted_effects | 补字段用新 key；完成门上下文待 B/C |
| emit_progress / event_rate_limited | transient_retryable | 事务写入前限流 | retry_after_sec 与桶额度 | 安全原操作等待后旧 key；现有 repair-feedback.test.ts 覆盖 |
| mark_job_done / tool_not_allowed、job_not_running | permanent_failure | 不能推定历史效果为空 | host rejection 有 envelope；HTTP auth/allowlist 仍可能只有 error_code | 停止，取消/租约/终态优先，不扩权 |
| mark_job_done / HANDLER_FAILED | transient_retryable（现状缺陷风险） | 未知：异常不能证明无效果 | 泛化失败、旧 key 重试建议 | 必须先对账；本基线不认可一律自动重试安全 |
| 任意操作 / effect_pending、unknown、replay_policy=never | unknown_external_effect（规范） | job_attempt_effects | 独立效果账本，不等于 Control receipt | 停止重放，reconcile/orphan/人工处理；不制造 accepted_effects |
| 已接受提交 / 响应丢失、同 key 改内容 | 进程内缓存命中/409 conflict | routes 的 Map；事件另有 durable gate | 原结果或 IDEMPOTENCY_KEY_CONFLICT | 同提交旧 key；进程重启丢缓存，不能声称持久 receipt 已闭环 |

事实入口：[Control routes](../apps/scheduler/src/domains/platform-api/routes.ts)、[host feedback](../apps/scheduler/src/domains/platform-api/repair.ts)、[完成提交](../apps/scheduler/src/executor-real.ts)、[Attempt](../apps/scheduler/src/domains/job-attempt/application.ts)。

## 冻结回放与完整性

[夹具](../apps/scheduler/src/fixtures/repair-feedback/baseline.json) 是人工构造、符合实际 Control JSON 格式的 8 个请求/host 拒绝样本；来源版本写在 provenance 中，非生产日志、非 CLI transcript。前三项经过真实 DonePayload schema；其余重放实际 host feedback 构造器，不冒充 executor 或事务集成测试。[测试](../apps/scheduler/src/repair-feedback-baseline.test.ts) 对 JSON wire round-trip、精确字段集合、category/code/path、UTF-8 shape、key、秘密标记不回显及重复调用结果做断言。另测首次有效提交和精确 8192 字节边界。

完整性基线：8/8 样本有版本/category/code/operation/message/key/next_action；3/8 有 expected/observed_shape；0/8 有可信 current_state_ref/accepted_effects。所有样本 revision/repair_attempt 为 0，可修正样本每次广告 attempts=8；这些是**已知缺口的刻画**，不是持久额度验收。未来修复时必须同时更新基线与证据，不长期保留错误行为作为规范。

接入 `pnpm ci:unit:capability-pack`，由 `.github/workflows/ci.yml` gate 调用。现有字节、限流和 hostile-details 测试继续保留。本测试不统计运行器恢复率：没有真实修复轮次、token 成本或人工介入的有效分母，全部标待评测；不能把 8 个拒绝回放算成 8 次修复成功。

## B/C 进入条件

B 只选 mark_job_done，复用 Control/event/Attempt，补持久拒绝与 revision/key/预算关联和可查询 receipt，再接同 Session 输入；注入不等于模型已处理。重复、冲突、旧 revision、并发、接受后丢响应、重启、取消、超时、CLI 退出、迟到输入及未知效果均要有真实运行器合成测试。修正次数、token、wall time、event 分别计数且不超过 Job 总预算；预算耗尽使用既有失败/人工路径，不新增 Job 状态。

Claude/Pi/DSH 按 adapter 的实际续接能力验证；DSH 跨进程持久 resume 不支持时停止并保存诊断。保留 #766 可信父子谱系、父 idle 有子任务不结算和子 finish 后等待父处理；运行器变更前核对 #768 最新修复，不能回退控制语义或将 evidence 保存失败变成功。

C 才扩展引用与完成门；#767 的失败后重新下发不算同会话修复。真实模型理解反馈的质量须独立受控评测，本切片不调用模型、不操作生产、不自动重跑 Job。
