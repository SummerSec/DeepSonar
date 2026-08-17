# DeepSonar 一键部署

> **状态：运维 as-built**。索引：[`README.md`](README.md)。

与代码、`deploy/deploy.sh` / `deploy/deploy.ps1` 对齐的部署说明。根目录 `README.md` 为快速入口；细节以本文件与脚本为准。

## 1. 组成

```text
浏览器 :8080
    ↓
Web Gateway（SPA + /api → Scheduler）
    ↓
Scheduler :3100  ←→  PostgreSQL 16
    ↓                 ↑
Image Admission       PGSTY Silo（共享资产 S3 API，默认 127.0.0.1:9000）
（docker.sock 扫描）  blob volume（证据/报告本地）
```

| 文件 | 用途 |
|------|------|
| `deploy/docker-compose.prod.yml` | PostgreSQL、Silo、Scheduler、Image Admission、Web、备份 |
| `deploy/docker-compose.real.yml` | real 模式：挂载 Docker Socket |
| `deploy/docker-compose.online.yml` | 空兼容层（旧脚本 `-f` 仍可用；推荐直接用 prod + pull） |
| `deploy/Dockerfile.scheduler` / `.web` / `.image-admission` | 平台服务镜像 |
| `deploy/Dockerfile.agent*` | Agent 运行时（base/audit/Kali/Chrome/OpenHarmony） |
| `deploy/.env.example` | 环境变量模板（Release 会同步版本号） |
| `deploy/runtime-image-registry.json` | 官方运行时清单（bundled fallback） |
| `deploy/deploy.sh` / `deploy.ps1` | 一键脚本 |
| `deploy/pull-runtime-images.sh` | 按清单批量 pull Agent 镜像 |
| `deploy/prepare-runtime-images.sh` / `.ps1` | 本地检测/可选 adopt 本机镜像 |

## 2. 前置

- Docker 24+、Compose v2（`docker compose`）
- 建议 ≥ 4 CPU / 8 GB 内存 / 20 GB 磁盘
- real 模式需可跑 Agent 沙箱（挂载 docker.sock）

## 3. 默认路径：从 ACR 拉取后 real 启动

**默认不是 fake，也不是本地 build。**

```bash
# Linux / macOS
chmod +x deploy/deploy.sh
./deploy/deploy.sh up              # = up real pull
./deploy/deploy.sh up fake pull    # 仅状态机
./deploy/deploy.sh up real build   # 本地 Dockerfile 构建平台镜像
```

```powershell
# Windows
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\deploy.ps1 -Action up -Mode real -NoBuild
.\deploy\deploy.ps1 -Action up -Mode fake -NoBuild
```

脚本会：

1. 从 `deploy/.env.example` 生成 `deploy/.env`（随机库密码、引导 Token、Silo 凭据）；
2. 生成 `deploy/master.key`（凭据加密主密钥，勿提交）；
3. 按 `DEEPSONAR_IMAGE_TAG`（无 `v` 前缀）从阿里云 ACR 拉取  
   `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission`；
4. real 模式显式拉取 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE`；该引用必须带 immutable sha256 digest，拉取失败则停止部署；
5. 启动 Compose（real 时叠加 `docker-compose.real.yml`）；
6. Scheduler 先监听 `/health`（liveness，含 `runtime_images` 与 `dispatcher.enabled`），再后台准备当前通道的官方默认 digest（Base/Audit/Kali）；`project_opt_in` 专项镜像不阻塞 dispatcher。`ready=false` 时不启用 Dispatcher，失败保持服务存活并退避重试。real 模式在启用 Dispatcher 前预热 managed gateway。

访问：**http://127.0.0.1:8080**

### 登录

空库首次启动创建人类管理员（生产必须立刻改密）：

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `Deep@Sonar66` |

容器部署 `DEEPSONAR_AUTH_REQUIRED=true`。`DEEPSONAR_ADMIN_TOKEN` 为 API/本机调用引导 Token，与人类会话账号独立。

### 镜像标签

- 平台镜像用 Release 版本号（ACR 标签**无** `v` 前缀，不发 `latest`）。
- `deploy/.env.example` 与 `runtime-image-registry.json` 随 Release 回写。
- 固定版本时显式设置：

```dotenv
DEEPSONAR_IMAGE_REGISTRY=crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec
DEEPSONAR_IMAGE_TAG=<release-version-without-v>
```

## 4. fake 与 real

| 模式 | 用途 | 要点 |
|------|------|------|
| `fake` | 验收状态机 / Hub / 画布 / 幂等 | 不启真实沙箱、不调上游模型 |
| `real`（默认） | 真实 Agent 执行 | 挂载 docker.sock；Job 只认目录内不可变 digest |

CLI / model / 长期密钥：**不在**部署 env 里选；用 Credentials + RoleConfig，Job 创建时冻结。`AGENT_MODE` 只表示 fake/real。

官方 Agent 镜像 digest 优先来自 GitHub Release / 内置 `runtime-image-registry.json`；`DEEPSONAR_OFFICIAL_*_IMAGE` 仅作清单尚无版本时的启动兜底。`DOCKER_IMAGE_AUDIT` 为历史兼容字段，**不能**用可变 tag 越过市场信任。

发布与多 channel 细节：[`RELEASE_RUNTIME_IMAGES.md`](./RELEASE_RUNTIME_IMAGES.md)、[`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](./RUNTIME_IMAGE_REGISTRY_CONTRACT.md)。

### 4.1 共享资产 helper 与 provision admission（#158）

real 模式写入共享资产只读卷时使用固定默认 helper：
`docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`。
可在 `deploy/.env` 用 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 覆盖，但必须仍是带小写 64 位
`sha256` digest 的 OCI 引用。`deploy.sh` 和 `deploy.ps1` 在 real 的 `up` 与 `pull` 路径显式执行
`docker pull`；失败即 fail closed。Job 运行时只用 `--pull=never` 创建 helper，不能因单个 Job
触发隐式 registry 拉取；fake 模式不预拉也不使用 helper。该 helper 不新增 DeepSonar 发布镜像。

Provision 并发是数据库 claim admission，不是进程内 semaphore：超过全局
`global_settings.maxConcurrentProvisioning` 的 Job 留在 `pending`，不消耗 `claimed_at`；槽位释放后
调度器显式唤醒 pending 队列，重新 claim 后才进入 `running`。`PROVISION_CONCURRENCY=2` 只在该全局配置
缺失时作为 fallback。rootless Docker 使用 `vfs` 存储驱动时，GB 级镜像的冷 `create` 会全量复制文件；应把数据库
`global_settings.maxConcurrentProvisioning` 设为 `1`，并使用生产默认 `PROVISION_TIMEOUT_SEC=900`。只改
`deploy/.env` 后执行 `docker compose restart` 不会更新既有容器环境，必须执行
`docker compose up -d --force-recreate scheduler`（或重新运行 `deploy.sh up real pull`）。

沙箱 Gateway 由 Scheduler 动态管理并同时加入普通 bridge 与 restricted internal bridge，不应再手工
`docker run`，也不应把 upstream 改为无路径的 Scheduler 根 URL。受管代理只暴露 `/gateway` 与
`/control/v1`；代理脚本或 upstream 指纹变化时会在下一次 provision 前自动重建。

### 4.2 Image Admission 扫描器镜像

`image-admission` 启动时要求四个扫描器镜像都是不可变 `@sha256:<64 hex>` digest，环境变量为：

- `DEEPSONAR_COSIGN_IMAGE`
- `DEEPSONAR_SYFT_IMAGE`
- `DEEPSONAR_TRIVY_IMAGE`
- `DEEPSONAR_CLAMAV_IMAGE`

未设或留空（含仅空白）时回退 `apps/image-admission` 内置的官方 pin（与 `deploy/.env.example` 相同）。显式覆盖必须仍是 digest；tag 或非法值会 fail closed，进程拒绝启动。Release 回写 `.env.example` 只改 `DEEPSONAR_IMAGE_TAG`，这四行 pin 会原样保留。

### 专项运行时（可选）

| image key | 用途 |
|-----------|------|
| `deepsonar-base` / `deepsonar-audit` | 默认角色底座 / 审计 |
| `deepsonar-kali-minimal` | Test 默认（无 metapackage/GUI） |
| `deepsonar-openharmony-*` | OH 源码 test/audit/fuzz（project opt-in） |
| `deepsonar-chrome-*` | Chrome audit/test/fuzz（project opt-in） |

Verify 系统角色默认 Base，不默认 Kali。工具链矩阵见 [`RUNTIME_TEST_TOOLCHAINS.md`](./RUNTIME_TEST_TOOLCHAINS.md)。

本地批量 pull Agent 镜像：

```bash
./deploy/pull-runtime-images.sh --file deploy/runtime-image-registry.json
# 或带 Scheduler：
# DEEPSONAR_URL=http://127.0.0.1:8080/api DEEPSONAR_TOKEN=… ./deploy/pull-runtime-images.sh
```

批量脚本严格使用 API 返回的 `selected_channel`；读取静态清单时使用
`DEEPSONAR_RUNTIME_REGISTRY_CHANNEL`（缺省 `aliyun-acr`）。它只选择宿主平台上每个产品的最新版本，
所选通道或平台缺失时直接失败，不跨 registry 回退。项目保存 `project_managed` 映射或启用/固定项目镜像时，
Scheduler 缺图时立即返回 `202 preparing/saved:false` 并启动后台准备；配置不落库，完成后需显式重试。Job 运行时 Dispatcher 只检查本地 digest，
缺失时以 `runtime_image_not_ready` 失败，不会临时触发网络拉取。

本机 tag 的 `detect-local` / `adopt-local` 见 `prepare-runtime-images.*`：检测只读，adopt 须管理员显式确认，不进入导出清单。

## 5. 数据库 schema

- **唯一基线**：`database/schema.sql` + `apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION`
- 空库启动：套用基线；非空：校验版本与表结构，不符 **fail closed**
- **无增量 ALTER 链**；改表 = 改基线 + bump 版本 + **重建库**
- 已有数据升级：先停 Scheduler，再 `pnpm db:rebuild -- --plan` / `pnpm db:rebuild -- --apply`（备份 + 套最新 `schema.sql` + 列交集回填；见 `database/README.md`）。生产 Compose 的 Postgres 默认不对外暴露，需从本机经 `deepsonar` Docker 网络连 `postgres:5432`，或临时 `docker compose port`。
- 手工空库：`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql`

## 6. 对象存储

生产 Compose 默认 `BLOB_STORE=s3` 指向内部 Silo（`http://silo:9000`）。证据/报告仍写本地 `BLOB_DIR` volume。切换外部 S3 见 [`SHARED_ASSET_BLOB_STORE.md`](./SHARED_ASSET_BLOB_STORE.md)；切换前先迁移并校验对象。

## 7. 运维命令

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh check
./deploy/deploy.sh pull          # 拉平台镜像；real 默认同时拉 helper
./deploy/deploy.sh down          # 保留 postgres / blob / silo volume
```

```powershell
.\deploy\deploy.ps1 status
.\deploy\deploy.ps1 logs
.\deploy\deploy.ps1 -Action pull -Mode real
.\deploy\deploy.ps1 down
```

健康检查：

```bash
curl -s http://127.0.0.1:8080/api/health
# {"ok":true,"ts":…}
```

### 备份

```bash
docker compose -p deepsonar --env-file deploy/.env \
  -f deploy/docker-compose.prod.yml exec -T postgres \
  pg_dump -U deepsonar -d deepsonar -Fc > deepsonar.dump
```

恢复到**独立实例**校验后再切流量。不要 `down --volumes` 除非确认可丢数据。

### 升级

```bash
git pull
./deploy/deploy.sh up            # pull 模式：拉新 tag；build 模式：重建
```

schema 大版本变化时须按基线重建库（无升级路径）。升级前先备份。

## 8. 常见问题

| 现象 | 处理 |
|------|------|
| API 401 | 鉴权开启为预期；配置控制台 Token / 人类登录 |
| 登录 429 像全站一起被锁 | 官方路径是浏览器 → Web(:8080) → Scheduler。Web 用入站 TCP peer 覆盖 `X-Forwarded-For`，Scheduler 默认只信任 1 跳（`DEEPSONAR_TRUST_PROXY_HOPS=1`）。在 Web 前面再加未纳入该 hop 策略的反向代理时，所有浏览器会共享同一 IP 桶（20 次/5 分钟）。不要把 Scheduler HTTP 暴露到公网；需要真实客户端 IP 时让 Web 直接看到浏览器（或该代理终止 TLS 后把真实 peer 交给 Web） |
| Scheduler 不健康 | `./deploy/deploy.sh logs`：库密码、schema 版本、`change-me` 占位符、资源 |
| real 无 Docker | 确认 real 覆盖层与 sock 挂载 |
| real helper 拉取失败 | 检查 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 是否为可达的 immutable digest 引用；脚本会 fail closed |
| image-admission Restarting (1) / 缺 scanner digest | 四个 `DEEPSONAR_{COSIGN,SYFT,TRIVY,CLAMAV}_IMAGE` 必须是 `@sha256:` digest。未设或留空会回退官方默认；填了 tag 或非法值仍会启动失败 |
| real 无法建 Job | 官方 digest 未准入/未 pull；在镜像市场检查通道与版本 |
| 彻底清数据 | 备份后手工 `docker compose … down --volumes`（不可恢复） |

## 9. 上线检查

- [ ] `deploy/.env` / `master.key` 无占位符且未进 Git
- [ ] `DEEPSONAR_AUTH_REQUIRED=true`，已改默认管理员密码
- [ ] 已建长期 API Token；外部事件 Token 单项目 + `tasks:write`
- [ ] real：官方 base/audit（及所用专项）均为 digest 且可 pull
- [ ] real：`DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 为 immutable digest 且已被部署脚本预拉
- [ ] 第三方准入扫描器为 digest；未设时使用官方默认 pin，非法覆盖会阻止 image-admission 启动
- [ ] PostgreSQL / Silo / Scheduler / Image Admission / Web 正常
- [ ] 已备份并演练恢复
