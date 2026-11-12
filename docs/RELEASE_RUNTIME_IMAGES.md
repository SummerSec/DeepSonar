# 运行时镜像发布（Issue #70 Slice B）

> 状态：**运维 as-built；最新正式版 v0.6.20，于 2026-11-12T16:12:08Z 正式发布；v0.6.18/v0.6.19 及更早 tag/镜像保持不可变**。
> 同步日期：2026-11-12
>
> **v0.6.17 发布准备（2026-11-08）**。用户要求先完成 #1002，再发布新版本。最新正式 [v0.6.16](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.16) 于 2026-11-07T16:21:03Z 发布，元数据列出 registry/v2、签名证据、Reverse 证据与 Management Skill 附件；这里核对元数据，不重新声明附件内容/签名/各通道镜像已逐项复验。远端 v0.6.17 已创建并推送（annotated tag `598dabe9`，解引用到 `24ba6a4fbff00190527da2923e7b644c387c6aa6`），compare 为 `v0.6.16...v0.6.17`。
>
> **v0.6.17 发布结果（2026-11-09）**。tag 触发 [release run 42554755905](https://github.com/SummerSec/DeepSonar/actions/runs/42554755905)，结论 **success**：31 个 job success、1 个 job failure。[Release](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.17) 已正式发布（非 draft / prerelease，`publishedAt=2026-11-09T04:16:56Z`），附件含 `runtime-image-registry.json`、`runtime-image-registry-v2.json`、`platform-signature-evidence.json`、`deepsonar-reverse-evidence-0.6.17.tar.gz` 与 `deepsonar-management-skill-0.6.17.tar.gz`。唯一 failure 是 `release-writeback`，实际记录为 `WRITEBACK_RUN_AWAITING_APPROVAL`（[job 128976917142](https://github.com/SummerSec/DeepSonar/actions/runs/42554755905/job/128976917142)，`04:16:45Z–04:18:00Z`）：回写 PR 的 `ci` run [42560943855](https://github.com/SummerSec/DeepSonar/actions/runs/42560943855) 当时是 `action_required`，GITHUB_TOKEN 建的 PR 需维护者批准。批准后该 run 全绿（`ci-summary=SUCCESS`），另触发 [release-resume 42563083855](https://github.com/SummerSec/DeepSonar/actions/runs/42563083855) 复用 #1028，该 job 在 `04:49:17Z` 由维护者以 `The operation was canceled` 终止，**没有**耗尽轮询或输出 timeout。
>
> 静态复核另确认一处**代码推导风险**（当时未在线上演完）：`gh` 把 `statusCheckRollup` 结论输出为 GraphQL 大写字面量（`SUCCESS`），而脚本按小写比较，因此 CI 已绿且 `mergeStateStatus=CLEAN` 的回写 PR 既不会 break 也不命中阻断集合；若不人工介入，会耗尽 90 次轮询后判 `WRITEBACK_CHECK_TIMEOUT`。该风险由回归用例钉住（还原旧实现即复现该错误码），但不能当作「线上已等满约 90 分钟」的运行证据。回写 PR [#1028](https://github.com/SummerSec/DeepSonar/pull/1028) 最终由维护者按原 required checks 人工合并（`7035fe60`），`deploy/.env.example` 的 `DEEPSONAR_VERSION=0.6.17` 与 bundled registry（`platform_version: 0.6.17`、`schema_version: 71`）已落默认分支。结论大小写归一与回归用例见后续修复；不能把「Release 已发布」当作回写自动完成。
>
> #1002 的 #1003（创建期 objective 绑定）、#1004（删除凭据保留 token/用量）、#1006（stopped Hub/评论准入）、#1007（Canvas 外键引用索引）与 #1009（单 effect 管理员结算）已位于核对主线 `8c6f5224277a33315e49fbe97245f52a1b3694a6`。该最新 main 的检查与本候选须分别核对，不继承旧主线绿灯。#1011 聚合候选另包含 #1005 `feafb8c5d93c0beeb2d69442e6d0694bd92f8b04`（重建基线与原 ACL 同事务发布）、#1008 `61c8a3208e40fb4d886887bf44285928b276c9f6`（同 Engine 声明预检与隔离 smoke 输入）、#1009 `fff016fb37e52c170ad25f1967c84951e53a5364`（单 effect 管理员结算）、#1010 `2b9a1a38660fdd2f7540e9b940652a8f61aff826`（provision 失败诊断），已完成技术整合和文档冲突核对；来源各自完整适用 Actions 已成功。[#1011](https://github.com/SummerSec/DeepSonar/pull/1011) 合入 `24ba6a4f` 后，该 SHA 的 `push@main` 完整 `ci`（[42490437063](https://github.com/SummerSec/DeepSonar/actions/runs/42490437063)）已全绿（四个 gate 分片、`crash-recovery`、`runtime-images` 三矩阵、Chrome Fuzz ARM 与 Windows 专项），`ci-summary` success；组合与最终 main 由该运行放行，不再沿用来源绿灯。#1005 的来源 [42458600818](https://github.com/SummerSec/DeepSonar/actions/runs/42458600818) 实际 migrations 31/31，包括独立连接 TRIGGER/无泄漏、提交前回滚及后续回填失败；#1008 的来源 [42454858971](https://github.com/SummerSec/DeepSonar/actions/runs/42454858971) / [42454859001](https://github.com/SummerSec/DeepSonar/actions/runs/42454859001)、#1009 的 [42445825039](https://github.com/SummerSec/DeepSonar/actions/runs/42445825039) / [42445825036](https://github.com/SummerSec/DeepSonar/actions/runs/42445825036)、#1010 的 [42451727319](https://github.com/SummerSec/DeepSonar/actions/runs/42451727319) / [42451727294](https://github.com/SummerSec/DeepSonar/actions/runs/42451727294) 分别保留来源证据。暂缓 #833/#834 不实施、不关闭；缺失历史预算、现场并发根因、per-container/持续资源约束及真实模型质量不宣称解决。主线另包含 #996 的 Management CLI 契约、#990 归档/pointer 回读与 #992 冻结安装输入/CI 分层，不冒充 Pi chunk sender 或跨运行 BASE proof 复用。
>
> 当前候选另补 #1002 P1-4 的关联后续 #1012：正常人工请求的 pending agent_run 先经宿主确认精确 sandbox 消失和同 Attempt 接受事实，原子撤销旧 grants 后才结清；unknown/清理或撤销失败/取消不改且不补 usage。所有 waiting_human 回复/忽略核原冻结请求策略并复用共享安全准入，仅有修正根时建立 resume-frozen 代际，原额度、期限、快照与回执不重置，旧 Gateway/Control 运行凭证随交接原子撤销；重复交接、拒绝全回滚、实际领取/Gateway/完成回归已接 recovery。其最终 SHA Actions 已随 `24ba6a4f` 的 [42490437063](https://github.com/SummerSec/DeepSonar/actions/runs/42490437063) 通过，不以旧组合或来源通过代替，也不宣称生产历史 Job 已恢复。

> **v0.6.18 发布结果（2026-11-10）**。annotated tag `v0.6.18` 指向最终 main `47d1f14dbda3acecc8f65de495687ec6086eb32c`，解引用 SHA 与 release run 的 `head_sha` 及实际 checkout 一致，compare 为 `v0.6.17...v0.6.18`。tag 触发 [release run 42736990400](https://github.com/SummerSec/DeepSonar/actions/runs/42736990400)，结论 **success**：31 个 job success、1 个 job failure，含双平台 `reverse-images`、chrome/mobile/openharmony 矩阵、`prepare-release` 与 catalog 双平台 payload 门禁。唯一 failure 是 `release-writeback`，记录 `WRITEBACK_RUN_AWAITING_APPROVAL`（[job 129593088690](https://github.com/SummerSec/DeepSonar/actions/runs/42736990400/job/129593088690)，`02:42:31Z`）：回写 PR [#1050](https://github.com/SummerSec/DeepSonar/pull/1050) 的 `ci` run [42744488348](https://github.com/SummerSec/DeepSonar/actions/runs/42744488348) 由 GITHUB_TOKEN 创建，需维护者批准才运行；批准后该 run 全绿（`ci-summary=SUCCESS`），PR 以 `83539ae0a06b1377360adb46ccbb443cedfa31a0` 正常合并，`deploy/.env.example` 的 `DEEPSONAR_VERSION=0.6.18` 与 bundled registry（`platform_version: 0.6.18`）已落默认分支，该最终 main 的 push `ci` 已 success。
> [Release v0.6.18](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.18) 已正式发布（非 draft / prerelease，`publishedAt=2026-11-10T02:41:40Z`），附件含 `runtime-image-registry.json`、`runtime-image-registry-v2.json`、`platform-signature-evidence.json`、`deepsonar-reverse-evidence-0.6.18.tar.gz` 与 `deepsonar-management-skill-0.6.18.tar.gz`。这里核对 Release 元数据与工作流结论，未逐通道重拉镜像复验 digest payload。
>
> **v0.6.18 发布准备（2026-11-10）**。用户在当前会话明确授权发布新版本。v0.6.17 仍是最高既有稳定 tag 与最新正式 Release，远端无 v0.6.18；准备基线为 main `93de217c8e93182e49cde68e0d5793124f75ed0b`（2026-11-10 核对），compare 为 `v0.6.17...v0.6.18`，本版目标 schema72（v0.6.17 为 71）。候选内容：#1018/#1030 项目 FIFO 队列与 schema 队列表、#1019/#1024 事实用途回读、#1033 人工请求指引与去重、#1002 的 #1021/#1023/#1025/#1026/#1027 补片、#1016/#1045 已接受完成结算、#1034→#1035 知识沉淀收敛（ADR-0020 由 ADR-0021 收窄）、#1032 首片的 #1037 上下文凭据移除、#1038/#1042 告警收敛、#1039/#1041 资产 helper 回收、#1046/#1048 create 路径熔断、#992/#1043 digest 加载、#1036 D/#1040 原生恢复回归、#1020/#1022 Web 清理与 #1029 回写归一。#1035/#1040 由本会话解决与 main 的文档冲突后合并（`f5b1e0ee`、`93de217c`），未改写原作者提交。打 tag 前的完整适用 Actions 已在该最终 main 上通过（workflow_dispatch `ci` run 42735098137），随后才创建 tag。
>
> 升级基线：v0.6.16 为 schema68，已核对 main `8c6f5224277a33315e49fbe97245f52a1b3694a6` 的基线为70，#1011 当前集成候选为 schema71（2026-11-08 核对 [`schema-version.ts`](../apps/scheduler/src/schema-version.ts) 与 `database/schema.sql`），另补现场 Finding 候选级联路径的三条完整外键前缀索引；其多 generation SQL buffer/HTTP 保全回归已在 `24ba6a4f` 的 [42490437063](https://github.com/SummerSec/DeepSonar/actions/runs/42490437063) 通过，旧 schema70 组合绿灯不能替代。必须备份并按受治理的基线重建/列交集回填处理非空库；没有增量 ALTER 或静默旧 Job 预算补齐。相关数据边界见[数据架构](architecture/08-data-architecture.md)。发版前重新核对最高既有稳定 tag、上述来源是否都在最终主线、最新 main 的文档/changelog 与完整适用 Actions；再创建新的不可变 v0.6.17，不能在只验证聚合候选或来源 SHA 时提前打 tag。私有 package 版本、bundled registry 与部署镜像引用不手改，真实签名/通道 payload 与回写仍由发布工作流留证。
> **v0.6.19 发布准备（2026-11-10）**。用户在当前会话明确授权 Agent 自主判断并发版。v0.6.18 仍是最高既有稳定 tag 与最新正式 Release，远端无 v0.6.19；准备基线为 main `f6ed59c8`（2026-11-10 核对），compare 为 `v0.6.18...v0.6.19`，schema 仍为 72（v0.6.18 同为 72，本版无迁移，非空库无需重建）。候选内容： #1059/#1061 anthropic 兼容流用法结算（消息起始快照缺 `output_tokens` 不再检查整条流，pending 快照仍建立 input/cache 单调性基线）、#1032 P1-3/#1056 凭据守卫拒绝的稳定终态码（含 provider 的 `(400):` 封装）、#1032 P2-5/#1060 运行控制 Skill 的 env 导出禁则与脱敏范围限定。三者均为 bug 修复，不改 API/schema/权限/镜像准入；打 tag 前仍须最终 main 的完整适用 Actions 全绿，本段是准备状态，不是发布完成。
>
> **v0.6.19 发布结果（2026-11-10，dsh-superagent 自主发布闭环）**。发布准备 PR [#1062](https://github.com/SummerSec/DeepSonar/pull/1062)（docs-only）合并后（`490a6919`）在 `push@main` 未触发核心 CI（paths-ignore 覆盖纯文档）；按门禁手动 dispatch [ci run 42849663811](https://github.com/SummerSec/DeepSonar/actions/runs/42849663811) 于同一 SHA，conclusion **success** 后才创建 annotated tag `v0.6.19`（本地解引用 = `490a691993f493ad497e0b955be9dea9865cf7a6`，与 run 的 `head_sha` / 实际 checkout 一致，compare `v0.6.18...v0.6.19`）。tag 触发 [release run 42851650415](https://github.com/SummerSec/DeepSonar/actions/runs/42851650415)，结论 **success**：`base-image`、双平台 `reverse-images`、chrome/mobile/openharmony 矩阵、`prepare-release`（含双平台 payload 门禁）、`platform-signatures` 与 `release-publish` 均 success；唯一 failure 是 `release-writeback`，`WRITEBACK_RUN_AWAITING_APPROVAL`（[release run 的 writeback job](https://github.com/SummerSec/DeepSonar/actions/runs/42851650415)）：回写 PR [#1063](https://github.com/SummerSec/DeepSonar/pull/1063)（bot 分支 `cb7c3f86`）的 [ci run 42856351634](https://github.com/SummerSec/DeepSonar/actions/runs/42856351634) 等待批准；经 Actions API 批准该 run（非绕过 required checks，运行仍完整执行），该 PR 的 `ci-summary` 与全部适用检查全绿后按正常合并门禁 merge（`e82f28ec`），`deploy/.env.example` `DEEPSONAR_VERSION=0.6.19` 与 bundled registry（`platform_version: 0.6.19`，registry manifest `schema_version: 2`，与 DB schema72 无关）已落默认分支，回写必须通过必需检查的门禁未绕过。
>
> [Release v0.6.19](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.19) 已正式发布（非 draft / prerelease，`publishedAt=2026-11-10T16:37:04Z`），附件含 `runtime-image-registry.json`、`runtime-image-registry-v2.json`、`platform-signature-evidence.json`、`deepsonar-reverse-evidence-0.6.19.tar.gz` 与 `deepsonar-management-skill-0.6.19.tar.gz`。这里核对 Release 元数据、run 各阶段结论与回写落地；未逐通道重拉镜像复验 digest payload，生产部署未执行（按 AGENTS「验收边界」豁免）。
> **v0.6.20 发布准备（2026-11-12）**。上一正式版仍是 [v0.6.19](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.19)，最高既有 tag 为 `v0.6.19`，远端无 `v0.6.20`；准备基线为 main `9a1d25c6`（2026-11-12 核对），compare 为 `v0.6.19...v0.6.20`，schema 由 72 升至 73（#1074/#1075 新增 `job_execution_clocks` 与 `human_requests`，无增量 ALTER，非空库须先备份并按 `pnpm db:rebuild` 的既有基线重建路径升级，scheduler 对旧版本 fail closed）。本版范围：Pi 1.4.0 → 1.5.2、DSH 0.2.1-rc.2 → 0.2.2-rc.1 与基础镜像 Node 24 的联合升级（#1069/#1070/#1071，含 DSH `tools` 插件改挂 `tool-executor-native`/`tool-executor-ptc`、预算补丁摘要重算、`cacheWarming=off`）；Pi 原生重试与宿主结算衔接（#1072/#1073）、Pi 请求异常来源分类（#1083/#1084）、OpenSandbox PTY 退出与传输中断区分（#1088/#1089）、PTY 积压消费让出 I/O（#1092/#1093）、事件载荷 U+0000 与 22P05 稳定分类（#1066/#1068）、Gateway 逐跳连接头隔离（#1097/#1098）、控制面 HTTP operation 引导（#1094/#1095）、进程基线读取失败闭合（#1091）、凭据按并发余量选择且冻结恢复身份优先（#1078/#1080/#1103）、Gateway 凭据拒绝审计与 create 熔断计数（#1053/#1054）、人工等待断点封存与晚回复续做第一切片（#1074/#1075）、管理面等待分类与恢复诊断只读投影（#1036 A/D，#1051）、项目知识闭环（#1076）、Pi 重试保留已完成消息（#1099）、凭据删除与 OCI 扫描串行化（#1100）、共享资产只读挂载与清理归属核验（#1101）。**本版包含运行时 CLI 与基础镜像升级，不能复用 v0.6.19 镜像**；打 tag 前须最终 main 的完整适用 Actions（含 `ci:images`、`runtime-images`、`reverse-runtime-images`、`pi-om-acceptance` 双架构）全绿，本段是准备状态，不是发布完成。
> **v0.6.20 发布结果（2026-11-12）**。annotated tag `v0.6.20` 指向最终 main `cf18126685540db6cac787a2db471e610b985d1e`（docs-only 发布准备链 #1104 → #1105 → #1106 后的 tip；打 tag 前手动 dispatch [ci run 43239097695](https://github.com/SummerSec/DeepSonar/actions/runs/43239097695) 在同一 SHA，conclusion **success**，`ci-summary=success`）。tag 触发 [release run 43243132668](https://github.com/SummerSec/DeepSonar/actions/runs/43243132668)，结论 **success**：`base-image`、`kali-minimal`、`mobile`、`openharmony-*`、`reverse-image-builds`（双平台 reverse）、`images`（audit/scheduler 双平台）、`chrome-*`、`prepare-release`（catalog 双平台 payload 门禁）、`platform-signatures` 与 `release-publish` 均 success；唯一 failure 是 `release-writeback`，记录 `WRITEBACK_RUN_AWAITING_APPROVAL`。回写 PR [#1107](https://github.com/SummerSec/DeepSonar/pull/1107)（bot 分支 `cff5b876`）的 [ci run 43256071516](https://github.com/SummerSec/DeepSonar/actions/runs/43256071516) 经 Actions API 批准后首次运行 `gate-e2e` 失败：`agent-harness/test-local-project-api.py` 的 Hub 编排链未在 15 分钟内收敛；同一内容的 [ci run 43239097695](https://github.com/SummerSec/DeepSonar/actions/runs/43239097695) 的 `gate-e2e` 已 success，判定为收敛计时 flake，按常规 `gh run rerun --failed` 重跑后全绿（`ci-summary=success`），PR 以正常合并门禁合并（main `50ad6e9b`），`deploy/.env.example` `DEEPSONAR_VERSION=0.6.20` 与 bundled registry（`platform_version: 0.6.20`，registry manifest `schema_version: 2`，与 DB schema 73 无关）已落默认分支。Release 附件 5 项（`runtime-image-registry(.v2).json`、`platform-signature-evidence.json`、Reverse 证据包、Management Skill 包），发布目录与回写目录的 `runtime-image-registry-v2.json` 逐字节 JSON 等价比对通过。**本版必须重建运行时镜像**（Pi 1.5.2 / DSH 0.2.2-rc.1 / Node 24，schema 72 → 73 升级记录见 [CHANGELOG](../CHANGELOG.md#0620---2026-11-12)）。

> #1018 的项目任务队列已随 #1030 合入并把基线推进到 schema72（2026-11-10 核对 [`schema-version.ts`](../apps/scheduler/src/schema-version.ts)），新增 `project_task_queues`、`project_task_queue_items` 及索引；v0.6.19 沿用 schema72，非空库无升级动作，改动仅覆盖用量 scanner、失败终态码与静态 Skill 文本。
>
> **历史 v0.6.15 失败发布核对（2026-11-07）**：[v0.6.15 发布运行](https://github.com/SummerSec/DeepSonar/actions/runs/42178680573) 在 Chrome / ClickHouse 子镜像构建失败，未完成最终 catalog、签名和正式 Release；不可把单个镜像 tag 当作整版发布。当时最新正式版为 [v0.6.14](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.14)，main `16ed0726` 的 bundled 清单与部署示例均已回写到 `0.6.14`。DSH/Pi OM 的旧镜像问题、三款已推送镜像的实物核验和恢复限制见 [#979 诊断与恢复](RUNTIME_IMAGE_GOVERNANCE_979.md)。原 v0.6.15 tag/已有镜像保持不可变；新的发布须重新确认目标版本、compare 和最终 SHA Actions，不能沿用旧准备状态。
>
> **历史 v0.6.16 发布准备（2026-11-07，保留当时范围）**。当时候选为 **v0.6.16**，compare 为 `v0.6.15...v0.6.16`。前一版本按「除目标外最高 Git `v*` tag」取 [v0.6.15](https://github.com/SummerSec/DeepSonar/actions/runs/42178680573) 指向的 `2b51080431826308c3fdc28cef8e7955ac7f16e6` —— 该 tag 的 Release 在 Chrome / ClickHouse 子镜像失败、未形成正式 Release，但仍参与比较，不移动也不复用。本候选范围为 **#944（Pi RPC 大载荷接收侧）** 与 **#958（Pi 输出截断与有界恢复、模型预算贯通）**，叠加 `[Unreleased]` 中已合入的 #971–#976、#961 P2/P3、#967、#945、#979。**2026-11-07 发布准备的源码基线要求 schema 68**（当日 `apps/scheduler/src/schema-version.ts`）：v0.6.14 与 v0.6.15 tag 都是 schema 67，schema 68 由 #954/#960 的 Skill 源发布隔离引入，所以 v0.6.16 是首个要求 68 的版本；仓库没有就地升级路径，非空库版本不匹配时 Scheduler 拒绝启动并提示先备份再按 `database/schema.sql` 重建，升级前须完成受治理备份/重建与验收。该次发布准备自身不改 schema、迁移或任何运行时行为；后续 #1002 P1-7A 集成目标见[数据架构](architecture/08-data-architecture.md)，实际发布须按最终源码及 Actions 重核，不能沿用此准备基线。产品版本仍只由 tag 注入的 `DEEPSONAR_VERSION` 决定，不改私有 package 版本。前置条件：#984 与 #989 必须先在最终 main 上合并并通过适用 Actions，之后才在本候选提交上打不可变 `v0.6.16`。
>
> **历史 v0.6.4 发布准备基线（2026-11-02，保留历史来源）**。准备时最近正式版为 [v0.6.2](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.2)，于 2026-10-31T09:05:38Z 正式发布，非 draft / prerelease；tag 指向包含 Web 隔离构建修复的 `347385a53f43d15a53175226528af10a692f6f9e`。[v0.6.3 的 Release](https://github.com/SummerSec/DeepSonar/actions/runs/41299685948) 失败，已有部分镜像但未完成正式发行。按用户 2026-11-02 的选择，保留其 tag 和既有镜像，改发 **v0.6.4**；Git compare 起点为 v0.6.3，成功升级基线仍为 v0.6.2（schema 65 → 67）。本轮范围沿用[原范围决定](<../AGENTS.md#豁免范围>)，不移动旧 tag 或覆盖旧镜像。这里核对发布元数据与源码关系，不重新声明附件、签名或各通道镜像已逐项复验。
>
> **历史 v0.6.0 元数据核对（2026-10-29）**。[v0.6.0](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.0) 已于 2026-10-22T06:02:52Z 正式发布（非 draft / prerelease），Release 附有 `runtime-image-registry.json`、`runtime-image-registry-v2.json`、`platform-signature-evidence.json`、`deepsonar-reverse-evidence-0.6.0.tar.gz` 和 Management Skill。本次只核对 Release 元数据及附件清单，未重新 inspect 镜像、验签或部署；附件存在不替代签名内容校验，发布完成不等于现网已经升级。下次发布仍须按本文完成目标版本的双架构、各通道 inspect、签名和验收门禁；历史正式 tag 保持不可变。
>
> Scheduler / runtime-sandbox 契约修复的**部署生效与自检**：[`RUNTIME_IMAGE_CONTRACT_DEPLOY.md`](RUNTIME_IMAGE_CONTRACT_DEPLOY.md)（#636）。

`.github/workflows/release.yml` 由 `v*` tag 触发。工作流先发布 `deepsonar-base`，再发布依赖它的 OpenHarmony、Chrome 与 Mobile 专项镜像与 Reverse 原生双架构镜像，最后由 `prepare-release` 合并真实的 buildx manifest digest 并冻结载荷，`platform-signatures` 验签后交给独立 `release-publish` / `release-writeback`。发布阶段把 `runtime-image-registry.json` 与 Management Skill 等冻结文件作为 GitHub Release 附件。合并前的核心定义与 base/audit/Kali 门禁在 `.github/workflows/ci.yml`；Chrome amd64 合同冒烟在 `.github/workflows/chrome-runtime.yml`，OpenHarmony test/audit/fuzz amd64/arm64 专项冒烟在 `.github/workflows/openharmony-runtime.yml`，Mobile amd64/arm64 专项冒烟在 `.github/workflows/mobile-runtime.yml`。`deepsonar-reverse` 在 `.github/workflows/reverse-runtime.yml` 使用原生 amd64/arm64 runner 构建当前 base+reverse，执行 ELF/.so/PE REA/Ghidra、真实 `docker save` / cgroup / 取消测量和 OpenSandbox Job；release 对缓存与 fresh child 执行相同门禁。脚本已接线不等于实际运行已通过。

独立 `release-writeback` 在校验通过后，会把生成的 `deploy/runtime-image-registry.json` 与 `deploy/.env.example` 中的 `DEEPSONAR_VERSION` 及三条平台镜像 digest 引用（`DEEPSONAR_SCHEDULER_IMAGE` / `DEEPSONAR_WEB_IMAGE` / `DEEPSONAR_IMAGE_ADMISSION_IMAGE`，按本次发布的 index digest 重新 inspect 写入，#740）**通过 bot 分支 PR 与必需检查合入仓库默认分支**（`chore(release): sync runtime-image-registry.json and image tag for vX.Y.Z`），用于更新内置 bundled 回退清单与部署示例版本。发布准备阶段不得手写运行镜像 digest 或提前改写 bundled 清单。历史 v0.5.3 的 Chrome / ClickHouse 产品选择曾陈旧；当前 ClickHouse 专项已按 #952 下线，不再列入新 Release 产品集合。每次发布都须由真实证据与最终 payload 门禁决定当前清单，再由 workflow 回写。仅当默认分支内容与本次发布不同时才提交；推送到默认分支不会再次触发本 workflow（触发条件只有 `v*` tag）。**回写必须通过默认分支的 required check（#865 / #877）**：默认分支要求 `ci-summary`，而**直推会被规则拒绝**——即使 `ci-summary` 已经在同一个 SHA 上通过（v0.6.7 实测：日志先出现 `ci-summary passed on 8f3479d4`，随后 `push declined due to repository rule violations`，Release 未创建，最终由人工从 bot 分支开 PR 才把清单合并进去）。因此回写不再直推，而是**走与人工合并相同的路径**：

1. 回写提交推到 `bot/sync-runtime-registry-v<version>` 分支；
2. 创建或复用回写 PR，通过正常 PR 事件进入检查，不手动 dispatch 另一条与 PR 检查汇总无关的运行；
3. 等待该 PR、该 head 的 `ci-summary` 成功及可合并状态；失败或等待批准时明确停止，不绕过 required checks；
4. 正常执行 `gh pr merge --merge`，随后 `assertLanded` 用 compare 核对默认分支包含回写提交；
5. 落地核验成功后删除 bot 分支。

核对基线：2026-11-06，[实现](../agent-harness/release-writeback.mjs)默认轮询上限为 90 次、轮询间隔 60 秒；API/命令耗时另计，不是严格 90 分钟墙钟预算。`DIRTY`/`CONFLICTING` 明确拒绝，其他尚不可合并状态等待到轮询上限。合并前检查失败不会由脚本执行合并；合并命令结果未知、合并后 compare 或分支清理失败时，默认分支可能已经更新，必须先查询 PR/默认分支/远端分支再决定恢复，不承诺回滚或 bot 分支一定保留。错误信息保留远端 `remote:` 规则拒绝原因。

要放行的是**同一条门禁**，不是绕过它：不要为 bot 配置 ruleset bypass、不要直推、也不要用可写 PAT 跳过必需检查。

**发布按阶段可重入（#893）**：`release.yml` 的末端不再是「一个 job 里的两个不可逆动作」，而是两个独立阶段，都只消费同一份冻结载荷：`release-publish`（校验签名载荷 → 建 Release，Release 已存在则不改写）与 `release-writeback`（同步 bundled 清单与 `.env.example`，内容一致则早退）。写回阶段带 `continue-on-error`：失败会以失败 job 的形式可见，但**不会扣住已经可以发布的 Release**；反之 Release 已存在也不会阻塞写回。两段实现分别在 `agent-harness/release-publish.sh` 与 `agent-harness/release-writeback.sh`，被发布流程与 `.github/workflows/release-resume.yml` 共用。当某一阶段失败时，用默认分支上的 **Release resume** 手动触发，输入 `X.Y.Z`、原 `source_run_id` 与 `writeback | publish | both`。恢复身份、证据来源及拒绝条件见下节；它不重建或重新签名镜像。已正式存在的 Release 不改写；默认分支两个文件均一致时回写早退，尚未落地的 bot 分支仍走原 PR/required checks，相同完整树复用原 head 保留检查；默认分支已有更高版本时拒绝旧版回写。 前置条件：仓库必须允许 GitHub Actions 创建 PR（Settings → Actions → General → “Allow GitHub Actions to create and approve pull requests”，API 为 `repos/<owner>/<repo>/actions/permissions/workflow` 的 `can_approve_pull_request_reviews=true`）。回写脚本在动任何分支之前先检查该开关，明确读到关闭时立即以 `WRITEBACK_PR_PERMISSION_MISSING` 单条可执行提示失败，权限端点不可读时记录未确认并继续到实际 PR 操作，不等于已证明允许；而不是先等满一轮门禁再报 GraphQL 错误（v0.6.8 实测：22 分钟后才失败）。bot 分支由 workflow 独占且可丢弃，因此用 `--force-with-lease` 覆盖上一次尝试留下的同名分支，避免非快进推送把发布卡死。

**维护者批准按实际运行状态处理（#887）**：若 GitHub 将回写 PR 的 Actions 运行置于 `status=waiting` 或 `conclusion=action_required`，脚本以 `WRITEBACK_RUN_AWAITING_APPROVAL` 停止并提供 run/PR 线索。维护者核实并批准该运行后，可恢复 writeback，再按原 required checks 和合并门禁继续。并非每次发布都必然等待批准，也不承诺批准恰好一次或批准后立即 `CLEAN`。历史 v0.6.10 曾等待批准并耗尽轮询预算；该事实不能替代当前运行状态查询。独立 publish 不受此批准等待阻塞。

## 恢复身份与原发布证据

核对基线：2026-11-05。`release-resume.yml` 只接受 `main` 的手动 dispatch，checkout 本次 `github.sha`，读取原版本 `refs/tags/vX.Y.Z` 而不执行旧 tag 的恢复代码。恢复与正常发布共享 concurrency，`both` 分别在两个 runner 上运行且 `fail-fast: false`，writeback 失败或切换工作树不会阻塞/改变 publish。默认分支升级不改原冻结目标。

`agent-harness/release-resume.mjs` 在每次副作用前通过认证 GitHub API 验证：同一官方仓库及 head repository、`release.yml` workflow ID/path、稳定版本 head branch、完成状态、原 commit 与本地/远端 peeled tag 一致，以及 `base-image`、`prepare-release`、`platform-signatures` 成功 job 和身份/冻结/签名步骤。归档只按该运行中唯一 artifact 的 ID 下载，校验 API 提供的 SHA-256、有效期、run/repository/head SHA 与 producer job 时间窗口，再按固定成员白名单读取；不会解压执行路径或信任 payload 自报哈希。

完整归档验证后，才从受信任归档取得 freeze/receipt 哈希，复用 `checkPublication` 与 `checkSignatureReceipt` 校验所有冻结附件、目标 metadata、原正向签名验证和负向篡改证明以及固定 cosign/根摘要。恢复不修改 `GITHUB_*`、不调用 signing、不增加 OIDC/持久凭据或新信任根；原 `releaseIdentity` 正式 tag 门禁不变。发布 gate 使用调用方的 signature directory。远端 tag 在证据检查后再次核对，不移动 tag；平台管理员另行并发移动 tag 不在恢复允许行为内。

限制：只接受原运行 attempt 1；GitHub artifact API 不提供可靠的跨重跑 attempt 绑定，所以多 attempt、缺失/过期/重复 artifact、无 API archive digest、错误工作流/仓库/版本/commit、缺失成功阶段、下载或 API 失败均 fail closed。不能从本地副本或自报 receipt 修补这些缺口。真实恢复须另行授权；合成测试不代表已恢复任何旧版本。v0.6.14 run `42037159429` 的 attempt 1 未产生冻结载荷；attempt 2 重跑相关阶段后产生了新载荷与签名并发布。该 run 现在因多 attempt 不满足本恢复入口的严格条件，不能使用 release-resume；不通过放宽门禁补回写。

Release 查询仅明确的 API 404 可进入 create，401/403/网络错误不当作缺失；已有正式 Release 的预期附件必须完整、已上传且 API digest 与冻结内容一致才幂等早退；缺件/不同内容或 draft/prerelease 冲突均停止供对账，不覆盖或补传。create 前在共享并发锁内分页查询已发布正式版本；存在更高稳定版本时显式 `--latest=false`，避免旧版本恢复倒退 latest/官方远端目录；查询失败停止。create 的未知结果不在同次执行自动重放，下一次恢复先查询现状。回写仍可能因 bot PR 等待批准或 required checks 失败而停止；不会绕过权限或检查。回归由 `ci:unit:runtime-registry` 的 Actions gate 执行，Draft 快检也显式运行恢复及原签名测试；覆盖合成冻结产物、假 API、受控发布命令与临时 Git 回写，不连接生产或真实模型。

## v0.6.15 集成证据与升级边界

2026-11-06 发布协调者完成日志验收的基线为 main `616d7a3651c0e0b89d9457f4f435c02f51f8561b`：核心 [42157394479](https://github.com/SummerSec/DeepSonar/actions/runs/42157394479)（gate/ci-summary）、Reverse [42157394594](https://github.com/SummerSec/DeepSonar/actions/runs/42157394594)（REA、Claude、Pi OM 双架构）、Mobile [42157394279](https://github.com/SummerSec/DeepSonar/actions/runs/42157394279)、Chrome [42157394517](https://github.com/SummerSec/DeepSonar/actions/runs/42157394517)、OpenHarmony [42157394433](https://github.com/SummerSec/DeepSonar/actions/runs/42157394433)、ClickHouse [42157395633](https://github.com/SummerSec/DeepSonar/actions/runs/42157395633) 均成功。该基线包含 #925/#926/#927/#928/#929/#930。此后合入的 #933（分支命名）、#935（生成前预算边界）、#936（持久 no-effect 回执回归）与 #937（验收前预拉取 egress sidecar）各自带自己的 PR Checks；它们的合入提交与最终 release head 的完整适用 Actions 仍须在打 tag 前逐条核对，不以本条基线替代后续 SHA 的验收。

schema 仍为 67（2026-11-06 对照 `apps/scheduler/src/schema-version.ts` 与 schema 基线），本轮未引入 schema 迁移；不为发布机械修改私有 package 版本。历史 Job 的请求策略缺失/非法，或多 Attempt 缺少策略回执时保持 fail closed，不补造无限预算；pending/unknown 效果仍阻止新代际。修复入队不等于执行完成，不静默修改旧快照。Claude Code 的运行中额度不足仍可明确拒绝并提示；DSH 不承诺持久会话恢复。详见[透明传输](MODEL_GATEWAY_TRANSPARENCY.md)与[修复生命周期](AGENT_REPAIR_LIFECYCLE.md)。

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

发布前在干净的合并提交上验收。按本轮用户要求，下面的测试、构建及校验全部只在 GitHub Actions 执行；`ci` 的 docs-freshness job 同时调用既有 changelog 校验器回归，并验证实际最新版本区段及其前一版本 compare link。打 tag 前须再次核对前一版本与 Release workflow 实际选择的**除目标版本外最高 Git `v*` tag**一致，而不是最近成功的 GitHub Release；失败发布留下的 tag 也参与比较。2026-11-10 已发布 v0.6.19（compare `v0.6.18...v0.6.19`）；2026-11-12 已发布 v0.6.20（compare `v0.6.19...v0.6.20`，除目标外最高 `v*` tag 为 v0.6.19，schema 版本按源码核对为 73；本版含运行时 CLI 与基础镜像升级并已重建镜像）；下一次发布须重新核对除目标外最高 `v*` tag 与 schema 基线后再替换此候选值，不沿用本轮：

```bash
pnpm ci:unit:docs-freshness
pnpm ci:unit:changelog
# 本轮真实 changelog 区段（仅在 Actions 执行）：
node agent-harness/validate-changelog.mjs --file CHANGELOG.md --version 0.6.20 --previous-version 0.6.19 --tag v0.6.20
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

清单由 `agent-harness/generate-runtime-image-registry.mjs` 根据各镜像构建输出或经证明可复用的真实 digest 生成，必需产品集合包含 Base、Audit、Kali Minimal、OpenHarmony Test、OpenHarmony Audit、OpenHarmony Fuzz、Chrome Audit、Chrome Test、Chrome Fuzz、Mobile 与 Reverse 十一项。尚未首发的产品在源码内置 bundled 清单中保持 `versions: []`；`deepsonar-reverse` 已在 v0.5.5 由 Release 回写 `0.5.5` + canonical digest。只有 Release 对两个平台完成真实构建 / 缓存复用验收、发布和 inspect 后，生成器才会写入版本与 digest。空版本条目不能代替 Release 要求的真实 descriptor。

**一版本多平台**：v2 多架构发布时，每条 canonical 版本记录的 `platforms` 同时列出 `linux/amd64` / `linux/arm64`，`digest` 是共享 manifest/index digest，`size_bytes` 为目标平台压缩层大小上限；不能按架构拆成两条同版本 alias。生成器可保留既有历史版本数组，最终 payload 门禁按 Scheduler 的通道 / 平台 latest-version 排序核对实际选中的版本，见下文。旧 v1 清单仍按一平台一版本解析（当前代码残留的兼容路径，非新发布契约）；Scheduler 消费平台全局 `runtime_registry_channel` 对应的 v2 不可变引用，缺少选定通道引用时 fail closed。

**版本轴拆开（#417）**：`vX.Y.Z` 是平台 Release 版本（changelog、`DEEPSONAR_VERSION`、scheduler/web/image-admission；部署按 digest 引用平台镜像，`DEEPSONAR_IMAGE_TAG` 已删除）。运行时产品的 `versions[].version` 按已证明的镜像内容决定：只有 catalog 已有本轮精确 canonical digest，或其不可变 index 已证明包含与本轮验收完全相同的 runnable 平台 manifest 集合，才可复用该行的 version + digest。summary 写 `image build unchanged; version kept`，且不对 ACR/GHCR/Docker Hub 打新的平台 version tag。source-cache / fingerprint 命中本身不能证明任意 catalog 行可复用；不得直接取 `versions[0]`。缓存 payload 无匹配 catalog 行时仍发布 version tag，并由 `record-runtime-image-digest.mjs` 对已发布通道做真实 inspect 补记一行，不编造 `registry_evidence`。平台清单同时写出 `platform_version` 与 `min_runtime_image`（默认下限来自 `agent-harness/min-runtime-image.json`）。可选 `platform` 段（#740 P1 第 2 片）携带结构化升级信息：`version` / `commit_sha` / DeepSonar `schema_version`，以及 scheduler / web / image-admission 的 index digest 与 `linux/amd64` / `linux/arm64` child digest（GHCR / ACR / Docker Hub 通道证据与运行镜像 v2 同形）。Scheduler 在清单同步路径上做只读版本发现并写入 `platform_update_checks`；缺省 `platform` 时仍可用 `platform_version` 比较。Release workflow 从三类平台镜像 descriptor 生成 `platform` 段，要求发布 commit、schema、双架构 child digest 和各通道证据完整；最终 payload 门禁重新 inspect 每个通道并核对 index / child digest，缺失或不一致立即失败。回写部署示例前校验四个版本 / 镜像变量恰好各一行，再按所选通道写不可变引用。digest Compose 契约已落地（#740 P1 第 3 片：Compose 每个平台镜像一个完整 digest 引用变量，`/health.version` 只认 `DEEPSONAR_VERSION`）；人工执行的 `deploy.sh upgrade` 与 PowerShell 入口见 [部署脚本](../deploy/README.md)。维护控制器已实现跨 schema 计划、显式审批、数据库身份隔离、候选库重建及安全恢复；实际演练范围见 [升级演练](../deploy/UPGRADE_REHEARSAL.md)。这不授权无人值守跨 schema 升级；P2 自动策略仅允许同 schema 的补丁版本。

**Chrome 双架构缓存复用（v0.5.4 修正）**：Audit、Test、Fuzz 在 amd64 与 arm64 同时命中 source-cache 后，先将本轮已验收的每架构 wrapper/index 解析为该目标平台唯一的 runnable manifest digest。用候选 catalog 的不可变 digest inspect runnable descriptors，再比较精确的 `linux/amd64` / `linux/arm64` → manifest digest 映射；attestation descriptor 不计入 payload，也不能充当 runnable manifest。只有平台集合和每个平台 digest 完全相同才复用 catalog canonical digest。缺失、重复、歧义的 runnable descriptor，或解析 / inspect 错误均 fail closed；不同 payload / 无匹配 catalog 行只作为复用未命中，改用本轮已测试缓存子镜像重新组装 index，再发布所有配置通道并收集新 inspect 证据。最后选入 catalog 的 canonical digest 必须包含本轮实际测试的两个子 manifest；不要求无关 wrapper / attestation 的 index digest 相等。其他调用方按精确 canonical digest 的复用方式仍有效。

**运行时版本轴独立于平台版本（#864 评审结论，含 floor 反例）**：`versions[].version` 表示「哪一次发布首次产出该 digest」，不随平台版本变化——内容未变时保留原 `version` + `digest`（summary 写 `image build unchanged; version kept`）。

**为什么不能在发布时把既有记录重标成平台版本**：该字段不只是展示，它参与 Scheduler 的 `(runtime_image_id,digest)` 写入，也参与最低运行镜像下限判断（`isRuntimeImageBelowPlatformMin`）。反例：同一份内容标为 `0.6.4`、当下限是 `0.6.5` 时本应被判为过低；若发布时把它重标为 `0.6.6`，它就会满足下限——而内容从未改变、也从未按新版本重新构建。也就是说「重标目标等于平台版本，所以不会超过平台」并不能证明原内容达到了最低版本。因此下限判断要真实有效，版本标签就必须来自构建事实。

配套的规范改动：`agent-harness/test-reverse-runtime.mjs` 与 `apps/scheduler/src/reverse-runtime-project-opt-in.test.ts` 里「reverse 版本必须等于 `platform_version`」的断言已移除，改为按**产物身份**校验，并按与生产一致的方式选择记录（`selectLatestRuntimeImagePullItems` 的语义：同平台下取最新版本标签）：

- reverse 至少发布一条版本，且最新标签不低于 `min_runtime_image.version`；
- digest 为 canonical `sha256:<64 hex>`，平台集合恰为 `linux/amd64,linux/arm64`；
- `image_ref` / `registry_refs` / `registry_evidence` 三个通道齐备，`inspect_digest` 与 digest 一致。

迁移：既有清单不做重标，`deepsonar-reverse` 回到真实构建版本 `0.6.4`（digest `62adab41…` 未变）。若某次平台发布确实要求更晚的 reverse，就必须真实重建 / 重新发布 reverse 并产出新 digest，而不是改标签。

**最终清单 payload 门禁**：`agent-harness/check-runtime-catalog-platforms.mjs` 必须收到 Chrome Audit、Test、Fuzz 及 Reverse 四个产品 × amd64 / arm64 的全部 8 份 native-smoke artifact。它从这些已测试 wrapper 重新解析 runnable manifest，并按 Scheduler 相同的 latest-version 排序为每个通道 / 平台解析实际 selected version；每个可用通道内的 amd64 / arm64 必须选中同一条 canonical 双平台记录，拆成不同平台版本的选择明确 fail closed，不能因任意历史行匹配就冒充 Scheduler 实际选择。随后重新 inspect 生成清单中 GHCR 及每个 available 的 Docker Hub / ACR 所选不可变 index，逐个平台核对实际子 manifest digest；不信任 cache-hit 标志、version 标签或 descriptor 自报的平台摘要。该门禁只校验目录的 bulk/latest 选择，不改写或覆盖既有 Job 冻结 / 钉死的 digest。未选中的历史行可以保留；缺失或歧义的选择、任一可用通道选到陈旧 payload、artifact 缺件 / 重复、解析 / inspect 失败均 fail closed。最终 Release job 使用既有凭据在本 job 登录 GHCR 及已配置的 Docker Hub / ACR，不依赖其他 job 的登录状态。此门禁在生成清单后、Release asset 上传及 bundled / 部署 tag 回写前执行；仅本次 catalog 修正不改运行镜像输入与 fingerprint，也不跳过 native smoke；v0.5.4 包含的其他变更（包括 #718 共享手册输入）仍可能触发重建。

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

## ClickHouse specialist contract（已下线，#952）

ClickHouse 专项镜像族（`deepsonar-clickhouse-audit` / `-test` / `-fuzz`）已按 #952 物理下线：
构建资产、注册表条目、专用 workflow 与 release job 均已删除，平台不再提供该运行镜像。
需要 ClickHouse 证据的任务改用 `deepsonar-base` / `deepsonar-audit`，并在沙箱内自行准备
工具；历史 Job 快照仍可追溯当时的 digest 记录。下线清单与 ops 清理 SQL 见
[`DEPRECATIONS.md`](DEPRECATIONS.md)。

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
- 体积预算以 [native common](../agent-harness/reverse-native-common.mjs) 的代码常量为准，不在本文复制可变上限；每个成功 run 的 `reverse-native-evidence-<arch>/measurements.json` 才是 OCI 实测。`reverse-job-evidence-<arch>` 证明隔离测试环境中的实际 Job 路径，不冒充生产准入。
- 既有版本标签包含 index wrapper 在内不可变。手动触发使用已验证的 release version；若已有标签与本次测试 payload 不同，或多个目的地已有不同 index digest，发布直接拒绝。匹配时保留旧 index bytes，仅补缺失目的地；不能靠改注释重打同版本。
- 最终 catalog 检查 reverse 及 Chrome 的 8 个原生 child，并重验所有可用通道。没有真实 `reverse.json` 或通道证据不得发布完整 catalog；不改动任何生产项目启用状态。

## 正式版本签名发布门禁

每轮版本来自新的、未使用的 `vX.Y.Z` tag，私有 package 版本不作为产品版本。正式 tag 必须指向已通过 CI 的 main；签名身份、目标 commit、CHANGELOG、schema 与最终平台镜像必须一致。`prepare-release` 的冻结产物经 `platform-signatures` 三张 GHCR index 签名及独立验证后，独立 `release-publish` / `release-writeback` 才能发布与回写。仅签名 job 新增 `id-token: write`，不创建持久凭据；信任根、签名 metadata 与默认关闭的宿主自动升级规则见 [签名运维](../deploy/UPGRADE_AUTOMATION.md)。生产正例以本版 Release 的公开回执和 workflow 为准；不能用测试密钥或 tag 存在代替。
