> 状态：as-built（#815 B 的 Gateway、账本与用量投影；本地替身和隔离 SQL 验证不代表真实模型效果或完整平台验收）
> 同步日期：2026-10-31

# Pi Observational Memory Gateway

## 身份与冻结范围

只有当前 Job 的 admitted frozen `pi_extensions` 包含 `pi-observational-memory` 时，
Scheduler 才为该 Job 签发独立的 `observational_memory` token。主运行使用 `main`
token。两者共用原有 Job、Attempt、Model Gateway 和 effect/usage ledger。

workload 只来自 `job_tokens.workload`，不接受请求 header、body 或模型名自报。
签发校验项目、凭据、Pi CLI、扩展 package/version/integrity/entry，以及 frozen
Job model。OM 的 `source_model` 必须等于主 Job 的 frozen model，不能增加第二个模型。
签发参数中的模型清单和请求额度不能扩大 OM 的冻结授权。

OM token 保存唯一的 `expected_provider`、`expected_model` 和 `expected_route`。
协议来自 frozen Pi provider/model profile；model 的 `api` 覆盖 provider `api`。
已有 frozen `models.json` 损坏、缺少 provider/model 或协议不受支持时直接拒绝，
不能改读另一份 settings 配置来延续请求。OM 不经过 main CLI alias rewrite，
只能向精确 route 提交指定模型的 POST。

每次请求在 Job 锁内重新检查冻结范围、token、有效期和 Job 状态。Job 进入
`succeeded`、`failed`、`timeout`、`cancelled` 或 `orphan` 后，两个 workload token
均不可使用；撤销与请求准入共享 Job 锁。语义终态提交在同一事务内撤销模型和 Control 令牌并写撤销审计，回滚时一起恢复；独立清理路径复用同一撤销实现。已经开始的上游请求仍须记账，终态和撤销
不能删除它的 usage 或覆盖 unknown effect。签发与记账不回写 Job snapshot。

## 请求配额

冻结的 `runtime_knobs.job_token_max_requests` 为 0 或未设置时，总请求数不限。
系统不推导百分比，不自动分配 main/background 额度。

有限总额要求 frozen OM config 显式提供 `request_budget`，例如：

```json
{
  "total_requests": 10,
  "main_requests": 7,
  "background_requests": 3
}
```

三个值必须是正整数；`total_requests` 必须等于 frozen Job 总额，main 与
background 之和不能超过 total。没有分配的剩余额度不会自动转给另一 workload。
可选 `background_limits.max_requests` 可以进一步收紧后台 allocation；0 表示该
附加维度不限，不能取消已有的 finite allocation。

准入在 Job 锁内按该 Job 的全部 token 聚合请求数，包括轮换、过期、耗尽和已撤销
token 的历史计数。main reservation 在第一个后台 token 签发之前就生效；创建或
轮换多个 token 不会扩大 main、background 或 total allowance。独立后台 cap 的
429 不消耗 main request/token reserve。

## Token 用量、pending 与 unknown

`background_limits.max_tokens` 为 0 或未设置时，该 token 维度不限。正数限制以
现有 effect/usage ledger 累计，并约束请求中的输出上限。输入和缓存成本只能在
响应后确认，因此这属于累计熔断，不能据此声称已知调用前的精确总 token 上界。
后台用量不会占用 main 的独立 token 或 repair allowance。

后台的未结算请求保留其 effect，并阻止另一个后台上游调用。有限 token allowance
不会因并发或轮换被重复取得。尚有请求额度但存在 pending 时返回
`409 workload_usage_pending`；请求额度已用完时可返回独立 429。已确认 unknown、
缺失 usage 或无法对账的效果优先返回 `409 workload_usage_unknown`，不能伪装成
可以降级的配额 429。main 的独立准入不消费这些后台额度。

每次后台准入只发起一次上游尝试，包括 unlimited 配额；不自动重放可能已经产生
外部效果的请求。后台 JSON/SSE 响应在内存中有界缓冲，最多 16 MiB；只有现有严格
协议 scanner 确认 terminal usage，且数据库结算成功后，才返回正常响应。
错误状态、断流、超限、缺失或伪造 usage 均进入 unknown 并返回明确的 409；provider 5xx/error prose 不自动等价于“请求未开始”。只有内核已证实的 known-never-started transport failure 才能按 `gateway_transient` + `effect_status=not_started` 走可见降级。
上游请求/响应正文不落库。

当前请求前失败分类只接受 Node 原生连接或 DNS 错误链，见
[`gateway-om-budget.ts`](../apps/scheduler/src/gateway-om-budget.ts)。每个聚合错误叶子都须符合要求；超时、连接后断流、权限或协议错误不能继承一个连接失败 cause 后降级。返回 `503 gateway_transient` 前，Gateway 必须在 Job 锁内核对当前 pending reservation、写入 settled 零用量账本并持久结算 `never_started`，请求次数不退还。结算冲突或写入失败仍返回对账错误。provider 自报的同名 JSON、SSE error 和 Pi 会转述的 Anthropic refusal 字段不能冒充内核结果。零外部用量不等于已经完成价格计算。

usage、effect settlement 和 token counter 在同一事务内写入。账本事务失败时，
原 effect 保持 pending，调用方得到对账错误，后续后台请求不能再次出站；不能在
内存中补造成功账单。权限、provider/model/route、snapshot、完整性、协议、撤销和
未知外部效果错误都保留硬失败边界。

## 账本与展示

`job_usage_ledger.workload` 和指向 `job_tokens` 的 `job_token_id` 外键记录归因。
新 Gateway 写入总是包含 token id；旧冻结历史允许没有该引用，并按 main 读取。
schema 只修改 baseline，与 `schema-version.ts` 一起使用本分支集成编号；没有新增
ALTER 迁移链。父任务统一处理与其他分支的最终 schema 编号。

Dashboard usage 的总量和日序列保留完整观测，并返回 `workloads.main` 与
`workloads.observational_memory` 的独立计数及结算状态。项目和任务成本列表只含
main；相同 provider/model 按 workload 拆成不同模型行，后台成本独立显示。

Finding quality cost 和 replay 的 hub/canvas tokens 只消费 main。后台 tokens 与
requests 另行保留用于对账，不摊入 Finding 或任务单位成本。Job detail 按
`observed_at, id` 倒序返回最近 100 条，显示各 workload 的 token、缓存、未知用量
和逐请求模型；这不是整个 Job 的完整账单。Session viewer 的配合范围见
[RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md)。

## 本地验证与父任务接线

离线入口（2026-10-31 已执行）：

- `apps/scheduler/src/gateway-om-budget.test.ts`：finite/unlimited 预算、严格字段、
  frozen model、provider 和 per-model 协议。
- `apps/scheduler/src/gateway-om-budget.integration.test.ts`：每次创建并删除自己的
  PostgreSQL 数据库；Fastify fake upstream 验证额度竞争、token 轮换、main reserve、
  pending/unknown、缺失与截断 usage、16 MiB 上限、账本失败、所有终态撤销、过期、
  scope 拒绝、外键和 SQL usage/quality 投影。
- 既有 `gateway-usage.test.ts`、`gateway-repair-usage.test.ts`、
  `gateway-repair-budget.integration.test.ts`、`gateway-retry.test.ts` 与
  `gateway-body-limit.test.ts` 提供相关回归。
- dashboard 的 `usage.test.ts`、`quality.test.ts`、`replay.test.ts` 验证单位成本排除；
  Web `usage-ledger.test.ts` 包含真实 React 渲染，验证后台成本与未知用量独立展示。
- 2026-10-31 主线程在当前根代码上运行 Gateway OM unit/SQL、usage、retry、repair usage 和 repair SQL 六个入口，44 项通过、无跳过；覆盖真实关闭的 loopback 端口、持久零用量、配额不退还、provider 冒充、部分流、结算失败及跨 provider/workload 的用量投影。Linux Unix-socket 相关四项也通过。夹具的投影窗口由自身账本时间范围确定，避免主机时钟与数据库时间精度影响计数。

使用已有 disposable `TEST_DATABASE_URL` 和本地 Node/tsx，无需设置示例密码：

```powershell
D:\nodejs\node.exe apps\scheduler\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 `
  apps\scheduler\src\gateway-om-budget.test.ts `
  apps\scheduler\src\gateway-om-budget.integration.test.ts
```

该部分对应 `FR-CRED-003` / `FR-CRED-004` 的 Gateway 与短期 token 边界。主协调者
拥有根 `package.json` 的测试入口、CI 接线、架构追溯和顶层索引同步；本片没有
修改这些文件。当前本地测试不等于 GitHub Actions 全量验收。本地实际构建镜像的
RPC、封装预检和独立生产启动守卫正负例已通过，集中见
[RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；
发布镜像/平台与 registry/catalog 证据仍另验，质量和成本收益保持 `unknown`。
