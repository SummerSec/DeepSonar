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
```

相关文件：

| 文件 | 用途 |
|------|------|
| `deploy/docker-compose.prod.yml` | PostgreSQL、Scheduler、Web 基础服务 |
| `deploy/docker-compose.real.yml` | real 模式覆盖：挂载 Docker Socket |
| `deploy/Dockerfile.scheduler` | Scheduler 运行镜像 |
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

1. 构建 Agent 镜像：

```bash
npx agentbox image build --provider local-docker --file agent-harness/image.mjs
```

2. 确认镜像名，并写入 `deploy/.env`：

```dotenv
DOCKER_IMAGE_AUDIT=deepsonar-agent:latest
AGENT_PROVIDER=claude-code
ANTHROPIC_API_KEY=your-key
```

也可以使用 Codex/OpenAI 兼容端点：

```dotenv
AGENT_PROVIDER=codex
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=
```

3. 启动 real 模式：

```powershell
.\deploy\deploy.ps1 up -Mode real
```

```bash
./deploy/deploy.sh up real
```

4. 在控制台建立 Agent Profile，并为 `hub_reason`、`audit_module`、`verify_finding` 和需要的角色绑定 Profile。

## 6. 数据库 schema 与迁移

正常 Compose 部署无需手工导入数据库：Scheduler 启动时会运行 `apps/scheduler/migrations`，并通过 PostgreSQL advisory lock 防止多实例并发迁移。

仓库同时提供统一 schema 入口：

```text
database/schema.sql
```

它是压平后的最终态 PostgreSQL DDL，不依赖 `psql \ir`，可用于全新外部
PostgreSQL、托管 PostgreSQL SQL 控制台、审阅和 CI。手工初始化：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

不要对已经运行过 migration 的数据库再次执行完整 `schema.sql`。已有数据库升级只启动新版本 Scheduler，让它自动执行缺失 migration。

校验 schema 的基线登记是否包含全部 migration：

```powershell
$migrations = Get-ChildItem apps/scheduler/migrations/*.sql | ForEach-Object Name
$schema = Get-Content database/schema.sql -Raw
$migrations | Where-Object { $schema -notmatch [regex]::Escape($_) }
```

命令无输出表示基线登记覆盖全部 migration。DDL 的语义一致性还应通过两个空库
分别执行 `database/schema.sql` 和完整 migration 链后比较结构；不能用文件名检查
替代实际建库测试。

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

脚本会重新构建镜像。Scheduler 新版本启动后自动执行新增 migration。

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

三个服务都应为 running/healthy。

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

### 10.4 real 模式找不到 Agent 镜像

`DOCKER_IMAGE_AUDIT` 必须与宿主 Docker 中的镜像名称完全一致：

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
- [ ] PostgreSQL、Scheduler、Web 都 healthy；
- [ ] `pnpm typecheck` 和 `pnpm build` 通过；
- [ ] fake 模式 API 冒烟通过；
- [ ] 已完成数据库备份和恢复演练。
