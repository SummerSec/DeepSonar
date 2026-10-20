# 12. 风险与技术债

> 状态：**as-built（风险登记，#741 PR 5 回填）**。本文只登记当前实现仍有证据支持的缺口、风险和有意暂缓项；已完成的历史决策不重复列为待办。
> 同步日期：2026-10-20

风险登记以当前代码、schema、OpenAPI、测试和已维护专题为证据。issue 只作为来源或后续协调入口；本次回填没有核实历史讨论的原始日期，也不把计划文本写成已实现能力。

## 1. 判定规则

- **实现债务**：当前路径能运行，但仍有明确的旧边界、重复事实或运维缺口；修复前必须保留现有安全边界和审计语义。
- **暂缓设计**：问题已经识别，当前方案刻意不推进；只有新的需求、边界证据和对应架构评审才能解除暂缓。
- **接受的运行时边界**：行为已被代码显式表达并有测试覆盖，风险通过 `unavailable`、`inconclusive`、`needs_human` 或人工操作显式呈现，不把它伪装成成功。
- **不列为债务**：已完成的决策、已经接线的测试和历史材料中的旧待办，不因仍有后续增强空间而重新列入待办。

等级只用于排序，不代表没有证据的精确概率：高表示会破坏权限、事实或副作用边界；中表示会阻塞可恢复性、运维或交付；低表示改进体验、吞吐或未来演进成本。

## 2. 当前实现债务

| 编号 | 等级 | 当前事实与证据 | 影响 | 处理边界 / 触发条件 |
| --- | --- | --- | --- | --- |
| D-01 | 中 | 多 Scheduler 使用各自本地 `BLOB_DIR` 时，过程流非持有副本返回 `visibility=unavailable`，WebSocket 以 4415 关闭；`stream-bus` 只在进程内缓存。代码见 [`process-stream-policy.ts`](../../apps/scheduler/src/process-stream-policy.ts)、[`evidence.ts`](../../apps/scheduler/src/evidence.ts)。 | 非共享卷部署无法提供跨副本过程流连续性；客户端必须处理显式不可见状态。 | 共享卷可证明可见性后才扩大支持面；在此之前保留显式 unavailable，不引入第二消息真相。运行时边界已有 [`process-stream-boundary.test.ts`](../../apps/scheduler/src/process-stream-boundary.test.ts) 覆盖。 |
| D-02 | 中 | 镜像对账已经从 Worker registry 枚举远端节点，但远端 inspect/repair 平面尚未实现；当前只支持本地执行检查或定向修复，远端明确 `unsupported`。详见 [`DESIGN.md`](../../DESIGN.md) 的运行时镜像恢复段和 [`runtime-image-pull-partial-failure.md`](../runbooks/runtime-image-pull-partial-failure.md)。 | 远端节点可能需要人工确认或单独运维，不能由 Scheduler 本地状态推断全节点已就绪。 | 关联 #724；实现远端平面前不得去掉 `unsupported`、节点枚举或证据要求，也不得把缺失结果当作成功。 |
| D-03 | 中 | Control API 已有版本化 RepairFeedback 和稳定错误路径，但 Hub、Verify、Completion Gate 与完整 Proposal/Receipt/Settlement 尚未统一；当前内核仍以 Job/Attempt/effect 账本作为效果边界。 | 跨域修复检查点和 durable receipt 语义仍需分别核对，模型修复成功率与副作用账本暂未形成一套统一回放。 | 只在现有 event-ingestion 和 effect 账本上增量收敛；未知外部效果继续停止自动重放。不得以新增内存状态替代数据库事实。 |
| D-04 | 中 | Capability Pack 的 manifest、Job 级发现、selector/digest 快照和平台准入已落地，但 task/session 生命周期、评估晋升、临时组合和跨任务经验推荐仍未实现。 | 后续若直接把目录推荐写进角色配置，可能绕过 Job 快照和权限边界，造成能力漂移。 | 关联长期 AI-native 路线；新能力先按当前 Pack/Job scope 落地，未实现的生命周期不写入 as-built，不为未来推荐预留运行时旁路。 |
| D-05 | 低 | Artifact-first Phase 1 已把 Fact/Finding 提案转换为 Artifact，并将 Finding/SARIF/报告作为投影；Claim/Evidence/Evaluation/Projection 的长期扩展和旧投影路径清理仍未完成。 | 投影种类增加时需要维持 Artifact、Fact、Finding 和报告的版本/来源一致，重复事实源会增加审计成本。 | 继续以 Artifact 为内部写入真相；Verify 只消费结构化 Fact、Artifact、Evidence 和独立 Evaluation。任何新字段先进入现有 schema/共享契约和投影测试。 |
| D-06 | 低 | 质量指标和 Hub replay 已有只读投影；Experience 经验存储为空，尚未有跨任务经验召回、成本感知计划和策略评估闭环。 | 不能把质量投影或人工标签解读为模型准确率承诺，也不能自动把历史结果当作当前事实。 | 关联长期评估路线；没有冻结数据集、来源、版本和过期策略前，不新增经验写入或推荐路径。 |
| D-07 | 中 | [`runtime-image-registry-contract.ts`](../../apps/scheduler/src/runtime-image-registry-contract.ts) 仍保留 schema v1 的兼容解析、旧 `image_ref` 投影和历史重复 digest alias；当前新目录契约以最新形态为准。 | 旧输入/输出路径继续存在会增加发布审计和移除成本，也可能让历史投影被误认为受支持的新契约。 | 仅在历史材料、迁移证据和发布窗口确认不再依赖后物理清扫；新生成内容不得依赖兼容投影，兼容解析不能扩大新运行时输入范围。 |

## 3. 有意暂缓的设计

### 3.1 全图服务端权威布局（#148）

Web 当前对可见投影使用 elkjs，服务端节点坐标只作 placement/exchange hint，节点不可由 Agent 提案，超阈值或 ELK 失败有固定列和本地路由。全图 `layout_revision` 的服务端权威重算按 #148 暂缓，代码事实见 [`layout.ts`](../../apps/web/src/layout.ts) 和 [`TODO_CANVAS_PROCESS_TRUTH.md`](../TODO_CANVAS_PROCESS_TRUTH.md)。

在 #148 重新定案前，不得把 `canvas_nodes.x/y` 宣称为全图权威坐标，不得因可视化需求改写 Job、Fact、Finding 或事件状态，也不得让 Agent 获得坐标写权限。解除暂缓需要定义布局输入版本、并发更新、失败回退、导出一致性和跨副本观察语义，并补充行为测试。

### 3.2 平台自动更新的后续阶段（#740）

P1 第 1–3 片已落地：全局暂停领取/恢复已持久化并接线，官方清单的 `platform` 版本发现已写入检查结果并由 Web 管理端提示；实现见 [`platform-claims`](../../apps/scheduler/src/domains/platform-claims) 和 [`platform-updates`](../../apps/scheduler/src/domains/platform-updates)。Compose 已改为每个平台镜像一个不可变 digest 引用并要求显式 `DEEPSONAR_VERSION`（`DEEPSONAR_IMAGE_TAG` 已删除，部署脚本 fail closed）。Release 已生成并 inspect 核对 `platform` digests；宿主 `upgrade check/apply/rollback` 已支持单控制面、同 schema 的稳定版本升级，回滚保持暂停且保留数据库。仍未落地的是跨 schema 自动重建、完整配置兼容性 preflight、多节点顺序/版本保护、自动中断续做、签名和无人值守补丁升级。恢复领取结果不明需人工对账，不能宣称完整 #740 已完成。此项不影响现有 Job/Attempt 副作用边界，也不能通过“自动更新”名义跳过镜像准入和发布证据。事实来源：[`DESIGN.md`](../../DESIGN.md) 的平台自动更新段。

### 3.3 可冻结的安全漏洞证明契约

通用 Fact-first v1 已是当前 Verify 主路径；`security.vulnerability.proof` 的更严格静态/动态证明契约是可选设计，默认不启用。缺少工具、目标或设备时，运行结果应为 `inconclusive` 或进入人工路径；文本描述、危险函数命中或单纯行号不能被写成运行证明。只有安全 profile 的明确需求和对应的 Artifact/Evidence 规范稳定后，才能推进强制门禁。

### 3.4 任务级 / 会话级能力生命周期

当前目录发现和 Skill 拉取受 Job token、快照、预算、网络和审计约束；任务级或会话级 Pack 持久化、评估晋升和跨任务推荐仍属于长期阶段。暂缓期间，Skill 只能影响当前任务的方法，不能改变 Job 快照、项目范围、镜像、凭据或平台工具权限。

## 4. 已收口边界（不作为待办）

下列结论已有代码和测试支撑，本节用于防止历史计划或旧 issue 把已完成能力重新写成债务：

| 边界 | 当前收口事实 | 主要核验入口 |
| --- | --- | --- |
| 不向后兼容 | 新契约不为旧输入保留兼容窗口；schema/快照不匹配 fail closed，历史快照和证据仅作不可变历史；现存格式兼容解析作为 D-07 登记，不是新契约。 | [`ADR 0001`](adr/0001-no-backward-compatibility.md)、[`migration-runner.ts`](../../apps/scheduler/src/migration-runner.ts)、Job snapshot tests |
| 单一 schema 基线 | `schema.sql` 与 [`schema-version.ts`](../../apps/scheduler/src/schema-version.ts) 的导出值必须一致；空库套用，非空版本/结构漂移拒绝启动，无增量升级链。 | [`ADR 0002`](adr/0002-schema-baseline.md)、[`migration-runner.test.ts`](../../apps/scheduler/src/migration-runner.test.ts) |
| API-only 控制 | Job-scoped Control API、短期 capability token、严格输入和幂等语义是唯一语义写入通道；受治理普通 MCP 仍可作为业务工具，但不能绕过该写入通道。 | [`ADR 0003`](adr/0003-api-only-control.md)、[`platform-api/routes.ts`](../../apps/scheduler/src/domains/platform-api/routes.ts)、[`platform-api.test.ts`](../../apps/scheduler/src/domains/platform-api/platform-api.test.ts) |
| Fact/Finding 分责 | Fact 的 `verification_status`、Finding 的 `verify_status` 和人的 `disposition` 独立；Verify 只消费结构化证据。 | [`ADR 0004`](adr/0004-fact-and-finding-verification.md)、[`database/schema.sql`](../../database/schema.sql)、[`verify-fact-first.test.ts`](../../apps/scheduler/src/verify-fact-first.test.ts) |
| 三流职责 | `events` 是语义账本，Evidence 文件是过程证据，stream-bus 是非权威实时缓存；补读走 Evidence，过程流可见性显式报告。 | [`ADR 0005`](adr/0005-event-evidence-stream.md)、[`process-stream-policy.ts`](../../apps/scheduler/src/process-stream-policy.ts) |
| 镜像准入 | 镜像目录、版本 trust 状态、扫描/批准、平台/CLI readiness 和不可变 digest 在 Job 创建时重新校验并冻结。 | [`ADR 0006`](adr/0006-runtime-image-admission.md)、[`runtime-image-registry-contract.ts`](../../apps/scheduler/src/runtime-image-registry-contract.ts)、[`runtime-images.test.ts`](../../apps/scheduler/src/runtime-images.test.ts) |

这些边界仍可能有后续增强，但增强不等于改变现行事实；任何改变都必须回到架构视图、追溯矩阵和 ADR 评审。

## 5. 风险处置与验收

风险条目关闭或降级前，必须能指出：

1. 触发条件和受影响的 Job/Attempt/项目范围；
2. 内核如何 fail closed、显式标记不可用或进入人工路径；
3. 结构化 Evidence、审计和可重放/不可重放依据；
4. 合法、非法、重复、冲突、超时、取消、重启和跨项目测试入口；
5. 相关文档、需求追溯和 ADR 是否同步，历史事实日期是否实际核实。

只修改措辞或链接不会自动关闭风险；没有新代码或新证据时不机械更新同步日期。对外部 registry、OpenSandbox、真实设备或多副本卷的验收，必须单独标注未执行、环境不可用或仅完成夹具测试。

## 6. 维护入口

风险登记与专题事实的交叉索引在 [`docs/README.md`](../README.md) 和 [`DESIGN.md`](../../DESIGN.md)；架构文档变更按照 [`11-engineering-specs.md`](11-engineering-specs.md) 和 [`architecture-doc-sync`](../../.agents/skills/architecture-doc-sync/SKILL.md) 的完整变更面处理。新增风险应优先引用代码/测试入口，避免只引用旧计划或未核实的历史结论。
