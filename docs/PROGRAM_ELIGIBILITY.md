# 程序资格评审（#822）

> 状态：实现；资格评审与技术 Verify 分离。

程序资格是 Finding 技术确认之外的独立投影。当前实现使用既有 `audit_logs` append-only 账本保存可信程序材料、撤销/替代事件和资格评审，不新增 Job、Control operation 或执行通道。

## 约束

- 可信材料只能通过管理 API 登记。任务契约中的 `operator_supplied` 规则不会自动成为可信材料。
- 评审请求不接受 reviewer 身份、权限或资格状态字段。Scheduler 从已认证 `req.actor` 冻结 reviewer identity 和 `findings:write`/`admin` permission。
- 通过记录绑定具体 Finding、Artifact revision/source digest、当前 Verify confirmed round、可信材料 program/version/source hash/target/baseline、当前证据引用摘要、理由和时间。
- `internal`/Agent actor、viewer、maker 对应的非授权主体不能批准。无当前证据、技术确认、可信材料、完整规则、目标/基线或版本一致性时 fail closed。
- 材料替代或撤销不改写历史评审；当前投影会将旧绑定标记为 stale/blocked。当前有效批准与拒绝并存时为 conflict/blocked。
- `eligible` 只代表当前独立资格评审仍有效；`technical_status=confirmed`、通用目标判据满足和 `program_rule_review.rules_satisfied` 均不能单独推导资格。
- `ineligible` 是当前有依据的明确否定；`blocked` 表示前置条件、历史、证据或规则状态无法安全判定，不能当作否定。
- 旧评审保留在 `audit_logs`，查询时重新读取当前 Finding/Verify/Evidence 和材料状态。损坏、截断或无法解析的历史会把当前投影置为 `blocked`。

## 接口

路由模块位于 `apps/scheduler/src/domains/program-eligibility/routes.ts`，由主路由注册器接入。OpenAPI 操作和组件片段位于同域 `openapi.ts`，并已并入全局 OpenAPI 文档。

- `POST/GET /program-materials`
- `GET /program-materials/:id`
- `POST /program-materials/:id/revoke`
- `POST/GET /findings/:id/program-eligibility/reviews`
- `GET /findings/:id/program-eligibility`

资格状态只读查询历史账本并重新核对 Finding/Verify/Artifact/Evidence 当前状态，不从审计文本或关键词推断。

## 主集成器接线

本片不需要数据库迁移或 SQL 片段。主集成器需要把 shared schema 加入统一导出，并在认证/项目 Hook 完成后注册域路由：

```ts
// packages/shared-types/src/index.ts
export * from "./program-eligibility.js";

// apps/scheduler/src/routes.ts
import { registerProgramEligibilityRoutes } from "./domains/program-eligibility/index.js";
registerProgramEligibilityRoutes(app);
```

还要把七个路由加入 `apps/scheduler/src/auth.ts` 的固定 scope 表：材料列表/详情使用 `projects:read`，材料登记/撤销使用 `projects:write`，评审写入使用 `findings:write`，两个 Finding 查询使用 `findings:read`。OpenAPI 操作已经由 `apps/scheduler/src/openapi.ts` 合并域操作和组件。

离线单元覆盖 strict schema、身份冻结、fail-closed 投影和报告分离；PostgreSQL 集成测试在设置 `TEST_DATABASE_URL` 时覆盖真实路由、append-only audit SQL、幂等/并发、版本替代、撤销、证据变更和重启重读。未设置该环境变量时不声称集成测试通过。
