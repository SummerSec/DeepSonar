# TODO：Finding 自动多轮 Verify、Hub 回弹与收敛后 Report

> 状态：**核心已落地**（分支 `feat/verify-confirmed-hub-bounce`，2026-08-02）  
> 已实现：schema v11、多轮 Verify + 证据硬门、Hub 回弹、自动 Report、去掉人工 confirmed 旁路。  
> **收敛门（与 §0.3 一致）**：全部 Finding ∈ `{confirmed, needs_human}` 即可 Hub complete / Report；`minVerifySeverity` 只影响优先级与等待，**不**要求 care 级必须 confirmed。`needs_human` 进报告待人工章，SARIF 仅 confirmed。护栏耗尽收口为 needs_human 后可自动 Report。  
> **第一性原理**：任何 Finding 想成为技术 `confirmed`，唯一入口都是 Scheduler 自动创建的系统 `verify_finding`。Verify 负责基于多节点复核与实际测试证据判断能否确认；Verify 只提交 verdict 提案，Scheduler 校验证据门槛后才有权写入 `confirmed`。  
> **闭环目标**：Finding 自动验证；证据不足或验证未通过时强制回弹 Hub 补审、补测；所有 Finding 最终进入 `confirmed` 或 `needs_human`，且画布无活跃工作后，自动创建唯一 Report Job，整合本次全部 Finding 输出结论报告。  
> 相关：`apps/scheduler/src/core.ts`、`dispatcher.ts`、`reaper.ts`、`graph.ts`、`executor-real.ts`、`report.ts`、`routes.ts`、`database/schema.sql`、`apps/web`。  
> 前序：`TODO_VERIFY_PRIORITY_AND_CONVERGENCE_PLAN.md`；报告基础设计：`ROLE_CONFIG_AND_REPORT_PLAN.md` §8。

---

## 0. 本文最终语义

### 0.1 谁决定 confirmed

```text
Finding(pending)
  → Scheduler 自动创建 verify_finding
  → Verify 读取 Finding + 绑定到该 Finding 的复核/实测证据
  → Verify 提交 verdict 提案
       ├─ confirmed
       ├─ rework（协议兼容期可由 false_positive 映射）
       └─ needs_human
  → Scheduler 校验证据门槛
       ├─ verdict=confirmed 且证据门槛通过 → Finding.confirmed
       ├─ 证据不足、冲突或未通过          → Finding.pending + force Hub 回弹
       └─ 达到轮次/深度上限或确需人工      → Finding.needs_human
```

这里不是“Finding 先变成 confirmed 再触发 verify”，而是：

> **Finding 要进入 confirmed，必须先自动经过 verify；不存在人工、Hub、普通 Worker 或 API 直接写 confirmed 的旁路。**

角色边界保持不变：

- Verify Agent 负责专业判断并提交 verdict，仍然只是“提案者”。
- Scheduler 负责检查证据链、状态机、幂等、轮次限制，并执行最终落库。
- Hub 不能直接确认 Finding，也不能直接下发 `verify` 或 `report` 系统角色。
- 人工 disposition 不能把未验证 Finding 伪造成技术 `confirmed`。

### 0.2 多轮验证不是重复调用同一个模型

“经过多个节点多次复核、实际测试结论足够可行”必须体现为可审计证据链，而不是仅把同一段文本多问几次：

1. 原始 Finding 节点描述待验证假设。
2. 至少一个独立复核 Job 产生结构化 review 证据节点，且 Job 不能是原始 Finding 的产出 Job。
3. 至少一个实际测试 Job 产生结构化 test 证据节点，记录目标版本、环境、步骤、预期、实际结果和产物引用。
4. 最终 Verify Job 独立读取冻结的证据快照并提交 verdict。
5. Scheduler 检查证据来源、关联关系、完整性和冲突后，才接受 `confirmed`。

单纯“节点数量够了”不算通过；重复节点、同一 Job 自证、无步骤的口头结论、未绑定目标版本的测试结果都不计入确认门槛。

### 0.3 任务级闭环

```text
Hub 派发角色工作
  → emit_finding
  → 自动 Verify 第 1 轮
       ├─ 证据充分 → confirmed
       ├─ 证据不足/冲突/未通过 → force Hub 补审或补测
       │                           → 自动 Verify 第 N 轮
       └─ 无法自动闭环/超过护栏 → needs_human
  → 所有 Finding ∈ {confirmed, needs_human}
  → 无活跃普通角色 / Hub / Verify Job
  → Hub 最终 complete（Root: analysis_complete）
  → Scheduler 自动且幂等地创建 Report Job（Root: reporting）
  → Report 成功并校验产物（Root: succeeded）
```

Report 必须整合本次任务的**全部 Finding**：

- `confirmed` 进入已确认问题与风险结论；
- `needs_human` 进入“待人工确认 / 验证限制”章节；
- 不允许静默丢弃任何 Finding；
- Report Agent 不能创建新 Finding，也不能改变验证结论。

---

## 1. 现状缺口

| # | 当前行为 | 与目标的冲突 |
|---|----------|--------------|
| 1 | 只有达到 `minVerifySeverity` 的 Finding 自动派生 verify | 低级别 Finding 永远可能停在 `pending`，无法满足“全部 Finding 收敛后报告” |
| 2 | 一个 Finding 任意历史 verify 存在即永不再验 | Hub 补充证据后不能进入下一轮 Verify |
| 3 | 单次 Verify 可直接提交 `confirmed` | 没有可机器校验的“独立复核 + 实际测试”证据门槛 |
| 4 | `false_positive` / `needs_human` 只走普通图进度 | 未通过可能被 `auto_stopped` 或活跃 Job 挡住，无法回弹 Hub |
| 5 | verify Job `failed/timeout/orphan` 后 Finding 可卡在 `verifying` | 状态不闭环，Hub 和 Report 都无法继续 |
| 6 | 人工 `confirmed_vuln` 可把 `pending` 直接写成 `confirmed` | 绕过系统 Verify，破坏唯一确认入口 |
| 7 | Hub YAML 中 Finding 没有完整验证轮次和证据摘要 | Hub 不知道缺什么、上一轮为何被拒绝 |
| 8 | Report 目前只有角色种子、OpenAPI 草图和方案文档 | 没有 `task_reports`、派发器、产物校验和最终状态机 |

---

## 2. Finding 与 Verify 状态机

### 2.1 Finding 聚合状态

继续使用 `findings.verify_status` 作为面向产品的聚合状态：

| 状态 | 含义 | 是否允许 Report 门通过 |
|------|------|------------------------|
| `pending` | 尚未验证，或上一轮未通过、正在等待 Hub 补证 | 否 |
| `verifying` | 当前有且仅有一个活跃 Verify Job | 否 |
| `confirmed` | Verify 提交 confirmed，且 Scheduler 证据门槛通过 | 是 |
| `needs_human` | 自动闭环无法继续，已记录明确阻塞原因 | 是，但必须进入报告的待人工章节 |
| `false_positive` | 兼容旧数据；新流程不把它作为最终聚合终态 | 否 |

新写路径中，Verify 的否定或证据不足结论记录在“验证轮次”里，Finding 聚合状态回到 `pending` 并回弹 Hub。这样不会把一次未通过误当成整个 Finding 的永久终态。

### 2.2 验证轮次状态

新增稳定记录 `finding_verification_rounds`，不要只靠 `jobs.payload_json` 反推状态：

```sql
CREATE TABLE finding_verification_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  attempt int NOT NULL,
  verify_job_id uuid REFERENCES jobs(id),
  status text NOT NULL,
  proposed_verdict text,
  final_outcome text,
  requirements_json jsonb NOT NULL DEFAULT '{}',
  evidence_snapshot_json jsonb NOT NULL DEFAULT '{}',
  summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (finding_id, attempt),
  UNIQUE (verify_job_id),
  CHECK (status IN ('pending','running','rework','confirmed','needs_human','failed')),
  CHECK (proposed_verdict IS NULL OR proposed_verdict IN ('confirmed','rework','needs_human')),
  CHECK (final_outcome IS NULL OR final_outcome IN ('confirmed','rework','needs_human'))
);
```

`attempt` 是 Finding 级单调轮次；Job 重试和验证业务轮次不得混为一谈。

### 2.3 证据节点契约

扩展 `emit_fact` 的可选验证字段；只有携带当前 Job 由 Scheduler 注入的 Finding 绑定时才接受：

```ts
interface VerificationEvidence {
  finding_id: string;
  evidence_kind: "review" | "test";
  outcome: "supports" | "refutes" | "inconclusive";
  subject_revision: string;
  environment?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  artifact_refs?: Array<{ uri: string; sha256?: string }>;
  limitations?: string[];
}
```

Scheduler 的落地规则：

- 忽略 Agent 自报的项目、画布、Job 和角色身份，以当前 Job 上下文覆盖。
- 校验 `finding_id` 属于当前画布，且当前 Job 是该 Finding 的 Hub 回弹 follow-up。
- review/test 证据各自落为 Fact 节点，并建立 `Finding → Fact` 的 `reviewed_by` / `tested_by` 边。
- test 证据必须包含 `subject_revision`、步骤、预期和实际结果；缺字段只能作为普通 Fact，不计入确认门槛。
- 大型日志、截图、PoC 进入冷存储；节点只保存 URI、哈希和小型摘要。

### 2.4 confirmed 的 Scheduler 硬门

Verify 可以提议 `confirmed`，但 Scheduler 只有在以下条件全部满足时才接受：

1. 当前 Verify Job 成功结束，并调用 `mark_job_done` 提交合法 verdict。
2. 本轮证据快照至少包含一个合格 review 节点和一个合格 test 节点。
3. review 与 test 来自不同 Job，且都不是原始 Finding Job。
4. test 绑定到本轮 Finding 所指向的目标版本 / commit / 制品版本。
5. 至少一条合格 test 证据为 `supports`，包含可复核的实际结果或产物引用。
6. 不存在尚未解释的 `refutes` 证据；存在冲突时必须回 Hub，不得 confirmed。
7. 本轮使用的证据节点 ID 与哈希已冻结到 `evidence_snapshot_json`。

若 Verify 提议 `confirmed` 但硬门不满足，Scheduler 将本轮记为 `rework`，Finding 回到 `pending`，并以缺失条件清单触发 Hub。不能“降级放行”。

如果实际测试因权限、环境、破坏性风险或目标不可用而无法安全执行，Verify 不能确认；达到自动处理上限后转 `needs_human`，报告明确记录限制。

---

## 3. 自动 Verify 与 Hub 回弹

### 3.1 所有 Finding 自动进入 Verify

`evaluateFollowup` 的职责改为“自动验证准入 + 优先级”，而不是“按严重度决定验不验”：

1. 每个新 Finding 都必须自动创建第 1 轮 `verify_finding`。
2. `minVerifySeverity` 不再决定是否验证，只决定优先级和 Hub 是否等待高优先级批次。
3. critical/high 仍优先 claim；medium/low 在资源允许时继续验证。
4. 同一 Finding 同时最多一个活跃 Verify Job，由局部唯一索引或事务锁保证。
5. `suggest_verify` 保留兼容但不再影响派生决策。

需要新增局部唯一约束：

```sql
CREATE UNIQUE INDEX jobs_one_active_verify_per_finding
  ON jobs (finding_id)
  WHERE type = 'verify_finding'
    AND status IN ('pending','claimed','provisioning','running','waiting_human');
```

### 3.2 Verify verdict 的含义

控制 MCP 的新协议：

```ts
verdict: "confirmed" | "rework" | "needs_human"
```

- `confirmed`：Verify 判断证据足够；Scheduler 仍执行 §2.4 硬门。
- `rework`：证据不足、测试失败、结果冲突或当前假设需要改写；必须给出 `missing_evidence` 和建议动作。
- `needs_human`：只有明确的权限、安全、业务语义或环境阻塞才能提出，并提供原因。

兼容期内接受历史 `false_positive`，服务端统一映射为 `rework`，不再把它直接写成 Finding 的最终聚合状态。

### 3.3 回弹 Hub

以下情况必须清除 `auto_stopped`，并 `force` 触发 Hub：

| 情况 | Finding 聚合状态 | Hub trigger |
|------|------------------|-------------|
| verdict=`rework` | `pending` | `verify_rework` |
| 提议 confirmed 但证据硬门失败 | `pending` | `verify_rework`，附缺失条件 |
| verdict=`needs_human` 且尚未达到允许转人工的条件 | `pending` | `verify_rework` |
| Verify Job failed/timeout/orphan | `pending` | `verify_failed` |
| 自动轮次、followup 深度或 Hub 轮次达到上限 | `needs_human` | 不再自动发散，建立 human 节点 |

回弹触发 payload 至少包含：

```json
{
  "kind": "verify_rework",
  "finding_id": "...",
  "attempt": 2,
  "proposed_verdict": "rework",
  "missing_evidence": ["independent_review", "runtime_test"],
  "conflicting_evidence_node_ids": [],
  "summary": "..."
}
```

### 3.4 Hub 补证与再验

Hub 收到 `verify_rework` / `verify_failed` 后只能做两类决策：

1. 派发必要的 audit/review/test/code 等普通角色补充证据；每个 intent 必须携带当前 `finding_id` 和明确的证据目标。
2. 如果自动执行已无安全可行路径，说明阻塞并请求人工；Hub 不能直接把 Finding 写成 confirmed。

Scheduler 为这些角色 Job 冻结：

```json
{
  "verification_followup": {
    "finding_id": "...",
    "round_id": "...",
    "required_evidence": ["review", "test"]
  }
}
```

同一回弹轮次的补证 Job 全部进入终态后：

- 只要有新增合格证据，Scheduler 自动创建下一轮 Verify；
- 没有新增合格证据且仍可重试时，回 Hub 并明确“无增量证据”，避免原样循环；
- 达到 `maxVerificationRounds`、`maxFollowupDepth` 或 `maxHubRounds` 时，Finding 转 `needs_human`；
- Hub 不负责手动创建 Verify，避免出现第二个派生真相。

推荐新增单一护栏 `maxVerificationRounds`，默认 3。Job 的基础设施重试仍使用 `maxAutoRetries`，二者含义必须分开。

### 3.5 统一终态收口

在 `core.ts` 提供统一入口：

```ts
closeVerifyRound(tx, jobId, outcome)
```

它负责：

1. 锁定 Finding 与当前 round。
2. 幂等关闭 round，冻结证据快照。
3. 根据 verdict 和硬门计算最终 outcome。
4. 同步 Finding、Finding 节点、Verify 节点和验证边。
5. 需要时回弹 Hub、创建下一轮 Verify 或转 `needs_human`。
6. 调用任务级收敛检查，但绝不直接创建重复 Hub / Verify / Report Job。

`finalizeJob`、dispatcher catch、Reaper 的 timeout/orphan、人工 resume 都必须走这一入口。drain/cancel 也必须明确恢复 Finding 状态，不能遗留 `verifying`。

---

## 4. Hub 读图与 complete 门禁

### 4.1 图快照

`buildGraphSnapshot` 对每个 Finding 输出：

```yaml
- id: "finding-node-id"
  kind: "finding"
  verify_status: "pending"
  verification_attempt: 2
  latest_outcome: "rework"
  missing_evidence: ["runtime_test"]
  review_evidence_ids: ["..."]
  test_evidence_ids: []
  conflicting_evidence_ids: []
```

证据节点还要输出其 `finding_id`、`evidence_kind`、`outcome`、目标版本、产物引用和限制。Hub 必须能看见上一轮为什么没通过，才能派发非重复工作。

### 4.2 Hub complete 硬门

Hub 的 `submit_hub_decision.complete` 只是完成提案。Scheduler 在落地前检查：

1. 画布不存在活跃普通角色、Hub 或 Verify Job；
2. 画布至少执行过一次非 Hub 角色 Job，防止空图直接完成；
3. 每个 Finding 的 `verify_status` 都是 `confirmed` 或 `needs_human`；
4. 每个 `confirmed` Finding 都能追溯到通过证据硬门的 verification round；
5. 每个 `needs_human` Finding 都有结构化 blocker 和 human 节点；
6. 不存在等待回弹、等待补证或等待再验的 round。

不满足时拒绝 complete，不把 Root 写成 succeeded；Scheduler 返回缺口并触发必要的 Hub/Verify 流程。满足时只把 Root 置为 `analysis_complete`，随后调用报告派发器。

---

## 5. 全部 Finding 收敛后自动 Report

### 5.1 唯一派发条件

实现 `maybeDispatchReport(tx, canvasId)`，必须同时满足：

1. Root 状态为 `analysis_complete`；
2. 所有 Finding 均为 `confirmed` 或 `needs_human`；
3. 所有 `confirmed` 均有合法的最终 verification round；
4. 不存在活跃普通角色、Hub、Verify 或 Report Job；
5. 不存在未关闭的 verification round；
6. 当前画布没有已成功报告，且没有另一个正在生成的报告。

Hub complete、Verify 收口、人工处理和 Report retry 都可以调用该函数；数据库唯一约束保证最终只产生一个有效 Report Job。

### 5.2 状态机与幂等

```text
running
  → analysis_complete
  → reporting
  → succeeded
```

- 创建 Report Job 后 Root 进入 `reporting`。
- Report 成功且 `report.json` / Markdown / SARIF 校验通过后，Root 才进入 `succeeded`。
- Report 失败时 Root 保持 `reporting` 并展示错误，允许显式 retry。
- Report Job 使用稳定 `ingress_key='report:<canvas_id>'`；`task_reports.canvas_id` 唯一。
- Report Job 结束后禁止触发 Hub、Verify 或第二份自动报告。

### 5.3 报告输入与输出

Scheduler 从数据库确定性生成 `report-input.json`：

```json
{
  "task": {},
  "statistics": {},
  "findings": [
    {
      "id": "...",
      "verify_status": "confirmed",
      "final_verification_round": {},
      "review_evidence": [],
      "test_evidence": [],
      "limitations": []
    }
  ],
  "confirmed_findings": [],
  "needs_human_findings": [],
  "scope_and_coverage": {},
  "evidence": []
}
```

最终产物：

- `report.json`：结构化完整报告，包含本次全部 Finding；
- `report.md`：Report Agent 基于确定性输入撰写的总报告；
- `report.sarif.json`：Scheduler 只从 `confirmed` Finding 确定性生成；
- `needs_human` 不冒充漏洞结论，单列待人工确认、已有证据、缺失证据和影响范围。

即使没有 confirmed，也必须生成报告，并明确“本次未形成已确认漏洞”，同时列出所有 `needs_human`、覆盖范围和限制；不得宣称系统绝对安全。

---

## 6. 人工与 API 门禁

| 操作 | 新规则 |
|------|--------|
| disposition=`confirmed_vuln` | 仅 `verify_status=confirmed` 允许，否则 409 |
| 直接 PATCH `verify_status=confirmed` | 禁止；管理 API 也无旁路 |
| disposition=`rejected_fp` | 仅作为人工业务处置；不得伪造技术 confirmed，也不得绕过未收敛 round |
| Verify 达护栏后 | Scheduler 写 `needs_human` + human 节点 + blocker |
| 人工补充证据后 resume | 清除对应 blocker，回到 `pending`，自动进入新一轮 Verify |

前端需要：

- Finding 详情展示验证轮次、review/test 证据、缺失条件和冲突。
- 未经系统 Verify 的 `confirmed_vuln` 操作禁用并解释原因。
- `needs_human` 明确展示“可带补充证据恢复验证”。
- Task Canvas 展示 `Finding → review/test evidence → Verify → Hub/Report` 链。
- Report 页面区分“已确认问题”和“待人工确认”，不把二者合并计数。

---

## 7. 数据库与兼容迁移

本方案不再假设“无需改 Schema”。为保证多轮验证与唯一报告可恢复、可查询、可审计，需要：

1. 新增 `finding_verification_rounds`。
2. 新增 `task_reports`（按 `ROLE_CONFIG_AND_REPORT_PLAN.md` §4.6）。
3. 新增活跃 Verify 局部唯一索引和 Report 唯一键。
4. 在 `events` / `canvas_nodes.body_json` 保存小型引用，不复制大型证据。
5. 更新 `database/schema.sql` 基线并同步 bump `db.ts` 的 `SCHEMA_VERSION`；按本仓库规则重建数据库验证，不添加运行时增量迁移回退。

旧数据处理：

- `confirmed`：若没有可追溯 Verify Job 和证据 round，迁移为 `needs_human`，不能继续视为技术确认。
- `false_positive`：迁移为 `pending` 并等待新 Verify；若已有人工 `rejected_fp`，转 `needs_human` 并保留人工处置说明。
- `verifying`：根据活跃 Verify Job 对账；无活跃 Job 则回 `pending` 并触发恢复。
- 已有 Verify Job：按时间生成只读历史 round；没有结构化证据时不得作为新硬门下的 confirmed 依据。

---

## 8. 实现文件与顺序

### P0：唯一确认路径

1. `database/schema.sql` / `db.ts`：round、report、唯一索引、版本升级。
2. `shared-types` / `control-mcp.ts`：`rework` verdict 与结构化验证证据。
3. `core.ts`：所有 Finding 自动派 Verify、`closeVerifyRound`、confirmed 硬门。
4. `dispatcher.ts` / `reaper.ts`：失败、超时、orphan、cancel 全部接入统一收口。
5. `routes.ts`：删除人工 confirmed 旁路。

### P1：Hub 回弹与多轮补证

1. `graph.ts`：输出验证轮次、证据和缺口。
2. `executor-real.ts`：Verify/Hub prompt 对齐新协议。
3. `core.ts`：`verify_rework` / `verify_failed`、补证 Job 绑定、补证完成后自动再验。
4. Fake executor：覆盖 confirmed、rework、needs_human、证据硬门失败。

### P2：自动报告

1. 新增 `apps/scheduler/src/report.ts`：`maybeDispatchReport`、确定性输入、产物校验、SARIF。
2. `core.ts`：Hub complete 门禁与 `analysis_complete → reporting → succeeded`。
3. `routes.ts` / OpenAPI：报告元数据、Markdown、SARIF、retry。
4. `apps/web`：Report 节点、报告页和未决 Finding 章节。

### P3：文档与回归

1. 更新 `docs/ARCHITECTURE.md` 的 §4.3、§6、§8.3 和任务状态机。
2. 更新 `ROLE_CONFIG_AND_REPORT_PLAN.md`，以本文的多轮 Verify 和收敛门为准。
3. 保留 `minVerifySeverity` 作为优先级参数，删除其“决定是否验证”的旧描述。

---

## 9. 验证计划

### 9.1 状态机

- 新建 low/medium/high/critical Finding 均自动创建第 1 轮 Verify。
- 同一 Finding 并发触发只产生一个活跃 Verify。
- Verify 提议 confirmed，但缺 review 或 test 证据 → 不 confirmed，回 Hub。
- review/test 来自同一 Job → 不满足独立证据门槛。
- test 缺目标版本、步骤或实际结果 → 不满足门槛。
- 合格 review + test + Verify confirmed → Scheduler 写 confirmed。
- rework → Finding 回 pending、清 `auto_stopped`、force Hub。
- failed/timeout/orphan → Finding 不残留 verifying，并进入恢复流程。
- 超过验证轮次/深度/Hub 轮次 → needs_human + human 节点。

### 9.2 Report 门

- 任一 Finding 为 pending/verifying/legacy false_positive → 不创建 Report。
- 任一普通角色、Hub 或 Verify Job 活跃 → 不创建 Report。
- Hub 提前 complete → 被拒绝并返回未收敛 Finding 列表。
- 全部 Finding 为 confirmed/needs_human + 无活跃 Job + Hub complete → 自动创建唯一 Report。
- 并发调用 `maybeDispatchReport` → 只有一条 `task_reports` 和一个 Report Job。
- Report 输入包含全部 Finding；SARIF 只含 confirmed；Markdown 单列 needs_human。
- Report 失败可 retry，成功后 Root 才 succeeded。

### 9.3 命令

```bash
pnpm typecheck
pnpm build
pnpm ci:smoke:hub
pnpm ci:smoke:projects
```

新增手工冒烟脚本建议：

- `agent-harness/test-verify-rounds.mts`
- `agent-harness/test-report-flow.py`
- `agent-harness/test-verify-terminal-recovery.mts`

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Hub/Verify 在相同证据上循环 | round 记录证据快照哈希；无新增合格证据不得开启等价 Verify，达到上限转 needs_human |
| 为所有 Finding 自动验证导致队列膨胀 | 严重度只控制优先级；项目/全局并发上限不变；高危先执行，低危不跳过 |
| Agent 伪造“实测完成” | Scheduler 校验结构化字段、Job 上下文、目标版本和 artifact 引用；证据仍保留来源与审计轨迹 |
| 节点凑数通过硬门 | 要求不同 Job、不同证据类型、实际测试字段完整、无未解释冲突 |
| 基础设施失败烧光业务轮次 | `maxAutoRetries` 管 Job 重试，`maxVerificationRounds` 管业务复核，分别计数 |
| Report 提前生成 | Hub complete 与 `maybeDispatchReport` 双重门禁 + 数据库唯一约束 |
| needs_human 被写成已确认 | 报告和 SARIF严格分流；needs_human 不计入 confirmed 数量 |

---

## 11. 验收清单

- [x] 任何 Finding 都自动进入 Verify，不再由 severity 或 `suggest_verify` 决定是否验证。（`verify.evaluateFollowup`）
- [x] 任何技术 `confirmed` 都能追溯到 Verify Job、验证 round、独立 review 和实际 test 证据。（`closeVerifyRound` + 硬门）
- [x] Verify Agent 只提交 verdict；Scheduler 是唯一写入 confirmed 的执行者。
- [x] 证据不足、冲突、rework 和执行失败都会回弹 Hub，不会静默沉没。
- [x] Hub 补证完成后由 Scheduler 自动再次 Verify；Hub 不能直接派 Verify。
- [x] 到达护栏而无法确认的 Finding 进入 needs_human，并留下 blocker 与 human 节点。
- [x] Hub complete 只有在全部 Finding 为 confirmed/needs_human 且无活跃工作时才成立。
- [x] 收敛后自动且幂等地触发唯一 Report Job。
- [x] 报告整合本次全部 Finding，confirmed 与 needs_human 明确分栏，SARIF 只含 confirmed。
- [x] Report 成功前任务不进入 succeeded。
- [ ] 前端 Finding 详情展示验证轮次 / 禁用未验证 confirmed_vuln（API 已 409）。
- [ ] 重建 DB（schema v11）后跑 `pnpm ci:smoke:hub` / `ci:smoke:projects`。

