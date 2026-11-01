# 03 约束与设计原则

> 状态：**as-built**（#741；#767/#775 同步）。集中说明跨模块必须保持的内核约束和配置覆盖规则；领域细节由专题文档单源维护。
> 同步日期：2026-10-31

这些规则来自 [DESIGN.md](../../DESIGN.md)、[AI_NATIVE_TRUSTED_KERNEL.md](../AI_NATIVE_TRUSTED_KERNEL.md) 和现有代码。本文只保留跨视图都需要的约束；Job 状态、事件锁序、研究/报告语义等细节分别链接到其权威专题，避免在多处维护同一矩阵。

## 注意力成本

跨模块设计与评审遵守 [DESIGN 的单一权威原则](../../DESIGN.md#核心理念优化人的注意力)，需求登记为 NFR-UX-001。评估新增概念、Agent、配置、通知和流程是否减少用户的总负担；先复用已有能力，不把可自行核实的工作转交用户。可行动信息、风险和证据必须可见，少打扰不改变下列授权、真相、未知效果和验证边界。具体评审与正反例见 [工程规范](11-engineering-specs.md#11-注意力成本评审830)。

## 不可绕过的原则

1. **四类真相各司其职。** PostgreSQL/API 保存管理和审计真相；Canvas 保存过程和观察真相；Sandbox/Evidence 保存执行和原始证据真相；Scheduler 是唯一具有副作用的执行者。模型文本、普通 CLI 输出和实时总线都不能单独提升为语义事实。
2. **Agent 只提案。** Agent 使用短期 Job capability token，通过严格的 Control operation 提交进度、Fact、Finding、Hub 决策、Plan v2/Result、人工请求和完成信号。宿主在共享 schema、作用域、快照、预算和状态机边界内校验并落库；Plan v2 仍由 Scheduler 通过既有 Intent materializer 派发。
3. **权限随 Job 快照冻结。** Job 创建时冻结 CLI、Provider/model、运行时镜像摘要、能力 selector/digest、工具、网络、设备、runtime knobs 和适用的 secret-free target authorization snapshot。Dispatcher 执行时不回退到最新 RoleConfig；目标授权必须在 provisioning、resume/rerun 前实时复核，受影响的 child/system follow-on Job 只能继承 Scheduler 审计账本中的权威 grant；历史 Job 的快照、证据和审计不可变。
4. **平台边界优先于业务组合。** Capability Pack、Skill、CLI 扩展和 Provider 组合可以插拔，但只能使用已经准入的工具、镜像、网络、凭据、项目范围、预算和操作 allowlist。业务能力不能建立第二条执行通道。
5. **失败必须可分类。** 规范要求可修正的 schema、引用、权限、状态和字节限制问题返回版本化 RepairFeedback；反馈至少携带稳定分类、错误码、operation、字段路径、脱敏消息/观测形状、当前状态引用、已接受效果、幂等键、提案/修正次数、剩余预算和下一步。瞬态错误只在规定范围内重试；外部效果未知时停止自动重放并进入对账或人工路径；永久错误 fail closed。目标授权 grant 缺失、漂移或与权威 Canvas 不匹配时使用非重试的 `target_authorization_grant_invalid`，不得用旧 grant 回退或扩大权限。当前实现只在部分 Control schema/语义 payload 校验路径构造完整 envelope，Hub、Verify、Completion Gate 和完整 Proposal/Receipt/Settlement 尚未统一，见 [D-03 风险登记](12-risks-and-tech-debt.md#2-当前实现债务)；实现缺口不能改写上述规范。
6. **当前契约是唯一输入。** 已废弃配置不转换、不双读双写、不使用兼容 shim；只有既有 Job 快照和历史结果作为不可变历史保留。Plan v1 仅可读取历史，新的写入和执行只接纳 v2；新运行时遇到不符合当前契约的输入必须拒绝。
7. **审计和幂等与副作用同行。** 语义事件通过事件去重、Job 序列、事件速率和业务事务写入；外部效果先登记 effect，再结算。取消、超时、重启、迟到回调和清理都必须可重复执行。Hub/Report 的 follow-on admission 失败在 savepoint 内回滚新增批次，保留前驱终态并暂停 Canvas；Plan 依赖准入同样持久停止，不撤销前驱已证明结果。

## 约束边界

| 边界 | 内核负责 | 组合能力或外部系统不能做的事 |
| --- | --- | --- |
| 身份和项目 | 管理 token、作用域、审计、Job token/capability token | 不能用模型输入、普通文本或猜测的管理接口取得权限 |
| 沙箱和资源 | 镜像摘要、网络、凭据、资源预算、Attempt、lease、清理和效果结算 | 不能让 Agent 自行启动容器、安装任意扩展或扩大项目范围 |
| 过程与事实 | Canvas 节点/边、Fact 验证状态、Artifact、Finding、Verify 门 | 不能由制造者文本直接推断 Verify 或报告结论 |
| 研究与报告 | Research 只做语义聚类/锚点/相对优先级；Report 只消费冻结输入 | Research 不能改严重性、验证门、Fact 状态或报告收敛 |
| 目标授权 | Scheduler 读取平台 authority，绑定项目、目标、认证主体、声明身份、动作、前置条件、内容/契约摘要和 revision，并将无 secret 的 grant 写入审计/Job 快照 | 任务和模型只能声明待核验身份，不能提供 authority URL、secret、权威动作链或 grant，也不能自证授权；authority 只读、不执行目标动作 |
| Plan v2 | Scheduler 由授权用户目标 CAS、路线 CAS、现有 Hub Intent admission、Job/Attempt 和持久停止投影负责执行；`graph_query(kind=plan_objective)` 仅按当前 Job scope 独立读取完整持久化 objective tuple，不依赖或返回 `acceptedPlan`；initial L0/overview 只给有界 handle，budget 不足或 `input_sha256` 不匹配时如实失败 | 模型不能改写目标/完成标准/预算，不能用 PlanResult、Artifact 绑定或新 key 重置 lifetime 预算，也不能建立第二执行通道；selectors、cross-scope 和 whole-graph 查询不得绕过 Job scope |
| 外部效果 | Gateway、OpenSandbox、设备、Registry、导入包的边界校验和对账 | 未知效果不能按“可能没发生”自动再做一次 |

状态机的所有权、Canvas-first 事务和领域间依赖以 [ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md](../ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md) 为准；本文不复制其锁序表。

## 配置覆盖优先级

Batch-1 runtime knobs 使用固定优先级：**Job > 角色 > 项目 > 平台 > env 引导**。Job 层只读创建期 `agent_snapshot_json`；角色和项目层提供创建快照的候选配置；平台层提供全局准入和默认值；env 只负责启动 Scheduler 所需的引导设置。Dispatcher、Worker 和 Agent 不能在执行期间把高层覆盖为新值。该优先级是 runtime knobs 的解析规则，不是所有配置的通用继承模型。

能力、Provider/model、CLI、镜像、网络和设备分别使用各自的 allowlist、快照 resolver、Canvas 网络策略或租约规则；不能从 runtime-knob 五层优先级推导这些字段也支持相同覆盖。所有 resolver 仍只能收紧平台硬边界，不能扩大镜像、凭据、项目范围或 operation allowlist。实现入口包括 [`runtime-knobs.ts`](../../apps/scheduler/src/runtime-knobs.ts)、[`core.ts`](../../apps/scheduler/src/core.ts)、[`config.ts`](../../apps/scheduler/src/config.ts) 和 `role-runtime-snapshot` 域。

目标授权的 authority URL、authority ID、secret 引用、动作链和传输边界只从 Scheduler 宿主环境读取；它们不是 Job、Canvas、任务内容或模型可覆盖的 runtime knobs。secret 只用于 Scheduler 进程内的 authority 请求，Job snapshot 与 audit grant 只保存可审计的非秘密配置身份和判定摘要，具体边界见 [ADR-0011](adr/0011-trusted-target-authorization.md)。

## 可信输入与可插拔性

- Capability 目录是选择入口，实际授权由 Job-scoped discovery 和 materialization operation 完成；目录描述不等于授权。
- Skill 拉取返回 selector 和 content hash，拉取内容不能改变 Job 快照的权限边界；来源必须是平台 trusted 且 enabled 的来源。
- Provider 账号与平台 API token 分离；短期 Gateway/Job 凭据只在需要的调用中使用，并且不写入快照、日志和 Evidence。
- 第三方镜像、导入包、设备和模型输出都按不可信输入处理；验证通过后仍受项目 scope、预算、审计和终态状态机限制。
- 目标 authority 的 allow 只证明精确声明在当前 revision/前置条件下被平台 authority 接受，不证明目标动作已经执行；Plan v2 的 `plan.output` 只证明工程上的来源和留存关联，不是语义完成 authority。
- Scheduler 之外的应用和包通过共享类型或明确的运行时契约连接；禁止通过隐式全局状态制造第二套协议。
