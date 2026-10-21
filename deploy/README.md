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
`deepsonar-*:local-build`，不改写 `.env`。受控维护升级入口见下节。

## 受控升级与中断恢复（#740）

Shell 和 PowerShell 共用维护升级控制器 `platform-upgrade-maintenance-host.mjs`，宿主需 Node.js >=22、Docker Compose/buildx，以及进程环境中的 `DEEPSONAR_ADMIN_TOKEN`。目标必须是官方清单的不可变平台镜像和向前的稳定版本。维护路径已接入数据库身份隔离、候选库 schema 重建、同目标续做和受管 SSH 节点；**真实单机/多节点成功场景已通过，选定 9 项中断/排空场景已通过，备份损坏/多节点恢复及最终组合基线镜像待验收；证据范围见 [隔离演练](UPGRADE_REHEARSAL.md)**。默认使用 prod + real + OpenSandbox overlay；其他布局由 Node CLI 重复 `--compose-file` 明确绑定。

当前维护控制器需要 Linux `flock` 和文件/目录 `fsync` 能力，在任何数据库动作前检查。操作系统锁由宿主进程的文件描述符持有，进程崩溃后自动释放，不需手删锁文件。Windows 尚缺经过验证的原生锁后端，当前会在执行升级前明确拒绝；Linux 上的 `pwsh` 参数转发测试不能证明 Windows 原生升级可用。

```bash
./deploy/deploy.sh upgrade check --to vX.Y.Z
# 查看 plan.risks / plan.blocking_errors 后，使用返回的 plan.plan_hash
./deploy/deploy.sh upgrade apply --to vX.Y.Z --approve-plan-hash <reviewed-plan-hash>
./deploy/deploy.sh upgrade rollback
# 回滚核验后显式恢复源代业务；不要绕过控制器直接调用 claims/resume
./deploy/deploy.sh upgrade resume-rollback
```

```powershell
.\deploy\deploy.ps1 upgrade check -UpgradeVersion vX.Y.Z
.\deploy\deploy.ps1 upgrade apply -UpgradeVersion vX.Y.Z -ApprovePlanHash <reviewed-plan-hash>
.\deploy\deploy.ps1 upgrade rollback
.\deploy\deploy.ps1 upgrade resume-rollback
```

API 默认 `http://127.0.0.1:8080/api/`，保留自定义路径前缀。Shell 使用 `--api` / `--web-url`，PowerShell 使用 `-ApiUrl` / `-WebUrl`。API 仅使用 HTTPS 或本机 HTTP。升级前清除进程环境中的平台镜像/版本及数据库身份/generation 覆盖变量，避免覆盖 `.env`。token、数据库密码和主密钥不进入诊断输出或普通 journal。

`check` 拉取并核对官方 manifest/digest 后，读取数据库一致性只读配置快照和目标 Compose 环境。离线配置验证通过 stdin 交给无网络、只读且无宿主挂载的目标容器；schema 计划则使用受控 PostgreSQL 连接和只读事务。返回 `plan.plan_hash`、`plan.risks`、`plan.blocking_errors` 及 `plan.preflight` 的覆盖/未检报告。阻断在暂停前处理；普通运维暂停不应被升级覆盖。风险批准必须匹配本次固定目标与结构计划，不能复用其他计划 hash。

离线预检检查 RoleConfig、Settings、Credential 配置结构与引用，以及已声明环境变量的数值、布尔、URL 协议/主机和枚举语义。必需 `DEEPSONAR_MASTER_KEY_FILE` 由宿主提供绑定到目标容器路径的文件元数据：存在、普通文件、可读与只读挂载；缺失/不符阻断。宿主在核验权限、只读绑定与文件身份后有界读取密钥内容，通过 stdin 送入断网目标容器；与运行时共用密钥解析及 AES-GCM 解密，认证全部已存凭据（含 disabled）。文件密钥优先于内联密钥。密钥和密文不进入 argv、日志或预检持久化产物，明文不返回。预检还复用 credential-first resolver，校验当前持久默认账号/模型及 fallback 与全局角色显式 model 组合的账号选择；仅 CLI 偏好或无默认模型的项目不被强行要求唯一账号；只有数据库版本差异时仍继续这些检查，由独立 schema plan 判断重建。仍**不验证**外部 Provider/服务认证、模型实际可用性、未来 Job 的 provider/model 约束、registry 可拉取性、历史 Job 快照语义、未知环境扩展、原生 Provider 扩展字段与 Skill 源内容。`ok=true` 不是全部配置或外部依赖可用性承诺。

#758 的旧角色 CLI 来源不明或项目 model 需要单独审核。只有明确选择 Shell `--reset-role-identity` / PowerShell `-ResetRoleIdentity`，并重新 `check`、批准该选项对应的 hash，才能清除所有角色 CLI 偏好和项目级 model；全局 model、其他配置及历史 Job 快照保留。普通维护授权不包含该清除动作。源配置预检只对明确计划中的重置作内存投影；候选完成重建后必须执行未经投影的目标配置验证。没有该选项时默认拒绝旧身份，不通过 force 绕过。

```bash
./deploy/deploy.sh upgrade check --to vX.Y.Z --reset-role-identity
./deploy/deploy.sh upgrade apply --to vX.Y.Z --reset-role-identity --approve-plan-hash <reviewed-reset-plan-hash>
```

通过预检后暂停领取并排空 Job 与全部 Attempt 的未结算/未知效果，不自动杀 Job。排空超时返回 `MAINTENANCE_AWAITING_DRAIN`，保留原服务和暂停状态，结算后可对同一目标续做；此时尚未回滚或隔离旧数据库身份。独立维护身份禁止旧数据库运行角色登录并清退会话，建立备份切点；验证 gzip custom dump 后恢复到本操作的候选库，只重建候选，源库冻结保全。备份当前使用至多 512 MiB 内存缓冲。目标 preparing 阶段关闭业务入口和后台执行，全部目标服务/节点验证后才激活。激活前失败回源并保持暂停；激活已经发生或结果不明时，不回旧数据，保留当前代并对账/前向修复。

`.upgrade/` 保存私有逐步记录、身份文件和备份，已排除 Git；恢复绑定 Compose 内容、PostgreSQL 存储、Docker 目标、节点清单、目标 digest、计划和 generation。中断后同目标 `apply` 根据实际回执续做，不能移植 journal 到另一部署。硬中断遗留锁时先确认无活跃升级进程，再处理 `.upgrade/lock`。回滚后通过 `resume-rollback` 明确激活源代的新受限身份；已激活后的响应丢失只能续验当前源代，不能再次恢复旧数据。

受管多节点使用 Shell `--nodes /path/to/nodes.json` / PowerShell `-Nodes`；check、apply 和后续恢复须提供同一份绑定清单。清单须准确列出全部登记 remote worker，并显式指定受管 control 节点、SSH 主机、规范目录、Compose 项目和文件；SSH 固定主机身份，缺节点或版本/generation 不符阻断。升级与恢复均先准备/核验全部节点，再激活。旧源版本没有维护状态契约且含受管节点时，`resume-rollback` 仍保持隔离并拒绝放行；支持维护契约的源代已有多节点恢复接线，但真实 SSH 闭环尚待最终验收。

历史同 schema 演练不能覆盖本维护路径。新命令、证据要求和剩余项见 [升级演练](UPGRADE_REHEARSAL.md) 与 [ADR 0008](../docs/architecture/adr/0008-maintenance-candidate-upgrade.md)。

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
