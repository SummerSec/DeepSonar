# AGENTS.md

本文件是仓库内编码 Agent 的工作说明。所有 Agent 均应先按下列顺序核对设计与代码事实，不依赖特定 CLI 或模型。

DeepSonar（深流循迹）：完整的 Loop Graph 工程平台。沙箱调度层安全执行多类 Agent（探索 → 分析 → 验证 → 反馈），Agent 只提「提案」，系统负责真正下发与记账，让复杂执行持续收敛。

**设计入口（必读顺序）**

1. **`DESIGN.md`（仓库根）** — 当前 as-built 设计摘要、实体模型、Hub 闭环、配置覆盖、已知演进（Issues）；**改功能/提方案先读它**。
2. **`docs/ARCHITECTURE.md`** — 完整架构、威胁建模、存储与状态机细则；与 `DESIGN.md` 冲突时以代码 + `DESIGN.md` 为准，并应回写 `DESIGN.md`。
3. **`docs/README.md`** — 专题文档索引与 **as-built / 历史方案 / 进行中** 状态表（大量 `*_PLAN.md` / `TODO_*.md` 主路径已落地，勿当未实现清单）。
4. 开放演进以 `DESIGN.md` §11 与代码为准（GitHub Issues 可能为空）。

## 常用命令

```bash
pnpm db:up            # 起独立开发库（deploy/docker-compose.yml，deepsonar/deepsonar@localhost:5432）
pnpm db:up:deploy     # 改连 deploy 栈同一份 Postgres（deepsonar-postgres-1；与 db:up 互斥，都占 5432）
pnpm db:rebuild       # 备份后按当前 schema.sql 重建并回填交集列（先 --plan，再 --apply）
pnpm dev              # 调度器（tsx watch，端口 3100；空库自动套用 schema.sql 基线，版本不符拒绝启动）
pnpm dev:web          # 前端（vite，5173；/api 代理到 3100）
pnpm build            # 全 workspace tsc 构建
pnpm typecheck        # 全 workspace 类型检查
```

- **测试**：单元与集成测试主要使用 Node.js `node:test`，由 `tsx --test` 执行；根 `package.json` 的 `ci:unit:*`、`ci:integration:*`、`ci:test:*` 是当前可运行入口。`agent-harness/test-*` 还包含需调度器运行的 API 冒烟脚本，常用入口有 `ci:smoke:projects`、`ci:smoke:roles`、`ci:smoke:hub`、`ci:smoke:auth`、`ci:smoke:images` 和 `ci:smoke:mcp`；后者文件名是历史命名，当前验证的是 Job 控制 API-only 契约。改动应按影响面选择脚本，不要只跑 `typecheck` 代替行为测试。
- **沙箱镜像**：`DEEPSONAR_IMAGE_TOOLSET=base|audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs`；Kali 专项镜像用 `deploy/Dockerfile.agent-kali-minimal`。镜像体积是 CI 硬门槛：base 使用 Node 22 Debian slim（匹配 Claude Code 的 Node 要求），重型工具只进专项镜像；Kali 版本无 metapackage/GUI，当前是 `test` 角色默认镜像且不要求项目 opt-in。`runtime-images.json` / `kali-minimal-runtime.json` 是版本、来源、SHA256 与大小预算定义，`pnpm ci:images` 检查漂移。
- **运行模式**：默认 `AGENT_MODE=real`（真实沙箱；默认 Agentbox，PoC 可设 `SANDBOX_PROVIDER=opensandbox`）。仅验证状态机时设 `AGENT_MODE=fake`（NoopRunner）。生产部署默认 `./deploy/deploy.sh up real pull`。
- `.env` 放仓库根目录，调度器会自动加载（config.ts 内置无依赖解析器）。
- **生产部署**：`deploy/` 含 scheduler/web/agent/image-admission/assets-helper/silo 等 Dockerfile、`docker-compose.prod.yml`（含备份与独立镜像准入 Worker）与 `deploy.sh`/`deploy.ps1`；`docker-compose.real.yml` 是本地真实沙箱联调覆盖层（`AGENT_MODE=real` + 挂 docker.sock）。核心 CI 在 `.github/workflows/ci.yml`（**PR 与 main 合并后**触发，功能分支每次 push 不再跑；main 上纯 `*.md`/`docs/`/`skills/` 跳过；可 `workflow_dispatch` 手动补跑；同 ref 并发会取消旧 run）；Chrome 与 OpenHarmony 专项 CI 分别在 `.github/workflows/chrome-runtime.yml` / `.github/workflows/openharmony-runtime.yml`，按自身 Dockerfile、配置/脚本、`.dockerignore`、共享 fingerprint/cache 机制或 workflow 变更触发；GHCR 制品发布在 `release.yml`。
- **镜像发布 / 如何更新镜像**（`release.yml` + `agent-harness/image-build-fingerprint.mjs`）：
  1. **改内容才会重建**：指纹 = schema version + Dockerfile + `.dockerignore` + 依赖路径 + build-args + platforms。GHCR 上存在 `src-<fingerprint>` 则 **跳过 docker build**，只对 **GHCR / ACR / Docker Hub** 打新版本 tag（版本照升，digest 可复用）。
  2. **常规更新步骤**：改对应 Dockerfile / `agent-harness/*-runtime.json` / OpenHarmony 脚本等 → 专项 workflow 先按路径过滤运行并通过 → 合并 main 且核心 CI 绿 → 推新 `v*` tag **或** Actions → `release` → Run workflow（`version`/`ref` 可留空：版本=最新 `v*`，源码=所选分支 HEAD）→ 看 job summary：`image build unchanged` = 未重建；否则全量构建并 pin 新 `src-*`。
  3. **只升版本号、内容未变**：仍会出新 GitHub Release 与各仓版本 tag，但 Kali 等大镜像不会重编（预期行为）。
  4. **强制重建**（内容未变也要重编）：删除 GHCR 上该镜像的 `src-<fp>` 标签后再跑 release；或改任一指纹输入（Dockerfile 注释/`.dockerignore`/依赖文件）使 fingerprint 变化；算法语义变化时 bump `FINGERPRINT_SCHEMA_VERSION`。本地可先算指纹：`node agent-harness/image-build-fingerprint.mjs --preset deepsonar-kali-minimal`。
  5. **改谁重建谁**（preset 见 `image-build-fingerprint.mjs`）：`deepsonar-base`/`audit` ← `Dockerfile.agent` + runtime-images；`kali-minimal` ← Kali Dockerfile + kali-minimal-runtime；`scheduler`/`web`/`image-admission` ← 各自 Dockerfile 与 COPY 进镜像的源码；`assets-helper` ← `Dockerfile.assets-helper`；`silo` ← `Dockerfile.silo`；`openharmony-*` / `chrome-*` ← 对应 Dockerfile/配置/脚本 + **base 的 digest**（base 变了专项镜像会跟着重编）。
  6. **发布通道**：ACR → GHCR → Docker Hub 分仓 `imagetools`（禁止一次混仓）；Docker Hub 仅当 `DOCKERHUB_USERNAME`+`DOCKERHUB_TOKEN` 齐全；缺凭据跳过该通道并记 unavailable，已配置却失败则 fail closed。多架构 index 须写镜像专属 annotations。
  7. **发布纪律**：main CI 全绿后再打新 `v*`；禁止覆盖旧 tag / 改已发布 digest 的说明；清单 `runtime-image-registry.json` 随 Release 回写默认分支。细节见 `docs/RELEASE_RUNTIME_IMAGES.md`。

## 架构要点（跨文件才能看懂的部分）

### 核心纪律

> **本地库 = 唯一真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者。** Plane 为可选集成，默认路径是 Web 直接建项目/任务。设计总览见根目录 **`DESIGN.md`**。

- **Agent 只提案，不决策**：真实 Job 注入静态 `deepsonar-control` Skill，Agent 使用短期 capability token 调用按冻结 operation allowlist 投影的 Job 级 HTTP API；五类治理 CLI 均不注入控制 MCP，也不在失败后回退其它控制通道。操作包括 `emit_progress / emit_fact / emit_finding / submit_hub_decision / mark_job_done / request_human` 的角色子集；是否派生 verify/report 与所有状态副作用仍由调度器唯一决定，并受深度、频次和收敛护栏约束。
- **Job 状态机**：`pending → claimed → provisioning → running → succeeded/failed/timeout/cancelled/orphan`。Lease + Reaper（`reaper.ts`）兜底防悬挂——超时与孤儿由调度器判定，**不信任 Agent 自报**。状态迁移统一走 `core.ts` 的 `transitionJob`。
- **幂等**：`events (job_id, event_id)` 唯一约束；`findings (project_id, fingerprint)` 唯一约束用于派生去重；事件处理重复重放无副作用。
- **调度唤醒是事件驱动**：建 job 后 `pg_notify('deepsonar_jobs')` 唤醒 dispatcher；`DEEPSONAR_DISPATCH_POLL_SEC` 与 `PLANE_POLL_INTERVAL_SEC` 默认 0（关闭轮询，Plane 走 webhook）。
- **无独立 `tasks` 表**：任务 = `canvases`；列表 `GET /projects/:id/canvases`。
- **读图注入**：`graph.ts` `buildGraphSnapshot` 按 `GraphScope` 投影 fact/finding 等 YAML 注入 Hub/Worker，并有整图字符预算（#30）；细节见 `DESIGN.md` §7。`job` 节点不进 YAML。
- **任务是否在跑**：以 `active_count`（活跃 Job）为准，勿用 `last_job_status=succeeded` 当作任务已完成（#46）。
- **配置覆盖**：**Job > 角色/项目 > 平台 > env 引导**；Job 只认创建时冻结的 `agent_snapshot_json`。

### 调度器（`apps/scheduler/src/`，Fastify + postgres.js）

| 文件 | 职责 |
|------|------|
| `index.ts` | 启动：migrate（空库套基线）→ `reconcileOnBoot` → 路由 → dispatcher/reaper/plane-sync 三个后台循环 |
| `dispatcher.ts` | 领取 pending job（全局/每项目并发上限，原子 claim）→ provision → run |
| `core.ts` | Scheduler composition root 与既有内部 import 的窄 facade；保留共享规则、Job 创建/终态编排，各领域实现通过 application/ports 注入 |
| `domains/*` | Job lifecycle、event ingestion、Hub、Finding verification、Report convergence、runtime snapshot 及各 HTTP API 的领域入口；语义事件副作用归 `event-ingestion/side-effects.ts` |
| `executor-real.ts` | 真实 agent 执行：按 `agent_snapshot_json` 冻结快照决定 provider/model/env/prompt |
| `reconcile.ts` | 重启对账 DB↔docker：孤儿容器强删、死在 provision 途中的 job 重置回 pending、running → orphan |
| `graph.ts` | fact-intent 二分图 → hub prompt 用 YAML；agent 输出结构化解析 |
| `routes.ts` | 只安装共享 auth/project-scope hook、Gateway，并组装 `domains/*/routes.ts` registrar；不承载业务 handler |
| `auth.ts` / `users.ts` | 双轨鉴权：服务/自动化用 API Token（库中只存 sha256），人用用户名密码 + 会话 Token（scrypt，角色 admin/operator/viewer，无用户时 `/auth/bootstrap` 引导）；跨回环部署须 `DEEPSONAR_AUTH_REQUIRED=true` |
| `credentials.ts` / `audit.ts` / `credential-test.ts` | Provider 凭据库 / append-only 审计（凭据明文永不入审计）/ 凭据连通性测试 |
| `gateway.ts` | Model Gateway（§6.3）：沙箱持短期单 Job token 经 `/gateway` 访问上游 LLM，不持长期 Provider Key |
| `domains/platform-api/` | Job 级控制 API、短期 capability token、按冻结权限投影的 capabilities/OpenAPI；真实 Job 的唯一控制入口 |
| `skill-sources.ts` | Git 托管 skill/command 仓库的浅克隆同步与 catalog 缓存 |
| `stream-bus.ts` | WS 实时流（前端 `/api` 代理 ws） |
| `evidence.ts` | 运行证据冷存储：OTLP/NDJSON 按 job 队列化写盘 + gzip |
| `platform-tools.ts` | 注入 Hub/Worker 的平台工具 usage 文本（`list_available_roles` 等，工具说明的单源） |
| `transfer/` | `.deepsonarpack` 项目数据导入导出：ZIP + manifest + checksums.sha256，按模块/预设选择，worker 异步执行，导入前 sanitize |
| `openapi.ts` / `metrics.ts` | OpenAPI 文档 / Prometheus 指标 |

### Hub 循环（Cairn 式图语义，§8.3）

画布是 **fact-intent 二分图**：Hub 可下发的角色 agent（explore/analyze/review/test/code/audit）只把发现写成 fact 或 Finding 节点；角色 job `done` → `finalizeJob` 同事务触发 `hub_reason` job 读整图 YAML 决策下一步 intent。Hub 的 intent 必须携带完整 `prompt`，直接作为 Worker CLI 的 input 注入。`verify` 与 `report` 是调度器专用系统角色，Hub 不可下发。**Hub 轮次由事件触发，不靠定时轮询**（任务本身可设置 `scheduled_start_at`），单画布同一时间最多一个活跃 hub，`maxHubRounds` 防失控。角色注册表在 `agent_roles`，运行配置在全局/项目 `role_configs`。

### 运行时（`packages/runtime-sandbox/`）

- `SandboxRunner` + `RuntimeHost` 是调度器与沙箱之间的唯一接口：`NoopRunner`（骨架）↔ `AgentboxRunner`（过渡实现）↔ `OpenSandboxRunner`（#162，绑定 `@alibaba-group/opensandbox@0.1.11`）。五类 CLI adapter 只依赖内部 process/file 契约，不引用 provider SDK 类型。real 默认仍走 Agentbox；`SANDBOX_PROVIDER=opensandbox` 才启用 OpenSandbox。升级只改显式 pin，禁止 `latest`。换 provider 只动这个包。
- 每个 Job 是全新沙箱，cwd 固定 `/workspace`。系统按冻结快照动态生成 `AGENTS.md` / `CLAUDE.md`、CLI 配置、plugin/skill/command/MCP/subagent 和环境变量；不预下载代码，Worker 自行决定如何获取目标。
- **系统沙箱**：RoleConfig 的 `runtime_image_key=null` 表示不绑定市场镜像；Scheduler 仍使用受治理的最小 Base 底座，并在 Job 快照中冻结不可变 digest。Test/Audit 等专项角色才默认或显式绑定专项镜像。
- **最新版本策略**：官方市场从 GitHub Release 的 `latest/runtime-image-registry.json` 同步并只提升最新版本；旧版本仅保留给显式 pin 与历史 Job，实际执行始终使用快照中的 digest，不使用可变 `latest`。
- 运行镜像由 RoleConfig 的市场 key 选择，Job 创建时冻结已准入的 `name@sha256:digest`、工具清单哈希和扫描 ID；Dispatcher 不重新解析 tag。第三方镜像只能经 `apps/image-admission` 扫描、管理员批准、项目启用后执行，Agent/Hub/任务内容都不能指定镜像引用。
- 项目只设定 Worker 默认是否出网，任务可覆盖；画布冻结最终 `allow_egress`。禁止出网时使用 Docker internal bridge，模型请求只能经 `deepsonar-gateway-proxy` 固定目标 sidecar 转发到调度器 `/gateway`。
- 语义事件由短期 capability token 授权的 Job 级 HTTP API 提交，经共享 Zod 契约、宿主重验和摄入事务落库；**不落 Worker 可写控制文件，也不从普通 CLI 文本或伪造 MCP tool call 推断事件**。同一画布的新 Fact/Finding 仅对声明 `incrementalMessages` 的 CLI 通过 `Agent.attach(...).sendMessage(...)` 追加；终态后撤销 token 并销毁沙箱。
- `env_keys` 白名单（`DEEPSONAR_ALLOWED_ENV_KEYS`，支持前缀通配）过滤 RoleConfig 下发变量；长期密钥不进快照或工作区。
- 沙箱硬限制（cpu/memory/pids/cap-drop-all/no-new-privileges）在 config 的 `sandboxLimits`，0 仅限调试。

### 数据与迁移

- **Schema**：`database/schema.sql` 是唯一基线（当前 v38，与 `apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` 一致）。空库启动时套用基线；非空库只校验 `schema_meta.version == SCHEMA_VERSION` 与表结构，版本不符 fail closed。**无增量 ALTER 链**，改表 = 改基线 + bump 版本 + 重建库。已有数据用 `pnpm db:rebuild -- --apply`（备份 + 套最新基线 + 列交集回填），不走 Scheduler 启动自动升级。
- **稳定区 vs 自由区**（§17.1）：状态机/幂等键/外键骨架进定列；"内容是什么"进 JSONB（`payload_json`、`config_json`、`body_json`、`raw_json`）。类型字段一律字符串，不用 Postgres enum。
- **配置全落库**：角色运行配置三层为全局 `role_configs` → 项目 `role_configs` 覆盖 → `jobs.agent_snapshot_json` 建 Job 时冻结；无 RoleConfig 时也冻结平台缺省，Executor 不做其他回退。
- **一任务一画布**：`canvases` 表按任务铸造，verify job 继承父审计 job 的画布；`projects.canvas_id` 是历史遗留。任务 `kind` 为 `standard` 或 `compose`：后者只能选择同项目 1–8 条当前已确认且 disposition 合法的 Finding，创建时冻结摘要并投影为只读种子节点；重试会重新校验源 Finding，失败则拒绝清空旧运行数据。
- Finding schema 对齐 SARIF 2.1.0（§6.1）；events 表只放语义事件，原始事件流进冷存储 NDJSON。

### 前端（`apps/web/`，React 19 + @xyflow/react + elkjs + Tailwind 4）

- 只读渲染（`nodesDraggable=false`）；节点坐标由服务端 elkjs 布局算好落库，Agent 不能提案坐标。
- 页面（`src/pages/`）：Dashboard、Projects、Tasks、TaskCanvas、Jobs、Findings、Agents、AgentMarketplace、RuntimeImages、PlatformSettings、ProjectData（导入导出）与 Login，经 `/api` 代理访问调度器。
- Findings 按 GitHub Issues 范式管理：disposition 状态流转 + 评论，评论可触发 hub 继续分析。

## 开发时的注意事项

- **设计变更**：先对齐 `DESIGN.md`；结构性/安全相关再改 `docs/ARCHITECTURE.md`，并更新 `DESIGN.md` §11 与相关 Issue。
- 全仓库 TypeScript ESM；`shared-types`（zod schema）是前后端/事件 payload 单源，改 schema 从这里改。
- 新增 job 类型 = 字符串新值 +（如需真实执行）在 `agent_roles` 注册，无需迁移；dispatcher 的 `isRealType` 自动识别。
- **新增 Agent CLI**：除 runtime adapter（`runtime-adapters.ts`）外，必须同步 **Session 归档**（`cli-session-adapters.ts`）与 **Job Session 查看器**（`apps/web/src/session-viewer/parseAgentSession.ts` + 测试）；保留下载原始文件。清单见 `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`「Session 归档 + Web 查看器」。
- 改表 = 直接改 `database/schema.sql` + bump `apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION`，然后重建数据库；不写增量 ALTER、不留旧结构 fallback。已有库用 `pnpm db:rebuild`。
- 被审计代码视为不可信输入（§9.1 威胁建模）：新增 Agent 可见的工具或下发内容时，检查 prompt injection 面与凭据边界。
- 需要以程序化方式操作本平台（建项目/任务、查 Job/Finding、改 RoleConfig）时，用仓库自带 skill `skills/deepsonar-management/`（API Token + OpenAPI 驱动），不要手写 curl 猜接口。
- RoleConfig `modules` 支持三类规范 selector：单模块 `"<source_id>:<module_id>"`、整插件 `"<source_id>:plugin:<plugin>"`、整来源 `"<source_id>:source:*"`；展开、冲突排除与最终内容 hash 由服务端 materializer 统一处理。
- 实时流：`stream-bus` + 短时 `POST /auth/ws-ticket` → `/ws?ticket=`（#38 已关）；运行中可读 inflight `stream.ndjson`；多 Scheduler 副本不共享内存 bus。
- Windows 探库：避免 PowerShell 弄坏 `node -e` 模板字符串；临时 `apps/scheduler/*.mjs` 跑完即删。
- **硬编码链接**：禁止在源码、测试、文档示例中写死公网第三方/中转/个人域名（如 `ai.feei.cn`、`agentrouter.org`）。需要可运行的 URL 夹具时只用 `127.0.0.1` 或内网地址（RFC1918、Docker 内部主机名）；不要用公网域名冒充上游。产品内置的官方厂商默认端点（OpenAI / Anthropic / DeepSeek）与官方发行/包管理源除外。`CLAUDE.md` 与本文件同步（符号链接）。

## 工程原则

1. **不保留向后兼容。** 过时实现直接删除，不加兼容层、不写增量 migration、不留双轨 fallback。
2. **极简优先。** 选择满足当前需求的最小方案，尽量少引入概念、状态、配置、依赖和长期维护面；能删除就不新增一层。
3. **先跑通最小端到端闭环。** 再按真实瓶颈扩展，不为假设中的未来做预防性抽象，也不为未完成的复杂度拆掉可运行主路径。
4. **模块化且边界清楚。** 关注点分离，但不把简单流程切成只增加跳转成本的薄层。
5. **不要让单文件无限膨胀。** 文件应围绕一个稳定职责组织；当一个文件出现多个变化原因、跨领域逻辑或持续增长的分支时，按领域与层次拆成可独立理解、测试和替换的模块。入口、composition root 和 route registrar 只负责组装，不堆业务实现；是否拆分看职责，不机械按行数切文件。
6. **成熟开源产品优先。** 协议、解析、布局、鉴权、沙箱、存储等通用问题，默认选经过生产验证且仍有人维护的开源项目；站在巨人的肩膀上，不以自研替代品为目标。
7. **复用顺序固定。** 先检查仓库现有依赖与平台能力，再调研成熟产品和标准方案，最后才考虑新增包或自行实现。自行实现必须说明现成方案在哪个明确约束上不适用。
8. **引入依赖要看全生命周期。** 至少核对维护活跃度、许可证、安全记录、生态采用、可替换性和运维成本；不要只因 API 顺手就引入。
9. **架构决策面向长期。** 核心边界、数据所有权和安全模型不接受“先这样以后再换”的临时方案；局部实现仍保持可删除、可替换。
10. **参考成熟产品的交互与运维模式。** 优先采用用户已经理解、社区已经验证的做法，不从零发明术语、协议或工作流。
