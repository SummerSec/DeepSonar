# AI-native 可信执行内核与插件组合工作流

> 状态：长期设计提案，尚未整体落地。当前实现仍以 `DESIGN.md`、`docs/ARCHITECTURE.md`、代码、schema 与 OpenAPI 为准。
> 关联：[#443](https://github.com/SummerSec/DeepSonar/issues/443)、[#444](https://github.com/SummerSec/DeepSonar/issues/444)、[#445](https://github.com/SummerSec/DeepSonar/issues/445)、[#446](https://github.com/SummerSec/DeepSonar/issues/446)。

## 1. 设计判断

DeepSonar 的长期方向是：

> **一个最小、可信、可审计的执行内核；模型通过受治理插件动态组合计划、工具、验证策略和交付投影。**

“一切皆插件”只适用于业务能力和表达方式。沙箱、权限、租约、资源、幂等、证据来源、账本和未知副作用处理必须留在内核。插件可以改变模型如何完成目标，但不能改变系统如何证明、限制和记账。

当前 Hub、Worker、Fact/Finding、Verify、Report 闭环是可运行的 as-built 主路径。本文描述逐步演进的目标边界，不把未来协议误写成现有实现，也不要求一次重写 Scheduler。

## 2. 内核与插件的职责边界

| 能力 | 可信内核拥有 | 插件/模型可以提出 |
|---|---|---|
| 执行 | 沙箱、进程、网络、凭据、镜像 digest、Job/Attempt 生命周期 | 使用哪些能力、工具和运行时需求 |
| 控制 | capability token、operation allowlist、租约、取消、预算 | Plan、子任务、依赖、验证策略和完成理由 |
| 数据 | Artifact/Evidence 来源、版本、完整性、幂等和审计 | Claim、领域字段、证据引用和关系 |
| 副作用 | 事务、Proposal/Receipt/Settlement、未知效果和重放策略 | 业务目标和预计收益 |
| 交付 | Projection 执行、导出边界、权限与审计 | Finding、SARIF、报告或外部对象的投影请求 |
| 质量 | 评估契约、回放、指标、准入和回滚 | 领域评估器和候选策略 |

模型不能直接修改数据库、容器、凭据、镜像准入、Job 快照、权限、账本或已发生但结果未知的外部效果。插件只能申请权限；内核按冻结 Job 身份、项目范围和安全策略授予权限。

## 3. 稳定的最小协议

插件接口围绕少数长期稳定的概念，而不是继续扩张角色枚举：

- `Capability`：插件可以做什么，以及需要哪些工具、权限、镜像、网络和资源。
- `Plan`：模型希望完成什么，如何拆分、依赖和验证。
- `Artifact`：模型提出的事实、Claim、假设和关系。
- `Evidence`：观察结果的不可变引用、来源、摘要和完整性。
- `Evaluation`：对 Artifact/Claim 的独立评估、冲突和结论。
- `Projection`：把内部对象投影为 Finding、SARIF、报告或外部系统对象。

现有 `explore/analyze/review/test/code/audit` 保留为内置 capability pack 的默认组合；它们不再是未来模型必须服从的唯一工作流分类。现有 `agent_roles`、RoleConfig、CLI adapter 和运行时镜像可以先作为插件实现，不建立第二套执行通道。

## 4. Plan 与能力组合

未来的 Plan 至少包含：

```ts
type Plan = {
  objective: string;
  assumptions: string[];
  tasks: Array<{
    id: string;
    purpose: string;
    capability: string;
    prompt: string;
    depends_on: string[];
    input_refs: string[];
    expected_outputs: string[];
    verification: string[];
    budget?: { tokens?: number; wall_time_sec?: number };
  }>;
  completion: {
    statement: string;
    required_evidence: string[];
    unresolved: string[];
  };
  budget: { tokens?: number; wall_time_sec?: number; sandbox_count?: number };
};
```

计划由平台校验 schema、引用、依赖环、capability 权限、预算和沙箱可执行性。模型拥有业务上的继续、收敛、阻塞和人工请求判断，但不能突破硬上限。

`maxHubRounds`、followup depth、token、wall time、并发、租约和沙箱限制的长期语义应分开：前两者是防失控的预算护栏，后者是执行安全边界。它们不能单独替模型证明“业务上已经完成”。这与 #443 的 Plan/Convergence 方向一致。

第一阶段可以把当前 Intent 适配成单个 `PlanTask`，把现有 Hub 行为作为默认 Plan。等新协议经过回放验证后，再允许模型组合多个能力包。

## 5. Artifact-first 与投影

内部写入真相应逐步从 Finding 转为版本化 Artifact。Artifact 核心字段只负责身份、版本、Claim、证据、关系、状态和 provenance；安全、质量、合规等领域字段放在带 namespace 的扩展中。

```ts
type Artifact = {
  id: string;
  kind: string;
  schema_version: string;
  claims: Array<{
    statement: string;
    subject_ref?: string;
    expected?: unknown;
    actual?: unknown;
    status: "supported" | "contradicted" | "unknown";
    evidence_refs: string[];
  }>;
  relations: Array<{ type: string; target_ref: string }>;
  evidence_refs: string[];
  status: "proposed" | "supported" | "contradicted" | "confirmed" | "rejected";
  provenance: { job_id: string; attempt_id: string; source_revision: string };
  extensions?: Record<string, unknown>;
};
```

一个 Artifact 可以同时包含支持证据、反驳证据和未决假设。Verify 消费 Artifact、Claim、Evidence 和独立 Evaluation，不覆盖原始 Artifact。Finding、SARIF、Task Report 和外部集成都是确定性 Projection；投影失败不能破坏内部事实和验证账本。

迁移期 `emit_finding` 可以作为兼容入口，但必须先转换为 Artifact。不得同时维护两个独立事实源。旧 Finding UUID 可作为投影身份保留，以避免历史链接断裂。

## 6. 统一失败、修复与重试语义

每个插件操作、Plan 提交、Artifact 写入、Verify 调用和 Runtime Adapter 都必须归入四类：

| 分类 | 内核动作 | 模型是否可修复 |
|---|---|---|
| `model_correctable` | 返回字段级修复上下文，在同一 Session 继续 | 是 |
| `transient_retryable` | 有界退避，保留同一 Attempt/Session 语义 | 通常是，平台自动恢复 |
| `unknown_external_effect` | 停止自动重放，进入对账、orphan 或人工处理 | 不能猜测重放 |
| `permanent_failure` | fail closed，给出配置、权限、版本或快照修复指引 | 需外部修复 |

### 6.1 RepairFeedback

`model_correctable` 不能只返回 `invalid_payload`。统一反馈至少包含：

```ts
type RepairFeedback = {
  category: "model_correctable" | "transient_retryable" |
    "unknown_external_effect" | "permanent_failure";
  code: string;
  operation: string;
  path?: string;
  message: string;
  expected?: unknown;
  observed_shape?: unknown;
  current_state_ref?: string;
  accepted_effects?: Array<{ effect_id: string; status: string }>;
  idempotency_key: string;
  proposal_revision: number;
  repair_attempt: number;
  remaining_budget: { attempts?: number; tokens?: number; wall_time_sec?: number };
  next_action?: string;
};
```

反馈必须脱敏：`expected` 描述允许的协议形状，`observed_shape` 默认只保留类型、长度、计数和摘要；不能把 provider 原始响应、凭据、完整不可信输入或内部秘密直接注入模型。

### 6.2 同会话修复闭环

一次提案的内核状态应能表达：

```text
proposed
  → rejected_with_guidance
  → corrected
  → revalidated
  → accepted
  → durably_recorded
  → effect_settled
```

收到 `model_correctable` 后，Completion Gate/Runtime Adapter 应把上一轮的失败原因、失败字段、当前可引用状态、已接受效果和剩余修复预算重新组织给同一 Session。模型可以重新读取 catalog、node reference、capability 或 Artifact，再提交新的 proposal revision。

“直到成功”不是无限重试：同一 Session 受 repair attempt、token、时间、事件额度和副作用预算限制。预算耗尽时必须明确进入 `blocked` 或 `needs_human`，保留修复检查点和完整反馈；不能重复发送相同错误后静默杀死 Job，也不能把失败伪装成成功。

## 7. Proposal、Receipt、Settlement 与现有 Attempt/effect

现有 Job/Attempt/effect 边界是可信内核的基础，不应绕过：

- 每个 Job 领取建立 Scheduler-owned Attempt；Job 状态和 Lease 仍由 Scheduler 判定。
- 外部动作先在 `job_attempt_effects` 写 intent 与 `effect_pending`，观察结果后写 settlement。
- `replay_policy=never` 与 `unknown` 继续适用于无法确认的外部效果；重启不能凭猜测重放。
- `accepted` 的长期含义应升级为已经写入可查询、可幂等判断的 durable Receipt，不只是 `executor-real` 内存中的 deferred bundle。
- Receipt 至少绑定 `job_id`、`attempt_id`、operation、proposal revision、idempotency key、输入摘要、权限快照和待结算 effect。
- Receipt 持久化成功后才允许推进延迟语义副作用；Settlement 记录实际结果或 `unknown`。

因此，模型提案失败可修复，但一旦发生未知外部效果，系统必须停止自动重放并交给 reconcile/Reaper/人工恢复。新协议不能把 `effect_pending`、`unknown`、`orphan` 重新解释为普通模型错误。

## 8. 插件 Manifest 与准入

插件 Manifest 至少声明：

- `id`、版本、schema 版本和不可变 digest；
- capability、operation 和所需权限；
- 输入/输出 Artifact、Evidence、Projection schema；
- CLI、工具、镜像、网络和凭据需求；
- token、时间、并发和沙箱资源预算；
- 错误码分类、重试条件和 `replay_policy`；
- 依赖、兼容矩阵、评估器和回滚版本。

准入标准不是“插件可以启动”，而是“插件的错误可反馈、模型可修正、成功可落账”。每个插件或插件组合必须在平台同款 runtime image 和 Job-scoped API 中通过：

1. manifest、版本、依赖、权限和 digest 校验；
2. 正常输入执行与 Artifact/Evidence 落库；
3. schema 错误得到结构化 `RepairFeedback`；
4. 模型按反馈修正并重新提交成功；
5. 重复提交、幂等、限流、冲突和过期 token；
6. timeout、进程退出、网络 429/5xx 和同会话恢复；
7. `effect_pending`、响应前崩溃、响应后崩溃和 settlement 丢失 failpoint；
8. 越权、路径越界、凭据泄露、prompt injection 和恶意 Artifact；
9. 终态、审计、指标、回放和销毁清理。

### 8.1 Crash matrix

| 崩溃窗口 | 允许结论 | 恢复动作 |
|---|---|---|
| Proposal receipt 写入前 | 无接受提案 | 同一 Session 可重新提交，使用新 revision/idempotency key |
| Receipt 写入后、effect 执行前 | 提案已接受，效果未开始 | 由 Scheduler 依据 receipt 继续一次 |
| `effect_pending` 写入后、外部响应前 | 外部效果未知 | settlement=`unknown`，禁止自动重放，转对账/orphan |
| 外部响应后、settlement 前 | 外部效果未知 | 同上；保留 effect id 和诊断上下文 |
| settlement 写入后 | 效果已落账 | 幂等读取 receipt/settlement，不重复执行 |
| Agent 进程退出但 receipt 已落账 | 提案不丢失 | 恢复或新 Attempt 读取检查点，不能凭空新建副作用 |

## 9. 读图、上下文与安全边界

模型可以逐步从平台查询状态，但查询本身仍是 Job-scoped capability：默认提供摘要、`search_nodes`、`get_node`、`get_neighbors`、`get_evidence`、`get_conflicts` 和历史/经验检索；每次返回带 revision、来源和预算信息。

现有 `buildGraphSnapshot`、GraphScope、整图字符预算和 canonical UUID 校验继续作为兼容与安全底座。逐步从“平台将全图 YAML 塞入 prompt”转向“模型主动查询需要的状态”，但不能让模型读取其他项目、未授权 evidence、凭据或原始控制面秘密。`graph_delta` 只改变上下文传输成本，不改变 Canvas、events、evidence 的权威性。

## 10. 分阶段实施路线

### Phase 0：失败基线与回放

- 盘点 Control API、Runtime Adapter、Attempt/effect、Hub/Verify/Report 的错误路径。
- 收集并结构化历史样本：#57、#107、#120、#126、#128、#131、#137、#166、#200、#332 等。
- 对每个样本标注四类错误、反馈是否可修复、是否有已接受副作用和最终状态。
- 建立回放夹具与修正成功率、重复错误率、unknown effect 等基线，不改变线上语义。

### Phase 1：统一 RepairFeedback

- 在 `packages/shared-types` 定义版本化结果契约。
- 让 Control API、Plan、Artifact、Verify 和 Runtime Adapter 使用同一反馈 Envelope。
- 保留已有稳定错误码，补充 path、expected、current state、accepted effects、repair budget 和 next action。
- 统一 Completion Gate，使 nudge 带上真实失败上下文而不是固定催促语句。

### Phase 2：Proposal/Receipt/Settlement

- 以现有 `job_attempt_effects` 为边界增加 proposal revision、receipt 和修复检查点。
- 将当前只存在于内存中的 deferred semantic state 逐步改为可查询账本。
- 所有副作用继续走 event-ingestion 与 Scheduler 事务；禁止并行控制文件或第二套 API。
- 为重启、取消、迟到回调和未知窗口补齐 reconcile/Replay policy 测试。

### Phase 3：Plan 与 Capability Pack

- 引入版本化 `Plan/PlanTask/CompletionPolicy/PlanResult`。
- 把现有角色包装为内置 capability pack，先保持旧行为。
- 支持模型声明依赖、预期输出、验证路径、预算和 `complete/continue/blocked/needs_human`。
- 将角色、Hub 意图与硬阈值从业务流程作者降为可组合默认策略和安全预算。

### Phase 4：Artifact-first

- 增加 Artifact、Claim、Evidence、Evaluation 和 Projection 契约。
- `emit_finding` 先写 Artifact，Finding/SARIF/报告由确定性投影生成。
- Verify 消费 Artifact + 独立 Evaluation；迁移期旧 API 只做 projection 读取。
- 禁止新代码形成 Artifact 与 Finding 双重事实源。

### Phase 5：跨任务经验、评估与成本

- 记录计划、失败反馈、修正次数、最终结果、人工介入、token、时间和沙箱成本。
- 从 confirmed/rejected/needs_human 与人工修正生成带来源、版本、置信度和过期时间的 Experience。
- Hub 计划前召回经验；模型在预算内判断继续验证、改策略或收敛。
- 固定评估集比较模型、Prompt、Skill、capability pack 和验证策略，策略上线可回滚。

## 11. 验收与运营指标

阶段验收至少覆盖：

- 可修正错误统一返回脱敏、字段级、可执行反馈；模型能在同一 Session 修正并成功提交。
- `accepted` 的 proposal 可查询、可幂等判断，不因进程退出静默丢失。
- `unknown_external_effect` 不会被自动重复执行；所有 Job 最终进入 `succeeded`、`blocked`、`needs_human` 或 `failed`。
- 新插件通过正常执行、错误修复、幂等、恢复、越权和 crash matrix；运行后资源、Token、Attempt 和副作用均可核对。
- 回放可解释模型提交了什么、平台拒绝了什么、模型如何修正、哪些效果已 settlement。

至少观测：修正成功率、平均修正轮数、重复错误率、错误后最终成功率、unknown effect 数量、插件失败原因分布、Verify 分歧率、Finding 确认/误报率、人工介入率、每 Finding 成本和缺陷逃逸率。

## 12. 非目标与设计纪律

- 不移除沙箱、权限、租约、幂等、审计、Reaper、fail-closed 或 `replay_policy=never`。
- 不允许模型修改 Job 快照、镜像准入、凭据和最终账本状态。
- 不一次性重写 Scheduler，不引入与现有 event-ingestion 平行的副作用路径。
- 不把自我批判、多路径多数决或模型置信度当作客观证据；它们必须产生可追溯 Evaluation，并接受内核完整性校验。
- 设计落地时遵循仓库的 schema 基线纪律：改表即修改 `database/schema.sql`、bump 版本、重建并验证；本文本身不改变 schema。

## 13. 与当前文档和 Issue 的关系

- #443 负责模型主导的 Plan、动态子任务和收敛判断；本文补足其失败修复、Receipt 和内核边界。
- #444 负责 Artifact-first、Claim/Evidence 和 Projection；本文补足插件准入和副作用一致性。
- #445 负责跨任务 Experience、指标、回放和成本感知；本文把失败反馈和修正轨迹纳入经验来源。
- #446 是本设计总单；后续实现、代码事实、阶段验收和失败复盘应在该 Issue 评论或关联 PR 中追加。
- `DESIGN.md` §5.1 的 Job/Attempt/effect、§8 的 events/evidence/bus 分层和 §13 的 D1–D6 是当前可信边界；本文只能在这些边界之上演进，不能以插件化绕过它们。
