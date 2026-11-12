# Pi 模型预算与截断恢复（#958）

> 状态：本修复的配置链路与有界恢复已接源码；最终 SHA GitHub Actions 待验。
> 核对基线：2026-11-07。未执行本地测试、构建、typecheck、数据库或生产重跑。

## 预算的来源与冻结

`/models` 发现保留结构化模型限制，不再只提取 ID。识别的上下文和输出字段、合法范围及冲突处理以
[发现解析器](../apps/scheduler/src/domains/provider-adapter/model-discovery.ts)为准。
每个限制分别保存 `declared` / `missing` / `invalid` 状态、原字段名与
`trust: provider_declared`；来源标记为 `models_endpoint`，不保存端点 URL、凭据或响应正文。

声明不是真实容量验证：例如中转声明的窗口与输出上限，不能证明最终厂商能接收等长输入，
也不能证明当前 CLI 正在使用该值。目录发现只补充能力，不扩大账号
`settings_config_json` 中的已配置模型名单、项目权限或选模资格。

创建 Job 时，[预算解析](../apps/scheduler/src/domains/provider-adapter/model-budget.ts)按字段冻结
`agent_snapshot_json.model_budget`：

- `context_window_tokens` / `max_output_tokens` 各含 `configured`、`declared`、`effective` 与 `source`；
- `catalog_revision` 对应创建时的模型目录；
- `configured` 表示已选择的显式配置，`declared` 保留发现值，即使被显式配置覆盖；
- `effective` 是创建期解析出的目标客户端预算，不是上游实测容量。未明确选值时为 null，来源为 `cli_default`；
  真实 CLI 默认值须由运行时观测，不能猜成统一固定值。

上下文沿用已有覆盖层：Job/runtime profile → RoleConfig → 账号显式配置/选定 Pi 模型
`contextWindow` → 同账号、同模型的发现声明 → 未知 CLI 默认。
输出沿用选定 Pi 模型的显式 `maxTokens` → 发现声明 → 未知 CLI 默认；
本修复不新增 Role/Job 输出配置 API，也不新增用户开关。
显式非法值拒绝，发现缺失或非法限制保持未知，不将字符串/零/负数或越界值当作合法容量。
账号配置、模型路由及原有权限解析规则保持不变。

[Pi 配置投影](../apps/scheduler/src/provider-settings.ts)把选定有效值写到该模型的
`contextWindow` / `maxTokens`，与冻结预算保持一致。本修复只为 Pi 新增这两个原生字段的投影与恢复；
Claude Code/DSH 沿用既有配置投影，预算元数据本身不能证明任一 CLI 已读取或应用这些值。
Dispatcher/Executor 不读取当前发现或配置来修补历史 Job；历史缺少预算字段仍是未知，
不会回写或伪造当时 CLI 默认值。运行中 `get_state` 观测到的模型限制与冻结输入并列诊断，
不修改模型、快照或 Gateway 额度。

原生 RPC 契约核对 [Pi 1.5.2 `rpc-mode.ts`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts)：
`get_state` 返回当前 Session、模型、streaming/compacting 状态及待处理输入计数，
`compact` 直接传递 `customInstructions`；此源码核对不是实际沙箱或上游容量验收。

## `length` 不等于完成

[Pi adapter](../packages/runtime-sandbox/src/runtime-adapters.ts)识别 assistant 的
`stopReason=length`，分别保留普通文本、工具参数和 thinking-only 的形状与用量。
`agent_settled` 只证明 Pi 静止，不证明输出完整或已通过 `mark_job_done`。
截断不得走普通“没有完成摘要”的反复 nudge；已接受的完成仍可按原协议结算，
真实 Provider/进程/语义失败也不能被截断策略洗成成功。

[恢复器](../packages/runtime-sandbox/src/pi-length-recovery.ts)在同一已校验 Session 内执行：

1. 读取匹配请求 ID 的 `get_state`，不重新发送初始化输入；核对会话、空闲及待处理输入。
2. 在极低输出预算、上下文压力或已有无效压缩等条件下，使用 Pi 支持的 `compact(customInstructions)`；
   不更换模型、不关闭推理或压缩设置，不提高冻结参数。
3. 给当前 Agent 一条短、可行动的续写反馈：只处理未完成部分，拆小工具参数，查询原结果，
   不重放已完成或未知效果的工具调用。
4. 累计恢复次数受源码上限约束；连续无可用压缩或仍然截断时明确停止，
   不因摘要出现或进程恢复重置计数，也不无限追加通用完成提示。
   Provider 内部反复 length 或只有压缩摘要、没有后续有效响应的循环同样有界，不能等不到 settled 就无限运行。

每个状态查询、压缩和续写前均调用
[Scheduler 恢复守卫](../apps/scheduler/src/pi-runtime-recovery-guard.ts)，复用既有
[完成执行状态](../apps/scheduler/src/domains/platform-api/completion-state.ts)：
精确活动 Attempt、原 lease/deadline、修正/请求/token 额度、已接受或预留终态与未知效果。
异步读取后再次检查本地完成/人工等待；最终 Control/Gateway 仍重新准入。
已接受人工等待、取消、超时、失效租约、预算耗尽或未知效果时不新增恢复请求。
此守卫是只读建议，不授予额外执行权或安全重放权限。
缺少守卫默认拒绝恢复；缺失 Attempt 身份与活动 Attempt 不匹配分别诊断，不混成一般 `inactive`。

## 压缩证据与诊断

`auto_compaction_start/end` 本身不证明可用摘要或上下文减小。
原生 compact 返回可用摘要是摘要观测，不等于 token 已减少；thinking-only、空摘要或报错
不能记为成功。后续有效响应可以证明恢复继续，但不能据此补造上下文变换的输入/输出 digest。

原生 Pi 数据没有完整 context/runtime 身份和连续变换摘要时，继续记录
`context.compaction_unknown`，不发布假的 `context.compacted` 或增加 `context_revision`。
严格证据契约仍由[上下文专题](AGENT_RUNTIME_CONTEXT.md)负责。

终止诊断保留原 `length`、内容形状/用量、冻结预算与实际 CLI 观测、恢复/压缩次数和具体停止原因；
使用稳定的 `PI_LENGTH_RECOVERY_EXHAUSTED`、`PI_COMPACTION_NO_PROGRESS` 或
`PI_LENGTH_RECOVERY_STOPPED`，而不是只剩“未提交最终摘要”。
诊断不复制原文本、工具参数、thinking 正文、凭据或 Provider 错误原文。
`last_length` 的观察字节数及 `text_projection_bytes` / `text_projection_sha256`，
以及 `last_compaction.summary_projection` 只描述 `observed_redacted_projection`；
它们不是原文或完整上下文的 digest。大 RPC 消息可能先投影为已归档的预览，
完整输出仍由受保护的运行流/Evidence 负责，不作为成功结果正文补回。
长度纠错后的既有瞬态错误进程续接与普通完成 nudge，也在启动进程、发新输入前重查同一守卫。

## Actions 验证入口

| 行为 | 入口与证据范围 |
| --- | --- |
| 发现限制、缺失/非法值、显式覆盖、完整 Job 创建/冻结与 Pi 投影 | `pnpm ci:unit:credential-compatibility`（实际 `gate-contract` 入口）；`pnpm ci:unit:provider-settings` 可定向执行同一预算回归。配置模型授权不被发现扩大，显式路由及未选中同名条目均覆盖 |
| text/tool/thinking-only length、有界继续、压缩无进展、身份和完成竞争 | `pnpm ci:unit:runtime-sandbox`；生产 runner + 确定性 Pi RPC 替身 |
| 精确 Attempt、lease/deadline/cancel/未知效果、终态读取竞争 | `pnpm ci:unit:executor-real`；复用真实完成状态规则，存储边界替身 |
| OpenAI 两种输出字段、实际 SDK 上下文 clamp 和 length | `pnpm ci:integration:request-budget-sdk`；锁定 Pi 1.5.2 SDK + loopback HTTP，不是真实厂商 |
| 生成后请求的原字节/字段保存、最终 Gateway 准入 | `pnpm ci:integration:platform-api`；隔离 PostgreSQL + HTTP 回归 |

入口已接既有 Actions 分片；命令存在不表示本次运行通过。工程验收以最终提交的全部适用检查为准。
真实上游容量、模型理解续写反馈的效果及生产链重跑未验证，不作为本次工程 PR 的额外生产前置。
需求追溯：FR-CRED-002、FR-JOB-009、FR-JOB-013、FR-JOB-014、IR-002。
