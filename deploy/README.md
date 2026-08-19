# deploy/

生产与本地一键部署编排（Docker Compose + 脚本）。

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
优先拉取 `$IMAGE_REGISTRY/deepsonar-assets-helper:$IMAGE_TAG` 并导出 RepoDigest；
该官方标签在下一正式 Release 才存在，当前版本回退
`docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`。
覆盖值必须仍是 immutable digest；失败即停止部署。fake 模式不使用 helper。

`SILO_IMAGE` 默认是 `docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z`。`up`/`pull` 优先拉取
`$IMAGE_REGISTRY/deepsonar-silo:$IMAGE_TAG` 并尽量写入 RepoDigest；该官方标签在下一正式
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
| `docker-compose.online.yml` | 空兼容层，勿依赖 |
| `Dockerfile.*` | 平台服务与 Agent 运行时 |
| `runtime-image-registry.json` | 官方 Agent 镜像清单（Release 回写） |
| `.env.example` | 环境变量模板（勿提交真实 `.env` / `master.key`） |
| `pull-runtime-images.sh` | 批量 pull Agent 镜像 |
| `prepare-runtime-images.*` | 本机 detect / 可选 adopt |

行为以脚本与 Compose 为准；文档漂移时改文档，不改脚本语义迁就旧文。
