# 项目 Memory 与 Skill

> 状态：#752 实现；同步日期：2026-10-21。代码、schema v61 和测试是事实入口。模型效果与生产试验结果需要独立记录，不能由状态机夹具推定。

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

## 工作与结算

`project_knowledge_work` 保存触发去重、stage、generation、当前 Job 和累计预算。Scheduler 为 work 创建独立标准 Canvas；maker、每个 case×arm trial、evaluator、reviewer 都是既有角色的普通 Job，使用现有 Dispatcher、Attempt、沙箱、Model Gateway、归档和终态恢复路径。知识 Job 的终态不触发业务 Hub/Report。

试验组按动作选择 without / baseline / candidate；每组独立 Job、Attempt 和 session。试验 Job 的常规项目知识目录与共享资产下发为空，只能读取该组分配的输入。固定覆盖 target、negative_trigger、missing_input、cross_project、coexistence、revocation。缺环境、缺证据、终态异常或未知外部效果保留 needs_eval/blocked，不能把说明文字当作执行成功。

首次 create 候选进入 `needs_eval` 后，修订必须引用此前提案并沿用其隔离草稿身份，追加新版本；不能覆盖评测中的候选、其他工作链的草稿或已激活身份。旧版本正文与来源保持不变。

预算为累计 32 Jobs、1800 秒、最多 2 次候选修订。工作领取短事务完成；创建与关联 Job 使用现有事务内创建原语，保持 Canvas → Job → work 的锁顺序。重启扫描已持久的 assignment 和 Job 终态；unknown/orphan 不自动重放。

reviewer 与 maker/evaluator 必须不同 Job，绑定 proposal revision、输入 digest、来源、baseline generation 和治理 hash。全部硬门通过才切 active 指针。merge 的目标激活与来源 retire 在同一事务，冲突或拒绝保留旧 active。版本正文及 provenance 不可改写；revoke tombstone 不可清除。

治理方法由平台 `deepsonar-project-knowledge` Skill 提供，代码保有项目范围、权限、预算、独立性、证据和结算硬门。项目治理方法的修订也必须经过相同流程，不改变当前 work 的冻结基线。

## 管理与存储

项目“知识”页提供目录、历史版本、内容对比、来源、评测/审查、usage/反馈和精确授权。分页 API 以项目管理权限读取；草稿仅管理面可见，不能据此获得跨项目候选访问权。

六张领域表为 work、items、versions、proposals、evaluations、receipts；assignments、grants、usages 是权限和执行基础记录。项目/Job/Attempt 复合外键防止伪造 provenance，receipt 和 evaluation 只追加。Skill bundle 仅允许 `SKILL.md` 与安全路径下的文本 references，总量 128 KiB / 20 文件。

`planKnowledgeBlobReachability` 提供只读离线根审计：所有历史版本（含 retired/revoked）、work/assignment 输入、历史 Job 目录、源清单及共享资产版本均保留。没有引用的索引字节也仅列为保留项，当前没有自动 GC。

## 验证与运维

运行 `pnpm ci:unit:project-knowledge`；设置独立 `TEST_DATABASE_URL` 后运行 `pnpm ci:integration:project-knowledge`。集成 helper 为每例创建临时数据库并套当前基线，不能指向业务默认数据库作为测试真相。

早期分支曾由 v59 升为 v60，使用基线重建；当时已在独立 PostgreSQL 16 容器执行 `pnpm db:rebuild -- --plan` / `--apply`，验证备份可恢复为 v59、列交集回填保留项目记录且目标为 v60。生产部署、生产库重建和长期模型效果试验均应在单独授权的环境进行。

### 2026-10-21 审查验收边界

本轮在 main `c5a1e7e0` 基础上复查 #756，补齐 create 候选的同身份修订与 PostgreSQL 回归；并发 Scheduler 领取、重建 Scheduler 实例后的未知效果停止及累计预算耗尽都有可复跑数据库断言。测试入口仍为上述知识集成脚本，并由常规 CI 调用。Reverse 真实 Job 验收夹具也必须先持久化 Skill 源 CAS 清单，再冻结全局和项目知识目录；直接插入旧形态快照会被运行时以 `JOB_SKILL_CATALOG_MISSING` 拒绝。数据库回归同时验证旧夹具拒绝与当前快照的搜索/拉取成功。

这些测试使用合成任务/评测记录，证明存储、状态转换和权限硬门；不证明 LLM 能正确生成、独立评测或审查方法。专用授权烟测的固定模型响应也只能证明 Dispatcher/OpenSandbox/Control API 授权链路。完整模型验收仍须保存任务 A 的 maker → case×arm trial → evaluator → reviewer → 激活，以及任务 B 的精确版本使用 → 失败反馈 → 同身份修订的 Job/Attempt/Receipt/Evidence、模型版本、用量和退出码。#752 已按用户明确不走真实模型验收的范围，以 #756 实现、隔离集成/重建测试和 CI 完成关闭；真实模型闭环与收益验证属于独立后续 #777，不重开或改写 #752 的完成条件。没有真实证据仍不得宣称生产模型效果已验收。

本轮未调用付费模型、未接触业务数据。该最终试验需要独立空白 Linux Docker 主机、测试数据库、已准入不可变 runtime digest、仅测试用途的模型配置，以及明确的调用费用上限；凭据应通过已有 Model Gateway 配置，不能写入文档或证据。

真实模型闭环的隔离驱动、预算限制与未完成验收说明见 [knowledge-live 准备入口](../agent-harness/knowledge-live/README.md)。该入口只经过离线验证；不代表已执行付费模型验收。

集成 #758 后当前知识基线为 v61；main v60 的凭据来源规则与 `rebuild --reset-role-identity` 显式确认保持不变。知识表不复用凭据变更的版本号。

本次集成以 main `5b0d9b1f` 的实际 v60 SQL 在全新隔离 PostgreSQL 16 库建立基线，运行 v61 rebuild apply（保留 staging）后复制 63 张表，核对项目记录、显式全局 CLI/model 保留及 9 张知识表建立；迁移套件 22/22、知识集成 24/24 通过。未操作生产库。

### #777 独立效果研究

离线协议、合成案例、预检和待运行报告模板见 [对照研究协议](../agent-harness/knowledge-live/STUDY.md)。当前仅准备材料；真实 A→激活→B 使用→反馈→同身份修订、重复对照与收益判断均 pending。报告复用既有 Job/Attempt/work/receipt/usage 引用，不新增执行器、知识晋升审批或数据库表。
