# DeepSonar

> 深流循迹 · 让复杂执行持续收敛
>
> Every loop converges.

DeepSonar 是一套 Loop Graph 工程平台：人提供任务标题与自然语言目标，`hub_reason` 读画布后派发 Audit / Explore / Analyze / Review / Test / Code 等角色；调度器负责状态机、幂等、沙箱、验证与过程记账，让多项目 Agent 编排可收敛、可审计。

当前设计摘要见根目录 [DESIGN.md](DESIGN.md)；行为以代码、`database/schema.sql`、OpenAPI 与测试为准。

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
          Hub 最终收敛 → Report
```

主要能力：

- **一任务一画布**（`canvases`，无独立 tasks 表），完整展示决策与执行过程；
- 新建任务只填标题和内容；Hub / 事件 / 人工评论统一进入调度闭环；
- Finding 全量进入验证生命周期；confirmed / needs_human 后可生成任务级与 Finding 级报告；
- Agent 只提案（`emit_*` / `submit_hub_decision` / `mark_job_done`），调度器是唯一副作用执行者；
- RoleConfig、Skill 源、Provider 凭据、API Token、镜像市场可在控制台管理；
- PostgreSQL 为业务真相；Scheduler 启动时对空库套 schema 基线，已有库只校验版本；
- **fake** 模式无模型凭据即可跑通状态机；**real** 模式经 Agentbox 起真实沙箱。

## Provider 与 Agent CLI

- `provider` 表示上游协议，仅支持 **Anthropic Messages** 与 **OpenAI Responses**；不内置 Anthropic、Kimi 等厂商预设。
- `agent_cli` 表示配置方言，当前支持 **Claude Code、Codex、OpenCode**。Credential 保存完整 `settings_config_json`，Job 创建时冻结并原样写入一次性 Agent 沙箱。
- 设置页可在保存前一键读取模型列表；显式 `allowed_model_ids` 只限制实际生效模型，不会由配置文件中的 model 自动生成白名单。
- 用户密码、Provider API Key 和完整 CLI 配置不会由管理 API 或 Web 明文回显；已保存密钥仅显示占位状态。
- 当前 real runtime 仅完整驱动 Claude Code。Codex、OpenCode 及后续更多 CLI 的通用执行适配跟踪见 [Issue #100](https://github.com/SummerSec/DeepSonar/issues/100)。

## 一键部署（推荐：拉取已发布镜像）

要求：Docker 24+、Docker Compose v2。

**默认从阿里云 ACR 拉取平台镜像并启动**（real 模式），无需本地 `docker build` 源码。

### Linux / macOS

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh up              # 等价：up real pull
# 仅状态机：
./deploy/deploy.sh up fake pull
# 必须本地构建时：
./deploy/deploy.sh up real build
```

### Windows

```powershell
Set-ExecutionPolicy -Scope Process Bypass
# 拉取镜像后启动（不要默认 --build）：
.\deploy\deploy.ps1 -Action up -Mode real -NoBuild
# 仅状态机：
.\deploy\deploy.ps1 -Action up -Mode fake -NoBuild
```

脚本会：

1. 从 `deploy/.env.example` 生成 `deploy/.env`（随机库密码、引导 Token、Silo S3 凭据）；
2. 生成 `deploy/master.key`（凭据加密主密钥，勿提交 Git）；
3. 使用当前 Release 的无 `v` 版本号拉取 `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission`；
4. 启动 PostgreSQL、PGSTY Silo、Scheduler、Image Admission、Web Gateway；
5. 健康检查通过后输出访问地址。

启动后访问：**http://127.0.0.1:8080**（不是开发态的 5173）。

### 登录（鉴权开启时）

新库首次启动会创建默认人类管理员：

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `Deep@Sonar66` |

该口令仅用于本地/演示开箱，**不会在重启时重置**；生产或公网部署后请立即改密（并建议改登录名）。人类会话与 API Token 服务账号相互独立。

### 镜像标签注意

- 平台镜像使用 **Release 版本号**，阿里云 ACR 标签不带 Git tag 的 `v` 前缀，也不发布 `latest`。
- Release workflow 会把发布版本自动同步到 `deploy/.env.example`；部署脚本也会把旧的 `latest` 配置改为当前清单版本。需要固定旧版本时再在 `deploy/.env` 显式设置：

```dotenv
DEEPSONAR_IMAGE_REGISTRY=crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec
DEEPSONAR_IMAGE_TAG=<release-version-without-v>
```

- 版本值与 [GitHub Release](https://github.com/SummerSec/DeepSonar/releases) 的 `vX.Y.Z` 对应，但 ACR 拉取使用 `X.Y.Z`。

手工拉取示例：

```bash
REG=crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec
VER=<release-version-without-v>

for img in deepsonar-scheduler deepsonar-web deepsonar-image-admission; do
  docker pull "$REG/$img:$VER"
done
```

### 对象存储

生产 Compose 默认启动固定版本的 [PGSTY Silo](https://github.com/pgsty/silo)，共享资产 CAS 通过内部 `http://silo:9000` 使用 S3 API。API 与 Console 默认只绑定宿主机 `127.0.0.1:9000/9001`，数据保存在独立 `silo_data` volume；报告与运行证据仍写入本地 `blob_data`。切换既有对象存储时必须先迁移并校验对象，部署脚本不会删除旧卷。

### 常用运维命令

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh down          # 保留 postgres / blob / silo volume
./deploy/deploy.sh pull          # 仅拉取应用镜像
```

```powershell
.\deploy\deploy.ps1 status
.\deploy\deploy.ps1 logs
.\deploy\deploy.ps1 down
```

部署行为以 `deploy/deploy.sh`、`deploy/deploy.ps1` 与 `deploy/docker-compose.prod.yml` 为准。

## 本地开发

要求：Node.js 20+、pnpm、Docker（Postgres）。

```bash
corepack enable
pnpm install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
pnpm db:up
# Windows 若 predev 报找不到 tsc，先把 node_modules/.bin 加入 PATH
pnpm dev                        # Scheduler: http://127.0.0.1:3100
pnpm dev:web                    # Web: http://127.0.0.1:5173 ，/api 代理到 3100
```

默认 `.env` 中 `AGENT_MODE=fake` 即可联调状态机。Web 的 `/images` 为镜像市场；schema v23 新库默认选择阿里云 ACR 通道，管理员仍可在市场切换 GHCR / Docker Hub / ACR。项目内 `/projects/:projectId/images` 用于启用第三方已准入镜像。

### 官方运行时镜像与语言能力

官方运行时按职责拆包，**镜像选择以 RoleConfig 为准**（Job 创建时冻结 digest），不要用全局 env 指定 CLI 或在沙箱内临时 `apt` 装工具链：

| 镜像 | 默认角色 | 主要能力 | 刻意不含 |
|------|----------|----------|----------|
| `deepsonar-base` | explore / analyze / review / code / hub / **verify** | Node 22 slim、git、系统 python3、curl、rg、jq | 多版本语言、JDK、Go、Rust、Maven |
| `deepsonar-audit` | **audit** | base + Semgrep、Gitleaks、ShellCheck、binutils | 完整应用构建链（如 Maven 起 Spring） |
| `deepsonar-kali-minimal`（Kali Test） | **test** | 多版本 Python + `uv`、Temurin JDK、Maven、Go、Rust 等 | Kali metapackage/GUI、DinD |

#### 镜像仓库（中国区 ACR）

`v*` Release 会同步推送到阿里云个人版 ACR（与 GHCR 同一批 digest）：

```text
crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/<image>:<version>
```

| 镜像 | 用途 |
|------|------|
| `deepsonar-base` / `deepsonar-audit` / `deepsonar-kali-minimal` | 官方运行时 |
| `deepsonar-openharmony-test` / `-audit` / `-fuzz` | OpenHarmony 专项（项目 opt-in） |
| `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission` | 平台服务 |

```bash
REG=crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec
VER=<release-version-without-v>   # 与 GitHub Release 的 vX.Y.Z 对齐

for img in \
  deepsonar-base deepsonar-audit deepsonar-kali-minimal \
  deepsonar-openharmony-test deepsonar-openharmony-audit deepsonar-openharmony-fuzz \
  deepsonar-scheduler deepsonar-web deepsonar-image-admission
do
  docker pull "$REG/$img:$VER"
done
```

也可用发布附件清单：`deploy/pull-runtime-images.sh --file deploy/runtime-image-registry.json`（优先 `name@sha256:…`）。real 模式请把不可变 digest 写入 `DEEPSONAR_OFFICIAL_*_IMAGE`。白名单需包含 ACR host：

```dotenv
DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=ghcr.io,docker.io,registry-1.docker.io,crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com
```

**静态审计 vs 动态验证**

- **只读代码出 Finding**（audit）：多数语言可用 `deepsonar-audit`。
- **runtime_test / 编译 / PoC**（test）：使用 **Kali Test** 或项目专项镜像，不要绑 base。
- 不要在沙箱内冷装 JDK/Maven；以 `agent-harness/*runtime.json` 的版本、能力和体积契约为准。

基本验证：

```bash
pnpm typecheck
pnpm build
pnpm ci:images
```

## 数据库

- 完整建库入口：[database/schema.sql](database/schema.sql)
- 说明：[database/README.md](database/README.md)
- Scheduler 启动时对空库套基线；已有库只校验版本与结构，不符则 fail closed（无增量 migration，需重建）
- 升级前请 `pg_dump -Fc` 并在隔离实例演练恢复

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

## 外部事件触发

事件与人工任务共用 Hub 入口；`project + source + event_id` 幂等，重复投递不重复执行。

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

Token 至少需要 `tasks:write`，并建议绑定到目标项目。

## 项目结构

```text
apps/
  scheduler/        Fastify 调度器、Hub、验证、报告、API
  image-admission/  第三方 OCI 镜像准入 Worker
  web/              React 控制台与任务画布
packages/
  shared-types/     前后端共享 Zod schema
  plane-client/     Plane 可选集成
  runtime-sandbox/  Noop / Agentbox 沙箱
database/           schema 基线（无 migration）
deploy/             Compose、一键脚本、发布镜像清单
agent-harness/      冒烟与镜像校验
DESIGN.md           当前 as-built 设计摘要（Agent / 贡献者先读）
```

## 设计约束

- 本地库 = 唯一业务真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者；
- Agent 只提案；图引用 id 必须是画布 UUID，禁止字段名泄漏（如字面量 `root_id`）；
- 被审计代码与外部事件均为不可信输入；
- API Token 与模型凭据分离；Job 使用创建时冻结的 snapshot / 镜像 digest；
- real 模式挂载 Docker Socket，仅限受控主机。

## 当前事实入口

- [DESIGN.md](DESIGN.md) — as-built 设计摘要与开放 Issue 索引
- [database/schema.sql](database/schema.sql) — 数据结构唯一基线
- [database/README.md](database/README.md) — schema 启动与重建规则
- `/api/openapi.json` — 当前 HTTP API 契约
- [GitHub Issues](https://github.com/SummerSec/DeepSonar/issues) — 未完成能力与演进方案

## License

DeepSonar 当前版本为 **专有源码**。使用、复制、修改、分发、再许可或销售前，须取得 SummerSec 事先书面授权；可通过 [GitHub Issues](https://github.com/SummerSec/DeepSonar/issues) 申请。

本声明适用于包含当前 `LICENSE` 的仓库版本，**不追溯**改变此前已按 MIT 发布的历史版本。第三方组件适用各自许可证。详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
