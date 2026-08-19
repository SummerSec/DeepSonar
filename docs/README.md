# DeepSonar 文档索引

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
| [ARCHITECTURE.md](ARCHITECTURE.md) | **as-built**（正文仍含早期 Plane 叙述，以 § 后半与 DESIGN 为准） | 威胁建模、状态机、存储、运行时；入口一句话已本地优先 |
| [AGENT_CLI_RUNTIME_ADAPTERS.md](AGENT_CLI_RUNTIME_ADAPTERS.md) | **as-built** | 五类 Agent CLI 适配器、能力、Session 归档+查看器接入清单；版本钉死见 runtime-images |
| [AGENT_RUNTIME_CONTEXT.md](AGENT_RUNTIME_CONTEXT.md) | **as-built**（#138） | context_id / compaction / 恢复身份 |
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built**（#37） | 领域拆分与锁序；非「待实施」 |
| [RUNTIME_IMAGE_REGISTRY_CONTRACT.md](RUNTIME_IMAGE_REGISTRY_CONTRACT.md) | **as-built**（#70） | 官方镜像 catalog v2、通道、fail-closed |
| [RUNTIME_TEST_TOOLCHAINS.md](RUNTIME_TEST_TOOLCHAINS.md) | **as-built** | Kali Test / Verify Base 工具链边界 |
| [SHARED_ASSET_BLOB_STORE.md](SHARED_ASSET_BLOB_STORE.md) | **as-built**（#41） | 共享资产 BlobStore fs\|s3 |
| [RELEASE_RUNTIME_IMAGES.md](RELEASE_RUNTIME_IMAGES.md) | **运维/发布** | `v*` tag / release.yml；改 CLI 钉死后需发版才出新镜像 |
| [ONE_CLICK_DEPLOYMENT.md](ONE_CLICK_DEPLOYMENT.md) | **运维/发布** | Compose 一键部署与生产拓扑 |

---

## 历史方案稿（主路径已落地）

正文可能仍写「问题/分期」；**以文首状态与 DESIGN 为准**。

| 文档 | 状态 | 已落地要点 |
|------|------|------------|
| [TODO_DATABASE_IMPORT_EXPORT_PLAN.md](TODO_DATABASE_IMPORT_EXPORT_PLAN.md) | **as-built** | `.deepsonarpack`、项目/平台导入导出；Secret 仅元数据 |
| [HUB_ORCHESTRATION_AND_EVENT_TRIGGER_IMPLEMENTATION_PLAN.md](HUB_ORCHESTRATION_AND_EVENT_TRIGGER_IMPLEMENTATION_PLAN.md) | **as-built + 历史推演** | Hub 唯一决策入口、本地建任务为主 |
| [ROLE_CONFIG_AND_REPORT_PLAN.md](ROLE_CONFIG_AND_REPORT_PLAN.md) | **as-built + 历史推演** | RoleConfig 三层、双轨 Report |
| [RUNTIME_EVIDENCE_AND_GRAPH_OPERABILITY_PLAN.md](RUNTIME_EVIDENCE_AND_GRAPH_OPERABILITY_PLAN.md) | **as-built + 历史推演** | Session 归档、过程流、Job 详情、WS ticket（#38） |
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built** | 见上 |

---

## 进行中 / 部分落地

| 文档 | 状态 | 说明 |
|------|------|------|
| [TODO_CANVAS_PROCESS_TRUTH.md](TODO_CANVAS_PROCESS_TRUTH.md) | **A as-built · B 主路径可用** | 广播已交付；布局为服务端落点+前端 ELK。**全图 `layout_revision` 权威重算暂缓 → #148** |

---

## 可选与其它

| 文档 | 状态 | 说明 |
|------|------|------|
| [PLANE_NOTES.md](PLANE_NOTES.md) | **可选集成** | Plane Cloud 联调笔记；默认路径是 Web 建项目/任务 |
| [PROJECT_REVIEW_2026-08.md](PROJECT_REVIEW_2026-08.md) | **评审快照** | 会漂移；P0 已回写 #38 完成；冲突以代码为准 |
| [TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md](TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md) | **素材/非产品** | 对外教程页生成 prompt |
| [brand/](brand/) | **素材** | 图标 brandkit |

---

## 明确不在文档「未完成清单」里的（避免误判）

| 主题 | 事实 |
|------|------|
| #38 实时流 WS 鉴权 | **已关**；`ws-ticket` + 运行中 stream tail，见 DESIGN §8 |
| #39 画布 soft-load / delta | **已关**；见 DESIGN §11 |
| #144 / #147 | **已关**；长上下文预算、任务定时开始 |
| #100 / #135 / #145 / #152 | **已关**；五 CLI Runtime Adapter + API-only 控制面（无 MCP 回退） |
| #130 / #146 / #151 | **已关**；项目镜像策略 `inherit_global` / `project_managed`（项目 RoleConfig 不接受独立 `runtime_image_key`） |
| #244 | **已关**；官方升版后显式项目 pin 不自动跟随；过期 pin 与最新 trusted 分开，预检/建任务 `RUNTIME_IMAGE_PIN_STALE` + 一键升级 |
| #133 / #153 / #154 / #155 | **已关**；minVerifySeverity 收敛、Finding 绑定、人工收口入口 |
| #157 / #158 | **已关**；共享资产孤儿卷回收、官方 `deepsonar-assets-helper` 发布与 busybox pin 回退、provision admission |
| #159 / #160 | **已关**；Fact 工作台、Agent CLI Session 时间线归一化（#160 起因是 Claude，现覆盖五类归档；画布广播仅在 CLI 归档持久化时展示） |
| Agent CLI 钉死版本 | 仓库已更新；**正式沙箱镜像**需 `v*` release 后才含新 CLI |
| #34 增量 ALTER 链 | **刻意搁置**；坚持基线 + 重建库。运维可用 `pnpm db:rebuild` 备份后按列交集回填，不是启动自动升级 |
| #148 全图 `layout_revision` | **暂缓设计**；过程真相 A 已 as-built，布局继续服务端落点 + 前端 ELK |
| #242 态势数据看板 | **P0 as-built**（总量/分布/近 7 日/Top N/活动时间线）；P1 风险与 P2 吞吐未做 |
| 导入导出便携 Secret 加密 / 包签名 | **产品明确不导出明文**；加密包与签名未纳入交付 |

---

## 维护纪律

1. 功能落地后：改 `DESIGN.md`，并更新本索引与对应专题文首 **状态** 行。  
2. 历史方案稿**不要删正文推演**（可当设计考古），但必须在顶部写清 as-built。  
3. 禁止在文首写「待实现」而代码已交付超过一版。  
