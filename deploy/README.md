# deploy/

生产与本地一键部署编排（Docker Compose + 脚本）。

## 平台矩阵

控制面镜像（`scheduler` / `web` / `image-admission`）与再发布依赖（`assets-helper` / `silo`）随 Release 发布 `linux/amd64` + `linux/arm64` 多架构 index；运行时镜像此前已多架构。详见 [`docs/ONE_CLICK_DEPLOYMENT.md`](../docs/ONE_CLICK_DEPLOYMENT.md) §3.1 与 [`docs/RELEASE_RUNTIME_IMAGES.md`](../docs/RELEASE_RUNTIME_IMAGES.md)。

## 平台镜像引用（#740）

`docker-compose.prod.yml` 与 `docker-compose.opensandbox.host.yml` 的平台镜像只接受完整不可变 digest 引用，
`/health.version` 只认显式 `DEEPSONAR_VERSION`；`DEEPSONAR_IMAGE_TAG` 已删除：

```dotenv
DEEPSONAR_VERSION=<release-version-without-v>
DEEPSONAR_SCHEDULER_IMAGE=<registry>/deepsonar-scheduler@sha256:<digest>
DEEPSONAR_WEB_IMAGE=<registry>/deepsonar-web@sha256:<digest>
DEEPSONAR_IMAGE_ADMISSION_IMAGE=<registry>/deepsonar-image-admission@sha256:<digest>
```

四行随 Release 回写到 `.env.example`。`deploy.sh` / `deploy.ps1`（共享校验见 `platform-images.sh` 与
`Assert-PlatformImageContract`）发现旧变量、可变 tag、仓库名不符、重复/非规范平台变量或缺版本时 fail closed，并打印应复制的四行；
不自动补写、不回退 tag。`worker-join` 不运行平台镜像，只拒绝旧变量。`up real build` 临时把平台镜像标记为
`deepsonar-*:local-build`，不改写 `.env`。同 schema 的受控升级入口见下节。

## 受控升级与中断恢复（#740）

Shell 和 PowerShell 共享 `platform-upgrade-host.mjs` / `platform-upgrade.mjs`，宿主需 Node.js >=22、Docker Compose/buildx、管理员进程环境变量 `DEEPSONAR_ADMIN_TOKEN`。只支持单控制面 Compose、无远程 worker、稳定版本向前且 schema 相同的升级；跨 schema 在暂停前拒绝，完整配置兼容性 preflight、自动 schema 重建和多节点编排尚未实现。默认使用 prod + real + OpenSandbox overlay，其他布局需用 Node CLI 的重复 `--compose-file` 明确指定。

```bash
./deploy/deploy.sh upgrade check --to vX.Y.Z
./deploy/deploy.sh upgrade apply --to vX.Y.Z
./deploy/deploy.sh upgrade rollback
```

```powershell
.\deploy\deploy.ps1 upgrade check -UpgradeVersion vX.Y.Z
.\deploy\deploy.ps1 upgrade apply -UpgradeVersion vX.Y.Z
.\deploy\deploy.ps1 upgrade rollback
```

API 默认使用生产 Web 代理 `http://127.0.0.1:8080/api/`（保留自定义 API 路径前缀），Shell 可传 `--api` / `--web-url`，PowerShell 对应 `-ApiUrl` / `-WebUrl`。API 使用 HTTPS 或本机 HTTP；token 不写日志或恢复记录。升级前取消进程环境中的四个平台版本/镜像变量，避免覆盖 `.env`。目标来自官方 Release 清单，逐通道 inspect 双架构 payload，拉取目标 GHCR digest；检查 Compose 配置与目标镜像 schema，然后通过管理 API 暂停并排空所有未结算效果，不杀 Job。

备份处理限制为 512 MiB 内存缓冲，超过上限安全中止并保持暂停。暂停后生成 gzip 包装的 PostgreSQL custom dump，验证 SHA-256、解压内容及 `pg_restore --list` 中的控制/schema 数据；失败保持暂停。`.upgrade/` 保存本地互斥锁、逐步记录和备份，已排除 Git。硬中断留下锁时，先确认没有升级进程，再人工移除 `.upgrade/lock`；同一未完成记录不会被新 apply 覆盖。恢复记录绑定 Compose 项目、配置文件内容及 Docker 目标；缺失绑定或目标变化时拒绝恢复，不能把记录移到其他部署继续。服务切换后最多等待 180 秒达到 ready，允许启动期间的暂态连接/HTTP 失败；随后核对 schema、版本、实际容器 digest 和 Web HTTP，全部通过才恢复领取。超时保持暂停。停止本地服务前再次直接核对本地数据库的暂停与排空状态，避免 API 地址误指其他部署。

中断或失败不会自动恢复领取；执行 `rollback` 前必须确认数据库仍暂停且已排空。回滚只恢复记录中的镜像配置，保留数据库及暂停期间新入队/管理写入；备份供人工离线灾难恢复，**不会自动恢复旧数据库**。回滚完成仍暂停，管理员核验后调用 `/platform/claims/resume`。一旦记录到恢复领取意图但结果不明，拒绝自动回滚，必须先人工对账；已完成升级也不支持自动降级。

真实容器演练入口、隔离要求与 #740 验收缺口见 [升级演练](UPGRADE_REHEARSAL.md)。

## 快速开始

```bash
./deploy/deploy.sh up              # 默认：real + 从阿里云 ACR pull
./deploy/deploy.sh up fake pull    # 仅状态机
./deploy/deploy.sh up real build   # 本地构建平台镜像
./deploy/deploy.sh pull             # 拉平台镜像与官方 Silo；real 默认同时预拉共享资产 helper
```

Windows 推荐 **PowerShell 7+（`pwsh`）**。`deploy.ps1` 以 **UTF-8 with BOM** 保存，正文仅 ASCII，避免 Windows PowerShell 5.1 按系统代码页误解析中文/全角标点（ParserError）。5.1 也可直接运行。

```powershell
# 推荐：pwsh。默认与 deploy.sh 相同：up real pull
pwsh -NoProfile -File .\deploy\deploy.ps1
# 等价显式参数（-NoBuild 仍映射为 -Source pull）
.\deploy\deploy.ps1 -Action up -Mode real -Source pull
.\deploy\deploy.ps1 -Action up -Mode fake -Source pull
.\deploy\deploy.ps1 -Action up -Mode real -Source build
.\deploy\deploy.ps1 -Action pull -Mode real
```

real 模式使用 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 写入共享资产只读卷。`up`/`pull`
优先拉取 `$IMAGE_REGISTRY/deepsonar-assets-helper:$DEEPSONAR_VERSION` 并导出 RepoDigest；
该官方标签在下一正式 Release 才存在，当前版本回退
`docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`。
覆盖值必须仍是 immutable digest；失败即停止部署。fake 模式不使用 helper。

`SILO_IMAGE` 默认是 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`。`up`/`pull` 优先拉取
`$IMAGE_REGISTRY/deepsonar-silo:$DEEPSONAR_VERSION` 并尽量写入 RepoDigest；该官方标签在下一正式
Release 才存在。已覆盖为其它镜像时不改写。Silo 的 command / healthcheck / `mcli` 契约不变。

real compose 将 `DEEPSONAR_HOST_DISK_SOURCE`（默认 `/var/lib/docker`）只读挂载为
Scheduler 的 `/host-disk`，仅供 Node `statfs` 水位检查。rootless Docker/vfs 必须把它改成
实际 data-root（例如 `/home/admin/.local/share/docker`）。达到 error 阈值会暂停新 Job claim，
恢复后自动唤醒；`DEEPSONAR_RUNTIME_IMAGE_GC_INTERVAL_SEC=0` 可关闭安全镜像 GC。GC 只删除 DB
已知且未被 promoted/回滚版/项目 pin/非终态 Job/容器保护的 immutable runtime ref，不执行 prune。

`image-admission` 的 `DEEPSONAR_{COSIGN,SYFT,TRIVY,CLAMAV}_IMAGE` 必须是 `@sha256:` digest。
未设或留空回退官方 pin（见 `deploy/.env.example`）；非法覆盖仍会 fail closed。

完整说明：**[`docs/ONE_CLICK_DEPLOYMENT.md`](../docs/ONE_CLICK_DEPLOYMENT.md)**  
根目录快速入口：[`README.md`](../README.md)  
运行时镜像发布：[`docs/RELEASE_RUNTIME_IMAGES.md`](../docs/RELEASE_RUNTIME_IMAGES.md)

## 文件索引

| 路径 | 说明 |
|------|------|
| `deploy.sh` / `deploy.ps1` | 一键 up/down/status/logs/pull |
| `docker-compose.prod.yml` | 生产栈（PG、Silo、scheduler、web、admission、backup） |
| `docker-compose.real.yml` | real：挂载 docker.sock |
| `docker-compose.yml` | 独立开发库（`pnpm db:up`） |
| `ensure-postgres.mjs` | `pnpm db:up:deploy`：开发态改连 prod Postgres |
| `Dockerfile.*` | 平台服务与 Agent 运行时 |
| `runtime-image-registry.json` | 官方 Agent 镜像清单（Release 回写） |
| `.env.example` | 环境变量模板（勿提交真实 `.env` / `master.key`） |
| `pull-runtime-images.sh` | 批量 pull Agent 镜像 |
| `prepare-runtime-images.*` | 本机 detect / 可选 adopt |

行为以脚本与 Compose 为准；文档漂移时改文档，不改脚本语义迁就旧文。
