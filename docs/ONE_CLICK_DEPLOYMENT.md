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
| `deploy/Dockerfile.scheduler` / `.web` / `.image-admission` / `.assets-helper` / `.silo` | 平台服务镜像 |
| `deploy/Dockerfile.agent*` | Agent 运行时（base/audit/Kali/Chrome/OpenHarmony/Android） |
| `deploy/.env.example` | 环境变量模板（Release 会同步版本号） |
| `deploy/runtime-image-registry.json` | 官方运行时清单（bundled fallback） |
| `deploy/deploy.sh` / `deploy.ps1` | 一键脚本（`up real` 单机；`up worker-join` 远程执行面） |
| `deploy/docker-compose.worker.yml` | 远程 worker：OpenSandbox + 注册/心跳 agent |
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
# Windows: prefer pwsh. deploy.ps1 is UTF-8 with BOM + ASCII so Windows PowerShell 5.1 also parses.
Set-ExecutionPolicy -Scope Process Bypass
pwsh -NoProfile -File .\deploy\deploy.ps1                  # = up real pull
.\deploy\deploy.ps1 -Action up -Mode real -Source pull
.\deploy\deploy.ps1 -Action up -Mode fake -Source pull
.\deploy\deploy.ps1 -Action up -Mode real -Source build
```

脚本会：

1. 从 `deploy/.env.example` 生成 `deploy/.env`（随机库密码、引导 Token、Silo 凭据）；
2. 生成 `deploy/master.key`（凭据加密主密钥，勿提交）；
3. 校验平台镜像部署契约（#740）：`DEEPSONAR_SCHEDULER_IMAGE` / `DEEPSONAR_WEB_IMAGE` / `DEEPSONAR_IMAGE_ADMISSION_IMAGE` 必须是对应仓库的完整不可变引用 `<registry>/<name>@sha256:<64 位小写 hex>`，且显式声明 `DEEPSONAR_VERSION`（无 `v` 前缀）；`deploy/.env` 或进程环境仍有已删除的 `DEEPSONAR_IMAGE_TAG`、可变 tag、仓库名不符或缺版本时直接 fail closed，并打印应从 `deploy/.env.example` 复制的四行。随后按这三条 digest 引用从阿里云 ACR 拉取；
4. 优先拉取同 registry、`DEEPSONAR_VERSION` 标签的 `deepsonar-silo`，将 RepoDigest（或 tag）写成 `SILO_IMAGE`；该标签不存在时回退 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`。已覆盖为其它镜像时不改写；
5. real 模式优先拉取同 registry、`DEEPSONAR_VERSION` 标签的 `deepsonar-assets-helper`，将 RepoDigest 写成 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE`；该标签不存在时回退 busybox pin。覆盖值必须仍是 immutable sha256 digest，拉取失败则停止部署；
6. 启动 Compose（real 时叠加 `docker-compose.real.yml`）；
7. Scheduler 先监听 `/health`（liveness，含 `runtime_images` 与 `dispatcher.enabled`），再后台准备当前通道的官方默认 digest（Base/Audit/Kali）；`project_opt_in` 专项镜像不阻塞 dispatcher。`ready=false` 时不启用 Dispatcher，失败保持服务存活并退避重试。real 模式在启用 Dispatcher 前预热 managed gateway。

访问：**http://127.0.0.1:8080**


### Podman 与依赖就绪（#726）

部分 Podman / Compose 组合下，依赖服务的 healthcheck 可能长期停在 `starting`，导致 `depends_on: service_healthy` 无限阻塞，`web`/`scheduler` 停在 `Created`、入口端口不可达。

- `DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC`（默认 `600`）：`compose up` 墙上时钟上限；超时失败并输出诊断。
- `DEEPSONAR_READY_TIMEOUT_SEC`（默认 `180`）：postgres/silo 真实探测与入口 `/api/health` 等待上限。
- `DEEPSONAR_COMPOSE_DEPENDS_ON`：`auto`（默认，检测到 Podman 时启用兼容层）/ `healthy` / `started`。
- 成功门禁：postgres 与 Silo 必须通过所属 Compose 服务内的真实探测，web 与 scheduler 容器必须为 `running`，且配置入口端口（默认 8080）的 `/api/health` JSON 顶层必须同时为 `ok: true`、`ready: true`。HTTP 200、`ok: true` 或 `runtime_images.ready` 单独为真都不代表平台已就绪；runtime warmup / OpenSandbox / Dispatcher 未就绪时继续等待，耗尽预算非零退出。
- 此预算只约束 `compose up`、就绪门禁与诊断，不是整个部署脚本的总 deadline；前置 config/pull 和已有桥接配置不在此计时范围内。每个依赖探测、容器状态查询及诊断命令都有独立上限；依赖循环按墙上时钟 deadline 计算（包含 exec 时间），超时清理最多另加 1 秒。入口 JSON 通过 scheduler 容器内的 Node 解析，宿主无需安装 JSON 解析器。日志中的凭据形态会脱敏。
- sh 的 `compose up` 普通失败保留原退出码；只有超时 `124` 且基础依赖真实就绪时允许受控恢复，恢复仍须等待 `silo-init` 成功退出，再启动 scheduler，最后通过同一入口与容器门禁。PowerShell 对 `compose up` 失败直接停止并输出有界诊断；不会因 `service_started` 跳过依赖探测或误报成功。
- `pnpm ci:unit:deploy-ps1` 包含 sh 行为回归及 PowerShell 函数行为/原生命令超时回归；CI 必须提供 PowerShell。测试夹具不代替 Docker/Podman 真机部署验收。

### 登录

空库首次启动创建人类管理员（生产必须立刻改密）：

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `Deep@Sonar66` |

容器部署 `DEEPSONAR_AUTH_REQUIRED=true`。`DEEPSONAR_ADMIN_TOKEN` 为 API/本机调用引导 Token，与人类会话账号独立。

### 平台镜像引用（#740 digest 契约）

- 平台镜像（scheduler / web / image-admission）只按不可变 digest 部署；`DEEPSONAR_IMAGE_TAG` 已删除，不保留兼容。Compose 缺任一变量直接失败，`deploy.sh` / `deploy.ps1` 另拒绝旧变量与非 digest 引用。
- `/health.version` 只认 `DEEPSONAR_VERSION`，不再回退镜像 tag；未设置时为空。
- `deploy/.env.example` 的这四行与 `runtime-image-registry.json` 随 Release 回写，不要手改成 tag：

```dotenv
DEEPSONAR_VERSION=<release-version-without-v>
DEEPSONAR_SCHEDULER_IMAGE=<registry>/deepsonar-scheduler@sha256:<digest>
DEEPSONAR_WEB_IMAGE=<registry>/deepsonar-web@sha256:<digest>
DEEPSONAR_IMAGE_ADMISSION_IMAGE=<registry>/deepsonar-image-admission@sha256:<digest>
```

- 已有部署升级到本契约：先删除 `deploy/.env` 中的 `DEEPSONAR_IMAGE_TAG`，再从目标版本的 `deploy/.env.example` 复制上面四行（不要删除整个 `deploy/.env`，其中保存数据库密码与密钥）。受控维护 `upgrade` 会在审批、数据库身份隔离和备份验证后更新这些行，跨 schema 仅重建候选库而保留源库；不要以手动改镜像替代维护流程。限制与中断恢复见 [部署脚本说明](../deploy/README.md)。
- `DEEPSONAR_IMAGE_REGISTRY` 仍保留，只用于按 `DEEPSONAR_VERSION` 解析官方 `deepsonar-assets-helper` / `deepsonar-silo` 并固定为 RepoDigest。
- `up real build` 本地构建时脚本临时把三个平台镜像标记为 `deepsonar-*:local-build`（Compose 不能把构建产物标记为 `name@sha256:`），不改写 `deploy/.env` 中的 digest 引用；`DEEPSONAR_VERSION` 仍须显式设置。

## 3.1 平台矩阵（控制面 vs 运行时）

正式 Release（`v*` → `.github/workflows/release.yml`）对官方镜像按下列矩阵发布多架构 OCI index；ACR / GHCR / Docker Hub 同步同一 index（通道缺凭据时该通道记 unavailable，不编造 digest）。

| 类别 | 镜像 | 平台 |
| --- | --- | --- |
| 控制面 | `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission` | `linux/amd64` + `linux/arm64` |
| 控制面依赖再发布 | `deepsonar-assets-helper`（busybox）/ `deepsonar-silo`（pgsty/silo） | `linux/amd64` + `linux/arm64`（上游 digest 已含双架构） |
| 运行时 | `deepsonar-base` / `audit` / `kali-minimal` 及多数专项 runtime | `linux/amd64` + `linux/arm64`（既有） |

`deploy/Dockerfile.scheduler` 按 `TARGETARCH` 安装并校验 amd64/arm64 各自的 `kubectl` sha。控制面 Node 基础镜像钉 `node:24-alpine@sha256:…` 的**多架构 index**（须同时含 amd64 与 arm64；禁止回退到历史 amd64-only digest，见 #598）。

Apple Silicon / Graviton / 本机 arm64 上 `./deploy/deploy.sh up real pull` 应直接拉取 arm64 层，无需 `--platform linux/amd64`。`device-broker` 为 rig 侧可选镜像，Dockerfile 与控制面共用同一 Node pin，但不走上述 Release 矩阵。

## 4. fake 与 real

| 模式 | 用途 | 要点 |
|------|------|------|
| `fake` | 验收状态机 / Hub / 画布 / 幂等 | 不启真实沙箱、不调上游模型 |
| `real`（默认） | 真实 Agent 执行 | 挂载 docker.sock；Job 只认目录内不可变 digest |

CLI / model / 长期密钥：**不在**部署 env 里选；用 Credentials + RoleConfig，Job 创建时冻结。`AGENT_MODE` 只表示 fake/real。

### 4.0 远程执行面 worker-join（#415 P0）

单机 `up real` 不变：Scheduler 启动时把 `OPEN_SANDBOX_DOMAIN` 种子为 `local` worker。要在另一台机器加执行容量：

1. 控制面 `deploy/.env` 记下 `DEEPSONAR_WORKER_BOOTSTRAP_TOKEN`（`up real` 会生成）。
2. 在 worker 宿主机复制同一 token，并设置该节点 OpenSandbox 对控制面可达的 `host:port`。
3. `DEEPSONAR_CONTROL_PLANE` 指向 Scheduler 基址。官方路径经 Web 反代时用 `http://<control-host>:8080/api`。
4. `./deploy/deploy.sh up worker-join --control-plane http://<control-host>:8080/api`

`endpoint` 必须是控制面可达的 `host:port`，不能是 loopback、link-local、`169.254.0.0/16` 或其它不可路由地址。同名节点不能靠再次 register 接管；worker-agent 会把 `node_token` 存在 `worker-agent-state` 卷。要换机器或轮换身份，先在控制面 `DELETE /workers/:id`。可选 `DEEPSONAR_WORKER_ENDPOINT_CIDRS` / `DEEPSONAR_WORKER_ENDPOINT_HOSTS` 收紧允许的远端。

沙箱 create/exec/PTY 仍走 `OPEN_SANDBOX_USE_SERVER_PROXY`，不组 overlay。OpenSandbox `[ingress]` 支持矩阵（#556）：Docker 默认 `mode = "direct"`（`deploy/opensandbox/config.toml`）——当前 pin 的 server 在 Docker backend 上未实现 gateway，且 `mode=gateway` 会要求 `[gateway]` 块否则启动 ValidationError；Kubernetes 可在提供 `[gateway]`（address + route.mode）时使用 `mode = "gateway"`（仅 K8s 路径实现）。#548 的 scheduler 侧 upload 重试 / provision 分类 / NUL 清洗在 direct 下仍生效。受限网络 / 共享资产卷的 Job 仍只派到 `local` worker（gateway sidecar 仍在控制面 Docker 引擎上）。心跳超时只停止新派发，不自动开新 attempt。派发 claim 与容量预留同一事务完成（#434），create 失败释放占位 lease。

官方 Agent 镜像 digest 优先来自 GitHub Release / 内置 `runtime-image-registry.json`；`DEEPSONAR_OFFICIAL_*_IMAGE` 仅作清单尚无版本时的启动兜底，不能用可变 tag 越过市场信任。

发布与多 channel 细节：[`RELEASE_RUNTIME_IMAGES.md`](./RELEASE_RUNTIME_IMAGES.md)、[`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](./RUNTIME_IMAGE_REGISTRY_CONTRACT.md)。

### 4.1 共享资产 helper 与 provision admission（#158）

real 模式写入共享资产只读卷时，`deploy.sh` / `deploy.ps1` 的 `up`/`pull` 优先拉取
`$IMAGE_REGISTRY/deepsonar-assets-helper:$DEEPSONAR_VERSION`（与 scheduler/web 同一发布通道），
`docker image inspect` 取其 RepoDigest 并导出为 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE`。
该官方标签在下一正式 Release 才首次发布；当前 v0.1.40 及更旧版本回退
`docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`。
覆盖值必须仍是带小写 64 位 `sha256` digest 的 OCI 引用。失败即 fail closed。
Job 运行时只用 `--pull=never` 创建 helper，不能因单个 Job 触发隐式 registry 拉取；
fake 模式不预拉也不使用 helper。运行时默认在官方 digest 存在前仍是上述 busybox pin，
不把未发布的官方 digest 写进仓库。

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

#### 网络拓扑与服务发现（#685）

rootless Podman 下容器每多挂一张启用 DNS 的网，`/etc/resolv.conf` 就多一个 aardvark nameserver；
musl 会并行查询全部 nameserver，只要某个名字不在其中一张网上，就会间歇 `ENOTFOUND`。调整
nameserver 顺序不能根治，健康探测的有界重试只作瞬态保护。因此拓扑约定为「每个容器只有一个 DNS 视图」：

| 部署模式 | Scheduler / DB / S3 / OpenSandbox 管理端 | 沙箱 → Gateway / Control API |
| --- | --- | --- |
| bridge（`docker-compose.prod.yml` + `docker-compose.opensandbox.prod.yml`，`up real` 默认） | 全部只挂业务网 `deepsonar`，按服务名互相解析；DB / 对象存储从不接沙箱网 | 沙箱只解析 `deepsonar-gateway-proxy`（provision 时写入沙箱 `/etc/hosts`）。代理只挂沙箱侧网络（`deepsonar-sandbox-gateway` / `deepsonar-restricted` / 沙箱所在网），经命名卷 `deepsonar-gateway-upstream` 上的 Unix socket（`/run/deepsonar-gateway/scheduler.sock`，代理侧只读挂载）回连 Scheduler，**不做任何 DNS 解析** |
| host（`docker-compose.opensandbox.host.yml`） | `network_mode: host`，DB / S3 / OpenSandbox 走回环端口 | 代理上游为 `http://host.docker.internal:<SCHEDULER_HOST_PORT>/gateway`，名字由 `--add-host host.docker.internal:host-gateway` 写入代理 `/etc/hosts`，同样不依赖任何网络的 DNS |

- bridge 模式由 Scheduler 在启动时创建 socket（容器重建后自动清理旧 socket 文件并重新监听），代理每个请求现连，
  Scheduler / 代理任一重建或 IP 变化都无需改配置；Scheduler 不可达时代理返回 `502`，不会回退到其它路由。
- 代理仍只放行 `/gateway` 与 `/control/v1`（Job token 鉴权不变），管理 API、任意路径与 `CONNECT` 一律拒绝；
  代理不在业务网上，沙箱无法经它触达 PostgreSQL / Silo。
- `DEEPSONAR_GATEWAY_UPSTREAM_SOCKET_VOLUME` 同时决定 compose 卷名与代理挂载的卷名，必须一致；冒烟用的
  `docker-compose.opensandbox.prod-isolated.yml` 改用独立卷，避免劫持生产 socket。
- 部署自检：`packages/runtime-sandbox/src/compose-network-topology.test.ts`（挂在 `pnpm ci:unit:runtime-sandbox`）
  渲染官方 compose 组合，校验多网容器解析的每个服务名都挂在它的全部网络上、Scheduler 只挂业务网、数据服务不接沙箱网。
- 从旧版本升级：`deploy.sh up real pull` 会把 Scheduler 与 `opensandbox` 从 `deepsonar-sandbox-gateway` 摘下，
  旧代理因 upstream 指纹变化在下一次 provision 前自动重建。手工维护的 compose 覆盖若仍给 Scheduler 加挂沙箱网，请删除。

### 4.2 Image Admission 扫描器镜像

`image-admission` 启动时要求四个扫描器镜像都是不可变 `@sha256:<64 hex>` digest，环境变量为：

- `DEEPSONAR_COSIGN_IMAGE`
- `DEEPSONAR_SYFT_IMAGE`
- `DEEPSONAR_TRIVY_IMAGE`
- `DEEPSONAR_CLAMAV_IMAGE`

未设或留空（含仅空白）时回退 `apps/image-admission` 内置的官方 pin（与 `deploy/.env.example` 相同）。显式覆盖必须仍是 digest；tag 或非法值会 fail closed，进程拒绝启动。Release 回写 `.env.example` 只改 `DEEPSONAR_VERSION` 与三条平台镜像 digest 引用，这四行 scanner pin 会原样保留。

Cosign 3 默认不对官方 catalog digest 验签（`signature: skipped`）。要强制验签时同时配置 `DEEPSONAR_COSIGN_KEY`，或 Cosign 3 keyless 的 `DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY`（或 `_REGEXP`）加上 `DEEPSONAR_COSIGN_CERTIFICATE_OIDC_ISSUER`（或 `_REGEXP`）。缺 identity/`--key` 时不会发出 `cosign verify`。

### 专项运行时（可选）

| image key | 用途 |
|-----------|------|
| `deepsonar-base` / `deepsonar-audit` | 默认角色底座 / 审计 |
| `deepsonar-kali-minimal` | Test 默认（无 metapackage/GUI） |
| `deepsonar-openharmony-*` | OH 源码 test/audit/fuzz（project opt-in） |
| `deepsonar-chrome-*` | Chrome audit/test/fuzz（project opt-in） |
| `deepsonar-clickhouse-*` | ClickHouse audit/test/fuzz（官方 LTS 二进制 + C++/fuzz 工具链；project opt-in） |
| `deepsonar-mobile` | 移动端 Android/iOS/OpenHarmony（JADX/apktool/bundletool/apkeep/androguard/rust-asc（droidasc 兼容；droidasc-python 显式回退）/ApkCheckPack/ADB/Frida、binutils/radare2/LIEF、libimobiledevice、HAP/hdc；project opt-in） |

Verify 系统角色默认 Base，不默认 Kali。工具链矩阵见 [`RUNTIME_TEST_TOOLCHAINS.md`](./RUNTIME_TEST_TOOLCHAINS.md)。

本地批量 pull Agent 镜像：

```bash
./deploy/pull-runtime-images.sh --file deploy/runtime-image-registry.json
# 或带 Scheduler：
# DEEPSONAR_URL=http://127.0.0.1:8080/api DEEPSONAR_TOKEN=… ./deploy/pull-runtime-images.sh
```

批量脚本严格使用 API 返回的 `selected_channel`；读取静态清单时使用
`DEEPSONAR_RUNTIME_REGISTRY_CHANNEL`（缺省 `aliyun-acr`）。它只选择宿主平台上每个产品的最新版本，
所选通道或平台缺失时直接失败，不跨 registry 回退。项目排除/启用镜像时（`PUT /projects/:id/runtime-images/:imageId`，#691 拒绝钉版本），
Scheduler 缺图时立即返回 `202 preparing/saved:false` 并启动后台准备；配置不落库，完成后需显式重试。
建任务 / Hub 派生 / resume 只冻结不可变 digest，不再因 Scheduler 本机缺层拒绝。
OpenSandbox server 按冻结 digest 拉取，并在 provision 后重验合同；Scheduler 不会在 Job 执行期隐式 `docker pull`。

本机 tag 的 `detect-local` / `adopt-local` 见 `prepare-runtime-images.*`：检测只读，adopt 须管理员显式确认，不进入导出清单。

## 5. 数据库 schema

- **唯一基线**：`database/schema.sql` + `apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION`
- 空库启动：套用基线；非空：校验版本与表结构，不符 **fail closed**
- **无增量 ALTER 链**；改表 = 改基线 + bump 版本 + **重建库**
- 已有数据升级：使用下文维护 `upgrade check/apply`，审核计划后冻结源库并重建候选；独立 `pnpm db:rebuild` 是人工基线重建工具，不具备宿主升级的身份隔离/激活恢复闭环，不应直接代替受控流程。Postgres 默认不对外暴露，维护 CLI 使用绑定的 Compose PostgreSQL。
- 手工空库：`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql`

## 6. 对象存储

生产 Compose 默认 `BLOB_STORE=s3` 指向内部 Silo（`http://silo:9000`）。`SILO_IMAGE` 优先用官方 `deepsonar-silo`，下一正式 Release 前回退 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`。证据/报告仍写本地 `BLOB_DIR` volume。切换外部 S3 见 [`SHARED_ASSET_BLOB_STORE.md`](./SHARED_ASSET_BLOB_STORE.md)；切换前先迁移并校验对象。

## 7. 运维命令

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh check
./deploy/deploy.sh pull          # 拉平台镜像与官方 Silo；real 默认同时拉 helper
./deploy/deploy.sh down          # 保留 postgres / blob / silo volume
```

```powershell
.\deploy\deploy.ps1 status
.\deploy\deploy.ps1 logs
.\deploy\deploy.ps1 pull          # 拉平台镜像；real 默认同时拉 helper
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

生产平台升级使用固定官方目标，不以 `git pull` 后直接重启服务代替维护流程：

```bash
./deploy/deploy.sh upgrade check --to vX.Y.Z
# 审核返回风险，使用该计划的 hash
./deploy/deploy.sh upgrade apply --to vX.Y.Z --approve-plan-hash <reviewed-plan-hash>
# 激活前失败后的安全回滚与显式恢复
./deploy/deploy.sh upgrade rollback
./deploy/deploy.sh upgrade resume-rollback
```

普通 `/platform/claims/pause` 只暂停领取，仍允许入队，不能建立数据库备份的写入隔离边界。维护控制器在预检后排空任务和全部未结算效果，再关闭旧数据库身份，验证备份并恢复/重建独立候选库；源库保持冻结。目标服务/受管节点 preparing 验证后才激活，激活后或结果不明时禁止切回旧库。不要在维护回滚后绕过 `resume-rollback` 直接调用 claims/resume。

旧角色身份需清理时必须明确加 `--reset-role-identity`（PowerShell `-ResetRoleIdentity`），重新取得并批准计划 hash；它仅清角色 CLI 与项目 model，保留全局 model 和历史快照。`--nodes` / `-Nodes` 绑定受管 SSH 节点清单；旧源缺少维护契约时不能安全恢复远程节点。配置预检覆盖声明的 URL/枚举、主密钥文件只读绑定与内容格式、已存凭据的 AES-GCM 认证及 当前持久默认组合的 credential-first 选择；仍不证明外部认证或模型可用性，详见部署说明。

维护模块与入口已实现，真实单机/多节点成功场景已通过，选定 11 项中断、排空、备份损坏与多节点恢复场景已通过，最终组合基线镜像待验收；不能据历史同 schema 测试或部分场景宣布当前路径全面通过。详细参数、权限、恢复限制和覆盖范围见 [受控升级](../deploy/README.md)；证据与执行命令见 [隔离演练](../deploy/UPGRADE_REHEARSAL.md)。

官方 runtime image 升版（例如 `0.1.38` → `0.1.39`）并完成 registry sync 后，市场会列出新的 trusted digest。#691 起项目不再钉版本，新建 Job 始终按平台 channel 最新 trusted 解析并冻结 digest；已冻结 Job 快照不改写。

## 8. 常见问题

| 现象 | 处理 |
|------|------|
| API 401 | 鉴权开启为预期；配置控制台 Token / 人类登录 |
| 登录 429 像全站一起被锁 | 官方路径是浏览器 → Web(:8080) → Scheduler。Web 用入站 TCP peer 覆盖 `X-Forwarded-For`，Scheduler 默认只信任 1 跳（`DEEPSONAR_TRUST_PROXY_HOPS=1`）。在 Web 前面再加未纳入该 hop 策略的反向代理时，所有浏览器会共享同一 IP 桶（20 次/5 分钟）。不要把 Scheduler HTTP 暴露到公网；需要真实客户端 IP 时让 Web 直接看到浏览器（或该代理终止 TLS 后把真实 peer 交给 Web） |
| Silo healthcheck 长时间 starting / `up` 卡住（常见于部分 Podman） | #726：`deploy.sh`/`deploy.ps1` 对 `compose up` 有界等待（`DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC`，默认 600s），超时非零退出并打印容器状态/健康/日志/版本（脱敏）。Podman 或 `DEEPSONAR_COMPOSE_DEPENDS_ON=started` 时附加 `docker-compose.podman-compat*.yml`（`service_started`），但仍用 postgres/silo 真实探测与入口 `:8080/api/health` 门禁；依赖真实不可用不会因 `service_started` 误报成功。`healthy` 可强制保留原 `service_healthy`。与 #101（silo-init 拆词）不同。 |
| Scheduler 不健康 | `./deploy/deploy.sh logs`：库密码、schema 版本、`change-me` 占位符、资源 |
| real 无 Docker | 确认 real 覆盖层与 sock 挂载 |
| 部署报 `DEEPSONAR_IMAGE_TAG` / 非 digest 平台镜像引用 | #740 已删除 tag 部署：删除该行，从目标版本 `deploy/.env.example` 复制 `DEEPSONAR_VERSION` 与三条 `DEEPSONAR_*_IMAGE` digest 引用；不要删除整个 `deploy/.env` |
| real helper 拉取失败 | 官方 `deepsonar-assets-helper:$DEEPSONAR_VERSION` 不存在时应回退 busybox pin；覆盖值必须是可达的 immutable digest，脚本会 fail closed |
| Silo 拉取失败 | 官方 `deepsonar-silo:$DEEPSONAR_VERSION` 不存在时应回退 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`；自定义 `SILO_IMAGE` 覆盖仍有效 |
| image-admission Restarting (1) / 缺 scanner digest | 四个 `DEEPSONAR_{COSIGN,SYFT,TRIVY,CLAMAV}_IMAGE` 必须是 `@sha256:` digest。未设或留空会回退官方默认；填了 tag 或非法值仍会启动失败 |
| real 无法建 Job | 官方 digest 未准入/未 pull；在镜像市场检查通道与版本 |
| 彻底清数据 | 备份后手工 `docker compose … down --volumes`（不可恢复） |

## 9. 上线检查

- [ ] `deploy/.env` / `master.key` 无占位符且未进 Git
- [ ] `DEEPSONAR_AUTH_REQUIRED=true`，已改默认管理员密码
- [ ] 已建长期 API Token；外部事件 Token 单项目 + `tasks:write`
- [ ] real：官方 base/audit（及所用专项）均为 digest 且可 pull
- [ ] real：`DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 为 immutable digest 且已被部署脚本预拉
- [ ] `SILO_IMAGE` 为官方 `deepsonar-silo` 或当前 pgsty 回退 tag，且已被部署脚本预拉
- [ ] 第三方准入扫描器为 digest；未设时使用官方默认 pin，非法覆盖会阻止 image-admission 启动
- [ ] PostgreSQL / Silo / Scheduler / Image Admission / Web 正常
- [ ] 已备份并演练恢复
