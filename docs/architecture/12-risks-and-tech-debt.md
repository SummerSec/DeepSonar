# 12. 风险与技术债

> 状态：**as-built（风险登记，#741 PR 5 回填）**。本文只登记当前实现仍有证据支持的缺口、风险和有意暂缓项；已完成的历史决策不重复列为待办。
> 同步日期：2026-11-08
> **v0.6.3 本轮风险处置（2026-11-01）**：独立质量验证/标注与隔离调参留出、后续质量门、Host 外部证据认证/当前证书、CAS 晋升和公开强关系建议均明确暂缓，不列为本轮 PR、工程 issue 收口或发布阻塞。不是仅待输入，也不在本轮追加这些软件卡点；已实现工程、现有测试和权限/CAS/发布抑制边界不放宽。工程验收仅以最终 SHA 的现有 GitHub Actions 适用检查实际全绿为准，全部测试/构建/typecheck 仅在 Actions 执行；质量仍 `unknown` / `not_evaluated`、强关系 `published=false`。下文历史质量条款按[最新范围决定](<../../AGENTS.md#豁免范围>)解释，不能冒充质量通过。

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
| D-03 | 中 | Control API 已有版本化 RepairFeedback 和稳定错误路径，但 Hub、Verify、Completion Gate 与完整 Proposal/Receipt/Settlement 尚未统一；当前内核仍以 Job/Attempt/effect 账本作为效果边界。 | mark_job_done 的窄范围持久回执与 [#874 完成恢复 v1](../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)区分旧负回执、持久宿主恢复事实及受治理对账/停止提案；本轮修复仍待最终 SHA Actions。显式恢复的新执行代际与 stale Hub 退出见 [#903 生命周期](../AGENT_REPAIR_LIFECYCLE.md)，最终 SHA 工程验收单独记录，不能以零 unknown 推导会话恢复或自动成功。独立 repair-token 累计熔断已有实现，调用前输入成本上界仍未知，单次可超额；跨域统一检查点与完整长期完成协议仍是缺口，模型质量未评测。 | 只在现有 event-ingestion 和 effect 账本上增量收敛；未知外部效果继续停止自动重放。不得以新增内存状态替代数据库事实。 |
| D-04 | 中 | Capability Pack 的 manifest、Job 级发现、selector/digest 快照和平台准入已落地，但 task/session 生命周期、评估晋升、临时组合和跨任务经验推荐仍未实现。 | 后续若直接把目录推荐写进角色配置，可能绕过 Job 快照和权限边界，造成能力漂移。 | 关联长期 AI-native 路线；新能力先按当前 Pack/Job scope 落地，未实现的生命周期不写入 as-built，不为未来推荐预留运行时旁路。 |
| D-05 | 低 | Artifact-first Phase 1 已把 Fact/Finding 提案转换为 Artifact，并将 Finding/SARIF/报告作为投影；Claim/Evidence/Evaluation/Projection 的长期扩展和旧投影路径清理仍未完成。 | 投影种类增加时需要维持 Artifact、Fact、Finding 和报告的版本/来源一致，重复事实源会增加审计成本。 | 继续以 Artifact 为内部写入真相；Verify 只消费结构化 Fact、Artifact、Evidence 和独立 Evaluation。任何新字段先进入现有 schema/共享契约和投影测试。 |
| D-06 | 低 | 质量指标和 Hub replay 已有只读投影；Experience 经验存储为空，尚未有跨任务经验召回、成本感知计划和策略评估闭环。 | 不能把质量投影或人工标签解读为模型准确率承诺，也不能自动把历史结果当作当前事实。 | 关联长期评估路线；没有冻结数据集、来源、版本和过期策略前，不新增经验写入或推荐路径。 |
| D-07 | 中 | [`runtime-image-registry-contract.ts`](../../apps/scheduler/src/runtime-image-registry-contract.ts) 仍保留 schema v1 的兼容解析、旧 `image_ref` 投影和历史重复 digest alias；当前新目录契约以最新形态为准。 | 旧输入/输出路径继续存在会增加发布审计和移除成本，也可能让历史投影被误认为受支持的新契约。 | 仅在历史材料、迁移证据和发布窗口确认不再依赖后物理清扫；新生成内容不得依赖兼容投影，兼容解析不能扩大新运行时输入范围。 |
| D-08 | 高 | OM 的 registry/freeze、Gateway workload/ledger、wrapper 与 RPC/历史 Session 脱敏已落地，默认显式 opt-in。实际本地 base 镜像的 canonical RPC、独立生产内容 guard 正负例及 OM 专属版本准入/适配器回归已通过；内核已知请求前 transport、持久零用量结算和 provider 防冒充亦已通过，集中见 [RPC](../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)与 [Gateway](../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。剩余为当前 PR/最终 main 组合 CI、发布通道/平台及 registry/catalog 证据；质量与成本收益仍为 `unknown`。 | 本地 base 验收不能证明最终源码组合、其他镜像/平台或已发布 digest；未经独立评估不能宣称记忆质量、价格/成本收益、容量或 SLA 改善。memory 仍不能成为 Fact/Evidence authority。 | 保持版本/内容两道独立准入、冻结 route/model、内核 workload、显式有限分配、pending/unknown 与终态撤销、私有配置和多出口脱敏。按[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)完成最终 CI，发布证据另行核对；质量/成本结论等待独立测量，不把源码接线、host 结果或本地 image ID 写成完整发布验收。 |
| D-09 | 中 | 2026-11-05 本机 Pi 任务的完成修正提案已获 `persisted_deferred` 接纳，随后 Gateway 拒绝续发模型请求，运行器以最终失败收口，缓冲的 Hub decision 未落地。见 [#913](https://github.com/SummerSec/DeepSonar/issues/913)、[`executor-real.ts`](../../apps/scheduler/src/executor-real.ts) 与 [`repair-token-budget.ts`](../../apps/scheduler/src/domains/event-ingestion/repair-token-budget.ts)。 | 对应 Hub 任务无法创建 Worker；启动成功或重新入队不能证明恢复闭环通过。 | #919 已修复宿主接受完成后的结构化 Gateway 拒绝处理，#930 已合入显式修复代际；工程验收基线见[发布记录](../RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)。剩余边界是未知效果对账、当前 Attempt/合法退出及最终完成门，不能由入队或 accepted-terminal 窄修复推定所有恢复场景成功；不得跳过权限、预算、取消、租约或未知效果边界。 |
| D-10 | 高 | #1002 P2-11 的[受管 Docker init](../OPENSANDBOX_1_2_UPGRADE.md#managed-docker-resource-preflight-1002-p2-11)拒绝 Engine 声明 unsupported/unknown，但当前快照/资源参数不认证逐容器控制器是否实际执行；复用 init、服务重启、`--no-deps`、外部 OpenSandbox 与 Kubernetes 不由此持续守卫。 | rootless/cgroup 或远端配置变化仍可能使声明的限额不强制；CI 的 Engine 声明读取不能冒充生产多租户隔离。 | 保留 ceiling、capDropAll/noNewPrivileges、失败关闭和未知效果边界；后续须由实际执行端证明有效控制器/逐容器限制，不能由 Scheduler 本机 inspect、Agent 自报或提高额度替代。此片最终 SHA Actions 尚待验。 |

### Skill 源修复与剩余证据边界（#960）

自动同步隐式发布、缺损 CAS 被当作 unchanged、从未成功却按 created_at 报新鲜，以及既有 Job/Intent 节点跳过 warning 的核心修复已落入当前源码；候选显式 hash+epoch 发布、同源跨实例 session 锁、短事务身份/取消 fence、事务审计和冻结观测隔离已编写回归，不能继续列作“尚未实现设计”。但本次按授权只做静态检查，所有真实 PG/HTTP/并发、schema68 rebuild/恢复和最终 SHA Actions 尚未运行或取得验收结果；接线不等于通过。

管理员审批证明的是平台对该精确内容的准入决定，不认证上游 Git 作者、内容无恶意或模型使用效果。同 hash 健康证据只对应最近一次成功核验，年龄指标不是实时 CAS 可用性认证；失败另以安全错误分类展示。缺失原 CAS 可以重 clone 同 hash 恢复；损坏缓存被存储后端拒绝覆盖或无法还原原已批准 hash 时必须明确 failed/待审批，不能改旧 Job 指针去读取不同内容。已有 live/历史批准不伪造迁移，历史 Job 冻结与显式撤销 epoch 不得为修复表面健康而修改。运行机制和数据边界见[IR-007](01-system-specification.md#ir-007-git-skill-source)、[候选数据](08-data-architecture.md#skill-源已批准目录与候选960)和[接口](09-interface-specs.md#全局-skill-源候选审批960)。

### Pi 模型预算与恢复证据边界（#958）

当前源码保留发现限制/来源并在创建期冻结，Pi length 改为同 Session 有界反馈及必要 compact；空摘要/start-end 不记为压缩成功，原完成/人工等待/lease/deadline/预算及未知效果守卫不放宽。回归覆盖配置链路、生产 runner RPC、真实锁版本 SDK 与隔离 HTTP/PG，最终 SHA Actions 尚待验，源码接线不证明已通过。

Provider 声明、客户端冻结值与实际 CLI 观测分层，均不能替代真实上游容量试验或证明模型能理解续写反馈。无完整上下文身份/digest 仍记 unknown，不通过补造变换证据清除失败。本轮不要求生产链重跑，亦不宣称容量、成本/质量或 SLA 改善；字段/停止原因与验收入口见[专题](../PI_MODEL_BUDGET_RECOVERY.md)。

### 任务下发校验的证据边界（#767）

共享契约已减少结构化字段与场景要求的入口漂移，但字段齐全不证明描述真实、目标可执行或模型结果一致。当前仅有 Scheduler-owned 的 `reference-http/v1` 目标授权适配器，并不是通用目标账号/租户/角色/资源归属与外部业务写权限探测器；也不从凭据公开元数据推断目标授权。authority、action、prerequisite、scope、revision、freshness 和 binding 任一未知或不一致时 fail closed，客户端 `verified`、模板默认权限和旧 grant 不能绕过。模板预算是规划信息，不替代既有内核资源预算；任意自然语言的语义归一化、自动安全拆分和真实模型质量提升仍需单独评测。

## 2.1 ASC 迁移验收证据（#754）

源码审查确认：rust_ASC 固定提交 `236dd096669c99eb30f6e1af0b24e668eff55dd5` 的 [LICENSE](https://github.com/MG1937/rust_ASC/blob/236dd096669c99eb30f6e1af0b24e668eff55dd5/LICENSE) 与 [Cargo.toml](https://github.com/MG1937/rust_ASC/blob/236dd096669c99eb30f6e1af0b24e668eff55dd5/Cargo.toml) 明确声明 Apache-2.0。[.gitmodules](https://github.com/MG1937/rust_ASC/blob/236dd096669c99eb30f6e1af0b24e668eff55dd5/.gitmodules) 指向的 [radguard 固定源码树](https://github.com/MG1937/radguard/tree/290de20c925c4a2c7642b1a63c9997185a06e130) 没有独立许可证声明，其 [Cargo.toml](https://github.com/MG1937/radguard/blob/290de20c925c4a2c7642b1a63c9997185a06e130/Cargo.toml) 亦无 `license` 字段。子模块许可覆盖尚未明确、未核实；这不足以断言确定禁止分发，也不作为 PR #755 的硬阻塞，同时不宣称已取得明确覆盖 radguard 的授权。

Mobile 最终镜像已在提交 `a46138f497df8394805c3774281a4eaa8d228712` 的 [CI 39395573082](https://github.com/SummerSec/DeepSonar/actions/runs/39395573082) 完成 amd64/arm64 构建与 fixture 验收，每个平台各 59 次真实命令均通过；Manifest、类/引用查询、模糊匹配、文件输出、多 DEX、无结果、非法类名和损坏文件的覆盖见 [验证记录](../../agent-harness/fixtures/asc/validation.md)。arm64 运行使用 QEMU，原生 arm64 与性能尚未验证，fixture 通过不证明一般 APK 兼容或性能提升。`droidasc-python` 显式选择是固定契约，Rust 真实错误不得自动掩盖；详见 [工具链契约](../RUNTIME_TEST_TOOLCHAINS.md)。

## 3. 有意暂缓的设计

### 3.1 全图服务端权威布局（#148）

Web 当前对可见投影使用 elkjs，服务端节点坐标只作 placement/exchange hint，节点不可由 Agent 提案，超阈值或 ELK 失败有固定列和本地路由。全图 `layout_revision` 的服务端权威重算按 #148 暂缓，代码事实见 [`layout.ts`](../../apps/web/src/layout.ts) 和 [`TODO_CANVAS_PROCESS_TRUTH.md`](../TODO_CANVAS_PROCESS_TRUTH.md)。

在 #148 重新定案前，不得把 `canvas_nodes.x/y` 宣称为全图权威坐标，不得因可视化需求改写 Job、Fact、Finding 或事件状态，也不得让 Agent 获得坐标写权限。解除暂缓需要定义布局输入版本、并发更新、失败回退、导出一致性和跨副本观察语义，并补充行为测试。

### 3.2 平台自动更新的后续阶段（#740）

P1 的暂停领取、版本发现、digest 部署、官方平台 manifest inspect、dotenv 唯一性和终态 Attempt 效果排空已有实现。维护模式已获用户授权；数据库身份隔离、候选库恢复/重建、只读 schema plan、同目标续做状态机和服务 preparing 门禁已有模块。隔离 PostgreSQL 身份测试、候选重建和状态机故障注入已有执行证据，不能再笼统写成全部缺实现。

宿主入口、私有恢复文件和受管 SSH 编排已接线；真实单机/多节点成功路径及旧 worker 身份隔离已通过隔离演练。最终 schema 61 → 62 组合镜像的 16 项 Compose 场景及独立知识后台停写场景已通过并清理。Windows 原生锁、私有 ACL 与持久文件后端的原生 CI 已通过（15 passed、1 项 Linux 专用 skipped），未宣称真实 Windows Docker 部署或断电验收；隔离演练不等于真实部署验收。历史同 schema 演练不能覆盖新维护代码。P2 默认关闭的宿主策略、签名验证和禁用调度模板已接线，正式 tag 的生产 keyless 签名已获授权并接线，实际发布验收见对应 Release 证据；P3 Web 发起为可选且未实现；不得宣称完整 #740 已交付。

离线配置 preflight 已检查声明字段的 URL/枚举语义、主密钥只读文件身份与内容格式、全部已存凭据（含 disabled）的 AES-GCM 认证，并复用 credential-first resolver 检查当前持久默认组合；明确未检凭据及外部服务真实认证、模型可用性、未来 Job provider/model 约束、registry 可拉取性、历史 Job 快照语义、未知环境扩展、原生 Provider 扩展字段和 Skill 源内容。跨 schema 计划需要明确审批删除数据与角色身份重置风险；当前集成 schema 编号不能当成已发布编号或同编号 DDL 等价证明。决策见 [ADR 0008](adr/0008-maintenance-candidate-upgrade.md)，既有演练边界见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)。

### 3.3 可冻结的安全漏洞证明契约

通用 Fact-first v1 已是当前 Verify 主路径；`security.vulnerability.proof` 的更严格静态/动态证明契约是可选设计，默认不启用。缺少工具、目标或设备时，运行结果应为 `inconclusive` 或进入人工路径；文本描述、危险函数命中或单纯行号不能被写成运行证明。只有安全 profile 的明确需求和对应的 Artifact/Evidence 规范稳定后，才能推进强制门禁。

### 3.4 任务级 / 会话级能力生命周期

当前目录发现和 Skill 拉取受 Job token、快照、预算、网络和审计约束；任务级或会话级 Pack 持久化、评估晋升和跨任务推荐仍属于长期阶段。暂缓期间，Skill 只能影响当前任务的方法，不能改变 Job 快照、项目范围、镜像、凭据或平台工具权限。

### 3.5 项目级 Finding 强关系关联（#819）

当前根代码已接入操作员认证的 identity source/mapping manifest、immutable source revision、mapping CAS、freshness/revocation/invalidation 和 durable relation worker；管理面有两条有界读取路由与六条受保护写入路由。写入只接受 `admin` 和 Finding 所属项目范围，服务端计算 digest/provenance，调用方不能自报外部 inventory authority；历史保留，最新 source/mapping 失效时读取端立即阻断，不回退旧版本。

交付边界仍然明确：强关系 `published=false`，`quality_gate_status=not_evaluated`，公共 relation items 为空；这套 operator attestation 不证明外部 inventory authenticity，也没有独立人工标注集、按问题家族/资产隔离的调参/留出集或预冻结阈值。`compareFindingFeatures` 的相似/弱候选不能被重新表述为同问题结论，不得传播 Verify/处置状态；质量与收益继续记为 `unknown`。生产执行豁免不覆盖这些非模型质量验收缺口。

The agreed schema67 engineering slice merged via #831 and accepted at fdb55a01 in Actions implements protocol commitments/freeze, pre-body exposure and append-only receipt/CAS state, bounded real-SQL observations, report reconstruction and structural review/revoke. #819 closed only within that scope; this accepted engineering is not an outstanding task or complete quality delivery. Remaining software is host admission/verification of external independent facts, natural-human alias/conflict resolution, current-certificate issuance and audited CAS promotion/expiry/revocation/source invalidation, plus guarded nonempty public SQL/schema/read publication. SQL now binds published rows to passed/non-null certificate tuples; it does not issue or verify certificates. Code/public responses still suppress relations. [Remaining software and genuine inputs](<../PROJECT_FINDING_EVALUATION.md#最小外部输入与剩余工作>) cannot be replaced by supplying synthetic declarations, digest-shaped records, account IDs or flipping constants.

Node/runtime-loader/preload trust and signed immutable deployment remain independent TCB/evidence boundaries; load-returned source hashing is not self-certification or proof that evaluation succeeded. Independent historical provenance, labels/adjudication, verified family/asset partitions and threshold adoption before prior/alias holdout access remain externally unverified. Schema67 SQL/HTTP/worker and rebuild/restore engineering passed at fdb55a01 in Actions; [acceptance evidence](<../PROJECT_FINDING_EVALUATION.md#819-sql-quality-engineering-2026-11-01-merged-engineering-slice>) is separate from subsequent #838 repair/final-main checks. Historical schema66 successes are not relabeled as schema67 acceptance. Production/model execution is waived, these independent non-model quality inputs are not.

## 4. 已收口边界（不作为待办）

下列结论已有代码和测试支撑，本节用于防止历史计划或旧 issue 把已完成能力重新写成债务：

| 边界 | 当前收口事实 | 主要核验入口 |
| --- | --- | --- |
| 不向后兼容 | 新契约不为旧输入保留兼容窗口；schema/快照不匹配 fail closed，历史快照和证据仅作不可变历史；现存格式兼容解析作为 D-07 登记，不是新契约。 | [`ADR 0001`](adr/0001-no-backward-compatibility.md)、[`migration-runner.ts`](../../apps/scheduler/src/migration-runner.ts)、Job snapshot tests |
| 单一 schema 基线 | `schema.sql` 与 [`schema-version.ts`](../../apps/scheduler/src/schema-version.ts) 的导出值必须一致；空库套用，非空版本/结构漂移拒绝启动，无增量升级链。2026-10-31 full rebuild 已用固定历史 v62/v63/v64 数据执行 pg_dump/pg_restore，并恢复七张新 relation 表；主线程证据为 19 pass/0 skip，无 pending。 | [`ADR 0002`](adr/0002-schema-baseline.md)、[`migration-runner.test.ts`](../../apps/scheduler/src/migration-runner.test.ts)、[`database/schema.sql`](../../database/schema.sql)；full rebuild 结果见[顶层索引](../README.md) |
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

## #775：Plan v2 路线与接纳恢复不代表执行结算

当前 Plan 执行接口只接收 v2，v1 只读历史是规范边界。2026-10-31 已物理删除 `applyHubPlanAdapter`、`persistPlanAudit`、side-effect writer 及纯 legacy `adapt*` helpers/types/exports；普通 HubIntent 仍走原 handler，不制造新的 v1 `plan_protocol` 或 audit，immutable v1（含 `hub_intent_adapter`）仅供历史读取。v2 objective/route CAS 与有限 lifetime 复用既有 Intent，保留 Attempt、实际 Evidence/provenance 和输出关联；接纳 receipt 不启动第二执行器。工程 `complete/completed` 仅表示路线输出条件，任务语义完成另需全部当前正向操作员判据。2026-10-31 根本地 normal→all7negative→normal 三次 replay 均 exit 0，当前 v2 单一 SQL/HTTP fixture 的 17 个 outcomes/traces 全匹配，七个注入故障均正确触发 gate 失败；`report.json` provenance 为 dirty 的非 HEAD 提交，且结果不是 17 个独立测试；后续本轮工程已随 [#831 在 fdb55a01 主线 Actions 验收](<../TASK_DISPATCH_ACCEPTANCE.md#831-engineering-acceptance-2026-11-01>)，不追溯改变该历史回放，后续修复 SHA 另验。未知或 `replay_policy=never` 的效果不自动重放。真实模型/生产执行不要求，质量/成本收益 unknown；独立质量按本轮范围暂缓而非通过。见 [ADR 0012](adr/0012-plan-v2-execution.md) 与 [Plan 专题](../PLAN_GAP_PROJECTION.md)。

## 可信目标授权与成果资格边界（#767 / #822）

Scheduler-owned 的只读 target-authorization protocol 已接线：authority/action/prerequisite/scope/revision/freshness/binding 由可信适配器返回，secret 只来自 host/platform 配置；中心继承与 dispatch/rerun live checks 重新核验，客户端字段、模板和公开凭据 metadata 不能证明外部写授权。最新 grant 无效不得回退旧 grant，`target_authorization_grant_invalid` 进入不可重试的 fail-closed 路径。目标写入本身不属于该协议。

程序材料/资格的操作员准入、append-only history、当前 Finding/Verify/Evidence 绑定投影已接线，但不认证外部官方来源，不授予执行权限；Agent/internal actor、viewer 和 Finding maker 不能批准，写入权限由认证 actor 和项目范围决定。剩余缺口仍是高标准提交所需攻击链、knownness 版本适用性、独立质量数据和预冻结阈值；可选 Plan 关联不能替代 operator attestation、verified Fact 或完整完成门。验收证据与决策分列见[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。真实模型验收已豁免，效果未验证不等于缺口已解决。

执行证据摘要升级为 content_schema_version:2 有失效影响：旧 v1 结果/评审绑定可能不再通过当前校验。#797/#798 已随本批合入，部署前仍须核对保存证据的版本；禁止自动重写旧摘要或改绑 assignment。重新产出 task_result/独立评审不授予新 authority；历史保留，rejected 与 Plan verified 门不变。

## 程序规则附加评审（#767）

本片已接 supplied bounty Finding 的独立程序规则评审，不再将规则自声明筛选视为全部能力；rules_satisfied 仍非官方规则认证、当前授权或资格闭环。适用攻击链、可复现证据、knownness 与资格 authority 映射继续保留为后续缺口。详见[评审](../TASK_GOAL_REVIEW.md)与[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## 证据追踪诊断修复

证据追踪此前混淆 manifest 声明摘要与 observed、路径后缀与精确 URI、最新 Attempt 与来源 Attempt；本片已修正只读完整性诊断并完成行为验收。仍无宿主命令 receipt 或真正独立复现/攻击链；knownness helper 未运行时接入，不可视为 novel authority。详见[证据追踪](../EVIDENCE_TRACE.md)。

#775 的 Plan v2 目标修订、依赖图调度、lifetime 路线、实际输出来源与既有 Intent 路径已接线；v1 writer 已于 2026-10-31 物理删除，immutable v1 与 `hub_intent_adapter` 仅保留历史读取。历史一次补证投影只说明历史范围；根本地 v2 replay 的 normal→all7negative→normal 三次退出 0、17 个 outcomes/traces 和七故障负例门禁已核验，但 `report.json` provenance 是 dirty 的非 HEAD 提交，不能代表后续 #831 的工程验收证据；本轮工程已按上述 Actions 摘要验收，后续修复 SHA 和正式发布另计。不要求生产或真实模型试验，独立质量按本轮范围暂缓而非通过。


## 透明 Gateway 的编码回显边界（#923）

绑定凭据的响应 header/trailer 与跨 chunk 原始 body 明文回显已有阻断；gzip/deflate/br 旁路解码检查已接入同一阻断，未知编码和超限明确拒绝；任意业务自定义编码/变换后的 key echo 尚无完整检测保证。不得把现有明文扫描宣称为真实 key 任意表示均不会回流。协议范围和待验合成场景见[透明传输契约](../MODEL_GATEWAY_TRANSPARENCY.md)；最终 SHA Actions 以及压缩回显负例需单独留证，本轮未做生产或真实模型验证。

### #923 原生 CLI 生成前预算兼容

Pi 1.4.0 已接公开 provider streamSimple 入口，Claude Code 2.1.312 只支持本次 launch/resume 的原生输出上限；DSH 0.2.1-rc.2 的 agent/request 不覆盖 compaction，也不暴露请求局部 model.maxTokens。DSH 现已通过锁版本/摘要的独立 vendor adapter 在共用 SDK 调用前接入，待 Actions 验收；用户已接受 Claude Code 2.1.312 保留 start/resume 原生启动输出上限、运行中余额不足时明确拒绝并提示的兼容限制，不要求逐请求自动适配；该范围决定不再是发布阻塞。需要自动适配时，必须使用请求形成前的受支持 SDK/CLI 入口或明确维护完整 adapter；不得用 HTTP body 改写或放宽预算消除缺口。具体版本、入口与静态证据见[透明传输专题](../MODEL_GATEWAY_TRANSPARENCY.md)。新合成回归不等于真实 CLI 运行通过，最终 SHA Actions 待验。
