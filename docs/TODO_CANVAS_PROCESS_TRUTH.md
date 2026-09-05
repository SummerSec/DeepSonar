# 画布过程真相增强（广播可见性 + 连线/布局第一性）

> **状态（2026-08-13）**  
> - **A. Fact/Finding 广播**：**as-built 已交付**（注入 + `canvas_broadcasts` + API + 画布 UI）。见「A as-built」与 `DESIGN.md` §4.2。  
> - **B. 连线/布局**：**主路径已可用**（服务端 `x/y` 是 placement/exchange hint；Web 对当前可见投影布局，≤200 节点用 ELK、超阈值用固定列；八类边）。
> - **`layout_revision` 全图权威重算：暂缓** — 见 GitHub **#148**，后续重议设计，不按本文 B2 原样强推。  
> - **当前投影护栏**：默认深度 3；每个父节点首批 12 个后继；常规投影上限 180 个节点（显式链路聚焦例外）；PNG 只导出当前可见投影。
> 索引：[`README.md`](README.md)。  
> 相关代码：`canvas-updates.ts`、`domains/canvas/`、`canvas_broadcasts`、`apps/web/src/canvas-broadcasts.ts`、`CanvasView.tsx`、`api.ts` EdgeType。

## 评估结论

- **A 已解决「无法回答投递给谁」**：独立表 `canvas_broadcasts`、`planned→injected|unknown`（及失败路径）、`GET /canvases/:id/broadcasts`、画布广播面板。真注入仍走 `sendMessage`；`injected` ≠ 模型已读。
- **A 的边界仍有效**：仅并发 running 目标；仅 `incrementalMessages=true` 的 CLI 订阅（Claude Code / Pi；Codex / OpenCode 不追加）。进程内订阅不能证明跨进程全局 `no_subscriber`。
- **B 不应重写调度语义**：权威边类型是八类，不是原草案的六类。先修契约漂移、数据库唯一性和 Report 可视连接；是否需要按因果 round 的服务端权威布局由 #148 另议，保留现有 Verify/Hub/Report 门禁。
- **历史观测样本（2026-08-03）**仅作布局 B 的动机（坐标重叠、Verify 门禁等），**不再**描述「无 broadcast API / 无账本」——该缺口 A 已补。
- **发布必须等任务收敛**：schema 基线已按仓库当前版本纪律重建；后续 B 的结构变更仍须先备份和恢复演练，不在运行中任务上直接实施。

---

# A. Fact/Finding 广播可见性

## A as-built（当前实现）

### 真注入链路

```
emit_fact/finding → canvas_nodes INSERT
  → pg_notify('deepsonar_canvas_events')
  → canvas-updates.ts LISTEN
  → 过滤 fact|finding、组装「DeepSonar 画布增量通知」
  → 对同画布已 subscribe 的目标 Job 调用 sendMessage
  → canvas_broadcasts：planned → injected | unknown
```

| 层 | as-built |
|----|----------|
| 注入 | `executor-real` `onRunReady`：`incrementalMessages === true` 时 `subscribeCanvasUpdates(canvasId, jobId, sendMessage)` |
| 数据库 | 表 `canvas_broadcasts`；幂等键 `(source_node_id, target_job_id, attempt)`；关联 active Attempt + effect `canvas_delivery` |
| API | `GET /canvases/:id/broadcasts`（`tasks:read`）；Job 详情可带 broadcasts 投影 |
| 前端 | 画布广播状态面板、源/目标聚合、overlay；`broadcastStatusLabel`；**禁止**「模型已收到」文案 |
| 启动对账 | reconcile 可将未决 planned 标为 unknown（进程崩溃窗口） |

### 能力与目标门禁

| 条件 | 行为 |
|------|------|
| CLI `incrementalMessages` 为 false（Codex / OpenCode） | **不订阅** → 无运行时追加、通常无账本行（不是“注入失败”） |
| 无 active Attempt / 非活跃状态 | 不进入投递集合 |
| 源 Job == 目标 Job | 跳过 |
| 后启动 Job | **不**补发历史 fact（Hub 整图） |

### 术语

`injected` = 平台已成功调用 CLI 增量输入（`sendMessage` 返回成功并结算账本）。**不**表示模型已读取、理解或采纳。UI/API/日志禁止写「模型已收到/已处理」。

### 仍可选增强（不阻塞「A 已落地」）

- stream-bus 推 `canvas.broadcast` 卡片（Phase 计划中；账本已可查）
- 成功路径更结构化的 Scheduler 日志
- 多 Scheduler 副本下的订阅拓扑（当前进程内 Map）

---

## 历史问题陈述（归档，2026-08 前）

> 以下描述的是**落地投递账本之前**的缺口，仅作设计背景；**不要**当作当前现状。

当时注入链路已存在，但缺少平台级投递账本与 API，前端只能靠 Session/事件文本猜痕迹。A 的目标正是补齐可审计、可按画布查询的账本。

---

## 目标（A，已满足主路径）

1. **可审计**：每个已识别目标的广播注入尝试有持久化记录（DB 为真相），并能区分成功与结果不确定。✅  
2. **可按画布看**：任务工作台能看到「谁 → 谁、什么节点、状态」。✅  
3. **不破坏边界**：仍由 Scheduler 唯一投递；Agent 不互调；不经目标出网。✅  
4. **兼容旧数据**：无记录的历史 Job 不报错。✅  
5. **可实时看（stream）**：运行中 WS 独立广播卡片 — **可选增强**，非 A 关闭条件。

非目标（仍不做）：

- 改变广播语义（广播给未 running 的 Job、重放历史全量图）。
- 把完整 CLI Session 当唯一真相。
- 让 Agent 自己上报「我收到了广播」。

---

## 推荐方案（分层，实现对照）

### 总览

```
                    ┌─────────────────────────────┐
  fact/finding INSERT │  canvas_nodes (已有)        │
                    └─────────────┬───────────────┘
                                  │ pg_notify
                    ┌─────────────▼───────────────┐
                    │  canvas-updates forward     │
                    │  + 写投递账本 + 推流 + 日志   │
                    └──────┬──────────┬───────────┘
                           │          │
              ┌────────────▼──┐   ┌───▼──────────────┐
              │ DB 投递记录    │   │ stream-bus / WS  │
              │ (持久、可查)   │   │ (实时、可丢)      │
              └────────────┬──┘   └───┬──────────────┘
                           │          │
              ┌────────────▼──────────▼──────────────┐
              │ 前端：Job 运行详情 / 画布活动 / 日志  │
              └──────────────────────────────────────┘
```

原则对应架构：

- **本地库 = 唯一真相**：投递结果落库。
- **画布 = 过程真相**：可选在画布侧展示「已广播」活动，不改节点坐标语义。
- **沙箱 = 执行真相**：sendMessage 仍是实际注入；失败以库中 `delivery_status` 为准，不信任 Agent 自报。
- **Scheduler = 唯一副作用执行者**：只有它写投递账本并 sendMessage。

---

## 数据模型

> 当前实现已落地四态投递账本：`planned`、`injected`、`failed`、`unknown`。
> 目标在发送前不满足活动 Attempt、同画布或权限策略时直接从候选集合排除，不生成
> 不生成其他跳过状态行，也不把“没有账本”解释为“确认未投递”。

### 方案 A（推荐）：新表 `canvas_broadcasts`

不塞进 `events`（events 语义是「Agent 提案/语义事件」），避免与 `emit_*` 混源。

```sql
CREATE TABLE canvas_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id text NOT NULL REFERENCES canvases(id),
  source_job_id uuid NOT NULL REFERENCES jobs(id),
  source_node_id uuid NOT NULL REFERENCES canvas_nodes(id),
  source_node_type text NOT NULL,               -- fact | finding
  target_job_id uuid NOT NULL REFERENCES jobs(id),
  target_role text NOT NULL,                    -- 创建订阅时从冻结快照读取，仅作审计展示
  target_role_kind text NOT NULL,               -- role | hub | verify | report
  attempt int NOT NULL DEFAULT 1,
  delivery_status text NOT NULL,                -- planned | injected | failed | unknown
  error_code text,
  error_message text,                           -- 脱敏后 ≤500 字符，禁止原始异常/凭据
  title text,                                   -- 冗余展示，避免联表
  payload_preview text,                         -- allowlist 后截断预览（≤2KB）
  payload_sha256 text,
  message_chars int,
  injected_at timestamptz,
  finished_at timestamptz,
  decision_deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canvas_broadcasts_attempt_check CHECK (attempt >= 1),
  CONSTRAINT canvas_broadcasts_not_self_check CHECK (source_job_id <> target_job_id),
  CONSTRAINT canvas_broadcasts_status_check
    CHECK (delivery_status IN ('planned','injected','failed','unknown')),
  CONSTRAINT canvas_broadcasts_source_type_check
    CHECK (source_node_type IN ('fact','finding')),
  CONSTRAINT canvas_broadcasts_target_kind_check
    CHECK (target_role_kind IN ('role','hub','verify','report')),
  CONSTRAINT canvas_broadcasts_timestamps_check CHECK (
    (delivery_status = 'planned' AND injected_at IS NULL AND finished_at IS NULL)
    OR (delivery_status = 'injected' AND injected_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (delivery_status IN ('failed','unknown') AND finished_at IS NOT NULL)
  ),
  CONSTRAINT canvas_broadcasts_error_code_check CHECK (
    (delivery_status IN ('failed','unknown') AND error_code IS NOT NULL)
    OR (delivery_status NOT IN ('failed','unknown') AND error_code IS NULL)
  ),
  CONSTRAINT canvas_broadcasts_delivery_attempt_uniq
    UNIQUE (source_node_id, target_job_id, attempt)
);
CREATE INDEX canvas_broadcasts_canvas_idx ON canvas_broadcasts (canvas_id, created_at DESC);
CREATE INDEX canvas_broadcasts_target_job_idx ON canvas_broadcasts (target_job_id, created_at DESC);
CREATE INDEX canvas_broadcasts_source_node_idx ON canvas_broadcasts (source_node_id);
CREATE INDEX canvas_broadcasts_status_idx ON canvas_broadcasts (delivery_status, updated_at DESC);
```

- `(source_node_id, target_job_id, attempt)` 是**逻辑投递幂等键**；不额外存一份可漂移的 hash。同一 source/target 的通知重放不得重复创建同一 `attempt`。显式重试才递增 `attempt`，并保留上一条记录，不能覆盖历史。
- `created_at` 即 planned 时间，不再重复存 `planned_at`。`planned → injected | failed` 是主状态机：先落 `planned` 再调用 `sendMessage`，返回成功后改 `injected`；异常改 `failed`。`injected` 只代表平台注入成功，不代表模型读取。
- 进程在 `planned` 后、终态更新前崩溃时，无法判断消息是在 send 前还是 send 后中断；启动对账在 `decision_deadline_at` 后将其标为 `unknown/error_code=ack_lost`。默认不自动重发，以避免底层 API 无幂等键时重复注入；若底层以后提供稳定 message id，再把它纳入协议。
- 状态迁移统一走一个 Scheduler 内部函数：只允许 `planned→injected|failed|unknown`，终态不可回写。目标校验在进入候选集合前完成，不满足条件的目标不产生账本行。Phase 1 没有公开重试 API，`failed/unknown→planned` 非法。
- `decision_deadline_at` 由服务端配置计算并在插入时强制写入；Reaper/启动对账都复用同一“过期 planned → unknown”函数。Phase 3 若开放重试，只能在同一 source/target 的事务锁内取 `MAX(attempt)+1`，并写入操作者/原因审计。
- 统一转移函数必须按矩阵写全字段并更新 `updated_at`：`planned` 的 `finished_at/injected_at` 为空；`injected` 同时写 `injected_at/finished_at`；`failed` 写 `finished_at + error_code`；`unknown` 写 `finished_at + error_code=ack_lost`。任何终态缺少矩阵必填字段都应在事务内失败。
- 目标已终态、策略拒绝、没有活动 Attempt 或不属于同一画布时，在候选集合阶段排除；`source==target` 同样不制造账本噪声。只有实际进入投递流程的目标才写入 `planned`。
- 当前订阅表是进程内 Map。在单实例下，“没有目标”可打 `no_local_subscriber` 日志/指标；它不能成为权威 DB 记录，因为多实例下某实例没有本地订阅者，不等于全局没有订阅者。若未来支持多 Scheduler 实例，必须先增加带 `instance_id + lease_expires_at` 的持久订阅登记或明确的单消费者分片，再把全局 `no_subscriber` 升格为账本状态。
- `error_message`、`payload_preview` 必须先做凭据/Token/Authorization 脱敏，再按字节截断；DB 和 API 均不保存完整 `body_json` 或原始异常堆栈。
- 应用层在同一事务校验 source node、source job、target job 均属于 `canvas_id`；现有表结构无法用单列 FK 表达该跨表一致性。
- `source_job_id`/`target_job_id` 不级联删除，避免清理 Job 时静默抹掉审计链；归档不删账本。只有明确硬删整个画布时，按“broadcasts → edges/nodes → jobs/canvas”的受控顺序清理，并在审计日志记录。
- 现有 `wipeCanvasRuntimeData` 的删除顺序必须与当前 schema 基线同步：先删 `canvas_broadcasts`，再删 edges/nodes、jobs、canvas。硬删 smoke 要覆盖“有广播行”和“无广播行”两种画布；否则新 FK 会直接阻断现有硬删路径。
- **schema 变更**：改表时直接 bump `SCHEMA_VERSION` 并更新空库基线；按本仓库当前启动纪律，旧库版本不匹配时重建，不能假设存在增量迁移。发布前必须先让当前任务收敛或明确取消，做数据库备份并验证项目导出/恢复路径；不能在运行中 Job 存在时直接重建。

### 不采用的备选：写入目标 Job 的 `events`

向 **接收方** job 插入语义事件：

```json
{
  "type": "canvas_broadcast",
  "payload": {
    "source_job_id": "...",
    "source_node_id": "...",
    "node_type": "fact",
    "title": "...",
    "delivery": "injected",
    "attempt": 1,
    "derived": true
  }
}
```

优点是前端「事件」Tab 改动较小；缺点是污染 Agent 语义事件流，还要额外证明 `ingestEvent` 不触发规则引擎/followup。本文明确**不实现 events 兼容投影**：持久真相只在 `canvas_broadcasts`，实时增强只走 stream-bus，避免第二真相和幂等键分叉。

---

## Scheduler 改动点（实现时）

文件：`apps/scheduler/src/canvas-updates.ts`（主），必要时 `stream-bus` / 路由。

### 1. 投递前后记账（先计划，再注入）

`forwardCanvasEvent` 不能再采用「先 `sendMessage`、后 INSERT」的顺序。对每个候选 `target_job_id ≠ source_job_id`，必须执行以下可重放流程：

1. 先从进程内 Map 取得候选 sender 的瞬时快照；再开启数据库事务，校验目标仍与 source 同画布、`status='running'`、冻结角色策略允许接收，并设置 `decision_deadline_at = now() + 配置化超时`，插入 `delivery_status='planned', attempt=1`。使用 `(source_node_id,target_job_id,attempt)` 唯一键和 `ON CONFLICT DO NOTHING` 抢占发送权；已存在的 `injected`/`failed`/`unknown` 行不得被隐式覆盖。
2. 事务提交后，只有成功插入该 `planned` 行且本地 sender 仍存在的调用者才执行 `Agent.attach(...).sendMessage(...)`；sender 在两步间消失时转为 `failed/target_detached` 并写 `finished_at`。返回成功后 `UPDATE` 为 `injected`（写 `injected_at/finished_at`）；抛错则 `UPDATE` 为 `failed`（写 `finished_at` 与脱敏后的 `error_code/error_message`）。状态更新必须带 `WHERE id=? AND delivery_status='planned'`，防止并发重试覆盖。
3. 状态更新成功后再 `publishStream(target_job_id, { type: 'canvas.broadcast', broadcast_id, delivery_status, attempt, ... })`。推流可丢，DB 账本不可丢；推流失败只记日志，不回滚已确认状态。
4. 每次日志带 `broadcast_id`、`source_node_id`、`target_job_id`、`attempt` 与同一关联 id；成功文案使用 `injected`，不得写 `delivered` 或「模型已收到」。

这明确暴露而不是掩盖崩溃窗口：行会停留 `planned`，启动对账超过 `decision_deadline_at` 后写 `finished_at` 并标为 `unknown/error_code=ack_lost`，默认不自动重发。只有人工明确判断或底层提供稳定 message id 时，才在事务/画布锁保护下分配 `attempt+1`；禁止以重启循环制造重复注入。现阶段选择的是“结果不确定时偏向不重复注入”，不是虚构 exactly-once。

### 2. 订阅快照可观测（可选）

`subscribeCanvasUpdates` 注册时打 debug：
`[canvas-update] subscribe canvas=… job=… subscribers=N`
取消订阅对称日志。便于回答「当时有没有人在听」。

### 3. 目标筛选与不广播的情况写清楚

目标集合来自当前进程的订阅注册表，并再次以数据库状态和冻结快照策略校验；订阅注册表为空只能证明本实例当时没有监听者。当前代码会为真实执行且带画布的 Job 注册订阅，因此 Phase 1 保持现有语义，不在本 TODO 中擅自排除 `verify_finding` 等系统 Job；若产品决定只投工作角色，必须先作为独立语义变更评审。角色配置、项目权限、画布归属和出网策略均由服务端判定，Agent/Hub/任务正文不得扩大目标范围。

| 情况 | 行为 |
|------|------|
| 无本地 running 订阅者 | 不插入目标账本行；记录 `no_local_subscriber` 日志/指标，并在 UI 说明“无记录不等于证明未投递” |
| 目标已终态/策略拒绝 | 发送前从候选集合排除，不插入账本行；候选筛选日志使用固定低基数原因 |
| source == target | 在候选集合过滤，不写账本、不调用 `sendMessage` |
| 节点非 fact/finding | 防御性过滤；不生成广播账本行（数据库触发器本身也只监听 fact/finding） |
| sendMessage 失败 | 保留原 `planned` 行并更新为 `failed`，错误码白名单化、正文脱敏且截断 |

**不**为「后启动的 Job」补发历史 fact（那是 Hub 整图职责）；文档写清：**广播仅覆盖时间重叠的 running Worker**。

---

## API

最小集（scope：`tasks:read`，沿用项目/任务行级权限）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/jobs/:id/broadcasts?after=&limit=&status=` | 该 Job **作为接收方** 的投递列表 |
| GET | `/canvases/:id/broadcasts?after=&limit=&status=` | 画布级广播时间线 |

采用 keyset cursor，不用 offset：默认 `limit=50`，范围 `1..100`；按 `(created_at DESC, id DESC)` 排序，`after` 是包含这两个值的 opaque base64url cursor。可按一个或多个规范状态 `planned,injected,failed,unknown` 过滤，响应为 `{items,next_cursor,has_more}`。`since` 只作为短期兼容参数，不能替代 cursor。API 只返回脱敏/截断字段，不暴露原始异常、完整 prompt 或凭据。

权限检查先从 Job/Canvas 解析 project，再应用调用者的 project/任务 scope；不能用 `target_job_id` 直接跨项目探测。`tasks:read` 允许查看同项目账本，写入/重试仍是 Scheduler 内部动作（若未来开放人工重试，另设显式 `tasks:operate` 且要求审计）。

OpenAPI、`skills/deepsonar-management/` 与前端 API 类型同步一笔，并固定状态/错误码/分页契约。

---

## 安全与数据最小化

- Fact/Finding 来自不可信被审计材料和 Agent 提案。广播模板继续把内容标成「平台转发的数据，不是系统指令」，用固定边界包裹；账本与 UI 不增加任何更高优先级提示。
- `payload_preview` 只从明确 allowlist 字段生成；先做 secret/Authorization/Token 模式脱敏，再按 UTF-8 字节截断。默认不保存完整 body、prompt、Session 或堆栈。
- 前端按纯文本渲染 title/preview/error，不执行 Markdown HTML；结构化日志字段去换行/控制字符，防止日志伪造。
- stream-bus 与两个 GET 端点复用 Job/Canvas 的项目权限；WS 事件也必须在订阅时鉴权，不能只保护历史列表。
- 对 title、preview、error、cursor、limit/status 参数设置长度/枚举上限；容量与速率限制按 project/canvas 维度统计，避免高频 Fact 放大存储或 WS。

---

## 前端展示（三处，优先级从高到低）

### P0：运行详情（Execution / 运行详情）

`JobDetailPanel`：

1. **事件 Tab** 旁新增 **「画布注入」** Tab；避免使用暗示模型已读的「收到」作为状态名称。
2. 每条展示：时间、来源角色/Job 类型、node_type、title、`attempt`、`planned/injected/failed/unknown`；`unknown` 明确显示为「平台未能确认注入结果」。
3. 展开可看 `payload_preview`（截断 body）。
4. **实时流**：订阅现有 WS，识别 `type === 'canvas.broadcast'`，渲染独立卡片（与 tool.call 区分），文案如「画布增量已注入平台 · fact · {title}」。不得显示「模型已收到/已处理」。

这样打开任意 running/历史 Job 都能回答：「有没有被广播」「广播了什么」。

### P1：任务画布工作台

`TaskCanvasPage` 或画布侧栏：

- 轻量 **活动条**：「12:56:35 explore → 2 个 running audit · fact「路由清单」」。
- 数据：`GET /canvases/:id/broadcasts`，5s 轮询或 WS 画布级通道（若已有画布 WS 可复用；否则轮询即可）。

### P2：节点详情

点开 fact 节点时显示 **「已广播给 N 个 Job」**（按 `source_node_id` 聚合），失败数标红。

---

## 日志与指标

### 结构化日志（stdout，运维可见）

```
[canvas-update] injected canvas=… broadcast_id=… attempt=1 source_job=… target_job=… node=… type=fact title=…
[canvas-update] failed   canvas=… broadcast_id=… attempt=1 target_job=… error_code=…
[canvas-update] unknown  canvas=… broadcast_id=… attempt=1 target_job=… error_code=ack_lost
[canvas-update] no-local-subscriber canvas=… node=… type=fact
```

### Prometheus（可选，与现有 metrics 风格一致）

- `deepsonar_canvas_broadcast_attempts_total{outcome=injected|failed|unknown,reason=…}`（每个 attempt 只在终态计一次；`reason` 仅用低基数白名单）
- `deepsonar_canvas_broadcast_planned`（当前未决行数，gauge）
- `deepsonar_canvas_broadcast_no_local_subscriber_total`（单实例观测 counter，不宣称全局无订阅者）
- `deepsonar_canvas_broadcast_subscribers`（当前订阅 Map 大小，gauge）

---

## 与现有机制的边界说明（产品文案）

在 UI 帮助或空态提示中写清：

> 画布增量广播只投递给**当时仍在运行**的同画布 Worker。
> 后启动的 Job 不会收到历史 Fact 的补发；它们依赖 Hub 注入的整图 / 新 prompt。
> 「平台注入成功」以投递账本的 `injected` 为准；它不代表模型已读取或采纳。没有账本记录也不能反向证明“当时没有其他订阅者”。

避免用户把「explore 写了 12 条 fact」误解为「所有 audit 都实时收到了 12 条」。

---

## 实现分期

### Phase 0（发布门禁，不改运行语义）

1. 当前运行任务先自然收敛，或由用户明确决定取消；有 `running/provisioning/claimed` Job 时禁止为本功能重建 schema。
2. 做数据库备份与恢复演练；确认 `.deepsonarpack` 对 Job/事件/画布的覆盖边界，凭据与全局配置另行保全。
3. 固定单 Scheduler 实例假设；若部署已经是多实例，先实现 Phase 3 的订阅租约/分片，不能把 `no_local_subscriber` 当全局事实。
4. 以 `database/schema.sql` + `apps/scheduler/src/db.ts` 的现实启动行为为准，先修正 `ARCHITECTURE §17.2` 中任何暗示在线增量迁移的旧描述；本发布不引入第二套迁移框架。
5. 对旧数据做 edge invalid/duplicate 与硬删路径预检；默认 fail closed。精确重复 edge 只有在生成可审计清单后才可按 `(created_at,id)` 保留最早一条，非法 edge type 不做猜测映射。

### Phase 1（最小完整闭环，A 已落地的部分）

1. [x] 表 `canvas_broadcasts` + `SCHEMA_VERSION` bump；加入 `planned` 超时对账为 `unknown`。
2. [x] `canvas-updates.ts`：先抢占 `planned`、再注入、再写终态；结构化成功/失败/不确定日志。
3. [部分] Job 详情已投影广播/Attempt/usage；画布级 cursor API 与前端活动条仍待后续独立工作。
4. 前端：`JobDetailPanel` 广播列表 + 实时流卡片；旧 Job 显示版本化空态。
5. 项目导入导出新增模块键 `canvas_broadcasts`，依赖 `tasks`（其中必须包含相关 canvas/job/node）：`project_full` 与 `evidence_archive` 默认包含，`configuration` 不包含，`custom` 选择后自动补 `tasks`。包内使用独立数据文件并进入 manifest/checksum/sanitize/UUID remap；缺任一 source/target/node 依赖时整模块拒绝，不能静默丢行。包内重复自然键直接报错；目标侧碰撞若内容完全一致可幂等跳过，字段不同则报告 conflict，不覆盖历史。

### Phase 2

1. 画布活动条 / fact 节点「已注入 N 个目标、失败 M、不确定 U」。
2. metrics 与保留策略：项目/画布归档保留全部状态行；空间紧张时可定期清空旧 `payload_preview/error_message`，不删除投递结果与时间戳。只有用户明确硬删画布时才按受控顺序删除账本；UI 在硬删前提示先导出 `project_full/evidence_archive`，但“是否导出”由用户决定并写审计。
3. 运行手册补充 `unknown` 排查、脱敏验证和容量基线。

### Phase 3（可选）

1. 显式、受控的失败/不确定投递重试（仅对仍 `running` 的 target；事务内分配下一 attempt）。
2. 广播消息模板版本化，并在底层支持时记录稳定 message id。
3. 多 Scheduler 支持：持久订阅租约、实例归属和单消费者分片；完成前不宣称全局 `no_subscriber`。

---

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| schema bump 需重建且当前有运行任务 | Phase 0 先排空任务、备份并演练恢复；禁止热重建 |
| 高频 fact 导致广播行膨胀 | 预览截断、cursor 分页；保留状态行，优先清空旧预览而非删除审计结果 |
| sendMessage 返回成功但模型未读 | 状态命名为 `injected`；产品文案明确平台注入≠模型采纳 |
| send 前后崩溃无法判定 | 先写 `planned`，超时转 `unknown`，默认不自动重发；不宣称 exactly-once |
| 多实例各自持有订阅 Map | Phase 1 固定单实例语义；多实例前实现持久租约/分片 |
| stream-bus 丢消息 | UI 以 DB 列表为准，流只增强实时感 |
| 与 events 混用 | 坚持独立表，避免规则引擎误触发 |
| Fact/Finding 含提示注入、HTML 或日志控制字符 | 固定不可信数据边界、allowlist 预览、纯文本 UI、结构化日志转义 |

---

## 验收标准

1. 两个重叠 running 的 Worker，A 提交 fact 后：
   - DB 先出现 `planned`，随后同一行转为 `injected`，`target_job_id=B`、`attempt=1`；
   - B 的运行详情「画布广播」可见该条；
   - B 实时流出现 `canvas.broadcast` 卡片；
   - 调度器日志有 `injected … target_job=B`，UI 不声称模型已读。
2. 同一 NOTIFY 被重复处理或两个转发器并发处理：同一 `(source_node,target_job,attempt)` 只有一行、至多一个调用者获得发送权。
3. 仅 A 运行、无其他本地订阅者：fact 入库，无目标账本行，有 `no_local_subscriber` 指标/日志；文案不把它冒充全局事实。
4. 后启动的 C：无历史 fact 的补发记录；行为与现网一致。
5. `sendMessage` 抛错：原行转 `failed`，错误已脱敏/截断，前端可见失败状态。
6. 在 `planned` 后模拟进程退出：重启对账后转 `unknown/ack_lost`，不自动重复注入。
7. 旧 Job 或确实没有投递的 Job：Tab 显示「暂无结构化投递记录；旧版本任务可能未记录」，不 500，也不推断“从未注入”。
8. 权限测试证明不能用 Job/Canvas id 跨项目枚举；cursor 翻页无重复/遗漏。
9. `project_full/evidence_archive` 导出再导入后，广播 source/target/node 引用完成 UUID remap，checksum 与 sanitize 通过；`configuration` 不含该模块，custom 缺 tasks 时自动补依赖；重复/冲突策略符合上文。
10. 注入含换行、HTML、伪 Authorization 与提示注入文本的 Fact：DB/API/日志均脱敏截断，前端只显示文本，WS 不能跨项目订阅。
11. 归档画布后账本仍可查；硬删带/不带广播数据的画布均按新顺序完成，无 FK 错误且有审计记录。
12. 验证命令至少包含全仓 `pnpm typecheck`、`pnpm build`、相关手工 API smoke、`git diff --check`；并用真实双 Worker 重叠运行做一次 E2E，不能只以 fake runner 通过代替。

---

## 建议默认选型

| 项 | 选择 |
|----|------|
| 持久化 | **新表 `canvas_broadcasts`** |
| 实时 | **stream-bus `canvas.broadcast` + 现有 Job WS** |
| 前端首屏 | **Job 运行详情「画布注入」Tab** |
| 日志 | **injected/failed/unknown/no_local_subscriber 均打点** |
| 分期 | **Phase 0 门禁通过后落 Phase 1** |

确认本方案后，再动代码与 schema。


---

# B. 连线规则与布局第一性收敛

> 背景：对照 2026-08-03 仍在运行的 java-sec-code 画布（90 节点、89 边）与 `ARCHITECTURE §8.4`、实现代码评审。
> 结论：**语义骨架大体符合第一性；图语法与布局是「能跑的演进态」，需收敛。**

## B.1 第一性原理（对照本平台）

| 原则 | 含义 |
|------|------|
| 本地库 = 唯一真相 | 连线应表达可查询的因果/派生，不是装饰 |
| 画布 = 过程真相 | 一眼看出：意图从哪来、产出是什么、谁在验证 |
| Agent 只提案 | 边由 Scheduler 建；Agent 不画坐标、不发明拓扑 |
| Hub 读图决策 | Hub 依赖 fact-intent 二分图；系统边不要污染决策语义 |
| 系统派生可追溯 | verify 必须能追到 finding → 源 audit |

## B.2 当前连线规则（实现真相）

| edge_type | 方向 | 谁建 | 语义 |
|-----------|------|------|------|
| `child` | root → 无更具体父级的 job | Dispatcher 兼容建点/任务入口 | 任务拥有的入口或兼容执行节点；不只 Hub |
| `from` | root/fact/finding → intent | Hub `submit_hub_decision` | 依据什么开意图；rework 可由 finding 再开 intent |
| `to` | intent → fact；complete 时可有 fact → root | `emit_fact` / complete | 意图产出事实 / 收敛 |
| `produces` | intent/job → finding | `emit_finding` | 哪个工作意图产出 Finding；历史/兼容 Job 可直接产出 |
| `verifies` | finding → verify job | 规则引擎 `evaluateFollowup` | 谁在验证该 Finding |
| `next` | root/fact/finding/intent/job → hub job/human 等 | Hub 唤醒/rework/人工流程 | 通用流程续接，不进入 Hub 的 intent.from 决策投影 |
| `reviewed_by` | finding → review evidence fact | Verify 证据入库 | 独立审查证据 |
| `tested_by` | finding → test evidence fact | Verify 证据入库 | 实测证据 |

规范单源 `shared-types.EdgeType` 当前共有八类；Web API 类型只声明了前六类，是必须修复的契约漂移。运行中快照尚未产生 review/test evidence 边：`child=1`、`from=9`（`root→intent=5`、`finding→intent=4`）、`next=2`、`produces=31`、`to=15`、`verifies=31`、`reviewed_by=0`、`tested_by=0`。31 个 Finding 当前都恰有一条 `produces` 和一条首轮 `verifies`；后续验证轮次允许同一 Finding 出现多条指向不同 Verify Job 的 `verifies`。

### 合理之处

1. **from/to 二分图** 对齐 Cairn：Hub 决策与执行产出方向清楚。
2. **verifies: finding → verify** 方向正确，系统派生可追溯。
3. **Agent 不写坐标**；边只由 Scheduler 建。当前快照无重复边。
4. **intent 与 role job 1:1**（intent 带 `job_id`），过程卡 = 认领态。

### 不合理 / 张力

1. **契约三方漂移**：shared-types 已有八种边，Web API 仍只有六种，架构文字还把部分方向写反/漏写；`from/to/next/reviewed_by/tested_by` 与 rework 的 `finding→intent` 没有统一说明。
2. **数据库缺少边唯一约束**：`canvas_edges` 只有普通 canvas 索引；`insertEdgeIfAbsent` 的「先查后插」不能在并发下提供真正幂等。当前快照没有重复边只是观测结果，不是结构保证。
3. **工作执行与系统/兼容执行视觉未分层**：新建工作角色通常用 `intent`（1:1 Job），系统角色和 Dispatcher 兼容路径用 `job`；`produces` 也允许 job 作为来源，不能把所有 job 都误称系统角色。
4. **结果状态与因果边混在同一视觉层**：Verify 结论已经由 Finding/Verify Job 状态表达，不需要再造一条反向边；前端应把状态附着在现有 `verifies` 链上。
5. **finding 星型爆炸**：一 intent 可产出十余 Finding，再各自派生 Verify；语义正确但默认全展开不可扫。
6. **首轮与 rework 轮次混排**：当前既有 `root→intent`，也有 `finding→intent`；固定“所有 intent 一列”的布局无法表达后续轮次。
7. **Report 节点当前无边**：它通过状态与 `job_id` 可查，但在过程图上是孤立节点；报告因果没有视觉连接。

## B.3 当前布局规则

| 层 | 机制 |
|----|------|
| 落库时 | 简单偏移 `x+300/340`，`y+count*140`；只作为 placement/exchange hint，不是 UI 权威坐标 |
| 可见投影 | 默认深度 3；每父节点按稳定创建顺序首批 12 个后继；常规投影上限 180 个节点，显式链路聚焦可例外 |
| 前端主布局 | 当前可见投影 ≤200 节点时用 **elkjs layered RIGHT**（拓扑分层） |
| 前端兜底 | 当前可见投影 >200 节点或 ELK 失败时用固定语义列：root → 普通 job → finding → verify/intent → fact |
| PNG 导出 | 导出当前可见投影，不承诺完整 DB 图或跨客户端坐标复现 |

### 合理之处

- 坐标不交给 Agent。
- ELK 适合链 + 分支 DAG。
- 兜底列意图「finding 右挂 verify」清楚。

### 不合理之处

1. **没有跨消费者的权威坐标**：DB `x/y` 是 hint，屏幕坐标是前端可见投影结果；API/导入包与 PNG 不承诺同一排布。
2. **ELK 全边同权** → 决策边与系统边搅在一起。
3. **兜底列 intent 与 verify 同列（列 3）**，且按类型固定列无法表达 `finding→rework intent` 的下一轮因果。
4. 前端已有默认深度 3、每父节点首批 12 与 180 节点渲染上限，但不是按 intent/Finding 组的语义聚合；30+ Finding 的大扇出仍难扫。
5. **落库 hint 已真实碰撞**：历史样本有 20 组、40 个节点共享坐标；当前 UI 不把它当权威坐标，API/导入包也不得暗示其等同屏幕布局。

## B.4 是否符合第一性原理

| 维度 | 判定 |
|------|------|
| 因果可追溯 | 基本符合 |
| 边类型契约一致 | 不符合（shared-types 八类、Web 六类、架构文字再漂移） |
| 过程图 = 决策图 | 部分符合 |
| 布局表达语义 | 弱 |
| 规模可读 | **不符合** |
| Agent 不碰布局 | 符合 |
| 边写入幂等 | 应用层尽力，数据库层不符合 |

**一句话**：规则引擎与派生语义对；图语法和布局是演进态，不是干净的第一性实现。

## B.5 目标方案（边模型收敛 + 语义布局）

### B.5.1 边模型收敛：保留八类，先固定语义

**决策子图（Hub 读）**

- Hub 的 `intent.from` 只投影合法 `root/fact/finding --from→ intent`；Fact/Finding（含 review/test evidence fact）的正文与验证摘要仍按既有规则进入 Hub 快照。`produces/verifies/next/reviewed_by/tested_by/child` 不得被误当成 intent.from。
- `finding→intent` 是 Verify rework 后的合法决策边，必须保留；首轮 `root→intent` 也合法。
- 若保留 complete 时的 `fact→root` 收敛边，文档必须明确它是 `to` 的唯一反向特例；本期不新造 `converges`。

**系统子图（调度/验证）**

- `produces`：优先 `intent→finding`；为已有手工/兼容 Job 保留 `job→finding`。新建 Hub Worker 不应同时生成 intent 与 job 两个来源节点。它与 `to` 都是“产出”视觉家族，但保留不同机器语义。
- `verifies`：保持 finding → verify job
- `reviewed_by/tested_by`：保持 finding → evidence fact，分别表达独立审查/实测硬门证据
- `child`：root → 没有更具体因果父级的入口/兼容 job；Report 创建时补 `root→report` 的 `child`，避免孤点
- `next`：合法触发源 → hub job/human 等流程续接；服务端白名单 source/target 组合

**推荐默认（改动可控）**

1. `shared-types.EdgeType` 是单源；文档、OpenAPI、前端类型和图例都固定八种边；不在本 TODO 做破坏性的 `produces/to` 重命名。
2. 前端把 `from/to` 标成「决策边」，`child/produces/verifies/next` 标成「流程/执行边」，`reviewed_by/tested_by` 标成「证据边」；`to/produces` 可共用产出色系但线型不同。
3. 不增加 `verified_by` 反向重复边；结论、轮次和 rework 状态显示在 Finding 与 Verify Job 卡片/详情中。
4. 在 v13 基线增加 `UNIQUE(canvas_id,from_node_id,to_node_id,edge_type)` 与八类字符串 `CHECK`；所有写入入口接收 `shared-types.EdgeType` 并改为 `INSERT ... ON CONFLICT DO NOTHING`。发布/导入前先列出 invalid/duplicate：非法类型 fail closed，精确重复按 Phase 0 的可审计规则处理，不能让约束错误变成无上下文失败。

### B.5.2 节点类型纪律

| 节点 | 用途 |
|------|------|
| `root` | 任务根 |
| `intent` | **所有 Hub 可下发工作角色**（explore/audit/…），1:1 job |
| `job` | 系统工作流或没有 intent 的兼容执行节点：hub_reason / verify_finding / 直接创建的普通 Job 等 |
| `report` | 报告产物节点，`job_id` 绑定 Report Job |
| `fact` / `finding` | 普通产出；带 verification body 的 fact 是 review/test evidence |
| `human` | 人工闸门 |
| `note` | 平台/人工注记；不进入 Hub 可引用集合 |

这里不是强行把所有执行统一成一种节点：`intent` 是 Hub 可派发工作单元，`job` 是系统工作流或没有 intent 的兼容执行节点。UI 必须用标签/图例说明差异；调度器创建节点时按来源校验，禁止同一个 Job 同时出现 intent/job 两张执行卡。

### B.5.3 布局

**历史提案：权威坐标与布局 revision（#148 暂缓，非 as-built、不得按本节直接实施）**

- 曾设想的最终态：Scheduler 的布局服务对完整图计算坐标，并在单事务中更新所有 `canvas_nodes.x/y` 与画布 `layout_revision/layout_algorithm`；前端只读这些坐标。
- v13 为 `canvases` 增加非空 `graph_revision bigint default 0`、`layout_revision bigint default -1`、`layout_status text default 'dirty' CHECK (layout_status IN ('dirty','running','ready','failed'))`，以及可空的 `layout_algorithm/layout_error`。空库新建画布从 dirty 开始；旧包导入完成后保持 `layout_revision=-1` 并排队首轮重算。若开发环境采用显式 ALTER 而非重建，所有既有画布统一回填 `graph_revision>=0, layout_revision=-1, layout_status='dirty'`，不把旧占位坐标冒充权威布局。
- 数据库 trigger 覆盖 node/edge insert/delete 及节点布局相关语义字段（如 node_type/title/status/w/h/job_id）更新并递增 graph revision，明确排除 x/y 和不会改变卡片尺寸的正文更新；特殊正文变更若会影响布局，由对应 Scheduler 路径显式 mark dirty。这样 API、导入和后台派生不会漏标。一次布局事务写坐标并令 `layout_revision=起始 graph_revision`，因此 `graph_revision>layout_revision` 可直接判 stale。
- 节点/边事务提交后只标记布局 dirty；布局服务按 canvas debounce，并用 advisory lock 保证同一画布单写。它读取起始 graph revision，计算后若 revision 已变化则丢弃结果并重算，避免旧布局覆盖新图。
- 成功时写 `layout_status=ready`；失败时写 `failed` 并保留上一版权威坐标。`graph_revision>layout_revision` 统一派生为 stale（不是第五种落库状态）。前端临时 ELK 只能作为明确标记的降级展示，不能回写 DB，也不能用于导出。
- 当前正式契约不是“迁移前临时态”：DB 坐标是 placement/exchange hint；Web 对当前可见投影布局；PNG 只导出该投影。只有 #148 明确了跨 UI/导出/多端的权威坐标消费者后，才重新设计服务端方案。
- 节点尺寸、间距、算法版本移到前后端共用模块；不能让 Scheduler 用一套 NODE_W/H、Web 卡片再用另一套尺寸。布局元数据和错误不进入 Agent prompt。

**语义子图布局（优先于全图 ELK 同权）**

不能只按节点类型固定列，因为运行数据已经有 `finding→intent` 的 rework。布局应按**因果轮次**从左到右：

```text
root/source → intent(round 1) → fact|finding
                              ├→ verify job（局部卫星）
                              └→ intent(round 2 / rework) → ...
```

- `from/to` 决定决策主轴和 round；同一 Hub 决策创建的并行 intent 在同一阶段。
- `produces` 把 Finding 放入其 intent/兼容 job 的产出组；`verifies/reviewed_by/tested_by/next` 作为 Finding 的局部分支，不反向改变 Hub 主轴 rank。
- Hub/Report/Human 等系统节点使用独立泳道；severity 只控制组内排序，不改变因果层级。
- 算法和 spacing 参数固定版本并写入 `layout_algorithm`；同一 graph revision 的输出须确定性稳定。
- 输入在计算前固定排序：nodes 按 `(created_at,id)`，edges 按 `(edge_type,from_node_id,to_node_id,id)`；算法不得使用未固定随机数。complete 的 `to: fact→root` 只作为回边路由，不参与 rank，避免把收敛边变成层级环；其他异常环先做 SCC 压缩并按最小 node id 稳定排序，同时记录低基数 `layout_warning=cycle`。

**规模**

- 保留现有 depth=3 的展开/收起作为兼容能力；新增 Finding 按所属 intent/兼容 job 的语义聚合摘要（数量、severity、验证状态），展开后显示真实 Finding、Verify 与证据分支。
- 折叠是 UI 投影：不得删除节点/边、改写 Hub YAML 或覆盖完整图权威坐标。
- 已 confirmed 可灰显；`needs_human` 与 `unknown`/rework 不能被默认折叠到不可见。

**迁移期兜底**

- 不再维护一个与真实 rework 因果冲突的永久固定列算法。短期兜底至少按 `from` 链计算 round，再在 round 内分 `intent | fact/finding | verify/system` 子列。
- 若无法完成 round 计算，保留上次权威 revision 并标记 stale，比静默展示一套看似权威的新坐标更诚实。

### B.5.4 Hub 决策与边的配合（产品）

- 首轮允许使用 YAML `root_id` 对应的 canonical UUID 作为 `from` 并行开槽，不得填写字段名 `root`/`root_id`。
- rework/后续轮必须引用触发它的 Finding/Fact canonical UUID；当前快照中的 4 条 `finding→intent` 是正确样例。普通扩展探索可继续引用 root UUID，但 Hub prompt 应要求说明原因。
- 三层校验按分支定义，不能笼统写成“target 必须 intent”：`buildGraphSnapshot` 只把 source 为同画布 root/fact/finding、target 为现存 intent 的 `from` 边放入 intent 引用；`parseHubDecision` 只接受 `intents[].from`/`complete.from` 的 canonical UUID，并校验其属于 referableIds（此时新 target 尚不存在）；副作用阶段对 `intents[]` 创建 intent target 并写 `from`，对 `complete` 则把合法 source 以 `to` 连到 root。布局与折叠不得改变 referableIds 或 Hub 输入集合。

### B.5.5 数据兼容与边界

- 八类既有边不迁移、不改名；v13 只增加唯一约束、Report 连接规则与布局元数据。
- schema bump 与 A 共用一次发布，不为 A/B 各重建一次数据库。发布仍受 A Phase 0 的运行任务排空和备份门禁约束。
- 导入包必须校验 edge 两端节点存在、同属一个 canvas、类型在八类白名单中，并在 UUID remap 后再应用唯一约束。
- 服务端布局只改变坐标/布局元数据，不触发 Hub、Verify、Report 派生，不写 Agent 语义 events。

## B.6 实现分期

### Phase B1（文档 + 可观测，低风险）

1. 更新 `ARCHITECTURE` / OpenAPI 边类型表与 shared-types 一致，修正 `verifies` 方向；写清 decision/process/evidence 三种投影。
2. 前端图例：八种边按决策/流程/证据分组，工作 intent 与系统/兼容 job 分型。
3. 节点详情展示完整入边/出边与来源 Job/轮次，便于人工追 rework/verify 父级。
4. v13 增加 edge 八类 CHECK + 唯一约束，写入统一为 shared-types 校验后的原子 upsert；加入非法类型和并发重复插入验证。

### Phase B2（历史布局设想；#148 暂缓）

以下条目保留为设计史，不是当前实现计划；不得据此新增 schema 或服务端 ELK：

1. 先实现因果 round + 决策主轴/系统卫星布局，验证 rework 链，不依赖未经验证的 ELK “边权”选项。
2. Finding 聚合/展开交互；折叠前后底层 node/edge 数不变。
3. 加入 `graph_revision/layout_revision/layout_status`，服务端布局落库；前端切为权威坐标并保留明确的 stale 降级。

### Phase B3（规模与性能）

1. 对 100/500/1000 节点画布做布局耗时、WS payload、首屏与交互性能基线。
2. 按首轮 intent/Hub round 做虚拟化或分段加载，但 API/导出仍可取得完整图。
3. 只有真实使用数据证明八类边造成机器语义问题时，才另立迁移提案；本 TODO 不预设重命名。

## B.7 验收标准

1. 文档、OpenAPI、前端类型和真实数据都只出现八类规范边；`reviewed_by/tested_by` 可正确渲染，非法类型被服务端拒绝。
2. 并发写同一 edge 时数据库最终只有一条；导入重复 edge 给出确定性结果。
3. 新人能从图例理解：intent 依据什么、Finding 谁产出、Verify/Hub rework 挂在哪个 Finding。
4. 当前 90 节点/89 边样本和合成 100+ 节点样本默认可扫；折叠后主轴清晰，展开后节点/边总数不丢。
5. `finding→intent` rework 被排在触发 Finding 之后，不被固定 intent 列拉回首轮。
6. 同一 graph revision 在固定排序/种子下重算坐标稳定；complete 的 `fact→root` 不制造 rank 环，异常环产生稳定 SCC 布局与 warning；无节点矩形重叠（允许边交叉但设预算）。
7. 服务端布局完成后，Canvas API/导出坐标与完整展开 UI 一致；前端筛选/折叠不回写权威坐标。
8. Hub YAML/读图逻辑不因视觉整理而回归：`intent.from` 只接受同画布 root/fact/finding，target 必须是 intent；流程/证据边不被误当决策引用，同时 evidence fact 正文仍可用于收敛判断。
9. Verify/Report/Hub 生命周期回归仍满足 `confirmed/needs_human` 收敛门禁；布局更新不创建任何 Job/event。
10. 导入旧画布或显式开发 ALTER 后先呈现 `dirty/stale`，首轮布局成功才把 `layout_revision` 追到 `graph_revision`；失败不把旧占位坐标标成权威。
11. 验证至少包含 `pnpm typecheck`、`pnpm build`、现有 convergence/control-api smoke、导入导出 round-trip、`git diff --check` 和浏览器实图检查。

## B.8 与 A 的关系

| | A 广播可见性 | B 连线/布局 |
|--|-------------|------------|
| 问题 | 投递不可见 | 图语法乱、不可读 |
| 是否改调度语义 | 否 | 否；只补约束、Report 可视连接与布局，不改派生规则 |
| 依赖 | `canvas-updates` | `core` 边插入 + `layout.ts` |
| 建议顺序 | Phase 0 后与 v13 基础同批 | B1 契约可先做；schema 项与 A 合并一次发布 |

---

## 总优先级建议

1. **契约先收口**：更新 ARCHITECTURE/OpenAPI/前端类型对八类边、布局权威和 schema 迁移纪律的描述；不动运行态。
2. **等待当前任务收敛 + Phase 0**：备份、恢复演练、确认单实例；运行中不做 schema 重建。
3. **一次 v13 基础发布**：A 账本与状态机、edge 唯一约束、布局 revision 元数据、导入导出支持同批落地，避免连续重建数据库。
4. **A Phase 1 UI + B Phase B1**：Job 注入详情、实时卡片、八类边图例、节点因果详情。
5. **B Phase B2**：因果 round 的服务端权威布局与 Finding 语义聚合。
6. **A Phase 2/3 + B Phase B3**：指标、受控重试、多实例租约与大图性能按真实容量数据推进。

确认后再动代码与 schema。
