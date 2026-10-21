# 07 部署视图

> 状态：**as-built**（#741）。描述生产 Compose、运行时网络、镜像准入、远程 Worker/设备和多副本限制；地址与凭据由部署环境提供。
> 同步日期：2026-10-21

部署事实来自 `deploy/` 下的 Compose 文件、运行时包和镜像准入代码。下图省略了环境变量值、镜像摘要和密钥，只保留拓扑和连接方向。当前 Compose 的 Scheduler、Web、image-admission 平台服务各由一个 Release 同步的完整不可变引用选择（`DEEPSONAR_SCHEDULER_IMAGE` / `DEEPSONAR_WEB_IMAGE` / `DEEPSONAR_IMAGE_ADMISSION_IMAGE=<registry>/<name>@sha256:...`，#740 P1 第 3 片），部署版本由显式 `DEEPSONAR_VERSION` 声明；`DEEPSONAR_IMAGE_TAG` 已删除，`deploy.sh` / `deploy.ps1` 对旧变量与非 digest 引用 fail closed。OpenSandbox/Worker 的基础服务同样由 Compose 使用摘要固定。Job runtime image 则必须经过准入并在快照中保存解析后的不可变 digest，二者不能混为一谈。#745 的 `platform` catalog 用于版本发现；发布路径还提供经 inspect 校验的平台 digest，宿主升级据此选择目标。原同 schema 路径保留，维护升级的身份隔离、候选库和受管节点路径已接线，不能由模块存在推定真实部署验收通过。

## 生产 Compose 拓扑

```mermaid
flowchart TB
    user[浏览器/管理客户端] --> web[web]
    web --> scheduler[scheduler]
    scheduler --> postgres[(postgres)]
    scheduler --> silo[(silo S3-compatible blob)]
    backup[backup] --> postgres
    backup --> silo
    silo_init[silo-init] --> silo
    admission[image-admission] --> postgres
    admission --> registry
    scheduler --> opensandbox[OpenSandbox overlay]
    scheduler --> gateway[managed gateway proxy / socket]
    release[Release] --> registry[(OCI Registry)]
    opensandbox --> registry
    worker[remote worker-agent] --> scheduler
    worker --> opensandbox
    scheduler --> broker[device-broker rig]
    broker --> device[受限设备]

    subgraph business[deepsonar bridge network]
        web
        scheduler
        postgres
        silo
        admission
    end
```

`docker-compose.prod.yml` 的服务是 `postgres`、`backup`、`silo`、`silo-init`、`scheduler`、`image-admission` 和 `web`；命名卷保存 PostgreSQL、Blob、Silo、备份和扫描数据。Web 仅通过 Scheduler 访问管理接口，Scheduler 连接 PostgreSQL、Silo 和网关代理；image-admission 作为独立 Worker 连接同一 PostgreSQL 写入镜像扫描/准入状态，Scheduler 不通过 HTTP 调它。OpenSandbox 由 `docker-compose.opensandbox.prod.yml` overlay 加入；其管理 API 和凭据由部署环境注入。沙箱 gateway/restricted 网络由 Scheduler 创建，不能把 Compose 网络误当成任务 egress 策略。

远程执行使用 `docker-compose.worker.yml`：Worker Agent 注册、心跳并按控制面安排运行时；Scheduler 仍拥有 Job/Attempt、token、快照和 settlement。设备使用 `docker-compose.device-broker.yml` 的独立 rig，Broker 通过短期租约和 allowlist 访问设备，Compose 不给容器 USB passthrough 或 privileged 权限。

## 镜像准入和运行时路径

```mermaid
flowchart LR
    build[Release 构建] --> registry[Registry 制品]
    scan[image-admission 扫描/签名/工具手册契约] -->|pull/inspect| registry
    scan -->|trusted + immutable digest| catalog[运行时镜像目录]
    catalog --> snapshot[Job runtime snapshot]
    snapshot --> dispatcher[Scheduler Dispatcher]
    dispatcher --> sandbox[OpenSandbox]
```

镜像准入按 `DEEPSONAR_COSIGN_*` 配置检查签名或 keyless identity/issuer、扫描结果、不可变摘要和运行时工具手册契约；未启用签名策略时，官方 catalog 可记录 `signature: skipped`，这不等于已完成签名验证。第三方镜像的 critical/secret 扫描失败会阻止信任；官方镜像的结果也会记录和告警。`image-admission` 直接拉取并检查 Registry，然后把 digest、扫描和 trust 状态写入 PostgreSQL；Scheduler 读取这些管理表，创建 Job 时把可用镜像选择冻结。Agent、Hub、导入包和任意管理文本不能提交新的 OCI 源。实现参考 [`trust-policy.ts`](../../apps/image-admission/src/trust-policy.ts)、[`cosign-verify.ts`](../../apps/image-admission/src/cosign-verify.ts) 和 [`runtime-manual-contract`](../../packages/runtime-manual-contract/src/index.ts)。

## Mobile ASC 工具供应链（#754）

`deepsonar-mobile` 的 ASC 默认实现为固定源码与 submodule 的 rust_ASC v0.1.1，以锁定依赖、`--no-default-features` 构建 CLI。`rust-asc` 与 `droidasc` 兼容入口使用同一 Rust 实现；`droidasc-python` 显式选择保留的 Python 版本，不自动回退。JADX/apktool、其他工具需要的 Python 仍保留，未引入 MCP 服务或新的执行通道。来源和调用契约见 [运行时工具链](../RUNTIME_TEST_TOOLCHAINS.md)。

镜像定义、环境 smoke 与真实 APK 验收是不同证据。amd64/arm64 构建和执行须分别留证，arm64 QEMU smoke 不代表原生验收；当前真实兼容性和性能仍需专项证据，见 [风险登记](12-risks-and-tech-debt.md)。此变更不更新已准入或运行中的镜像 digest。

## 平台版本发现与部署状态

Scheduler 在 catalog 同步路径比较当前部署版本与 registry 的 `platform` 段（没有该段时使用 `platform_version`），把最近一次结果写入 `platform_update_checks` 单例；管理员可通过只读 `GET /platform/updates` 读取最近一次检查结果，Web 只显示版本提示。该域不执行 `upgrade`、`apply` 或 `rollback`。Release workflow 从平台镜像 descriptor 生成并重新 inspect 核对各通道真实 platform digests；Compose 只接受不可变 digest 引用。部署脚本同时拒绝重复或非规范平台变量，防止校验值与 Compose 插值结果不一致。宿主升级在暂停/排空、备份校验后切换；恢复记录绑定项目、Compose 文件内容和 Docker 目标，身份变化拒绝恢复；旧同 schema 路径的回滚只恢复镜像配置并保留期间数据库写入；新维护路径保全冻结源库，仅在激活前回源且保持暂停，激活或恢复领取结果不明时拒绝自动回旧数据。目标配置离线 preflight 已接线但只覆盖声明的配置契约。跨 schema 候选重建、数据库身份隔离与同目标续做已有基础模块；受管 SSH 节点、宿主入口和显式回滚恢复已接线；真实单机/多节点成功场景已通过，完整故障矩阵仍在验收，见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)，入口见 [部署脚本](../../deploy/README.md)。相关后续和边界见 [平台自动更新后续阶段](12-risks-and-tech-debt.md)。

## 多副本和共享存储限制

PostgreSQL 是跨 Scheduler 副本的管理真相，Silo/S3 是生产 Blob 存储；副本不应依赖各自本地磁盘保存可见 Evidence。过程流的实时总线只做非权威投递。Evidence catch-up 读取当前副本的本地 `BLOB_DIR`；若请求落到没有同一文件的副本，响应必须标注 `visibility=unavailable` 并按协议关闭 WS（代码使用 4415），不能从另一副本猜测或伪造补读。

Compose 测试保证业务服务只加入 `deepsonar`、共享网关 socket 不被错误公开、DNS 不产生不明确的多宿主路径；见 [`compose-network-topology.test.ts`](../../packages/runtime-sandbox/src/compose-network-topology.test.ts)。多副本部署因此需要共享的对象存储和明确的 Worker/OpenSandbox 路由；不能把进程内 stream-bus、临时文件或本地 socket 当成跨副本一致性机制。没有共享卷时，系统应诚实显示不可见，而不是承诺强一致过程流。

设备 rig、OpenSandbox 管理端、Registry 和 Provider 都是边界外部效果。其网络地址、证书和凭据由部署环境配置，本文不写死个人域名、长期 token 或可变标签。


## 维护升级的部署边界

[ADR 0008](adr/0008-maintenance-candidate-upgrade.md) 扩展原同 schema 路径：官方目标与配置预检先于暂停，排空后以独立维护身份关闭旧数据库运行身份，验证备份并创建候选库。目标 Scheduler/ImageAdmission 的 generation、版本、运行角色和数据库 preparing/active 状态必须一致。受管节点清单记录固定 SSH 主机身份与部署路径，并与登记 worker 集合及本地部署绑定；不是任意 SSH 主机的远程执行入口。节点准备和版本验证在激活前完成。

源库保全与候选目录需要额外存储。恢复 journal 绑定 Compose 内容、Docker 目标、固定镜像、plan hash 和 generation；秘密放独立私有文件，SQL/CLI连接参数经 stdin 传递。备份切点后的业务写入只应在激活代发生；激活后失败不再自动切旧库。显式回滚恢复领取及多节点编排已接线，完整恢复矩阵仍待验收，最终运行命令以 [部署说明](../../deploy/README.md) 为准。
