# 0011. 可信目标授权由 Scheduler 宿主 authority 只读判定

> 状态：**已采纳**
> 原决策日期：2026-10-31（由 `f06c3ddf`、`198f4f72` 提交时间核对）
> 同步日期：2026-10-31
> 来源：#767；目标授权实现与 terminal/follow-on 生命周期修复
> 关联需求：FR-TASK-006、FR-HUB-002、FR-HUB-003、FR-HUB-005、FR-JOB-009、FR-CRED-001、FR-CRED-002、FR-IMG-001、FR-IMG-003、NFR-REL-008

## 背景

任务契约可以声明目标、身份、动作和前置条件，但这些声明不能证明当前主体真的有权写目标。把 URL、secret、authority ID 或“已允许”字段交给任务、Canvas、Job 或模型，会把不可信输入提升为执行授权，也无法在撤权、策略变更或配置漂移后收敛旧 Job。#767 还要求目标写入与现有 Job/Attempt、Hub follow-on 和审计保持同一可信内核边界。

## 决策

- Scheduler 采用 `deepsonar.target-authorization/v1` 的只读 authority 适配器。当前只支持 `reference-http/v1` 的单一目标描述及固定的 `save → publish → trigger` 动作链；authority 只回答当前请求是否被允许，不接收或执行目标动作。
- authority URL、稳定 ID、secret 引用、动作链和传输限制只从 Scheduler 宿主环境读取。secret 只在 Scheduler 进程内用于 HTTP 请求，既不进入请求体、Job snapshot、Canvas、audit、feedback，也不进入 Evidence；任务或模型不能覆盖这些配置。
- Scheduler 生成请求并绑定项目、目标、认证主体、tenant/role/resource、精确动作、必需前置条件、原始内容 SHA、规范化 task-contract SHA、派生 revision、authority 配置身份和 freshness。response 必须严格复述作用域和 binding，按顺序 allow 每个动作，满足每个前置条件，并在有效 freshness 内返回 authority revision 与 expiry；宽泛的 read grant 不能转换成 write。
- 初次创建在 Canvas/Job 产生前完成检查；成功结果只生成 secret-free snapshot，并在创建事务写入 `audit_logs` 的 `task.target_authorization` Scheduler-owned grant。Job snapshot 冻结该 grant，`Dispatcher` 在 sandbox provisioning 前用冻结 authority revision 重新检查；`resume-frozen` 与 `rerun-current` 在中断 Attempt、撤销 grant、改变 Job 状态或转回 pending 前检查。child/system follow-on Job 只能从该审计账本继承与权威 Canvas 内容和契约一致的 grant；Canvas metadata 不能替代 host grant。
- grant 缺失、配置或 authority revision 改变、撤权/过期、身份或目标不匹配、动作或前置条件不完整、内容/契约 binding 变化、响应越界或 secret 不可用均 fail closed。`target_authorization_grant_invalid` 是非重试错误；创建不建 Canvas/Job，执行不创建 sandbox 或目标动作，rerun 不先中断既有 Attempt。
- Hub/Report 后置 admission 在 savepoint 中处理 grant 拒绝：回滚本批新 Job，保留前驱已写入的 terminal result，并持久暂停 Canvas convergence。Plan v2 依赖 admission 采用同一错误持久停止，不撤销前驱已证明输出。既有 Job 的 snapshot、Evidence 和审计历史不被重写，也不使用旧 grant fallback。

## 状态

2026-10-31 已按上述边界接入创建、派发、resume/rerun、PATCH 和 Hub/Report follow-on 路径。机器契约、配置解析、HTTP client、snapshot 和 grant ledger 位于 [`target-authorization`](../../../apps/scheduler/src/domains/target-authorization/)、[`task-contract-preflight.ts`](../../../apps/scheduler/src/task-contract-preflight.ts) 与 [`sandbox-limits.ts`](../../../apps/scheduler/src/domains/role-runtime-snapshot/sandbox-limits.ts)。专题说明见 [`TARGET_AUTHORIZATION.md`](../../TARGET_AUTHORIZATION.md)。

## 后果

- 目标身份和动作授权具有可复核的项目/主体/内容/契约/revision 绑定；模型只能提出契约和后续 Intent，不能伪造 authority 或扩大作用域。
- live preprovision/rerun 检查阻止撤权后的新副作用，集中 grant ledger 让 child/system Job 继承同一权威来源；savepoint 保证后置 admission 失败不抹掉前驱已证明结果。
- authority 不可用、响应过期或配置错误会阻塞目标写入，操作员必须修复平台 authority 或重新创建当前契约；系统不会把失败自动降级成只读目标或猜测目标动作未发生。
- 当前协议不证明任意外部目标可写，也不提供生产 target-action client。离线 HTTP/SQL 夹具和 fake Worker 只能证明 Scheduler 边界；真实目标、生产部署和真实模型质量仍未验证。

## 替代方案

- 让任务或模型提交 authority URL、secret、grant 或“已允许”字段：可伪造身份并绕过平台撤权，拒绝。
- 由 Scheduler 直接尝试目标写入来“验证授权”：把授权检查和外部副作用混在一起，违反 effect/settlement 与未知效果边界，拒绝。
- 把 broad read 或同项目旧 grant 推导成 write：无法证明精确动作、内容和当前 policy revision，拒绝。
- 在 Canvas metadata 保存可覆盖的 grant，或为目标动作建立第二执行队列：绕过 Scheduler-owned 审计/Job/Attempt 边界，拒绝。

## 验证边界

代码测试入口为 [`target-authorization.test.ts`](../../../apps/scheduler/src/domains/target-authorization/target-authorization.test.ts)、[`target-authorization.integration.test.ts`](../../../apps/scheduler/src/domains/target-authorization/target-authorization.integration.test.ts) 及其现有 CI 脚本。它们覆盖严格 HTTP/SQL contract、secret 脱敏、binding/revision/prerequisite、撤权、配置漂移、live dispatch、resume/rerun、child/system grant、PATCH 原子性和 savepoint 行为；是否由本轮全局 CI 通过，以精确 PR head 的实际结果为准，不能由本文推断。
