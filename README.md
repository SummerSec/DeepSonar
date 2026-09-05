# DeepSonar

> 深流循迹 · 让复杂执行持续收敛
>
> Every loop converges.

DeepSonar 是一套 Loop Graph 工程平台：人提供任务标题与自然语言目标，`hub_reason` 读画布后派发 Audit / Explore / Analyze / Review / Test / Code 等角色；调度器负责状态机、幂等、沙箱、验证与过程记账，让多项目 Agent 编排可收敛、可审计。

当前设计摘要见根目录 [DESIGN.md](DESIGN.md)；行为以代码、`database/schema.sql`、OpenAPI 与测试为准。

## 发布记录与版本规则

完整的生产变更记录见 [CHANGELOG.md](CHANGELOG.md)。产品版本以不可变的 `vX.Y.Z` Git tag 为准；根目录和第一方 workspace 的私有 package 版本（当前为 `0.1.11`）只是内部包元数据，不代表产品 Release 版本。运行时镜像标签对应同一版本但省略 `v` 前缀。

## 核心流程

```text
人工任务 / 外部事件
                ↓
          Hub 决策中枢
                ↓
       Audit / Explore / Test ...
                ↓
        Finding → Verify
                ↓ confirmed
          Hub 继续 / 收敛
                ↓
          Report（调度器派生）
```

主要能力：

- **一任务一画布**（`canvases`，无独立 tasks 表），完整展示决策与执行过程；
- 新建任务只填标题和内容；Hub / 事件 / 人工评论统一进入调度闭环；
- Finding 按任务 `minVerifySeverity` 进入自动验证（低于阈值的保留但不占 Verify）；`confirmed` 后生成 Finding 报告，画布收敛后生成任务级报告；
- **Agent 只提案**：真实 Job 经短期 capability token 调用 Job 级控制 API（`emit_*` / `submit_hub_decision` / `mark_job_done` / `request_human` 等）；不注入控制 MCP、失败不回退 MCP；调度器是唯一副作用执行者；
- 任务详情含画布 / **事实** / Finding / Job / 报告；Finding 与 Fact 均可人工裁决；Session 查看器按当前三类治理 Agent CLI 的归档格式归一化消息、reasoning、tool call/result、usage，leftover Codex/OpenCode 归档仍只读可看；归档中存在的画布广播以独立条目展示，并保留原始归档下载；
- RoleConfig、Skill 源、Provider 凭据、API Token、镜像市场与项目镜像策略可在控制台管理；
- PostgreSQL 为业务真相；Scheduler 启动时对空库套 schema 基线，已有库只校验版本；
- **fake** 模式无模型凭据即可跑通状态机；**real** 模式经 OpenSandbox 起真实沙箱。

## Provider 与 Agent CLI

- `provider` 表示上游协议，仅支持 **Anthropic Messages** 与 **OpenAI-compatible**；不内置 Anthropic、Kimi 等厂商预设。
- `agent_cli` 表示运行时方言，新配置只支持 **Claude Code（默认）、Pi、DSH**（能力与兼容镜像在创建 Job 时校验并冻结到 `agent_snapshot_json`）。leftover Codex/OpenCode 历史快照与 Session 归档只读可看，下次保存拒绝并提示迁移。Credential 保存完整 `settings_config_json`；Job 只冻结无密钥结构，运行时经 Model Gateway 注入短期 Job token。
- 当前三类 CLI 均走 **Job 级 HTTP 控制 API**（`platformControlApi`）；平台注入静态 `deepsonar-control` Skill，说明能力发现与鉴权，不授予额外权限。
- 设置页可在保存前一键读取模型列表；模型可用性只认 Credential `settings_config` 声明的清单，不再使用 `allowed_model_ids` 白名单。
- 用户密码、Provider API Key 和完整 CLI 配置不会由管理 API 或 Web 明文回显；已保存密钥仅显示占位状态。
- 适配器契约与 Session 归档清单见 [`docs/AGENT_CLI_RUNTIME_ADAPTERS.md`](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)。
- Session 归档按 CLI 方言独立处理：当前 Claude Code、Pi、DSH 使用本次沙箱的受治理本地 session artifact；leftover Codex/OpenCode 历史归档仍由查看器只读解析。malformed 的 session identity/path、导出/读取错误或超限会显式报告，不把各类归档当作同一 schema。

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
# 推荐 pwsh。脚本为 UTF-8 with BOM + ASCII，Windows PowerShell 5.1 也可解析。
# 默认与 Linux 相同：up real pull（拉取 ACR 应用镜像，不本地 --build）
pwsh -NoProfile -File .\deploy\deploy.ps1
.\deploy\deploy.ps1 -Action up -Mode real -Source pull
# 仅状态机：
.\deploy\deploy.ps1 -Action up -Mode fake -Source pull
```

脚本会：

1. 从 `deploy/.env.example` 生成 `deploy/.env`（随机库密码、引导 Token、Silo S3 凭据）；
2. 生成 `deploy/master.key`（凭据加密主密钥，勿提交 Git）；
3. 使用当前 Release 的无 `v` 版本号拉取 `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission`；再优先解析同 tag 的 `deepsonar-silo`（缺失则回退 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`）。real 模式另优先解析 `deepsonar-assets-helper`（缺失则回退 busybox pin）；
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

for img in deepsonar-scheduler deepsonar-web deepsonar-image-admission deepsonar-assets-helper deepsonar-silo; do
  docker pull "$REG/$img:$VER"
done
```

### 对象存储

生产 Compose 默认使用 [PGSTY Silo](https://github.com/pgsty/silo) `RELEASE.2026-08-06T00-00-00Z` 不可变 pin；`SILO_IMAGE` 可覆盖为其它 S3 兼容镜像。共享资产 CAS 走内部 `http://silo:9000`。API 与 Console 默认只绑定宿主机 `127.0.0.1:9000/9001`，数据保存在独立 `silo_data` volume；报告与运行证据仍写入本地 `blob_data`。切换既有对象存储时必须先迁移并校验对象，部署脚本不会删除旧卷。

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
.\deploy\deploy.ps1 pull
.\deploy\deploy.ps1 down
```

部署行为以 `deploy/deploy.sh`、`deploy/deploy.ps1` 与 `deploy/docker-compose.prod.yml` 为准。  
更完整的部署说明见 [`docs/ONE_CLICK_DEPLOYMENT.md`](docs/ONE_CLICK_DEPLOYMENT.md) 与 [`deploy/README.md`](deploy/README.md)。

## 本地开发

要求：Node.js 20+、pnpm、Docker（Postgres）。

```bash
corepack enable
pnpm install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
pnpm db:up                      # 独立开发库：deepsonar/deepsonar@localhost:5432
# 若要改连一键部署那份库（与 db:up 互斥）：pnpm db:up:deploy
# Windows 若 predev 报找不到 tsc，先把 node_modules/.bin 加入 PATH
pnpm dev                        # Scheduler: http://127.0.0.1:3100
pnpm dev:web                    # Web: http://127.0.0.1:5173 ，/api 代理到 3100
```

默认 `.env` 中 `AGENT_MODE=fake` 即可联调状态机。Web 的 `/images` 为镜像市场；schema 新库默认选择阿里云 ACR 通道（历史自 v23 起），管理员仍可在市场切换 GHCR / Docker Hub / ACR。当前基线版本以 `apps/scheduler/src/schema-version.ts` 为准（现为 **v43**）。项目内 `/projects/:projectId/images` 用于启用第三方已准入镜像。

项目镜像策略：`inherit_global`（默认，只认全局 RoleConfig 镜像与 model / 默认 CLI）或 `project_managed`（项目 `role_runtime_images` 集中绑定；项目 RoleConfig **不接受**独立 `runtime_image_key`，但可托管自己的 model）。

基本验证：

```bash
pnpm typecheck
pnpm build
pnpm ci:images
```

## 数据库

- 完整建库入口：[database/schema.sql](database/schema.sql)
- 说明：[database/README.md](database/README.md)
- Scheduler 启动时对空库套基线；已有库只校验版本与结构，不符则 fail closed（无增量 ALTER 链）
- 已有数据升级：`pnpm db:rebuild -- --plan` 后 `pnpm db:rebuild -- --apply`（备份 + 套最新 `schema.sql` + 列交集回填）
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
  runtime-sandbox/  Noop / OpenSandbox 沙箱
database/           schema 基线（无 migration）
deploy/             Compose、一键脚本、发布镜像清单
agent-harness/      冒烟与镜像校验
DESIGN.md           当前 as-built 设计摘要（Agent / 贡献者先读）
```

## 设计约束

- 本地库 = 唯一业务真相；画布 = 过程真相；沙箱 = 执行真相；调度器 = 唯一有副作用的执行者；
- Agent 只提案；控制面默认拒绝（严格 Zod 契约 + Job 状态/角色授权）；图引用 id 必须是画布 UUID，禁止字段名泄漏（如字面量 `root_id`）；
- 被审计代码与外部事件均为不可信输入；
- API Token、Job capability token 与模型凭据分离；Job 使用创建时冻结的 snapshot / 镜像 digest；
- 共享资产经 CAS + 只读 named volume 注入；helper 使用不可变 digest（官方 `deepsonar-assets-helper`，未发布前回退 busybox pin），不把业务运行时镜像当拷贝工具；
- real 模式挂载 Docker Socket，仅限受控主机。

## 当前事实入口

- [DESIGN.md](DESIGN.md) — as-built 设计摘要与演进索引（§11 含已完成能力表）
- [docs/README.md](docs/README.md) — 专题文档索引（哪些已 as-built、哪些是历史方案）
- [CHANGELOG.md](CHANGELOG.md) — 生产变更记录
- [database/schema.sql](database/schema.sql) — 数据结构唯一基线（与 `SCHEMA_VERSION` 同步 bump）
- [database/README.md](database/README.md) — schema 启动与重建规则
- `/api/openapi.json` — 当前 HTTP API 契约
- [GitHub Issues](https://github.com/SummerSec/DeepSonar/issues) — 开放项可能很少；未完成能力以 DESIGN §11 + 代码为准

## License

DeepSonar 当前版本为 **专有源码**。使用、复制、修改、分发、再许可或销售前，须取得 SummerSec 事先书面授权；可通过 [GitHub Issues](https://github.com/SummerSec/DeepSonar/issues) 申请。

本声明适用于包含当前 `LICENSE` 的仓库版本，**不追溯**改变此前已按 MIT 发布的历史版本。第三方组件适用各自许可证。详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
