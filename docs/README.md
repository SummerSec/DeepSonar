# DeepSonar 文档索引

> **任务目标证据（#767）**：契约与研究候选、确定性报告、来源隔离判据评审、非 Finding 交付/负结果已接线；Plan 可选显式关联已接线，保留原操作员 authority 与完整完成门。赏金资格正向闭环未交付，无契约按原可选设计标为 unassessed。见[验收矩阵](TASK_DISPATCH_ACCEPTANCE.md)、[任务判据评审](TASK_GOAL_REVIEW.md)、[执行结果评审](TASK_RESULT_REVIEW.md)与[报告](TASK_OUTCOME_REPORT.md)。

> **任务下发（2026-10-29，#767）**：可选版本化契约、共享场景模板、结构化补充建议及派发前复核见[下发指南](../skills/deepsonar-management/references/task-dispatch.md)与 [FR-TASK-006](architecture/01-system-specification.md#fr-task-006-版本化任务契约与派发前校验)。结构化一致性与真实模型质量收益分开验收；未知身份/写权限不当作已授权。
> **#775 A/B 首片**：[Plan 缺口投影](PLAN_GAP_PROJECTION.md) 将审计与操作员判据/留存证据绑定纳入冻结报告；报告机器整体判断仍为 unknown；既有 Intent 可按版本依据进行一次补证，全判据正向操作员授权才允许完成。持久 Plan 接纳回执可只读恢复；真实效果未验证且不作为本批验收前置，C 不启用。

> **Finding 来源身份（2026-10-29，#770 A）**：Job 内来源幂等与 Control 提交幂等分离，跨 Job 相同文本保留独立 Finding/Artifact，冲突拒绝；历史缺失不补造，跨任务关联仍未实现。见[数据架构](architecture/08-data-architecture.md#finding-来源身份770-a)。

> **Pi 大输出（2026-10-29，#765）**：完整 JSON 校验、脱敏 workspace/evidence 双写、128MiB 保存预算与控制帧保留；详见 [CLI 契约](AGENT_CLI_RUNTIME_ADAPTERS.md#pi-大输出与证据765)。生产重跑未验收。

> **平台升级核查（2026-10-21，#740 / #747）**：官方 digest 清单、严格 dotenv 校验和终态 Attempt 效果排空已接通；维护升级新增数据库身份隔离、源库保全、候选库重建与同目标续做模块。宿主入口、受管 SSH 节点和显式回滚恢复已接线，真实单机/多节点成功场景已通过；最终 schema 61 → 62 组合镜像的 16 项 Compose 场景及独立知识后台停写场景已通过并清理，见 [升级演练](../deploy/UPGRADE_REHEARSAL.md)。配置 preflight 已接密钥格式/密文认证与 当前持久默认组合的 credential-first 解析，外部认证等仍列为未检查；P2 宿主实现已接线，正式 tag 签名发布已获授权并接线，生产验收见对应 Release 证据，P3 Web 发起为可选。决策见 [ADR 0008](architecture/adr/0008-maintenance-candidate-upgrade.md)，验收边界见 [风险记录](architecture/12-risks-and-tech-debt.md)。
> **项目知识（2026-10-20，#752）**：schema v61；Job 冻结目录、项目 Memory/Skill 生命周期、精确跨项目 Skill 授权、独立 case×arm 评测、持久回执与管理页见 [PROJECT_KNOWLEDGE.md](PROJECT_KNOWLEDGE.md)。实现状态与模型效果试验分开记录。

> **账号修复审查补强（2026-10-18，#748 / #749）**：普通编辑保留 Claude 独立 tier；上游错误摘要覆盖配置秘密与 C1 控制字符；探测结果回写按配置、CLI 和项目核对；Windows 基线重建支持 CRLF/LF。详见 [`../DESIGN.md`](../DESIGN.md) §8 与 [凭据解析运行时视图](architecture/06-runtime-view.md#凭据与-cli-解析757)。

> **凭据解析同步（2026-10-21，#757）**：Provider/model/项目授权先形成候选，凭据决定 CLI；readiness 与 Job 共用解析，区分全局种子无偏好和用户显式偏好。项目 RoleConfig 不再暴露可写却不生效的 CLI/model，未收紧白名单读取不固化凭据 ID。详见 [运行时视图](architecture/06-runtime-view.md#凭据与-cli-解析757)、[数据架构](architecture/08-data-architecture.md)与[接口规范](architecture/09-interface-specs.md)。

> **当前同步状态（2026-10-18）**：核心设计禁止向后兼容；废弃契约不保留旧 schema/API/UI/运行时路径。#690 已删除 `role_credentials`、`POST /credentials/batch-bind` 与 `RoleConfig.pi_extensions`；Hub 提案 provider/model/extension，Scheduler 在项目授权目录内解析凭据。#674 / #676 把运行镜像收敛为平台目录、Hub 组合角色权威（`image_strategy` / `role_runtime_images` / 项目角色启用白名单已移除）；schema 当前集成编号以 `schema-version.ts` 为准（不作为发布版本承诺）（#690 能力插件运行时；#691 清除项目级能力配置面；#740 平台级全局暂停领取与版本发现；#748 凭据健康类别新增 `model_unavailable` / `quota_exhausted`）；#740 平台镜像按不可变 digest 引用，`DEEPSONAR_IMAGE_TAG` 已删除，`/health.version` 只认 `DEEPSONAR_VERSION`。#626 把凭据资产、角色引用与快照生效拆成三条边界。当前 DSH 迁移选定官方 `@deepseek-ai/dsh@0.2.1-rc.2`：隔离 lockfile + `dsh --profile`、显式 `bundles: []` profile、Gateway-only 短期 token、PTC `run_code`、v4 Session 归档；跨进程持久 resume 明确不支持。根 README 与架构入口仍以本地库/Web 为主路径。开放演进只看 `DESIGN.md` §12 与代码。


> **发布状态核对（2026-10-29）**：[v0.6.0](https://github.com/SummerSec/DeepSonar/releases/tag/v0.6.0) 已于 2026-10-22 正式发布（非 draft / prerelease），包含两份 runtime registry、平台签名证据、Reverse 证据和 Management Skill 附件。本次核对 Release 元数据及附件清单，没有重新执行 registry inspect、验签或部署；发布存在不代表任意部署已升级或已通过运行验收。镜像内容版本与平台 Release 版本分别管理，缓存复用仍须核对 runnable 平台 manifest。发布契约与历史记录见 [`RELEASE_RUNTIME_IMAGES.md`](RELEASE_RUNTIME_IMAGES.md)，Reverse 专题见 [`REA_CLI_CAPABILITIES.md`](REA_CLI_CAPABILITIES.md)。

> **阅读顺序（Agent / 贡献者）**  
> 1. 仓库根 [`DESIGN.md`](../DESIGN.md) — as-built 产品与设计摘要  
> 2. [`architecture/README.md`](architecture/README.md) — 系统规格、架构视图、追溯与 ADR；实现事实与规范要求分开，旧 ARCHITECTURE 按章节历史归档
> 3. 本目录专题文档 — 见下表「状态」列  
>
> **GitHub Issues** 是当前主整改入口；开放演进以 `DESIGN.md` §12 与代码为准，勿把历史方案稿正文里的「现状问题」当缺陷清单。

---

## 状态图例

| 标记 | 含义 |
|------|------|
| **as-built** | 与当前主路径代码对齐的契约/运维说明 |
| **as-built + 历史推演** | 主路径已落地；正文保留旧方案段落仅供对照 |
| **运维/发布** | 部署与镜像发布流程（持续有效） |
| **可选集成** | 默认路径不依赖；文档供联调 |
| **进行中** | 仅部分落地，见文内分段状态 |
| **素材/非产品** | Prompt、品牌等，不是系统契约 |

---

## 系统架构设计

| 文档 | 状态 | 说明 |
|------|------|------|
| [architecture/README.md](architecture/README.md) | **文档基线（#741；2026-10-15）** | 十二篇规格与视图、主题权威归属、逐章迁移、[追溯矩阵](architecture/traceability.md)和[开发 Skill](../.agents/skills/architecture-doc-sync/SKILL.md)；实现事实、规范与验证证据分开 |
| [architecture/adr/README.md](architecture/adr/README.md) | **已采纳决策索引** | 0001–0006 为历史回填；0007–0008 记录暂停回滚及维护身份隔离/候选库升级，验收范围见各条状态与演练记录 |

---

## 契约与 as-built

| 文档 | 状态 | 说明 |
|------|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **历史对照 / 已迁移入口（#741）** | 每个一级章节标注权威目标；现行细则按 architecture 归属表定位，不从旧 MVP 草图推导实现 |
| [AGENT_CLI_RUNTIME_ADAPTERS.md](AGENT_CLI_RUNTIME_ADAPTERS.md) | **as-built** | 当前三类 Agent CLI 适配器、能力、Session 归档+查看器接入清单；DSH 0.2.1-rc.2 profile/SDK smoke、异步子代理完成边界与 v4 归档；**#389 DSH/Pi 解码三类契约与钉死版本夹具矩阵**；leftover Codex/OpenCode 只读 |
| [AGENT_RUNTIME_CONTEXT.md](AGENT_RUNTIME_CONTEXT.md) | **as-built**（#138） | context_id / compaction / 恢复身份 |
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built**（#37） | 领域拆分与锁序；非「待实施」 |
| [AI_NATIVE_TRUSTED_KERNEL.md](AI_NATIVE_TRUSTED_KERNEL.md) | **长期设计提案**（#446；Phase 1 脚手架已落地） | 最小可信执行内核、可组合插件、统一修复反馈、durable receipt、插件准入与分阶段迁移。`RepairFeedback` 契约与 Control API 截断/校验路径已接线 |
| [RUNTIME_IMAGE_REGISTRY_CONTRACT.md](RUNTIME_IMAGE_REGISTRY_CONTRACT.md) | **as-built**（#70 / #417） | 官方镜像 catalog v2、通道、平台/运行时版本轴、`min_runtime_image` fail-closed |
| [RUNTIME_TEST_TOOLCHAINS.md](RUNTIME_TEST_TOOLCHAINS.md) | **as-built** | Kali Test / Verify Base 与 Mobile 工具链边界；#754 Rust ASC 默认、Python 显式回退及真实 APK/双架构验收边界 |
| [RUNTIME_ROLE_IMAGE_MATRIX.md](RUNTIME_ROLE_IMAGE_MATRIX.md) | **as-built**（#565 / #588） | 角色×官方镜像默认、工具范围、不包含、Scheduler 边界注入；#588 起每镜附带 `/opt/deepsonar/manuals` 工具说明书与 CI 门禁 |
| [RUNTIME_TOOL_MANUALS.md](RUNTIME_TOOL_MANUALS.md) | **as-built**（#588） | 14 个官方镜像的离线工具手册契约、发现方式、构建与验收门禁 |
| [语言服务器能力](LANGUAGE_SERVER_CAPABILITIES.md) | #604 受治理 `language-server.clangd`（phase 1） |
| [通用 CLI 能力包](CLI_CAPABILITIES.md) | #611 受治理通用 CLI（`deepsonar.cli-capability/v1`，phase 1） |
| [REA CLI 深度二进制解析](REA_CLI_CAPABILITIES.md) | **v0.5.5 已发布**（#718）：`deepsonar-reverse` canonical digest 与三通道 inspect 证据已回写 bundled registry；原生双架构 OCI、真实 OpenSandbox Job、reverse 发布与不可变 catalog 链；保持项目 opt-in 边界 |
| [Agent Runtime Profiles](AGENT_RUNTIME_PROFILES.md) | #613 Provider / 模型 / CLI 统一运行时 Profile（`deepsonar.agent-runtime-profile/v1`，phase 1） |
| [SHARED_ASSET_BLOB_STORE.md](SHARED_ASSET_BLOB_STORE.md) | **as-built**（#41） | 共享资产 BlobStore fs\|s3 |
| [RELEASE_RUNTIME_IMAGES.md](RELEASE_RUNTIME_IMAGES.md) | **运维/发布** | `v*` tag / release.yml；v0.6.0 正式 Release 与附件已核对，镜像验签和部署验收分别留证；双架构缓存复用须证明 runnable payload 一致 |
| [runtime-image-pull-partial-failure.md](runbooks/runtime-image-pull-partial-failure.md) | **运维 runbook**（#724） | 拉取部分失败：真实尝试计数、定向重拉、本地对账/修复与远端 unsupported 边界、readiness 复核 |
| [ONE_CLICK_DEPLOYMENT.md](ONE_CLICK_DEPLOYMENT.md) | **运维/发布** | Compose 一键部署、真实 readiness 门禁与有界失败诊断；实机兼容性需单独验证 |
| [RELEASE_READINESS_POST_v0.4.4.md](RELEASE_READINESS_POST_v0.4.4.md) | **运维/发布** | v0.4.4→当前 main 升级/部署/合并后验收闭环（#582）；区分代码/CI 已核实与实机延期 |

---

## 历史方案稿（主路径已落地）

正文可能仍写「问题/分期」；**以文首状态与 DESIGN 为准**。

| 文档 | 状态 | 已落地要点 |
|------|------|------------|
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built** | 见上 |

---

[#776 RepairFeedback 基线](REPAIR_FEEDBACK_BASELINE.md)记录 A 阶段错误矩阵与合成契约回放；作为 B 前历史基线保留。

[#776 B 完成修正回执](REPAIR_FEEDBACK_DONE_REPAIR.md)记录 mark_job_done 的持久提案闭环与未验收边界；C0 提供 scoped 引用刷新指引，C1 提供既有 Hub complete 门的有界缺失项反馈；完整 C 和真实模型效果仍待交付。

## 进行中 / 部分落地

| 文档 | 状态 | 说明 |
|------|------|------|
| [TODO_CANVAS_PROCESS_TRUTH.md](TODO_CANVAS_PROCESS_TRUTH.md) | **A as-built · B 主路径可用** | 广播已交付；服务端 `x/y` 是 placement/exchange hint，Web 对当前可见投影布局（≤200 节点由 ELK 排主 DAG 节点/边，root 完成反馈走共享 rail；超阈值固定列）。**全图 `layout_revision` 权威重算暂缓 → #148** |
| [DEVICE_ACCESS.md](DEVICE_ACCESS.md) | **设计（#494）+ Phase 1 as-built（#495）** | 真实设备接入：device broker 把物理设备暴露为可租借网络端点（沙箱不直连设备）、设备租约绑 Attempt、项目 opt-in + 任务级授权、设备机可抛弃隔离与威胁模型；Phase 1（adb-over-TCP/租约/审计）已落地，Phase 2 见文内 |

## 已收口的设计债（#359）

[#359](https://github.com/SummerSec/DeepSonar/issues/359) 五个子单均已合入 main；实施日记见 [`CHANGELOG.md`](../CHANGELOG.md)，as-built 事实见 `DESIGN.md` 对应节。不再把它们当作开放整改项。

| Issue | 结论 | 事实入口 |
|------|------|----------|
| [#390](https://github.com/SummerSec/DeepSonar/issues/390) | DSH 方言归 runtime-sandbox adapter | `docs/AGENT_CLI_RUNTIME_ADAPTERS.md` |
| [#386](https://github.com/SummerSec/DeepSonar/issues/386) | 删除无决策别名；保留项写明权威来源 | `DESIGN.md` §4.1 |
| [#387](https://github.com/SummerSec/DeepSonar/issues/387) | **保留** Fact 证据信任态（与 Finding Verify 分责） | `DESIGN.md` §6.1 |
| [#388](https://github.com/SummerSec/DeepSonar/issues/388) | events / evidence / bus 三职责；拓扑可恢复性；bus 非权威 | `DESIGN.md` §9 |
| [#389](https://github.com/SummerSec/DeepSonar/issues/389) | 解码三类契约与钉死版本夹具；当前 DSH 为 0.2.1-rc.2，旧代夹具仅作历史 viewer 回归 | `docs/AGENT_CLI_RUNTIME_ADAPTERS.md` |

---

## 可选与其它

| 文档 | 状态 | 说明 |
|------|------|------|
| [PROJECT_REVIEW_2026-08.md](PROJECT_REVIEW_2026-08.md) | **评审快照** | 会漂移；P0 已回写 #38 完成；冲突以代码为准 |
| [TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md](TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md) | **素材/非产品** | 对外教程页生成 prompt |
| [brand/](brand/) | **素材** | 图标 brandkit |

---

## 明确不在文档「未完成清单」里的（避免误判）

| 主题 | 事实 |
|------|------|
| #38 / #388 实时流 | **#388 收口**：`ws-ticket` + evidence 补读 + `unpersisted`/`visibility`/`4415`；拓扑结论见 DESIGN §9；bus 非权威 |
| #39 画布 soft-load / delta | **已关**；画布 soft-load / delta 已落地 |
| #144 / #147 | **已关**；长上下文预算、任务定时开始 |
| #100 / #135 / #145 / #152 | **已关**；五 CLI Runtime Adapter + API-only 控制面（无 MCP 回退） |
| #130 / #146 / #151 / #691 | **已关**；运行镜像统一由平台目录准入：项目不再选择镜像来源，也不再钉版本；官方默认可用（`deepsonar-base` 不可停用），第三方由平台 `visible_project_ids` 绑定后项目可启用；Job 创建时冻结平台 digest |
| #244 / #284 | **#284 修订**：官方 stale pin 在 catalog 提升时自动滚到最新 trusted；`pin_ok` / 第三方 / `pin_policy=hold` 仍不自动换；过期且未滚动时 `RUNTIME_IMAGE_PIN_STALE` + 一键升级 |
| #286 / #359 本机镜像闸门 | **已修订**：删除 leftover 本机 Docker inspect 调度闸门；建 Job 不再因 Scheduler 本机缺层拒绝。OpenSandbox 按冻结 digest 在 provision 拉取并重验 |
| #133 / #153 / #154 / #155 | **已关**；minVerifySeverity 收敛、Finding 绑定、人工收口入口 |
| #157 / #158 | **已关**；共享资产孤儿卷回收、官方 `deepsonar-assets-helper` 发布与 busybox pin 回退、provision admission |
| #243 Windows deploy.ps1 | **已关**；UTF-8 BOM + ASCII，避免 PS 5.1 代码页 ParserError；pull/up 与 `deploy.sh` 对齐 |
| #251 任务下发后改标题/内容 | **已关**；`PATCH /tasks/:canvasId` 就地改 title/content，不改写冻结 Job 快照 |
| #257 Chrome / 长工具 stall 误杀 | **已关**；在飞 `tool.call` + 有效 lease 不判停滞；chrome/clickhouse-audit/test/fuzz 有 stall 下限，全局默认仍 900s |
| #263 配置中心 / 运行时护栏 | **Batch 1 as-built**（stall / token 上限 / audit·verify·provision 超时落库 + Web 配置中心）；lease / Reaper 间隔 / Gateway 超时 / 镜像 pins 与巡检仍走 env |
| #267 / #266 官方镜像不预装决策扫描器 | **已关**；工具助力、扫描不决策；Semgrep / gitleaks / shellcheck 与 Chrome 固定扫描入口已从官方运行时移除；Job token / Provider 密钥仍精确 `[REDACTED]` |
| #159 / #160 / #387 | **已关**；Fact 工作台与独立证据信任态保留（#387），不并入 Finding Verify；Session 时间线覆盖当前三类归档 + leftover 只读 |
| #359 / #386–#390 | **已关**；设计债总单收口，见上表 |
| Agent CLI 钉死版本 | Claude/Pi 版本与官方镜像清单对齐；DSH 选定 `@deepseek-ai/dsh@0.2.1-rc.2`，隔离 closure 与 `dsh --profile` 已在仓库验证；**正式沙箱镜像**需 `v*` release 后才含新 CLI |
| #34 增量 ALTER 链 | **刻意搁置**；坚持基线 + 重建库。运维可用 `pnpm db:rebuild` 备份后按列交集回填，不是启动自动升级 |
| #281 rebuild 序列漂移 | **已关**；回填后只 reset public owned sequences，rebuild 结束与 Scheduler 启动自动 `setval` + fail closed，避免 `audit_logs_pkey` / `events_pkey` |
| #148 全图 `layout_revision` | **暂缓设计**；当前采用可见投影优先：默认深度 3、每父节点首批 12、首批总计 24，可稳定继续显示/显式展开全部；常规投影上限 180，搜索和显式链路/节点聚焦不受默认预算裁剪。Web 布局且只导出当前可见投影 |
| #242 态势数据看板 | **P0 as-built**（总量/分布/近 7 日/Top N/活动时间线）；P1 风险与 P2 吞吐未做 |
| #312 用量账本缓存与项目 tab | **as-built**：Gateway 落库缓存读/写；项目账本独立 tab；任务工作台不再内嵌；看板可折叠 |
| #484 项目报告工作台 | **Phase 1 as-built**：统一交付物投影与默认折叠；筛选/抽屉/视觉/按需加载仍待 PR 2–PR 5 |
| 导入导出便携 Secret 加密 / 包签名 | **产品明确不导出明文**；加密包与签名未纳入交付 |

---

## 维护纪律

1. 功能落地后：改 `DESIGN.md`，并更新本索引与对应专题文首 **状态** 行。  
2. 历史方案稿**不要删正文推演**（可当设计考古），但必须在顶部写清 as-built。  
3. 禁止在文首写「待实现」而代码已交付超过一版。  
4. **发版前必须做文档保鲜（硬门）**：改 `CHANGELOG.md` / 打 `v*` tag 之前，按 [`../AGENTS.md`](../AGENTS.md)「发布前的文档保鲜」清单核一遍（版本字面量、已删机制残留、as-built 与代码一致性、本索引状态行与日期、命令与链接），并同步本文件顶部的「当前同步状态」。其中版本字面量、命令、链接与已删机制残留已由 `pnpm ci:unit:docs-freshness` 机检阻断（`as-built 与代码相反` 仍需人工）；漂移修在同一个 release 分支，不留给下一个版本；展开见 [工程规范](architecture/11-engineering-specs.md)与[发布流程](RELEASE_RUNTIME_IMAGES.md)。

- [Skill 适用证据离线校验](../agent-harness/capability-applicability/README.md)：#778 A 补强/B 前置工程切片；合成断言与真实效果分开，不提供推荐。

- [能力证据离线报告](../agent-harness/capability-evidence/README.md)：#778 A 部分实现；仅合成行为测试，实际导出、独立质量评测与推荐接口未验收。

独立研究 #777 的 [离线协议与报告准备](../agent-harness/knowledge-live/STUDY.md) 已提供；真实模型对照尚未运行，不改变 #752 已完成的实现验收范围。

#770 查询增强：现有项目交付页的服务端筛选、游标分页和汇总口径见[接口规格](architecture/09-interface-specs.md#finding-项目查询770-切片-b)（切片 B；2026-10-29）。来源身份由切片 A 独立交付（见本页顶部）；跨任务关系仍待后续交付，不能由查询上线推定已完成。

## #775 设计目标与实现差额

[有界 Intent 设计对照](PLAN_BOUNDED_INTENT_DESIGN.md) 区分 #791 已实现的 B 首片与未交付目标：首次显式 Plan 激活、每 Canvas 一次预算及假执行闭环已有证据；持久 Plan 接纳回执已复用 events.control_receipt，支持原响应恢复及冲突校验；真实模型效果未验证且不作为本批验收前置，C 不启用。

[#776 CLI 离线矩阵](REPAIR_FEEDBACK_CLI_MATRIX.md)记录三CLI九流程的真实代码、合成协议和未验收边界；不是模型质量报告。
