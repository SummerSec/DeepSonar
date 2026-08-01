# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DeepFlowHunter：多项目代码审计调度平台。沙箱调度层安全执行多类 Agent（审计 → 验证 → …），Agent 只提「提案」，系统负责真正下发与记账。设计文档与所有架构决策见 `docs/ARCHITECTURE.md`（v1.1），改架构前先读它。

## 常用命令

```bash
pnpm db:up            # 起 Postgres（docker compose，deploy/docker-compose.yml，dfh/dfh@localhost:5432）
pnpm dev              # 调度器（tsx watch，端口 3100，启动时自动跑 migrations）
pnpm dev:web          # 前端（vite，5173；/api 代理到 3100）
pnpm build            # 全 workspace tsc 构建
pnpm typecheck        # 全 workspace 类型检查（无 lint、无单元测试框架）
```

- **测试**：无 test runner。`agent-harness/test-*.py` 是手工 API 冒烟脚本（需调度器运行中）：`python agent-harness/test-local-project-api.py`（项目/任务 API）、`test-roles-api.py`（角色）、`test-hub-loop.py`（hub 循环）。
- **沙箱镜像**：`npx agentbox image build --provider local-docker --file agent-harness/image.mjs`（预装三家 CLI）。
- **联调不开沙箱**：`.env` 设 `AGENT_MODE=fake`（默认），dispatcher 走 NoopRunner 只跑状态机；`AGENT_MODE=real` 才经 agentbox-sdk 起真实容器。
- `.env` 放仓库根目录，调度器会自动加载（config.ts 内置无依赖解析器）。

## 架构要点（跨文件才能看懂的部分）

### 核心纪律

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。** Plane 自 2026-08 起降级为可选集成（`docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md`），默认路径是 Web 直接建项目/任务。

- **Agent 只提案，不决策**：白名单工具仅 `emit_progress / emit_finding / mark_job_done / request_human`。`emit_finding` 只能带 `suggest_verify` 建议，是否派生 verify job 由调度器规则引擎（`core.ts`）唯一决定，有深度（`MAX_FOLLOWUP_DEPTH=2`）与频次护栏。
- **Job 状态机**：`pending → claimed → provisioning → running → succeeded/failed/timeout/cancelled/orphan`。Lease + Reaper（`reaper.ts`）兜底防悬挂——超时与孤儿由调度器判定，**不信任 Agent 自报**。状态迁移统一走 `core.ts` 的 `transitionJob`。
- **幂等**：`events (job_id, event_id)` 唯一约束；`findings (project_id, fingerprint)` 唯一约束用于派生去重；事件处理重复重放无副作用。
- **调度唤醒是事件驱动**：建 job 后 `pg_notify('dfh_jobs')` 唤醒 dispatcher；`DFH_DISPATCH_POLL_SEC` 与 `PLANE_POLL_INTERVAL_SEC` 默认 0（关闭轮询，Plane 走 webhook）。

### 调度器（`apps/scheduler/src/`，Fastify + postgres.js）

| 文件 | 职责 |
|------|------|
| `index.ts` | 启动：migrate → 路由 → dispatcher/reaper/plane-sync 三个后台循环 |
| `dispatcher.ts` | 领取 pending job（全局/每项目并发上限，原子 claim）→ provision → run |
| `core.ts` | 状态机 `transitionJob`、事件入库 `ingestEvent`、规则引擎派生、hub 触发（`finalizeJob`） |
| `executor-real.ts` | 真实 agent 执行：按 `agent_snapshot_json` 冻结快照决定 provider/model/env/prompt |
| `graph.ts` | fact-intent 二分图 → hub prompt 用 YAML；agent 输出结构化解析 |
| `routes.ts` | 全部 HTTP API（项目/任务/job/画布/角色/RoleConfig/skill-source/配置/webhook） |
| `skill-sources.ts` | Git 托管 skill/command 仓库的浅克隆同步与 catalog 缓存 |
| `stream-bus.ts` | WS 实时流（前端 `/api` 代理 ws） |

### Hub 循环（Cairn 式图语义，§8.3）

画布是 **fact-intent 二分图**：角色 agent（explore/analyze/verify/test/code 等）只把发现写成 fact 节点；角色 job `done` → `finalizeJob` 同事务触发 `hub_reason` job 读整图 YAML 决策下一步 intent。Hub 的 intent 必须携带完整 `prompt`，直接作为 Worker CLI 的 input 注入。**事件触发，无定时任务**，单画布同一时间最多一个活跃 hub，`maxHubRounds` 防失控。角色注册表在 `agent_roles`，运行配置在全局/项目 `role_configs`。

### 运行时（`packages/runtime-sandbox/`）

- `SandboxRunner` 是调度器与沙箱之间唯一接口：`NoopRunner`（骨架）↔ `AgentboxRunner`（agentbox-sdk，可切 local-docker/e2b/daytona）。换 provider 只动这个包。
- 每个 Job 是全新沙箱，cwd 固定 `/workspace`。系统按冻结快照动态生成 `AGENTS.md` / `CLAUDE.md`、CLI 配置、plugin/skill/command/MCP/subagent 和环境变量；不预下载代码，Worker 自行决定如何获取目标。
- 项目只设定 Worker 默认是否出网，任务可覆盖；画布冻结最终 `allow_egress`。禁止出网时使用 Docker internal bridge，模型请求只能经 `dfh-gateway-proxy` 固定目标 sidecar 转发到调度器 `/gateway`。
- 事件**不经沙箱网络**，走 agentbox-sdk 控制通道回传；结果文件读回即删，随后销毁沙箱。
- `env_keys` 白名单（`DFH_ALLOWED_ENV_KEYS`，支持前缀通配）过滤 RoleConfig 下发变量；长期密钥不进快照或工作区。
- 沙箱硬限制（cpu/memory/pids/cap-drop-all/no-new-privileges）在 config 的 `sandboxLimits`，0 仅限调试。

### 数据与迁移

- **Schema**：`database/schema.sql` 是唯一结构基线，Scheduler 只对空库执行；本阶段不保留历史 migration 回放或增量兼容，结构变更后重建数据库。
- **稳定区 vs 自由区**（§17.1）：状态机/幂等键/外键骨架进定列；"内容是什么"进 JSONB（`payload_json`、`config_json`、`body_json`、`raw_json`）。类型字段一律字符串，不用 Postgres enum。
- **配置全落库**：角色运行配置三层为全局 `role_configs` → 项目 `role_configs` 覆盖 → `jobs.agent_snapshot_json` 建 Job 时冻结；无 RoleConfig 时也冻结平台缺省，Executor 不做其他回退。
- **一任务一画布**（migration 0002）：`canvases` 表按任务铸造，verify job 继承父审计 job 的画布；`projects.canvas_id` 是历史遗留。
- Finding schema 对齐 SARIF 2.1.0（§6.1）；events 表只放语义事件，原始事件流进冷存储 NDJSON。

### 前端（`apps/web/`，React 19 + @xyflow/react + elkjs + Tailwind 4）

- 只读渲染（`nodesDraggable=false`）；节点坐标由服务端 elkjs 布局算好落库，Agent 不能提案坐标。
- 页面：Projects/Tasks/TaskCanvas/Jobs/Findings/Agents/Settings/Dashboard，经 `/api` 代理访问调度器。

## 开发时的注意事项

- 全仓库 TypeScript ESM；`shared-types`（zod schema）是前后端/事件 payload 单源，改 schema 从这里改。
- 新增 job 类型 = 字符串新值 +（如需真实执行）在 `agent_roles` 注册，无需迁移；dispatcher 的 `isRealType` 自动识别。
- 改表必须带新迁移文件并重启调度器验证；MVP 阶段允许清库重来但迁移文件照写。
- 被审计代码视为不可信输入（§9.1 威胁建模）：新增 Agent 可见的工具或下发内容时，检查 prompt injection 面与凭据边界。
