# DeepSonar 一键部署教程

本文说明如何使用仓库内脚本一次启动 PostgreSQL、Scheduler 和 Web 控制台。部署采用 Docker Compose，数据库数据和 Blob 数据写入具名 volume，普通停止或升级不会删除。

## 1. 部署组成

```text
浏览器 :8080
    ↓
Web Gateway
    ├─ /       React 静态文件
    └─ /api/*  Scheduler :3100（含 WebSocket）
                    ↓
              PostgreSQL 16

独立 Image Admission Worker 通过 Docker Socket 对隔离镜像执行准入/周期复扫；它不在 Scheduler 进程内执行第三方层内容。
```

相关文件：

| 文件 | 用途 |
|------|------|
| `deploy/docker-compose.prod.yml` | PostgreSQL、Scheduler、Image Admission、Web 基础服务 |
| `deploy/docker-compose.real.yml` | real 模式覆盖：挂载 Docker Socket |
| `deploy/Dockerfile.scheduler` | Scheduler 运行镜像 |
| `deploy/Dockerfile.image-admission` | 第三方 OCI 镜像独立准入 Worker |
| `deploy/Dockerfile.web` | Web 构建和最小 Node Gateway 运行镜像 |
| `deploy/web-server.mjs` | SPA、API 和 WebSocket 反向代理 |
| `deploy/.env.example` | 部署环境变量模板 |
| `deploy/deploy.ps1` | Windows 一键脚本 |
| `deploy/deploy.sh` | Linux/macOS 一键脚本 |

## 2. 前置要求

- Docker Engine/Desktop 24 或更新版本；
- Docker Compose v2，命令为 `docker compose`；
- 至少 4 CPU、8 GB 内存、10 GB 可用磁盘；
- real 模式额外要求 Docker 主机能够运行 Agentbox 镜像；
- Linux/macOS 健康检查需要 `curl`。

验证环境：

```bash
docker version
docker compose version
```

## 3. 首次部署

### 3.1 Windows

在仓库根目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\deploy.ps1 up
```

### 3.2 Linux / macOS

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh up
```

首次执行会从 `deploy/.env.example` 生成 `deploy/.env`，并自动生成：

- `POSTGRES_PASSWORD`；
- `DEEPSONAR_ADMIN_TOKEN`；
- `deploy/master.key`：Provider Credential 的 AES-256-GCM 主密钥。

`deploy/.env` 和 `deploy/master.key` 已加入 `.gitignore`。不要把密码、模型密钥、管理员 Token 或主密钥提交到 Git；主密钥丢失后，数据库中的 Provider Credential 将无法解密。

启动成功后访问：

```text
http://127.0.0.1:8080
```

可修改 `deploy/.env` 中的 `DEEPSONAR_WEB_PORT` 改变端口，然后重新执行部署脚本。

## 4. 首次使用 API Token

容器部署强制设置 `DEEPSONAR_AUTH_REQUIRED=true`。首次打开控制台时：

1. 打开 `deploy/.env`；
2. 复制 `DEEPSONAR_ADMIN_TOKEN` 的值；
3. 在控制台全局设置的“API Token”页面，把它填入“本机调用令牌”；
4. 创建长期使用的数据库 Token；
5. 保存新 Token 明文；它只在创建时显示一次；
6. 使用新 Token 后，可以轮换部署环境中的引导 Token。

建议 scope：

| 用途 | Scope |
|------|-------|
| 浏览控制台 | `projects:read,tasks:read,findings:read,agents:read,skills:read,integrations:read` |
| 创建任务或事件 | `tasks:write` |
| 控制 Job | `jobs:control` |
| 管理 Agent/Skill | `agents:write,skills:write` |
| 查看/导入镜像 | `images:read,images:manage` |
| 批准/拒绝/撤销镜像 | `images:approve` |
| 管理 Token | `tokens:manage` |

外部事件 Token 应绑定到单一项目，并只授予 `tasks:write`。

## 5. fake 与 real 模式

### 5.1 fake 模式

一键部署默认使用 fake 模式：

```powershell
.\deploy\deploy.ps1 up -Mode fake
```

```bash
./deploy/deploy.sh up fake
```

fake 不调用模型、不启动审计沙箱，但会真实运行数据库状态机、Hub、Finding、Verify、画布和事件幂等，适合安装验收。

### 5.2 real 模式

real 模式会把 `/var/run/docker.sock` 挂载给 Scheduler。Docker Socket 基本等价于宿主机 Docker 管理权限，因此只能在受控主机运行。

1. 构建官方 base/audit 镜像，并运行一致性检查。镜像体积是 CI 硬门槛；默认 base 使用 Node 22 Debian slim（满足 Claude Code 运行要求），审计工具只进入 audit：

```bash
DEEPSONAR_IMAGE_TOOLSET=base npx agentbox image build --provider local-docker --file agent-harness/image.mjs
DEEPSONAR_IMAGE_TOOLSET=audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs
pnpm ci:images
docker build -f deploy/Dockerfile.agent-kali-minimal -t deepsonar-kali-minimal:local .
node agent-harness/test-runtime-image.mjs deepsonar-kali-minimal:local kali-minimal agent-harness/kali-minimal-runtime.json
```

2. 推送或转换为 registry digest 引用，写入 `deploy/.env`。`DOCKER_IMAGE_AUDIT` 只是升级期兼容值，新 Job 只使用目录内的 digest：

```dotenv
DEEPSONAR_OFFICIAL_BASE_IMAGE=ghcr.io/<owner>/deepsonar-base@sha256:<digest>
DEEPSONAR_OFFICIAL_AUDIT_IMAGE=ghcr.io/<owner>/deepsonar-audit@sha256:<digest>
DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE=ghcr.io/<owner>/deepsonar-kali-minimal@sha256:<digest>
DOCKER_IMAGE_AUDIT=deepsonar-agent:latest
AGENT_PROVIDER=claude-code
ANTHROPIC_API_KEY=your-key
```

3. 若要从独立的“镜像市场”页导入第三方镜像，还要将 Cosign、Syft、Trivy、ClamAV 扫描器引用配成 `name@sha256:digest`，并校对 `DEEPSONAR_ALLOWED_IMAGE_REGISTRIES`。扫描器未固定时 Worker 会拒绝准入，不会退回 tag。

也可以使用 Codex/OpenAI 兼容端点：

```dotenv
AGENT_PROVIDER=codex
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=
```

4. 启动 real 模式：

```powershell
.\deploy\deploy.ps1 up -Mode real
```

```bash
./deploy/deploy.sh up real
```

5. 在独立“镜像市场”页检查官方版本；项目内的“镜像市场”用于启用第三方可信版本和 opt-in 的 `deepsonar-kali-minimal`，“角色配置”再从已启用目录选择镜像 key。Kali 镜像不安装任何 `kali-linux-*` / `kali-tools-*` metapackage，也不会成为项目默认镜像。

## 6. 数据库 schema 基线

正常 Compose 部署无需手工导入数据库：Scheduler 启动时持有 PostgreSQL advisory lock。空库会一次性套用 `database/schema.sql`；非空库只有 `schema_meta.version` 与程序完全一致才启动。

仓库同时提供统一 schema 入口：

```text
database/schema.sql
```

它是压平后的最终态 PostgreSQL DDL，不依赖 `psql \ir`，可用于全新外部
PostgreSQL、托管 PostgreSQL SQL 控制台、审阅和 CI。手工初始化：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

本项目不维护历史 migration 链。表结构变更必须同时更新 `schema.sql` 与 `apps/scheduler/src/db.ts` 中的 `SCHEMA_VERSION`，并在空 PostgreSQL 上实际建库。已有库升级前先备份，然后按项目的基线重建策略执行；不要期待 Scheduler 自动增量升级。

## 7. 日常操作

### Windows

```powershell
.\deploy\deploy.ps1 status
.\deploy\deploy.ps1 logs
.\deploy\deploy.ps1 check
.\deploy\deploy.ps1 down
```

### Linux / macOS

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh check
./deploy/deploy.sh down
```

`down` 只停止并删除容器和网络，不删除 `postgres_data`、`blob_data` volume。

## 8. 升级

```bash
git pull
./deploy/deploy.sh up
```

或 Windows：

```powershell
git pull
.\deploy\deploy.ps1 up
```

脚本会重新构建镜像。如果 Schema 版本已变更，新 Scheduler 会拒绝旧库；升级前必须完成备份和基线重建。

升级前建议备份：

```bash
docker compose -p deepsonar --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_dump -U deepsonar -d deepsonar -Fc > deepsonar.dump
```

## 9. 健康检查

```bash
curl http://127.0.0.1:8080/api/health
```

期望：

```json
{"ok":true,"ts":1785580000000}
```

查看服务状态：

```bash
docker compose -p deepsonar --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml ps
```

PostgreSQL、Scheduler、Image Admission 和 Web 都应为 running（带 healthcheck 的服务应为 healthy）。

## 10. 常见问题

### 10.1 Web 可以打开，但 API 返回 401

这是容器部署的预期行为。把 `deploy/.env` 中的 `DEEPSONAR_ADMIN_TOKEN` 填入控制台“本机调用令牌”。

### 10.2 Scheduler 一直不健康

```bash
./deploy/deploy.sh logs
```

重点检查：

- PostgreSQL 密码或 DATABASE_URL；
- migration SQL 错误；
- `deploy/.env` 是否仍有 `change-me-`；
- 端口和 Docker 资源是否充足。

### 10.3 real 模式找不到 Docker

确认使用了 real 覆盖文件，并检查：

```bash
docker compose -p deepsonar --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml -f deploy/docker-compose.real.yml \
  exec scheduler docker version
```

### 10.4 real 模式无可信 Agent 镜像

`DEEPSONAR_OFFICIAL_BASE_IMAGE` / `DEEPSONAR_OFFICIAL_AUDIT_IMAGE`（以及启用时的 `DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE`）必须是可拉取的 `name@sha256:digest`。`DOCKER_IMAGE_AUDIT` 只保留为旧配置兼容，不会让可移动 tag 越过市场信任边界：

```bash
docker images
```

### 10.5 如何彻底删除数据

部署脚本故意不提供自动清库参数。确认备份且明确不再需要数据后，才手工执行 Compose `down --volumes`。该操作不可恢复，会删除 PostgreSQL 和 Blob volume。

## 11. 上线检查表

- [ ] `deploy/.env` 不含占位符且未提交 Git；
- [ ] `DEEPSONAR_AUTH_REQUIRED=true`；
- [ ] 已创建长期数据库 API Token；
- [ ] 外部事件 Token 绑定单项目且只有 `tasks:write`；
- [ ] real 模式模型凭据可用；
- [ ] Agent 镜像存在；
- [ ] 官方 base/audit（以及需要时的 kali-minimal）引用均为 digest，并通过断网硬化冒烟与大小预算；
- [ ] 第三方准入需要的四个扫描器均以 digest 固定；
- [ ] PostgreSQL、Scheduler、Image Admission、Web 状态正常；
- [ ] `pnpm typecheck` 和 `pnpm build` 通过；
- [ ] fake 模式 API 冒烟通过；
- [ ] 已完成数据库备份和恢复演练。
