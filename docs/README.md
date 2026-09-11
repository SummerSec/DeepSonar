# DeepSonar 文档索引

> **当前同步状态（2026-09-06）**：根 README 与架构入口已按本地库/Web 主路径校正；Plane 仅为可选集成。#400 补齐运营指标、查询平面、事件归属与导入续跑契约。**#359 设计债总单已收口**（#390 / #386 / #387 / #388 / #389 均已合入 main）。开放演进只看 `DESIGN.md` §11 与代码。

> **阅读顺序（Agent / 贡献者）**  
> 1. 仓库根 [`DESIGN.md`](../DESIGN.md) — as-built 产品与设计摘要  
> 2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — 架构细则（与 DESIGN 冲突时以 **代码 + DESIGN + schema + OpenAPI** 为准，并回写 DESIGN）  
> 3. 本目录专题文档 — 见下表「状态」列  
>
> **GitHub Issues** 当前可能为空；开放演进以 `DESIGN.md` §11 与代码为准，勿把历史方案稿正文里的「现状问题」当缺陷清单。

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

## 契约与 as-built

| 文档 | 状态 | 说明 |
|------|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **as-built** | 威胁建模、状态机、存储、运行时；本地库/Web 是管理真相，Plane 仅为可选集成 |
| [AGENT_CLI_RUNTIME_ADAPTERS.md](AGENT_CLI_RUNTIME_ADAPTERS.md) | **as-built** | 当前三类 Agent CLI 适配器、能力、Session 归档+查看器接入清单；**#389 DSH/Pi 解码三类契约与钉死版本夹具矩阵**；leftover Codex/OpenCode 只读；版本钉死见 runtime-images |
| [AGENT_RUNTIME_CONTEXT.md](AGENT_RUNTIME_CONTEXT.md) | **as-built**（#138） | context_id / compaction / 恢复身份 |
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built**（#37） | 领域拆分与锁序；非「待实施」 |
| [AI_NATIVE_TRUSTED_KERNEL.md](AI_NATIVE_TRUSTED_KERNEL.md) | **长期设计提案**（#446；Phase 1 脚手架已落地） | 最小可信执行内核、可组合插件、统一修复反馈、durable receipt、插件准入与分阶段迁移。`RepairFeedback` 契约与 Control API 截断/校验路径已接线 |
| [RUNTIME_IMAGE_REGISTRY_CONTRACT.md](RUNTIME_IMAGE_REGISTRY_CONTRACT.md) | **as-built**（#70 / #417） | 官方镜像 catalog v2、通道、平台/运行时版本轴、`min_runtime_image` fail-closed |
| [RUNTIME_TEST_TOOLCHAINS.md](RUNTIME_TEST_TOOLCHAINS.md) | **as-built** | Kali Test / Verify Base 工具链边界 |
| [SHARED_ASSET_BLOB_STORE.md](SHARED_ASSET_BLOB_STORE.md) | **as-built**（#41） | 共享资产 BlobStore fs\|s3 |
| [RELEASE_RUNTIME_IMAGES.md](RELEASE_RUNTIME_IMAGES.md) | **运维/发布** | `v*` tag / release.yml；改 CLI 钉死后需发版才出新镜像 |
| [ONE_CLICK_DEPLOYMENT.md](ONE_CLICK_DEPLOYMENT.md) | **运维/发布** | Compose 一键部署与生产拓扑 |

---

## 历史方案稿（主路径已落地）

正文可能仍写「问题/分期」；**以文首状态与 DESIGN 为准**。

| 文档 | 状态 | 已落地要点 |
|------|------|------------|
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built** | 见上 |

---

## 进行中 / 部分落地

| 文档 | 状态 | 说明 |
|------|------|------|
| [TODO_CANVAS_PROCESS_TRUTH.md](TODO_CANVAS_PROCESS_TRUTH.md) | **A as-built · B 主路径可用** | 广播已交付；服务端 `x/y` 是 placement/exchange hint，Web 对当前可见投影布局（≤200 节点由 ELK 排主 DAG 节点/边，root 完成反馈走共享 rail；超阈值固定列）。**全图 `layout_revision` 权威重算暂缓 → #148** |

## 已收口的设计债（#359）

[#359](https://github.com/SummerSec/DeepSonar/issues/359) 五个子单均已合入 main；实施日记见 [`CHANGELOG.md`](../CHANGELOG.md)，as-built 事实见 `DESIGN.md` 对应节。不再把它们当作开放整改项。

| Issue | 结论 | 事实入口 |
|------|------|----------|
| [#390](https://github.com/SummerSec/DeepSonar/issues/390) | DSH 方言归 runtime-sandbox adapter | `docs/AGENT_CLI_RUNTIME_ADAPTERS.md` |
| [#386](https://github.com/SummerSec/DeepSonar/issues/386) | 删除无决策别名；保留项写明权威来源 | `DESIGN.md` §6.0 |
| [#387](https://github.com/SummerSec/DeepSonar/issues/387) | **保留** Fact 证据信任态（与 Finding Verify 分责） | `DESIGN.md` §4.3 |
| [#388](https://github.com/SummerSec/DeepSonar/issues/388) | events / evidence / bus 三职责；bus 非权威 | `DESIGN.md` §8 |
| [#389](https://github.com/SummerSec/DeepSonar/issues/389) | 解码三类契约与钉死版本夹具；#320/#321 不是完整解码 | `docs/AGENT_CLI_RUNTIME_ADAPTERS.md` |

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
| #38 / #388 实时流 | **已关**；`ws-ticket` + 本机 evidence 补读。bus 只作非权威投递，见 DESIGN §8 |
| #39 画布 soft-load / delta | **已关**；画布 soft-load / delta 已落地 |
| #144 / #147 | **已关**；长上下文预算、任务定时开始 |
| #100 / #135 / #145 / #152 | **已关**；五 CLI Runtime Adapter + API-only 控制面（无 MCP 回退） |
| #130 / #146 / #151 | **已关**；项目镜像策略 `inherit_global` / `project_managed`（项目 RoleConfig 不接受独立 `runtime_image_key`） |
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
| Agent CLI 钉死版本 | 仓库已更新；**正式沙箱镜像**需 `v*` release 后才含新 CLI |
| #34 增量 ALTER 链 | **刻意搁置**；坚持基线 + 重建库。运维可用 `pnpm db:rebuild` 备份后按列交集回填，不是启动自动升级 |
| #281 rebuild 序列漂移 | **已关**；回填后只 reset public owned sequences，rebuild 结束与 Scheduler 启动自动 `setval` + fail closed，避免 `audit_logs_pkey` / `events_pkey` |
| #148 全图 `layout_revision` | **暂缓设计**；当前采用可见投影优先：默认深度 3、每父节点首批 12、首批总计 24，可稳定继续显示/显式展开全部；常规投影上限 180，搜索和显式链路/节点聚焦不受默认预算裁剪。Web 布局且只导出当前可见投影 |
| #242 态势数据看板 | **P0 as-built**（总量/分布/近 7 日/Top N/活动时间线）；P1 风险与 P2 吞吐未做 |
| #312 用量账本缓存与项目 tab | **as-built**：Gateway 落库缓存读/写；项目账本独立 tab；任务工作台不再内嵌；看板可折叠 |
| 导入导出便携 Secret 加密 / 包签名 | **产品明确不导出明文**；加密包与签名未纳入交付 |

---

## 维护纪律

1. 功能落地后：改 `DESIGN.md`，并更新本索引与对应专题文首 **状态** 行。  
2. 历史方案稿**不要删正文推演**（可当设计考古），但必须在顶部写清 as-built。  
3. 禁止在文首写「待实现」而代码已交付超过一版。  
