# 08 数据架构与真相流

> 状态：**as-built**（#741）。说明 schema 基线、核心实体、三类真相流和状态机；列定义以 `database/schema.sql` 与代码为准。
> 同步日期：2026-10-18

## Schema 基线纪律

[`database/schema.sql`](../../database/schema.sql) 是唯一基线；[`schema-version.ts`](../../apps/scheduler/src/schema-version.ts) 必须与基线的版本字面量同步，当前主线基线为 schema v59。空库启动直接套用基线；非空库的版本或结构不匹配时 fail closed。改表必须先改基线、同步版本、执行 rebuild plan/apply 并验证备份和列交集回填，不能建立未经审计的增量 ALTER 链。稳定状态、外键、幂等键和权限骨架使用定列；开放内容使用 JSONB；状态字段保持可演进字符串而非被数据库 enum 锁死。

## 核心实体和关系

| 实体/表组 | 作用 | 关键关系或约束 |
| --- | --- | --- |
| `projects`、`canvases` | 项目 scope 和任务过程容器 | Canvas 隶属项目；用户、API token、Job 和导入导出均按项目授权 |
| `canvas_nodes`、`canvas_edges`、`canvas_changes` | Intent、Fact、Artifact、Finding、Job 等过程图和 revision | 节点/边由拥有域写入；变更日志有可见 floor；Agent 不能提交坐标或任意终态 |
| `jobs`、`job_attempts` | 逻辑任务和一次执行尝试 | Job 有冻结 `agent_snapshot_json`；一个 Job 同时最多一个 active Attempt |
| `job_attempt_effects` | provision、agent run、清理等外部效果意图和 settlement | `effect_pending`/`unknown` 保护崩溃恢复；effect id 幂等；未知不得自动重放 |
| `job_tokens`、`job_capability_tokens` | Gateway 凭据与 Job-scoped Control 能力 | 存 hash/prefix 或受限加密投影；终态 Job 撤销 token |
| `events`、`event_dedup`、`job_event_rate_limits` | 语义事件、Job 序列和 durable 限流 | event id、Job sequence 和事件 dedup 约束重复；原始运行流不进入 events |
| `artifacts`、`artifact_claims`、`artifact_evidence`、`artifact_relations` | 版本化内部写入真相 | claim/evidence polarity 和 relation 类型结构化保存，旧版本可追溯 |
| `findings`、`finding_verification_rounds` | Finding 处置和 Verify 门 | `verify_status` 与人的 `disposition` 分离；round 保存 eligibility/evidence/rework 状态 |
| `finding_research_runs` 及 cluster/anchor/priority 表 | Research 语义结果与运行审计 | batch 有界、输入幂等；失败不回滚主 Finding/Report |
| `task_reports`、`finding_reports` | 冻结输入后的版本化 Projection | 一条 scope 只有一个 active 版本；输入/输出 hash 使变化追加版本 |
| `shared_assets*` | 内容寻址共享资产和 Job 版本绑定 | scope、配额、版本和 Blob hash 分离；不把文件内容直接当语义事件 |
| `credentials`、`api_tokens`、`audit_logs` | 凭据、管理身份和 append-only 审计 | 密文/nonce/tag 与安全 projection 分离；审计触发器防止更新/删除 |
| `runtime_images*`、`devices*` | 镜像信任目录和设备租约/事件 | 信任状态、摘要、租约和设备状态由对应域持有 |
| `platform_update_checks` | 平台 catalog 与当前部署版本的最近一次只读比较结果 | 单例行；由 `platform-updates` 写入，管理员读取；不触发升级或 Compose 变更 |

## 三类真相流

```mermaid
flowchart LR
    management[(PostgreSQL 管理真相)] --> canvas[Canvas 过程真相]
    canvas --> job[Job/Attempt 执行编排]
    job --> evidence[(Sandbox/Evidence 执行真相)]
    evidence --> events[结构化 events]
    events --> artifact[Artifact/Finding/Verify]
    artifact --> projection[Research/Report 投影]
    stream[stream-bus/WS] -.非权威投递.-> evidence
```

1. **管理流。** PostgreSQL 保存项目、权限、配置、Job、snapshot、token、设备、镜像目录、状态和审计。Management API 是管理流的入口，Scheduler 负责事务和状态判定。
2. **过程流。** Canvas 表保存 root、Intent、Fact、Artifact、Finding、Job、边、revision、broadcast 和 human message。Fact 的 `verification_status` 表示证据验证状态；Finding 的 `verify_status` 和人的 `disposition` 独立推进。坐标、广播注入和 ACK 都由宿主控制。
3. **执行流。** Sandbox 产生进程、工具、Session、文件和原始运行流；Scheduler 将其写入受保护的 Evidence/Blob，经过严格 schema 的语义事件才进入 `events` 和内部实体。stream-bus 只用于实时投递，断线补读只信任可见 Evidence。

Artifact、Finding、Verify、Research 和 Report 不是同一张“结果表”：Artifact 是内部写入真相，Finding 是去重和处置实体，Verify 消费结构化事实和证据，Research 只生成语义组织结果，Report 是可重建的用户投影。Projection 失败不能改写上游事实。

## 关键状态机

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> claimed
    claimed --> provisioning
    provisioning --> running
    running --> waiting_human
    waiting_human --> pending
    running --> succeeded
    running --> failed
    running --> timeout
    running --> cancelled
    running --> orphan
    failed --> pending
    timeout --> pending
    orphan --> pending
```

Job 的 `succeeded` 和 `cancelled` 是终态；`failed/timeout/orphan → pending` 必须服从 reconcile、retry 和未知效果规则。Attempt 还记录 `preparing`、`effect_pending`、`provisioned`、`agent.ready`、`settling`、`terminal`、`interrupted`、`unknown` 等 phase；`job_attempt_effects` 分 `planned/effect_pending/settled/unknown`，其 replay policy 不能由模型决定。

Verify round 有 pending/running/rework/confirmed/needs_human/failed/refuted/inconclusive，Finding 还独立保存 verify status 和 disposition。Research run 有 pending/running/succeeded/failed；Task/Finding report 有 pending/generating/succeeded/failed，并以输入 hash 区分版本。这些状态由各 bounded context 拥有，跨域事件只能通过拥有者入口推进。
