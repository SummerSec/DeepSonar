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

容器首次启动会在空数据库中自动创建人类管理员 `admin` / `Deep@Sonar66`。默认口令是公开的本地/演示引导值，不会在重启时覆盖已修改的密码；生产或公网部署必须在首次登录后立即修改密码，并建议修改登录名。修改会话账号不会影响 API Token 服务账号。

可修改 `deploy/.env` 中的 `DEEPSONAR_WEB_PORT` 改变端口，然后重新执行部署脚本。

## 4. 首次使用人类账号与 API Token

容器部署强制设置 `DEEPSONAR_AUTH_REQUIRED=true`。首次打开控制台时可以先用默认人类账号登录：

1. 用户名填 `admin`，密码填 `Deep@Sonar66`；
2. 立即在「Agent 管理 → 我的账号」修改密码，并建议修改登录名；修改后旧会话会失效，页面会自动换发新会话。

随后再配置 API Token 服务账号：

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

1. 构建官方 base/audit 镜像，并运行一致性检查。gzip 压缩后的可分发镜像包体积是 CI 硬门槛，并同时输出解压层大小；默认 base 使用 Node 22 Debian slim（满足 Claude Code 运行要求），审计工具只进入 audit：

```bash
DEEPSONAR_IMAGE_TOOLSET=base npx agentbox image build --provider local-docker --file agent-harness/image.mjs
DEEPSONAR_IMAGE_TOOLSET=audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs
pnpm ci:images
docker build -f deploy/Dockerfile.agent-kali-minimal -t deepsonar-kali-minimal:local .
node agent-harness/test-runtime-image.mjs deepsonar-kali-minimal:local kali-minimal agent-harness/kali-minimal-runtime.json
node agent-harness/test-maven-package.mjs deepsonar-kali-minimal:local
```

2. 推送或转换为 registry digest 引用，写入 `deploy/.env`。`DOCKER_IMAGE_AUDIT` 只是升级期兼容值，新 Job 只使用目录内的 digest：

```dotenv
DEEPSONAR_OFFICIAL_BASE_IMAGE=ghcr.io/<owner>/deepsonar-base@sha256:<digest>
DEEPSONAR_OFFICIAL_AUDIT_IMAGE=ghcr.io/<owner>/deepsonar-audit@sha256:<digest>
DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE=ghcr.io/<owner>/deepsonar-kali-minimal@sha256:<digest>
DOCKER_IMAGE_AUDIT=deepsonar-agent:latest
```

角色使用的 `agent_cli`、`model` 和 `env_vars` 不在部署环境变量中选择；请在 Agents / RoleConfig UI 或 API 中配置，创建 Job 时由 Scheduler 冻结快照。`AGENT_MODE` 仍只表示 fake/real 基础设施运行模式。Provider 凭据必须存入 Settings / Credentials，再绑定到 RoleConfig；长期密钥不会下发给沙箱。

正式 `v*` Release 还会把三类运行时发布到同一个 Docker Hub 仓库 `docker.io/sumsec/deepsonar`：

```text
sumsec/deepsonar:base-<version>
sumsec/deepsonar:audit-<version>
sumsec/deepsonar:kali-minimal-<version>
```

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 中配置 `DOCKERHUB_USERNAME=sumsec` 与具有 Read & Write 权限的 `DOCKERHUB_TOKEN`。未配置时 Release 仍发布 GHCR，但会跳过 Docker Hub。部署配置最终仍应使用发布后解析出的 `docker.io/sumsec/deepsonar@sha256:<digest>`，不能把可变 tag 冻结进 Job。

3. 若要从独立的“镜像市场”页导入第三方镜像，还要将 Cosign、Syft、Trivy、ClamAV 扫描器引用配成 `name@sha256:digest`，并校对 `DEEPSONAR_ALLOWED_IMAGE_REGISTRIES`。扫描器未固定时 Worker 会拒绝准入，不会退回 tag。

使用 Codex/OpenAI 兼容端点时，在 Settings / Credentials 中创建 OpenAI Credential（包括密钥与可选 Base URL），再在 RoleConfig 中把目标角色的 `agent_cli` 设为 `codex`，选择该 Credential 和允许的 `model`；不要使用旧的 provider/model 环境变量作为生效配置。

4. 启动 real 模式：

```powershell
.\deploy\deploy.ps1 up -Mode real
```

```bash
./deploy/deploy.sh up real
```

5. 在独立“镜像市场”页检查官方版本；项目内的“镜像市场”用于启用第三方可信版本，“角色配置”可覆盖默认镜像。只有 `test` 默认使用 `deepsonar-kali-minimal`（Kali Test）；系统 `verify` 默认使用最小 Base。Kali Test 预装 Python 3.10–3.14、JDK 8/11/17（默认 17，不含 21）、Apache Maven 3.9.16、Go 与 Rust；Maven 位于 `/opt/deepsonar/maven`，不预置 `.m2` 缓存，但不安装任何 `kali-linux-*` / `kali-tools-*` metapackage。

需要 `runtime_test` 时不要把 Test 绑回 Base，也不要在沙箱内下载 JDK/Maven；Verify 只有在项目级 RoleConfig 中显式选择已准入的动态镜像时才使用该工具链。静态/动态矩阵与真实证据边界见 [`RUNTIME_TEST_TOOLCHAINS.md`](./RUNTIME_TEST_TOOLCHAINS.md)。

如需 OpenHarmony 源码专项工作，可在项目中显式启用下列官方镜像（均为 `project_opt_in`，不把全量源码烘焙进镜像，也不等于板级固件）：

| 镜像 key | 用途 | Dockerfile |
|----------|------|------------|
| `deepsonar-openharmony-test` | 源码同步与产品构建验证 | `deploy/Dockerfile.agent-openharmony` |
| `deepsonar-openharmony-audit` | 高危静态审计（Clang/clang-tidy/cppcheck/sparse + ASan/UBSan 工具链） | `deploy/Dockerfile.agent-openharmony-audit` |
| `deepsonar-openharmony-fuzz` | 动态验证与 Fuzz（libFuzzer / AFL++ + ASan/UBSan） | `deploy/Dockerfile.agent-openharmony-fuzz` |

默认全局 RoleConfig 仍是 `audit → deepsonar-audit`、`test → deepsonar-kali-minimal`。做 OpenHarmony 高危挖掘时，在项目镜像市场启用对应镜像后，把项目级 RoleConfig 覆盖为：`audit → deepsonar-openharmony-audit`，`test`/`verify` → `deepsonar-openharmony-fuzz`（按需）。

```bash
# 需先有 deepsonar-base:local
docker build -f deploy/Dockerfile.agent-openharmony \
  --build-arg BASE_IMAGE=deepsonar-base:local \
  -t deepsonar-openharmony-test:local .
docker build -f deploy/Dockerfile.agent-openharmony-audit \
  --build-arg BASE_IMAGE=deepsonar-base:local \
  -t deepsonar-openharmony-audit:local .
docker build -f deploy/Dockerfile.agent-openharmony-fuzz \
  --build-arg BASE_IMAGE=deepsonar-base:local \
  -t deepsonar-openharmony-fuzz:local .

docker run --rm -it -w /workspace deepsonar-openharmony-test:local \
  openharmony-init.sh --branch master --jobs "$(nproc)"
docker run --rm -it -w /workspace deepsonar-openharmony-audit:local \
  openharmony-audit-env.sh --check
docker run --rm -it -w /workspace deepsonar-openharmony-fuzz:local \
  openharmony-fuzz-env.sh --check
```

同步和完整编译需要任务允许出网，并准备足够的磁盘和内存；构建时必须指定实际的 `product_name`。`openharmony-init.sh` 默认使用 `https://gitcode.com/openharmony/manifest.git` 与 `master`，可用 `--group`、`--manifest-file`、`--jobs` 和 `--source-dir` 做必要调整；`openharmony-build.sh` 会将其他参数原样传递给源码根目录的 `./build.sh`。Audit 镜像提供 `openharmony-audit-scan.sh`（clang-tidy/cppcheck/sparse）；Fuzz 镜像提供 `openharmony-fuzz-build.sh`（编译 libFuzzer/AFL harness）。

### 5.3 启动后的运行时镜像准备

`deploy/local-daemon.sh start` 与 `deploy/deploy.sh up` 会在服务健康后后台运行 `deploy/prepare-runtime-images.sh`，日志写入 `data/logs/runtime-images.log`，不会阻塞主服务启动。脚本优先读取 API/静态注册表并拉取不可变版本；无版本或拉取失败时，逐项构建 `deepsonar-base:local`、`deepsonar-audit:local` 与 `deepsonar-kali-minimal:local`，单项失败不会阻断其他项。

默认不执行 `git pull`。只有显式设置 `DEEPSONAR_RUNTIME_IMAGE_GIT_PULL=true` 且 worktree clean 时，脚本才执行 `git pull --ff-only`；dirty worktree 只记录跳过，绝不执行 stash、reset 或 merge。可用 `--dry-run` 或 `DEEPSONAR_RUNTIME_IMAGE_BUILD=false` 做无构建验证。

本地构建或已有本地 tag 先通过 Scheduler 的 `detect-local` 取得完整 image ID、RepoDigest、contract、架构和产品匹配证据；检测是 transport 与 trust 分离的只读候选检查，不会自动登记。只有管理员在 UI/CLI 中核对不可变 image ID 并二次确认 `adopt-local` 后，才会产生当前机器 `local-docker` 专用 trusted 版本。该版本不会进入导出 registry 清单；生产、多机部署仍应使用 registry manifest 的 `name@sha256:<digest>`。OpenHarmony 镜像在 base、audit、Kali 流程后准备，并依赖本地 `deepsonar-base:local`，整体准备仍由部署脚本后台异步执行。

Linux/macOS 的后台准备流程默认也只检测、不改变 trust；需要由运维显式授权本机候选时，直接运行 `deploy/prepare-runtime-images.sh --adopt`。后台守护进程和一键部署不会代替管理员自动授权。

Windows 用户可以在自行 `docker pull`、`docker build` 或 `docker load` 后运行检测脚本；脚本不会直改数据库，也不会因为 mutable tag 自动信任：

```powershell
# 使用现有本地 tag，只检测（默认不 pull/build/load）
.\deploy\prepare-runtime-images.ps1 -LocalImage deepsonar-base=deepsonar-base:local

# 可选：按受信目录拉取不可变 ref，再映射到本地 tag 后检测
.\deploy\prepare-runtime-images.ps1 -Pull -LocalImage deepsonar-base=deepsonar-base:local

# 可选：在当前工作树构建官方 base（audit/Kali/OpenHarmony 也可按 image-key 指定）
.\deploy\prepare-runtime-images.ps1 -Build -LocalImage deepsonar-base=deepsonar-base:local

# 可选：加载归档后指定其中的 tag；-Adopt 会对每个 adoptable 候选逐项要求输入 ADOPT
.\deploy\prepare-runtime-images.ps1 -LoadPath .\deepsonar-base.tar -LocalImage deepsonar-base=deepsonar-base:local -Adopt
```

`detect-local` 需要 `images:read`；`adopt-local` 需要管理员角色或 `images:approve`。`expected_image_id` 用于防止检测后本地 tag 被替换。脚本读取 `DEEPSONAR_TOKEN`，否则仅从本地 `.env`/`deploy/.env` 读取 `DEEPSONAR_ADMIN_TOKEN`，不会打印或写入 token。

Scheduler 若要访问私有 GitHub Release 目录，可配置 `DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN`；仅 Scheduler 读取 SummerSec/DeepSonar Release metadata/asset，权限应最小化为 `contents:read`，不下发沙箱。未配置时使用 bundled last-known-good fallback，目录来源、回退和错误会在镜像市场 UI 显示。

Scheduler 启动时及其后每隔 `DEEPSONAR_RUNTIME_REGISTRY_SYNC_SEC`（默认 3600 秒）从固定的官方 GitHub Release 地址获取最新 `runtime-image-registry.json`，失败时回退当前部署内置清单；全局页“同步市场”会立即执行同一条受信任同步路径，不接受任意 URL。正式发布版本优先，`DEEPSONAR_OFFICIAL_*_IMAGE` 只在官方清单尚无版本时作为启动兜底。历史版本继续保留用于项目显式固定与 Job 快照，但不会保持默认 promoted 状态。同步后可用“异步拉取”按顺序拉取清单内远程不可变版本；本地 raw image ID 不会被 pull。

## 6. 数据库 schema 基线

正常 Compose 部署无需手工导入数据库：Scheduler 启动时在 reserved session 上持有 PostgreSQL
session advisory lock。空库会一次性套用 `database/schema.sql` 得到最新 v13；已有 v12
数据库会按连续 migration 升级，其他实例等待后在 v13 no-op。

仓库同时提供统一 schema 入口：

```text
database/schema.sql
```

它是压平后的最终态 PostgreSQL DDL，不依赖 `psql \ir`，可用于全新外部
PostgreSQL、托管 PostgreSQL SQL 控制台、审阅和 CI。手工初始化：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

当前支持的增量链是 v12 → v13，迁移文件位于 `database/migrations/`，由
`schema_migrations` 账本记录原始 UTF-8 字节 SHA-256、执行结果和错误。成功的 migration
与 `schema_meta.version` 在同一事务提交；失败会回滚并追加失败审计行，重启可安全重试；
历史文件 checksum 漂移、编号不连续、v12 之前或未知结构都会 fail closed。每次结构变更
必须新增下一个连续编号的 SQL，同时更新 `schema.sql` 最新基线和 `SCHEMA_VERSION`，并在
全新库与 v12 fixture 上运行 CI 迁移测试。

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

脚本会重新构建镜像。Scheduler 会在启动时持锁执行 v12→v13 migration；迁移失败则回滚且
不会推进版本，修复发布包后重启即可重试。升级前必须完成备份和隔离恢复演练。

升级前必须备份：

```bash
docker compose -p deepsonar --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_dump -U deepsonar -d deepsonar -Fc > deepsonar.dump
```

建议把 dump 恢复到独立 PostgreSQL 实例并读取关键业务表及 `schema_migrations`，确认恢复
有效后再切换部署。不要删除 `postgres_data` volume 或手工重放 migration；若需要恢复，
停止 Scheduler，将备份恢复到新实例并切换 `DATABASE_URL`。项目不提供 down migration，
v13 应用回退仍需保留已新增结构。

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
- [ ] 官方 base/audit/kali-minimal 引用均为 digest，并通过断网硬化冒烟（含 `mvn -v`）与联网最小 Maven POM package、大小预算；其中 kali-minimal 仅是 Test 默认环境，Verify 默认使用 Base；
- [ ] 第三方准入需要的四个扫描器均以 digest 固定；
- [ ] PostgreSQL、Scheduler、Image Admission、Web 状态正常；
- [ ] `pnpm typecheck` 和 `pnpm build` 通过；
- [ ] fake 模式 API 冒烟通过；
- [ ] 已完成数据库备份和恢复演练。
