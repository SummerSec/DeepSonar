# 隔离 Compose 升级演练（#740）

> 状态：测试入口与验收边界
> 同步日期：2026-10-20

演练使用真实 PostgreSQL、Scheduler、Web 和 ImageAdmission 容器，以及两个源码提交构建的不同不可变镜像。Scheduler 使用 `AGENT_MODE=fake`、文件 blob 存储；不连接模型、OpenSandbox 或真实部署。它验证宿主升级状态机与实际 Compose/数据库/API 的组合，不代替真实沙箱、多架构生产部署或 Release 发布验收。

## 镜像准备

使用两个独立干净源码目录，以各自 frozen lockfile 安装依赖并编译。两份源码的 schema 必须相同。优先用各自生产 Dockerfile 构建；网络不可用时可用 [测试产物 Dockerfile](fixtures/platform-upgrade/Dockerfile.artifacts) 打包已编译的真实应用和锁定依赖，必须把这种差异写入证据，不能称为生产镜像构建通过。

测试产物 Dockerfile 需要 Node 24 的固定基础镜像、源码目录中的 `node_modules`、各 workspace 的 `dist`。对 `scheduler`、`web`、`image-admission` 分别设置 `SERVICE` 和实际 `GIT_REVISION` 构建。只推入绑定 `127.0.0.1` 的独立测试 registry；本地暂存 tag 不用于部署，配置文件必须填写 registry 返回的真实 `repo@sha256:…`。不创建 Git tag 或公共 Release。

```bash
docker build \
  -f /path/to/DeepSonar/deploy/fixtures/platform-upgrade/Dockerfile.artifacts \
  --build-arg SERVICE=scheduler \
  --build-arg GIT_REVISION=<actual-source-commit> \
  -t 127.0.0.1:55000/summersec/deepsonar-scheduler:old \
  /path/to/old-source
docker push 127.0.0.1:55000/summersec/deepsonar-scheduler:old
```

对另两个服务和新源码重复，保存构建日志、来源 SHA、manifest digest 与镜像 ID。不要仅改版本环境变量并复用同一套镜像。

## 执行与隔离

配置 JSON 包含 `registry`（仅 loopback）、`schemaVersion`、`postgresImage`，以及 `versions` 下 `0.0.1` / `0.0.2` 各三个服务的真实 digest 引用。演练版本号只是测试标识，不是已发布产品版本。

```bash
node deploy/platform-upgrade-compose.integration.mjs \
  --config /path/to/refs.json \
  --output /path/to/evidence
```

测试使用随机 `pr747-upgrade-*` Compose 项目和项目内数据卷，不复用生产固定卷名；ImageAdmission 不挂宿主 Docker socket。清理仅针对本次创建的项目，不执行全局 prune。官方清单与引用策略仅在程序调用的测试 adapter 中替换，生产 CLI 不开放任意来源或本地 registry 旁路。镜像拉取、容器 inspect、备份、API 与数据库操作均使用真实实现。

该入口需显式提供隔离镜像，不随默认 `ci.yml` 自动运行；宿主单元回归仍由 `pnpm ci:unit:deploy-ps1` 接入 CI。

验收应逐项记录成功升级、健康失败后显式回滚并保持暂停、保留暂停后的数据库写入、中断恢复、排空超时、跨 schema/remote worker 拒绝，以及清理结果。没有执行的场景写明“未运行”，不能由单元测试或脚本存在推定通过。

## 已执行证据（2026-10-20）

在独立本地 Docker/Compose 与 PostgreSQL 16 环境，以 `9ccf2837` 和 `2cd75eb4` 两份源码的真实编译产物、六个不同 digest 完成六项场景：成功升级、外部 Web 返回 503 后显式回滚、SIGKILL 中断后显式回滚、排空超时、schema 不一致拒绝、存在 remote worker 拒绝。所有场景通过并清理项目内卷。

成功场景实际将 custom dump 恢复至另一个数据库，确认 schema 59、暂停标志和预置项目记录；运行库没有被恢复覆盖。回滚场景确认备份后新增记录仍存在。排空场景用真实数据库中的 running Job 记录模拟长时任务，未运行长时模型或沙箱 Job；schema 拒绝场景修改隔离数据库的版本标记，不是一次真实跨 schema 重建；remote 场景使用隔离数据库节点记录，不是多节点升级。

生产 Dockerfile 构建曾受本环境 Alpine HTTP 403 和 npm DNS 失败阻塞；最终演练使用上述测试产物 Dockerfile。测试使用本地 registry 来源注入，不验证官方 Release 发布或第二架构。宿主回归 135 项、文档与文件体量门禁通过。早期诊断运行因过程中增加记录绑定而拒绝旧格式记录；最终六项完整运行始终使用同一版代码，二者证据分开。

## #740 尚未完成的要求

| 原 issue 要求 | 当前边界 / 后续决策 |
| --- | --- |
| 同 schema 单控制面升级与回滚 | 已实现；用本演练补真实容器证据。 |
| 含 schema 重建的升级 | 宿主程序拒绝；尚未接入新镜像 plan、风险确认与 apply。独立 rebuild 工具存在，不等于升级流程已接通。 |
| 完整配置 preflight | 目前检查 Compose、schema 与 remote worker；未覆盖目标版本全部配置契约。 |
| 多节点升级和版本不匹配拒领 | 当前拒绝 remote worker；尚无跨节点版本 fencing 与编排。 |
| 中断后同目标自动续做 | 当前保留日志并要求显式回滚；恢复领取响应不明须人工对账。 |
| 失败后自动恢复旧数据库 | [ADR 0007](../docs/architecture/adr/0007-paused-upgrade-recovery.md) 禁止覆盖暂停期间合法写入。需先决定全写入冻结、恢复点后写入处理与跨节点隔离协议。 |
| Release 平台 payload 实际发布验收 | 生成与 inspect 门禁已接线；不能未经授权触发发布来补证据。 |

上述未实现项仍是 #740 缺口，不能通过缩小文档描述宣布 issue 完成。
