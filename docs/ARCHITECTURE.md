# DeepSonar 项目方案（优化版）

> 版本：v1.1（在 v1.0 评审基础上合入崩溃恢复、幂等性、威胁建模、单一决策点等修正）
> 日期：2026-07-31

**一句话**：以 Plane 管理多审计项目进度，以无限画布承载每次运行的过程与发现链，以沙箱调度层安全执行多类 Agent（审计 → 验证 → …），Agent 只提「提案」，系统负责真正下发与记账。

---

## 1. 问题与目标

### 要解决什么

- 同时跑多个**代码扫描 / 白盒审计 / 验证**项目，需要统一看进度
- 单次运行过程（发现了什么、验没验、卡在哪）需要**可追溯的过程数据**，而不是只在聊天记录里
- Agent 需要能**派生下一步**（审计出洞 → 自动/半自动派验证），但不能失控乱起进程、乱建资源

### 非目标（第一期不做）

- 不做完整商业级红队平台 / 报告中心
- 不做全局一张超级画布
- 不让任意 Worker 直接操作 Docker / 直接改 Plane / 直接建画布
- 不一次接入所有 CLI（先 1 个）
- 不做多 Scheduler 实例横向扩展（单实例 + 数据库约束即可，见 §16）

### 成功标准（MVP）

1. 在 Plane 建一个审计项目 + 若干 Work Item，能被系统领取并跑完
2. 每个项目有一张画布；运行过程在画布上形成「任务节点 → 发现节点 → 验证节点」链
3. 审计 Agent 产出结构化 finding 后，系统能派生验证任务并写回同一张画布
4. 全程有并发限制、超时、失败可查；**调度器或沙箱崩溃后任务不悬挂**

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────┐
│  Plane（项目管理真相）                                      │
│  Project / Work Item / 状态 / 优先级 / 给人看的进度          │
└──────────────────────────┬──────────────────────────────┘
                           │ Webhook 或 轮询
┌──────────────────────────▼──────────────────────────────┐
│  Scheduler（调度与纪律）                                    │
│  队列 · claim · 限流 · 状态机 · Reaper · 规则引擎 · 回写     │
└───────┬─────────────────────────────┬───────────────────┘
        │ 起沙箱/跑 Agent              │ 结构化事件
┌───────▼──────────┐         ┌────────▼─────────┐
│  Runtime         │         │  Canvas Service  │
│  agentbox 沙箱    │         │  每项目一张画布   │
│  + Claude Code   │         │  节点/边/事件     │
└──────────────────┘         └──────────────────┘
```

### 四层职责（团队共识）

| 层 | 职责 | 不做 |
|----|------|------|
| **Plane** | 多项目、任务是否该做、完成与否、负责人 | 不存攻击图细节 |
| **Canvas** | 过程、发现、验证链、状态流转可视化 | 不负责起 Agent |
| **Scheduler** | 领任务、限流、起沙箱、执行提案、判超时、回写 | 不做业务推理 |
| **Agent** | 审计/验证等专业工作 + 调用白名单工具提案 | 不直接碰基建、不做派生决策 |

原则：

> **Plane = 管理真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**

---

## 3. 核心概念模型

### 3.1 实体关系

```
Plane.Project  1 ── 1  Canvas
Plane.WorkItem 1 ── * Job（调度任务，可重试）
Job            1 ── * Event
Job            1 ── * Canvas.Node（或一组节点）
Finding        * ── 1 Canvas.Node
Finding        可派生  Followup Job（verify 等，由规则引擎决定）
```

### 3.2 画布约定

- **每项目一张画布**（创建 Plane Project 时一并创建）
- **每次 Job** = 画布上的一个分组 / 子图，不是新画布
- 节点类型固定：

| node_type | 含义 |
|-----------|------|
| `root` | 项目根（目标、仓库、范围） |
| `job` | 一次运行（审计模块 / 验证…） |
| `finding` | 可疑/确认问题 |
| `note` | 过程说明 |
| `human` | 需人工 |

边类型：`child` / `produces` / `verifies` / `next`

**布局纪律**：节点坐标由**服务端 auto-layout 分配**——分层 DAG 布局用 **elkjs**（比 dagre 更适合"链 + 分支"结构），坐标在节点落库时算好写入 `canvas_nodes.x/y`。Agent 不能提案坐标；画布布局不在 Agent 权限内。前端只读渲染（`nodesDraggable=false`）。

### 3.3 Job 状态机与 Lease

```
pending → claimed → provisioning → running → succeeded
                                ↘ failed / timeout / cancelled / orphan
```

**Lease 机制（防悬挂，核心纪律）：**

- Job 进入 `running` 时写入 `lease_expires_at = now + LEASE_TTL`（默认 120s）
- 调度器经沙箱控制通道（agentbox-sdk）探测存活并续 lease；进程/通道断开即停续
- **Reaper**（调度器内置定时任务，默认每 30s 扫描）：
  - 发现 `status=running 且 lease_expires_at < now` → 标记 `orphan` → 强制销毁沙箱 → 按重试策略重入队或转 `failed` → 回写 Plane
  - 发现 `运行时长 > timeout_sec` → 标记 `timeout` → 同上回收
- **超时与孤儿由调度器判定，不信任 Agent 自报**。harness 上报 `done/failed` 是善意路径，Reaper 是兜底路径

### 3.4 Agent 工具白名单（只提案）

| 工具名 | 谁可调用 | 调度器落地动作 |
|--------|----------|----------------|
| `emit_progress` | Worker | 更新 job 节点文案/进度 |
| `emit_fact` | Hub 可下发的非审计工作角色 | 增量建立 fact 节点与意图边 |
| `emit_finding` | audit Worker | 增量建立 finding 节点 + 落库（可带 `suggest_verify` 建议字段） |
| `submit_hub_decision` | hub_reason | 提交 complete 或 intents 提案 |
| `mark_job_done` | Worker | 结束节点 + 摘要 |
| `request_human` | Worker | Job 转人工等待 + 画布 human 节点 |

**明确不在 Agent 权限内**（v1.1 收紧）：

- 派生验证的**决策**：`emit_finding` 只能携带 `suggest_verify: true/false` 建议，是否派生由调度器规则引擎唯一决定（见 §4.3）
- 画布节点坐标与布局
- `create_canvas` / `docker.*` / `plane.set_state`（状态由调度器在 claim/finish 时统一写）

---

## 4. 主流程（可执行路径）

### 4.1 项目初始化

> 2026-08-01 起（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md）：**本地库为唯一真相，Plane 降级为可选集成**。
> 默认路径是 Web 直接创建：`POST /projects`（plane_project_id 可空）→ `POST /projects/{id}/tasks`（同事务建任务画布 + root + pending job）。

1. 默认：在 Web「项目」页新建本地项目（或 `POST /projects`）
2. 可选：在项目「设置 → Plane 集成」绑定 Plane Project；绑定后 Ready 状态的 issue 只需标题和自然语言描述即可被认领
3. 创建任务：Web 表单、`POST /projects/{id}/tasks`、Plane Ready issue，或 `POST /projects/{id}/events` 外部事件；所有入口都先创建 `hub_reason` Job

### 4.2 调度循环（MVP）

```text
loop:
  1. 任务入队：人工任务、Plane Ready issue 或幂等外部事件 → hub_reason 决策中枢
  2. 原子 claim（DB advisory lock 串行化配额判断）→ 读取 `global_settings.effective_rules` 的全局/每项目 cap，再按“Provider → Credential → Model ID → Agent CLI”检查资源配额 → 写 jobs 表 → pg_notify('deepsonar_jobs') 事件唤醒 dispatcher；规则更新也会 notify，后续 claim 热生效
  3. Canvas：创建/更新 job 节点（running）
  4. Runtime：起沙箱（agentbox-sdk），注入任务包（repo gitClone、task.json、hooks/MCP 白名单工具）
  5. 启动 Agent（claude-code server 进程模式）；事件经 SDK 控制通道回传，调度器维护 lease
  6. 结束（正常回调 或 Reaper 判定超时/孤儿）：销毁沙箱；绑定了 Plane 的 job 尽力回写（失败只告警，不改本地终态）；Canvas 节点定格
  7. Hub 派发 audit 等角色；每个 Finding 一律自动进入多轮 verify，rework 强制回弹 Hub 补证；每条 Finding 进入 `confirmed` 时独立生成版本化 Finding Report；全部 Finding 收敛为 confirmed/needs_human 后保留并生成任务总 Report
```

### 4.3 审计 → 验证链（单一决策点）

1. `hub_reason` 根据目标派发 `audit` 等角色，审计角色输出结构化 Finding
2. Finding 只是待证实假设，**所有严重级别都必须自动派生验证**，不由人或前端决定
3. 派生前按 `fingerprint` 去重；同一 Finding 同时最多一个活跃 verify，但允许在 Hub 补证后创建下一验证轮次
4. 调度器创建 verify Job，输入 = Finding 快照 + 与硬门同源的冻结 review/test 证据快照；画布只作辅助上下文
5. Verify Worker 只提交 `confirmed` / `rework` / `needs_human` 提案（兼容输入 `false_positive` 映射为 rework）；Scheduler 检查独立 review、完整 test、来源 Job 与冲突后才可写 confirmed
6. `rework` 或 Verify 失败强制回弹 Hub，且补证只派发 review/test；`confirmed` 可触发影响验收。
7. 全部 Finding ∈ `{confirmed, needs_human}`、画布无活跃工作且 Hub complete 后，Scheduler 幂等派发该画布唯一任务总 Report。任务报告汇总全部 Finding，`needs_human` 保留在待人工章节，SARIF 仅包含 `confirmed`。
8. 每条 Finding 写入 `confirmed` 时，Scheduler 在独立 Report Job 路径派发 Finding Report：输入冻结为 `report-input.json` 并记录 SHA-256，`finding_reports` 以 `(finding_id, version)` 版本化且 `pending/generating` 期间只允许一个活跃版本。`POST /findings/:id/report` 可手动刷新/重试并创建下一版本；生成失败只标记报告失败，不回退或修改 Finding 状态。两条报告轨道互不替代。

### 4.4 Scheduler bounded contexts（Issue #37，渐进迁移）

Scheduler 的领域代码按 application/ports seam 渐进拆分，PostgreSQL 仍是唯一执行状态权威；终态/恢复调用方把已开启的事务 client 传入 application，application 不自行开启嵌套事务，也不改变外层锁顺序。人工评论入口由该 bounded context 自己拥有一个明确的外层事务。当前已落地的边界为：

- `domains/job-lifecycle`：Job 状态迁移、claim、恢复、取消与重试的 CAS 写入；
- `domains/event-ingestion`：event envelope 校验、幂等、`job_seq` 与固定窗口限流；
- `domains/hub-orchestration`：Hub 资格判断、证据快照 edge-trigger、idle/terminal 推进、人工评论唤醒、`maxHubRounds` 收口。

Hub 的每次资格检查先锁 `canvases`，再读取/锁定 waiting verification round；同一事务内才会写入 Hub Job、节点和 `next` 边。失败 Hub 会清除等待证据的 edge marker 并停在人工恢复边界，不递归生成相同快照的 Hub。`maxHubRounds` 只统计 `hub_reason.status = succeeded`，耗尽时复用 Verify 完成门；未通过完成门则设置 `auto_stopped`，不派发空图 Report。

`core.ts` 暂时保留兼容 facade，供既有 dispatcher/reaper/reconcile/routes 调用；Hub 业务实现不再由 facade 承载。Finding verification、Report convergence、runtime snapshot 与 routes registrar 仍是 #37 的后续切片。

**护栏**（同时是防注入措施，见 §9）：

- 每 Job 最大 followup 数 `MAX_FOLLOWUPS_PER_JOB`（默认 60）
- 派生深度上限 `MAX_FOLLOWUP_DEPTH`（默认 12；verify 的结果仍由规则引擎约束，不由 Agent 自行派生）
- 超出验证轮次、派生深度或 Hub 轮次护栏 → Finding 收口为 `needs_human` 并记录 human blocker；随后仍可进入报告的待人工章节

### 4.5 人工介入与恢复

- `request_human` → Job 转 `waiting_human`，Plane 标 Blocked，画布出 human 节点
- 人处理完后调用 `POST /jobs/{id}/resume` → Job 重新入队（`pending`），恢复上下文从 events/findings 表重建
- 普通 Worker 的 `request_human` 表示 Job 暂停并等待恢复；Verify 不走该路径，而是用 verdict=`needs_human` 把 Finding 收口为可报告终态

---

## 5. 模块拆分与技术选型

| 模块 | 实现 | 说明 |
|------|------|------|
| **plane-adapter** | HTTP Client | 拉 Issue、改状态、评论；字段映射 |
| **scheduler-core** | 服务 + Postgres | jobs/events、claim、状态机、限流、Reaper、规则引擎 |
| **runtime-adapter** | agentbox-sdk（TwillAI, MIT） | provision/run/stop/delete；timeoutMs；networkMode 网络隔离；local-docker 起步，可切 e2b/Daytona 云端 |
| **canvas-service** | API + React Flow 渲染 | 节点边 CRUD；auto-layout；只读 WS 推送 |
| **agent-harness** | 沙箱内包装脚本 | 读任务 JSON、调 CLI、把工具调用转成 Event API、心跳 |
| **web-ui** | React + React Flow (@xyflow/react, MIT) | 打开某项目画布；链到 Plane |

### 技术栈（已定）

- **语言：全 TypeScript**。前端 React + React Flow，后端同语言可让 `shared-types`（job/event/finding schema）前后端单源复用，避免跨语言维护两份 schema
- DB：Postgres（`jobs` / `events` / `findings` / `canvas_nodes` / `canvas_edges`）
- 队列：第一期 DB 轮询（`SELECT ... FOR UPDATE SKIP LOCKED`）；量大再 Redis
- 画布：**React Flow（@xyflow/react，MIT）+ elkjs 服务端布局**。不选 tldraw（生产商用需付费授权）与 Excalidraw（canvas2d 无法嵌入 React 组件节点），理由见 §16
- 运行时：**agentbox-sdk（TwillAI，MIT）**——TS SDK，统一 API 驱动沙箱（local-docker 起步，可切 e2b/Modal/Daytona/Vercel）与 Agent（server 进程模式，`approvalMode: "auto"` 权限完全开放，沙箱即安全边界）。Agent CLI 三家可换：**claude-code（默认）/ opencode / codex**；CLI、model 与非敏感 env_vars 只由 RoleConfig / Agents UI/API 管理，Job 创建时冻结快照，凭据按服务端 Credential 注入。`AGENT_MODE` 仍仅表示 fake/real 基础设施运行模式。事件经 SDK 控制通道回传，**不经沙箱网络**（见 §8）。已知风险：0.1.x 早期项目，靠 runtime-adapter 接口隔离，必要时 fork
- Plane：自托管 Community + API Token

暂不引入 Multica/ClawTeam，避免与 Plane 双看板；接口预留「执行器可替换」。

---

## 6. 数据表（MVP）

```text
projects
  id, plane_project_id, canvas_id, name, config_json, created_at
  -- canvas_id 为历史遗留（旧项目级画布），新项目画布按任务铸造（见 canvases）

canvases                              -- 0002 起：一任务一画布
  id, project_id, plane_issue_id, title, target_json, created_at
  -- 唯一约束: (plane_issue_id) WHERE plane_issue_id IS NOT NULL
  -- 同一 issue 重试复用同一画布；target_json = 自然语言任务 + 冻结的 network_policy.allow_egress

jobs
  id, project_id, canvas_id, plane_issue_id, parent_job_id, finding_id,
  type, status, priority, payload_json, sandbox_id,
  lease_expires_at, heartbeat_at, timeout_sec,
  followup_depth, transcript_uri,
  error, started_at, finished_at, created_at
  -- 唯一约束: (plane_issue_id) WHERE status IN ('claimed','provisioning','running')
  -- canvas_id: 任务画布；verify job 继承父审计 job 的画布

events
  id, job_id, event_id, job_seq, type, payload_json, created_at
  -- 唯一约束: (job_id, event_id)  -- 幂等去重，重试/重连重放不产生重复副作用
  -- 排序: 自增 id = 全局序；job_seq = 调度器侧每 job 单调递增局部序（不信 created_at，时钟有偏差）
  -- 只放语义事件（progress/finding/done/human），原始事件流不进此表（见 §6.2）
  -- 按月原生分区，到期 DROP PARTITION（不 DELETE，避免死元组）

findings
  id, project_id, job_id, node_id, fingerprint, title, severity,
  location, summary, suggest_verify, verify_status, raw_json, created_at
  -- 唯一约束: (project_id, fingerprint)  -- fingerprint = hash(title + location + rule)

canvas_nodes
  id, canvas_id, job_id, node_type, title, body_json,
  x, y, w, h, status, created_at, updated_at
  -- 唯一约束: (canvas_id) WHERE node_type='root'  -- 每画布一个 root（任务根，body_json.target 为目标）

canvas_edges
  id, canvas_id, from_node_id, to_node_id, edge_type, created_at
  -- edge_type: child（任务 root→job）/ produces（job→finding）/ verifies（verify→finding）

canvas_changes
  canvas_id, revision, entity_type(node|edge|meta), entity_id,
  op(upsert|delete), projection_json, changed_at
  -- PK(canvas_id, revision)；canvases.change_revision 单调递增
  -- canvases.change_floor_revision 标记保留窗口；过旧 delta 游标必须回退 L0
```

要点：

- **画布以 nodes/edges 表为真相**（好查询、好索引、好并发）；tldraw document 只做读取时的物化组装，不存整文档
- `events.event_id` 由宿主从控制工具调用生成（UUID），**所有事件处理幂等**：重复 event_id 直接返回上次结果
- `findings.fingerprint` 是派生去重和画布合并展示的基础
- 画布 L0 通过 `GET /canvases/{id}/summary` 取得当前 `revision`，运行中用
  `GET /canvases/{id}/delta?since=<revision>` 读取 `(since, upper]` 的持久化变更。
  变更日志在同一 Postgres 事务内锁画布、推进 revision、写入事件时 projection 和
  tombstone；游标低于 `change_floor_revision` 时返回 `CURSOR_GAP`，客户端只重取
  有界 L0，不重复传输历史 `body_json`。

### 6.1 Finding Schema 对齐 SARIF 2.1.0

`findings` 表字段与 SARIF（OASIS 标准，Semgrep/CodeQL 等通用）保持映射，将来接入任何扫描器或导出报告零成本：

| findings 字段 | SARIF 字段（runs[].results[]） |
|---------------|-------------------------------|
| `title` | `message.text` |
| `severity` (low/medium/high/critical) | `level`（note/warning/error）+ `properties.severity` 细分 critical |
| `location` | `locations[0].physicalLocation.artifactLocation.uri` + `region.startLine` |
| `summary` | `markdown` 版 `message` / `fullDescription` |
| `fingerprint` | `partialFingerprints`（SARIF 原生概念，语义一致） |
| `raw_json` | 整条 SARIF result 原样保留 |
| 派生规则来源 | `ruleId` → 对应 job type / audit 规则名 |

`emit_finding` 的 payload 即 SARIF result 的子集；`raw_json` 保证不丢信息。

### 6.2 存储分层（热/冷分离）

Agent 输入输出是无界数据（单次运行原始事件流可达数十 MB），**Postgres 只放可查询的语义数据**：

| 数据 | 存储 | 说明 |
|------|------|------|
| 原始事件流（text.delta、工具调用细节） | **冷**：每 job 一个 NDJSON 文件（gzip），`transcripts/{job_id}.ndjson.gz`；jobs 表存 `transcript_uri` | 只追加、极少查；SDK 事件流经调度器缓冲合并（每 2s 或 32KB 一批）后写入 |
| 语义事件（progress/finding/done/human） | **热**：events 表 | 小行、有索引，驱动调度与画布 |
| 超限 payload（> `EVENT_PAYLOAD_MAX_KB`） | 行内截断 + 全文进 blob，行里留 `blob_uri` + 头部预览 | 防 TOAST 大行拖垮扫描 |
| findings / jobs / canvas | **热**：Postgres | 结构化业务数据 |
| PoC 产物、截图等 | 冷：blob 存储 | 同 transcript 通道 |

纪律：

- **events 表永不放原始 token 流**
- 冷存储 MVP = 文件系统卷；二期换 MinIO/S3 只改 `blob_uri` 解析层
- 库备份因此保持 MB 级；冷存储走文件级快照
- 保留策略：findings 永久；transcript 默认 90 天；events 表按月分区到期 DROP PARTITION

### 6.3 索引与搜索策略

**只给确定会发生的查询建索引：**

```sql
jobs     (plane_issue_id) WHERE status IN ('claimed','provisioning','running')  -- 唯一，防双跑
findings (project_id, fingerprint)                                               -- 唯一，去重
events   (job_id, event_id)                                                      -- 唯一，幂等
jobs     (project_id, status, created_at DESC)                                   -- 列表
events   (job_id, id)                                                            -- 顺序读
findings (project_id, severity, verify_status)                                   -- 过滤
canvas_nodes / canvas_edges (canvas_id)
findings GIN (title gin_trgm_ops), GIN (location gin_trgm_ops), GIN (summary gin_trgm_ops)  -- 子串搜索
```

语义事件的限流不扫描 `events`：`event-ingestion` 在既有 Canvas → Job 锁顺序下，先以
`event_dedup` 判重，再锁定每 Job 一行的 `job_event_rate_limits`，按固定窗口更新
`progress_count`、`standard_count` 或独立的 `terminal_count`。超过额度时抛出稳定
`event_rate_limited`（含 `retry_after_sec`、bucket、limit），并由外层事务回滚 dedup、
事件、节点、边和状态副作用；重复 `event_id` 直接返回 deduped，不占额度。计数行随
数据库保留，跨 Scheduler 进程/重启仍有效，窗口回拨不会倒退。`core.applySideEffects` 还会
按 Scheduler-owned Job 类型/冻结快照重算工具授权，并要求 Job 为 `status=running`；终态、
角色种类或快照工具不一致时回滚当前 dedup、额度、事件和图副作用。项目数据导入/恢复是
历史审计写入，可按 manifest 批量恢复既有 `events` 而不消耗运行时额度；恢复完成后的新
Job 事件仍必须经过本摄入硬门。

- **JSONB 不建 GIN 全索引**；某路径高频查询后按 §17.2 expand 提升为列再加索引
- 模糊搜索用 **pg_trgm** 而非 tsvector：CJK 分词不友好；trigram 对中英混排与代码路径子串（`auth/login.php:42`）都合适
- 冷数据（transcript）不建索引，按需 grep；语义搜索（向量库）二期再评估，不污染主库

**搜索能力分档：** 结构化过滤（B-tree）→ 子串模糊（pg_trgm）→ 历史运行内容（冷存储 grep）→ 语义搜索（二期）。搜索接口限长 + `statement_timeout` 防 ReDoS/慢查询。

### 6.4 API 与推送的读放大控制

- 列表接口不返回 payload/body 大字段；detail 才返回；blob 内容单独端点支持 Range
- WS 推送只推引用（`{node_id, version}`），客户端按需拉取
- `GET /canvas` 支持 viewport/bbox 参数 + 按 job 分组折叠按需展开
- 画布加载避免 N+1：nodes/edges 两次查询取全，前端组装

---

## 7. API 草图（调度对外）

**事件写入（仅调度器内部，不暴露给沙箱）**

- 事件由调度器消费 SDK 控制通道后自行落库：`{ event_id, type, payload }`
  - `type`: `progress` | `finding` | `done` | `human`
  - 幂等：同 `event_id` 重放不产生新副作用（SDK 重连重放场景）

**管理**

- `POST /projects`  新建本地项目（plane_project_id 可空；不再预建项目级画布）
- `GET/PATCH /projects/{id}`、`POST /projects/{id}/archive`  项目详情/改名/归档（归档=软删除，历史保留）
- `POST /projects/{id}/tasks`  创建任务（同事务建画布 + root + pending job）
- `POST /tasks/{canvas_id}/retry`  重试（新建 job 复用原画布，历史保留）
- `PATCH /jobs/{id}/priority`（仅 pending 可改）
- `PUT/DELETE /projects/{id}/integrations/plane`、`POST .../plane/sync`  Plane 绑定/解绑/手动补跑
- `POST /projects/sync`  绑定 Plane 项目（兼容入口；画布随任务认领铸造）
- `GET  /projects/{id}/canvases`  任务画布列表（一任务一画布，带 rollup 计数 + 最近一次 job 状态/优先级）
- `GET  /canvases/{id}`  单任务画布节点/边
- `GET  /projects/{id}/canvas`（deprecated，仅兼容历史项目级画布）
- `POST /jobs/{id}/cancel`
- `POST /jobs/{id}/resume`  人工处理后恢复
- `POST /reconcile/run`（或定时）以 jobs 表为准修正 Plane 状态

**Plane → 系统**

- 轮询：`GET ready work items`（适配器实现）
- 或 Webhook：`issue.updated` → 入队（二期）

---

## 8. Agent 任务包与事件通道

调度器通过 agentbox-sdk 在一次性沙箱内以 server 进程方式拉起 Agent。每个 Job 都使用全新的 `/workspace`，任务内容只通过 Agent CLI 的 input 注入，不再生成 `task.json`，也不由 Scheduler 预下载或挂载代码。

系统按 Job 冻结快照动态组装：

- `/workspace/AGENTS.md` 与 `/workspace/CLAUDE.md`：平台边界、角色职责、结果契约与 RoleConfig 长期指令
- Provider 项目配置文件，以及 agentbox setup 下发的 plugin/skill/command/MCP/subagent
- 非敏感环境变量、白名单 `env_keys` 和按 Job 签发的短期模型凭据
- Hub 生成的完整、自包含 Worker prompt，等价于 CLI 的非交互 `-p "prompt"` / input
- 已准入的不可变运行镜像快照：产品/版本 ID、`name@sha256:digest`、工具清单哈希和准入扫描 ID

Worker 不假设目标类型或固定路径。是否需要代码、网页、制品或其他材料，以及是否使用 git、curl、浏览器或已有文件，由 Worker 根据 prompt 自行决定。平台只控制项目默认/任务覆盖的 `allow_egress`；最终布尔值在创建画布时冻结。Hub 不访问目标网络。

**事件通道**：事件不经过沙箱网络，经 agentbox-sdk 控制通道回传调度器侧：

- SDK normalized event stream → 文本/进度 → `progress` 事件
- 系统按 Job 动态注入本地 `deepsonar-control` MCP；MCP 只暴露、执行同源严格 schema 校验并返回 `schema_validated / pending_scheduler_validation`，不声称业务已落库，不写文件、不连接调度器
- 宿主从 Claude `stream-json` 的 `assistant` `tool_use` 块只登记 bounded pending；收到同一 `tool_use_id` 的合法非错误 `user.tool_result`（`is_error` 省略或为 `false`）后才转换为 `{v:1,event_id(UUID),type,payload}`，串行 `await onSemanticEvent`。显式错误或畸形 `is_error` 结果丢弃 pending，Agent 可用新的 call id 重试；重复结果/重放不重复释放。
- 宿主先用不含 Scheduler-owned 字段的 `ControlEventEnvelope` 严格校验（Fact 不得带 `intent_node_id`，Finding 不得带 `raw`），再转换为内部 `EventEnvelope`；`core.applySideEffects` 仍在写入前再次校验，并以 `jobs.type`/冻结快照重算工具、角色 kind，要求 Job 仍为 `running`。需要数据库的 referable/role/verification 业务约束在同一 ingest 事务中执行，失败抛稳定 `ControlInputError` 并回滚 dedup、rate-limit、event、节点和边。MCP 子进程与 Scheduler 之间没有同步业务 ack；如需该能力，须另立受治理宿主 IPC 设计。
- 非 JSON/未知 runtime 行、未知控制命名空间工具和 Agent 对 `.deepsonar/control-*` 控制文件的尝试只产生固定分类告警/指标（不记录原文），跳过后继续解析后续合法行；控制工具的 normalized telemetry 仅保留 toolName/callId 与输入 shape/count，非控制工具保持既有可观测性；不恢复可写事件文件队列
- 同一 `tool_use.id` 只有合法非错误 `tool_result` 才生成一次语义事件；pending 有上限，Job 终态会丢弃残留并记低基数告警。`list_available_roles` 仅返回动态角色清单，不生成语义事件。控制事件不依赖 Agent 可写文件，Hub 决策、人工请求与 done 同样通过动态工具提交
- Claude CLI 的 `HOME` 与 `CLAUDE_CONFIG_DIR` 固定到 `/workspace/.deepsonar/` 下的 Job 专属可写目录，不信任镜像继承的 `/root`；原始 Session 归档复用同一环境，读回内存后立即清理，随后再销毁一次性沙箱
- 数据库在新 Fact/Finding 节点提交后发出 `deepsonar_canvas_events` 通知；调度器实时回查节点正文，并用 `Agent.attach(...).sendMessage(...)` 向同一画布仍在运行的其他 Agent CLI 追加增量消息。追加消息只提供新任务数据，不改变冻结角色、网络或工具权限
- 终态后销毁该 Job 的独立沙箱；不创建或清理控制事件文件队列
- 沙箱内不注入调度器数据库或 API 凭据；Provider Credential 只换成短期 Job Token
- lease 由调度器根据控制通道存活状态维护；SDK 通道中断由 Reaper 按 lease 判定

### 8.1 Agent 配置体系（RoleConfig）

配置按“全局缺省 → 项目覆盖 → Job 冻结快照”生效，不存在旧 Profile 回退：

| 层 | 位置 | 内容 |
|----|------|------|
| 存储 | `role_configs` / `role_credentials` / `role_config_files` | CLI、模型、reasoning、长期指令、env、模块、skill、command、MCP、subagent、平台工具开关、可信镜像、Provider 配置文件与 Credential 引用 |
| 决策 | 全局 RoleConfig + 项目 RoleConfig + `projects.config_json.rules` | 项目只覆盖确有差异的角色配置；规则控制 Hub 护栏与 Worker 出网默认值 |
| 执行 | `jobs.agent_snapshot_json` | 建 Job 时必须冻结完整运行快照；Executor 不读取旧配置或为缺失快照降级 |

长期密钥不进入数据库明文字段、Job 快照或工作区文件。RoleConfig 的 `env_vars` 只能保存非敏感值；`env_keys` 经过服务端白名单；Credential 运行时换成短期 Job Token。

并发治理服从单一的调度优先级：`global_settings.rules_json` 的 effective `maxGlobalJobs`（全局硬 cap）与 `maxJobsPerProject`（每项目硬 cap）先于 Provider，Provider 先于 Credential，Credential 先于该凭据下的 Model ID，Agent CLI 全局配额最后检查。`.env` 中的 `MAX_GLOBAL_JOBS` / `MAX_JOBS_PER_PROJECT` 仅在全局规则缺失时作为启动默认；项目规则不能放宽全局硬 cap。Provider 与 Agent CLI 上限存于全局规则；Credential 的总上限 `max_concurrent`、启用模型 `allowed_model_ids` 和逐模型上限 `model_concurrency` 存于凭据公开元数据。模型目录由调度器持有密钥并调用 Provider 模型列表接口获取，前端只能接收模型 ID 清单，不能读取长期密钥；启用模型白名单后，RoleConfig 必须显式选择其中一个模型。

平台控制工具也属于 RoleConfig：每个角色只能配置自身合法工具，开关随 Job 快照冻结。关闭的工具不会出现在当次控制 MCP、动态 `AGENTS.md` / `CLAUDE.md` 或运行清单的可用列表中，执行器接收语义事件时还会再次校验授权；`core.applySideEffects` 是 fake/direct/recovery 路径的最终授权边界。`mark_job_done` 对所有角色，以及 `list_available_roles`、`submit_hub_decision` 对 Hub 是不可关闭的决策/终态工具；其余进度、事实、Finding、人工请求工具可按全局缺省或项目覆盖启停。Job 离开 `running` 后的新语义事件稳定拒绝（历史导入/恢复批量写入既有 events 是唯一例外）。

### 8.2 可信运行镜像与独立市场

镜像市场是受治理的 OCI 目录，不是任意容器执行入口。`runtime_images` 表示产品身份，`runtime_image_versions` 表示不可变版本，`project_runtime_images` 表示项目显式启用/固定版本，`runtime_image_scans` 保留每次准入或复扫证据。

- 官方 `deepsonar-base` 供 explore/analyze/review/code/hub/report，`deepsonar-audit` 供 audit；两者以固定 digest 的 `node:22-bookworm-slim` 为底（满足当前 Claude Code 的 Node 版本要求），共用 `agent-harness/runtime-images.json` 版本/来源/摘要单一定义，本地 image DSL 与生产 Dockerfile 均消费该约束并由 CI 检测漂移。
- **镜像体积是准入硬门槛**：按角色拆包、`--no-install-recommends`、不安装重复 Agent SDK/CLI、构建后清理包缓存，并在断网冒烟中以 gzip 压缩分发包检查 `maxSizeMiB`、同时报告解压层大小。重型扫描器只进入专项镜像，不允许为了“可能用到”扩张默认 base。
- `deepsonar-kali-minimal`（市场名 Kali Test）仅是 test 的官方默认镜像：固定官方 `kali-last-release` digest，预装 Python 3.10–3.14、固定 digest 的 Temurin JDK 8/11/17（默认 17，不含 21）、固定官方 Apache Maven 3.9.16、Kali 仓库的 Go/Rust 与清单化审计 CLI；Maven 位于 `/opt/deepsonar/maven` 且不预置 `.m2` 缓存。不安装 `kali-linux-*` / `kali-tools-*` metapackage、GUI、桌面或默认工具全集。Python 运行时构建后禁止联网补装，Java/Python/Maven 均提供明确的版本化命令。系统 verify 默认使用最小 Base，需要专项工具时通过 RoleConfig 显式覆盖。
- Runtime-test Worker 只消费上述镜像内的预构建工具链，禁止在 Job 内冷装/下载 JDK、Maven、Gradle 或编译器；工具缺失时必须回传结构化 inconclusive/needs_human 证据。Java/Python/Go/Rust 的静态—动态能力和证据硬门见 [`RUNTIME_TEST_TOOLCHAINS.md`](./RUNTIME_TEST_TOOLCHAINS.md)。
- OpenHarmony 专项镜像均为 `project_opt_in`：`deepsonar-openharmony-test`（源码同步与构建）、`deepsonar-openharmony-audit`（Clang 静态分析 + ASan/UBSan 工具链，面向 OOB/UAF/提权类假设）、`deepsonar-openharmony-fuzz`（libFuzzer/AFL++ 动态验证）。三者均基于 `deepsonar-base`，不烘焙全量源码或板级固件；高危挖掘时由项目启用后覆盖 audit/test/verify 的 RoleConfig，不改变全局默认。
- Job 创建于 `core.ts` 时按项目 RoleConfig → 全局 RoleConfig → 角色官方默认值解析可信版本（test → Kali Test，audit → Audit，verify 与其余角色 → Base），并立即冻结 digest；Dispatcher/Executor 只消费快照，不在执行期重新解析 tag。
- `image-admission` 是与 Scheduler 进程隔离的 Worker。它对 allowlist registry 的导入执行 digest 解析、Cosign 验签、Syft SBOM、Trivy 漏洞/凭据扫描、ClamAV 恶意文件检查、setuid 枚举和断网硬化自检。扫描通过后仍保持 quarantined，只有 `images:approve` 管理员能提升 trusted。
- 复扫失败的 trusted 版本自动 revoked，调度器/准入 Worker 会取消尚未完成的相关 Job 并精确回收它们的 sandbox ID。历史 Job 快照、Finding 和扫描记录不删除；新 digest 只进入 quarantined，不自动替换生产版本。
- 私有 registry 使用 `oci_registry` Credential，准入 Worker 仅在 `docker login --password-stdin` 时解密，不进入 Job Snapshot、Docker 参数、日志或 Agent 工作区。
- `runtime_data_layers` / `runtime_data_layer_versions` 为 Trivy/OSV 等离线库预留可版本化、只读、digest 准入模型；尚未准入的数据层不得挂载进运行沙箱。

Web 的 `/images` 是独立市场页，`/projects/:projectId/images` 是项目启用视图；新建任务仍只接收标题、内容和可选网络策略，不暴露镜像引用。

官方运行时市场只从固定 HTTPS 信任边界内的 GitHub Release `latest` 清单同步。Scheduler 启动时同步一次，并按 `DEEPSONAR_RUNTIME_REGISTRY_SYNC_SEC` 定时刷新；远端不可用时回退随部署内置的清单。正式发布清单存在版本时，环境变量镜像引用仅作为无版本场景的启动兜底，不能覆盖正式最新版本。同步后每个官方镜像只有清单首个版本保持 `promoted_at`，历史版本继续保留，供项目显式固定与既有 Job 不可变快照追溯。Issue #70 Slice B 的 v2 发布清单由 release workflow 以 ACR→GHCR→Docker Hub 顺序生成；每个已发布目的地必须通过真实 `docker buildx imagetools inspect` 并与 canonical digest 相等，`registry_evidence` 记录 inspect/provenance，配置目的地发布失败则清单生成 fail-closed。Slice C 将平台全局 `runtime_registry_channel`（默认 `github`）落库：`GET /runtime-images/registry` 返回 `selected_channel`，管理员通过 `PATCH /runtime-images/registry/channel`（`images:manage`）在 `github`、`dockerhub`、`aliyun-acr` 间切换；项目限定 token 被拒绝，且请求不接受 query/env 覆盖。apply、pull 与 Job snapshot 只消费所选通道的不可变引用；若该通道没有可信引用则 fail-closed，不回退到其它 host，历史 Job 快照不改写。

RoleConfig 不要求每个角色绑定市场镜像。空 `runtime_image_key` 表示“系统沙箱”：Scheduler 使用平台治理的最小 Base 底座创建沙箱，并在 Job 快照中记录其不可变 digest，但 RoleConfig 本身保持未绑定状态。Test 与 Audit 可默认绑定专项 Kali/Audit 镜像；其余内置角色默认使用系统沙箱。该选项不允许 Agent、Hub 或任务内容提供任意镜像引用。

发布清单的 `size_bytes` 来自不可变 OCI manifest/index 的压缩层描述符：分别汇总目标平台层大小，清单记录其中最大的平台大小，并保留各平台大小作为发布证据。该值不是本机解压后的 Docker 占用，避免不同构建机的本地 inspect 结果影响市场元数据。

### 8.3 Git 模块源（skill_sources）

Agent 的插件/skill 集中托管在 Git 仓库，每个 RoleConfig 按需勾选。数据库基线内置受信任且启用的 `DeepSonar-Skills`（`https://github.com/SummerSec/DeepSonar-Skills.git`，`main`），并使用由仓库 URL 派生的稳定 UUID；catalog 不固化到 schema，仍由受控同步接口获取并缓存：

- `POST /skill-sources/:id/sync`：浅克隆 → 扫描 `SKILL.md`（skill）与 `commands/*.md`（slash 命令）→ catalog（含文件内容）落库缓存
- 模块归属按最近含 `.claude-plugin/plugin.json` 的祖先目录分组（= 插件）
- RoleConfig 保存原始 selector：历史 `<source_id>:<module_id>`，以及 `<source_id>:plugin:<plugin_path>`（插件下全部 skill/command）和 `<source_id>:source:*`（整源）。快照时只在 trusted + enabled 的当前 catalog 上展开，和手写 JSON 合并（按 name 去重，手写优先），随 `agent.setup()` 下发到当次 Worker
- `module_selectors`、展开模块元数据、`module_content_hash`、`skill_revisions` 与结构化 `missing_modules` 一并冻结进 Job snapshot；后续 sync 只影响下一 Job，历史 Job 只消费快照内容。插件/整源 selector 会自动纳入 sync 后新增模块，旧的显式 module 列表不会。手写 `skills_json`/`commands_json` 对同 kind/name 的 catalog 模块具有确定性优先级，被屏蔽模块从最终 expanded 集合与 hash 排除并记录 `manual-override`
- selector 解析固定以 36 字符 source UUID 开头；插件/模块路径拒绝绝对路径、空段、`..` 与 URL 解码后的保留 `:`。未信任/禁用来源、缺失插件、空 catalog、手工覆盖和同一 skill/command 命名空间内的重复名称写入明确 missing；重复名称的全部冲突模块排除，不依赖 catalog 顺序覆盖写入
- catalog 与最终展开集合的内容哈希覆盖 plugin/name/description 与文件内容；Job 证据 manifest/runtime evidence/API 详情均保留 missing_modules，旧快照按空数组兼容。Runtime materializer 在 mkdir/upload 前对 command/subAgent/skill 名称及 skill 文件相对路径做 normalize/resolve 子树校验，路径穿越、绝对路径和控制字符直接拒绝
- 内容在 sync 时缓存，跑任务不再访问 Git —— 断网/私有网络也能跑

### 8.4 图语义与 hub 循环（Cairn 式自驱审计）

画布升级为 **fact-intent 二分图**（参考 Cairn 的 blackboard 架构）：agent 不直接决定下一步，只把发现写进画布；**hub agent 读整张图做决策**。

- 节点：`intent`（意图，与角色 job **1:1**，状态即认领态：pending=未认领 / running=进行中 / succeeded=已结论）、`fact`（事实，角色 agent 的产出）
- 边：`from`（被引用事实 → 新意图）、`to`（意图 → 产出事实；收敛时 事实 → root）
- **hub_reason**（job 类型，也是所有任务的统一入口）：输入 = 任务内容 + 服务端 `GraphScope=hub` 投影；需要派发时由 Hub 调用 `list_available_roles` 动态系统工具获取数据库角色，再通过 `submit_hub_decision` 提交 complete 或 intents；intent 的 `prompt` 必填并直接注入 Worker CLI，首次决策不得在没有执行证据时直接完成
- Hub 可下发工作角色输入 = 自包含 intent prompt + 服务端 `GraphScope=agent` 引用邻域；执行中每发现一个新事实就调用 `emit_fact`，一轮可产出多个增量事实并立即建立 fact 节点 + to 边；`audit` 则用 `emit_finding`
- **事件触发，无定时任务**：角色 job 的 `done` 事件 → `finalizeJob` → 同事务触发 hub（单画布同一时间最多一个活跃 hub；`maxHubRounds` 轮次上限防失控）
- 规则：`hubEnabled`（默认 true，per-project `config_json.rules` 或 `DEEPSONAR_HUB_ENABLED` 可覆盖关闭）、`maxHubRounds`、`maxIntentsPerDecision`；`allowEgress` 同样默认 true，任务创建时可覆盖并冻结到画布
- **角色注册表（Phase ② 已落地）**：`schema.sql` 只负责首次建库写入可编辑的内置模板，运行时以 `agent_roles` 为唯一真相。Hub 需要派发时主动调用 `list_available_roles` 平台工具；工具从数据库查询 `kind='role'`，再按项目 `config_json.roles.enabled` 过滤，不把角色清单预埋进 prompt，也不维护代码侧固定角色枚举。`submit_hub_decision` 落地时调度器用同一数据库边界再次校验，缺失、停用或 system/hub 角色会令整次决策失败，不做默认回退。默认模板包含 `audit/explore/analyze/review/test/code` 六个工作角色；所有 `kind='role'` 条目（包括内置模板）都可删除或新增。`verify/report` 为调度器专用系统角色，`hub_reason` 为唯一中枢，三者都不进入 Hub 可派发清单且不可删除，但职责描述和 RoleConfig 均可修改。其中 `audit` 产出 Finding，其余工作角色产出 Fact
- **角色颜色（Schema v16）**：`agent_roles.ui_color` 仅允许 `#RRGGBB`，由 Scheduler 在创建事务内持 `deepsonar_role_color_allocator` advisory lock，从非语义保留色的共享调色板分配；调色板耗尽后先用稳定、最大间距的 HSL 候选，再用覆盖完整 `2^24` 色域的确定性 RGB 置换，跳过保留色、已占用色和过暗颜色，色域真正耗尽才失败。删除角色会释放颜色，导入包里的颜色只是提示，保留色/冲突色/缺失色会在同一锁内重映射；system / hub 角色始终为 `NULL`。角色 Job 创建时把最终色冻结进 intent/job `body_json`，旧节点安全回退语义色；前端边 stroke/marker 取源节点最终色，`edge_type` 只控制 dash 与动画速度。
- **语义事件限流（Schema v17 / Issue #57）**：`job_event_rate_limits` 为每 Job 持久化固定窗口计数行；`progress`、普通语义事件与 `done`/`human` 终态控制事件使用独立预算。摄入事务在 dedup 后锁行并原子递增；超限是带 `event_rate_limited` 与 retry 元数据的全事务拒绝，重放不占预算。
- **事件触发任务**：`POST /projects/{id}/events` 接收 `source/event_type/event_id/data`；`project + source + event_id` 唯一，重复投递返回原画布和入口 Job，不重复执行
- Phase ③：elkjs 分层布局 + hint 注入（human 节点已入 hub 上下文 hints）

### 8.5 图上下文预算与读图作用域

调度器在服务端按 Job 类型生成分级图投影，不把整张过程图直接注入每个沙箱：

| Scope | 默认字符硬预算 | 注入内容 |
|-------|----------------|----------|
| `hub` | 48,000 | 全 Finding `verify_status` 索引、开放意图、事实索引、近期/触发相关摘要与 hints |
| `agent` | 16,000 | 自包含 prompt 作为独立主输入；图投影仅提供 intent 元数据、`from` 引用邻域与已确认背景 |
| `verify` | 24,000 | 目标 Finding 与相关验证证据短字段；硬门权威仍是冻结证据快照 |
| `report` | 8,000 | 目标与状态元数据；完整输入以 Scheduler 生成的 `report-input.json` 为准 |

预算由 `MAX_GRAPH_YAML_CHARS_HUB/AGENT/VERIFY/REPORT` 配置但由 Scheduler 强制执行。超预算时投影写入顶层 `truncated: true` 与 `omitted` 计数；返回的 `referableIds` 始终来自完整画布，供服务端校验 `intent.from`。每次投影的 scope、字符数、节点计数和截断状态写入 Job runtime evidence，并暴露为 Prometheus 计数器。

`report` Job 的 `payload_json.kind` 区分 `task_report` 与 `finding_report`。前者绑定画布 Root 的 `analysis_complete → reporting → succeeded` 生命周期并消费 Scheduler 生成的任务级 `report-input.json`；后者只绑定一条已确认 Finding，消费带 SHA-256 校验的冻结输入，不推进 Root，也不改变 Finding 的 `verify_status`。单 Finding 输入由 `MAX_FINDING_REPORT_INPUT_CHARS`（默认 40000）限制；截断时冻结 JSON 显式记录 `input_truncated`、预算与各类省略计数，Executor 在注入模型前再次执行同一上限。

---

## 9. 安全与资源策略

### 9.1 威胁建模：被审计代码 = 不可信输入

这是审计平台与普通 AI 工作流的本质区别：

| 威胁 | 对策 |
|------|------|
| 被审计代码中埋 **prompt injection**（注释诱导 Agent 乱提案、外泄源码） | 审计沙箱默认**断外网**；工具白名单收口；followup 频次/深度护栏（§4.3）；system prompt 中声明仓库内容均为不可信数据 |
| **PoC 由 Agent 生成**，验证 = 在沙箱执行半不可信代码 | verify 沙箱独立隔离、一次性、跑完即毁；出网白名单 |
| finding 内容含恶意 HTML/JS | finding 一律当纯数据存储；画布前端渲染防 XSS（不渲染 raw HTML） |
| 事件通道被滥用（伪造 finding、刷事件） | 事件不经沙箱网络，只走 SDK 控制通道；沙箱内无调度器凭据；payload schema 校验 + 大小上限 + 每 Job 持久化固定窗口速率限制 |
| 任务内容诱导 Agent 指定恶意镜像 | Hub 不输出镜像 ID；Scheduler 只从可信目录和 RoleConfig 解析并冻结 digest；未准入/未项目启用版本无法建 Job |
| 第三方镜像供应链投毒 | 独立准入 Worker + 固定 digest 扫描器 + 验签/SBOM/漏洞/凭据/恶意文件检查 + 管理员提升 + 周期复扫自动撤销 |

### 9.2 资源配置（MVP 默认）

| 项 | 配置建议 |
|----|----------------|
| 全局并发沙箱 | 4～8 |
| 单项目并发 | 1～2（`global_settings` 可调；项目不能放宽） |
| 默认超时 | audit 30–60min；verify 15–30min |
| Lease TTL | 120s，心跳 30s |
| 网络 | 项目默认 + 任务覆盖只得到一个 `allow_egress` 布尔值；Hub 不出网，禁止出网 Worker 使用 internal bridge，模型请求只能经固定目标 Gateway sidecar 到 `/gateway` |
| 工作区 | 每个 Job 使用全新可写 `/workspace`；Worker 自行决定是否获取代码或其他材料 |
| 密钥 | 仅调度器注入，不进画布正文 |
| 审计日志 | 所有语义 event 落库；原始流进冷存储；均可导出 |
| 敏感信息 | transcript 含客户源码、finding 可能含挖到的硬编码密钥 → 冷存储 at-rest 加密、访问走鉴权端点、finding 展示前密钥脱敏（gitleaks 规则） |

---

## 10. 分阶段规划

### Phase 0 — 骨架（约 3～5 天）

- [ ] Postgres schema（含 event_id / fingerprint / lease 字段，一次建对）
- [ ] Scheduler 空转：手动插入 job → running → succeeded
- [ ] Reaper：lease 过期 → orphan → 回收（先用假沙箱测）
- [ ] agentbox-sdk（local-docker）跑通 findOrProvision / run / delete + claude-code 冒烟
- [ ] Plane API：读一个 Issue、改状态、写评论

### Phase 1 — 单类型闭环（约 1～2 周）

- [ ] `audit_module` 一种任务类型
- [ ] 轮询 Plane Ready → claim → 沙箱 → 假 Agent（脚本模拟 finding）
- [ ] Event API（幂等）+ 画布节点落库（可先无 UI，只存 JSON 用简单页展示）
- [ ] 结束回写 Plane；杀沙箱/杀调度器演练 Reaper 兜底

**验收**：Plane 一条任务变成 Done，库里有 finding，画布有节点；中途杀掉沙箱任务能转 orphan/failed 而不悬挂。

### Phase 2 — 真 Agent + 画布 UI（约 1～2 周）

- [ ] Harness 对接 Claude Code
- [ ] 前端：打开项目画布（React Flow），只读轮询或 WS
- [ ] `emit_finding` / `emit_progress` / `mark_job_done` 真实可用
- [ ] token 用量与成本记账

**验收**：对真实仓库一个小模块跑出真实 finding 并上图。

### Phase 3 — 派生验证（约 1 周）

- [x] 规则引擎（全部 Finding 自动验证）+ fingerprint 去重 + 多轮/深度/频次护栏
- [x] verify Worker（独立沙箱策略）+ 冻结证据快照 + `verifies` 边
- [x] 普通 Worker `request_human` / `resume` 与 Verify `needs_human` 收口分流
- [ ] Plane 可选自动建子 Issue

**验收**：任意严重度 Finding 自动出现验证节点；证据不足回弹 Hub 补证并再验；重复 Finding 不重复落库；每条 `confirmed` Finding 有独立版本化报告；全部 Finding 收敛后自动生成任务总报告。

### Phase 4 — 多项目与打磨（持续）

- [ ] 全局/每项目限流、失败重试策略、reconcile 定时任务
- [ ] 画布分组、过滤 job、节点详情侧栏
- [ ] 配置化任务类型（第二种 audit 规则 / 依赖扫描等）
- [ ] （可选）Lead Agent 做模块拆分提案（仍只提案，进规则引擎）
- [ ] （可选）执行器换成 agentbox；编排对接 ClawTeam，接口不变

---

## 11. 目录结构

```text
deepsonar/
  apps/
    scheduler/          # 核心调度（含 canvas-api，第一期合并）
    web/                # 画布前端（React + React Flow）
  packages/
    plane-client/
    runtime-sandbox/    # agentbox-sdk 封装（local-docker / e2b / daytona 可切）
    shared-types/       # job/event/finding schema（前后端单源）
  agent-harness/        # 沙箱镜像定义 + hooks/MCP 白名单工具约定
  deploy/
    docker-compose.yml  # postgres + scheduler + web
  docs/
    ARCHITECTURE.md     # 本文档
    EVENT_SCHEMA.md     # 事件 JSON Schema（待补）
```

---

## 12. 配置项清单

```text
PLANE_BASE_URL=
PLANE_API_TOKEN=
PLANE_READY_STATE=Ready

MAX_GLOBAL_JOBS=12             # global_settings 未配置时的启动默认
MAX_JOBS_PER_PROJECT=4         # global_settings 未配置时的启动默认

DEFAULT_AUDIT_TIMEOUT_SEC=7200
DEFAULT_VERIFY_TIMEOUT_SEC=3600
LEASE_TTL_SEC=120
HEARTBEAT_INTERVAL_SEC=30
REAPER_INTERVAL_SEC=30

AUTO_VERIFY_SEVERITIES=low,medium,high,critical
MAX_FOLLOWUPS_PER_JOB=60
MAX_FOLLOWUP_DEPTH=12
MAX_AUTO_RETRIES=6

DEEPSONAR_HUB_ENABLED=true
DEEPSONAR_HUB_MAX_ROUNDS=20
DEEPSONAR_HUB_MAX_INTENTS=6

SANDBOX_PROVIDER=local-docker
DOCKER_IMAGE_AUDIT=deepsonar-agent:latest
EVENT_PAYLOAD_MAX_KB=256

# Scheduler-authoritative semantic-event fixed-window budgets (Issue #57).
# progress and terminal/control events use independent buckets.
EVENT_RATE_LIMIT_WINDOW_SEC=60
EVENT_RATE_LIMIT_PROGRESS_PER_WINDOW=30
EVENT_RATE_LIMIT_STANDARD_PER_WINDOW=120
EVENT_RATE_LIMIT_TERMINAL_PER_WINDOW=8

BLOB_STORE=fs
BLOB_DIR=./data/blobs
TRANSCRIPT_RETENTION_DAYS=90
EVENT_FLUSH_INTERVAL_MS=2000
EVENT_FLUSH_MAX_KB=32
SEARCH_STATEMENT_TIMEOUT_MS=3000
EVENTS_PARTITION_RETENTION_MONTHS=6
CANVAS_LAYOUT=auto
```

调度并发的运行时权威源是设置页或 `PATCH /global-settings` 写入的
`global_settings.rules_json`。有效值可通过 `GET /global-settings` 的
`effective_rules` 查看：包括 `maxGlobalJobs`、`maxJobsPerProject` 与
`maxConcurrentByAgentCli`。修改规则会发送 `pg_notify('deepsonar_jobs')`，无需
重启即可影响后续 claim；已运行 Job 不会被强制终止。

---

## 13. 风险与对策

| 风险 | 对策 |
|------|------|
| Agent 胡写、死循环派生 | 白名单工具 + followup 频次/深度护栏 + 超限转人工 |
| 被审计代码 prompt injection | 见 §9.1 威胁建模（断网、白名单、payload 校验） |
| 沙箱/调度器崩溃任务悬挂 | Lease + 心跳 + Reaper（§3.3） |
| 事件重试产生重复副作用 | event_id 幂等 + finding fingerprint 去重（§6） |
| 事件顺序错乱（时钟偏差） | 自增 id 全局序 + job_seq 局部序，不信 created_at |
| 原始事件流撑爆数据库 | 热冷分层（§6.2）：语义事件入库，原始流进文件 |
| 大字段读放大 | 列表不含 payload、blob 单独端点、WS 只推引用（§6.4） |
| 备份体积失控 | 库内无原始流，pg_dump 保持 MB 级；冷存储文件级快照 |
| 敏感信息二次泄露（源码/密钥进 transcript 与 finding） | at-rest 加密 + 鉴权访问 + 展示前脱敏（§9.2） |
| 与 Plane 状态不一致 | 以 jobs 表为准；定时 reconcile |
| 画布节点爆炸 | 按 job 分组折叠；finding 按 fingerprint 合并展示 |
| CLI 输出不稳定 | Harness 强约束 JSON schema；失败可重试 1 次 |
| 双看板诱惑 | 明确 Plane 给人、不引入第二套 PM 直到有明确痛点 |

---

## 14. 开工顺序

1. 建仓库 + `docker-compose`（Postgres）
2. 按 §6 建表（**一次把 event_id / fingerprint / lease 字段建对**）
3. 实现 `jobs` 状态机 + 手动 `POST /jobs` + Reaper
4. Plane 适配器：list ready / update state
5. runtime 适配层：agentbox-sdk local-docker 最小封装
6. 假 Agent 脚本打通 Event → DB（含幂等重试演练）
7. 再挂真 CLI 与画布 UI

---

## 15. 结论摘要

| 决策 | 选择 |
|------|------|
| 项目管理 | **Plane** |
| 过程数据 | **每项目一张无限画布**（nodes/edges 表为真相） |
| 执行隔离 | **agentbox-sdk 沙箱**（local-docker 起步，可切云端 provider） |
| 调度 | **自研薄调度 + 状态机 + Lease/Reaper**（单实例） |
| Agent 智能 | **提案式工具**；派生决策收归规则引擎 |
| 可靠性 | **事件幂等 + finding 去重 + 崩溃可恢复** |
| 安全 | **被审计代码视为不可信输入**，沙箱默认断网 |
| MVP 范围 | 单 CLI、单审计类型、自动高危验证、画布可展示链条 |

按 **Phase 0 → 3** 做，就有一条可演示的闭环：**Plane 下发 → 沙箱审计 → 画布记过程 → 自动验证 → 状态回写**，且崩溃不悬挂、重试不重复、注入难失控。

---

## 16. 已知取舍（明确记录，避免后期争论）

- **单 Scheduler 实例**：MVP 假设单实例运行，claim 靠 DB 唯一约束兜底。多实例扩展时改用 `SELECT ... FOR UPDATE SKIP LOCKED` 竞争领取，接口不变
- **DB 轮询而非 Webhook/Redis**：延迟秒级可接受；二期再升级
- **画布不做多人协同编辑**：第一期只读展示 + 服务端写入；协同编辑是二期候选
- **verify 不直接派生下游**：Verify 只提交 verdict；Scheduler 依据硬门决定 confirmed、回弹 Hub 或 needs_human，并以多轮/深度/Hub 轮次护栏防止链式失控
- **运行时选 TwillAI/agentbox-sdk（MIT）**：TS SDK 统一驱动沙箱与 Agent，事件走控制通道不经沙箱网络（化解"审计沙箱断网"与"事件回调"的矛盾，沙箱内零凭据）。已知风险：0.1.x 早期项目（2026-07 仍活跃），靠 runtime-adapter 接口隔离，最坏情况 fork local-docker provider（代码薄）
- **沙箱内权限完全开放**（`approvalMode: "auto"`）：安全边界在沙箱层（断网/隔离/一次性），不在 Agent 层做二次权限收敛
- **不做 token 成本配额**（明确决策，如需观测后期再加用量字段）
- **不评估 Claude Agent SDK**：只用 CLI 路线（经 agentbox-sdk 的 claude-code provider）
- **不引入低代码 LLM 编排平台（Flowise / Dify / n8n / Langflow）**：它们是完整产品而非可嵌入组件，无法替代沙箱调度（不管容器生命周期、无 lease/reaper、无 Plane 同步），且会与 Claude Code CLI 的 agentic loop 重复、制造第二控制面；Flowise 另有默认无认证的安全记录问题（RAXE-2026-033）与被收购后的路线图不确定性。其画布 UI 底层即 React Flow，反向印证画布选型
- **画布引擎选 React Flow 而非 tldraw/Excalidraw**：画布本质是结构化节点-边图而非白板；React Flow（MIT）与 nodes/edges 表 1:1 映射、节点即 React 组件（finding 卡片可交互）；tldraw 生产商用有授权费用、Excalidraw 无法嵌入 React 节点。若二期需要手绘标注/多人白板协同，再单独评估 tldraw
- **全 TypeScript**：配合 React Flow 生态一套类型打通；若未来 CLI/沙箱层需要 Python 工具，通过容器内独立进程解决，不引入第二后端语言
- **迁移工具落地为手写 SQL + 轻量 runner（约 30 行）而非 Drizzle Kit**：SKIP LOCKED / 分区 / 部分索引等裸 SQL 友好、少一层 ORM 抽象；查询层用 postgres.js。纪律不变（顺序编号、启动自动 up、禁止手改库）

---

## 17. 扩展性与演进策略（改表不慌的依据）

### 17.1 稳定区 vs 自由区

| 稳定区（定列、加约束，几乎不变） | 自由区（JSONB 吸收变化） |
|----------------------------------|--------------------------|
| 状态机字段（status, lease, timeout） | `jobs.payload_json`（任务参数随类型变） |
| 幂等键（`event_id`、`fingerprint`） | `events.payload_json`（事件内容随类型变） |
| 外键骨架（project → job → event/finding/node） | `findings.raw_json`（SARIF 原文） |
| 时间戳、error | `canvas_nodes.body_json`、`projects.config_json` |

判断标准：状态机/去重/限流逻辑依赖的字段进列；"内容是什么"的字段进 JSONB。类型字段（`jobs.type`、`node_type`、`status`）一律用**字符串**，不用 Postgres enum——新增类型零迁移。

### 17.2 迁移纪律（Phase 0 第一天就建立）

- **版本化迁移工具（**Drizzle Kit** 或 node-pg-migrate）**，`migrations/000N_*.sql` 顺序编号，禁止手改库
- 启动时自动 `migrate up`；每个 PR 必须带迁移文件
- 破坏性变更走 **expand → migrate → contract** 三步：先加新列（可空/默认值）→ 部署 + 回填 → 稳定后删旧列；服务不停机
- MVP 单用户阶段允许"改表 + 清库重来"，但迁移文件照写，保证重来是一条命令的事

### 17.3 事件格式版本化

`events.payload_json` 约定 `v` 字段（`{ v: 1, type: "finding", ... }`）。格式演进时：新事件用新版本号落库，**历史数据不回填**（事件 append-only，本就不该改），读取端按 `parsers[v][type]` registry 分发解析。

### 17.4 扩展场景验证（设计时已推演）

| 未来场景 | 改动面 | 需要迁移 |
|----------|--------|----------|
| 新增任务类型 / 节点类型 / 事件类型 | 字符串新值 + JSONB 新形状 + 应用层代码 | ❌ |
| 自由区字段高频查询（如 CWE 编号） | expand 加列，只加不删 | ✅ 安全 |
| 换沙箱 provider / 多 Scheduler 实例 | 适配层/领取逻辑，表不动 | ❌ |
| 状态机加状态 | status 新字符串值 | ❌ |

总原则：**表结构管"关系和不变量"，JSONB 管"内容"，版本号管"格式演进"，migration 工具管"物理变更"。** 真正危险的是把易变内容固化成列，§6 已规避。

### Issue #12 调度语义补充：资格与排序分离

`jobs.priority` 只保存 `fixedPriorityForJob` 生成的固定语义档位；Hub
轮次、父 Job 和 severity delta 均不得累加。调度器先判断图资格，再在
固定档位内按 `created_at, id` FIFO（Verify 档位仍保持
critical > high > medium > low/info）。`minVerifySeverity` 仅定义 care/wait
门与 Verify 排序范围，所有 Finding 都进入 Verify 生命周期。

证据不足时，`finding_verification_rounds.requirements_json` 写入
`eligibility = "waiting_evidence"`，Finding 的 `raw_json.verification_state`
同步记录同一资格；此时不创建可运行的 `verify_finding` Job。补证 Hub
在无活跃 Hub、普通角色或 `waiting_human` Job 后按证据快照至多唤醒一次，
证据齐全后复用该 round 绑定 Verify Job。
