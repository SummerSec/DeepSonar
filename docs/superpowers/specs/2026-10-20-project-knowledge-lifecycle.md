# 项目记忆与 Skill 全生命周期：实践设计

> 日期：2026-10-19；关联 [#752](https://github.com/SummerSec/DeepSonar/issues/752)。状态：完整实施设计草稿，以下新增表、operation、文件与默认值均是提案，尚未实现。
> 本文保留实施前设计；实际实现与授权补充以 [项目知识](../../PROJECT_KNOWLEDGE.md) 为准，原 Demo 结果不能代替生产闭环。

## 1. 最终应当运行起来的行为

一个项目完成任务后，Agent 判断哪些观察值得保留、哪些方法值得复用。它先查现有目录：内容够用就复用，有缺口就修订，确实没有才新建。独立 Agent 组织行为评测和审查，通过后由 Scheduler 自动切换项目内版本。下一任务按需取用；使用证据再触发 Agent 重验、修订、合并或停用。

人的操作可提供任务目标或启动一次整理，但不承担任何 Skill 审核或批准。页面展示过程、证据、版本与失败原因，不提供“人工批准”捷径。治理循环预算耗尽时停止并记录阻塞。

最小生产闭环的验收不是“生成了 SKILL.md”，而是：任务 A 的 Agent 提案经独立评测和审查自动激活；任务 B 在真实 Job 中找到、读取并使用该精确版本；B 的失败反馈能驱动下一轮，且整个过程项目隔离、可重启、可追溯。

## 2. 已核查的基础与职责

核查基线为本地已提交 `c08fb3611a333128738f96af4d5e21e5a7fcf320`。工作区既有未提交修改不计为本功能落地。所有路径均相对仓库根。

| 模块 | 现有入口与事实 | 本方案影响 |
| --- | --- | --- |
| `deepsonar:contracts` | `packages/shared-types/src/index.ts` 的 `ControlToolPayloadSchemas` 定义运行时操作输入 | CHANGE：新增独立知识契约并注册，严格拒绝未知字段 |
| `deepsonar:skill-runtime` | `apps/scheduler/src/executor-real.ts` 的 list/search/pull 使用 `skill-sources.ts` 全局 trusted+enabled loader | CHANGE：统一 Job 范围、冻结目录和实时撤销；不能直接接项目私有 Skill |
| `deepsonar:project-policy` | `domains/project-skill-allowlist/catalog.ts` 计算全局源减项目停用 | CHANGE：相同策略贯穿 Hub 与运行时发现/拉取 |
| `deepsonar:capability-discovery` | `domains/capability-pack/discovery.ts` 也通过全局 trusted loader 发现 Skill 源 | CHANGE：能力发现复用同一 Job-scoped 可见集合，避免旁路泄露目录 |
| `deepsonar:knowledge` | 当前不存在完整项目知识领域 | CHANGE：新增候选、版本、评测、审查、工作请求与目录投影 |
| `deepsonar:job-control` | `domains/platform-api/operations.ts`、`domains/event-ingestion/` 负责受治理语义写入；`domains/job-attempt/application.ts` 有 effect/settlement | CHANGE：接入知识操作，继续使用现有事务与 Attempt 边界 |
| `deepsonar:storage` | `database/schema.sql` 有 `shared_asset_blobs`；普通 active 共享资产会被选入 Job | CHANGE：复用 CAS 基础设施，但不创建会自动下发的草稿 shared asset |
| `deepsonar:orchestration` | `domains/hub-orchestration/application.ts` 返回 `maybeTriggerHub`、`advanceCanvasAfterTerminalJob` | CHANGE：持久知识工作请求唤醒既有 Hub/Job；不新增沙箱执行器 |
| `deepsonar:web` | 项目管理与 `apps/web/src/JobDetailPanel.tsx` 展示项目和执行过程 | CHANGE：只读知识目录与来源/版本/评测/使用追踪 |
| `deepsonar:sandbox` | `packages/runtime-sandbox` 已负责运行时适配、网络、执行与归档 | VERIFY：复用现有执行通道与 CLI adapter，不增加模型 Provider 或长期密钥注入 |

只在一个 Git 仓库内实施；以上是模块职责划分，不是多仓部署。代码改造前须重新检查当前 HEAD、局部 AGENTS 和相关符号，防止路径漂移。

## 3. 架构：一个领域、一个治理 Skill、现有执行内核

新增 `apps/scheduler/src/domains/project-knowledge/`，负责知识领域规则。HTTP/Control 入口只组装；持久化、状态转移、审查绑定和目录投影在领域内实现。

治理方法放在可替换的 `skills/project-knowledge-governor/SKILL.md` 及其 `references/`：包含复用取舍、提案格式、评测组织、审查要求、反馈分析、合并/停用方法。它不持有发布权限，也不替代代码里的范围和状态检查。SkillOpt 只作为可选文本 evaluator；在线优化依靠真实 Agent Job，不要求运行某个特定优化器。

通过现有 Capability Pack 声明治理能力。生成、行为评测、独立审查是不同 Job 的职责绑定，不增加固定角色枚举或 RoleConfig 分支。Hub 在平台已准入的 CLI、模型、工具和镜像目录内选择；工作请求只允许引用已批准的能力，不允许 raw 镜像或自由安装。

首次部署提供平台发布的固定治理 Skill 基线；治理 Job 按冻结版本拉取。项目可以提出项目内治理方法修订，经旧的有效治理版本组织独立审查后生效。项目修订不能覆盖平台控制 Skill、平台准入目录或其他项目。平台共享基线更新仍属于平台发布，项目 Agent 无权自行提升为全局版本。

```text
授权任务/资料变化/使用反馈
  -> durable 知识工作请求（去重、预算、阶段游标）
  -> 既有 Hub -> maker Job -> proposal
  -> evaluator Job（候选只进入隔离评测输入）
  -> reviewer Job（独立上下文、精确输入绑定）
  -> Scheduler 事务：校验、CAS 版本切换、durable receipt
  -> 下一 Job 的冻结目录 -> Agent 搜索/拉取/使用
  -> 实际证据 + Agent 反馈 -> 新的有界工作请求
```

## 4. 数据模型：身份、正文与评测审查证据分离

首期增加以下六张领域表。这里给出约束，不在设计稿中预写整段 DDL；实现时以 schema 基线和 shared Zod 契约为准。第六张是本功能必须补的持久操作 receipt，当前 Control API 的进程内缓存不能替代它。

| 建议表 | 稳定定列 | JSONB 内容与约束 |
| --- | --- | --- |
| `project_knowledge_items` | id、project_id、kind(memory/skill)、logical_key、status(draft/active/stale/retired/revoked)、active_version_id、generation、时间 | 标题、说明、关键词、适用范围；`UNIQUE(project_id, kind, logical_key)`；新身份先为 draft，无 active 版本不得进入普通目录 |
| `project_knowledge_versions` | id、item_id、project_id、version、content_sha256、creator_job_id、creator_attempt_id、created_at | sources、适用资产指纹、触发与失败条件、治理版本；`UNIQUE(item_id, version)` 和同身份内容 hash 去重；正文与来源清单不可变 |
| `project_knowledge_proposals` | id、project_id、work_id、action、state、revision、parent_proposal_id、maker_job_id、idempotency_key、request_digest | 候选版本引用、完整 base generation 映射、合并/停用计划、原因、eval/review 绑定；`UNIQUE(maker_job_id, idempotency_key)`；相同键不同输入拒绝；修订追加新行与父提案引用，不覆写旧提案正文 |
| `project_knowledge_evaluations` | id、proposal_id、proposal_revision、kind(behavior/review)、actor_job_id、actor_attempt_id、input_digest、created_at | case/输出/证据引用、环境/模型版本、结果、理由、风险、未执行项；仅指定评测/审查 Job 可追加，不能改写已有记录 |
| `project_knowledge_work` | id、project_id、trigger_key、state、stage、active_job_id、generation、claim_expires_at、next_attempt_at、时间 | 有界触发引用、子 Job 关联、预算已用值、停止原因；`UNIQUE(project_id, trigger_key)`；每项目至多一条 running 根工作链；claim 超时可重领但必须比较 generation |
| `project_knowledge_receipts` | id、project_id、job_id、attempt_id、operation、idempotency_key、input_digest、state、event_id、created_at、settled_at | 有界 result/error、proposal/评测/反馈引用；`UNIQUE(job_id, idempotency_key)`，操作名和输入摘要同时比较；领域变更、语义事件和 receipt 同事务提交 |

所有父子引用带 project_id 的复合唯一键/外键，数据库和应用都拒绝跨项目组合。Job/Attempt 归属再次校验，不信模型提交的身份。`generation` 是并发比较值，不是模型自填版本。候选版本可持久化，但只有有效 active 指针可进入普通目录。item/version 的循环引用在完整 schema 基线中先建空指针、后建版本表和延迟复合 FK；首次发布在同事务填指针，禁止把“应用已经校验”当成可删除数据库约束的理由。这是单一新基线的建库次序，不引入非空库增量迁移。

版本号由平台在身份锁内分配，允许被拒候选占用编号，不为展示连续性回收编号。首次草稿身份通过前不返回普通索引；重复逻辑 key 返回已有身份供 Agent 修订，不自动覆盖。memory 的事实验证状态放在版本内容，不复用 item 生命周期字段。物理清理由现有项目删除/审计保留政策统一管理；外键默认 RESTRICT 保护被 Job/证据引用的版本，不让级联删除静默抹掉历史。实现需测试删除计划与 CAS 保留，而不是另加后台删除通道。

正文与包清单使用现有 BlobStore/CAS；复用 `shared_asset_blobs` 的哈希索引，不插入普通 `shared_assets` 记录。当前没有可直接扩展的通用 Blob GC，首期采用保守保留：无完整根扫描能力时不自动删除 blob。新增离线 mark/plan 工具枚举 shared assets、知识版本、评测证据和 Job 目录根，产出可审核的回收清单；实施自动 sweep 前单独验收根完整性。CAS 写成功而事务失败的孤儿允许暂留，不能通过重放外部执行来“修补”。

一个 Skill 包由规范化 manifest 列出 `SKILL.md` 和允许的 `references/` 文件路径、字节与 hash，bundle hash 覆盖整份清单。首期只接文本包，拒绝可执行脚本、符号链接、路径穿越、压缩炸弹和绝对路径；脚本型 Skill 以后另走已有能力准入，不允许“文档发布”自动获得代码执行准入。

记忆保存观察、假设、冲突、已验证/未验证状态和来源；独立审查只能确认“表述与证据边界合适”，不能凭 LLM 判断把未验证观察升成 Fact confirmed。使用记录优先复用语义 events 与审计，原始任务输出保留在 Evidence，不再建第二套原始日志库。现有 Artifact 绑定业务 Job 且 source_operation 受限，不直接拿来充当知识版本或评测表；知识独立保存摘要、不可变 digest、来源 Job/Attempt 与可读/失效状态，原证据被删除或不可读时显式反馈，不能用旧摘要冒充原证据仍在。

schema 当前核查值为 59。实施时从当时主线 bump 下一版本，不预占固定版本数字；只改基线 + schema-version + rebuild，禁止 ALTER 链、双读双写和旧契约 fallback。新增私有内容前部署者须按备份/重建流程升级；旧 Job 快照保持只读历史，不自动补成新快照。

## 5. Job 目录冻结与运行中撤销

Job 创建时生成平台持有的目录 manifest：全局 trusted+enabled 且未被项目停用的 Skill，加本项目当时有效的 active 知识版本。manifest 存 CAS，Job snapshot 只保存引用、hash、权限指纹与治理版本；给模型的是有界摘要和分页入口，不是整个目录或全部正文。

当前 `syncSkillSource` 原地覆盖 `skill_sources.catalog_json`，并没有可支撑旧 Job 的动态目录历史。因此必须在同步时保存不可变 catalog/文件 bytes 的 CAS 清单，再让 Job 引用已存内容；只记录 Git commit 或 source 行 hash 不足以保证旧字节可读。现有显式 RoleConfig 的 `expanded_modules/skill_revisions` 不代表完整动态目录，不得借它宣称已经冻结。`pullSkillFromCatalog` 目前返回有界 files，接入仍复用这一读取形态；不要凭本方案新增一套隐式挂载或安装协议。

`list_available_skills`、`search_skills`、Hub 源摘要和 `pull_skill` 使用同一个 Job-scoped catalog 服务。项目 Skill 使用显式来源身份，例如 `project:<item_uuid>@<version>`，不可用同名静默覆盖全局源。语义身份、selector 与 hash 都经过严格契约解析。项目记忆采用相同冻结上限，但使用记忆读取操作，不借 `pull_skill` 绕过包校验。

每次发现或读取实际允许集合为：**Job 冻结集合 ∩ 当前权限仍允许且未撤销的集合**。运行中只能收紧，不能因新发布版本扩大。

| 变化 | 进行中 Job | 新 Job |
| --- | --- | --- |
| 普通来源同步、Skill v2 发布 | 继续固定旧版本；不得自动改为新 hash；旧内容必须仍可读 | 采用新有效版本 |
| 项目停用全局源、平台撤信/禁用、紧急 revoke | 从结果中移除并拒绝新的 read/pull，返回稳定 revoked 错误 | 不进入目录 |
| 普通 retire/stale | 已冻结旧版可复查，读取时带旧版/过期提示；若涉及越权则升级 revoke | 不进入目录，等待重新评测/有效新版本 |
| 请求任意旧 hash/其他 Job selector/其他项目 id | 未属于当前快照则拒绝，即使历史存在 | 同样拒绝 |

这取代概念稿中“同步后旧 hash 一律失败”的宽泛说法：正常更新不能破坏冻结语义；撤销不能被冻结语义绕过。撤销只能阻止后续读取/调用，无法让模型忘记已读文字，也不能收回已进入沙箱的字节。紧急 revoke 应标记受影响的运行 Job，按现有取消/对账机制停止后续执行，保留已发生效果。

读写与撤销操作采用一致锁序和短事务：现有事件路径为 Canvas -> Job，知识事件继续依次锁 work/proposal、按 UUID 排序的 item 与 version/evaluation；CAS/网络不在数据库长事务里。后台扫描先用独立短事务领取 work 并释放锁，再按 Canvas -> Job -> work 顺序校验 generation、创建/关联后续 Job，不能持有 work 锁反向等待终态 Job 的锁。pull 在返回 files 前重验权限；撤销提交是新的读取准入线性化点，之前已获准的读取如实记账。确切锁序由事务集成测试固定。

## 6. 对 Agent 开放的操作契约

所有新 operation 经 `shared Zod -> runtime handler -> event-ingestion/application transaction` 三层校验，`project_id`、actor、Attempt、stage assignment 从 token/当前 Job 推导。请求体不接受这些字段来改权限。

| 操作（提案） | 最小输入 | 返回与副作用 |
| --- | --- | --- |
| 现有 `list_available_skills/search_skills/pull_skill` | 原查询/selector/hash，加当前契约所需分页 | 统一全局与项目 Skill；授权与内容均受当前冻结目录限制 |
| `search_project_knowledge` | kind、query、keywords、cursor、limit | 仅当前 Job 可见的 metadata、版本/hash、适用范围和来源摘要；不返回草稿正文 |
| `read_project_memory` | item_ref、version、expected_hash | 有界记忆正文、来源/验证状态、usage_ref；只读有效冻结记录 |
| `read_knowledge_input` | work_ref、input_ref、expected_hash、cursor | 仅已分配治理 Job 读取 work 冻结的授权资料片段/候选/评测证据；不能读任意项目文件、blob URI 或别的 work；不把候选暴露给普通任务 |
| `propose_project_knowledge` | work_ref、action、base_refs、候选包/内容引用、source_refs、reason、evaluation_plan | 持久 proposal + receipt；action 为 reuse/revise/create/merge/retire；候选可被专用评测 Job 精确读取，不进入普通目录 |
| `submit_knowledge_evaluation` | proposal_ref、revision、input_digest、case_results、evidence_refs | 仅平台分配的 evaluator Job 提交；写入独立不可变结果，不激活 |
| `review_project_knowledge` | proposal_ref、revision、input_digest、decision、reason、evidence_refs、remaining_checks | 仅平台分配的 reviewer Job；approve 满足硬门则同一事务激活/合并/停用并结算，否则返回 needs_eval/reject/冲突 |
| `record_knowledge_feedback` | usage_ref、outcome、evidence_refs、next_action、reason | 绑定实际已读版本；保存语义反馈、去重创建工作请求；文本反馈不能直接撤销/发布 |
| `get_knowledge_receipt` | receipt_ref 或原 idempotency_key（二选一） | 返回当前 Job 自己的持久接受/结算结果；跨 Job 仅限已分配 work 的显式只读输入引用，管理页另按现有项目读取权限查询 |

读目录不授予写操作；maker 不能凭填写 `reviewer_ref` 获审查资格。reviewer Job 必须与 maker、behavior evaluator 的 Job id 不同，且由工作请求的 Scheduler-owned assignment 绑定。它们允许使用同一模型，但必须独立上下文；不能把生成者的自评作为 reviewer 的唯一证据。跨模型审查可由 Hub 在已准入模型中选择，不硬编码 Provider。

新增公共 schema 放 `packages/shared-types/src/project-knowledge.ts`，导出请求/结果/错误与 manifest 类型，再接入 `index.ts` 的注册表。遵守当前 MCP/OpenAPI 投影要求：顶层严格 object，互斥字段用字段级结构和 refine 校验，不生成顶层 anyOf/oneOf。字节限制按 UTF-8 计算，不把字符数量当字节预算。不在新模块复制平台 token、HTTP 端口或普通文本控制协议。

首期检索使用项目索引 + 结构化关键词/名称匹配，Agent 负责扩展查询和选择；中文通过明确关键词而非假设英文分词有效。分页 limit 默认 10、最大 20；摘要单条上限 500 字符，单次读取正文最大 12 KiB，单 Skill 文本包最大 128 KiB/20 文件。使用签名 cursor 绑定 Job、catalog hash 和查询；预算由平台计数，超限明确反馈。以上是建议初值，实施需写成契约常量并测试。

稳定错误至少覆盖 `KNOWLEDGE_SCOPE_DENIED`、`KNOWLEDGE_REVOKED`、`KNOWLEDGE_BASE_CONFLICT`、`KNOWLEDGE_REVIEW_MISMATCH`、`KNOWLEDGE_EVALUATION_REQUIRED`、`KNOWLEDGE_BUDGET_EXHAUSTED`。按现有 RepairFeedback 分类返回脱敏修复动作；越权 fail closed，不通过重试或换通道放行。

## 7. 评测、审查与自动结算

输入摘要绑定 project、proposal revision、全部父版本与 generation、候选 bundle hash、来源指纹、评测集 hash、治理 Skill hash、评测环境/模型配置。任一变化生成新 revision，旧评测和审查不得沿用。

maker 提评测计划，evaluator 检查其覆盖后在隔离 Job 执行无 Skill、当前版、候选版对照。新建没有旧版时比较无 Skill；合并比较各旧版共存与合并版；停用比较移除前后关键任务。记录具体 case 的触发、输出、证据、工具调用、token、耗时，未执行项显式标记，不把 `expected/forbidden` 文案命中当行为成功。

最低 case 集包含一个目标任务、一个不应触发任务、一个错误/缺资料分支、一个跨项目诱导、一个与现有 Skill 共存任务、一个来源变更/撤销场景。固定的平台安全负例不由候选作者覆盖。每个关键 case 必须有真实执行证据或可重复的确定性 evaluator；缺执行环境返回 needs_eval，不允许编造结果或将环境失败归为方法失败。

reviewer 阅读独立执行结果、来源与候选，决定 approve/reject/needs_eval，说明取舍与未覆盖项。平台只检查已指定评测的可验证结构与结论、硬权限和独立性，不硬编码项目业务方法。初版准入：所有关键安全 case 通过，目标行为无关键退化，触发负例不扩大；非关键收益由 reviewer 解释，不设“总分过线即可”。首次激活不因成本更低而豁免安全或功能门。

激活事务锁定所有目标 item，比较 base generation、来源适用性、review assignment 与 input_digest，插入版本/评测关联并切 active 指针，追加语义 event 和可查询 receipt。merge 同时激活目标与 retire 被合并身份，全部成功或全部回滚；retire 不物理删除历史。HTTP 超时后查询 receipt，重复同键同输入返回原结算，不创建 v3。

当前 `platform-api/routes.ts` 的幂等缓存是进程内 Map；`event_dedup` 只避免重复 event_id，不能证明重试输入相同，也不能恢复完整结果。因此知识写操作在领域入口先查 `project_knowledge_receipts`，同 Job/key 的不同 operation/input_digest 一律冲突，同输入返回原结果。不能在 handler 之前由进程内缓存绕过这项持久检查；新增知识 operation 必须接入 durable invocation 分支。

数据库变更、事件和 receipt 在同一事务提交后才返回 accepted；提供 Job-scoped `get_knowledge_receipt` 只读操作，允许重启后凭 receipt id/原 idempotency key 查询。HTTP 丢响应不等于失败，不重做激活。Attempt effect ledger 仍只管需记账的 CAS/沙箱外部效果，不充当这张 receipt 表。已有其他 operation 的 receipt 缺口不在本次伪装成已全部修复。

## 8. 触发、持久进度、停止与恢复

触发来自 Agent 显式提案/反馈、来源版本变化以及治理相关 Job 的已结算结果。普通任务结束不必无条件再跑一次 LLM 总结；没有结构化知识信号则不建链。首次项目知识任务可以由任务目标启动，后续由这些事件自动驱动。

trigger_key 由项目、触发类型、实际来源事件/资产指纹组成，不能只用时间戳。`project_knowledge_work` 是领域 outbox/进度记录，不是新的执行 Job：Scheduler 扫描 pending 工作请求，通过现有创建 Canvas/Hub/Job 的领域入口创建一个标准治理画布，关联 origin Job，但不重开已收敛业务画布或改变其 Report。work/stage assignment 冻结进治理 Job。创建关联对象与更新 active_job_id 在同一事务，用唯一键和行锁防重复；没有事务内可复用入口的地方需先抽取既有创建逻辑，不能直接写第二套生命周期。

work 另冻结有界输入 manifest（授权 Evidence/Fact/资产版本的引用和 hash），逐项重新校验项目与可读范围。新治理 Job 不天然继承原 Job 的所有图读取权，也不因为 project_id 相同而获得所有历史任务；只能通过 `read_knowledge_input` 读取 manifest 中获准的片段。maker 可读自己当前 work 的候选以修订，但不能读其他 work 的候选或平台保留的盲测答案。评测 Job 额外只读指定 candidate，reviewer 可读候选、来源与指定评测证据。输入变化创建新 revision，不允许模型提交宿主机路径或任意 blob 地址。

Hub 自主选择下一步与能力；平台只限制该 work 可提交的 stage、scope 和预算。合法转换为 discover -> propose -> evaluate -> review -> settle，needs_eval 返回 propose/evaluate。reuse 可直接记录合法版本引用，不走无用生成；没有写权限的任务也可以查询和使用。stage 不是新增 Job.type 或固定业务角色。

建议初值：每项目同时 1 条治理工作链，每链至多 8 个 Agent Job、2 次候选修订、30 分钟累计运行时间；各 Job 继续受已有 token/工具/时间预算约束，链预算只能更严。相同事件自动重入不清零预算；新的来源版本/独立证据事件才可开启新链。知识治理 Job 的终态事件只推进当前链，不能再次创建无限根链。

重启扫描已提交 work 与关联 Job/Attempt/receipt：Job 仍有效则等待；已经结算则幂等推进；尚未创建 Job 则补建；未知外部效果标 blocked 并进入既有对账，禁止自动重放。取消、lease 失效和终态后迟到评测/审查均拒绝。知识整理失败不回滚主任务的 Fact/Finding/Report。

预算耗尽、来源缺失、执行环境不可用分别保留清晰原因和 next_action。`blocked` 是知识工作状态，不擅自增加或改名生产 Job 状态；本方案不调用 `request_human` 作为 Skill 审批回退。

## 9. 合并、停用、撤销与治理方法迭代

合并提案显式列出所有父身份、版本/generation、目标身份和取代理由；无跨项目隐式合并，无静默同名覆盖。一般选择一个现有身份作为目标，避免每次合并又创建新身份。Agent 可搜索相似项，但相似度只用于候选发现，不能直接触发合并。

普通停用由独立 Agent 基于行为/来源证据审查并结算，影响后续目录；明确安全违规或平台权限撤销由平台 fail closed 即时收紧，并唤醒 Agent 分析，不等 LLM 给越权签许可。误报反馈不直接触发全局禁用，必须保留原证据和独立复核。

治理 Skill 新版也走旧有效治理版本下的独立评测与 reviewer assignment；冻结旧版与测试集，验证它不能放宽准入、伪造 reviewer 或自行改权限。新治理版本只能影响后续工作链。没有有效基线时使用平台随发布提供的初始基线；不能让新候选以“没有 reviewer”为由自举放行。

## 10. Web 与运行结果展示

项目详情增加“项目知识”入口，列表区分 memory/skill、active/stale/retired/revoked、来源适用版本与最近反馈；候选、评测和审查单独展示状态。详情提供正文/来源/版本差异/真实执行证据/使用 Job 链接，明确“已读取”与“已执行”的差别。

任务工作台现有六个一级视图保持；知识追踪通过项目页及 Job 详情链接进入，不另加第七个任务一级视图。URL 参数记录筛选与当前知识详情，后台刷新不抢视图。空态为尚无有效知识，错误态展示稳定错误和最后可读结果。所有选择器使用仓库既有可搜索原语。

不提供人工 approve 按钮、拖拽改变 active 指针或编辑已发布正文。用户的普通任务启动/取消仍走现有管理权限；治理决定来自 Agent 记录，平台结算状态单独显示。

## 11. 一次完整生产试验及完成标准

1. 选择代码项目 A 与无 Git 的设备夹具项目 B，分别给定授权资产指纹；A/B 互相不可读。
2. 首个任务创建观察，Agent 查目录后提出一个记忆和一个方法候选；草稿不得被普通后续 Job 搜到。
3. evaluator 在真实已准入沙箱执行固定对照；reviewer 独立判定；approve 后平台自动激活 v1，记录 receipt。
4. 第二个任务通过现有 Skill 操作拉取 v1，产生读取记录、真实执行 Evidence 和反馈；不默认灌入全库。
5. 反馈推动同身份 v2；同时运行的旧 Job 保持 v1，新 Job 采用 v2；重复请求不产生 v3。
6. 来源普通同步保持旧 Job 可复现；项目停用/紧急撤销拒绝后续读取，记录已发生效果；重启不重复激活。
7. 输入文本满分的越权候选、假 reviewer、自批、跨项目 source、过期评测以及取消后的回调，全部阻塞且可修复/可诊断。
8. 构造重叠方法，经共存对照后合并并停用旧身份；查询历史 Job 仍看到原版本。
9. 更换治理 Skill 版本，验证旧工作链不变、后续链使用新版，不能改平台权限与独立审查门。

所有真实运行保存 commit、镜像 digest、模型/治理版本、case hash、Job/Attempt/receipt/Evidence 引用、命令退出码与未执行项。首轮至少完整通过一条“生成 -> 独立评测/审查 -> 自动激活 -> 后续使用 -> 反馈修订”链才算闭环；当前回放 Demo 不满足此生产完成标准。

实施任务、文件布局、函数接口与测试接线见 [实施计划](../plans/2026-10-20-project-knowledge-lifecycle.md)。此稿本身不触发数据库重建、模型调用或生产部署。

## 12. 上线顺序与故障处理

先交付 Job 目录冻结与实时收紧，再交付存储/receipt/只读检索；自动激活必须与独立评测、审查和恢复一同上线，不发布可自批的中间形态。最后接入真实模型治理 Job、合并/停用和只读 Web。每步独立 PR，完整链路通过前不标产品完成。

部署新 schema 前按已有 rebuild 流程保存备份、检查回填计划并确认运行 Job 排空。没有新 manifest/契约的历史快照只作历史读取；未开始的旧契约 Job 不自动重写，按新契约重新创建后才可执行。重建、取消或部署操作在实际实施阶段按已有授权和发布流程执行，本次只写计划。

发生问题时先停止创建新治理链并阻止有问题私有版本进入新目录，保留 receipt、Job 与证据；必要时撤销并按现有取消/对账路径处理运行任务。不得通过旧 live loader、人工批准或新旧双读来恢复。回退应用前检查 schema 版本是否匹配，不在新基线上启动只懂旧契约的二进制；数据库恢复遵循备份/审计流程，不静默移动历史版本指针。
