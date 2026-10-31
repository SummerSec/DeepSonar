# 0004. Fact 信任态与 Finding 技术验证、人工处置分责

> 状态：**已采纳（历史回填）**。本文记录 Fact/Finding 分责和 Fact-first 门禁，不新增验证策略。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[Issue #387](https://github.com/SummerSec/DeepSonar/issues/387)；实现核验见 [`database/schema.sql`](../../../database/schema.sql)、[`verify.ts`](../../../apps/scheduler/src/verify.ts)

## 背景

工作角色可以观察代码、工具和运行结果，但它的陈述本身不能成为确认 Finding 的唯一证据。Fact 是过程中的观察或验证证据，Finding 是可查询的风险投影，Finding 的技术验证和人的业务处置又有不同生命周期。把这些状态合并会让普通观察直接改变确认门禁，也会让人工处置覆盖技术证据。

当前 schema 为 Canvas Fact 保存独立 `verification_status`，为 Finding 保存 `verify_status` 和 `disposition`，并持久化 Finding verification round。`emit_fact`/`emit_finding` 先写 Artifact，Finding 由 Artifact 投影；Verify 读取归属正确、版本匹配的结构化 Fact、Artifact、Evidence 和独立 Evaluation。Fact 信任态迁移的 owner 是人工 `jobs:control`；Agent `emit_fact` 只产生 `unverified`，`verifying` 仅用于导入/历史可读状态，人不能写入该状态。实现和测试见 [`domains/canvas/fact-verification.ts`](../../../apps/scheduler/src/domains/canvas/fact-verification.ts)、[`domains/artifacts/model.ts`](../../../apps/scheduler/src/domains/artifacts/model.ts)、[`verify-fact-gate.ts`](../../../apps/scheduler/src/verify-fact-gate.ts)。

## 决策

1. Fact 的 `verification_status` 只表达证据的信任态；Finding 的 `verify_status` 只表达技术验证收口；Finding 的 `disposition` 只表达人的处置。三者不得互相隐式改写。
2. Fact 信任态的 owner 是人工 `jobs:control`。Agent 提交 Fact 时只能产生 `unverified` 观察；`verifying` 仅可由导入/历史路径保留和读取，不能作为人工写入状态。人工迁移必须遵守既有转换规则；已拒绝 Fact 不能直接回到已验证，必须经过显式人工重开路径。
3. Finding Verify 只消费允许的结构化 Fact、Artifact、Evidence 和独立 Evaluation，不从 maker 文本、标题或普通 verdict 推断确认。
4. Fact-first v1 的确认门禁必须校验 Finding UUID、subject revision、归属、来源 Job、结构化 expected/actual/outcome、冲突和缺项；门禁失败进入补证、refuted、inconclusive 或人工路径。
5. `emit_finding` 的内部写入真相是 Artifact；Finding、SARIF 和报告是确定性投影。投影失败不能改写 Artifact、Fact 或验证账本。

## 状态

当前状态为已采纳。本文件于 2026-10-15 回填，原始决策日期未核实。当前安全 profile 可叠加更严格的 review/test、impact 或 proof 要求，但通用 Fact-first 规则不因某个专项 profile 被静默改写。改变职责或确认门禁需另开 ADR。

## 后果

- 正面：观察、证据可信度、技术确认和业务处置可以独立审计；Verify 不会把工作角色的自述当作独立证明。
- 代价：一次 Finding 需要维护 Artifact、Fact、verification round、Evidence snapshot 和投影关系；冲突或版本变化会保守地等待补证。
- 处理边界：缺少工具、目标、设备或运行证据时必须记录限制并使用 `inconclusive`/`rework`/`needs_human`，不能伪造确认。
- 验收：[`fact-verification.test.ts`](../../../apps/scheduler/src/domains/canvas/fact-verification.test.ts)、[`fact-verification.integration.test.ts`](../../../apps/scheduler/src/domains/canvas/fact-verification.integration.test.ts)、[`verify-fact-first.test.ts`](../../../apps/scheduler/src/verify-fact-first.test.ts)、[`verify-gate-590.test.ts`](../../../apps/scheduler/src/verify-gate-590.test.ts) 和 [`artifacts.integration.test.ts`](../../../apps/scheduler/src/domains/artifacts/artifacts.integration.test.ts) 覆盖合法、非法、冲突、版本错配和投影路径。

## 替代方案

以下替代方案是本次回填的当前分析，不冒充历史会议结论：

- 直接把 Finding 的 `confirmed` 当作所有 Fact 已验证：会丢失单条证据的来源和信任态，因此不选。
- 让 maker 文本 verdict 直接关闭 Verify：无法证明独立性、版本和反证尝试，因此不选。
- 让人工处置覆盖技术验证：会把业务决定误当成事实确认，因此不选。
