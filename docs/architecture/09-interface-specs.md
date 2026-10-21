# 09 接口与协议边界

> 状态：**as-built**（#741）。说明 Management、Control、Gateway、流和导入接口的认证、幂等、错误和修复反馈边界；字段细节以 OpenAPI 与 shared schema 为准。
> 同步日期：2026-10-21

完整 HTTP 路由和字段只在 [`openapi.ts`](../../apps/scheduler/src/openapi.ts) 及其 shared Zod schema 中维护；路由面和 OpenAPI 一致性由 [`route-surface.test.ts`](../../apps/scheduler/src/route-surface.test.ts) 与 [`openapi.test.ts`](../../apps/scheduler/src/openapi.test.ts) 覆盖。本文解释协议语义，不复制全部请求字段。

## Management API

Management API 面向用户、Web 和受信任自动化，包含项目/任务、Canvas、Job 控制、Finding/报告、设置、镜像、凭据、设备、Worker、导入导出、平台 claim、只读平台版本发现和审计等入口。管理员只读 `GET /platform/updates` 读取 catalog 同步路径最近一次写入的当前部署与 `platform` 信息比较结果；它不触发新的比较，也不执行升级、apply 或 rollback，项目 token 不能调用。管理 API token 以 hash/prefix 存储，明文只在创建或轮换时返回；token scope 与 path project scope 同时校验。Provider credential 与平台 API token 分离，凭据密文使用 nonce/auth tag 存储，常规 credential projection 不含 ciphertext；现有设置编辑契约允许特定 `settings_config` 字段携带账户配置值，因此该响应仍受管理 scope、审计和脱敏规则约束。Job snapshot 投影不携带长期 secret。

项目 RoleConfig 写入拒绝 `agent_cli` / `model`，读取不暴露这两个字段；全局 CLI 接受 NULL 表示未指定偏好。项目 RoleConfig 导出不含这两项，导入含这两项（即使为 NULL）也拒绝；全局导入未指定 CLI 保持 NULL。项目 Agent 设置分别表达 CLI 和凭据白名单是否显式收紧，`credential_ids_configured` 区分未配置与空名单，设置读取不持久化凭据 ID。readiness 的检查项可携带与 Job 解析同源的 RepairFeedback；悬空/停用白名单要求管理员修复，不能通过 Agent 提交账号 ID 或 OCI 地址绕过（#757）。

管理认证入口有明确的健康、schema、bootstrap、Worker 注册和 WS ticket 例外；`/gateway` 与 `/control/v1/jobs` 使用独立的 Job-scoped 凭据。认证失败和授权拒绝会审计但不记录 token、Provider 原文或内部堆栈。旧配置不通过转换继续运行，不能用另一个认证面绕过当前契约。

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


## 宿主维护升级接口

平台版本发现 API 保持只读，不能触发 Compose 变更。宿主维护控制器使用固定目标、结构计划 hash、generation 和部署绑定推进；风险计划需要明确批准，角色身份清除不是维护许可的隐含动作。目标 schema CLI 以 stdin 接收连接及动作，plan 使用只读事务，apply 只接受归属明确的候选库；返回结构化错误，不输出驱动原始错误或秘密。管理入口在 preparing 或身份不匹配时拒绝业务请求；当前宿主动作包括 `check`、`apply`、`rollback`、`resume-rollback`，风险批准使用 `--approve-plan-hash`，受管清单使用 `--nodes`。`--reset-role-identity` 已接 #758 目标重建，只在明确选择并批准对应 hash 时清角色 CLI 与项目 model，保留全局 model 和历史快照。`resume-rollback` 已接本地回执与维护源代的受管节点恢复；旧源没有维护契约且含远程节点时仍保持隔离，真实端到端验收未完成。具体参数以部署说明及最终验收为准。[ADR 0008](adr/0008-maintenance-candidate-upgrade.md) 规定了激活未知不得回旧的恢复边界。
