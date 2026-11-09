# DeepSonar 文档索引

#1002 P1-8：[同项目多账号池](architecture/06-runtime-view.md#凭据与-cli-解析757)仅为新 Job 在显式授权、同 Provider/CLI/模型的账号间选择并冻结，沿用默认优先及原 Job 恢复身份/预算门；readiness 不消费轮次，不能借故障自动换 key。隔离 SQL/真实 Gateway 回归已接现有 role-config，最终 SHA Actions 待验。

> 状态：工程实现、最终 SHA 验收与正式发行分别记录；当前修复涵盖 #871/#873/#874，#834 仍暂缓。
> 同步日期：2026-11-09
> **可行动人工请求（2026-11-09）**：严格 guidance、完整 body_json、L0/L1 按需读取、waiting_human 当前 Scheduler 投影及同 Job 待办去重已同步到 [FR-CTRL-004 / FR-WEB-003 / NFR-UX-001](architecture/01-system-specification.md)、[接口/运行时视图](architecture/09-interface-specs.md#可行动人工请求2026-11-09)和[生命周期专题](AGENT_REPAIR_LIFECYCLE.md#可行动人工请求与待办投影)。消息账本、恢复准入、ACK 和完成仍独立；最终 SHA Actions 待验，注意力收益未测量。
> **同 Job 模型失败恢复（#1002 P1-9）**：[契约](MODEL_GATEWAY_TRANSPARENCY.md#job-scoped-model-recovery-1002-p1-9)记录 Pi SDK 的 scoped no-start→新关联模型调用、原 live owner/预算重新准入与跨代际恢复许可。没有 Agent 重启、旧效果重放或退款，unknown/partial/无来源历史拒绝；受控 SDK 与真实 SQL/HTTP 回归已接原 Actions，最终 SHA 待验。
> **#1002 P2-10 清理前诊断读回**：[OpenSandbox 专题](OPENSANDBOX_1_2_UPGRADE.md#provision-失败诊断1002)记录原 append-only audit/Attempt 引用同事务及 Job GET 有界重验投影。无新通知/设置/状态/重放或失败容器保留；SQL/HTTP/受控 Provider 回归已接 Actions，最终 SHA 待验，原始 Engine 日志与现场因果不冒充恢复。
> **Pi 模型预算与截断（#958）**：[预算与恢复专题](PI_MODEL_BUDGET_RECOVERY.md)记录发现声明/显式配置/CLI 观测分层、创建期冻结、同 Session 有界恢复及压缩无进展停止；不扩大权限/额度，不伪造上下文证据。行为回归与实际锁版本 SDK、HTTP/PG 入口已接既有 Actions，最终 SHA 待验；本地与生产验证均未执行。
> **#951 完成失败诊断**：[生命周期专题](AGENT_REPAIR_LIFECYCLE.md#完成失败诊断候选951)登记当前 Attempt 可归属产出、原回执状态和受权限保护证据；有产出不升级成功，不伪造未知字段或自动重放。核心缺诊断已随 #963 合入并工程收口（2026-11-07 核对）；后续提交按各自最终 SHA 另验，全量覆盖和生产归因仍未验证。
> **v0.6.3 本轮范围（2026-11-01）**：独立质量验证/人工标注与隔离调参留出、后续质量门、Host 外部证据认证/当前证书、CAS 晋升及公开强关系建议均暂缓，不阻塞本轮 PR、工程 issue 收口或发布。历史非豁免和未交付质量条款不表示本轮追加卡点；已接线工程测试及权限/CAS/发布抑制边界保留，最终 SHA 的现有 GitHub Actions 适用检查须实际全绿，全部测试/构建/typecheck 仅在 Actions 执行。质量仍 `unknown` / `not_evaluated`、强关系 `published=false`。见[最新范围决定](<../AGENTS.md#豁免范围>)和[评估专题](<PROJECT_FINDING_EVALUATION.md>)。

> **v0.6.16 发布准备（2026-11-07）**。当前候选及前一版本比较基线见[发布专题](RELEASE_RUNTIME_IMAGES.md#发布前门禁)：compare 为 `v0.6.15...v0.6.16`，前一版本取最高既有 tag v0.6.15（其 Release 在 Chrome / ClickHouse 子镜像失败、未形成正式 Release，但仍参与比较，不移动旧 tag）。范围为 #944 与 #958，叠加已合入的 #971–#976、#961 P2/P3、#967、#945、#979，清单见 [CHANGELOG](../CHANGELOG.md)。**2026-11-07 的发布准备基线要求 schema 68**（v0.6.14/v0.6.15 均为 67，schema 68 由 #954/#960 引入，故本版是首个要求 68 的发布；无就地升级路径，非空库须先备份再按 `database/schema.sql` 重建）；该次发布准备不改 schema；后续 #1002 P1-7A 的集成目标见[数据架构](architecture/08-data-architecture.md)，发布时必须按最终源码重核，产品版本只由 tag 注入的 `DEEPSONAR_VERSION` 决定。#984 与 #989 需先合并并通过适用 Actions，之后才打不可变 `v0.6.16`；最终 main Actions 与正式产物成功状态分别核对。

> **全局 Skill 源发布隔离（#954/#960，2026-11-07）**：当前源码将手动/boot/周期 sync 限为候选，只有全局管理主体按候选 hash+epoch 显式批准才发布；既有 live 授权和旧 Job CAS 不迁移，显式撤销 epoch 保持。schema68 元数据、同源 session 锁与 CAS/事务 fence 见[数据归属](architecture/08-data-architecture.md#skill-源已批准目录与候选960)，管理员/项目边界与全局启用影响见[审批接口](architecture/09-interface-specs.md#全局-skill-源候选审批960)。同 hash 有效 live 健康核验可续鲜，不同候选不替 A 续鲜；从未成功为 null/+Inf，既有 Job/Intent 节点原位更新 warning。IR-007/FR-CAP-003/FR-KNOW-002、trace 和视图已同步；回归仅编写/静态核对，schema68 rebuild/恢复与最终 SHA Actions 待验，未运行本地测试、构建、typecheck 或数据库。风险与验收证据分离见[风险登记](architecture/12-risks-and-tech-debt.md#skill-源修复与剩余证据边界960)。

#914 的项目默认账号 UI 切片映射 [FR-CRED-002](architecture/01-system-specification.md#fr-cred-002-providermodel-catalog-与兼容性)及[接口语义](architecture/09-interface-specs.md#项目默认-provider-账号选择914)：显式选择、更换、清除与服务端保存结果，不自动选择替代账号；后端引用一致性由 #925 交付，UI 由 #929 交付；工程证据见[发布基线](RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)，不代表自动重跑或快照改写。

> **数据库直接重建授权（#1002 P2-13）**：[数据库说明](../database/README.md#重建授权保全1002-p2-13)记录源有效 ACL 与默认授权保全、基线/原对象权限同事务发布及触发器/提交前失败拒绝，不猜测角色、不无条件扩大 PUBLIC CREATE；CON-003、数据/工程视图及既有 migrations PostgreSQL 回归已同步，最终 SHA Actions 待验。本地与生产数据库未执行。

> **Job 侧数据库冲突（#945）**：工具活动进度保持 Canvas-first。新 Task/Finding Report 的精确输入字节随 SQL 提交，领取后才投影文件；Verify/orphan 收口现可沿用纯数据库有界重试，成功报告输出仍禁止整体重放。历史缺冻结字节不补造，冲突文件不覆盖，原始 SQLSTATE 与未知效果边界不变；见[运行时视图](architecture/06-runtime-view.md#数据库锁序共享卷与完成恢复871873874)和[数据契约](architecture/08-data-architecture.md#report-输入与文件投影945)。回归覆盖晚期 SQL 回滚、终态重复与文件摘要/归属，最终 SHA Actions 待验，未执行本地测试/构建/typecheck。

> **CI 执行成本与分层（#971–#976/#992，2026-11-08）**：`gate` 为 `gate-contract` / `gate-runtime` / `gate-db-core` / `gate-db-domain` / `gate-e2e` 五个有界并行分片；运行时/锁版本 SDK 与其他契约独立失败重跑，精确修复 #994 两文档白名单；计划解释包含实际事件/变量、checkout commit/tree 与 Git 状态/命中路径；#995 补齐 Reverse 的 PR/main 路由触发并取消输入覆盖回归中的路由豁免，缺项在核心 docs-freshness 阻断。手动 `isolation_probe` 的同 SHA 原生失败重跑已通过；本次进一步核对 base COPY/专用与其他镜像输入，并在核心/Reverse 汇总增加只读成本观测，区分排队、执行和保留结果；三组同形文档对照均成功，详见 [#992 验收记录](CI_COST_ACCEPTANCE_992.md)。`ci-summary` 按 `EXPECTED_GATE_SHARDS` 期望矩阵逐片要求 `success`，完整套件归属以 [`gate-shards.mjs`](../agent-harness/gate-shards.mjs) 的覆盖率断言为准；`prepare-hosted-runner-disk` 改为按 `df -Pk /` 实测空间预算清理（达标即跳过、逐项删且每步重测、全删不足即失败）；`kali-minimal` 去掉重复的 GHA `mode=max` 大层导出，`RUNTIME_CACHE_KALI_GHA` 可切回 `min`/`max`；Reverse 家族按 `reverse`/`claude`/`pi-om` 三份显式依赖清单分流，`package.json` 只对「新增且不被专项消费的 `ci:unit:*` 测试脚本」判无影响；Reverse base 复用默认关闭，开启后每架构只构建一次当前 checkout 的 base 并按不可变标签共享。规范正文见[工程规范](architecture/11-engineering-specs.md#4-测试分层与实际接线)，`gate` 运行计划见 [AGENTS](../AGENTS.md#ci-gate何时触发何时必须等)。文档路由数据不外推为镜像冷/热/失效或 gate 拆片自身收益，这两类对照尚未完成。

> **基础构建输入（#992 前置）**：[CI 专题](CI_COST_ACCEPTANCE_992.md#6-基础构建输入冻结992前置切片)记录 CLI/OM npm closure、Debian signed 快照与 fd 双架构资产冻结；[ADR 0018](architecture/adr/0018-frozen-base-build-inputs.md)记录不回退 live 的取舍。#1001 已合并，历史验收见[交付记录](https://github.com/SummerSec/DeepSonar/issues/992#issuecomment-6713522110)；PR→main 复用及其成本收益仍未交付。2026-11-09 的[缓存加载候选](CI_COST_ACCEPTANCE_992.md#7-ci-缓存解析与加载身份992)修复四个 CI 入口解析 digest 后仍按 tag 加载的问题，新 SHA 完整 Actions 待验。

> **提示与错误反馈统一（#967，2026-11-07）**：全局 Toast 增加 `warn` 语义、同文案去重合并（最多 4 条且优先淘汰非 sticky）、按严重程度分层停留（成功 3.2s / 警告 6s / 错误 8s），错误用 `role=alert` + `assertive`、成功与警告保持 `polite`；悬停与焦点改为两个独立 hold，集合为空才恢复计时，去重刷新在暂停时只收敛预算；每条可手动关闭、详情折叠复制、支持一个恢复动作。页面自有 flash 收敛到 `useFlashMessage`（新提示取消旧定时器、卸载清理），`HelpTip` 支持 Escape 关闭并保留触发器焦点。Toast 颜色改语义 token 并纳入 WCAG AA 断言。实现依据仍是 [注意力原则](../DESIGN.md#核心理念优化人的注意力)与[工程评审正反例](architecture/11-engineering-specs.md#11-注意力成本评审830)；真实浏览器逐主题截图与键盘/触屏回归未执行。

> **注意力原则（#830）**：单一权威定义见 [DESIGN](../DESIGN.md#核心理念优化人的注意力)，开发与贡献入口引用同一[工程评审及正反例](architecture/11-engineering-specs.md#11-注意力成本评审830)。NFR-UX-001 登记约束与验证范围；本次只落实设计/评审依据，不改变运行时、UI 或授权，也不宣称注意力收益。

> **任务目标证据（#767）**：契约、候选、来源隔离评审、非 Finding 结果与确定性报告已接线。可信只读 authority/grant 绑定当前身份、动作、前提和版本，子/系统 Job 统一继承并在 provision/重跑实时重核，见 [ADR 0011](architecture/adr/0011-trusted-target-authorization.md)。独立程序资格由 [#822 操作员评审](PROGRAM_ELIGIBILITY.md) 投影；目标授权、技术 Verify、判据、Plan 完成与资格各自分责。无契约仍 unassessed，验收见[矩阵](TASK_DISPATCH_ACCEPTANCE.md)。

> **任务下发（2026-10-29，#767）**：可选版本化契约、共享场景模板、结构化补充建议及派发前复核见[下发指南](../skills/deepsonar-management/references/task-dispatch.md)与 [FR-TASK-006](architecture/01-system-specification.md#fr-task-006-版本化任务契约与派发前校验)。结构化一致性与真实模型质量收益分开验收；未知身份/写权限不当作已授权。
> **Kernel 平台门禁出口（#1002 P0-3，本分支）**：[生命周期](AGENT_REPAIR_LIFECYCLE.md#kernel-平台门禁出口1002-p0-3)记录现有 Reaper 对内核验证 stopped objective / 修正次数、已知 token 与期限耗尽的本 Hub 非成功停止，原资源清理与固定原因/inconclusive/下一步；不借 directed grant 操作 target，不替换 accepted human/完成，不重放 unknown。真实 Reaper/SQL/停止后 Control 拒绝与隔离历史回归已接 `ci:integration:completion-recovery`，最终 SHA 待验；未宣称任意 platform_blocker 或原 P0-3 全部完成。

> **Plan v2（#775）**：当前执行接口只接收 v2，普通 Hub 的 v1 writer 已删除，历史 audit 仍只读。objective CAS、有限 lifetime 预算、多轮路线及留存输出检查复用既有 Intent admission，持久 continue 消费水位防止终态和重启重计；工程 complete 和输出关联不授予语义完成 authority。#1002 P0-3 为普通自动/idle/非人工 force Hub 唤醒增加停止 objective 门，不回写人工等待、累计预算或 unknown effect；该后续 SHA 的 Actions 待验。该工程切片已随下述 `fdb55a01` 主线 Actions 验收，历史本地回放不是后续 SHA 的证明。见 [ADR 0012](architecture/adr/0012-plan-v2-execution.md)、[运行时](architecture/06-runtime-view.md)与 [Plan 专题](PLAN_GAP_PROJECTION.md)。

> **Finding quality engineering (2026-11-01, #770/#819)**: Identity/relation and lexical/weak-candidate mechanisms remain distinct. The agreed schema67 engineering slice merged via #831 includes protocol/freeze/exposure receipts, exact-bigint CAS, bounded actual-SQL observations/recomputed reports and protected structural review/revoke. [FR-FIND-007/009](<architecture/01-system-specification.md>), [ADR 0014](<architecture/adr/0014-operator-finding-identity.md>) and [evaluation status](<PROJECT_FINDING_EVALUATION.md>) preserve not_evaluated/published=false. Host external-fact verification, current certificates/promotion/guarded publication are missing; independent labels/aliases/provenance, verified family/asset partitions and pre-access adopted thresholds remain unverified. Source-loader capture is TCB evidence, not self-signature or human-quality proof. The engineering slice passed the exact-main Actions listed below and #819 closed within the agreed scope; deferred quality and Host certification/promotion are not delivered.

> **当前稳定性修复（2026-11-04，#871/#873/#874）**：Gateway admission 纯数据库有界重试、SDK error.message 的宿主安全降级 carrier、分候选页独立事务的 Canvas-first 领取与忙锁补槽，以及[跨 Attempt 共享卷生命周期](SHARED_ASSET_BLOB_STORE.md#跨-attempt-共享卷生命周期871)在已合入主线整合；[完成恢复 v1](REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)使用持久宿主事实、去重 Hub 与严格对账/停止提案。main 616d7a36 工程验收见[发布基线](RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)；后续 SHA 另验，显式恢复的新执行代际与 stale Hub 退出见 [#903 生命周期](AGENT_REPAIR_LIFECYCLE.md)，最终 SHA 工程验收单独记录，正式版本状态另行核对。

> **管理效果结清（#1002 P1-9，2026-11-08）**：[单条入口](../deploy/README.md#管理-api-的单条效果结清1002-p1-9)在既有内核增加 admin/同项目 Job/Attempt 限定的 HTTP 见证，精确重复读原结果、不覆盖旧证据；不补写 unknown 用量、不退还额度、不自动恢复 Job。真实 HTTP/SQL 权限、竞争和预算不变已接 recovery，当前最终 SHA Actions 待验；宿主 CLI 的单条/全局计数边界保留。

> **人工等待效果门（#946，2026-11-06）**：[生命周期专题](AGENT_REPAIR_LIFECYCLE.md#人工等待超时与未结清效果946)记录未结清效果/本轮对账进展保留 waiting_human，最终 SQL 覆盖 active/planned 效果，避免进入 human_timeout/终态清理。#957 最终提交的完整 Actions 已通过，核心误判已合入并关闭 #946（2026-11-07 核对）；通知投递计时仍是未交付的独立范围，不冒充已实现。

> **人工等待修正链交接（2026-11-08，#1012）**：[生命周期专题](AGENT_REPAIR_LIFECYCLE.md#人工等待修正链交接1012)记录宿主确认精确 sandbox 消失后原子撤销旧 grants、再收口正常等待 run；所有普通回复/忽略核对原冻结请求策略并通过共享累计额度、暂停、已接受完成与效果门，仅有修正根时核原期限并建立 resume-frozen 代际；具体拒绝回滚消息/节点/状态，重复提交不重复交接，注入与显式 ACK 不合并。#1011 补现有对账 loop 的可达重入，HTTP ready 后精确 owner 销毁/分页核验，缺 key/不可达/资源仍在保持未结清；run/grants/lease 同事务收口，不缩窄 Job 级未知效果门。原清理 SQL 失败→重建 runner/loop 和 key 丢失/恢复→HTTP 续接/Gateway/完成回归已接 recovery，最终 SHA Actions 待验，不声称真实 OS 重启或生产旧 Job 已恢复。

> **修正 token（2026-10-31，#776 / #817）**：复用 Gateway usage ledger 的独立累计熔断、持久额度与未知用量停止，新链未设置、空白或显式 0 时不限，显式正整数才限制，非法显式配置拒绝启动；历史冻结 null/缺失仍关闭，调用前输入成本仍未知。见 [修正回执](REPAIR_FEEDBACK_DONE_REPAIR.md#独立修正-token-用量与额度)。

> **创建与可信显式补冻（#943/#948，2026-11-07）**：[生命周期专题](AGENT_REPAIR_LIFECYCLE.md#缺损快照的可信显式恢复943)记录创建同事务冻结及单 Job rerun-current 的历史预算/宿主执行前证明准入。完整历史求交保留额度、用量和 Attempt；无可信证明、未知效果或耗尽继续拒绝，resume 不替换旧快照。真实 HTTP 恢复、领取/生产 Gateway mint 与无变更负例复用现有 Actions 入口；最终 SHA 待验，不声称生产恢复或模型效果。

> **Pi 大输出（2026-10-29，#765）**：完整 JSON 校验、脱敏 workspace/evidence 双写、128MiB 保存预算与控制帧保留；详见 [CLI 契约](AGENT_CLI_RUNTIME_ADAPTERS.md#pi-大输出与证据765)。生产重跑未验收。

> **平台升级核查（2026-10-21，#740 / #747）**：官方 digest 清单、严格 dotenv 校验和终态 Attempt 效果排空已接通；维护升级新增数据库身份隔离、源库保全、候选库重建与同目标续做模块。宿主入口、受管 SSH 节点和显式回滚恢复已接线，真实单机/多节点成功场景已通过；最终 schema 61 → 62 组合镜像的 16 项 Compose 场景及独立知识后台停写场景已通过并清理，见 [升级演练](../deploy/UPGRADE_REHEARSAL.md)。配置 preflight 已接密钥格式/密文认证与 当前持久默认组合的 credential-first 解析，外部认证等仍列为未检查；P2 宿主实现已接线，正式 tag 签名发布已获授权并接线，生产验收见对应 Release 证据，P3 Web 发起为可选。决策见 [ADR 0008](architecture/adr/0008-maintenance-candidate-upgrade.md)，验收边界见 [风险记录](architecture/12-risks-and-tech-debt.md)。
> **项目知识（2026-10-20，#752）**：schema v61；Job 冻结目录、项目 Memory/Skill 生命周期、精确跨项目 Skill 授权、独立 case×arm 评测、持久回执与管理页见 [PROJECT_KNOWLEDGE.md](PROJECT_KNOWLEDGE.md)。实现状态与模型效果试验分开记录。 #903 的 Knowledge/Skill 分类透传与离线验证边界见[拒绝反馈](PROJECT_KNOWLEDGE.md#knowledgeskill-拒绝反馈903-切片)。 成功业务 Job 自动登记、异步来源准备与历史补做入口见[项目知识专题](PROJECT_KNOWLEDGE.md#成功任务自动登记与历史补做)及[ADR-0020](architecture/adr/0020-scheduler-knowledge-triggers.md)，最终 SHA Actions 待验。

> **账号修复审查补强（2026-10-18，#748 / #749）**：普通编辑保留 Claude 独立 tier；上游错误摘要覆盖配置秘密与 C1 控制字符；探测结果回写按配置、CLI 和项目核对；Windows 基线重建支持 CRLF/LF。详见 [`../DESIGN.md`](../DESIGN.md) §8 与 [凭据解析运行时视图](architecture/06-runtime-view.md#凭据与-cli-解析757)。

> **凭据引用保护（2026-11-05，#914 切片）**：项目范围 impact、全局删除完整性与设置/删除共用凭据行锁已接线；真实 PG 双会话与 scoped HTTP 回归复用 `pnpm ci:integration:credential-delete`。保留空白名单与冻结 Job，不提供新编辑器或自动扩权修复；本句仅描述 #925 服务端切片，#929 已补齐显式默认账号选择与修复导航；工程证据见[发布基线](RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)。详见[接口规格](architecture/09-interface-specs.md#项目凭据引用保护914-切片)。

> **Canvas 引用索引（2026-11-08，#1002 P1-6）**：[数据库说明](../database/README.md#canvas-节点引用索引1002-p1-6)与[数据视图](architecture/08-data-architecture.md#canvas-节点引用索引1002-p1-6)记录边/人工消息节点与 Finding 候选完整外键前缀索引；在已合入主线基线上推进候选版本，不修改 retry 的单事务、外键或项目范围。合成节点/多 generation Finding 级联 SQL 计划与 buffer 对照及实际 HTTP 完整回滚/成功隔离已接 recovery，最终 SHA Actions 待验，生产延迟根因与容量未验证。

> **历史凭据删除（2026-11-08，#1002 P1-7A）**：删除前撤销全部 Gateway token，再脱离秘密凭据，保留 token/用量账本身份及历史有限额度；无凭据 token 仅允许 revoked，不复活旧授权，不自动清配置。impact 历史 token 生成/账本引用计数与 actor 项目隔离复用既有入口，不返回内容；真实账本/预算/HTTP 与精确旧基线重建、备份恢复已接现有 Actions，最终 SHA 待验。详见[历史预算契约](MODEL_GATEWAY_TRANSPARENCY.md#删除凭据与历史预算1002-p1-7a)及[数据架构](architecture/08-data-architecture.md)。

> **凭据解析同步（2026-10-21，#757）**：Provider/model/项目授权先形成候选，凭据决定 CLI；readiness 与 Job 共用解析，区分全局种子无偏好和用户显式偏好。项目 RoleConfig 不再暴露可写却不生效的 CLI/model，未收紧白名单读取不固化凭据 ID。详见 [运行时视图](architecture/06-runtime-view.md#凭据与-cli-解析757)、[数据架构](architecture/08-data-architecture.md)与[接口规范](architecture/09-interface-specs.md)。

> **当前同步状态（2026-10-31）**：当前契约不向后兼容，冻结 Job/证据/审计历史保持不可变。#690 的旧凭据绑定与 RoleConfig Pi 扩展字段、#674/#676 的旧项目镜像机制均已删除；能力、凭据、镜像仍由内核准入和 Job 快照冻结。schema 只按[源码编号](../apps/scheduler/src/schema-version.ts)与[唯一基线](../database/schema.sql)核对；本批 full rebuild 已用固定历史 v62/v63/v64 数据和七张新 relation 表完成 pg_dump/pg_restore 验证，无 pending 项（2026-10-31 主线程证据）。其余当前边界见 [DESIGN](../DESIGN.md) 与[架构索引](architecture/README.md)。


> **集成/发布证据（2026-11-01）**：[#831](https://github.com/SummerSec/DeepSonar/pull/831) 最终 PR 与合并主线 `fdb55a01b1e02b5b9078586923a8d506ce5bb096` 的六个适用 Actions 工作流已全绿，本轮工程 issue 已关闭，schema67 重建/备份恢复已在 Actions 验收。此前本地和较早 SHA 记录保留为历史，不能覆盖新修复。正式 [Release](https://github.com/SummerSec/DeepSonar/actions/runs/41299685948) 的 OpenHarmony Fuzz 新构建失败；匹配工具链和 fresh/reuse 原生 sanitizer 回归须通过正常修复 PR 的 Actions 验收，不能靠缓存命中或重跑旧版本宣称修复。v0.6.3 尚未正式发布，tag 保持原位；已发布 v0.6.2 不变。最终修复 SHA、镜像通道、签名、catalog 与正式附件须实际成功，见[发布专题](<RELEASE_RUNTIME_IMAGES.md#openharmony-specialist-ci-contract>)；暂缓质量和 #833/#834/#835 不替代当前红灯修复。

> **阅读顺序（Agent / 贡献者）**  
> 1. 仓库根 [`DESIGN.md`](../DESIGN.md) — as-built 产品与设计摘要  
> 2. [`architecture/README.md`](architecture/README.md) — 系统规格、架构视图、追溯与 ADR；实现事实与规范要求分开，旧 ARCHITECTURE 按章节历史归档
> 3. 本目录专题文档 — 见下表「状态」列  
>
> **GitHub Issues** 是当前主整改入口；开放演进以 `DESIGN.md` §12 与代码为准，勿把历史方案稿正文里的「现状问题」当缺陷清单。

---

#952/#964 的[退休镜像](DEPRECATIONS.md#软件拒绝边界9642026-11-07-核对)已补软件拦截：旧目录/DB 不复活到市场或准入/pull，新执行 fail closed，历史只读不改写。原文件校验与当前产品投影分开。回归接入既有 CI，最终 SHA Actions 待验；运营清库/GC 未执行且不是本轮工程验收前置。

> **运行镜像治理（#979）**：[旧镜像诊断与恢复](RUNTIME_IMAGE_GOVERNANCE_979.md)记录 DSH 插件缺失、Pi OM 旧 wrapper、已推送产物核验与尚未完成的正式 Release；启动检查不等于线上目录已修复。

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
| [architecture/README.md](architecture/README.md) | **v0.6.3 集成核对（2026-11-01）** | 十二视图、主题归属、[追溯矩阵](architecture/traceability.md)与开发 Skill；实现、规范、当前验证和未交付质量分开 |
| [architecture/adr/README.md](architecture/adr/README.md) | **历史与当前决策索引** | 0009 保持提议、0010 保持已采纳；0011–0014 分别记录目标授权、Plan v2、Pi 记忆、操作员身份，验收缺口见正文 |

---

## 契约与 as-built

| 文档 | 状态 | 说明 |
|------|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **历史对照 / 已迁移入口（#741）** | 每个一级章节标注权威目标；现行细则按 architecture 归属表定位，不从旧 MVP 草图推导实现 |
| [Management Skill](../skills/deepsonar-management/SKILL.md) | **当前契约修复（#996）** | Prompt-only RoleConfig 同步、credential-first 与项目 CLI/Provider 白名单；旧角色开关拒绝、schema 引用保鲜与真实请求体回归接现有 Actions，验证结果以最终 SHA 为准 |
| [AGENT_CLI_RUNTIME_ADAPTERS.md](AGENT_CLI_RUNTIME_ADAPTERS.md) | **as-built** | 当前三类 Agent CLI 适配器、能力、Session 归档+查看器接入清单；DSH 0.2.1-rc.2 profile/SDK smoke、异步子代理完成边界与 v4 归档；**#389 DSH/Pi 解码三类契约与钉死版本夹具矩阵**；[#919 runner 失败来源与已接受完成的限定结算](AGENT_CLI_RUNTIME_ADAPTERS.md#runner-failure-provenance-919)；#947 候选补齐实际 Pi `409:` 完成拒绝格式；#1011 / #1015 主 allowance 通过私有宿主错误身份保留精确完成拒绝并等待 SDK message_end，不放行 usage/未知效果或缺终态，最终 SHA 原生 Pi/OM 与完整 Actions 待验；离线测试不代替最终 SHA Actions；leftover Codex/OpenCode 只读 |
| [AGENT_RUNTIME_CONTEXT.md](AGENT_RUNTIME_CONTEXT.md) | **as-built**（#138） | context_id / compaction / 恢复身份 |
| [Pi 模型预算与截断恢复](PI_MODEL_BUDGET_RECOVERY.md) | **进行中**（#958，源码接线，最终 Actions 待验） | 发现限制与来源、不可变预算、Pi 投影、length 有界恢复、压缩无进展与原生命周期 |
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built**（#37） | 领域拆分与锁序；非「待实施」 |
| [USAGE_LIMITS.md](USAGE_LIMITS.md) | **as-built** | 用量预算默认不限、显式限额、历史冻结策略及保留安全边界 |
| [AI_NATIVE_TRUSTED_KERNEL.md](AI_NATIVE_TRUSTED_KERNEL.md) | **长期提案 + 已实现边界（2026-10-31）** | `RepairFeedback`、目标授权及 Plan v2 工程边界已有实现；完整长期协议、当前回放/组合验证与独立质量分别登记 |
| [PI_OBSERVATIONAL_MEMORY_INTEGRATION.md](PI_OBSERVATIONAL_MEMORY_INTEGRATION.md) | **#815 A 工程与本地镜像准入已验** | canonical 固定发布物、独立 wrapper 指纹、opt-in 冻结配置/模型；OM 专属版本准入与生产内容守卫已验证，镜像证据集中见 RPC 专题 |
| [MODEL_GATEWAY_TRANSPARENCY.md](MODEL_GATEWAY_TRANSPARENCY.md) | **#928 已合入；main 616d7a36 工程验收** | 原始请求/响应、HTTP 边界、显式预算拒绝与 scoped 持久确认；#1002 P1-9 同 Job no-start 模型恢复及跨代际许可已接线，最终 SHA 待验 |
| [PI_OBSERVATIONAL_MEMORY_GATEWAY.md](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) | **#815 B 工程已随 #831 Actions 验收** | 内核 workload 凭据、冻结路由、额度/归因、pending/unknown 与终态撤销；历史 Gateway budget/SQL/HTTP 证据保留原范围，后续修复 SHA、发布与收益结论另计 |
| [PI_OBSERVATIONAL_MEMORY_RPC.md](PI_OBSERVATIONAL_MEMORY_RPC.md) | **#815 C 实际本地镜像 RPC/启动拒绝已验** | 本地 base 镜像身份、canonical package/lock/manifest/wrapper 预检、已安装真实 RPC 与独立生产 guard 正负例的唯一详细记录；#831 工程 Actions 已验收，后续修复 SHA/发布通道及收益另计 |
| [SUPERAGENT_GAP_RESEARCH.md](SUPERAGENT_GAP_RESEARCH.md) | **研究结论（#833）** | DeepSeek Super Agent 与现有设计的差距评估：结论是不新增系统或功能层，已有 Hub/Intent/Job、能力发现、Skill 拉取、项目知识与成果评价覆盖大部分能力；效果改善仍无对照证据，后续只按现有架构推进。 |
| [PI_OBSERVATIONAL_MEMORY.md](PI_OBSERVATIONAL_MEMORY.md) | **#815 A 历史评审背景** | 当前实现细则以上述集成/Gateway/RPC 专题为准；早期比例方案不能覆盖当前显式分配契约，v0.6.2 镜像不含 OM |
| [PROGRAM_ELIGIBILITY.md](PROGRAM_ELIGIBILITY.md) | **#822 as-built 工程边界** | 操作员见证材料与独立评审、证据失效和当前资格投影；不认证外部官方真实性，不授予目标执行或任务完成 authority |
| [RUNTIME_IMAGE_REGISTRY_CONTRACT.md](RUNTIME_IMAGE_REGISTRY_CONTRACT.md) | **as-built**（#70 / #417） | 官方镜像 catalog v2、通道、平台/运行时版本轴、`min_runtime_image` fail-closed |
| [DEPRECATIONS.md](DEPRECATIONS.md) | **下线记录**（#952） | 物理下线能力清单：ClickHouse 运行镜像族的删除范围、保留的不可变历史、既有库清理 SQL 与 fail-closed 边界 |
| [RUNTIME_TEST_TOOLCHAINS.md](RUNTIME_TEST_TOOLCHAINS.md) | **as-built；执行证据另计** | Kali Test / Verify Base 与 Mobile 边界；OH Fuzz 匹配 LLVM/AFL 工具链与原生 sanitizer 回归；#754 Rust ASC 默认、Python 显式回退及真实 APK/双架构验收边界 |
| [RUNTIME_ROLE_IMAGE_MATRIX.md](RUNTIME_ROLE_IMAGE_MATRIX.md) | **as-built**（#565 / #588） | 角色×官方镜像默认、工具范围、不包含、Scheduler 边界注入；#588 起每镜附带 `/opt/deepsonar/manuals` 工具说明书与 CI 门禁 |
| [RUNTIME_TOOL_MANUALS.md](RUNTIME_TOOL_MANUALS.md) | **as-built**（#588） | 11 个官方镜像的离线工具手册契约、发现方式、构建与验收门禁 |
| [语言服务器能力](LANGUAGE_SERVER_CAPABILITIES.md) | #604 受治理 `language-server.clangd`（phase 1） |
| [通用 CLI 能力包](CLI_CAPABILITIES.md) | #611 受治理通用 CLI（`deepsonar.cli-capability/v1`，phase 1） |
| [REA CLI 深度二进制解析](REA_CLI_CAPABILITIES.md) | **v0.5.5 已发布**（#718）：`deepsonar-reverse` canonical digest 与三通道 inspect 证据已回写 bundled registry；原生双架构 OCI、真实 OpenSandbox Job、reverse 发布与不可变 catalog 链；保持项目 opt-in 边界 |
| [Agent Runtime Profiles](AGENT_RUNTIME_PROFILES.md) | #613 Provider / 模型 / CLI 统一运行时 Profile（`deepsonar.agent-runtime-profile/v1`，phase 1） |
| [项目默认模型与创建冲突](architecture/09-interface-specs.md#项目默认模型与创建冲突966) | **#966 候选，最终 SHA 待验** | 启用范围与显式默认模型分开；预检/POST 同源诊断、项目隔离，不自动重试。 |
| [SHARED_ASSET_BLOB_STORE.md](SHARED_ASSET_BLOB_STORE.md) | **as-built**（#41） | 共享资产 BlobStore fs\|s3 |
| [RELEASE_RUNTIME_IMAGES.md](RELEASE_RUNTIME_IMAGES.md) | **运维/发布准备（2026-11-08）** | v0.6.16 正式 Release 元数据已核对；v0.6.17 的 #1011 已聚合 #1002 来源，组合及最终 main 完整 SHA Actions 待验后 tag；schema68 → 当前源码基线、签名/通道 payload 与回写分别留证，不宣称部署通过 |
| [runtime-image-pull-partial-failure.md](runbooks/runtime-image-pull-partial-failure.md) | **运维 runbook**（#724） | 拉取部分失败：真实尝试计数、定向重拉、本地对账/修复与远端 unsupported 边界、readiness 复核 |
| [ONE_CLICK_DEPLOYMENT.md](ONE_CLICK_DEPLOYMENT.md) | **运维/发布** | Compose 一键部署、真实 readiness 门禁与有界失败诊断；实机兼容性需单独验证 |
| [OPENSANDBOX_1_2_UPGRADE.md](OPENSANDBOX_1_2_UPGRADE.md) | **源码升级/资源 init/失败诊断读回（2026-11-09）** | SDK/image 与既有恢复边界不变；same-Engine 声明拒绝和正常清理前的非秘密 Job/Attempt 审计均已接线；组合最终 SHA Actions 待验，逐容器/远端 enforcement、现场并发因果及 D-10 分开保留 |
| [RELEASE_READINESS_POST_v0.4.4.md](RELEASE_READINESS_POST_v0.4.4.md) | **运维/发布** | v0.4.4→当前 main 升级/部署/合并后验收闭环（#582）；区分代码/CI 已核实与实机延期 |

---

## 历史方案稿（主路径已落地）

正文可能仍写「问题/分期」；**以文首状态与 DESIGN 为准**。

| 文档 | 状态 | 已落地要点 |
|------|------|------------|
| [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) | **as-built** | 见上 |

---

[#776 RepairFeedback 基线](REPAIR_FEEDBACK_BASELINE.md)记录 A 阶段错误矩阵与合成契约回放；作为 B 前历史基线保留。

[#776 B 完成修正回执](REPAIR_FEEDBACK_DONE_REPAIR.md)记录 mark_job_done 的持久提案闭环与未验收边界；C0 提供 scoped 引用刷新指引，C1 提供既有 Hub complete 门的有界缺失项反馈；限定 C 实现已交付；独立预算与最后生命周期证据见 [逐项验收及关闭条件](REPAIR_FEEDBACK_ACCEPTANCE.md)，真实模型效果按用户要求不作为验收门。

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
| #257 Chrome / 长工具 stall 误杀 | **已关**；在飞 `tool.call` + 有效 lease 不判停滞；chrome-audit/test/fuzz 有 stall 下限，全局默认仍 900s |
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

- [能力证据离线报告](../agent-harness/capability-evidence/README.md)：#778 选择/拉取/反馈的 v2 只读关联报告；实际 SQL 已有隔离 PostgreSQL 回归，独立质量与收益未验证。

独立研究 #777 的 [离线协议与报告准备](../agent-harness/knowledge-live/STUDY.md) 已提供；真实模型对照尚未运行，不改变 #752 已完成的实现验收范围。

#770 查询增强：现有项目交付页的服务端筛选、游标分页和汇总口径见[接口规格](architecture/09-interface-specs.md#finding-项目查询770-切片-b)（切片 B；2026-10-29）。来源身份由切片 A 独立交付（见本页顶部）；项目词法检索与持久弱候选另见下方专题，不能由查询上线推定强关系质量已验收。

## #775 当前执行与证据边界

[Plan v2 决策](architecture/adr/0012-plan-v2-execution.md)与[运行时视图](architecture/06-runtime-view.md)记录当前 objective CAS、有限 lifetime、多轮路线和依赖输出核验；[设计对照](PLAN_BOUNDED_INTENT_DESIGN.md)保留范围分析。历史每 Canvas 一次补证不再描述当前 v2 执行上限；不把 v1 审计只读当作新执行兼容。旧 writer 已于 2026-10-31 物理删除，ADR-0012 的决策文字保持不变。#1002 的创建初始 objective 绑定最终冻结 Canvas/root 输入见[Plan 专题](PLAN_GAP_PROJECTION.md#用户目标与路线身份)，不自动修补历史目标；对应创建/bootstrap 回归已接入 Actions，最终 SHA 另验。

[#776 CLI 离线矩阵](REPAIR_FEEDBACK_CLI_MATRIX.md)记录三CLI十八流程的真实代码、合成协议和未验收边界；不是模型质量报告。

#767 程序规则附加评审已接线：仅 supplied bounty Finding，通过 program_rule:<ruleid> 独立评价材料规则；不改变通用任务判据，不授予提交资格。见[任务判据评审](TASK_GOAL_REVIEW.md)与[验收矩阵](TASK_DISPATCH_ACCEPTANCE.md)。

#775 的[冻结离线控制回放](../agent-harness/plan-replay/README.md)记录当前 v2 的 SQL/HTTP fixture、17 个 outcomes/traces 和七个注入故障门禁；normal→all7negative→normal 迁移已完成。`report.json` 的 provenance 为 dirty 的其他 commit，不能当作 `5619154f` 精确验收；回放不证明模型质量收益或最终组合 CI。

[Finding 证据追踪](EVIDENCE_TRACE.md)：本片修正来源 Attempt 与宿主实际字节完整性诊断；不认证命令执行、独立复现、knownness 或资格。


#770/#819: [Finding research](<PROJECT_FINDING_RESEARCH.md>), [data architecture](<architecture/08-data-architecture.md>) and [quality engineering](<PROJECT_FINDING_EVALUATION.md>) distinguish the agreed schema67 SQL/receipt/report/review engineering merged via #831 and accepted at fdb55a01 in Actions from deferred current certificates, Host verification, CAS promotion/guarded publication and independent quality. #819 closed only within that engineering scope. Schema66 integration/rebuild and SDK-only #832/schema65-main b1d77c3031f1942e782605bd62772cb70860c7e8 acceptance/merge remain historical; they are not the schema67 evidence. Subsequent #838 repair/final-main checks and formal publication remain separate; quality stays unknown/not_evaluated and strong relations published=false.

#770 非模型验收工具：[Finding 离线评估与积压测量](PROJECT_FINDING_EVALUATION.md)（2026-10-30；工具已合入）。2026-10-31 随 #770 收口，但独立人工质量验收仍记为未执行；生产执行豁免不覆盖该验收。


- [当前 Job 的 Skill 条件建议](SKILL_SUGGESTIONS.md)：#778 本项目精确版本条件匹配、选择声明回执与非模型验收矩阵；不自动启用，不声称效果或成本收益。

- [沙箱 Pi 观测记忆决策](PI_OBSERVATIONAL_MEMORY_DECISIONS.md)与 [ADR 0013](architecture/adr/0013-governed-pi-memory.md)：已定边界保持不变；实际本地镜像 RPC、独立生产 guard 与 OM 专属版本准入已验，细节集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。本轮工程已随 [#831 在 fdb55a01 主线 Actions 验收](<TASK_DISPATCH_ACCEPTANCE.md#831-engineering-acceptance-2026-11-01>)，后续修复 SHA、发布通道/平台与 registry/catalog 仍另验，质量/成本收益 unknown。

发布恢复的 as-built 身份/证据与限制已于 2026-11-05 对照[发布专题](RELEASE_RUNTIME_IMAGES.md#恢复身份与原发布证据)同步；真实恢复未经本次执行。

#899 的[操作员效果结清契约](../deploy/README.md#未知效果的人工结清899)区分单条成功、全局残留和未核验状态；隔离 PostgreSQL/CLI 回归接入 Actions，最终 SHA 工程验收与 s66 现场升级分别留证。

- [运行镜像构建分项量测（#961 P0）](RUNTIME_BUILD_TIMING.md)：分项观测与可信默认分支采集器来源校验已接线；缺少不可变 checkout 或关键输入证据时保持 unknown，不进入正式中位数/P95，旧回填只保留历史观测身份。受控样本仍未累积；P2 的 V8 builder 已随 #961 P2 交付（builder 固定到不可变 digest，不再继承 `BASE_IMAGE`），toolchain 缓存拆分仍未交付；最终候选 Actions 另验，不宣称提速。

- [集成测试共享连接池 teardown 待办清单（#971）](INTEGRATION_POOL_TEARDOWN.md)：三个 gate 长尾套件在 `finally` 末尾显式 `sql.end({ timeout: 5 })`，其余 18 个长尾套件的逐个核对顺序与「未机械批量替换」边界。纯 Node 契约回归见 `apps/scheduler/src/integration-pool-teardown.test.mjs`。#972 的 gate 四分片清单与覆盖率断言见 `agent-harness/gate-shards.mjs`；#973 的按空间预算清盘见 `.github/ci/prepare-hosted-runner-disk.mjs`；#974 的 Kali 缓存导出策略见 `agent-harness/runtime-image-cache-policy.mjs`。以上均不宣称任何提速比例，真实前后对照样本仍待线上累积。

- Reverse 家族子套件分流与 base 复用（#975/#976）：`agent-harness/reverse-suite-plan.mjs` 按 `reverse` / `claude` / `pi-om` 三份显式依赖清单计划，shared 与 routing 输入一律保守全跑；`package.json` 仅「新增且不被专项消费的 `ci:unit:*` 测试脚本」可判无影响，依赖/lockfile/脚本删改/删除改名/解析失败/缺 SHA 全部 fail closed。`reverse-runtime-acceptance` 逐项核对计划与实际。`vars.REVERSE_BASE_REUSE=on` 才启用每架构一次的不可变 base artifact 共享，默认保持原路径。以上均不宣称提速比例，真实前后对照样本仍待线上累积。

- Chrome Fuzz ARM 构建层优化（#961 P2/P3）：V8 编译阶段改用按 digest 钉死的 `V8_BUILDER_IMAGE`，不再继承 `${BASE_IMAGE}`，base 的运行时变化不再使下载/GN/编译层失效；运行时阶段仍跟随本次 base。指纹新增 `ci_src_tag`（`src-ci-<fp>`）与 `release_src_tag`（`src-release-<fp>`）：CI 四个 workflow 只读写前者，`release.yml` 只读写后者，历史 `src-<fp>` 已无消费方，避免 PR 产物让发布跳过真实构建。契约回归见 `agent-harness/image-cache-trust.test.mjs`。真实冷/热/失效三组样本仍待线上累积，本文不宣称提速比例。
- [Pi RPC 大载荷链路（#944 / #990）](PI_RPC_PAYLOAD_LIMITS.md)：帧/分片/预览/重试阈值以专题的核对基线和代码为准。#990 的全部大预览归档关联、索引先于引用、Attempt 已用额度恢复和按源 hash/JSON Pointer 完整回读已接线，最终 SHA Actions 待验；发送侧分片、冻结 knobs、真实 Pi 80 MiB E2E 与容量/质量观测仍未交付。不自动加载大正文，`prompt` 仍不重传。

#1018 的[项目任务队列](PROJECT_TASK_QUEUE.md)集中说明项目 FIFO、占位、失败确认继续、schema 72 与验收边界，最终 SHA Actions 待验。
#1019 的[事实用途与待处理投影](EVIDENCE_TRACE.md#事实用途与待处理投影1019)区分过程记录、当前验证引用与需要处理的证据事项，列表统计限定已加载范围，最终 SHA Actions 待验。
