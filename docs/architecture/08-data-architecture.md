# 08 数据架构与真相流

> 状态：**as-built**（#741）。说明 schema 基线、核心实体、三类真相流和状态机；列定义以 `database/schema.sql` 与代码为准。
> 同步日期：2026-10-30

mark_job_done 修正回执复用 events 的宿主 control_receipt 语义事件、Job 锁、Attempt 关联与原 key/digest；不新建平行效果账本或修改 schema。回执与最终 done 分别派生 Job/key 范围内的不同事件身份，持久接受不代表结算，详见 [#776 B](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

## Schema 基线纪律

[`database/schema.sql`](../../database/schema.sql) 是唯一基线；[`schema-version.ts`](../../apps/scheduler/src/schema-version.ts) 必须与基线的版本字面量同步，当前集成版本以该常量与基线一致性为准，不代表已发布版本。空库启动直接套用基线；非空库的版本或结构不匹配时 fail closed。改表必须先改基线、同步版本、执行 rebuild plan/apply 并验证备份和列交集回填，不能建立未经审计的增量 ALTER 链。稳定状态、外键、幂等键和权限骨架使用定列；开放内容使用 JSONB；状态字段保持可演进字符串而非被数据库 enum 锁死。


## 核心实体和关系

| 实体/表组 | 作用 | 关键关系或约束 |
| --- | --- | --- |
| `projects`、`canvases` | 项目 scope 和任务过程容器 | Canvas 隶属项目；用户、API token、Job 和导入导出均按项目授权 |
| `canvas_nodes`、`canvas_edges`、`canvas_changes` | Intent、Fact、Artifact、Finding、Job 等过程图和 revision | 节点/边由拥有域写入；变更日志有可见 floor；Agent 不能提交坐标或任意终态 |
| `jobs`、`job_attempts` | 逻辑任务和一次执行尝试 | Job 有冻结 `agent_snapshot_json`；一个 Job 同时最多一个 active Attempt |
| `job_attempt_effects` | provision、agent run、清理等外部效果意图和 settlement | `effect_pending`/`unknown` 保护崩溃恢复；effect id 幂等；未知不得自动重放 |
| `job_tokens`、`job_capability_tokens` | Gateway 凭据与 Job-scoped Control 能力 | 存 hash/prefix 或受限加密投影；终态 Job 撤销 token |
| `events`、`event_dedup`、`job_event_rate_limits` | 语义事件、Job 序列和 durable 限流 | event id、Job sequence 和事件 dedup 约束重复；原始运行流不进入 events |
| `artifacts`、`artifact_claims`、`artifact_evidence`、`artifact_relations` | 版本化内部写入真相 | claim/evidence polarity 和 relation 类型结构化保存，旧版本可追溯 |
| `findings`、`finding_verification_rounds` | Finding 处置和 Verify 门 | `verify_status` 与人的 `disposition` 分离；round 保存 eligibility/evidence/rework 状态 |
| `finding_research_runs` 及 cluster/anchor/priority 表 | Research 语义结果与运行审计 | batch 有界、输入幂等；失败不回滚主 Finding/Report |
| `task_reports`、`finding_reports` | 冻结输入后的版本化 Projection | 一条 scope 只有一个 active 版本；输入/输出 hash 使变化追加版本 |
| `shared_assets*` | 内容寻址共享资产和 Job 版本绑定 | scope、配额、版本和 Blob hash 分离；不把文件内容直接当语义事件 |
| `project_knowledge_*` | 项目 Memory/Skill、不可变版本、work/assignment、proposal/evaluation/receipt、精确 grant 与 usage | 草稿/候选不进普通目录；复合项目/Job/Attempt 外键校验 provenance；版本正文留在 CAS，历史版本含 revoked 保留，不自动 GC |
| `credentials`、`api_tokens`、`audit_logs` | 凭据、管理身份和 append-only 审计 | 密文/nonce/tag 与安全 projection 分离；审计触发器防止更新/删除 |
| `runtime_images*`、`devices*` | 镜像信任目录和设备租约/事件 | 信任状态、摘要、租约和设备状态由对应域持有 |
| `platform_update_checks` | 平台 catalog 与当前部署版本的最近一次只读比较结果 | 单例行；由 `platform-updates` 写入，管理员读取；不触发升级或 Compose 变更 |

### 任务契约快照（#767）

`canvases.target_json.task_contract` 保存规范化后的版本化契约，包含 schema 与模板版本；`content` 保留原始用户需求。Job 的 `agent_snapshot_json.task_contract` 冻结该契约用于执行提示；未提交契约的 Job 不增加此字段。模板升级不会重写既有契约。沿用现有 JSONB，不新增数据库表/列或第二份任务真相。派发时读取当前权限只用于撤销/收窄检查，不改变历史 Job 冻结运行快照。

## 运行身份与可选白名单（#757）

全局 `role_configs.agent_cli=NULL` 是未指定偏好的显式存储语义；种子不再写入 `claude-code`。用户保存的非空值是跨 CLI 候选的偏好，不能排除唯一有效凭据。项目 RoleConfig 不持有 `agent_cli` / `model`，管理写入拒绝这两项，读取不暴露，遗留值清空。已有 Job 的 `agent_snapshot_json` 仍是冻结历史真相，不参与清理或重新解析。

本地 `db:rebuild` 对版本未知或低于 v60、目标至少 v60 且需复制 `role_configs` 的库检查旧身份；非空 CLI 的种子/用户来源不能由值推断。命中旧身份时 `--apply` 默认拒绝且 `--force` 不绕过；管理员复核后可明确 `--reset-role-identity`，在有成功备份或保留源 staging 的前提下丢弃旧角色 CLI/项目模型。全局模型、其余配置和历史 Job 保留；实际条件见 [schema-rebuild.ts](../../apps/scheduler/src/schema-rebuild.ts)，操作步骤见[数据库升级说明](../../database/README.md#v60-角色身份复核757)。宿主维护升级的目标计划与审批另见下方维护升级边界，不能用本地版本阈值替代其风险检查。

项目 `config_json.enabled_agent_clis` 与 `enabled_credential_ids` 独立表示可选收紧；未配置凭据维度不同于显式空数组。读取设置和 Hub 目录不保存派生候选 ID。删除/停用后，未收紧项目自然使用当前候选；显式名单保留限制并要求管理员修复不可用引用，不自动替换为新账号。执行顺序见[运行时视图](06-runtime-view.md#凭据与-cli-解析757)。

## 三类真相流

```mermaid
flowchart LR
    management[(PostgreSQL 管理真相)] --> canvas[Canvas 过程真相]
    canvas --> job[Job/Attempt 执行编排]
    job --> evidence[(Sandbox/Evidence 执行真相)]
    evidence --> events[结构化 events]
    events --> artifact[Artifact/Finding/Verify]
    artifact --> projection[Research/Report 投影]
    stream[stream-bus/WS] -.非权威投递.-> evidence
```

1. **管理流。** PostgreSQL 保存项目、权限、配置、Job、snapshot、token、设备、镜像目录、状态和审计。Management API 是管理流的入口，Scheduler 负责事务和状态判定。
2. **过程流。** Canvas 表保存 root、Intent、Fact、Artifact、Finding、Job、边、revision、broadcast 和 human message。Fact 的 `verification_status` 表示证据验证状态；Finding 的 `verify_status` 和人的 `disposition` 独立推进。坐标、广播注入和 ACK 都由宿主控制。
3. **执行流。** Sandbox 产生进程、工具、Session、文件和原始运行流；Scheduler 将其写入受保护的 Evidence/Blob，经过严格 schema 的语义事件才进入 `events` 和内部实体。stream-bus 只用于实时投递，断线补读只信任可见 Evidence。

Artifact、Finding、Verify、Research 和 Report 不是同一张“结果表”：Artifact 是内部写入真相，Finding 是去重和处置实体，Verify 消费结构化事实和证据，Research 只生成语义组织结果，Report 是可重建的用户投影。Projection 失败不能改写上游事实。

#752 的知识目录在 Job 创建时冻结版本/hash/授权身份；读取时再检查当前撤销。全局 Skill 源额外冻结 source instance 与 source/project revocation epoch，避免禁用后重新启用扩张旧快照。知识 mutation 的事件 ID 由 Job ID 与幂等键派生，领域结果和持久 receipt 与事件在同一事务；相同输入重放原结果，不同输入冲突。试验 Evidence 必须绑定独立 trial Job/Attempt、asset 版本/hash 与 case×arm，不能把模型文字当事实。数据细节和保留根见[项目知识专题](../PROJECT_KNOWLEDGE.md)。

## 关键状态机

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> claimed
    claimed --> provisioning
    provisioning --> running
    running --> waiting_human
    waiting_human --> pending
    running --> succeeded
    running --> failed
    running --> timeout
    running --> cancelled
    running --> orphan
    failed --> pending
    timeout --> pending
    orphan --> pending
```

Job 的 `succeeded` 和 `cancelled` 是终态；`failed/timeout/orphan → pending` 必须服从 reconcile、retry 和未知效果规则。Attempt 还记录 `preparing`、`effect_pending`、`provisioned`、`agent.ready`、`settling`、`terminal`、`interrupted`、`unknown` 等 phase；`job_attempt_effects` 分 `planned/effect_pending/settled/unknown`，其 replay policy 不能由模型决定。

Verify round 有 pending/running/rework/confirmed/needs_human/failed/refuted/inconclusive，Finding 还独立保存 verify status 和 disposition。Research run 有 pending/running/succeeded/failed；Task/Finding report 有 pending/generating/succeeded/failed，并以输入 hash 区分版本。这些状态由各 bounded context 拥有，跨域事件只能通过拥有者入口推进。


## 维护升级的源库、候选库与回执

维护授权允许暂时拒绝业务写入，但不允许丢弃激活后的合法写入。数据库身份隔离完成后生成不可变备份切点；候选库从经校验的备份恢复，再由目标镜像基线重建，源库始终保留。候选 COMMENT 绑定操作、源库、备份 hash 和 restoring/rebuilding/rebuilt 阶段；不能依据半完成 schema_meta 推断重建成功。只读计划包含源结构及目标 DDL 指纹，明确审批删除字段/表等风险，历史 Job 快照语义不在当前自动验证范围。

同 schema 编号不证明相同 DDL：宿主从已验证的当前不可变镜像取得 baseline SHA，目标 CLI 计算目标 SHA；不一致须拒绝版本别名，不能仅凭版本号跳过。角色身份重置必须是独立显式选择并绑定计划，不由维护许可或 force 自动授权。维护记录和激活证据需与本地 journal 对账；未知激活不能触发旧库恢复。代码入口：[候选库管理](../../deploy/platform-upgrade-candidate.mjs)、[schema 计划](../../apps/scheduler/src/platform-upgrade-schema-plan.ts)、[ADR 0008](adr/0008-maintenance-candidate-upgrade.md)。

## Plan 审计与判据绑定（#775 A）

jobs.payload_json.plan_protocol 按 Canvas/项目冻结到报告输入。规范化 raw Plan SHA 与 criterion_id 标识判据；现有 append-only audit_logs 的 canvas.fact.plan_binding 保存操作员评价、来源内容 SHA、Fact 验证 epoch 与 Job/Attempt/event/Artifact revision/Evidence IDs。该审计与 Fact 信任更新原子提交；expected_binding_id 串行 CAS，重复决定幂等。刷新重新核对实际留存内容与来源状态，失效不能自动恢复；历史报告不回写。未新增 schema 或执行账本；A 投影本身不决定整体完成，B 的 complete 仍受完整判据门约束；见 [来源、限额及范围](../PLAN_GAP_PROJECTION.md)。

## Finding 来源身份（#770 A）

Control `event_id` / Idempotency-Key 保持提交幂等；来源 Finding 使用 `(job_id, fingerprint)` 唯一约束。fingerprint 仍由 profile、规范化 title、location、rule_id 生成，只是 Job 内来源标识，不是跨任务问题身份。Job UUID 不同，即使文本完全相同也建立独立 Finding、Artifact 和画布节点；新 Artifact key 为 `finding:<job UUID>:<fingerprint>`，不共享修订链、不继承其他来源的 Verify/disposition/report。

同 Job 同 fingerprint 的完整规范化提案以 `source_digest` 比较（v1 前缀的 SHA-256，递归排序对象键，数组有序，含 raw 来源）。相同提案重交无新增效果；内容不同明确拒绝并回滚，不能静默丢弃新证据。当前没有 Finding 修订协议，title/location/rule_id/profile 身份字段变化是新提案；同 Job 同身份却环境/版本不同必须冲突，不能伪装同源。Job 行锁与同事务 event_dedup 保证并发重放顺序。hash 不是根因或目标版本证据，资产/版本未知仍未知。

基线重建保留已有 Finding UUID、job_id、状态、证据和 Artifact key。历史行的新增 source_digest 为 NULL；原提交事件重放仍由 event_dedup 拦截，但新提交若命中无法证明内容相同的历史来源则 fail closed，不推导摘要或替换旧 Artifact。导入导出携带已有摘要；无摘要的历史行保持未知。此前项目指纹提前去重的提交不自动补造来源，只有另行证明来源和授权才能评估恢复。数据完整性起点是部署本写入契约后接受的独立来源，不是重建日期之前所有事件。跨任务关系、投影和质量评估不属于此切片。

#776 的修正限额冻结在首个 control_receipt 的 repair_token_limit；Gateway effect intent 保存宿主 repair_receipt_ref/repair_reserved_tokens。实际用量仍只在 job_usage_ledger 一次写入，按 Attempt/effect 联结投影累计，无新增表或 schema 版本变更。未知/缺报与已知零分开；详见 [修正预算](../REPAIR_FEEDBACK_DONE_REPAIR.md#独立修正-token-用量与额度)。

Plan 成功响应复用 events.control_receipt；operation、key、原请求/展开输入/最终语义摘要、snapshot 与 Attempt 绑定。其存在不推进 Plan revision 或单步预算；不新增 schema/执行账本。 详见 [持久化边界](../PLAN_BOUNDED_INTENT_DESIGN.md#持久化与原子性)。

## 成果规则与候选依据（#767）

规范化后的整个任务契约由服务端计算 task_contract_sha256，候选绑定目标/可选基线与逐判据 Fact；赏金源材料 source.sha256 是另外的操作员声明身份，不可混用。Finding raw_json 和 Artifact 保存准入依据，status为 admitted_for_research且submission_eligibility:not_assessed。历史冻结不回写，观察先独立落库。详见[通用标准与研究候选](../TASK_OUTCOME_ADMISSION.md)。

## 目标结果与 Plan 显式关联（#767）

task.result 保存声明与事件派生身份，task.goal_evaluation 保存宿主绑定；原文留 Artifact，报告使用有界引用。可选 plan_binding.goal_review 关联 review_artifact_id、task_contract_sha256、criterion_ids、expected_review_sha256（已接线），不增加表或 authority。执行证明摘要不含仅改变人工验证注释的字段；rejected 与 Plan verified 权限仍分别检查。详见[结果评审](../TASK_RESULT_REVIEW.md)、[Plan 关联](../PLAN_GAP_PROJECTION.md#可选目标评审关联767)及[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

执行证据绑定的 `content_schema_version: 2` 摘要排除 `manual_verification`/`verification_status`，拒绝状态与 Plan verified 授权仍独立校验。旧 v1 摘要可能失效，严格拒绝而不自动转换；历史记录不回写，必要时重新产出结果与评审，不能静默改绑旧 assignment。部署边界见[Plan 来源版本](../PLAN_GAP_PROJECTION.md#可选目标评审关联767)。

## 程序规则附加评审（#767）

程序规则使用冻结 rule_snapshot 的 rule id 派生 program_rule:<ruleid>，复用 task.goal_evaluation；报告 findings[].program_rule_review 保存规则来源摘要、逐项 review_indexes 与状态，不新增数据库表或官方认证身份。详见[评审](../TASK_GOAL_REVIEW.md)与[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## 证据追踪诊断修复

Artifact source_event 对应真实证据来源 Attempt，最新 Attempt 仅用于有效性核验，不能替代来源。manifest 声明 hash 与宿主 observed hash 分开，历史不回写。详见[证据追踪](../EVIDENCE_TRACE.md)。
