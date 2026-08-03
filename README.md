# DeepSonar

> 深流循迹 · 让复杂执行持续收敛
>
> Every loop converges.

DeepSonar 是一套完整的 Loop Graph 工程平台。人只需要提供任务标题和自然语言内容，`hub_reason` 读取任务画布后决定调用 Audit、Explore、Analyze、Review、Test 或 Code Agent；调度器负责状态机、幂等、沙箱、验证和过程记账，让多项目 Agent 的编排、执行、反馈与收敛形成可信闭环。

## 核心流程

```text
人工任务 / Plane Issue / 外部事件
                ↓
          Hub 决策中枢
                ↓
       Audit / Explore / Test ...
                ↓
        Finding → Verify
                ↓ confirmed
          Hub 风险验收
                ↓
       环境 / PoC / 动态验证
                ↓
          Hub 最终收敛
```

主要能力：

- 一任务一画布，完整展示 Agent 决策和执行过程；
- 新建任务只填写标题和内容；
- 人工、Plane 和幂等事件统一进入 Hub；
- Finding 必须经过验证，前后端共用统一状态；
- confirmed 风险强制进入 Hub 验收；
- 每种画布边拥有独立颜色、箭头和流动效果；
- Agent Profile、Skill 源、角色和 API Token 可在控制台管理；
- PostgreSQL 是唯一业务真相，Scheduler 启动时自动迁移；
- fake 模式无需模型凭据即可验证完整流程，real 模式通过 Agentbox 沙箱运行真实 Agent。

## 一键部署

要求：Docker 24+、Docker Compose v2。Windows 推荐 PowerShell 7，Linux/macOS 需要 POSIX shell 和 curl。

### Windows

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\deploy.ps1 up
```

### Linux / macOS

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh up
```

脚本会自动：

1. 生成 `deploy/.env`；
2. 生成随机 PostgreSQL 密码、管理员引导 Token 和 Credential 主密钥；
3. 构建 Web、Scheduler 镜像；
4. 启动 PostgreSQL、Scheduler、Web Gateway；
5. 等待数据库迁移和健康检查完成。

启动后访问：<http://127.0.0.1:8080>。

默认使用 `AGENT_MODE=fake`，可以直接验证完整编排。真实 Agent 部署、首次 Token 配置、升级、备份和故障排查见：[一键部署教程](docs/ONE_CLICK_DEPLOYMENT.md)。

常用命令：

```powershell
.\deploy\deploy.ps1 status
.\deploy\deploy.ps1 logs
.\deploy\deploy.ps1 down       # 保留数据库和 blob volume
.\deploy\deploy.ps1 up -Mode real
```

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh down         # 保留数据库和 blob volume
./deploy/deploy.sh up real
```

## 本地开发

要求：Node.js 20+、pnpm、Docker。

```bash
corepack enable
pnpm install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
pnpm db:up
pnpm dev                        # Scheduler: http://127.0.0.1:3100
pnpm dev:web                    # Web: http://127.0.0.1:5173
```

默认 `AGENT_MODE=fake`，不需要构建 Agent 镜像。Web 的 `/images` 是独立镜像市场页；项目内的 `/projects/:projectId/images` 用于启用第三方已准入镜像和固定版本。

### 官方运行时镜像与语言能力

官方运行时按职责拆包，**镜像选择以 RoleConfig 为准**（Job 创建时冻结 digest），不要用全局 env 指定 CLI 或临时 `apt` 充当工具链：

| 镜像 | 默认角色 | 主要能力 | 刻意不含 |
|------|----------|----------|----------|
| `deepsonar-base` | explore / analyze / review / code / hub / **verify** | Node 22 slim、git、系统 python3、curl、rg、jq | 多版本语言、JDK、Go、Rust、Maven、审计重器 |
| `deepsonar-audit` | **audit** | base + Semgrep、Gitleaks、ShellCheck、binutils | 完整应用构建链（如 Maven 起 Spring） |
| `deepsonar-kali-minimal`（Kali Test） | **test** | Python 3.10–3.14 + `uv`、Temurin JDK 8/11/17、固定 Apache Maven 3.9.16（`/opt/deepsonar/maven`，无预置 `.m2`）、Go、Rust、以及 audit 系 CLI | Kali metapackage/GUI、Gradle、Docker-in-Docker |

**静态审计 vs 动态验证**

- **只读代码出 Finding**（audit）：多数语言在 `deepsonar-audit` 上即可起步（Semgrep + 读仓）。
- **要 runtime_test / 编译运行 / 打 PoC**（test，必要时项目级覆盖 verify）：必须使用 **Kali Test**（或项目启用的专项镜像），**不要**把 test 绑到 base。
- base 上没有 `go` / `cargo` / `java` / `mvn`；系统仅有单版本 `python3`。test 误绑 base 时，Python 也偏弱，Go/Rust/Java 会直接 `command not found`，Agent 会浪费时间在沙箱内下载工具链（不可复现，见 [issue #11](https://github.com/SummerSec/DeepSonar/issues/11)）。
- 需要 `runtime_test` 时，Test/项目级动态 Verify 必须使用可信预构建工具链；**不要在沙箱内冷装** JDK/Maven。完整 Web+DB、Compose 全家桶任何语言都不在默认镜像范围内。
- Java、Python、Go、Rust 的静态/动态能力矩阵与证据边界见 [`docs/RUNTIME_TEST_TOOLCHAINS.md`](docs/RUNTIME_TEST_TOOLCHAINS.md)；OpenHarmony 等专项镜像为 `project_opt_in`，见 [agent-harness/README.md](agent-harness/README.md) 与 [一键部署](docs/ONE_CLICK_DEPLOYMENT.md)。

基本验证：

```bash
pnpm typecheck
pnpm build
pnpm ci:images
python agent-harness/test-local-project-api.py
```

## 数据库

- 当前完整建库入口：[database/schema.sql](database/schema.sql)
- Schema 使用说明：[database/README.md](database/README.md)
- 不维护增量 migration；Scheduler 持有 advisory lock，仅对空库套用完整基线
- 已有库的 `schema_meta.version` 与程序不一致时会拒绝启动，升级前必须备份并按项目策略重建
- `database/schema.sql` 是全新外部数据库初始化、审阅和 CI 校验的唯一结构基线

手工初始化全新数据库：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

## 外部事件触发

事件和人工任务共用 Hub 入口；`project + source + event_id` 保证重复投递不会重复执行。

```bash
curl -X POST "http://127.0.0.1:8080/api/projects/<project-id>/events" \
  -H "Authorization: Bearer <api-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "event_id":"alert-20260801-001",
    "source":"ci",
    "event_type":"security_scan_failed",
    "data":{"repository":"demo","branch":"main"}
  }'
```

事件 Token 至少需要 `tasks:write` scope，并应绑定到目标项目。

## 项目结构

```text
apps/
  scheduler/        Fastify 调度器、状态机、Hub、建库基线
  image-admission/  第三方 OCI 镜像独立准入/持续复扫 Worker
  web/              React 控制台和任务画布
packages/
  shared-types/     前后端共享 Zod schema
  plane-client/     Plane 可选集成
  runtime-sandbox/  Noop/Agentbox 沙箱适配层
database/           完整 schema 入口
deploy/             Docker 镜像、Compose 和一键部署脚本
agent-harness/      API、Hub、鉴权和真实 Agent 验收脚本
docs/               架构与实施文档
```

## 设计约束

- 本地数据库是唯一业务真相；Plane 只是可选入口；
- Agent 只提交 Finding、Fact 或决策提案，调度器是唯一副作用执行者；
- 被审计代码和外部事件都属于不可信输入；
- API Token 与模型/Plane 凭据严格分离；
- Agent 只能运行 Job 创建时冻结的已准入 digest，不能从任务内容指定 OCI 引用；
- real 模式挂载 Docker Socket，等价于较高宿主权限，只能部署在受控主机。

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [Hub 与事件触发实施方案](docs/HUB_ORCHESTRATION_AND_EVENT_TRIGGER_IMPLEMENTATION_PLAN.md)
- [一键部署教程](docs/ONE_CLICK_DEPLOYMENT.md)
- [本地项目管理迁移](docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md)
- [Plane 集成笔记](docs/PLANE_NOTES.md)
- [生产改进与优化方案](docs/PRODUCTION_HARDENING_AND_OPTIMIZATION_PLAN.md)

## License

[MIT](LICENSE)
