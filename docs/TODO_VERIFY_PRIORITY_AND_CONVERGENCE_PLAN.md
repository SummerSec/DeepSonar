# TODO：Verify 优先级 + 可配置收敛门 + 人工停决策

> 状态：已收敛为单一旋钮（2026-08）  
> **第一性原理**：用户只配 `minVerifySeverity`（最低关注级别）。  
> 派生写死：≥ 该级别 → 自动 verify；Hub 等它们；验完停自驱；调度永远高危优先。  
> 背景：`java-sec-code` 全量审计扇出过大；多旋钮配置违背第一性原理后已砍掉。  
> 相关：`apps/scheduler/src/core.ts`、`apps/web` Settings / 画布。

---

## 0. 目标与非目标

### 目标

1. **高危 Finding 优先进入 verify 队列**（critical/high 先于 medium/low）。
2. **恢复并强化 severity 门槛**：不是每条 finding 都自动 verify。
3. **confirmed 触发 Hub 可配置**，不再默认「一条 confirmed 立刻 force、绕过等 verify」。
4. **收敛门可配置**：例如「priority 档（默认 high+critical）全部 verify 终态后即可停自驱」；更低 severity 可继续跑、可丢弃、或不再阻塞 Hub。
5. **人工可随时选择停止决策任务**（停新 hub / 停新 intent / 只 drain 高危 verify）。

### 非目标（本阶段不做）

- 不改 Agent 协议（仍只提案，调度器决策）。
- 不引入增量 schema migration（规则进 `config_json.rules` / `global_settings.rules_json` JSONB）。
- 不在本阶段做跨 intent 语义近重去重（可单列 follow-up）。

---

## 1. 现状问题：「evaluateFollowup 忽略 severity」

### 含义

项目 / 全局配置里虽有 `autoVerifySeverities`，且 `rulesForProject` 会读入 `ProjectRules`，但 **`evaluateFollowup` 派生 verify 时不根据 severity 过滤**。

当前逻辑大致只检查：

- `followup_depth` 是否 ≥ `maxFollowupDepth`
- 同 finding 是否已有 `verify_finding`
- 父 job followup 数是否 ≥ `maxFollowupsPerJob`

注释写明：

> Finding 必须经过验证后才能进入后续决策，**不再让人或 severity 配置决定是否验证**。

因此：

| 预期 | 实际 |
|------|------|
| 只自动验 high/critical | 所有 severity 都自动验 |
| 设置页去掉 low 能少刷队列 | **改了也没用** |
| `autoVerifySeverities` 生效 | 对派生路径是**死配置** |

### 其它相关问题

| 现状 | 问题 | 目标行为 |
|------|------|----------|
| claim 只按 `priority DESC, created_at` | 高危与低危同队先到先得 | verify job 按 severity 加权 priority |
| confirmed → `forceHubReview=true` 绕过 active verify 等待 | 验证未完就二次发散 | 默认改为门控/批量；immediate 仅可选 |
| 无任务级「停决策」 | 只能 cancel 单个 job | 画布级收敛开关 + 策略模式 |
| 无「high 验完即可停」 | 必须等全部 verify 或靠 maxHubRounds 硬切 | `hubWaitSeverities` 定义阻塞门 |
| `maxHubRounds` 计 failed/orphan | 基础设施失败吞收敛预算 | Phase 2：仅计 succeeded（或可配置） |

---

## 2. 规则模型（配置面）

在现有 `ProjectRules` 上扩展（全局 → 项目三级回落不变）：

```ts
type Severity = "critical" | "high" | "medium" | "low" | "info";

interface ProjectRules {
  // —— 已有，恢复为真实门控 ——
  autoVerifySeverities: Severity[];   // 自动派生 verify 的 severity 集合
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  hubEnabled: boolean;
  maxHubRounds: number;
  maxIntentsPerDecision: number;
  // ... timeouts / allowEgress 等

  // —— 新增：Verify 策略 ——
  /** claim 时是否按 severity 抬升 verify job 优先级；默认 true */
  verifySeverityPriority: boolean;

  // —— 新增：Hub / 收敛策略 ——
  /**
   * confirmed 后如何触发 Hub：
   * - immediate: 现状，立刻 force（绕过 wait）
   * - gated: 仅当「门控 severity」无活跃 verify 时才触发（推荐默认）
   * - batch: 聚合同一画布的 confirmed，debounce 后一次 Hub
   * - off: confirmed 不单独触发；只走普通 graph_progress
   */
  confirmedHubMode: "immediate" | "gated" | "batch" | "off";

  /**
   * Hub 等待门：哪些 severity 的 verify 算「必须跑完才允许非 force / gated Hub」。
   * 例：["critical","high"] → medium/low 的 pending verify 不阻塞 Hub。
   * 默认 = autoVerifySeverities ∩ {critical, high}，若为空则回落 autoVerifySeverities。
   */
  hubWaitSeverities: Severity[];

  /**
   * 自驱停止策略（自动，不替代人工停）：
   * - never: 仅靠 maxHubRounds / hubEnabled / 人工
   * - after_wait_gate: 门控 severity 的 verify 全部终态，且无活跃角色 job 时，不再自动 maybeTriggerHub
   * - after_all_auto_verify: autoVerifySeverities 全部终态后停
   */
  autoStopMode: "never" | "after_wait_gate" | "after_all_auto_verify";

  /** batch 模式 debounce 秒数；默认 60 */
  confirmedHubBatchSec: number;
}
```

### 推荐默认（针对全量审计靶场）

| 字段 | 推荐默认 | 含义 |
|------|----------|------|
| `autoVerifySeverities` | `["critical","high"]` | 只自动验高危 |
| `verifySeverityPriority` | `true` | critical > high > … |
| `confirmedHubMode` | `gated` | 不再每条 confirmed 立刻 force |
| `hubWaitSeverities` | `["critical","high"]` | **high 全验完即可放行/可停** |
| `autoStopMode` | `after_wait_gate` | 门控验完 + 无活跃 worker → 停自驱 |
| `confirmedHubBatchSec` | `60` | batch 模式用 |
| `maxFollowupsPerJob` | `8`（可另调） | 防止单 audit 打满 20 |

> 「策略比例」落地为 **severity 集合 + 门控集合**，而不是 0–100% 百分比：百分比难解释、难审计；集合与门控和 SARIF severity 一致。若以后要「只验 top N」，可再加 `maxAutoVerifiesPerJob`。

---

## 3. 运行语义（调度器）

### 3.1 派生：高危才自动 verify

`evaluateFollowup` 恢复门控：

```
if severity ∉ autoVerifySeverities → 不派生 verify（finding 保持待人工 / 未自动验证）
if 已有同 finding 的 verify → 跳过
if parent followups ≥ maxFollowupsPerJob → human 节点（保持）
else → 创建 verify_finding，priority 按 severity 加权
```

**Severity → priority 建议（叠在 parent.priority 上）：**

| severity | delta |
|----------|-------|
| critical | +40 |
| high | +30 |
| medium | +10 |
| low | +0 |
| info | -5 |

dispatcher 已有 `ORDER BY priority DESC, created_at`，**无需改 claim SQL 结构**，只改建 job 时的 priority。

medium/low 不在 `autoVerifySeverities` 时：

- 不进自动队列
- UI 可「手动创建 verify」→ 人工点名的 verify 仍可跑，priority 同样按 severity

### 3.2 Hub 等待门（替代「等所有 verify」）

`maybeTriggerHub`：

**旧逻辑：**

- 非 force：任意 `verify_finding` active 就 return
- force（confirmed）：完全绕过

**新逻辑：**

```
activeBlockingVerify =
  verify_finding active
  AND finding.severity ∈ hubWaitSeverities

if confirmedHubMode == immediate && options.force:
  // 兼容旧行为，仍绕过
elif options.force && confirmedHubMode == gated:
  if activeBlockingVerify: return   // 只等 high/critical
elif options.force && confirmedHubMode == batch:
  记入 canvas 待审 confirmed 集合；debounce 后统一 trigger
elif options.force && confirmedHubMode == off:
  force = false，走普通路径
else:  // 普通 graph_progress
  if activeBlockingVerify: return
  // medium/low pending 不再挡住 Hub
```

「全部执行 verify high 之后即可停止/放行」由 `hubWaitSeverities=["critical","high"]` 表达。

### 3.3 自动停止自驱（autoStopMode）

在 `maybeTriggerHub` 入口增加画布级判断：

```
if canvas.convergence.hub_paused: return
if autoStopMode != never:
  if 门控 severity 的 verify 均已终态
     AND 无活跃 non-hub 角色 job（策略可配）
     AND 本轮不是人工 resume 强制:
       标记 canvas.convergence.auto_stopped = true
       return  // 不再自动开 hub
```

**停止 ≠ 杀光队列：**

- 默认：**停新 Hub / 停新 intent 派生**
- 已 running 的 job 跑完
- pending 的 **非门控** verify：可配置 `onAutoStop: "leave" | "cancel_non_gate"`

推荐默认 leave；UI 提供「清理低优先级 verify」一键。

### 3.4 人工选择「决策任务停止时间」

画布级状态（优先 JSONB 自由区，免 bump `SCHEMA_VERSION`），建议落在 `canvases` 的扩展字段或 `target_json` 旁的 control 区：

```ts
interface CanvasConvergence {
  /** 人工暂停自动 Hub */
  hub_paused: boolean;
  paused_reason?: string;
  paused_at?: string;
  /** 自动停止是否已触发 */
  auto_stopped: boolean;
  /** 覆盖项目规则的本画布策略（可选） */
  override?: Partial<Pick<ProjectRules,
    "confirmedHubMode" | "hubWaitSeverities" | "autoStopMode" | "autoVerifySeverities">>;
  /** batch 模式：待 Hub 处理的 confirmed finding ids */
  pending_confirmed_ids?: string[];
}
```

**API（任务/画布操作）：**

| 接口 | 作用 |
|------|------|
| `POST /canvases/:id/convergence/pause` | 立即停自动 Hub（决策停止） |
| `POST /canvases/:id/convergence/resume` | 恢复自驱；可选 `force_hub: true` 立刻开一轮验收 |
| `POST /canvases/:id/convergence/stop-after-gate` | 套用「门控验完即停」 |
| `POST /canvases/:id/convergence/drain-priority` | 取消非 `hubWaitSeverities` 的 pending verify；保留 high/critical |
| `POST /canvases/:id/convergence/run-hub-now` | 人工强制一轮 Hub（写 audit log） |

前端任务画布顶栏：

- **暂停决策** / **恢复决策**
- **高危验完即停**（快捷套用推荐策略）
- **清理低优先级 verify**
- 状态徽标：`自驱中 | 已暂停 | 门控等待中 | 已自动停止`

「手动选择停止时间」= 用户任意时刻点 **暂停决策**，或预先设 **门控验完即停**；改的是调度器是否还 `maybeTriggerHub`，不是 Agent 时钟。

### 3.5 confirmed 批量（batch，二期）

- finding confirmed → 写入 `pending_confirmed_ids`，不立刻 insert hub job
- debounce：`now - last_confirm ≥ confirmedHubBatchSec` 且无 activeBlockingVerify → 一次 hub，`trigger.kind=confirmed_batch`
- 一期可只做 `gated` + 人工 pause；`batch` 放 Phase 3

---

## 4. 状态机示意

```
Audit emit finding
    │
    ├─ severity ∉ autoVerify ──► finding 挂起（可人工 verify）
    │
    └─ severity ∈ autoVerify ──► verify job (priority by severity)
                                    │
                                    ▼
                              verify 终态
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
               confirmed      rejected/FP      needs_human
                    │
                    ▼
         confirmedHubMode?
    immediate │ gated │ batch │ off
         │        │       │      └── 不 force
         │        │       └── 入 batch 队列
         │        └── 等 hubWaitSeverities 无 active
         └── 立刻 hub（兼容）

maybeTriggerHub 公共门:
  hub_paused? → 停
  auto_stopped? → 停
  maxHubRounds? → 停
  active hub? → 停
  activeBlockingVerify? → 等（gated/普通路径）
  else → 创建 hub_reason
```

---

## 5. 策略模板

| 场景 | autoVerify | hubWait | confirmedHubMode | autoStopMode |
|------|------------|---------|------------------|--------------|
| 全量靶场（推荐） | critical, high | critical, high | gated | after_wait_gate |
| 严苛上线审计 | 全 severity | 全 autoVerify | gated | after_all_auto_verify |
| 快速扫一眼 | critical only | critical | gated | after_wait_gate |
| 旧行为兼容 | 全 severity | 全 | immediate | never |

项目设置页可提供 **策略模板下拉**，一键写入 rules。

---

## 6. 实现切面

| 层 | 改动 |
|----|------|
| `core.ts` `ProjectRules` + `rulesForProject` | 新字段读写与默认 |
| `core.ts` `evaluateFollowup` | severity 门控 + priority 加权 |
| `core.ts` `finalizeJob` / `maybeTriggerHub` | confirmedHubMode、wait 门、autoStop、canvas convergence |
| `routes.ts` | canvas convergence API；settings 透传新 rules |
| `apps/web` SettingsPanel | 规则表单：severity 多选、mode 下拉、说明文案 |
| `apps/web` TaskCanvas 顶栏 | 暂停/恢复/门控停/清理低优先级 |
| OpenAPI / 前端 `EffectiveRules` 类型 | 同步新字段 |
| 可选：ARCHITECTURE 短记 | 决策摘要 |

**不改** `database/schema.sql`（规则与 convergence 走 JSONB）。

---

## 7. 分阶段交付

### Phase 1（最小可用，优先）

1. 恢复 `autoVerifySeverities` 门控（`evaluateFollowup` 真正判断 severity）
2. verify priority by severity
3. `hubWaitSeverities` + 普通/gated 路径只等门控 verify
4. `confirmedHubMode`: `immediate | gated | off`（默认 `gated`）
5. 画布 `hub_paused` + API/UI 暂停/恢复决策
6. Settings 可配上述字段；推荐默认 high+critical

**验收：**

- medium/low 不再自动刷 verify
- critical/high pending 时 Hub 等待；仅 medium pending 时 Hub 可触发
- 点「暂停决策」后不再新开 hub

### Phase 2

1. `autoStopMode=after_wait_gate`
2. `drain-priority` 清理非门控 pending verify
3. 策略模板 UI
4. `maxHubRounds` 仅计 succeeded（或可配置）
5. 可选：`POST /canvases/:id/reprioritize-verifies` 重排已有队列

### Phase 3

1. `confirmedHubMode=batch` + debounce
2. 画布级 override rules
3. 指标：按 severity 的 verify 队列深度、门控等待时长

---

## 8. 边界与纪律（对齐架构）

| 原则 | 本方案如何守 |
|------|----------------|
| Agent 只提案 | severity/门控/停决策全在调度器 |
| 本地库唯一真相 | finding.verify_status、job.priority、canvas convergence JSON |
| 幂等 | 同 finding 仍唯一 verify；pause 只影响 maybeTriggerHub |
| 单画布一个活跃 hub | 不变 |
| 配置落库 | rules 三级回落；画布控制态 JSONB |

**注意：**

- 已 pending 的旧 verify（例如某次全量审计堆积的队列）**不会自动消失**；需 `drain-priority`、批量 cancel，或按 severity 清理脚本。
- 改 rules「下一 job 生效」对**已建** verify 不回溯；priority 只影响新建。
- `run-hub-now` 人工强制须写 audit log。

---

## 9. 已拍板的默认策略（实现按此）

1. **默认只自动 verify `critical` + `high`**
2. **默认 `confirmedHubMode = gated`**（不再每条 confirmed 立刻 force）
3. **默认 `hubWaitSeverities = critical + high`** → high 全验完即可放行/可停
4. **人工「暂停决策」** 作为一等操作
5. medium/low：不自动 verify；需要时人工点验

---

## 10. 一句话总结

> 用 **`autoVerifySeverities` + severity 优先级** 控制「谁先验、谁验」；用 **`hubWaitSeverities` + `confirmedHubMode=gated`** 控制「验到哪一档就能继续/停」；用 **画布 `hub_paused` / 自动 stop 策略** 让人随时选择决策停止点——调度器仍是唯一有副作用的执行者。

---

## 11. 实现 checklist（TODO）

- [x] `ProjectRules` 扩展字段 + env/全局/项目回落（branch: `feat/verify-priority-convergence`）
- [x] `evaluateFollowup`：severity 门控 + priority 加权
- [x] `maybeTriggerHub`：`hubWaitSeverities` 阻塞查询
- [x] `finalizeJob`：按 `confirmedHubMode` 处理 confirmed
- [x] 画布 convergence JSON + pause/resume API
- [x] Settings UI 绑定新字段 + 文案说明「门控 / 自动验」
- [x] 画布顶栏：暂停决策 / 恢复 / 高危验完即停 / 清理低优先级 / 立即 Hub
- [ ] Phase 1 冒烟：高危优先 claim、low 不自动 verify、pause 后无新 hub
- [x] Phase 2 部分：autoStop 基础 + drain-priority（maxHubRounds 仅 succeeded 已在 main）
- [ ] Phase 3：batch confirmed hub
