# 项目 Memory 与 Skill

> 状态：#752 生命周期及项目采集/隔离评测沿用既有实现；2026-11-16 项目合批、间隔和停发的目标契约见 ADR 0024，本轮共享工作树整合与最终 SHA Actions 待验。历史候选验收只覆盖原提交，不表示本轮已修复或部署。代码、[schema 基线](../database/schema.sql)和测试是事实入口；模型效果不能由状态机夹具推定。
> 同步日期：2026-11-16

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
| `read_project_knowledge` | 本项目精确版本及 hash 的 Memory 正文（旧名 `read_project_memory` 仅在迁移窗口内、且只对冻结快照本来就允许旧名的在途 Job 生效；两者执行同一实现与同一项目/版本/撤权检查） |
| `read_knowledge_input` | 当前 Scheduler 分配的 work/stage/audience 输入 |
| `propose_project_knowledge` | maker 提出 reuse/revise/create/merge/retire |
| `submit_knowledge_evaluation` | evaluator 提交独立 trial 的结构化结果 |
| `review_project_knowledge` | 独立 reviewer 审查并原子结算 |
| `record_knowledge_feedback` | 仅持久反馈，结果为 `{usage_ref,state:"recorded"}`；不返回 work_ref、不创建 work，自动整理经来源登记和项目 collector |
| `get_knowledge_receipt` | 查询当前 Job 的持久操作回执 |

`record_knowledge_feedback` 仅持久化已接受的 usage 反馈，操作结果为 `{usage_ref,state:"recorded"}`，不返回 `work_ref`，也不入队或启动知识 work。成功业务 Job 的已接受反馈经普通来源登记进入项目 collector，冻结精确 usage/反馈、target 版本/hash 基线及 evidence refs；同样受 4 来源或等待 24 小时、自动批次间隔 24 小时和连续两批无产出停发约束。原 Job 没有冻结 `request_project_knowledge` 权限时，不因提交反馈获得自动整理权限。显式 `request_project_knowledge` 仍按原有授权、来源、预算与幂等约束请求整理，不被自动策略替代；不得把仅反馈记录当作显式整理。

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

## 用后必评（#1219 第二步，2026-11-23）

评价写进工具契约本身，而不是另加一道门。三处描述现在说清同一件事：

- `search_project_knowledge`：搜索不是使用，本身不产生反馈；
- `read_project_knowledge`：只有**实际应用且能给出可核对证据**时才调用反馈工具，带上该次读取返回的 `usage_ref` 与真实 `evidence_refs`；效果不明或没有证据就**不要调用**（旧名 `read_project_memory` 只作为迁移窗口内的只读别名存在，仅对快照已列出该名的在飞任务可用，反馈口径相同）；
- `record_knowledge_feedback`：`outcome` 只有 `success` / `failure` / `inapplicable` 三选一，**没有 `unknown` 可提交**——缺评就是平台记录的「未知」，不得用任务成败反推知识有效性。

因此「缺评＝无样本」与「提交 unknown」是两件事：前者是统计口径，后者不存在。评价失败只登记，不阻塞主任务；覆盖率不得自动用于候选、评分或退役判定，旧的后台整理链仍按既有条件接收合格来源。本轮只改指引，不声称反馈率会因此提高。
## 项目知识卡片投影（#1256，2026-11-24）

项目知识页的列表一次分页请求就够渲染卡片，不需要为每条再发请求，也不会随页大小增加数据库往返：

- `summary`：**可见**当前生效版本的 `content` 截断 240 字；版本被撤权或受限、或没有正文（纯 Skill）时为 `null`。摘要读取按内容哈希去重，单页最多读 50 份。
- `feedback`：一次分组查询按 **版本 id** 聚合（`project_id` + `version_id` + `owner_project_id = 本项目`），分 `success` / `failure` / `inapplicable` / `unrated` 与 `total`。同一 `content_sha256` 被多个条目或多个版本引用时各归各，绝不串票；没有记录时各计数为 0。

页面语义：
- 没有记录写「当前版本暂无评价」；有阅读但都没评价写「N 条阅读记录，均未评价」；
- `total` 是**阅读记录数**（含未评价），不叫「使用次数」；
- `inapplicable` 显示「不适用」，与旧契约的「部分有用」不是一回事。

任务报告只写**不识别条目**的读取摘要（读取不等于采用）：报告正文里给出读过多少个知识版本、累计读取次数、其中有显式反馈的版本数，其余记为未评价（效果未知）。条目标题、条目/版本 id 与内容哈希**既不写入通用报告正文，也不写入报告 Job 的 `report_input_json`**（该输入会被原样并入通用 `report.json` 产物）——报告只要有 `tasks:read` 就能下载，而知识目录要求 `projects:read`；精确版本引用保存在报告的冻结输入里，由具备项目知识权限的成员在项目知识页按版本核对。受限、已撤权或来源权限无法核实的条目连摘要也不计入。历史报告字节不变。

反馈明细（`GET /projects/:id/knowledge/:itemId/versions/:versionId/feedback`）同样绑定版本 id：读者的 `job_id` 与自由文本 `reason` 只在具备 `tasks:read` 时返回，否则两者都为 `null`。投影只读：不写 usage、不改评价、不影响排序与权重；人的页面浏览不写入 `project_knowledge_usages`，不增加采纳票或延长闲置期。

## 工作与结算

`project_knowledge_work` 保存触发去重、stage、generation、当前 Job 和累计预算。Scheduler 为 work 创建独立标准 Canvas；maker、每个 case×arm trial、evaluator、reviewer 都是既有角色的普通 Job，使用现有 Dispatcher、Attempt、沙箱、Model Gateway、归档和终态恢复路径。知识 Job 的终态不触发业务 Hub/Report。

非 reuse 提案固定覆盖 target、negative_trigger、missing_input、cross_project、coexistence、revocation 六类，每类两个 arm，共 12 个独立 trial Job/Attempt/session。create 为 without/candidate，revise/merge 为 baseline/candidate，retire 为 baseline/without；reuse 复用精确已生效版本，不新建这轮候选试验。全部 trial 的普通知识目录、全局 Skill 目录和共享资产下发为空，只读取当前 assignment 的共同任务材料与本 arm 内容；评分规则不会进入 trial。

每例 `evaluation_plan[].task_inputs` 必须显式选择当前 work 已冻结的原始任务材料，两个 arm 取得相同材料，只在候选/基线内容上存在差别；不自动把全部来源复制给所有 trial。prompt 应是每个 arm 均可独立尝试的同一任务；候选正文、原任务最终结论、评分答案和 governor 方法不得充当共同答案。空列表仅适用于 prompt 自带完整输入的任务或明确省略待测材料的 missing_input 用例。这些语义要求由 maker/reviewer 核查，代码校验冻结引用/hash 和 assignment 分配，不能据此宣称平台已识别所有答案泄漏。rubric 以 `evaluation:proposal:<id>` 冻结，绑定 proposal、revision、input_digest、evaluation_plan 和 base_refs，reviewer 另得到 behavior 记录，仅 evaluator/reviewer audience 可读；trial 只注入专用 `deepsonar-project-knowledge-trial` Skill，不注入完整治理 Skill 的固定评分预期。源码见 [work.ts](../apps/scheduler/src/domains/project-knowledge/work.ts)、[proposals.ts](../apps/scheduler/src/domains/project-knowledge/proposals.ts)、[platform-skills.ts](../apps/scheduler/src/domains/project-knowledge/platform-skills.ts)。

trial 实际执行后发布 JSON，再以返回的真实 `version.id`、`version.content_sha256` 构造 `asset:<version UUID>` Evidence 引用；发布 operation ID 不能充当版本。数据必须绑定 case/arm/outcome/observations、独立 Job/最新成功 Attempt、资产版本和内容 hash，cross_project/revocation 还需真实 Control 拒绝审计。执行成功与任务结果分开：trial Job 可成功记录一次 target `fail`；candidate target 和所有安全组仍须 pass。target comparator 的 fail 可作为 without/baseline 差异观察，不再要求无知识组也解决任务才能激活候选；retire 的目标 arm 为 without。`unexecuted`、矩阵缺项/重复、缺证、未知效果一律不能激活。源码见 [evaluation.ts](../apps/scheduler/src/domains/project-knowledge/evaluation.ts)、[settlement.ts](../apps/scheduler/src/domains/project-knowledge/settlement.ts)、[发布回执](../apps/scheduler/src/shared-asset-publish-control.ts)；通过软件门禁不等于真实模型收益已证明。

首次 create 候选进入 `needs_eval` 后，修订必须引用此前提案并沿用其隔离草稿身份，追加新版本；不能覆盖评测中的候选、其他工作链的草稿或已激活身份。旧版本正文与来源保持不变。

预算为累计 32 Jobs、1800 秒、最多 2 次候选修订；1800 秒是 work 级累计执行预算，不是单个 Job 的超时——派发时 Job 超时不超过余额，余额低于最小可执行预算（`KNOWLEDGE_MIN_JOB_TIMEOUT_SEC`，见 `apps/scheduler/src/domains/project-knowledge/work.ts`，#1111）时直接按 `work_budget_exhausted` 阻断 work，既不派发注定被 Reaper 判 timeout 的短命 Job，也不授予终态路径会用不到的预算。提案准入和试验派发都计算完整剩余 case×arm，并为 evaluator/reviewer 预留 2 个 Job；不足则拒绝或阻断，不先创建无法收敛的部分矩阵。工作领取短事务完成；创建与关联 Job 使用现有事务内创建原语，保持 Canvas → Job → work 的锁顺序。重启扫描已持久的 assignment 和 Job 终态；unknown/orphan 不自动重放。治理 hash 改变时旧 work 保持 `blocked/governance_baseline_changed`，不改历史快照、回执或累计预算。整链 token 预算未在本轮新增，不能把 Job/时间预算写成共享 token 额度。

自动项目批次的全部阶段以 `assignment.source_mode=project_collection` 标识，与所有 trial 一起在创建期经 [job-isolation.ts](../apps/scheduler/src/domains/project-knowledge/job-isolation.ts) 收紧快照：工具取已准入 allowlist 与 stage 工具的交集，`allow_egress=false`，清除角色预加载 skills/modules/commands/MCP/subagents/instructions 和共享资产；不授予角色本来没有的 operation。trial 再清空冻结知识/全局 Skill 目录，仅保留专用试验指导与分配输入。原有 Job 快照不可改写。隔离环境不能满足任务时如实记录 unexecuted，不能为得到结果自动放宽网络或工具。

reviewer 与 maker/evaluator 必须不同 Job，绑定 proposal revision、输入 digest、来源、baseline generation 和治理 hash。全部硬门通过才切 active 指针。merge 的目标激活与来源 retire 在同一事务，冲突或拒绝保留旧 active。版本正文及 provenance 不可改写；revoke tombstone 不可清除。

治理方法由平台 `deepsonar-project-knowledge` Skill 提供，代码保有项目范围、权限、预算、独立性、证据和结算硬门。项目治理方法的修订也必须经过相同流程，不改变当前 work 的冻结基线。

## 管理与存储

项目“知识”页在目录前显示紧凑的积累/复用汇总与最近工作进展，工作详情和跳过原因按需展开，受阻原因使用中文并链接现有 Job/Canvas；目录、历史版本、来源、评测/审查、usage/反馈和精确授权沿用原入口。刷新复用现有页面触发，不新增定时轮询，项目与刷新身份隔离迟到响应。分页 API 以项目管理权限读取；草稿仅管理面可见，不能据此获得跨项目候选访问权。组件见 [ProjectKnowledgeActivity.tsx](../apps/web/src/pages/ProjectKnowledgeActivity.tsx)。

本轮在同一页展示 `collection` 的积累、冷却、执行中或连续无产出停发及下次可准入时间；停发说明成功的显式整理可恢复，不新增恢复按钮、配置或通知。下次时间是调度资格提示，不承诺届时一定创建或执行 Job。

六张领域表为 work、items、versions、proposals、evaluations、receipts；assignments、grants、usages 是权限和执行基础记录。项目/Job/Attempt 复合外键防止伪造 provenance，receipt 和 evaluation 只追加。Skill bundle 仅允许 `SKILL.md` 与安全路径下的文本 references，总量 128 KiB / 20 文件。

`planKnowledgeBlobReachability` 提供只读离线根审计：所有历史版本（含 retired/revoked）、work/assignment 输入、历史 Job 目录、源清单及共享资产版本均保留。#960 将全局源的 `catalog_snapshot_hash` 与待批 `candidate_hash` 都作为同类 `skill_source` 根；候选字节保留至指针被覆盖/清除或 source 删除，移除某个引用不移除其它历史 Job/版本保留根。保留不是授权，新 Job 仍只冻结已批准 live 指针。没有引用的索引字节也仅列为保留项，当前没有自动 GC（`deletion_enabled=false`）。[现有真实 PG 可达性回归](../apps/scheduler/src/domains/project-knowledge/reachability.integration.test.ts)覆盖候选覆盖/删除后的根变化及冻结 live，沿既有知识集成 CI 入口；本次仅编写和静态核对，未执行本地测试。

## 任务会话收尾（#1197）

获授权的业务 Job 可在原会话使用 `submit_task_knowledge_suggestion` 提交待核验建议或明确无新增，再照常完成任务。每个 Attempt 最多接受一次，最多两项、每项最多四个本 Attempt 提交的 Fact 或 Evidence 引用，建议合计限 4 KiB。Scheduler 绑定来源哈希，拒绝识别出的凭据内容，并用现有持久回执记录提交结果。建议正文存入内容寻址存储，通用事件和画布只显示状态与引用。

正式报告和根任务成功后，且任务画布没有活跃或等待人工的 Job、没有未决效果，Scheduler 汇总最新成功 Attempt 的建议。画布只出现一个收尾节点，显示有建议、无新增或未提交。详情读取重新核对来源和修订目标，同页有一条无法核对时不返回该页正文。通用回执仅公开登记结果和回执引用。旧任务在项目的「历史补做预览」中查看资格和原因，预览不会排队或重跑。已有收尾回执受知识历史保留门保护。有项目读写及任务读取权限的操作者，可在原画布选择一条 Memory 或 Skill 送评。相同候选重复提交返回原评测。来源已被其他整理工作使用时拒绝送评，先送评则同一来源退出旧自动采集。

送评固定候选正文、来源和已有修订基线，复用 maker、独立试验和 evaluator。事务外解析准备来源清单和去重引用，最终授权由事务内来源复核确定。每次成功送评请求都记录操作者、请求标识和候选引用，审计中的 `reused` 区分新建与复用原评测。评测结果在原节点显示，通过与未通过都保留草稿，不进入审核或发布。来源失效时停止派发，并按现有权限限制详情读取。真实模型的质量效果尚未验证。完整设计见[任务知识沉淀设计](superpowers/specs/2026-11-21-task-knowledge-closeout-design.md)。

### 重试被设备历史挡住时的分类（#1236，2026-11-24）

清空历史的硬重试要删掉旧 Job，而 `device_leases.job_id` 是到 `jobs` 的非空外键、没有级联：租约仍引用旧 Job，所以删除会被拒绝，记录保持不动。**顶层错误码仍是 `TASK_DELETE_KNOWLEDGE_RETAINED`**（现有调用方只认它），新增 `retained_kinds` 与 `retained_reason` 供新客户端分支：

| `retained_kinds` | `retained_reason` | 引导 |
|---|---|---|
| `["device_lease"]` | `device_history` | 设备使用记录引用旧 Job，请保留此任务不动；任务本来支持继续时可用「继续此任务」，确需从零开始请另建新任务 |
| 含 `knowledge`（工作、版本、提案、回执、评测…） | `governance_records` | 沿用原有「先确认这些记录的去向」 |
| `continuation_budget` | `governance_records` | 续做预算留痕单独成一类，不混进知识记录 |

两类都不放宽删除守卫；设备历史情形下旧 Job 与 released 租约在拒绝后都仍然存在（集成测试会读回核对）。

列表和任务详情在弹出清空确认前调用 `GET /tasks/:canvasId/retry-availability`。该只读查询检查归档、活动执行及保留引用，使用与重试相同的 `jobs:control` 和项目范围。阻塞时展示设备使用历史、知识治理记录或续做预算记录及操作引导，保留任务并通过任务工作台的「下达任务」按原目标新建任务。正常继续入口仍由当前任务已有的恢复准入决定。

查询通过后才请求清空确认，确认框显示任务标题及编号。页面范围和每次操作身份绑定查询、确认和 POST；新操作、切换任务或项目以及页面卸载会中止旧查询和确认，迟到结果不弹窗、不提交、不清除当前操作的忙状态。确认后再次校验当前身份，实际 POST 继续在事务内重新检查当前保留引用和执行配置。查询后新增引用造成的 409，Web 保留并消费 `retained`、`retained_kinds`、`retained_reason` 和 `next_action`，所有保留类别按同一中文规则展示。查询结果仅表示本次只读检查的事实。PG 回归覆盖 released 租约、查询后新增引用、混合保留、只读账号及跨项目拒绝。列表和详情的 DOM 回归覆盖确认前阻塞、确认后的冲突反馈、乱序返回、A→B→A 切换和卸载，只有当前任务确认会提交一次。最终候选的 Actions 另验。

### 任务沉淀直接入库（#1219 第一步，2026-11-23）

Memory 类任务沉淀不再只停在画布节点上。同一次提交在写回执的同一事务里生成可检索的知识条目与版本：逻辑键取归一化标题（`task/<slug>`），同标题再次沉淀追加新版本并把新版本设为 `active`，形成可追溯修订；内容写入内容寻址存储，来源记录四个引用及其写入时校验过的完整性哈希，并附任务、画布与 attempt 归属。

这条路径**不经过** maker→evaluator→reviewer 的模型评测，因此不会为沉淀额外启动模型 Job，也没有评测与审核等待。入库范围仍受投稿时已校验的 Job、Attempt、画布与项目约束，函数本身不读也不放宽任何权限。Skill 沉淀不走这条路径，继续由显式送评处理（送评、授权、撤销与历史回执保持不变）。同一份内容重复提交返回 `unchanged`，不产生新版本。

新条目与新 Job 的关系：Job 创建时冻结知识目录，所以沉淀只对**之后创建**的 Job 出现在检索结果里；而已冻结目录的在途 Job 不受影响，这也符合「不改写冻结快照」的既有约束。


### 唤醒查询与领取解耦（#1287，2026-11-26）

现象（来自报告，因果仍待实测）：`readNextKnowledgeWake` 的集合策略查询在 44k 行 `audit_logs` 上耗时 6–11s，而 Dispatcher 的每次调度刷新都会调用它；报告观察到端点排队 20–44s 并触发客户端 15s 超时。**这些耗时与因果尚未在本仓库的 CI 或实例上复现，属于待验证假设**，不要当作已证实结论引用。

本轮只做一件事：把普通任务领取从这条重查询上解耦，不改 schema、不改唤醒语义。

- `schedule-wake.ts` 用 `shouldProbeKnowledgeWake` 决定这次刷新要不要回库：唤醒时间还在未来就不查；到期后查一次并记住「已为这条到期回库」；之后最多每 `DEEPSONAR_KNOWLEDGE_PROBE_INTERVAL_MS`（默认 30s，0–300000）复查一次，避免同一条到期被反复重跑。
- 知识工作推进时（`project-knowledge-scheduler.tick`）调用 `noteKnowledgeWakeChange()` 显式请求回库，保证写入后立刻可见，不依赖间隔。
- `readNextKnowledgeWake` 本身保持无缓存：直接调用的集成用例（写入后立即读、halted 项目不再唤醒等）语义完全不变。

刻意没做：没有给 `audit_logs` 加部分索引，也没有把 `SCHEMA_VERSION` 从 79 升到 80——索引能否消除 `DISTINCT ON` 的排序、以及重试来源的「取最新记录」路径都需要 `EXPLAIN (ANALYZE, BUFFERS)` 实测数据支撑，缺证据就要求已有非空库受控重建不划算。索引与查询形态重写留作后续项，届时单列升级影响与重建验收。

## 验证与运维

2026-11-16 本轮只按 [ADR 0024](architecture/adr/0024-project-knowledge-batching-admission.md) 同步目标契约，代码由共享工作树并行整合；未取得最终 SHA Actions 结果，不宣称已通过或运行实例已修复。Actions 应覆盖：少量来源积累、4 来源合批、24 小时等待与批次间隔、32 候选在 19 inputs 上限内装箱并保留放不下者、跨项目隔离、blocked/cancelled/无产出的 completed 连续两次停发、重启与治理 hash 变化不恢复、显式成功整理恢复、CAS 期间准入变化、未知提交去重、未来 retry 不造成热循环，以及 activity 与既有知识页状态。本轮反馈修正还须在 Actions 验证 recorded 结果无 work_ref/无新 work、成功 Job 的 feedback-only 来源登记、精确 target/证据冻结、collector 积累/间隔/停发不可绕过、原 Job 无整理权限不扩权，以及显式请求入口保持原语义。原最小 Job 预算、独立评测和权限边界继续验收；本机不运行测试/build/typecheck，不部署、不重跑历史生产任务、不做真实模型收益试验。

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

本轮用户明确授权自动项目整理，[ADR 0023](architecture/adr/0023-project-knowledge-collection.md) 取代 [0021](architecture/adr/0021-knowledge-source-preview.md) 中项目批处理暂缓的限制；0021 的历史决定保留。成功业务 Job 的登记仍仅在原终态事务/savepoint 中向 append-only `audit_logs` 写 `project_knowledge.source_registered`（`system/scheduler`、`result=ok`），记录 Job/Attempt/Canvas 与 Fact/Evidence 或已接受反馈的存在标记；不在终态事务中复制正文或创建模型 Job。登记失败隔离并告警，不回滚业务成功。登记不保证来源正文保留，不是候选或产物。

[collector.ts](../apps/scheduler/src/domains/project-knowledge/collector.ts) 由既有 Dispatcher tick 调用，[knowledge-wake.ts](../apps/scheduler/src/knowledge-wake.ts) 计算同一调度器的持久唤醒，不新增轮询执行器。数值阈值是本轮实现取舍，不追认为用户逐字指定参数。本轮 [ADR 0024](architecture/adr/0024-project-knowledge-batching-admission.md) 替代 0023 的来源数量及自动准入规则：项目至少积累 **4 个未处理来源，或最老待处理来源等待满 24 小时**，并且距上次自动批次创建满 **24 小时**，才可准入。来源数按源 Job 去重，已 collected/skipped 的来源不再计入；retry 未到期的来源仍待处理，但不得提前准备。低于四个可准备来源时，同一来源必须同时满足满 24 小时和 retry 到期，不能由尚在退避的旧来源为新来源提前开启批次。项目已有非旧自动 `pending/running` work 时等待，不再建立并行项目批次；这不是给全部 Agent 显式请求新增数据库唯一约束。

每次有界扫描最多 **32 个候选来源**，在其中继续选择本批可容纳者，合计至多 **19 个原始 inputs**（Fact、Evidence 及其授权资产），另可带一个冻结 governor 版本。4 是项目来源门槛，不是每批来源上限；满 24 小时也可整理少量来源。仅因本批剩余容量放不下的来源保留待后续批次，不记 collected/skipped，也不在首个放不下的来源处终止扫描；单个来源本身超过硬限制仍按永久拒绝处理。保留原观察的 verification_status，不把采集变为验证。

自动批次指 `knowledge:project:` work；成功须 work 为 `completed`，且关联 proposal 有 `active/retired` 产出。`blocked/cancelled`，以及 completed 但无该产出的自动批次都计无产出；连续 **2 个**即停发新自动批次，保留待处理来源。失败链从持久 work/proposal 历史推导，成功自动批次或按相同口径成功的显式知识整理可截断该链；失败显式整理不计入也不清零。重启、时间流逝、治理 hash 变化均不能恢复；显式成功后仍须满足项目、来源、间隔和权限等准入条件。没有进程内计数或新增恢复开关。完成/阻断批次不重建来源来重置预算，旧 `knowledge:auto:` work 不参与新批次的成功/恢复判断，也不自动开始后续阶段；其在途执行和历史记录不被取消或改写。

来源解析与 CAS 字节准备在短 SQL 事务外进行；项目行锁下以和选项目、durable wake、activity 相同的数据库准入规则重验来源门槛、24 小时间隔、持久失败链和繁忙状态，同时检查项目活动、最新成功 Attempt、冻结 `request_project_knowledge` 权限、未结算效果、当前来源/hash、既有处理、重试代次及 governor 版本，再原子建立 `knowledge:project:` work 和逐来源 `project_knowledge.source_collected` 审计链接。CAS 准备期间出现繁忙、冷却或停发，不能沿用事务前 ready 结果创建批次。wake 同时尊重积累门槛、冷却与来源 retry 的未来时间，停发或繁忙项目不生成立即过期的采集 wake；未来 retry 不得造成热循环。链接保存 `registration_id`、`work_ref`、`attempt_id`、`input_count`、`manifest_sha256`，最后一项为该来源冻结 manifest 的 canonical SHA-256，保留来源执行身份与输入摘要而不在审计中复制正文。无新 schema、迁移、持久失败计数或第二份经验账本。

超大来源、失权、未知效果等永久拒绝，以及瞬态来源准备失败累计三次耗尽后写 `project_knowledge.source_collection_skipped`（`system/scheduler`、`result=error`，安全 `error_code`/`after_json.reason`）。瞬态故障按下文持久退避，不能因一次准备失败永久消费来源；登记经 collected/skipped 消费后不再被 collector 自动重建。未结算/unknown 效果仍走原对账边界，跳过不是已解决，也不授予重放权限。各项目间隔离，项目行锁和同事务链接用于并发/restart 去重；具体实现见 [collector-sources.ts](../apps/scheduler/src/domains/project-knowledge/collector-sources.ts) 与 [scheduler](../apps/scheduler/src/project-knowledge-scheduler.ts)。

`GET /projects/:id/knowledge/backfill` 保留项目读权限内的历史资格只读预览；不返回正文、不登记历史来源、不启动整理，没有 POST 历史执行入口。自动 collector 只消费已经持久登记的来源，不把预览自动升级为下发授权。整链 token 预算和 schema 改动仍不在本轮范围。

## 积累与复用可见性

`GET /projects/:id/knowledge/activity?limit=10&offset=0` 要求 `projects:read` 与严格项目 scope；分页默认 10、最多 50，拒绝未知字段，授权范围内项目不存在返回 404。保留 `summary`、工作 `items`、`next_offset` 和最多 10 条去重 `skipped_sources:[{job_id,reason,at}]`，新增 `collection:{state,pending_sources,consecutive_failures,next_collection_at}`。错误原因仅返回安全已知码或通用提示，不返回来源正文、manifest、模型反馈正文和跨项目信息。机器入口见 [activity-routes.ts](../apps/scheduler/src/domains/project-knowledge/activity-routes.ts)、[activity.ts](../apps/scheduler/src/domains/project-knowledge/activity.ts)、[OpenAPI](../apps/scheduler/src/domains/project-knowledge/openapi.ts)和 [Web 契约](../apps/web/src/ProjectKnowledgeApi.ts)；本轮新字段的最终 SHA Actions 待验。

`collection` 是从项目未处理来源、work/proposal 历史及同一准入查询派生的只读投影，不新增持久状态机。`collection.pending_sources` 从可信 system/scheduler 来源登记审计按源 Job 去重并排除已处理来源，包含未来 retry 与本批放不下者；summary 的采集统计还核验关联 work 存在。两者在正常数据下口径一致，但 collection 与 summary 是两次只读查询，并发变更可能漂移，异常损坏数据也不保证同值；不得作为同一快照或强一致计数使用。`consecutive_failures` 是最近成功整理之后连续无产出的自动批次数，不是源准备 retry 次数。`next_collection_at` 为可计算的下次自动准入时间戳或 `null`，须同时考虑来源门槛、自动间隔和 retry；`ready` 表示已到资格时间，不能视作已派发。

| `collection.state` | 页面含义与调度边界 |
| --- | --- |
| `idle` | 无待处理来源且无在途工作；下次时间为空 |
| `busy` | 已有非旧自动 pending/running work；等待既有工作推进，下次采集时间为空 |
| `accumulating` | 等待来源积累或来源 retry；显示待处理数量与尊重 retry 的下次时间 |
| `cooldown` | 自动批次最小间隔是最后限制：cooldown_until 尚未到期且不早于 accumulated_at；显示下次时间 |
| `ready` | 当前全部自动准入条件满足，等待 Dispatcher；下次时间为已到期的资格时间 |
| `halted` | 连续 2 个自动批次无 active/retired 提案产出，停止新批次；下次时间为空，成功显式整理可恢复资格 |

| 投影 | 口径与证据边界 |
| --- | --- |
| `registered_sources` | 本项目成功 system/scheduler 登记按源 Job `resource_id` 去重；24 个登记不表示 24 个产物 |
| `collected_sources` / `skipped_sources` / `pending_sources` | 采集通过同项目 `after_json.work_ref` 关联 work；跳过来自 error 审计。待采集排除已采集或已跳过的去重并集，重叠不重复扣减；已采集含排队批次，仅表示已纳入整理 |
| `active_memory` / `active_skills` / `draft_items` | 本项目 active 且未撤销的版本与本项目草稿；不把全局源或其他项目 grant 当成本项目新产物 |
| `completed_work` / `blocked_work` | 工作流程状态，不是激活产物数或质量通过数 |
| `usage_count` / `feedback_count` / `successful_feedback` | 反馈 recorded 仅表示已保存，不等于 source_registered/source_collected、work 已创建或知识已生效；同 Job 多条 usage 反馈不变成多个来源。消费项目与 `owner_project_id` 都是本项目；排除全局和跨项目使用。拉取不证明实际采用，反馈及 success 仅为模型报告，保留 usage/provenance，不宣称效果已证明 |

知识页用 `feedback_count / usage_count` 显示反馈覆盖率，并分别显示显式反馈数与未反馈数。没有拉取显示「无样本」，没有反馈的拉取效果保持未知。统计沿用现有项目内口径。

任务工作台的「知识整理历史」展示尚未归档、能确认归属且已收口的知识 Canvas。默认任务列表保留在途或有待处理审核、人工续做、未结算外部效果的记录。切换筛选只改变列表，Canvas 详情及已归档历史仍可访问。页面复用原轮询和活动统计，减少日常任务列表的干扰，反馈缺口可直接看到。

工作项只含 id/state/stage/reason、Job 数、累计运行秒、当前 Job/Canvas 引用、创建/更新时间、可选最新提案状态及 `source_count`。来源数按 source_collected 的 work_ref 关联去重；没有采集链接的显式 work 仅在存在 origin Job 时按 1 回退。Job/Canvas 链接继续受原接口权限控制。

### 故障退避、试验上下文与修订

单条来源的永久拒绝只记录该来源的跳过，不吞掉同批正常来源。CAS/数据库准备的瞬态失败通过 `project_knowledge.source_collection_retry` 保存代次和下次时间，间隔 30 秒，最多 3 次；耗尽后明确跳过。这与项目级连续两个自动批次无产出的停发计数分开。既有 knowledge-wake 从持久审计恢复 retry，并与同一项目准入规则计算下一次时间，不因 retry 到期越过积累、冷却、繁忙或停发门；不另设轮询。失权、未知外部效果和预算耗尽不按瞬态重放，已创建/阻断的 work 不因此重建。

自动采集产生治理引用后，原任务按既有 `TASK_DELETE_KNOWLEDGE_RETAINED` 守卫保留：清空历史的硬重试/删除可能被拒绝，不能为重跑而删除来源、工作或回执。后续执行使用保留历史的受治理入口或新任务；这一保留成本不能被“自动积累”隐藏。

trial 保留可信的 `deepsonar-control` 与专用执行 Skill，不携带评分答案。共存用例为各 arm 分配相同的平台授权中性 trace Memory；这是固定工程用例上下文，不是项目积累或模型收益。自动批次与 trial 清理业务扩展、角色环境与手工配置，只重新物化连接必需的 Provider 配置，并重新冻结 Runtime Profile/launch。资产型 Evidence 同时冻结原 Job 有权读取的真实资产版本字节，不能只给 maker 描述和 hash。

实际 usage 的反馈先保存为记录，不逐 usage 另启自动 work；只有成功 Job 的合格来源经 collector 准入后，才在项目批次中冻结精确 usage/版本/hash、反馈 outcome/next_action/reason、target 基线及 evidence refs。反馈引用仍须属于原 Job/Attempt 并满足原项目/版本授权；不得复制跨项目来源正文或扩大原 grant。这些输入计入原 manifest 上限，放不下仍保留，不能另起 work 绕过限额或停发。修订 maker 继续读取绑定上一 proposal/revision/input_digest 的评测、审查意见和失败原因。普通 Job 启动时只获得有界的冻结知识数量与按需查询指引；不把知识正文或整目录默认注入。独立 Verify/Review、报告和治理 Job 不接收该复用指引。读取、模型反馈与真实质量收益继续分开报告。

### 注意力成本

| 行为 | 减少的人工负担 | 新增代价与约束 |
| --- | --- | --- |
| 有界自动采集 | 无需逐个成功 Job 手动整理；4 来源或 24 小时积累、24 小时间隔及两次无产出停发限制重复工作 | 小量来源需等待；32 候选装箱保持 19 inputs+governor，放不下者保留；累计预算、永久拒绝及瞬态退避不放宽，停发不随重启自动恢复 |
| 目录前汇总与最近工作 | 直接区分登记、排队、候选、生效、拉取与模型反馈，并说明积累、冷却、执行中或停发 | 原位置展示状态、待处理数与下次时间，详情按需展开、复用刷新；无新增通知、设置、恢复按钮或定时轮询，成功显式整理仍消耗原预算 |
| 独立试验与证据边界 | 避免人工把模型自述当收益或把来源数当产物数 | 每轮 12 个 trial 加 evaluator/reviewer 的成本，语义可比性仍需审查；注意力和质量收益未测量 |

Barry 的全局 Git Skill 源通过既有 trusted + enabled 同步机制接入，仓库公开性和维护由来源所有者管理；同步现有 Skill 不代表业务任务产生了新沉淀，本版也不自动回写 GitHub。
