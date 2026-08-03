# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DeepSonar（深流循迹）：完整的 Loop Graph 工程平台。沙箱调度层安全执行多类 Agent（探索 → 分析 → 验证 → 反馈），Agent 只提「提案」，系统负责真正下发与记账，让复杂执行持续收敛。设计文档与所有架构决策见 `docs/ARCHITECTURE.md`（v1.1），改架构前先读它。

## 常用命令

```bash
pnpm db:up            # 起 Postgres（docker compose，deploy/docker-compose.yml，deepsonar/deepsonar@localhost:5432）
pnpm dev              # 调度器（tsx watch，端口 3100；空库自动套用 schema.sql 基线，版本不符拒绝启动）
pnpm dev:web          # 前端（vite，5173；/api 代理到 3100）
pnpm build            # 全 workspace tsc 构建
pnpm typecheck        # 全 workspace 类型检查（无 lint、无单元测试框架）
```

- **测试**：无 test runner。`agent-harness/test-*` 是手工 API 冒烟脚本（需调度器运行中），快捷方式 `pnpm ci:smoke:projects`（项目/任务）、`ci:smoke:roles`（角色）、`ci:smoke:hub`（hub 循环）、`ci:smoke:auth`（API Token）、`ci:smoke:images`（镜像市场）、`ci:smoke:mcp`（控制 MCP）；另有 `test-credentials-api.py`、`test-gateway.py`（Model Gateway）、`test-sandbox-hardening.mts`（沙箱硬限制）。
- **沙箱镜像**：`DEEPSONAR_IMAGE_TOOLSET=base|audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs`；Kali 专项镜像用 `deploy/Dockerfile.agent-kali-minimal`。镜像体积是 CI 硬门槛：base 使用 Node 22 Debian slim（匹配 Claude Code 的 Node 要求），重型工具只进专项镜像；Kali 版本无 metapackage/GUI、仅项目显式启用。`runtime-images.json` / `kali-minimal-runtime.json` 是版本、来源、SHA256 与大小预算定义，`pnpm ci:images` 检查漂移。
- **联调不开沙箱**：`.env` 设 `AGENT_MODE=fake`（默认），dispatcher 走 NoopRunner 只跑状态机；`AGENT_MODE=real` 才经 agentbox-sdk 起真实容器。
- `.env` 放仓库根目录，调度器会自动加载（config.ts 内置无依赖解析器）。
- **生产部署**：`deploy/` 含 scheduler/web/agent/image-admission 四个 Dockerfile、`docker-compose.prod.yml`（含备份与独立镜像准入 Worker）与 `deploy.sh`/`deploy.ps1`；`docker-compose.real.yml` 是本地真实沙箱联调覆盖层（`AGENT_MODE=real` + 挂 docker.sock）。CI 在 `.github/workflows/ci.yml`，GHCR 制品发布在 `release.yml`。
- **镜像发布**：Release 必须显式向多架构 OCI index 写入各镜像专属 annotations；Docker Hub 仅在 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` 同时存在时发布，Actions 中被跳过的“凭据未配置”步骤不代表登录失败。
- **发布纪律**：先确保 main CI 全绿，再创建新的 `v*` 标签；不要覆盖旧标签或尝试修改既有 digest 的说明与证据。

## 架构要点（跨文件才能看懂的部分）

### 核心纪律

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。** Plane 自 2026-08 起降级为可选集成（`docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md`），默认路径是 Web 直接建项目/任务。

- **Agent 只提案，不决策**：系统按 Job 动态注入本地控制 MCP，工具为 `emit_progress / emit_fact / emit_finding / submit_hub_decision / mark_job_done / request_human` 的角色子集。Fact/Finding 在执行中增量回传；`emit_finding` 只能带 `suggest_verify` 建议，是否派生 verify job 由调度器规则引擎（`core.ts`）唯一决定，有深度（`MAX_FOLLOWUP_DEPTH=12`）与频次护栏。
- **Job 状态机**：`pending → claimed → provisioning → running → succeeded/failed/timeout/cancelled/orphan`。Lease + Reaper（`reaper.ts`）兜底防悬挂——超时与孤儿由调度器判定，**不信任 Agent 自报**。状态迁移统一走 `core.ts` 的 `transitionJob`。
- **幂等**：`events (job_id, event_id)` 唯一约束；`findings (project_id, fingerprint)` 唯一约束用于派生去重；事件处理重复重放无副作用。
- **调度唤醒是事件驱动**：建 job 后 `pg_notify('deepsonar_jobs')` 唤醒 dispatcher；`DEEPSONAR_DISPATCH_POLL_SEC` 与 `PLANE_POLL_INTERVAL_SEC` 默认 0（关闭轮询，Plane 走 webhook）。

### 调度器（`apps/scheduler/src/`，Fastify + postgres.js）

| 文件 | 职责 |
|------|------|
| `index.ts` | 启动：migrate（空库套基线）→ `reconcileOnBoot` → 路由 → dispatcher/reaper/plane-sync 三个后台循环 |
| `dispatcher.ts` | 领取 pending job（全局/每项目并发上限，原子 claim）→ provision → run |
| `core.ts` | 状态机 `transitionJob`、事件入库 `ingestEvent`、规则引擎派生、hub 触发（`finalizeJob`） |
| `executor-real.ts` | 真实 agent 执行：按 `agent_snapshot_json` 冻结快照决定 provider/model/env/prompt |
| `reconcile.ts` | 重启对账 DB↔docker：孤儿容器强删、死在 provision 途中的 job 重置回 pending、running → orphan |
| `graph.ts` | fact-intent 二分图 → hub prompt 用 YAML；agent 输出结构化解析 |
| `routes.ts` | 全部 HTTP API（项目/任务/job/画布/角色/RoleConfig/skill-source/镜像市场/配置/webhook） |
| `auth.ts` / `users.ts` | 双轨鉴权：服务/自动化用 API Token（库中只存 sha256），人用用户名密码 + 会话 Token（scrypt，角色 admin/operator/viewer，无用户时 `/auth/bootstrap` 引导）；跨回环部署须 `DEEPSONAR_AUTH_REQUIRED=true` |
| `credentials.ts` / `audit.ts` / `credential-test.ts` | Provider 凭据库 / append-only 审计（凭据明文永不入审计）/ 凭据连通性测试 |
| `gateway.ts` | Model Gateway（§6.3）：沙箱持短期单 Job token 经 `/gateway` 访问上游 LLM，不持长期 Provider Key |
| `control-mcp.ts` | 按 Job 动态注入的本地控制 MCP（`emit_*`/`mark_job_done` 等提案工具的服务端实现） |
| `skill-sources.ts` | Git 托管 skill/command 仓库的浅克隆同步与 catalog 缓存 |
| `stream-bus.ts` | WS 实时流（前端 `/api` 代理 ws） |
| `evidence.ts` | 运行证据冷存储：OTLP/NDJSON 按 job 队列化写盘 + gzip |
| `platform-tools.ts` | 注入 Hub/Worker 的平台工具 usage 文本（`list_available_roles` 等，工具说明的单源） |
| `transfer/` | `.deepsonarpack` 项目数据导入导出：ZIP + manifest + checksums.sha256，按模块/预设选择，worker 异步执行，导入前 sanitize |
| `openapi.ts` / `metrics.ts` | OpenAPI 文档 / Prometheus 指标 |

### Hub 循环（Cairn 式图语义，§8.3）

画布是 **fact-intent 二分图**：Hub 可下发的角色 agent（explore/analyze/review/test/code/audit）只把发现写成 fact 或 Finding 节点；角色 job `done` → `finalizeJob` 同事务触发 `hub_reason` job 读整图 YAML 决策下一步 intent。Hub 的 intent 必须携带完整 `prompt`，直接作为 Worker CLI 的 input 注入。`verify` 与 `report` 是调度器专用系统角色，Hub 不可下发。**事件触发，无定时任务**，单画布同一时间最多一个活跃 hub，`maxHubRounds` 防失控。角色注册表在 `agent_roles`，运行配置在全局/项目 `role_configs`。

### 运行时（`packages/runtime-sandbox/`）

- `SandboxRunner` 是调度器与沙箱之间唯一接口：`NoopRunner`（骨架）↔ `AgentboxRunner`（agentbox-sdk，可切 local-docker/e2b/daytona）。换 provider 只动这个包。
- 每个 Job 是全新沙箱，cwd 固定 `/workspace`。系统按冻结快照动态生成 `AGENTS.md` / `CLAUDE.md`、CLI 配置、plugin/skill/command/MCP/subagent 和环境变量；不预下载代码，Worker 自行决定如何获取目标。
- **系统沙箱**：RoleConfig 的 `runtime_image_key=null` 表示不绑定市场镜像；Scheduler 仍使用受治理的最小 Base 底座，并在 Job 快照中冻结不可变 digest。Test/Audit 等专项角色才默认或显式绑定专项镜像。
- **最新版本策略**：官方市场从 GitHub Release 的 `latest/runtime-image-registry.json` 同步并只提升最新版本；旧版本仅保留给显式 pin 与历史 Job，实际执行始终使用快照中的 digest，不使用可变 `latest`。
- 运行镜像由 RoleConfig 的市场 key 选择，Job 创建时冻结已准入的 `name@sha256:digest`、工具清单哈希和扫描 ID；Dispatcher 不重新解析 tag。第三方镜像只能经 `apps/image-admission` 扫描、管理员批准、项目启用后执行，Agent/Hub/任务内容都不能指定镜像引用。
- 项目只设定 Worker 默认是否出网，任务可覆盖；画布冻结最终 `allow_egress`。禁止出网时使用 Docker internal bridge，模型请求只能经 `deepsonar-gateway-proxy` 固定目标 sidecar 转发到调度器 `/gateway`。
- 语义事件由本地 MCP 写入控制队列，再经 agentbox-sdk 控制通道增量回传，**不经沙箱目标网络**；同一画布的新 Fact/Finding 通过 `Agent.attach(...).sendMessage(...)` 追加给仍在运行的 Agent CLI。终态后删除队列并销毁沙箱。
- `env_keys` 白名单（`DEEPSONAR_ALLOWED_ENV_KEYS`，支持前缀通配）过滤 RoleConfig 下发变量；长期密钥不进快照或工作区。
- 沙箱硬限制（cpu/memory/pids/cap-drop-all/no-new-privileges）在 config 的 `sandboxLimits`，0 仅限调试。

### 数据与迁移

- **Schema**：`database/schema.sql` 是唯一结构基线（版本号在 `schema_meta` 与 `db.ts` 的 `SCHEMA_VERSION`）；Scheduler 只对空库执行，无增量迁移，版本不符直接拒绝启动——结构变更后改基线、bump 版本、重建数据库。
- **稳定区 vs 自由区**（§17.1）：状态机/幂等键/外键骨架进定列；"内容是什么"进 JSONB（`payload_json`、`config_json`、`body_json`、`raw_json`）。类型字段一律字符串，不用 Postgres enum。
- **配置全落库**：角色运行配置三层为全局 `role_configs` → 项目 `role_configs` 覆盖 → `jobs.agent_snapshot_json` 建 Job 时冻结；无 RoleConfig 时也冻结平台缺省，Executor 不做其他回退。
- **一任务一画布**：`canvases` 表按任务铸造，verify job 继承父审计 job 的画布；`projects.canvas_id` 是历史遗留。
- Finding schema 对齐 SARIF 2.1.0（§6.1）；events 表只放语义事件，原始事件流进冷存储 NDJSON。

### 前端（`apps/web/`，React 19 + @xyflow/react + elkjs + Tailwind 4）

- 只读渲染（`nodesDraggable=false`）；节点坐标由服务端 elkjs 布局算好落库，Agent 不能提案坐标。
- 页面（`src/pages/`）：Projects/Tasks/TaskCanvas/Jobs/Findings/Agents/Settings/Dashboard/Login/ProjectData（导入导出）/RuntimeImages（独立镜像市场），经 `/api` 代理访问调度器。
- Findings 按 GitHub Issues 范式管理：disposition 状态流转 + 评论，评论可触发 hub 继续分析。

## 开发时的注意事项

- 全仓库 TypeScript ESM；`shared-types`（zod schema）是前后端/事件 payload 单源，改 schema 从这里改。
- 新增 job 类型 = 字符串新值 +（如需真实执行）在 `agent_roles` 注册，无需迁移；dispatcher 的 `isRealType` 自动识别。
- 改表 = 改 `database/schema.sql` 并同步 bump `db.ts` 的 `SCHEMA_VERSION`；无增量迁移，版本不符调度器拒绝启动，直接清库重建验证。
- 被审计代码视为不可信输入（§9.1 威胁建模）：新增 Agent 可见的工具或下发内容时，检查 prompt injection 面与凭据边界。
- 需要以程序化方式操作本平台（建项目/任务、查 Job/Finding、改 RoleConfig）时，用仓库自带 skill `skills/deepsonar-management/`（API Token + OpenAPI 驱动），不要手写 curl 猜接口。
