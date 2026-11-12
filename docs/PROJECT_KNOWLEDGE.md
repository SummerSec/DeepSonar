# 项目 Memory 与 Skill

> 状态：#752 生命周期已有实现；本轮项目批量整理、隔离试验和积累/复用投影已进入共享工作树，原候选 `6d96df59` 已通过主 CI 与 Reverse 专项，同步 main 后的候选须独立验收；尚未合并或部署。代码、[schema 基线](../database/schema.sql)和测试是事实入口；模型效果不能由状态机夹具推定。
> 同步日期：2026-11-12

项目知识分为 Memory（有来源的简短事实）和 Skill（触发条件、步骤、输入输出、不适用边界）。两者有稳定身份、不可变版本和 active 指针。草稿、候选和评测资料不进入普通 Job 目录。

## 发现与权限

平台注入保留名称 `deepsonar-skill-discovery`，指导 Agent 搜索、拉取、使用和反馈；保留名称不能被角色配置覆盖。Skill 不持有授权能力，Scheduler 在每个操作中执行权限判断。

项目 Skill 默认私有。来源项目具有 `projects:write` 权限的管理者可授予另一个项目使用**精确版本**，不包含未来版本、不允许接收方转授权，也不包含来源项目的 Memory、Evidence、凭据、网络、工具或镜像权限。授权和安全撤销是管理动作，知识内容晋升由独立评测及审查自动完成，页面没有人工激活入口。

Job 创建时冻结两类目录：

- `job_skill_catalog`：trusted + enabled 全局源减项目禁用，引用 CAS 中不可变的源清单；后续同步不改变旧 Job 的字节。
- `project_knowledge_catalog`：本项目 active 版本，以及明确授予本项目的 Skill 版本；元数据、版本、hash、grant ID 一同冻结。

读取时与当前有效权限取交集，先过滤再搜索、计数和分页。源/项目禁用 epoch、版本 revoke 和授权 revoke 只收紧。重新启用源或新建授权不会复活旧 Job。普通 retire 保留历史冻结版本可读，安全 revoke 则拒绝读取该版本。CAS 完整性失败必须显式拒绝。

## Agent 操作

既有 `list_available_skills` / `search_skills` / `pull_skill` 返回当前 Job 可读 Skill；拉取返回稳定 `usage_ref`，不安装代码或扩大权限。项目 selector 为 `project:<item UUID>@<version>`。

| 操作 | 用途 |
| --- | --- |
| `request_project_knowledge` | 普通 Job 用真实可读来源启动第一次整理，无需已有 work |
| `search_project_knowledge` | 查询冻结目录的有界 metadata |
| `read_project_memory` | 本项目精确版本及 hash 的 Memory 正文 |
| `read_knowledge_input` | 当前 Scheduler 分配的 work/stage/audience 输入 |
| `propose_project_knowledge` | maker 提出 reuse/revise/create/merge/retire |
| `submit_knowledge_evaluation` | evaluator 提交独立 trial 的结构化结果 |
| `review_project_knowledge` | 独立 reviewer 审查并原子结算 |
| `record_knowledge_feedback` | 用实际 usage 和来源证据触发后续整理 |
| `get_knowledge_receipt` | 查询当前 Job 的持久操作回执 |

project、Job、Attempt、actor 和 assignment 均由平台推导，不接受请求自行声明。契约拒绝未知字段。变更经 shared Zod、宿主 handler 和 event-ingestion/application transaction 三层校验，领域写入、事件和 receipt 同事务提交。相同 key + 相同输入返回原结果；变更操作或输入返回冲突。候选 CAS 写入在短事务外完成，失败后的无引用字节保守保留。

`read_knowledge_input` 每页最多 12 KiB UTF-8，返回 `content_fragment`、`encoding=json-utf8` 与 `next_cursor`。保持相同 work/input/hash 读取后续页，拼接后解析 JSON；每页仍重新检查 assignment、audience 和版本撤销。大输入在读取 CAS 前按元数据拒绝，不能用 cursor 读取其他工作或版本。

控制 token 终态失效。历史回执通过 `GET /projects/:id/knowledge/receipts?job_id=...` 或 receipt 详情，以项目管理身份读取；不会为查回执延长执行 token。动态目录读取不使用进程内结果缓存，避免旧成功响应绕过撤销。

## Knowledge/Skill 拒绝反馈（#903 切片）

知识领域拒绝沿 `KnowledgeOperationError` → `PlatformRuntimeHandlerError` → Control HTTP 的既有 `RepairFeedback` 返回；保留稳定 `code`、`category`、可选字段 `path` 和领域 `next_action`，不在 runtime/HTTP 边界仅按 422 重新推断为可修正。Agent 工具响应消费同一反馈，不建立平行错误协议。

- 当前授权与执行仍合法的输入错误保留 `model_correctable`，指向读取当前允许状态并修正输入。`retryable=false` 不妨碍按反馈提交合法修正，但不授权原样自动重放；幂等冲突按归属给出指引：仅已存在的 knowledge key/payload 冲突建议在有权限时读取原 knowledge 回执；Plan/control key 冲突停止并报告原请求归属；usage 身份或已接受 feedback 冲突停止且不覆盖原记录，不假定本次 key 存在回执，不能笼统换 key。`retryable=true` 只用于明确的 `transient_retryable`。
- Job/Attempt 不再活动、operation/scope/assignment 无权限及版本/授权撤销属于 `permanent_failure`，`retryable=false`。行动指引要求停止该调用，由既有管理或恢复入口处理；改参数、换 key、重新启用源均不能复活旧执行权限。
- 全局 Skill 目录的快照缺失、撤权或完整性失败继续 fail closed；治理冻结基线变化、已冻结知识正文/治理方法/建议候选的完整性失败也为 `permanent_failure`，与可修正的请求 hash 错误分开。
- 事件提交后缺少持久结算回执返回 `unknown_external_effect`、`retryable=false`：保留原 key，交 Scheduler 对账事件和回执，不能自动重放或另开提案。

外层 token、Job active 和 allowlist 准入可能先拒绝请求。域/adapter 单元契约与实际 HTTP 可达拒绝分别验证，不能把直接调用 adapter 视为终态请求已通过 HTTP 准入。知识单元与集成入口为 `pnpm ci:unit:project-knowledge` 和 `pnpm ci:integration:project-knowledge`，已由 `.github/workflows/ci.yml` 调用。离线/fake 上游和隔离数据库回归仅证明工程反馈链，不证明真实模型会理解并完成修正；最终执行结果以对应 SHA 的 GitHub Actions 为准。

本切片不改变鉴权、lease/Attempt fencing、预算、幂等或未知效果门；跨 Attempt 新执行代际、Recovery Hub ownership、完成门和 Web 恢复投影仍属 #903 后续范围。

## 工作与结算

`project_knowledge_work` 保存触发去重、stage、generation、当前 Job 和累计预算。Scheduler 为 work 创建独立标准 Canvas；maker、每个 case×arm trial、evaluator、reviewer 都是既有角色的普通 Job，使用现有 Dispatcher、Attempt、沙箱、Model Gateway、归档和终态恢复路径。知识 Job 的终态不触发业务 Hub/Report。

非 reuse 提案固定覆盖 target、negative_trigger、missing_input、cross_project、coexistence、revocation 六类，每类两个 arm，共 12 个独立 trial Job/Attempt/session。create 为 without/candidate，revise/merge 为 baseline/candidate，retire 为 baseline/without；reuse 复用精确已生效版本，不新建这轮候选试验。全部 trial 的普通知识目录、全局 Skill 目录和共享资产下发为空，只读取当前 assignment 的共同任务材料与本 arm 内容；评分规则不会进入 trial。

每例 `evaluation_plan[].task_inputs` 必须显式选择当前 work 已冻结的原始任务材料，两个 arm 取得相同材料，只在候选/基线内容上存在差别；不自动把全部来源复制给所有 trial。prompt 应是每个 arm 均可独立尝试的同一任务；候选正文、原任务最终结论、评分答案和 governor 方法不得充当共同答案。空列表仅适用于 prompt 自带完整输入的任务或明确省略待测材料的 missing_input 用例。这些语义要求由 maker/reviewer 核查，代码校验冻结引用/hash 和 assignment 分配，不能据此宣称平台已识别所有答案泄漏。rubric 以 `evaluation:proposal:<id>` 冻结，绑定 proposal、revision、input_digest、evaluation_plan 和 base_refs，reviewer 另得到 behavior 记录，仅 evaluator/reviewer audience 可读；trial 只注入专用 `deepsonar-project-knowledge-trial` Skill，不注入完整治理 Skill 的固定评分预期。源码见 [work.ts](../apps/scheduler/src/domains/project-knowledge/work.ts)、[proposals.ts](../apps/scheduler/src/domains/project-knowledge/proposals.ts)、[platform-skills.ts](../apps/scheduler/src/domains/project-knowledge/platform-skills.ts)。

trial 实际执行后发布 JSON，再以返回的真实 `version.id`、`version.content_sha256` 构造 `asset:<version UUID>` Evidence 引用；发布 operation ID 不能充当版本。数据必须绑定 case/arm/outcome/observations、独立 Job/最新成功 Attempt、资产版本和内容 hash，cross_project/revocation 还需真实 Control 拒绝审计。执行成功与任务结果分开：trial Job 可成功记录一次 target `fail`；candidate target 和所有安全组仍须 pass。target comparator 的 fail 可作为 without/baseline 差异观察，不再要求无知识组也解决任务才能激活候选；retire 的目标 arm 为 without。`unexecuted`、矩阵缺项/重复、缺证、未知效果一律不能激活。源码见 [evaluation.ts](../apps/scheduler/src/domains/project-knowledge/evaluation.ts)、[settlement.ts](../apps/scheduler/src/domains/project-knowledge/settlement.ts)、[发布回执](../apps/scheduler/src/shared-asset-publish-control.ts)；通过软件门禁不等于真实模型收益已证明。

首次 create 候选进入 `needs_eval` 后，修订必须引用此前提案并沿用其隔离草稿身份，追加新版本；不能覆盖评测中的候选、其他工作链的草稿或已激活身份。旧版本正文与来源保持不变。

预算为累计 32 Jobs、1800 秒、最多 2 次候选修订。提案准入和试验派发都计算完整剩余 case×arm，并为 evaluator/reviewer 预留 2 个 Job；不足则拒绝或阻断，不先创建无法收敛的部分矩阵。工作领取短事务完成；创建与关联 Job 使用现有事务内创建原语，保持 Canvas → Job → work 的锁顺序。重启扫描已持久的 assignment 和 Job 终态；unknown/orphan 不自动重放。治理 hash 改变时旧 work 保持 `blocked/governance_baseline_changed`，不改历史快照、回执或累计预算。整链 token 预算未在本轮新增，不能把 Job/时间预算写成共享 token 额度。

自动项目批次的全部阶段以 `assignment.source_mode=project_collection` 标识，与所有 trial 一起在创建期经 [job-isolation.ts](../apps/scheduler/src/domains/project-knowledge/job-isolation.ts) 收紧快照：工具取已准入 allowlist 与 stage 工具的交集，`allow_egress=false`，清除角色预加载 skills/modules/commands/MCP/subagents/instructions 和共享资产；不授予角色本来没有的 operation。trial 再清空冻结知识/全局 Skill 目录，仅保留专用试验指导与分配输入。原有 Job 快照不可改写。隔离环境不能满足任务时如实记录 unexecuted，不能为得到结果自动放宽网络或工具。

reviewer 与 maker/evaluator 必须不同 Job，绑定 proposal revision、输入 digest、来源、baseline generation 和治理 hash。全部硬门通过才切 active 指针。merge 的目标激活与来源 retire 在同一事务，冲突或拒绝保留旧 active。版本正文及 provenance 不可改写；revoke tombstone 不可清除。

治理方法由平台 `deepsonar-project-knowledge` Skill 提供，代码保有项目范围、权限、预算、独立性、证据和结算硬门。项目治理方法的修订也必须经过相同流程，不改变当前 work 的冻结基线。

## 管理与存储

项目“知识”页在目录前显示紧凑的积累/复用汇总与最近工作进展，工作详情和跳过原因按需展开，受阻原因使用中文并链接现有 Job/Canvas；目录、历史版本、来源、评测/审查、usage/反馈和精确授权沿用原入口。刷新复用现有页面触发，不新增定时轮询，项目与刷新身份隔离迟到响应。分页 API 以项目管理权限读取；草稿仅管理面可见，不能据此获得跨项目候选访问权。组件见 [ProjectKnowledgeActivity.tsx](../apps/web/src/pages/ProjectKnowledgeActivity.tsx)。

六张领域表为 work、items、versions、proposals、evaluations、receipts；assignments、grants、usages 是权限和执行基础记录。项目/Job/Attempt 复合外键防止伪造 provenance，receipt 和 evaluation 只追加。Skill bundle 仅允许 `SKILL.md` 与安全路径下的文本 references，总量 128 KiB / 20 文件。

`planKnowledgeBlobReachability` 提供只读离线根审计：所有历史版本（含 retired/revoked）、work/assignment 输入、历史 Job 目录、源清单及共享资产版本均保留。#960 将全局源的 `catalog_snapshot_hash` 与待批 `candidate_hash` 都作为同类 `skill_source` 根；候选字节保留至指针被覆盖/清除或 source 删除，移除某个引用不移除其它历史 Job/版本保留根。保留不是授权，新 Job 仍只冻结已批准 live 指针。没有引用的索引字节也仅列为保留项，当前没有自动 GC（`deletion_enabled=false`）。[现有真实 PG 可达性回归](../apps/scheduler/src/domains/project-knowledge/reachability.integration.test.ts)覆盖候选覆盖/删除后的根变化及冻结 live，沿既有知识集成 CI 入口；本次仅编写和静态核对，未执行本地测试。

## 验证与运维

全部测试、构建、typecheck 仅在 GitHub Actions 执行。本轮静态核对 [package.json](../package.json) 与 [ci.yml](../.github/workflows/ci.yml)：`pnpm ci:unit:project-knowledge`、独立 `TEST_DATABASE_URL` 下的 `pnpm ci:integration:project-knowledge`、`pnpm ci:unit:web-facts` 已有工作流入口；新增 [collector](../apps/scheduler/src/domains/project-knowledge/collector.integration.test.ts)、[闭环合成记录](../apps/scheduler/src/domains/project-knowledge/closed-loop.integration.test.ts)、[activity](../apps/scheduler/src/domains/project-knowledge/activity.integration.test.ts)、[快照隔离](../apps/scheduler/src/job-creation.integration.test.ts)、[调度唤醒](../apps/scheduler/src/knowledge-wake.integration.test.ts) 和 [Web 交互](../apps/web/src/ProjectKnowledgeApi.test.ts) 回归已接线。[behavior-policy 独立单测](../apps/scheduler/src/domains/project-knowledge/behavior-policy.test.ts)覆盖允许 target comparator fail，以及 candidate 失败、安全任一 arm 失败、unexecuted、重复/缺项仍拒绝的边界。原候选的 Actions 证据见下文；同步 main 后的候选仍须独立验收，未合并、未部署。集成 helper 为每例创建临时数据库并套当前基线，不能指向业务默认数据库。历史记录中的通过结果不代表本轮最终 SHA 通过。

### PR #1076 的候选验收记录（2026-11-12 核对）

提交 `6d96df59119739becffd31a59696451167366af7` 的[主 CI](https://github.com/SummerSec/DeepSonar/actions/runs/43012390072)和 [Reverse 专项](https://github.com/SummerSec/DeepSonar/actions/runs/43012390067)已成功；包含工作区 typecheck/build、知识单元与 PostgreSQL 集成、Web 回归和适用运行时检查。collector 回归覆盖瞬态故障保留待处理资格、持久退避与重启后唤醒、恢复时并发仅创建一个 work、第三次失败明确终止及提交响应丢失先对账。闭环使用合成执行证据，不证明真实模型收益。

上述通过结果只属于该提交；本次同步 main 的 Pi 重试结算变更并解决文档冲突后，必须重新核对最终 head 的主 CI 和所有适用专项。本机仅静态复核与 `git diff --check`，不运行测试、构建或 typecheck，不合并 PR、不部署，也不做真实模型试验。

早期分支曾由 v59 升为 v60，使用基线重建；当时已在独立 PostgreSQL 16 容器执行 `pnpm db:rebuild -- --plan` / `--apply`，验证备份可恢复为 v59、列交集回填保留项目记录且目标为 v60。生产部署、生产库重建和长期模型效果试验均应在单独授权的环境进行。

### 2026-10-21 审查验收边界

本轮在 main `c5a1e7e0` 基础上复查 #756，补齐 create 候选的同身份修订与 PostgreSQL 回归；并发 Scheduler 领取、重建 Scheduler 实例后的未知效果停止及累计预算耗尽都有可复跑数据库断言。测试入口仍为上述知识集成脚本，并由常规 CI 调用。Reverse 真实 Job 验收夹具也必须先持久化 Skill 源 CAS 清单，再冻结全局和项目知识目录；直接插入旧形态快照会被运行时以 `JOB_SKILL_CATALOG_MISSING` 拒绝。数据库回归同时验证旧夹具拒绝与当前快照的搜索/拉取成功。

这些测试使用合成任务/评测记录，证明存储、状态转换和权限硬门；不证明 LLM 能正确生成、独立评测或审查方法。专用授权烟测的固定模型响应也只能证明 Dispatcher/OpenSandbox/Control API 授权链路。完整模型验收仍须保存任务 A 的 maker → case×arm trial → evaluator → reviewer → 激活，以及任务 B 的精确版本使用 → 失败反馈 → 同身份修订的 Job/Attempt/Receipt/Evidence、模型版本、用量和退出码。#752 已按用户明确不走真实模型验收的范围，以 #756 实现、隔离集成/重建测试和 CI 完成关闭；真实模型闭环与收益验证属于独立后续 #777，不重开或改写 #752 的完成条件。没有真实证据仍不得宣称生产模型效果已验收。

本轮未调用付费模型、未接触业务数据。该最终试验需要独立空白 Linux Docker 主机、测试数据库、已准入不可变 runtime digest、仅测试用途的模型配置，以及明确的调用费用上限；凭据应通过已有 Model Gateway 配置，不能写入文档或证据。

真实模型闭环的隔离驱动、预算限制与未完成验收说明见 [knowledge-live 准备入口](../agent-harness/knowledge-live/README.md)。该入口只经过离线验证；不代表已执行付费模型验收。

历史上集成 #758 后知识基线为 v61；以下 v60/v61 重建记录不是当前集成版本或本轮验收，当前基线只认 [schema-version.ts](../apps/scheduler/src/schema-version.ts) 与 [schema.sql](../database/schema.sql)。当时 main v60 的凭据来源规则与 `rebuild --reset-role-identity` 显式确认保持不变，知识表没有复用凭据变更的版本号。

本次集成以 main `5b0d9b1f` 的实际 v60 SQL 在全新隔离 PostgreSQL 16 库建立基线，运行 v61 rebuild apply（保留 staging）后复制 63 张表，核对项目记录、显式全局 CLI/model 保留及 9 张知识表建立；迁移套件 22/22、知识集成 24/24 通过。未操作生产库。

### #777 独立效果研究

离线协议、合成案例、预检和待运行报告模板见 [对照研究协议](../agent-harness/knowledge-live/STUDY.md)。当前仅准备材料；真实 A→激活→B 使用→反馈→同身份修订、重复对照与收益判断均 pending。报告复用既有 Job/Attempt/work/receipt/usage 引用，不新增执行器、知识晋升审批或数据库表。

### #778 条件建议与选择声明

当前 Job 可在显式授权后使用 `suggest_project_skills` 查看本项目精确 Skill 的条件匹配，再用 `record_skill_choice` 记录 select/reject/none。宿主重算和撤权复查；选择回执不生成 usage 或触发 work，实际拉取/反馈仍走原链路。作者条件、调用者目标和独立效果分开，token 余额与质量未知时不伪造证据。协议、非模型验收和后续边界见[Skill 建议专题](SKILL_SUGGESTIONS.md)。

## 来源登记与项目批量整理

本轮用户明确授权自动项目整理，[ADR 0022](architecture/adr/0022-project-knowledge-collection.md) 取代 [0021](architecture/adr/0021-knowledge-source-preview.md) 中项目批处理暂缓的限制；0021 的历史决定保留。成功业务 Job 的登记仍仅在原终态事务/savepoint 中向 append-only `audit_logs` 写 `project_knowledge.source_registered`（`system/scheduler`、`result=ok`），记录 Job/Attempt/Canvas 与 Fact/Evidence 存在标记；不在终态事务中复制正文或创建模型 Job。登记失败隔离并告警，不回滚业务成功。登记不保证来源正文保留，不是候选或产物。

[collector.ts](../apps/scheduler/src/domains/project-knowledge/collector.ts) 由既有 Dispatcher tick 调用，[knowledge-wake.ts](../apps/scheduler/src/knowledge-wake.ts) 从持久未处理登记计算下一次唤醒，不新增轮询执行器。每批至多 4 个来源 Job、合计至多 19 个来源输入（Fact、Evidence 及其授权资产），另可带一个冻结 governor 版本；保留原观察的 verification_status，不把采集变为验证。collector 在项目已有非旧自动 `pending/running` work 时等待，不再建立并行项目批次；这不是给全部 Agent 显式请求新增数据库唯一约束。完成/阻断批次不会重新构造同一来源来重置预算。旧 `knowledge:auto:` work 仍不自动开始后续阶段，其在途执行和历史记录不被取消或改写。

来源解析与 CAS 字节准备在短 SQL 事务外进行；项目行锁下重新检查项目活动、最新成功 Attempt、冻结 `request_project_knowledge` 权限、未结算效果、当前来源/hash、既有处理及 governor 版本，再原子建立 `knowledge:project:` work 和逐来源 `project_knowledge.source_collected` 审计链接。链接保存 `registration_id`、`work_ref`、`attempt_id`、`input_count`、`manifest_sha256`，最后一项为该来源冻结 manifest 的 canonical SHA-256，保留来源执行身份与输入摘要而不在审计中复制正文。无新 schema、迁移或第二份经验账本。

超大来源、失权、未知效果等永久拒绝，以及瞬态来源准备失败累计三次耗尽后写 `project_knowledge.source_collection_skipped`（`system/scheduler`、`result=error`，安全 `error_code`/`after_json.reason`）。瞬态故障按下文持久退避，不能因一次准备失败永久消费来源；登记经 collected/skipped 消费后不再被 collector 自动重建。未结算/unknown 效果仍走原对账边界，跳过不是已解决，也不授予重放权限。各项目间隔离，项目行锁和同事务链接用于并发/restart 去重；具体实现见 [collector-sources.ts](../apps/scheduler/src/domains/project-knowledge/collector-sources.ts) 与 [scheduler](../apps/scheduler/src/project-knowledge-scheduler.ts)。

`GET /projects/:id/knowledge/backfill` 保留项目读权限内的历史资格只读预览；不返回正文、不登记历史来源、不启动整理，没有 POST 历史执行入口。自动 collector 只消费已经持久登记的来源，不把预览自动升级为下发授权。整链 token 预算和 schema 改动仍不在本轮范围。

## 积累与复用可见性

`GET /projects/:id/knowledge/activity?limit=10&offset=0` 要求 `projects:read` 与严格项目 scope；分页默认 10、最多 50，拒绝未知字段，授权范围内项目不存在返回 404。返回 `summary`、工作 `items`、`next_offset` 和最多 10 条去重 `skipped_sources:[{job_id,reason,at}]`。错误原因仅返回安全已知码或通用提示，不返回来源正文、manifest、模型反馈正文和跨项目信息。实现见 [activity-routes.ts](../apps/scheduler/src/domains/project-knowledge/activity-routes.ts)、[activity.ts](../apps/scheduler/src/domains/project-knowledge/activity.ts)、[Web 契约](../apps/web/src/ProjectKnowledgeApi.ts)。

| 投影 | 口径与证据边界 |
| --- | --- |
| `registered_sources` | 本项目成功 system/scheduler 登记按源 Job `resource_id` 去重；24 个登记不表示 24 个产物 |
| `collected_sources` / `skipped_sources` / `pending_sources` | 采集通过同项目 `after_json.work_ref` 关联 work；跳过来自 error 审计。待采集排除已采集或已跳过的去重并集，重叠不重复扣减；已采集含排队批次，仅表示已纳入整理 |
| `active_memory` / `active_skills` / `draft_items` | 本项目 active 且未撤销的版本与本项目草稿；不把全局源或其他项目 grant 当成本项目新产物 |
| `completed_work` / `blocked_work` | 工作流程状态，不是激活产物数或质量通过数 |
| `usage_count` / `feedback_count` / `successful_feedback` | 消费项目与 `owner_project_id` 都是本项目；排除全局和跨项目使用。拉取不证明实际采用，反馈及 success 仅为模型报告，保留 usage/provenance，不宣称效果已证明 |

工作项只含 id/state/stage/reason、Job 数、累计运行秒、当前 Job/Canvas 引用、创建/更新时间、可选最新提案状态及 `source_count`。来源数按 source_collected 的 work_ref 关联去重；没有采集链接的显式 work 仅在存在 origin Job 时按 1 回退。Job/Canvas 链接继续受原接口权限控制。

### 故障退避、试验上下文与修订

单条来源的永久拒绝只记录该来源的跳过，不吞掉同批正常来源。CAS/数据库准备的瞬态失败通过 `project_knowledge.source_collection_retry` 保存代次和下次时间，间隔 30 秒，最多 3 次；耗尽后明确跳过。既有 knowledge-wake 从同一审计恢复最早到期时间，不另设轮询。失权、未知外部效果和预算耗尽不按瞬态重放，已创建/阻断的 work 不因此重建。

自动采集产生治理引用后，原任务按既有 `TASK_DELETE_KNOWLEDGE_RETAINED` 守卫保留：清空历史的硬重试/删除可能被拒绝，不能为重跑而删除来源、工作或回执。后续执行使用保留历史的受治理入口或新任务；这一保留成本不能被“自动积累”隐藏。

trial 保留可信的 `deepsonar-control` 与专用执行 Skill，不携带评分答案。共存用例为各 arm 分配相同的平台授权中性 trace Memory；这是固定工程用例上下文，不是项目积累或模型收益。自动批次与 trial 清理业务扩展、角色环境与手工配置，只重新物化连接必需的 Provider 配置，并重新冻结 Runtime Profile/launch。资产型 Evidence 同时冻结原 Job 有权读取的真实资产版本字节，不能只给 maker 描述和 hash。

实际 usage 的反馈 work 还冻结精确 usage/版本与 outcome/next_action，修订 maker 读取绑定上一 proposal/revision/input_digest 的评测、审查意见和失败原因。普通 Job 启动时只获得有界的冻结知识数量与按需查询指引；不把知识正文或整目录默认注入。独立 Verify/Review、报告和治理 Job 不接收该复用指引。读取、模型反馈与真实质量收益继续分开报告。

### 注意力成本

| 行为 | 减少的人工负担 | 新增代价与约束 |
| --- | --- | --- |
| 有界自动采集 | 无需逐个成功 Job 手动发起整理，同项目来源合批 | 自动模型工作消耗既有累计预算；一次仅准入一个项目批次，永久拒绝持久跳过；瞬态失败持久退避，不自动提额 |
| 目录前汇总与最近工作 | 直接区分登记、排队、候选、生效、拉取和模型反馈，快速定位阻塞 | 增加一行汇总与列表；正文/原因按需展开，复用刷新，不新增通知、设置或定时轮询 |
| 独立试验与证据边界 | 避免人工把模型自述当收益或把来源数当产物数 | 每轮 12 个 trial 加 evaluator/reviewer 的成本，语义可比性仍需审查；注意力和质量收益未测量 |

Barry 的全局 Git Skill 源通过既有 trusted + enabled 同步机制接入，仓库公开性和维护由来源所有者管理；同步现有 Skill 不代表业务任务产生了新沉淀，本版也不自动回写 GitHub。
