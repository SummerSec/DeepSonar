# DeepSonar Design

> 当前产品与系统设计摘要（as-built + 已共识演进方向）。  
> 细节与历史决策以 `docs/ARCHITECTURE.md` 为准；本文件给 Agent / 新人**先读**用。  
> 日期：2026-08 · 与代码主路径对齐（Plane 可选、本地任务为主）。

## 1. 一句话

**DeepSonar（深流循迹）**：以本地库为唯一管理真相，以任务画布为过程真相，以一次性沙箱为执行真相；多角色 Agent 只提案，调度器唯一落地副作用，通过 fact–intent 二分图与 Hub 循环把探索 → 验证 → 报告收敛。

## 2. 四层真相

| 层 | 真相 | 职责 | 不做 |
|----|------|------|------|
| **本地库 / Web** | 管理真相 | 项目、任务（画布）、角色、凭据、规则、镜像准入 | 不在 Agent 里改基建 |
| **Canvas** | 过程真相 | fact / intent / finding / job 节点与边；布局由服务端算 | Agent 不提案坐标 |
| **Sandbox** | 执行真相 | 每 Job 全新 `/workspace`；CLI + 控制 MCP | 不持长期 Provider Key |
| **Scheduler** | 副作用唯一执行者 | claim、状态机、派生 verify/report、Reaper、注入快照 | 不做业务推理 |

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。**  
> Plane 为可选集成（`docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md`）。

## 3. 核心实体（实现）

```
Project 1 ── * Canvas（= 任务；无独立 tasks 表）
Canvas  1 ── * Job
Canvas  1 ── * canvas_nodes / canvas_edges
Job     1 ── * events（语义）
Job     1 ──  transcript / evidence（冷存储）
Finding * ── 1 project + job + optional node
Finding 1 ── * finding_verification_rounds
```

| 概念 | 说明 |
|------|------|
| **任务** | 即 `canvases` 一行；API `GET /projects/:id/canvases` |
| **Job** | 一次沙箱运行：`hub_reason` / 角色名 / `verify_finding` / `report` 等 |
| **Intent** | Hub 下发；与角色 Job 1:1；`prompt` 直接注入 Worker CLI |
| **Fact** | 工作角色增量产出；可带 verification 证据块 |
| **Finding** | 审计假设 → 全量进 verify 生命周期 → confirmed / needs_human / … |
| **Root** | 画布根；阶段如 `analysis_complete` / `reporting` / `succeeded` |

## 4. 控制闭环（Hub）

```
用户建任务 → hub_reason
    → intents（角色 + 完整 prompt）
    → Worker emit_fact / emit_finding
    → finalizeJob → 再 hub_reason
    → 全部 Finding ∈ {confirmed, needs_human} 且无活跃工作
    → Hub complete → Report（系统角色）
```

纪律：

- **Agent 只提案**：`emit_*` / `submit_hub_decision` / `mark_job_done` / `request_human`；是否 verify、是否 report 由调度器决定。
- **图引用硬约束**：Hub 的 `intents[].from` / `complete.from` 必须使用同画布 `root`/`fact`/`finding` 节点的 canonical UUID（YAML `root_id` 的值）；字段名、别名、占位符或跨画布 ID 会使整次决策被拒绝。
- **控制面默认拒绝（#57）**：所有控制工具与语义事件先经 `packages/shared-types` 严格 Zod 契约（未知字段、空白文本、类型、枚举、UUID、长度、范围、预算均拒绝），再由宿主重验，最后在同一事件事务执行图/状态副作用。MCP 合法响应只代表 `schema_validated / pending_scheduler_validation`，不是落库成功；`isError` 始终带稳定 `error_code` 与人话。
- **二阶段 ack 边界**：本地 MCP 子进程不连 Scheduler/数据库，无法同步返回业务事务结果；禁止引入可写控制文件队列或未经治理的 socket。需要端到端同步业务 ack 时另立受治理宿主 IPC 架构变更。
- **控制通道不污染**：结构化 MCP `tool_use` 先进入宿主 bounded pending；只有对应 `tool_result.is_error=false` 才释放语义事件。非 JSON 运行时行、未知行和写 `.deepsonar/control-*` 的尝试只记低基数告警/指标，跳过后继续处理后续合法事件。
- **Hub 不可下发** `verify` / `report`；须先 `list_available_roles`。
- 单画布同时最多一个活跃 hub；`maxHubRounds` / followup 深度护栏。
- 验证：独立 review + test 证据硬门；rework 回弹 Hub 补证。

## 5. Job 与并发

```
pending → claimed → provisioning → running
       ↘ waiting_human
       → succeeded | failed | timeout | cancelled | orphan
```

- Lease + Reaper：超时/孤儿**调度器判定**，不信任 Agent 自报。
- 唤醒：`pg_notify('deepsonar_jobs')` 为主；轮询可关。
- 优先级：资格与排序分离（图阶段 / 收敛证据 vs 固定优先级），避免 priority 通胀。

## 6. 配置层级

| 层 | 内容 | 覆盖 |
|----|------|------|
| 全局 | `global_settings`、全局 `role_configs`、平台 skill 源、镜像市场 | 缺省 |
| 项目 | 规则、启用角色、项目 RoleConfig、出网默认 | **压过全局** |
| 任务/画布 | `target_json`、出网覆盖、（拟）Finding 协议等 | **压过项目** |
| Job | `agent_snapshot_json` 创建时冻结 | 执行只认快照 |

**冲突规则：任务 > 项目 > 全局**（RoleConfig 已如此；Finding 协议等演进配置同此心智）。

## 7. 注入与读图（as-built）

- `buildGraphSnapshot(canvasId, scope?, opts?)` → YAML：goal、facts/findings 摘要、open/concluded intents、hints。
- **GraphScope**（`hub` | `agent` | `verify` | `report`）与**整图字符预算**已在 `graph.ts` 落地（#30）；Hub/Worker/Verify 注入投影不同，仍须关注超预算截断与索引完整性。
- 单字段仍有截断（description/summary 等）；`job` 类型节点**不进** YAML。
- Skill：`skill_sources` sync catalog；RoleConfig `modules` 现为 `"source_id:module_id"` / `plugin:` / `source:*` 展开为 embedded skills/commands。手写同 kind/name 配置覆盖 catalog 模块时，最终 expanded 集合/hash 只保留实际嵌入内容，并记录 `manual-override`。Job 快照同时冻结模块元数据哈希与结构化 `missing_modules`；同一 materializer 命名空间的重名模块全部排除，禁止顺序覆盖；materializer 对组件名和 skill 文件路径执行严格子树安全校验。

## 8. 观测与证据

| 通道 | 内容 | 持久化 |
|------|------|--------|
| 语义 events | progress / finding / done / human | Postgres |
| 实时流 | text.delta / tool.call.* | 进程内 `stream-bus` + WS `/ws`；环形缓冲 |
| 过程流 | normalized NDJSON | Job 目录；**manifest 多在 finalize 后可读** |
| Session / OTLP | CLI 原始 | 冷存储 blob |

`DEEPSONAR_AUTH_REQUIRED=true` 时 HTTP 需 Bearer；**WS 鉴权与前端带 token 为已知缺口**（#38）。

## 9. 安全边界

- 被审计目标 = 不可信输入（prompt injection）。
- 长期密钥不进快照/工作区；沙箱经 **Model Gateway** 短 token 访问模型。
- 镜像：市场 digest 冻结；第三方须 image-admission；Agent 不能指定镜像。
- 出网：`allow_egress` 任务级冻结；禁出网时仅 gateway sidecar。

## 10. 前端信息架构

- 任务列表 / 任务工作台（画布 · Findings · Jobs · 报告）
- 节点语义色：`SEMANTIC_STYLE`（hub 紫、finding 红、agent 黄、fact 青…）
- **任务是否在跑：以 `active_count` / 活跃 Job 为准**；勿把 `last_job_status=succeeded` 当成任务已完成（#46）
- 画布只读；Finding 详情偏 GitHub Issue（disposition + 评论可唤醒 Hub）

## 11. 已共识演进（未完全落地）

下列方向已在 GitHub Issues 中立项，**实现前以 issue 为准**；改架构需同步 `ARCHITECTURE.md`。

| 主题 | Issue | 设计要点 |
|------|-------|----------|
| 读图预算 / GraphScope | #30 | **部分已落地**（scope + 字符预算）；索引层/Worker 邻域与可观测性可继续收紧 |
| Finding 追踪链 + 画布只看链路 | #31 | 服务端 `trace`；`traceFinding` 聚焦 |
| 整插件 / 整源挂载 | #33 | `modules` selector：`plugin:` / `source:*` |
| 实时流 + 运行中过程流 | #38 | WS 鉴权；inflight 读 `stream.ndjson` |
| 软加载 / 增量同步 | #39 | 骨架 L0 → 视口 L1 → 详情 L2；`canvas_changes` durable revision/tombstone；`delta?since=<revision>`，游标过旧显式回退 L0 |
| 分层共享资产 | #41 | platform / project / finding 只读注入；人工+Agent publish |
| 节点/边着色 + Agent 专色 | #42 | 边随源节点色；新建 role 分配未占用色 |
| 双轨报告 | #43 | 任务总报告 + 每条 confirmed 单报告 |
| 通用 Finding + CVSS | #44 | profile 可配置；任务>项目>全局；运行中显著标识；CVSS 主流版+可演进 |
| 任务卡片状态 | #46 | 任务级相位与 `active_count` 同源 |

## 12. 仓库地图

| 路径 | 职责 |
|------|------|
| `apps/scheduler` | Fastify API、dispatcher、core、verify、report、gateway |
| `apps/web` | React 工作台与画布 |
| `apps/image-admission` | 第三方镜像扫描准入 |
| `packages/runtime-sandbox` | SandboxRunner / agentbox |
| `packages/shared-types` | zod 事件与 payload 单源 |
| `database/schema.sql` | 唯一结构基线（无增量迁移；改则 bump `SCHEMA_VERSION`） |
| `docs/ARCHITECTURE.md` | 完整架构与威胁建模 |
| `deploy/` | 生产与 real 模式编排 |

## 13. 给实现者的硬约束

### 13.1 Agent 控制面输入 doctrine（D1–D6）

1. **D1 默认拒绝**：每个工具 `additionalProperties: false`；未知字段返回 `unknown_field`，不得 strip 后部分落库。
2. **D2 标识符标准形态**：节点/边只认当前画布 `referableIds` 中的 canonical UUID；Finding 绑定只认数据库 Finding UUID；角色只认本轮 `list_available_roles`；未来路径工具只认白名单前缀。
3. **D3 通道不可污染**：语义事件只能由控制 MCP 结构化提交；Agent 不能用 shell 或 `.deepsonar/control-*` 文件模拟队列；脏行告警后不得丢弃后续合法事件。
4. **D4 错误形态**：拒绝返回稳定 `error_code` + 可读消息；禁止把 PostgreSQL/`JSON.parse` 堆栈作为唯一结果；禁止 MCP 先报成功、Scheduler 后静默失败。
5. **D5 单源契约**：`shared-types` Zod schema 同时生成 MCP JSON Schema；每个工具必须有合法/非法夹具、宿主重验和业务前置条件测试。
6. **D6 纵深校验**：MCP schema → runtime/host parse → ingest/apply transaction 三层均须拒绝；任何层缺失都不算完成。

工具 → 禁止输入 → 稳定错误码：

| 工具 | 关键禁止输入 | 错误码 |
|---|---|---|
| `list_available_roles` | 非空参数、未知字段、未授权调用 | `invalid_payload` / `unknown_field` / `tool_not_allowed` |
| `emit_progress` | 空白/超长 message、percent 越界或非数字 | `invalid_progress` |
| `emit_fact` | 缺 title/description、未知字段、非法 verification 或错误 Finding 绑定 | `invalid_payload` / `unknown_field` / `invalid_verification` |
| `emit_finding` | 非法 severity、空白/超长字段、写入内部 `raw` | `invalid_payload` / `unknown_field` |
| `submit_hub_decision` | complete/intents 同时或皆无、空/半截 intent、非法 UUID/角色/预算 | `invalid_payload` / `invalid_node_ref` / `invalid_role` / `invalid_reference_budget` |
| `mark_job_done` | 空白 summary、verify 缺 verdict、rework 缺 missing_evidence、非 verify 乱传 verdict | `invalid_done` |
| `request_human` | 空白/超长 reason、未授权角色 | `invalid_human` / `tool_not_allowed` |

新增控制工具 checklist：定义严格 Zod payload + 同源 JSON Schema；列出禁止输入/错误码/业务白名单；MCP 与宿主各有合法/非法测试；core 事务断言失败全回滚；确认不写控制文件、不把普通文本当语义事件；更新本表、平台工具说明和 CI 冒烟。

1. **不扩大 Agent 权限**：镜像、凭据、派生、状态机终态只在调度器。  
2. **改表 = 改基线 + bump 版本 + 重建库验证**（直至 #34 类迁移落地）。  
3. **列表 API 不塞大 body**；大字段详情/按需（#39）。  
4. **进 prompt 的内容当不可信**；共享资产只读挂载（#41）。  
5. **配置覆盖：任务 > 项目 > 全局**；Job 只认冻结快照。  
6. 细节冲突时：`ARCHITECTURE.md` + 代码 > 本摘要；演进以 open issue 为准。

## 14. 相关文档

- `docs/ARCHITECTURE.md` — 架构全文  
- `docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md` — Plane 可选化  
- `docs/ROLE_CONFIG_AND_REPORT_PLAN.md` — 角色/报告/读图分级（含未落地 GraphScope）  
- `docs/TODO_VERIFY_*.md` — 验证与收敛  
- `AGENTS.md` / `CLAUDE.md` — 给编码 Agent 的操作手册  
