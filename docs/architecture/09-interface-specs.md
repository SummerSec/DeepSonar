# 09 接口与协议边界

> 状态：**as-built**（#741）。说明 Management、Control、Gateway、流和导入接口的认证、幂等、错误和修复反馈边界；字段细节以 OpenAPI 与 shared schema 为准。
> 同步日期：2026-10-30

完整 HTTP 路由和字段只在 [`openapi.ts`](../../apps/scheduler/src/openapi.ts) 及其 shared Zod schema 中维护；路由面和 OpenAPI 一致性由 [`route-surface.test.ts`](../../apps/scheduler/src/route-surface.test.ts) 与 [`openapi.test.ts`](../../apps/scheduler/src/openapi.test.ts) 覆盖。本文解释协议语义，不复制全部请求字段。

## 任务下发契约（#767）

`POST /projects/{id}/tasks` 可选提交 `task_contract`；类型/版本错误按既有校验错误处理。共享 [TaskContract schema](../../packages/shared-types/src/task-contract.ts) 是字段与模板的唯一机器来源。201 成功返回 `task_contract_warnings`；必要条件阻塞返回 `409 task_contract_blocked`、`task_contract_blockers` 和 warnings，且不创建 Canvas/Job。每项有 `code/path/message/suggestion`，用于明确补充什么、哪些条件尚不能执行；它们不是完整度分数，也不代表自然语言意图已被理解。未提交契约的自由文本任务继续接受并返回未评估提示，工程场景不强套审计模板。

`workspace_write` 仅表示沙箱工作区变更，不包含外部业务写入或代码推送；后者属于需要目标核验的 `write`。客户端不得把 `allowed_actions`、身份字段或前置条件声明当作授权证明。服务端对可核验的当前项目网络限制、凭据存在/启用/项目范围做复核；真实目标身份、写权限和任意材料的可用性无可信核验结果时保持未知。契约及提示只能使用凭据引用，不能放入密码、cookie、token；schema 不提供秘密字段，但也不能保证自由文本没有秘密。详细管理工作流见[任务下发指南](../../skills/deepsonar-management/references/task-dispatch.md)。

## Management API

Management API 面向用户、Web 和受信任自动化，包含项目/任务、Canvas、Job 控制、Finding/报告、设置、镜像、凭据、设备、Worker、导入导出、平台 claim、只读平台版本发现和审计等入口。管理员只读 `GET /platform/updates` 读取 catalog 同步路径最近一次写入的当前部署与 `platform` 信息比较结果；它不触发新的比较，也不执行升级、apply 或 rollback，项目 token 不能调用。管理 API token 以 hash/prefix 存储，明文只在创建或轮换时返回；token scope 与 path project scope 同时校验。Provider credential 与平台 API token 分离，凭据密文使用 nonce/auth tag 存储，常规 credential projection 不含 ciphertext；现有设置编辑契约允许特定 `settings_config` 字段携带账户配置值，因此该响应仍受管理 scope、审计和脱敏规则约束。Job snapshot 投影不携带长期 secret。

项目 RoleConfig 写入拒绝 `agent_cli` / `model`，读取不暴露这两个字段；全局 CLI 接受 NULL 表示未指定偏好。项目 RoleConfig 导出不含这两项，导入含这两项（即使为 NULL）也拒绝；全局导入未指定 CLI 保持 NULL。项目 Agent 设置分别表达 CLI 和凭据白名单是否显式收紧，`credential_ids_configured` 区分未配置与空名单，设置读取不持久化凭据 ID。readiness 的检查项可携带与 Job 解析同源的 RepairFeedback；悬空/停用白名单要求管理员修复，不能通过 Agent 提交账号 ID 或 OCI 地址绕过（#757）。

管理认证入口有明确的健康、schema、bootstrap、Worker 注册和 WS ticket 例外；`/gateway` 与 `/control/v1/jobs` 使用独立的 Job-scoped 凭据。认证失败和授权拒绝会审计但不记录 token、Provider 原文或内部堆栈。旧配置不通过转换继续运行，不能用另一个认证面绕过当前契约。

### Finding 项目查询（#770 切片 B）

现有项目交付页使用 `GET /findings` 的最多 50 条游标页，按创建时间与 UUID 降序；游标保留 PostgreSQL 微秒精度。项目/任务/严重度/profile/类别/验证/处置同维度多选 OR、跨维度 AND；`q` 是标题、位置、摘要、指纹的不区分大小写字面子串，保留中文且转义 SQL 通配符。项目 token 在分页前约束所有项目和任务过滤项；列表与汇总复用同一条件和同项目来源 JOIN。汇总各桶在同一 SQL 快照计算，`total` 表示匹配数，`project_total` 明示为项目全量。列表与汇总为独立请求的当前读视图，不承诺跨请求快照一致；新建/删除/状态更新后需刷新首屏。

任务/profile 选项从未筛选的授权汇总取得，不以当前页推断。URL 保存筛选、游标、详情与交付视图；查询失败隐藏旧列表、计数和详情，重试仍保留 URL。记录展示源 `updated_at`，不虚构异步计算状态。证据内容、任务详情和报告仍由各自 scope 校验，列表权限不扩大证据读取；普通 Job 无新增查询通道。

本切片不提供猜测资产/版本筛选、关联边或数据完整性承诺。来源提前去重修复、权威特征覆盖率与样本质量、查询规模性能需分别验收；字面文本检索不是语义同一性判断。既有默认无分页 API 窗口仍供其他调用方使用，项目页面不再依赖该窗口。

## Job-scoped Control API

Control API 由 Scheduler 动态注册 operation、schema 和当前 Job 的 allowlist。Agent 持有短期 capability Bearer token，调用 `/control/v1/jobs/{jobId}/capabilities`、`/openapi.json` 和 operation 入口。宿主依次校验 token hash/Job/project/canvas、Job active 状态、过期/撤销、snapshot hash、operation allowlist、共享 Zod schema、可见引用和业务状态；Job 终态后 token 失效。只读 graph/capability/Skill 查询也受 Job 预算和脱敏约束。

所有 `/control/v1/jobs/{jobId}/operations/{operationId}` POST（包括只读 discovery、graph/capability 查询和 Skill 拉取）都必须带 UUID `Idempotency-Key`。在同一 Scheduler 进程的接口缓存仍存在时，同 key、同 operation 和同输入可返回已有结果；同 key 改变 operation/input 返回冲突。只读 operation 的 key 只提供请求级缓存和冲突检查，不产生 durable event/effect receipt；改变语义或外部效果的 operation 才继续依赖具体领域的事件 dedup、唯一键或 effect settlement。当前接口层缓存是进程内的，Scheduler 重启后会丢失；重启后的重复请求不能把内存缓存当成跨重启幂等保证。

Control operation 分为两类：`list/search/describe/validate/preview` 能力发现、graph 查询和 Skill 拉取是只读 operation；`emit_progress`、`emit_fact`、`emit_finding`、`submit_hub_decision`、`mark_job_done`、`request_human`、人工 ACK 以及 Plan/PlanResult 是语义提交，其中 Plan/PlanResult 当前 Phase 1 只记录版本化输入/结果，不派发 Worker、不改变 Hub convergence。所有 operation 都不直接暴露数据库写入、容器命令、凭据、Job 快照或终态修改；只有语义提交由 event-ingestion/application transaction 产生受审计的领域结果。

## 项目知识接口（#752 分支）

Management API 的 `/projects/:id/knowledge` 提供按项目授权的目录、版本、work、评测、usage/feedback、receipt 查询，以及来源项目管理者的精确 Skill 授权和不可逆撤销；grant 入口还要校验该版本已经审批，不能以授权激活 candidate。Job-scoped Control 增加知识搜索/读取、请求整理、提案、评测、审查和反馈；平台推导 project、Job、Attempt 与 stage，不接受调用方自报身份。只读输入受冻结 manifest、audience 和当前权限约束；mutation 经 shared schema、宿主和领域事务校验，返回 `accepted`、operation、`receipt_ref`，同 Job 同 key 同输入返回持久结果，同 key 异输入冲突。当前 Job 可用 `get_knowledge_receipt`，终态历史由项目管理入口查询。接口字段见 [OpenAPI](../../apps/scheduler/src/openapi.ts) 与[项目知识专题](../PROJECT_KNOWLEDGE.md)；领域 receipt 不等于全平台通用回执。

## Gateway、流和导入接口

- **Model Gateway：** Provider 选择、凭据、网络、模型和用量归 Scheduler 所有。Gateway 上游请求/响应体不落库（usage 计数除外）；Job 执行流由 Evidence writer 归档并对已登记的运行时 secret 脱敏。Provider 错误不成为 Agent 可伪造的语义事件。实现见 [`gateway.ts`](../../apps/scheduler/src/gateway.ts) 与 [`evidence.ts`](../../apps/scheduler/src/evidence.ts)。
- **过程流：** WS 使用一次性 ticket、项目/Job scope 和本地 Evidence catch-up。stream-bus 只做实时投递；本地副本不可见时返回 `visibility=unavailable`，不能从另一副本补造原始流。终端 WS 另有更严格的 control/admin scope、lease、帧大小和空闲限制。
- **导入/导出：** transfer 域校验格式、hash、版本/计数、项目 scope、路径和 provenance。导入可以保留历史 Job 的终态、旧 Attempt/effect 和 provenance，但不能恢复历史 token、沙箱或 secret，也不能直接授权新的 active execution；需要重跑时必须按当前 admission 和 snapshot 重新治理。导入与导出均审计。

[#776 A 基线](../REPAIR_FEEDBACK_BASELINE.md)冻结当前字段完整性与 operation/error/effect 恢复矩阵；进程内幂等缓存和广告预算不构成持久修正链。

[#776 B](../REPAIR_FEEDBACK_DONE_REPAIR.md)给 mark_job_done 增加必填 proposal revision header、原 key 的只读回执查询和持久拒绝计数。原 Control 权限仍有效；accepted/persisted_deferred 不是终态或效果结算。

## 稳定错误和 RepairFeedback

| 层 | 典型错误 | 调用方动作 |
| --- | --- | --- |
| 认证/作用域 | 未认证、项目越界、token 过期/撤销 | 停止调用并重新走管理授权；不能用新输入绕过 scope |
| 操作/状态 | operation 不存在、不在 allowlist、Job 不在运行态、状态冲突 | 读取当前 capability/Job 状态；权限和错误状态 fail closed |
| 输入/引用 | 未知字段、坏 UUID、不可见节点/Finding、超字节/计数 | `model_correctable` 时按反馈重新读取有界状态并用新 key 修正 |
| 速率/瞬态 | 429、Provider/Handler 暂时不可用、Gateway stream 截断 | 只按反馈延迟和预算重试同一语义；不重放未知效果 |
| 外部效果 | effect 已发出但结果不明、清理回执缺失 | `unknown_external_effect`，保留 effect id，转对账或人工 |
| 永久失败 | 工具未准入、快照/权限不匹配、禁止的控制文件 | `permanent_failure`，停止自动重试并进入失败/人工处理 |

规范要求 [`RepairFeedback`](../../packages/shared-types/src/repair-feedback.ts) 至少包含版本、category、code、operation、字段 path、脱敏 message、expected、observed_shape、current_state_ref、accepted_effects、idempotency_key、proposal_revision、repair_attempt、remaining_budget 和 next_action。`observed_shape` 只描述类型/长度/计数，不回显不可信正文、凭据、Provider 原文或堆栈。当前实现只在部分 Control schema/语义 payload 校验路径构造完整 envelope；auth、allowlist 和部分状态错误仍可能只返回稳定 error code，Hub、Verify、Completion Gate 与完整 Proposal/Receipt/Settlement 也尚未统一。该覆盖缺口登记于 [D-03 风险登记](12-risks-and-tech-debt.md#2-当前实现债务)，不能反向缩小规范要求。模型可修正错误必须重新读取当前状态，用新的 proposal revision 和 Idempotency-Key；瞬态错误遵守反馈的 retry delay；未知效果禁止自动重放。

Control handler 的错误响应保持稳定 code 和人类可读消息；下游原始错误文本不会直接透传。失败响应是否缓存遵循幂等语义：限流和未建立结果的瞬态失败不制造虚假的成功结果。Control 路由没有承诺一个跨重启的通用 receipt 查询 API；结果能否重读由具体事件、effect 或领域查询接口决定。

`submit_hub_decision` 的可修正 `invalid_node_ref` 可返回由当前 Job principal 生成的 `current_state_ref`，仅当 Canvas 存在且 token 已允许 `graph_query`。该链接 GET 只读 operation Schema，需按 `next_action` POST 有界查询；每次查询和重提重新鉴权/校验，不授予新权限，也不提供图版本锁。无权限时停止猜测，详见 [C0 边界](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

Hub `complete` 被现有分析完成门拒绝时，保持 `invalid_payload` / `complete` 路径，通过 `repair.expected` 提供由宿主门结果生成的有界缺失项。自由文本标题、证据正文与内部错误不进入该投影；反馈不是状态锁或效果接受凭据，提交仍须通过当前权限、引用及最终完成门。详见 [C1 边界](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

## 宿主维护升级接口

平台版本发现 API 保持只读，不能触发 Compose 变更。宿主维护控制器使用固定目标、结构计划 hash、generation 和部署绑定推进；风险计划需要明确批准，角色身份清除不是维护许可的隐含动作。目标 schema CLI 以 stdin 接收连接及动作，plan 使用只读事务，apply 只接受归属明确的候选库；返回结构化错误，不输出驱动原始错误或秘密。管理入口在 preparing 或身份不匹配时拒绝业务请求；当前宿主动作包括 `check`、`apply`、`rollback`、`resume-rollback`，风险批准使用 `--approve-plan-hash`，受管清单使用 `--nodes`。`--reset-role-identity` 已接 #758 目标重建，只在明确选择并批准对应 hash 时清角色 CLI 与项目 model，保留全局 model 和历史快照。`resume-rollback` 已接本地回执与维护源代的受管节点恢复；旧源没有维护契约且含远程节点时仍保持隔离。最终组合基线的多节点升级、第二代失败回滚和显式恢复已有隔离演练证据，范围见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)；不等同于 Windows Docker 或真实模型验收。具体参数以 [部署说明](../../deploy/README.md) 为准。[ADR 0008](adr/0008-maintenance-candidate-upgrade.md) 规定了激活未知不得回旧的恢复边界。

## Plan 判据管理读取与人工绑定

既有 Job 详情暴露 Plan 内容 SHA/判据；Fact 详情暴露当前来源版本与有界绑定历史。Fact verification PATCH 可附 plan_binding，必须 verified+note、jobs:control；expected_binding_id 与内容 SHA 冲突/不可用返回 409。它不改变 Agent 控制操作或派发契约。字段及限制见 [专题](../PLAN_GAP_PROJECTION.md) 与 OpenAPI。

## Plan 决策元数据（#775 B 首片）

Control graph_query 新增 plan_gap 分页只读类型；submit_hub_decision/request_human 可带严格版本化 plan_basis。字段、只读证明、单步预算、错误/重试边界见 [Plan 协议范围](../PLAN_GAP_PROJECTION.md#b既有-intent-上的一次补证)；OpenAPI 输入 schema 由 shared-types 派生，无新写入 API。

## Finding 特征元数据（#770 C）

既有 GET /findings/:id 增加 project_research_features 状态与声明字段覆盖，沿用 findings:read 和项目授权。失败/过期不返回旧特征正文，普通 Job 无新增接口；无关系写入/自动处置接口。细节、质量门与验证见[项目 Finding 特征研究](../PROJECT_FINDING_RESEARCH.md)。

## Finding 词法检索（#770 D 检索首片）

`GET /findings/:id/lexical-search` 使用既有 `findings:read` 与项目鉴权，当前声明文本按128来源窗口seek后排名最多25项，返回游标、窗口/排名截断、声明摘要与规则版本。主体变更使游标409失效；无缓存关系、Evidence内容或资产权限扩张。详情只展示待核验词法候选，不作全项目top-K或同问题判定。字段、权限矩阵、来源跳转及完整D缺口见[专题](../PROJECT_FINDING_RESEARCH.md#当前声明文本检索770-d-检索首片)。


`GET /findings/:id/candidates` 沿用 findings:read/项目权限，以25条边窗口读取当前有效持久词法候选。活动代/主体输入改变使游标409失效；失效记录不补扫，可能返回有下一页的空窗口。Web 区分待计算、失败、过期、成功零项与重建。无关系写 API、强关系或处置传播，见[持久候选协议](../PROJECT_FINDING_RESEARCH.md#持久词法候选与代际失效770-d-后续切片)。
