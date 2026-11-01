# 程序资格评审（#822）

> 状态：**as-built；定向离线行为已验证，最终 CI 另行验收**。资格评审与技术 Verify 分离。
> 同步日期：2026-10-31

程序资格是 Finding 技术确认之外的独立投影。实现复用现有 `audit_logs` append-only 账本保存操作员准入的程序材料、撤销/替代事件及资格评审，不新增 Job、Control operation 或执行通道。对应 FR-FIND-008，决策见 [ADR-0010](architecture/adr/0010-program-eligibility-authority.md)。

## authority 和范围

- 程序材料须通过管理 API 显式准入。任务契约中的 `operator_supplied` 规则不会自动成为可信材料。
- 平台材料要求未绑定项目的管理员；项目材料要求当前 actor 对该项目有管理权限。项目绑定的管理员 token 也不能准入平台或其他项目材料。
- 材料是操作员见证，不认证外部官方签名、站点所有权或规则 URL 内容。`source_sha256` 是准入材料的来源身份；Scheduler 另计算规范化登记摘要，不把两种摘要混同。
- 评审请求不接受 reviewer 身份、权限或资格状态字段。Scheduler 从认证 `req.actor` 冻结主体及 `findings:write`/`admin` 权限。Agent/internal actor、viewer 和已识别的 Finding maker 不能批准。
- 这里认证平台主体及已知来源隔离，不认证自然人或模型之间的物理独立性。可提交资格也不授予目标写权限，不自动提交漏洞或联系外部程序。

## 当前有效性

没有独立评审且历史完整时保持 `not_assessed`，并列出技术或材料缺项；已有评审失效时为 `blocked`。历史损坏即使没有可解析的评审也保持 `blocked`。

评审绑定具体 Finding、Artifact revision/source digest、来源及 Verify Attempt、当前 confirmed round、来源 Job 冻结契约中的目标/基线、准入材料的 program/version/source hash、当前证据指纹、理由和时间。请求不能通过匹配任意材料自报一个 Finding 未获准的目标。

材料替代、撤销和来源/Attempt/证据变化不会改写旧评审；当前投影重新校验。当前有效批准与拒绝并存时为 `blocked`，不用最后写入覆盖先前结论。`eligible` 只表示当前操作员资格评审仍有效；技术 `confirmed`、普通目标判据满足和 `program_rule_review.rules_satisfied` 均不能单独推导资格。`ineligible` 是有依据的明确否定，`blocked` 表示无法安全判断。

评审写入按 Canvas 优先顺序锁定材料生命周期及相关 Job/Finding/证据，再读取当前输入。幂等响应也校验项目范围。独立查询在同一 repeatable-read 只读快照内读取 Finding、材料、评审和证据；报告已有事务保持 Canvas 输入锁及材料共享锁。历史损坏、截断、证据不可用或预算不足使当前投影阻断；批量预算外的条目显式返回 `eligibility_projection_limit_exceeded`，不静默丢弃。上限及字节预算以 [store.ts](../apps/scheduler/src/domains/program-eligibility/store.ts) 为准，不作为容量或 SLA 证据。

## 管理接口

路由已由 [主路由注册器](../apps/scheduler/src/routes.ts) 在认证和项目 hook 后接入；固定 scope 表位于 [auth.ts](../apps/scheduler/src/auth.ts)。

| 接口 | 基础 scope | 附加边界 |
| --- | --- | --- |
| `GET /program-materials`、`GET /program-materials/:id` | `projects:read` | 只读平台或 actor 项目可见材料 |
| `POST /program-materials`、`POST /program-materials/:id/revoke` | `projects:write` | 另校验平台/项目材料管理权限 |
| `POST /findings/:id/program-eligibility/reviews` | `findings:write` | 认证操作员、项目范围、maker 隔离及当前依据 |
| `GET /findings/:id/program-eligibility`、`GET /findings/:id/program-eligibility/reviews` | `findings:read` | 当前投影与不可变历史，不扩大证据读取权限 |

登记/评审的 `idempotency_key` 与服务端生成的 `material_id`/`review_id` 不同。严格机器契约位于 [shared schema](../packages/shared-types/src/program-eligibility.ts)；请求和响应见 [域 OpenAPI](../apps/scheduler/src/domains/program-eligibility/openapi.ts)，已并入全局文档和路由面清单。

## 报告与验证

[任务报告](TASK_OUTCOME_REPORT.md) 消费独立资格投影；资格不能替代通用目标判据或 Plan 完成 authority。未评审、失效和预算不足分别保留缺口。

2026-10-31 域内定向验证：Windows Node 与真实隔离 PostgreSQL 下，schema/model/routes/report 及既有任务报告单元共 35 项通过，路由/SQL 集成共 12 项通过，无跳过。覆盖真实管理 token 与 Job capability 分离、来源和版本不符、身份伪造/越权、项目绑定管理员、幂等并发及跨项目重放、多条当前评审、Verify Attempt 变化、Canvas 并发重验、材料替代/撤销、证据变化、未知效果、预算及重启重读。未执行生产任务或真实模型质量试验；最终组合 GitHub CI 尚未完成。主路由、OpenAPI、scope、测试接线、文档与体量的本地门禁另有 44 项通过；这些结果不代表外部程序资格已经通过。

单元已接入 `pnpm ci:unit:verify-eligibility`，数据库测试已接入 `pnpm ci:integration:verify-eligibility`；全局路由/scope 由 `pnpm ci:unit:authz` 检查。2026-10-31 集成分支按这些脚本中的同一文件清单以本地 Windows Node 执行，分别通过 186、24、78 项；资格状态修正后的 `ci:integration:authz-boundaries` 文件清单另通过 85 项。前述定向结果与这些组合有重叠，不重复加总。未设置 `TEST_DATABASE_URL` 时集成测试明确跳过，不能声称通过。该功能不改 schema 基线。
