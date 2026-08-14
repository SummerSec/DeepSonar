# deploy/

生产与本地一键部署编排（Docker Compose + 脚本）。

## 快速开始

```bash
./deploy/deploy.sh up              # 默认：real + 从阿里云 ACR pull
./deploy/deploy.sh up fake pull    # 仅状态机
./deploy/deploy.sh up real build   # 本地构建平台镜像
./deploy/deploy.sh pull             # 拉平台镜像；real 默认同时预拉共享资产 helper
```

Windows：`.\deploy\deploy.ps1 -Action up -Mode real -NoBuild`；real 拉取：`.\deploy\deploy.ps1 -Action pull -Mode real`

real 模式使用 `DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 写入共享资产只读卷，默认是
`docker.io/library/busybox@sha256:03ba26f2d749e8791ca5907276dbe832bb0c0be05ad2360293037db3088a4ab6`。
该值只能覆盖为 immutable digest；启动和拉取路径会显式预拉，失败即停止部署。fake 模式不使用 helper。

完整说明：**[`docs/ONE_CLICK_DEPLOYMENT.md`](../docs/ONE_CLICK_DEPLOYMENT.md)**  
根目录快速入口：[`README.md`](../README.md)  
运行时镜像发布：[`docs/RELEASE_RUNTIME_IMAGES.md`](../docs/RELEASE_RUNTIME_IMAGES.md)

## 文件索引

| 路径 | 说明 |
|------|------|
| `deploy.sh` / `deploy.ps1` | 一键 up/down/status/logs/pull |
| `docker-compose.prod.yml` | 生产栈（PG、Silo、scheduler、web、admission、backup） |
| `docker-compose.real.yml` | real：挂载 docker.sock |
| `docker-compose.yml` | 仅本地 Postgres（`pnpm db:up`） |
| `docker-compose.online.yml` | 空兼容层，勿依赖 |
| `Dockerfile.*` | 平台服务与 Agent 运行时 |
| `runtime-image-registry.json` | 官方 Agent 镜像清单（Release 回写） |
| `.env.example` | 环境变量模板（勿提交真实 `.env` / `master.key`） |
| `pull-runtime-images.sh` | 批量 pull Agent 镜像 |
| `prepare-runtime-images.*` | 本机 detect / 可选 adopt |

行为以脚本与 Compose 为准；文档漂移时改文档，不改脚本语义迁就旧文。
