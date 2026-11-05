# 运行时镜像发布（Issue #70 Slice B）

> 状态：**运维 as-built；v0.6.14 为当前补丁候选，尚未 tag/发布**。
> 同步日期：2026-11-05
>
> 2026-11-05 核对 GitHub，最近正式版与最高既有版本 tag 均为 [v0.6.13](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.13)，正式发布时间为 `2026-11-05T13:02:09Z`，tag commit 为 `71cefc0b34d3eddf771a6a39decba6fa003b6ac6`。该 tag 尚未包含 #912，承载该修复及 #916 原生 CI 准备修正的新候选为 v0.6.14，compare 为 `v0.6.13...v0.6.14`。最终 main SHA 的 Actions 与正式 Release 流水线、签名、catalog 和产物仍待验收。已知的 [Pi 完成修正阻塞 #913](https://github.com/SummerSec/DeepSonar/issues/913) 尚未修复，发布范围见 [CHANGELOG](../CHANGELOG.md)。
>
> **历史 v0.6.4 发布准备基线（2026-11-02，保留历史来源）**。准备时最近正式版为 [v0.6.2](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.2)，于 2026-10-31T09:05:38Z 正式发布，非 draft / prerelease；tag 指向包含 Web 隔离构建修复的 `347385a53f43d15a53175226528af10a692f6f9e`。[v0.6.3 的 Release](https://github.com/SummerSec/DeepSonar/actions/runs/41299685948) 失败，已有部分镜像但未完成正式发行。按用户 2026-11-02 的选择，保留其 tag 和既有镜像，改发 **v0.6.4**；Git compare 起点为 v0.6.3，成功升级基线仍为 v0.6.2（schema 65 → 67）。本轮范围沿用[原范围决定](<../AGENTS.md#豁免范围>)，不移动旧 tag 或覆盖旧镜像。这里核对发布元数据与源码关系，不重新声明附件、签名或各通道镜像已逐项复验。
>
> **历史 v0.6.0 元数据核对（2026-10-29）**。[v0.6.0](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.0) 已于 2026-10-22T06:02:52Z 正式发布（非 draft / prerelease），Release 附有 `runtime-image-registry.json`、`runtime-image-registry-v2.json`、`platform-signature-evidence.json`、`deepsonar-reverse-evidence-0.6.0.tar.gz` 和 Management Skill。本次只核对 Release 元数据及附件清单，未重新 inspect 镜像、验签或部署；附件存在不替代签名内容校验，发布完成不等于现网已经升级。下次发布仍须按本文完成目标版本的双架构、各通道 inspect、签名和验收门禁；历史正式 tag 保持不可变。
>
> Scheduler / runtime-sandbox 契约修复的**部署生效与自检**：[`RUNTIME_IMAGE_CONTRACT_DEPLOY.md`](RUNTIME_IMAGE_CONTRACT_DEPLOY.md)（#636）。

`.github/workflows/release.yml` 由 `v*` tag 触发。工作流先发布 `deepsonar-base`，再发布依赖它的 OpenHarmony、Chrome、ClickHouse 与 Mobile 专项镜像与 Reverse 原生双架构镜像，最后由一个 Release job 合并真实的 buildx manifest digest，上传 `runtime-image-registry.json` artifact，并把它与 Management Skill 一起作为 GitHub Release 附件。合并前的核心定义与 base/audit/Kali 门禁在 `.github/workflows/ci.yml`；Chrome amd64 合同冒烟在 `.github/workflows/chrome-runtime.yml`，ClickHouse amd64 合同冒烟在 `.github/workflows/clickhouse-runtime.yml`，OpenHarmony test/audit/fuzz amd64/arm64 专项冒烟在 `.github/workflows/openharmony-runtime.yml`，Mobile amd64/arm64 专项冒烟在 `.github/workflows/mobile-runtime.yml`。`deepsonar-reverse` 在 `.github/workflows/reverse-runtime.yml` 使用原生 amd64/arm64 runner 构建当前 base+reverse，执行 ELF/.so/PE REA/Ghidra、真实 `docker save` / cgroup / 取消测量和 OpenSandbox Job；release 对缓存与 fresh child 执行相同门禁。脚本已接线不等于实际运行已通过。

同一 Release job 在校验通过后，会把生成的 `deploy/runtime-image-registry.json` 与 `deploy/.env.example` 中的 `DEEPSONAR_VERSION` 及三条平台镜像 digest 引用（`DEEPSONAR_SCHEDULER_IMAGE` / `DEEPSONAR_WEB_IMAGE` / `DEEPSONAR_IMAGE_ADMISSION_IMAGE`，按本次发布的 index digest 重新 inspect 写入，#740）**提交并推送到仓库默认分支**（`chore(release): sync runtime-image-registry.json and image tag for vX.Y.Z`），用于更新内置 bundled 回退清单与部署示例版本。发布准备阶段不得手写运行镜像 digest 或提前改写 bundled 清单；v0.5.3 的 Chrome / ClickHouse 六个产品选择已知陈旧，须在新 Release 真实发布证据与最终 payload 门禁通过后由 workflow 回写纠正。仅当默认分支内容与本次发布不同时才提交；推送到默认分支不会再次触发本 workflow（触发条件只有 `v*` tag）。**回写必须通过默认分支的 required check（#865 / #877）**：默认分支要求 `ci-summary`，而**直推会被规则拒绝**——即使 `ci-summary` 已经在同一个 SHA 上通过（v0.6.7 实测：日志先出现 `ci-summary passed on 8f3479d4`，随后 `push declined due to repository rule violations`，Release 未创建，最终由人工从 bot 分支开 PR 才把清单合并进去）。因此回写不再直推，而是**走与人工合并相同的路径**：

1. 回写提交推到 `bot/sync-runtime-registry-v<version>` 分支；
2. `GITHUB_TOKEN` 推送的分支不会自动触发 workflow，显式 `gh workflow run ci.yml --ref <branch>`；
3. 轮询该 SHA 的 `ci-summary`，只有 `success` 才继续（`failure`/`cancelled`/`timed_out`/`skipped` 或 90 分钟无结论即失败，默认分支不动）；
4. 打开（或复用已存在的）回写 PR，轮询 `mergeStateStatus` 直到 `CLEAN`，再 `gh pr merge --merge`；
5. 合并后用 `compare` 校验默认分支确实包含该回写提交，然后删除 bot 分支。

失败语义：dispatch 失败、检查失败/超时、PR 无法合并（`DIRTY`/`CONFLICTING`/`BEHIND`）、合并命令失败、`compare` 未包含该提交，任何一种都**不移动默认分支**并把 bot 分支留在原地供排查；错误信息保留远端 `remote:` 行（规则拒绝的原因），不再只给退出码。

要放行的是**同一条门禁**，不是绕过它：不要为 bot 配置 ruleset bypass、不要直推、也不要用可写 PAT 跳过必需检查。

**发布按阶段可重入（#893）**：`release.yml` 的末端不再是「一个 job 里的两个不可逆动作」，而是两个独立阶段，都只消费同一份冻结载荷：`release-publish`（校验签名载荷 → 建 Release，Release 已存在则不改写）与 `release-writeback`（同步 bundled 清单与 `.env.example`，内容一致则早退）。写回阶段带 `continue-on-error`：失败会以失败 job 的形式可见，但**不会扣住已经可以发布的 Release**；反之 Release 已存在也不会阻塞写回。两段实现分别在 `agent-harness/release-publish.sh` 与 `agent-harness/release-writeback.sh`，被发布流程与 `.github/workflows/release-resume.yml` 共用。当某一阶段失败时（规则拒绝、缺权限、bot PR 待批准、runner 抖动），用 **Release resume** 手动触发：输入版本、`source_run_id` 与要重跑的阶段，它会从原运行下载 `platform-release-payload` 与 `platform-signature-evidence` 后只重跑该阶段，**不重建镜像**；两个阶段都幂等，重跑不会产生额外提交或覆盖既有 Release。 前置条件：仓库必须允许 GitHub Actions 创建 PR（Settings → Actions → General → “Allow GitHub Actions to create and approve pull requests”，API 为 `repos/<owner>/<repo>/actions/permissions/workflow` 的 `can_approve_pull_request_reviews=true`）。回写脚本在动任何分支之前先检查该开关，关闭时立即以 `WRITEBACK_PR_PERMISSION_MISSING` 单条可执行提示失败，而不是先等满一轮门禁再报 GraphQL 错误（v0.6.8 实测：22 分钟后才失败）。bot 分支由 workflow 独占且可丢弃，因此用 `--force-with-lease` 覆盖上一次尝试留下的同名分支，避免非快进推送把发布卡死。

**一次人工批准是这条路径的固有成本（#887）**：由 `GITHUB_TOKEN` 创建的 PR 被 GitHub 当作外部贡献者，它的 workflow 运行不会自动开始，而是**等待维护者在 Actions 里批准**；等待期间 PR 的检查汇总为空，回写若按「检查未结论」继续轮询就会白等到预算耗尽（v0.6.10 实测：08:37 建 PR，gate 停在待批准约一小时，回写在 10:08 以 `WRITEBACK_CHECK_TIMEOUT` 失败）。现在回写会识别这种运行（`status=waiting` 或 `conclusion=action_required`）并**立即**以 `WRITEBACK_RUN_AWAITING_APPROVAL` 失败，消息里给出该 run 与 PR 编号、以及「在 Actions 里批准后重跑本次 release job」。

这是选择「不放宽必需检查」的代价：没有给 bot 配 ruleset bypass、也没有用可写 PAT 跳过门禁，所以每次发版需要维护者点一次批准。批准后 PR 变为 `CLEAN`，回写会自动合并并创建 Release；若回写已因等待超时退出，重跑该 release job 即可（清单已落地时回写会因无差异而早退，直接进入创建 Release）。v0.6.6 因直推被拒（`Required status check "ci-summary" is expected`）而没产出 Release，v0.6.7 因“直推即使检查已通过仍被拒”而没产出 Release，本条据此把回写改为 PR 合并。

## 控制面镜像平台矩阵（#598）

运行时镜像（base / audit / kali / 专项）此前已按 `linux/amd64,linux/arm64` 发布。自本变更起，**控制面**与再发布依赖同样走双架构：

| 镜像 | platforms |
| --- | --- |
| `deepsonar-scheduler` / `deepsonar-web` / `deepsonar-image-admission` | `linux/amd64,linux/arm64` |
| `deepsonar-assets-helper` / `deepsonar-silo` | `linux/amd64,linux/arm64`（上游 busybox / pgsty/silo digest 已含 arm64） |

控制面 Dockerfile 的 `node:24-alpine` pin 必须是含 amd64+arm64 的 OCI index；静态门禁见 `pnpm ci:unit:control-plane-platforms`（亦挂入 `pnpm ci:images`）。发布后可用 `docker buildx imagetools inspect` 验收 index 同时含两平台。

## Web 隔离构建回归

Web 生产构建使用 [`tsconfig.build.json`](../apps/web/tsconfig.build.json) 继承完整严格类型配置，仅排除测试入口；`typecheck` 保留完整 `tsconfig.json`，跨包 Plan 报告测试仍由 `ci:unit:plan-protocol` 执行。`ci:images` 同时执行实际 `deploy/Dockerfile.web` 构建与最终静态产物检查，覆盖完整仓库可通过而镜像上下文缺少 Scheduler 源码的情况；不复制 Scheduler 源码到 Web 镜像。2026-10-31 核对 v0.6.1 run `41171008148` 的 Web job `124451427235` 已因 TS2307 失败；原 tag 保留，其他镜像产出不等于正式 Release 完成。该修复已随 v0.6.2 正式发布；每个新候选仍须在最终提交上重新完成适用的发布门禁。

## Chrome Fuzz ARM64 的宿主磁盘准备

2026-10-31，[CI run 41173355695](https://github.com/SummerSec/DeepSonar/actions/runs/41173355695) 的 `chrome-fuzz-arm64-build` 在构建中失败；check-run 注释明确记录 runner 写诊断日志时 `System.IO.IOException: No space left on device`。该证据不能证明编译错误、网络协议问题或容量/SLA 上限。

CI 和 Release 的 Chrome Fuzz ARM64 cache miss 构建前调用[磁盘准备脚本](../.github/ci/prepare-hosted-runner-disk.mjs)：只在 GitHub-hosted runner 删除明确列出的未使用 SDK，并打印前后磁盘状态。脚本保护工作区、runner 和 Docker/containerd 数据，清理失败直接失败；本地与 self-hosted 禁止实际删除，显式 dry-run 只打印诊断。安全测试通过 mock 命令执行，不删除宿主文件。此准备不改变 fingerprint、镜像产物或原生 build/smoke 门禁。2026-10-31，[后续 run 41184204236](https://github.com/SummerSec/DeepSonar/actions/runs/41184204236) 的 ARM64 构建与原生 smoke 均通过；该轮整体 CI 因独立的资格报告回归失败，不能写成全量通过。此证据不构成容量/SLA 保证。

## 发布前门禁

生产变更记录维护在根目录 [CHANGELOG.md](../CHANGELOG.md)。产品版本的唯一来源是不可变的 `vX.Y.Z` Git tag；根目录和第一方 workspace 的私有 package 版本是内部元数据，不参与 Release 版本解析。每个正式版本必须有一个非空、日期有效的 changelog 区段，并带有精确匹配 `vPrevious...vCurrent` 的 compare link。

发布前在干净的合并提交上验收。按本轮用户要求，下面的测试、构建及校验全部只在 GitHub Actions 执行；`ci` 的 docs-freshness job 同时调用既有 changelog 校验器回归，并验证实际最新版本区段及其前一版本 compare link。打 tag 前须再次核对前一版本与 Release workflow 实际选择的**除目标版本外最高 Git `v*` tag**一致，而不是最近成功的 GitHub Release；失败发布留下的 tag 也参与比较。2026-11-05 当前候选为 v0.6.14，预期 compare 为 `v0.6.13...v0.6.14`，最近正式升级基线为 v0.6.13，schema 版本只按源码核对；若候选或最高 tag 已变化，重新核对而不沿用此准备值：

```bash
pnpm ci:unit:docs-freshness
pnpm ci:unit:changelog
# 本轮真实 changelog 区段（仅在 Actions 执行）：
node agent-harness/validate-changelog.mjs --file CHANGELOG.md --version 0.6.14 --previous-version 0.6.13 --tag v0.6.14
pnpm typecheck
pnpm build
pnpm ci:images
```

先按 `AGENTS.md` 的发版硬门完成人工 as-built 文档核对，再等待最终 `main` 提交的 CI 通过，才创建并推送新的不可变 `vX.Y.Z` tag。`ci:unit:changelog` 验证校验器本身的用例，上面的 `validate-changelog.mjs` 命令才验证真实待发布区段；每次发布需改为本次目标和实际前一 tag。`ci.yml` 的 `push@main` 会跳过纯文档提交，因此文档版 release-prep 合入后，应在 Actions 手动触发 `ci` 的 `workflow_dispatch` 并核对运行 SHA 为最终待打 tag 的提交。纯文档 PR 始终执行文档保鲜与聚合门，只有明确白名单内的文本变更可跳过重活；手动 `workflow_dispatch` 强制全量。专项 workflow 是否触发由各自 paths 决定。运行镜像输入及 `BASE_IMAGE` digest 未变且 immutable `src-*` cache 可用时，核心 CI 可复用既有构建，仍执行规定的真实冒烟；不要为缩短发版时间改动 fingerprint 或跳过门禁。Release workflow 会在镜像构建前再次校验 tag、目标 changelog 区段和 compare link；校验失败时不会构建或发布镜像。工作流将经过校验的精确 changelog 区段写入 GitHub Release，同时保留许可证声明、runtime registry、Management Skill 附件和 GitHub 生成的 compare notes。

**v0.5.5 发布结果**（v0.5.4 tag 不移动；其 Release 中 `reverse-images` 曾把 GHCR index 推送成功但 ACR / Docker Hub `imagetools create` 失败；#732 为 `publish-reverse-runtime.mjs` 补上 HTTP/1.1、每次 15 分钟、最多 3 次重试）：v0.5.5 tag 触发的 Release 已全部成功——真实不可变 digest、`reverse.json`、三通道 inspect、证据附件 `deepsonar-reverse-evidence-0.5.5.tar.gz`，并由 workflow 把 `deepsonar-reverse` `0.5.5` 回写 `deploy/runtime-image-registry.json`（此前 `versions: []`）。后续发版仍不得用空 descriptor、手写 digest、复制其他产品证据或从必需产品集合静默删除 reverse 来绕过阻塞。

**历史 v0.5.6 发版准备记录**（2026-10-15）：本版为补丁版，内容为 #736（Anthropic Messages 推理探测与网关认证头携带受治理的 Claude CLI 客户端指纹）、#730（部署就绪门禁、运行镜像恢复统计与远端对账边界）、#734（失败发布同名 tag 恢复守则）以及 #718 的 v0.5.5 准入证据绑定与文档收口。上述准备项本身不修改数据库 schema；后续主线已由 #740 的平台级暂停领取与版本发现变更更新 schema，当前版本以 [`schema-version.ts`](../apps/scheduler/src/schema-version.ts) 为准，发布验收须覆盖最终合并内容。上述准备项不改变运行镜像输入与 fingerprint，命中不可变 `src-*` 缓存时复用既有构建并仍执行规定的原生冒烟；控制面镜像因 Scheduler 源码变更随本次发布重建。剩余硬门与上一版相同：`v0.5.6` tag 触发的 Release 必须实际成功，产出真实不可变 digest、每个配置通道的 descriptor / inspect 证据、必需产品集合完整的 catalog 并通过最终双平台 payload 门禁，再由 workflow 回写 bundled registry 与部署 tag；tag 存在、CI 通过或部分镜像推送成功都不等于发布完成。

## 可选发布凭据

Docker Hub 运行时镜像使用以下 GitHub Actions Secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

中国区阿里云 ACR 同步必须四项同时配置，否则工作流会在 Step Summary 明确说明并只发布 GHCR/Docker Hub：

- `ALIYUN_REGISTRY`：完整 registry host，例如 `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com`
- `ALIYUN_REGISTRY_NAMESPACE`
- `ALIYUN_REGISTRY_USERNAME`
- `ALIYUN_REGISTRY_PASSWORD`

ACR、GHCR 与 Docker Hub 标签在同一次 buildx 多平台发布中生成。清单保留每个已发布目的地的不可变引用和 inspect 证据；没有配置的可选目的地明确记录 unavailable，不会用 ACR/GHCR 优先级猜测替代。工作流不会硬编码任何凭据。

ACR 仓库需要设为公开或启用匿名拉取，才能供中国区部署直接使用。公网访问请按最小范围配置，仅开放必要仓库和拉取权限；不要为发布账号授予超出镜像推送所需范围的权限。

## 清单与校验

清单由 `agent-harness/generate-runtime-image-registry.mjs` 根据各镜像构建输出或经证明可复用的真实 digest 生成，必需产品集合包含 Base、Audit、Kali Minimal、OpenHarmony Test、OpenHarmony Audit、OpenHarmony Fuzz、Chrome Audit、Chrome Test、Chrome Fuzz、ClickHouse Audit、ClickHouse Test、ClickHouse Fuzz、Mobile 与 Reverse 十四项。尚未首发的产品在源码内置 bundled 清单中保持 `versions: []`；`deepsonar-reverse` 已在 v0.5.5 由 Release 回写 `0.5.5` + canonical digest。只有 Release 对两个平台完成真实构建 / 缓存复用验收、发布和 inspect 后，生成器才会写入版本与 digest。空版本条目不能代替 Release 要求的真实 descriptor。

**一版本多平台**：v2 多架构发布时，每条 canonical 版本记录的 `platforms` 同时列出 `linux/amd64` / `linux/arm64`，`digest` 是共享 manifest/index digest，`size_bytes` 为目标平台压缩层大小上限；不能按架构拆成两条同版本 alias。生成器可保留既有历史版本数组，最终 payload 门禁按 Scheduler 的通道 / 平台 latest-version 排序核对实际选中的版本，见下文。旧 v1 清单仍按一平台一版本解析（当前代码残留的兼容路径，非新发布契约）；Scheduler 消费平台全局 `runtime_registry_channel` 对应的 v2 不可变引用，缺少选定通道引用时 fail closed。

**版本轴拆开（#417）**：`vX.Y.Z` 是平台 Release 版本（changelog、`DEEPSONAR_VERSION`、scheduler/web/image-admission；部署按 digest 引用平台镜像，`DEEPSONAR_IMAGE_TAG` 已删除）。运行时产品的 `versions[].version` 按已证明的镜像内容决定：只有 catalog 已有本轮精确 canonical digest，或其不可变 index 已证明包含与本轮验收完全相同的 runnable 平台 manifest 集合，才可复用该行的 version + digest。summary 写 `image build unchanged; version kept`，且不对 ACR/GHCR/Docker Hub 打新的平台 version tag。source-cache / fingerprint 命中本身不能证明任意 catalog 行可复用；不得直接取 `versions[0]`。缓存 payload 无匹配 catalog 行时仍发布 version tag，并由 `record-runtime-image-digest.mjs` 对已发布通道做真实 inspect 补记一行，不编造 `registry_evidence`。平台清单同时写出 `platform_version` 与 `min_runtime_image`（默认下限来自 `agent-harness/min-runtime-image.json`）。可选 `platform` 段（#740 P1 第 2 片）携带结构化升级信息：`version` / `commit_sha` / DeepSonar `schema_version`，以及 scheduler / web / image-admission 的 index digest 与 `linux/amd64` / `linux/arm64` child digest（GHCR / ACR / Docker Hub 通道证据与运行镜像 v2 同形）。Scheduler 在清单同步路径上做只读版本发现并写入 `platform_update_checks`；缺省 `platform` 时仍可用 `platform_version` 比较。Release workflow 从三类平台镜像 descriptor 生成 `platform` 段，要求发布 commit、schema、双架构 child digest 和各通道证据完整；最终 payload 门禁重新 inspect 每个通道并核对 index / child digest，缺失或不一致立即失败。回写部署示例前校验四个版本 / 镜像变量恰好各一行，再按所选通道写不可变引用。digest Compose 契约已落地（#740 P1 第 3 片：Compose 每个平台镜像一个完整 digest 引用变量，`/health.version` 只认 `DEEPSONAR_VERSION`）；人工执行的 `deploy.sh upgrade` 与 PowerShell 入口见 [部署脚本](../deploy/README.md)。维护控制器已实现跨 schema 计划、显式审批、数据库身份隔离、候选库重建及安全恢复；实际演练范围见 [升级演练](../deploy/UPGRADE_REHEARSAL.md)。这不授权无人值守跨 schema 升级；P2 自动策略仅允许同 schema 的补丁版本。

**Chrome / ClickHouse 双架构缓存复用（v0.5.4 修正）**：Audit、Test、Fuzz 在 amd64 与 arm64 同时命中 source-cache 后，先将本轮已验收的每架构 wrapper/index 解析为该目标平台唯一的 runnable manifest digest。用候选 catalog 的不可变 digest inspect runnable descriptors，再比较精确的 `linux/amd64` / `linux/arm64` → manifest digest 映射；attestation descriptor 不计入 payload，也不能充当 runnable manifest。只有平台集合和每个平台 digest 完全相同才复用 catalog canonical digest。缺失、重复、歧义的 runnable descriptor，或解析 / inspect 错误均 fail closed；不同 payload / 无匹配 catalog 行只作为复用未命中，改用本轮已测试缓存子镜像重新组装 index，再发布所有配置通道并收集新 inspect 证据。最后选入 catalog 的 canonical digest 必须包含本轮实际测试的两个子 manifest；不要求无关 wrapper / attestation 的 index digest 相等。其他调用方按精确 canonical digest 的复用方式仍有效。

**运行时版本轴独立于平台版本（#864 评审结论，含 floor 反例）**：`versions[].version` 表示「哪一次发布首次产出该 digest」，不随平台版本变化——内容未变时保留原 `version` + `digest`（summary 写 `image build unchanged; version kept`）。

**为什么不能在发布时把既有记录重标成平台版本**：该字段不只是展示，它参与 Scheduler 的 `(runtime_image_id,digest)` 写入，也参与最低运行镜像下限判断（`isRuntimeImageBelowPlatformMin`）。反例：同一份内容标为 `0.6.4`、当下限是 `0.6.5` 时本应被判为过低；若发布时把它重标为 `0.6.6`，它就会满足下限——而内容从未改变、也从未按新版本重新构建。也就是说「重标目标等于平台版本，所以不会超过平台」并不能证明原内容达到了最低版本。因此下限判断要真实有效，版本标签就必须来自构建事实。

配套的规范改动：`agent-harness/test-reverse-runtime.mjs` 与 `apps/scheduler/src/reverse-runtime-project-opt-in.test.ts` 里「reverse 版本必须等于 `platform_version`」的断言已移除，改为按**产物身份**校验，并按与生产一致的方式选择记录（`selectLatestRuntimeImagePullItems` 的语义：同平台下取最新版本标签）：

- reverse 至少发布一条版本，且最新标签不低于 `min_runtime_image.version`；
- digest 为 canonical `sha256:<64 hex>`，平台集合恰为 `linux/amd64,linux/arm64`；
- `image_ref` / `registry_refs` / `registry_evidence` 三个通道齐备，`inspect_digest` 与 digest 一致。

迁移：既有清单不做重标，`deepsonar-reverse` 回到真实构建版本 `0.6.4`（digest `62adab41…` 未变）。若某次平台发布确实要求更晚的 reverse，就必须真实重建 / 重新发布 reverse 并产出新 digest，而不是改标签。

**最终清单 payload 门禁**：`agent-harness/check-runtime-catalog-platforms.mjs` 必须收到 Chrome / ClickHouse Audit、Test、Fuzz 及 Reverse 七个产品 × amd64 / arm64 的全部 14 份 native-smoke artifact。它从这些已测试 wrapper 重新解析 runnable manifest，并按 Scheduler 相同的 latest-version 排序为每个通道 / 平台解析实际 selected version；每个可用通道内的 amd64 / arm64 必须选中同一条 canonical 双平台记录，拆成不同平台版本的选择明确 fail closed，不能因任意历史行匹配就冒充 Scheduler 实际选择。随后重新 inspect 生成清单中 GHCR 及每个 available 的 Docker Hub / ACR 所选不可变 index，逐个平台核对实际子 manifest digest；不信任 cache-hit 标志、version 标签或 descriptor 自报的平台摘要。该门禁只校验目录的 bulk/latest 选择，不改写或覆盖既有 Job 冻结 / 钉死的 digest。未选中的历史行可以保留；缺失或歧义的选择、任一可用通道选到陈旧 payload、artifact 缺件 / 重复、解析 / inspect 失败均 fail closed。最终 Release job 使用既有凭据在本 job 登录 GHCR 及已配置的 Docker Hub / ACR，不依赖其他 job 的登录状态。此门禁在生成清单后、Release asset 上传及 bundled / 部署 tag 回写前执行；仅本次 catalog 修正不改运行镜像输入与 fingerprint，也不跳过 native smoke；v0.5.4 包含的其他变更（包括 #718 共享手册输入）仍可能触发重建。

**真实 digest 来自构建输出或经不可变 registry inspect 证明可复用的 catalog 内容**，不会手写伪造。发布成功后：

1. GitHub Release 附件（Scheduler 优先拉取的 remote 目录）  
2. 仓库内 `deploy/runtime-image-registry.json`（bundled 回退，由 workflow 自动回写默认分支）

Scheduler 定时读取官方 GitHub Release 的最新清单；失败时回退仓库内置清单。新正式版本成为默认 promoted 版本，旧版本只保留给历史 Job 快照追溯（#691：项目钉版本已移除）。新建 Job 跟随平台 channel 最新 trusted 并冻结 digest。

GHCR 包说明来自 OCI 元数据。Dockerfile 为单平台 manifest 写入 `org.opencontainers.image.title`、`description`、`source` 与 `licenses`；Release workflow 同时把这些值写入多架构 image index annotation。项目源码使用 `LicenseRef-DeepSonar-Proprietary`，但镜像内第三方组件仍分别适用其自身许可证，详见根目录 `THIRD_PARTY_NOTICES.md` 与随镜像生成的组件清单。修改说明后必须重新发布镜像，既有 digest 的包页面不会被原地改写。

以下一致性与差异校验也遵守本轮仅 GitHub Actions 执行的约定：

```bash
node agent-harness/check-runtime-image-consistency.mjs
git diff --check
```

## Slice B release contract

The [release workflow](../.github/workflows/release.yml) is the source of truth
for the v2 catalog. Each publisher defines the order of publishing to configured
destinations and copying its canonical index; there is no universal ACR-first
sequence. ACR and Docker Hub are optional; missing credentials produce an
explicit unavailable channel record rather than a guessed reference.
The official ACR endpoint is fixed to
`crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec`; a
different host/namespace is rejected by the server-owned catalog policy.

Every destination that is published is checked with
`docker buildx imagetools inspect`. Its registry-reported `Digest:` must equal
the build canonical digest before `record-runtime-image-digest.mjs` writes a
descriptor. Copy operations retry with bounded exponential backoff. If any
configured channel exhausts retries, the workflow sets
`CHANNEL_PUBLISH_FAILED`; the recorder fails closed and the release job cannot
generate a partial catalog. The old raw-JSON hash shortcut is not valid OCI
evidence.

Descriptors contain `registry_records` (availability, immutable ref,
`inspect_digest`, provenance/reason) and are merged into one
`deepsonar.registry/v2` version per product with all target platforms. The
descriptor must carry all three channel outcomes; generated v2
`registry_evidence` contains exactly `github`, `dockerhub`, and `aliyun-acr`,
with GitHub available and inspected for the public release baseline. Scheduler
adds `fallback`, `error`, and `checked_at` after parsing; those fields are not
accepted as upload-controlled catalog input.
Available provenance is fixed to `build-push+inspect` for GitHub and
`cross-registry-copy+inspect` for Docker Hub/ACR; unavailable reasons are
bounded single-line tokens.
release uploads `runtime-image-registry-v2.json` and synchronizes the bundled
v2 fallback. Scheduler Slice C stores a platform-global selected channel
(`github`, `dockerhub`, or `aliyun-acr`) and consumes only that channel's
immutable reference for apply, pull, and Job snapshots. If an internal
channel-only item has no reference for the selected channel, it is skipped or
fails closed; the Scheduler never substitutes another channel or rewrites an
existing Job snapshot.

## Chrome specialist release contract

The Chrome source pins are kept in `deploy/chrome-runtime-sources.json` and are
consumed by the three Chrome Dockerfiles and the consistency gate:

- Chromium `151.0.7922.71-1~deb12u1` is installed from Debian bookworm-security
  snapshot packages. The amd64 and arm64 package URLs, sizes, and SHA-256
  values are pinned separately, including the exact-version `chromium-common`
  package closure; the package is never downloaded from a moving `stable` URL.
- `playwright-core@1.62.1` is installed with its npm integrity value. The test
  smoke launches the image's governed Chromium wrapper and connects through
  the CDP endpoint with Playwright; it is not a host-browser smoke.
- Chrome Fuzz 固定 checkout depot_tools 提交，关闭自动更新，并在 gclient 前运行
  `ensure_bootstrap`（生成 `python3_bin_reldir.txt`），避免浅克隆未初始化或漂移到
  与 Debian Git 2.39 不兼容的新 gclient
  `921e61b35fbc5e97b14250a118e363ec05078089` 与 V8 提交
  `792d9716fea48312ad7ce4413c538e00628b1d50`（V8 `15.1.206.10`，来自 Chromium
  `151.0.7922.71`），然后针对目标架构运行 `autoninja d8
  v8_json_libfuzzer`。amd64 按正常目标架构构建；arm64 在 x86 runner 上使用固定
  Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装。Chromium 包版本与
  V8 源码版本分别记录，因为它们是独立固定的输入。`chrome-fuzz-env.sh` 与
  `chrome-fuzz-smoke.sh` 拒绝缺失或非 V8 二进制，并使用 `-runs=1` 执行真实 V8
  libFuzzer 目标；arm64 的真实 smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，
  原生 smoke 通过前不得组装发布 index。Release 必须证明 `linux/amd64` 与
  `linux/arm64` 均生成真实目标；若 arm64 源码构建不能生成实际 d8，发布不完整，
  不得向 registry 写入 digest。

The Chrome images are all project opt-in and have no global role defaults.
`chrome-runtime.yml` builds amd64 and runs the contract/smoke harness when its
Dockerfiles, descriptors/scripts, `.dockerignore`, shared fingerprint/cache
mechanism, or workflow changes. `release.yml` is the authoritative
multi-architecture gate：Chrome Fuzz amd64 按正常目标架构构建，arm64 在 x86 runner
上使用固定 Chromium Clang 与 arm64 sysroot 交叉构建，QEMU 仅用于组装；arm64 的
真实 d8/libFuzzer smoke 在 `ubuntu-24.04-arm` 原生 runner 执行，只有原生 smoke
通过后才允许 `chrome-images` 组装两个子 digest 的发布 index。它使用不可变 base
digest，发布 GHCR 以及配置的 ACR、Docker Hub 标签，检查每个目标，并且只上传
`record-runtime-image-digest.mjs` 接受的记录。

## ClickHouse specialist release contract

The ClickHouse source pins are kept in `deploy/clickhouse-runtime-sources.json`
and are consumed by the Test/Fuzz Dockerfiles and the consistency gate:

- Official unmodified LTS `clickhouse-common-static` `v26.3.28.5` is installed
  from ClickHouse GitHub Releases. The amd64 and arm64 tarball URLs, sizes, and
  SHA-256 values are pinned separately; the installer rejects any URL that is
  not `https://github.com/ClickHouse/ClickHouse/releases/download/*`.
- ClickHouse Test ships `clickhouse-local` plus a governed
  `clickhouse-server.sh` that listens only on `127.0.0.1` and keeps `--path`
  under `/workspace/*`. HTTP smoke hits `/ping` and `SELECT 40 + 2`.
- ClickHouse Fuzz installs the same official binary plus Clang-16 /
  compiler-rt / libFuzzer / AFL++. It does **not** compile ClickHouse from
  source. `clickhouse-fuzz-env.sh` and `clickhouse-fuzz-smoke.sh` refuse a
  missing or unofficial binary; there is no toy harness fallback.
- Audit is a C++ toolchain image (git / CMake / Ninja / Clang / binutils) with
  no platform scan script or rule pack.

The ClickHouse images are all project opt-in and have no global role defaults.
Jobs using them require canvas `allow_egress=true` so agents can clone
in-scope source. `clickhouse-runtime.yml` builds amd64 and runs the
contract/smoke harness when its Dockerfiles, descriptors/scripts,
`.dockerignore`, shared fingerprint/cache mechanism, or workflow changes.
`release.yml` is the authoritative multi-architecture gate: every image is
built natively on `ubuntu-latest` (amd64) and `ubuntu-24.04-arm` (arm64),
smoked on that architecture, then assembled into a multi-arch index. Unlike
Chrome Fuzz, there is no QEMU/cross-compile exception.

## OpenHarmony specialist CI contract

[OpenHarmony CI](<../.github/workflows/openharmony-runtime.yml>) covers test,
audit, and fuzz on `linux/amd64` and `linux/arm64`. Test/audit retain QEMU
cross-architecture checks. Fuzz uses a matching native runner for each platform;
its Dockerfile still offers a compile/ELF-only arm64 build check for QEMU,
which is not dynamic sanitizer evidence. OpenHarmony Test smoke is
`hdc version` / `hdc -v` plus the source-tool check; either command reporting
`Ver:` is enough (qemu/no-daemon may print `Connect server failed` on the
other), and it must not require a real device. Path filters include the
OpenHarmony Dockerfiles, scripts, vendored repo/hdc tools, Test manifest,
manuals, fingerprint/cache inputs and the [Fuzz behavior probe](<../agent-harness/test-openharmony-fuzz-runtime.mjs>).

Toolchain baseline checked 2026-11-01: [Fuzz Dockerfile](<../deploy/Dockerfile.agent-openharmony-fuzz>)
pins matching Debian LLVM/compiler-rt 19 and builds checksum-pinned AFL++ 4.32c
against the same LLVM PCGUARD plugin. This retains default PIE/ASLR and
ASan/UBSan/libFuzzer; replacing only the smoke flags or Clang alias would leave
the actual AFL build path broken. The image and helper set `AFL_UBSAN_VERBOSE=1`
at compile time, retaining specific non-recovering UBSan reports instead of
trap-only signals. The probe resolves the actual compiler plugin argument to
its installed PCGUARD path; spelling the same path with `bin/../lib` is valid.
Exact pins and host-tool limitations are in
the Dockerfile and [toolchain guide](<RUNTIME_TEST_TOOLCHAINS.md>).

Fresh **and reused** Fuzz candidates must pass offline environment/manual checks
and the same native behavior probe: fixed independent launches through the
original C command and both production helper engines, actual ASan/UBSan error
reports, and distinct nonempty AFL branch maps. Only then may CI pin its
single-architecture source cache. [Release](<../.github/workflows/release.yml>)
selects one immutable multi-platform candidate, tests it on both native
architectures, then pins new source cache and publishes version tags/descriptors.
A cache hit, QEMU ELF check, version string, or partial image push cannot replace
these checks. Actual acceptance is the exact source SHA, candidate digest and
Actions logs, not this contract text or a synthetic target's product quality.
Release still publishes all three OpenHarmony products.

诊断记录（2026-11-01）：[原 Release 的 OH Fuzz job](https://github.com/SummerSec/DeepSonar/actions/runs/41299685948/job/124831086342)
在 ASan/libFuzzer 启动时退出 139；原日志没有栈，不能仅凭退出码断言根因。
[固定源码/基础镜像诊断](https://github.com/SummerSec/DeepSonar/actions/runs/41305345014)
以原 C 源码和参数复现 20 次中的 8 次崩溃，GDB 显示高熵 PIE 映射落入 LLVM 14 ASan
固定主分配器保留区。所选 LLVM 19 包含 [上游最终修复](https://github.com/llvm/llvm-project/commit/fb77ca05ffb4f8e666878f2f6718a9fb4d686839)。
[独立启动对比](https://github.com/SummerSec/DeepSonar/actions/runs/41306403494)
固定 `fdb55a01b1e02b5b9078586923a8d506ce5bb096` 和 base
`sha256:29f7d8b63d4a323295ba204d83e682a43698d648b965899287b818547a7b5220`：
LLVM 14 对照 7/20 失败，匹配 LLVM 19 候选 20/20 通过，均保留原 flags、PIE 和宿主 ASLR。
这是有限诊断，不是实际 AFL 工具链、arm64 或正式发布验收；不重跑旧 Release 碰运气，
修复走正常 PR 和最终 SHA Actions，既有未发布 tag 的恢复仍须单独明确授权。

### Reverse 原生发布硬门（#718）

- 本次 release 的 `base-image.outputs.digest` 进入各架构 fingerprint 与 `BASE_IMAGE`，不使用可变 base tag。Ghidra arm64 decompiler 从固定 PUBLIC zip 的 bundled source 原生构建。
- 两架构都完成离线手册、真实 CLI / ELF / `.so` / PE、压缩镜像体积、资源与取消测量，以及真实 OpenSandbox Job，才保存 native child artifact、钉 src cache、放行 index 组装。
- 首期预算仍为 2800 MiB；每个成功 run 的 `reverse-native-evidence-<arch>/measurements.json` 才是 OCI 实测。`reverse-job-evidence-<arch>` 证明隔离测试环境中的实际 Job 路径，不冒充生产准入。
- 既有版本标签包含 index wrapper 在内不可变。手动触发使用已验证的 release version；若已有标签与本次测试 payload 不同，或多个目的地已有不同 index digest，发布直接拒绝。匹配时保留旧 index bytes，仅补缺失目的地；不能靠改注释重打同版本。
- 最终 catalog 检查 reverse 及 Chrome/ClickHouse 的 14 个原生 child，并重验所有可用通道。没有真实 `reverse.json` 或通道证据不得发布完整 catalog；不改动任何生产项目启用状态。

## 正式版本签名发布门禁

每轮版本来自新的、未使用的 `vX.Y.Z` tag，私有 package 版本不作为产品版本。正式 tag 必须指向已通过 CI 的 main；签名身份、目标 commit、CHANGELOG、schema 与最终平台镜像必须一致。`prepare-release` 的冻结产物经 `platform-signatures` 三张 GHCR index 签名及独立验证后，`release` 才能发布与回写。仅签名 job 新增 `id-token: write`，不创建持久凭据；信任根、签名 metadata 与默认关闭的宿主自动升级规则见 [签名运维](../deploy/UPGRADE_AUTOMATION.md)。生产正例以本版 Release 的公开回执和 workflow 为准；不能用测试密钥或 tag 存在代替。
