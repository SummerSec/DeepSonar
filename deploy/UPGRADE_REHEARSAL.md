# 隔离 Compose 升级演练（#740）

> 状态：测试入口与验收边界
> 同步日期：2026-10-21

演练使用真实 PostgreSQL、Scheduler、Web 和 ImageAdmission 容器，以及两个源码提交构建的不同不可变镜像。Scheduler 使用 `AGENT_MODE=fake`、文件 blob 存储；不连接模型、OpenSandbox 或真实部署。它验证宿主升级状态机与实际 Compose/数据库/API 的组合，不代替真实沙箱、多架构生产部署或 Release 发布验收。

P1 的跨 schema 重建、同目标中断续做、多节点编排与版本隔离已接线；已执行场景与剩余故障矩阵分别记录如下；P2 才是签名和无人值守补丁更新，P3 Web 发起为可选。

## 镜像准备

使用两个独立干净源码目录，以各自 frozen lockfile 安装依赖并编译。历史同 schema 入口要求两份源码 schema 相同；下文维护入口要求真实旧基线与较新的目标基线，不能只改 schema_meta 冒充重建。优先用各自生产 Dockerfile 构建；网络不可用时可用 [测试产物 Dockerfile](fixtures/platform-upgrade/Dockerfile.artifacts) 打包已编译的真实应用和锁定依赖，必须把这种差异写入证据，不能称为生产镜像构建通过。

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

## 历史同 schema 入口与隔离

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

## 新维护路径演练（进行中，尚未完成最终验收）

新入口运行真实 Compose/PostgreSQL/Scheduler/Web/ImageAdmission，验证数据库身份隔离、候选重建和激活边界。它与上面的历史同 schema 证据分开；旧六场景通过不能推定新路径通过。

```bash
node deploy/platform-upgrade-maintenance.integration.mjs \
  --config /path/to/maintenance-refs.json \
  --output /path/to/maintenance-evidence
```

配置需包含 `registry`（loopback）、`postgresImage`、`oldVersion`、`newVersion`、`oldSchema`、`newSchema`，以及 `versions` 按版本映射的 scheduler/web/image-admission 真实 digest。`oldSchema` 必须来自真实旧镜像自行初始化的基线；`newSchema` 必须取目标源码/镜像的真实值，不能把临时集成编号当发布编号。新旧各服务须不同 digest。`knowledge-background-fence` 专门验证知识基线 61 → 62：其他基线默认记录 `not_run` / `not_applicable`，显式选中不支持组合时在创建容器前报错，不伪造知识表。旧配置需要 #758 重置时显式填写 `resetRoleIdentity: true`；演练先验证未选择时拒绝，再验证相应计划审批。不能默认用维护授权代替此选择。

脚本使用随机 `pr747-maint-*` 隔离项目与卷，生成私有证据，结束时只清理本项目。它只消费准备好的镜像，不构建/推送公共版本。可选 `scenarios` 是明确的场景子集；未选场景记录 `not_run`，不能将子集称为完整通过。生产 Dockerfile 与离线产物打包的区别仍须记录。

当前脚本包含只读 plan/审批、preparing HTTP 拒绝与后台停写、旧角色持有会话清退、成功激活、Scheduler/Web 故障后回滚及显式恢复、backup/candidate/rebuild/configurePreparing/activate 后真实 SIGKILL 续做，以及 Job/effect/scan 排空阻断。结果以本次输出 `summary.json` 和各场景证据为准；本段不声明这些场景已经跑完。受管 SSH 多节点成功场景已有下述证据；连续代协议已有下述受限证据；不同源码版本的连续升级及完整恢复矩阵仍需对应真实环境证据，不能由本地场景或 mock 替代。

单元及独立数据库门禁已接 `pnpm ci:unit:platform-upgrade-maintenance`、`pnpm ci:unit:platform-upgrade-preflight`、`pnpm ci:integration:platform-upgrade`；这不意味着上述 Compose 演练默认在 CI 运行。每次修改代码/镜像后，重新记录该最终提交的已通过、失败、未运行和清理状态。

## 已执行维护路径证据（2026-10-21）

隔离测试的真实旧基线 59 → 集成基线 61 已完成单机 `success-preparing` 与受管 SSH `multinode-success`，两者均 `passed` 且 `cleanedUp: true`。运行报告分别为 `maintenance-canonical/summary.json` 与 `maintenance-remaining/summary.json`（本次本地证据目录 `/workspace/740-artifacts`）。单机确认 preparing HTTP 503 后激活；多节点运行使用源码 `8e12c588` 的测试入口，经过真实 loopback SSH 操作独立 control/worker Compose 项目，核验控制面 preparing/ready、数据库 schema/generation/phase、worker 当前代准入，以及旧 generation 和持原 node token 伪报公开新 generation 的领取拒绝。多节点的 OpenSandbox 仅为最小健康服务，未执行真实沙箱 Job。

多节点旧测试镜像没有内置 worker 脚本，因此配置显式使用 `oldWorkerSourceRevision=a7f7e1eab27103037814a2742bba2cd108d2593f`，提取该历史脚本并记录 SHA-256 `f429c80fec450f313b3f9081284eed70b3b94935d2bc96910b5f91161b56a5e6`；没有用当前脚本冒充旧 worker。旧来源和新镜像 digest 由运行配置及私有证据保存。早期多节点运行在激活后因夹具误读 active health 的 generation 字段失败；修正为数据库核验后，上述独立重跑通过，不能把早期失败报告改记通过。

`maintenance-remaining/summary.json` 的 `success-preparing` 后续也已通过并清理：第一代激活后，在同一 fixture 以相同镜像 digest、测试版本 `0.0.7` 执行第二代 61 → 61，真实停止 Web 触发回滚，验证安全暂停与显式 `resumeRollback`、持久维护身份、新 rollback role/generation、active 且 claims 恢复、旧源角色仍 NOLOGIN。这证明连续代协议与支持维护契约的源代恢复，不是不同源码版本的连续升级。

这些是明确的场景子集，不代表完整矩阵通过。本轮选定中断/排空矩阵的后续结果见下方 UTC 快照；最终合入基线仍必须重新构建并演练。#756 的临时本地提交 `6f61fff8577c0a0701d93504b97b6096c927d267` 已用实际 #756 提交 `a01eb394` 的 schema 61 执行 custom `pg_dump` → 私有文件 SHA-256/TOC 校验 → template0 候选 `pg_restore`，恢复后 plan hash 与源库一致，再实际重建到 62，知识、receipt、偏好及历史 Job 保留；独立传输测试 1/1、相关回归 13/13 与类型检查通过，数据库/备份已清理。此证据取代早期 TEMPLATE 克隆和手工 CHECK 重解析的传输限制，**不是 Compose 验收，也不是已发布基线**；最终编号以 [`schema-version.ts`](../apps/scheduler/src/schema-version.ts) 为准。以上历史运行尚未包含 Windows 后端；当前原生后端已经实现，验收状态独立记录，Linux 上的 PowerShell 函数测试不证明 Windows 原生升级通过。

新增密钥内容/密文认证和 credential-first 解析属于后续源码增强；上述旧镜像 Compose 结果不覆盖这些检查。对应新镜像预检证据见下方 UTC 快照，不能由既有旧镜像成功场景推定通过。

## 验收快照：截至 2026-10-21 05:19:07 UTC

本轮 `maintenance-final-boundaries/summary.json` 记录选定 **9/9 passed、0 failed，全部 cleanedUp=true**，结束时间 `2026-10-21T05:19:07.774Z`。与上述 `8e12c588` 历史成功/多节点证据分开：宿主提交为 `772d907564d68a64979cfe06c3361524544b1fd6`，目标镜像由 `59d256c689b14bc7d636043a3bea134f3e07a27b` 编译，两提交仅相差三个测试夹具/入口文件，生产代码等价。`maintenance-build/final-boundaries-provenance.json` 记录宿主文件 hash；`maintenance-build/final-image-provenance.json` 核对实际镜像内 13 个关键文件与编译工作区 hash 全部一致。

目标 Scheduler digest 为 `sha256:fcdf646bfe3ee4a7fb9e3114ffa06a73a408a1f494e8d6d8f62878a9a8aa7f17`，Web 为 `sha256:408a1d097e21b541077002f25f7565acb2a2ac601fcbec4f8c99a8753f9fde49`，ImageAdmission 为 `sha256:df421a26bfa9deb698d7a2258cdc2b16172654632b8d0d0a39ac43b4878db4e4`；全部为隔离 loopback registry 的 amd64 测试产物镜像。真实旧基线仍为 59，目标为当前集成 61，不是最终含 #756 的 62 镜像验收。

六个真实 SIGKILL 场景为 `crash-fence`、`crash-backup`、`crash-candidate`、`crash-rebuild`、`crash-configurepreparing`、`crash-activate`：在实际 actor 边界中断后，使用原目标和 generation 续做并核验激活。三个排空场景为 `drain-job`、`drain-effect`、`drain-scan`：先确认阻断在身份隔离之前、旧服务和状态保持，再显式结算阻断项后续做激活。等待期间允许正常结算，因此不承诺所有数据库行 hash 不变。actor 日志中的 `rollbackPreparing` 名称在排空分支返回 `awaiting_drain` 回执，不代表已执行数据库回滚。

同一目标镜像的实际 dist 离线预检 **8/8** 通过，报告 `final-image-offline-preflight.json`：合法输入、错误密钥、错误 auth tag、非法 nonce、默认 CLI 不匹配、文件密钥优先、非法文件内容、跨 schema 错误密钥；均在断网/只读根文件系统运行且无秘密输出。该证据覆盖新增密钥/密文认证及持久默认组合解析，仍不证明上游认证或模型可用性。宿主提交对应 [CI](https://github.com/SummerSec/DeepSonar/actions/runs/39545204186) 与 [另一工作流](https://github.com/SummerSec/DeepSonar/actions/runs/39545204193) 合计 8/8 job 成功，无失败、取消、跳过或等待。

这是上述 UTC 时刻的证据快照，不是全部场景通过：`backup-integrity-rejection` 与 `multinode-recovery` 将单独运行，未计入这 9 项。最终 #756 合入后的唯一 schema 62 组合镜像尚待验收；该时刻 Windows 原生维护后端与 P2 尚未完成；后续实现见下方当前边界，P3 Web 发起为可选。没有执行真实部署、公共镜像发布或 Release。

## #740 当前验收边界

| 原 issue 要求 | 当前实现与证据边界 |
| --- | --- |
| 同 schema 单控制面升级与回滚 | 历史入口及历史容器证据已存在；不能覆盖新维护路径。 |
| 含 schema 重建的升级 | 只读计划、显式风险审批、身份隔离、验证备份、候选重建与源库保全已接线；真实 59 → 61 单机/多节点成功场景已通过；选定 9 项中断/排空场景已通过；最终 schema 62 组合镜像与剩余备份/多节点恢复场景待验收。 |
| 配置 preflight | 校验声明字段、引用、URL/枚举、主密钥文件身份与格式、全部已存凭据 AES-GCM 认证及 credential-first 默认选择；不认证外部服务或证明模型可用性，详见 [部署说明](README.md)。 |
| 显式角色身份重置 | #758 已接 reset flag 与审批 hash；仅清角色 CLI / 项目 model，历史快照与全局 model 保留；没有明确选择时拒绝。 |
| 多节点升级与旧节点隔离 | 已有受管 SSH 编排、版本/generation 准入和维护源代回滚恢复；真实升级与旧身份拒绝已通过；完整远程恢复矩阵仍待验收，旧源缺维护契约时不能恢复远程节点。 |
| 中断后同目标续做 | journal 固定目标与实际回执驱动；已实现，本轮 6 个真实 actor SIGKILL 场景已通过；范围与目标基线见下方快照。 |
| 失败恢复与激活边界 | [ADR 0008](../docs/architecture/adr/0008-maintenance-candidate-upgrade.md) 保留冻结源库，激活前可回源保持暂停；激活后/结果不明不切旧库，不能抹掉已接受写入。 |
| Windows 原生宿主 | 已实现 NTFS 内核锁、借用句柄、私有 DACL 与持久写入；原生 CI 正在验收，Windows Docker 完整演练未运行。Linux PowerShell 证据不能替代原生验收。 |
| Release 实际发布、P2/P3 | 已实现签名验证、默认关闭的补丁自动升级和禁用调度模板；真实 keyless 发布权限与正向链路验收待处理，详见 [P2 说明](UPGRADE_AUTOMATION.md)。P3 Web 发起为可选且未实现；发布生成/inspect 门禁不等于已发布。 |

验收进行中不等于没有实现，也不等于 #740 已完成。新增真实结果应另附最终提交和镜像 digest，不覆盖或扩大历史证据的含义。
