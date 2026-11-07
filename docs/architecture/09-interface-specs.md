# 09 接口与协议边界

> 状态：**as-built**（#741）。说明 Management、Control、Gateway、流和导入接口的认证、幂等、错误和修复反馈边界；字段细节以 OpenAPI 与 shared schema 为准。
> 同步日期：2026-11-07

完整 HTTP 路由和字段只在 [`openapi.ts`](../../apps/scheduler/src/openapi.ts) 及其 shared Zod schema 中维护；路由面和 OpenAPI 一致性由 [`route-surface.test.ts`](../../apps/scheduler/src/route-surface.test.ts) 与 [`openapi.test.ts`](../../apps/scheduler/src/openapi.test.ts) 覆盖。本文解释协议语义，不复制全部请求字段。

## 任务下发契约（#767）

`POST /projects/{id}/tasks` 可选提交 `task_contract`；类型/版本错误按既有校验错误处理。共享 [TaskContract schema](../../packages/shared-types/src/task-contract.ts) 是字段与模板的唯一机器来源。201 成功返回 `task_contract_warnings`；已提供契约的 objective/targets/scope/evidence/acceptance 基本完整性或必要条件阻塞返回 `409 task_contract_blocked`、`task_contract_blockers` 和 warnings，且不创建 Canvas/Job。每项有 `code/path/message/suggestion`，用于明确补充什么、哪些条件尚不能执行；它们不是完整度分数，也不代表自然语言意图已被理解。未提交契约的自由文本任务继续接受并返回未评估提示，工程场景不强套审计模板。

`workspace_write` 仅表示沙箱工作区变更，不包含外部业务写入或代码推送；后者属于需要目标核验的 `write`。客户端不得把 `allowed_actions`、身份字段或前置条件声明当作授权证明。服务端对可核验的当前项目网络限制、凭据存在/启用/项目范围做复核；真实目标身份、写权限和任意材料的可用性无可信核验结果时保持未知。契约及提示只能使用凭据引用，不能放入密码、cookie、token；schema 不提供秘密字段，但也不能保证自由文本没有秘密。详细管理工作流见[任务下发指南](../../skills/deepsonar-management/references/task-dispatch.md)。

当前 `reference-http/v1` 的身份与动作正向判权由宿主配置的只读 `deepsonar.target-authorization/v1` authority 提供，严格核对 principal/scope/action/prerequisite/content/contract/config/authority revision 和 freshness。任务不能指定 authority URL/secret 或自带 grant；系统审计保存无密钥 grant，子/系统 Job 统一继承，provision/rerun 实时复核。缺失或变化 grant 使用不可重试 `target_authorization_grant_invalid`；其他拒绝/传输错误按授权域稳定错误返回，均不执行目标动作。详见 [ADR 0011](adr/0011-trusted-target-authorization.md)及[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## 退休运行镜像（#964）

运行镜像市场不返回[精确退休 key](../../packages/shared-types/src/runtime-image-retirement.ts)的旧 DB 行；registry API 是原目录完整校验后的当前产品投影，明确携带 `excluded_retired_image_keys`，不能冒充原发布签名原文。退休产品的 manual/import、官方登记/本地采用、启用/批准/复扫和定向拉取请求返回 `410` 与稳定 `error_code: RUNTIME_IMAGE_RETIRED`，直接版本 ID 解析也不能绕过。历史 usage / Job、Evidence 与审计读取保留，不赋予新执行许可。排队 pull/scan 的副作用前拒绝及未执行的运营清理见[下线专题](../DEPRECATIONS.md#软件拒绝边界9642026-11-07-核对)；HTTP/PG 回归接入既有 promotions CI，最终 SHA Actions 待验。

## Management API

Management API 面向用户、Web 和受信任自动化，包含项目/任务、Canvas、Job 控制、Finding/报告、设置、镜像、凭据、设备、Worker、导入导出、平台 claim、只读平台版本发现和审计等入口。管理员只读 `GET /platform/updates` 读取 catalog 同步路径最近一次写入的当前部署与 `platform` 信息比较结果；它不触发新的比较，也不执行升级、apply 或 rollback，项目 token 不能调用。管理 API token 以 hash/prefix 存储，明文只在创建或轮换时返回；token scope 与 path project scope 同时校验。Provider credential 与平台 API token 分离，凭据密文使用 nonce/auth tag 存储，常规 credential projection 不含 ciphertext；现有设置编辑契约允许特定 `settings_config` 字段携带账户配置值，因此该响应仍受管理 scope、审计和脱敏规则约束。Job snapshot 投影不携带长期 secret。

项目 RoleConfig 写入拒绝 `agent_cli` / `model`，读取不暴露这两个字段；全局 CLI 接受 NULL 表示未指定偏好。项目 RoleConfig 导出不含这两项，导入含这两项（即使为 NULL）也拒绝；全局导入未指定 CLI 保持 NULL。项目 Agent 设置分别表达 CLI 和凭据白名单是否显式收紧，`credential_ids_configured` 区分未配置与空名单，设置读取不持久化凭据 ID。readiness 的检查项可携带与 Job 解析同源的 RepairFeedback；悬空/停用白名单要求管理员修复，不能通过 Agent 提交账号 ID 或 OCI 地址绕过（#757）。

### 管理 Skill 的当前契约（#996）

[Management Skill](../../skills/deepsonar-management/SKILL.md)及 Python CLI 跟随现有 credential-first 契约：RoleConfig 不再写账号绑定或 `reasoning`；项目角色由 Hub/Job 在可见目录内选择，不提供角色启用开关。旧 `project-settings update --roles` 在发请求前明确拒绝，项目 CLI/Provider 白名单仍是授权边界，不因删角色开关而放宽。

`role-configs sync-builtin-prompts` 从同 checkout 的 schema 基线读取 Prompt，把全局 GET 投影映射到现有严格 PUT，仅替换指令；空 CLI、DSH 模式、上下文窗口、runtime knobs、工具/能力与配置文件内容保持原值，缺失必要字段时停止而非补默认。相同 Prompt 和 dry-run 不写入；不改项目覆盖、Job 快照或服务端协议。`pnpm ci:unit:management-skill` 用离线 CLI 请求经过真实 `RoleConfigPutBody` 校验非 Prompt 字段往返及删除参数拒绝；运行结果以最终 SHA 的 Actions 为准，不能由端点覆盖或 dry-run 推定。

### 全局 Skill 源候选审批（#960）

平台源是全局供应链控制面，不属于单个项目：源登记、同步、删除、信任/启用操作要求全局管理授权，项目受限主体不能凭项目权限修改所有项目可见的源。`POST /skill-sources/:id/sync` 仅核验并暂存候选，force 只要求重拉内容，不绕过 branch、CAS、取消、身份或审批门；返回的本次 SHA/hash 与 `updated` 不表示已发布。列表/详情分别展示已批准 live 与 nullable candidate 元数据、最近检查及安全错误分类，不能把 B 的核验时间覆盖成 A 的新鲜度。

`POST /skill-sources/:id/trust` 的 trusted 请求必须携带明确的 `candidate_hash`（SHA-256 hex）、字符串 `expected_epoch` 及调用者所见的 `expected_instance_id`，不接受只点 trusted 而隐式采用最新/旧 live 目录。服务按 source 行锁精确核对 hash、epoch、请求期望实例、描述符实例/repo/branch 和 CAS；删除重建同 ID/hash/epoch 也不能消费旧实例的审批。失败保持 live 与 RoleConfig 原样；过期审批应刷新候选再明确决定，不自动批准另一份内容。quarantined/disabled 管理写入同样校验调用者所见实例与 epoch，防止迟到请求修改重建后的新实例。审批 actor 只取认证主体，不取 body。登记按受支持的规范仓库/分支身份复用，不覆盖同名异源。平台包若声明的源 UUID 经登记落到另一目标 UUID，而导入角色仍引用原 UUID，则拒绝整个事务；不改写 selector raw，也不重绑旧 Job。操作者须按目标目录明确重配置该引用。项目 DTO 的 `project_enabled` 表示已保存选择（缺行继承默认），真实准入仍另取平台 trusted+enabled 与有效批准目录交集。批准默认启用（显式 enabled 按本次请求），发布与 selector heal、系统审计在同事务提交，请求审计另保留 HTTP 主体/请求上下文。机器字段、稳定错误映射以[源路由](../../apps/scheduler/src/domains/skill-source/routes.ts)和[审批服务](../../apps/scheduler/src/skill-source-catalog-lifecycle.ts)为准。

全局 enabled 影响所有未显式收紧的项目，不是当前项目开关。项目源绑定只能进一步禁用平台已批准源，不能批准候选或扩大权限。批准 B 后新 Job 冻结 B；已有 Job A 不切换 CAS，不因批准 B 自动撤权。显式 disabled/撤信任则沿原 source/project epoch 撤销旧 Job 读取；重新启用或再次批准也不能恢复旧 epoch Job。disabled 源需先转回 quarantined（仍不启用），同步生成当前 epoch 绑定候选后再审批；同字节 hash 也不能在无效 live 上免审批。

注意力成本：复用既有源管理和信任操作，明确“已批准可下发”与“候选待审批”，让管理者只批准确切版本；同 hash 健康检查不反复要求审批，但缺损、失败和 pending 不伪装为健康。Job/Canvas 的陈旧与待审 warning 是创建期观察，不阻断任务或获得额外权限。验证入口为 `pnpm ci:unit:startup-gate`、`pnpm ci:unit:project-knowledge`、`pnpm ci:integration:platform-api`；本次仅静态核对，最终 SHA 的 HTTP 权限/请求回归与 Actions 结果仍须单独验收。

### 项目凭据引用保护（#914 切片）

`GET /credentials/:id` 的 impact 与 `GET /credentials/:id/impact` 只返回 actor 可见项目的 `project_references`；count 是该作用域完整计数，items 按[引用查询](../../apps/scheduler/src/credential-project-references.ts)有界返回。能读取全局凭据不表示能读取其他项目的名称、UUID 或配置关系。DELETE 的完整性判定另查所有项目：仍有 `enabled_credential_ids` 或 `default_credential_id` 引用时返回 `409 CREDENTIAL_PROJECT_REFERENCE` 和修复指引，但拒绝响应仍只展示可见引用。

设置 PATCH 在项目 `FOR NO KEY UPDATE` 锁内合并配置，按 UUID 顺序取得与 DELETE 共用的凭据行锁，持有至事务提交；该项目锁保护配置写入，同时允许凭据迁移的外键 `KEY SHARE`，避免 Project/Credential 反向等待。DELETE 不靠锁定扫描时已有的引用项目提供互斥。设置写入重验新增及保留的全部引用是否存在、active、属于全局或当前项目，省略模型字段不绕过；失效返回 `400 provider_credential_allowlist_stale`，配置原样保留。模型/回退仍按缺省账号的配置名单重验；清除或收窄掉缺省账号时清除配对模型，显式提交无账号的模型拒绝。缺少白名单键继续不收紧，显式 `[]` 继续禁止所有账号；不自动删键、替换账号或改写历史 Job。此片复用既有设置和删除反馈，**不代表 #914 完整默认账号 UX 已交付**。

不修改凭据的配置入口不能复制旧整对象来回写账号引用：Skill configured 标记与 convergence 快捷规则使用当前 JSONB 的字段级更新，启动清理使用原配置 CAS，导入合并在事务中锁定项目后重新读取当前值。这样不会在账号替换/删除后复活旧引用；这些机制不授予新凭据、不清历史快照，也不把显式空白名单扩大为未收紧。

行为入口是 `pnpm ci:integration:credential-delete`：包括实际 HTTP 两项目负例与 PostgreSQL 双会话 delete-first/write-first 屏障，覆盖仅白名单、仅缺省及同时引用。测试接线不代表最终 SHA Actions 已通过。注意力成本：在删除前显示阻塞与既有修复位置，不增加编辑器、设置或自动修复决策；不以减少打扰扩大授权。

管理认证入口有明确的健康、schema、bootstrap、Worker 注册和 WS ticket 例外；`/gateway` 与 `/control/v1/jobs` 使用独立的 Job-scoped 凭据。认证失败和授权拒绝会审计但不记录 token、Provider 原文或内部堆栈。旧配置不通过转换继续运行，不能用另一个认证面绕过当前契约。

### 项目默认 Provider 账号选择（#914）

项目 Provider 面板通过既有 settings PATCH 显式设置、更换或清除 `default_credential_id`。候选须是 active、全局或当前项目可见、在项目凭据与 CLI 启用范围内的 Provider；未配置凭据白名单表示未收紧，显式 `[]` 没有候选，不自动选择其他账号。现有失效引用清理控件继续保留；默认账号不可用时要求用户明确清除或更换，加载失败不能视作空名单并清掉配置。

默认账号变化时，Web 清除旧模型和备用模型引用；若用户同次为新账号显式选择模型，则同笔提交新 `default_model_ref` 和 `fallback_model_refs: []`，否则提交 `default_model_ref: null`。项目默认模型通过同一 settings PATCH 显式选择或清除，候选只取账号 `settings_config_json` 中已配置的模型，不用探测目录扩大候选；空目录或多候选均不自动选择。普通保存保留未编辑的模型，失效模型保留可见且要求显式修复。保存后以服务端返回为准并刷新，失败保留未保存状态。同项目健康检查返回等价设置时保留编辑草稿（不以数组对象身份判定变更）；真实服务端配置变化加载新值并提示重新确认，取消和项目切换仍重置草稿。账号连接与模型配置链接到既有 Credentials 页面。该 UI 切片不改变后端引用保护、resolver fail-closed、历史快照或 Job 恢复机制，不自动重跑任务，也不代表 #914 全部验收完成；最终 SHA Actions 结果另计。

Job 详情、Job 列表及任务画布的单 Job 重跑错误保留原确认操作，读取 `SNAPSHOT_STALE` 响应的当前解析失败标记和结构化 `repair.code`。`resolution_error` 是人类可读文本，不按文案猜测机器原因：仅 `provider_credential_allowlist_stale` / `provider_credential_multi_match` 导向已知 Job 项目的 `settings?tab=roles` 和凭据配置页；普通快照身份漂移及其他权限、预算、租约拒绝不冒充账号失效。导航不发起重跑；保存配置后仍由用户确认后续执行。确认取消、重复点击、路由/项目切换及卸载用请求身份隔离迟到响应，已经入队但刷新失败与入队被拒绝分别展示。测试接在 `pnpm ci:unit:credential-compatibility`；最终 Actions 结果另记。resolver 的缺失/停用/跨项目引用与空名单拒绝、`rerun-current` 连续拒绝后仅由显式修复和再次执行恢复的回归分别接在 `pnpm ci:unit:capability-pack` 与 `pnpm ci:integration:recovery`；配置保存不改冻结快照，不自动入队。

### 项目默认模型与创建冲突（#966）

项目 CLI/凭据启用范围仅约束候选，不自动确定模型。任务/Hub 显式提案优先于项目配对默认模型，再沿用全局角色模型；不恢复项目 RoleConfig 身份覆盖。入口 Hub 与后续 Worker 共用该解析路径，账号范围、健康、模型名单及镜像准入保持 fail closed。

任务创建 POST 失败在提交区复用现有 `SNAPSHOT_STALE`、`stale_fields` 与 `repair`；快捷创建还读取 `ready=false` 预检中失败 check 的同一 `repair`，不必等到 POST 才显示冲突，且拒绝时不调用创建 API。两者仅从已知模型冲突的 `expected` 中投影请求模型和有界候选，过滤非法标识/URL，不回显原始 `resolution_error`、Provider 文本或堆栈；候选样本不是完整目录。预检 scope 必须匹配当前项目，POST 拒绝绑定发起项目；切换项目清除旧反馈，迟到响应不能给新项目显示旧模型或配置入口。其他解析失败只显示固定配置检查说明，普通身份漂移及权限错误不冒充模型冲突。提示持续保留至下次提交、项目切换或表单关闭，并提供已知项目设置、凭据及全局角色入口；导航不自动执行任务。

| 注意力成本 | 本切片处理 |
| --- | --- |
| 用户需要决定 | 显式选择项目默认账号/模型，或修正全局角色默认；不替用户任选候选 |
| 减少的负担 | 避免把“仅启用 Pi”误当作默认模型已配置，创建失败后可直接看到冲突和修复位置 |
| 新增代价与去重 | 沿用已有 settings 字段和可搜索选择器；提交区只投影可行动诊断，不重复输出完整错误链 |
| 可审查证据 | 配置 PATCH/回显、空目录和多候选、Hub/Worker 优先级、诊断脱敏与两处创建接线；`pnpm ci:unit:web-quick-start` 的真实组件回归覆盖失败预检不创建任务、项目切换和迟到反馈隔离；最终 SHA Actions 待验，未运行本地或生产验证 |

### Finding 项目查询（#770 切片 B）

现有项目交付页使用 `GET /findings` 的有界游标页，页面上限见[研究专题](../PROJECT_FINDING_RESEARCH.md)与机器契约，按创建时间与 UUID 降序；游标保留 PostgreSQL 微秒精度。项目/任务/严重度/profile/类别/验证/处置同维度多选 OR、跨维度 AND；`q` 是标题、位置、摘要、指纹的不区分大小写字面子串，保留中文且转义 SQL 通配符。项目 token 在分页前约束所有项目和任务过滤项；列表与汇总复用同一条件和同项目来源 JOIN。汇总各桶在同一 SQL 快照计算，`total` 表示匹配数，`project_total` 明示项目全量。列表与汇总是独立请求，不承诺跨请求快照一致；状态变化后需刷新首屏。

任务/profile 选项从未筛选的授权汇总取得，不以当前页推断。URL 保存筛选、游标、详情与交付视图；查询失败隐藏旧列表、计数和详情，重试仍保留 URL。记录展示源 `updated_at`，不虚构异步计算状态。证据内容、任务详情和报告仍由各自 scope 校验，列表权限不扩大证据读取；普通 Job 无新增查询通道。

本切片不提供猜测资产/版本筛选、关联边或数据完整性承诺。来源提前去重修复、权威特征覆盖率与样本质量、查询规模性能需分别验收；字面文本检索不是语义同一性判断。既有默认无分页 API 窗口仍供其他调用方使用，项目页面不再依赖该窗口。

## Finding 操作员见证身份与强关系接口（#819）

以下八个 Management API 操作在根认证和项目 scope hook 后注册；读接口要求 `findings:read`，身份 source/mapping 写接口要求 `admin`。项目受限主体只能访问自己的 Finding/Canvas；Job capability token 不进入这些 Management API，也不能写入身份登记。完整字段、严格未知字段拒绝、OpenAPI scope 和稳定错误响应以 [relation routes](../../apps/scheduler/src/domains/project-finding-research/relation-routes.ts)、[relation OpenAPI](../../apps/scheduler/src/domains/project-finding-research/relation-openapi.ts)、[`auth.ts`](../../apps/scheduler/src/auth.ts) 和 [shared relation schema](../../apps/scheduler/src/domains/project-finding-research/relation-schemas.ts) 为准。

| 方法和路径 | scope | 接口边界 |
| --- | --- | --- |
| `GET /findings/:id/relations` | `findings:read` | 当前 Finding 的有界强关系状态；可选 opaque cursor 绑定 project、subject、generation、source/identity fingerprint，游标失配返回冲突并要求从首面重读 |
| `GET /canvases/:id/finding-relations` | `findings:read` | 同一 repeatable-read 快照内的 Canvas 有界投影；不接受查询参数，不代表完整项目图 |
| `POST /findings/:id/identity-sources` | `admin` | 登记 typed source manifest；server 生成 `source_id`、内容摘要和 `registered_by`，不是调用方声明 |
| `POST /findings/:id/identity-sources/:sourceId/revisions` | `admin` | 以 `expected_source_revision` 做 CAS 追加不可变 revision；旧 revision 的 mapping 立即失效 |
| `POST /findings/:id/identity-sources/:sourceId/revoke` | `admin` | 以当前 source revision + reason 撤销；保留历史，重复相同撤销可幂等读取 |
| `POST /findings/:id/identity-mappings` | `admin` | 首次按 `source_id`/field 绑定，`expected_mapping_version` 必须为 `null`；server 从当前 source 解析 digest/metadata/freshness |
| `POST /findings/:id/identity-mappings/remap` | `admin` | 以最新 mapping version + reason 做显式 CAS remap；原 mapping 撤销并追加新版本，不能静默覆盖 |
| `POST /findings/:id/identity-mappings/revoke` | `admin` | 以最新 mapping version + reason 撤销当前字段绑定；保留历史并触发关系重建 |

source body 只允许 `authority_version`、受限 `source_kind`、无控制字符的 `source_ref`、`freshness_until` 和非空 digest-only `identity_fields`；mapping body 不接受调用方自报 `identity_digest`、source revision/kind/ref/digest 或 provenance。source revision、mapping version、项目/Finding/source 外键和当前状态在事务内重验；过期、撤销、字段缺失、跨项目 source、旧 CAS 版本、重复 remap 和未知字段 fail closed，典型稳定错误为 `IDENTITY_SOURCE_CAS_CONFLICT`、`IDENTITY_MAPPING_CAS_CONFLICT`、`IDENTITY_SOURCE_STALE`、`IDENTITY_SOURCE_REVOKED`、`IDENTITY_SOURCE_FIELD_MISSING`、`PROJECT_MISMATCH` / `PROJECT_SCOPE_MISMATCH`。

关系响应明确返回 `authority_basis=platform_admin_attestation` 与 `independent_external_verification=false`。当前 `quality_gate_status=not_evaluated`、`published=false`，公开读路由省略 suppressed relations；`includeSuppressed` 等未知 query 字段由 strict schema 拒绝。每次读侧按当前 Finding source fingerprint、identity snapshot fingerprint、generation 和 rule version 重核，旧或失效项标 `stale_results_omitted`；身份历史不完整则 `read_status=blocked`。响应中的 `read_status`/`read_reason`、`pair_truncated`、`next_cursor` 和 Canvas `query_budget` 是完整性判断，不应把空 `items` 当作“没有关系”。

读取、计算和历史的上限只在源码命名常量维护：Finding page 的 `RELATION_RESULT_LIMIT`，Canvas 的 `CANVAS_FINDING_LIMIT`/`CANVAS_RELATION_LIMIT`/`CANVAS_RESPONSE_BYTES`，worker 的 `RELATION_BATCH_SIZE`/`RELATION_PROJECT_SCAN_SIZE`/`RELATION_PAIR_LIMIT`，以及 mapping 的 `IDENTITY_MAPPING_HISTORY_LIMIT`；见 [`relation-read.ts`](../../apps/scheduler/src/domains/project-finding-research/relation-read.ts)、[`relation-computation.ts`](../../apps/scheduler/src/domains/project-finding-research/relation-computation.ts) 和 [`identity-mapping-store.ts`](../../apps/scheduler/src/domains/project-finding-research/identity-mapping-store.ts)。文档不复制这些可变数值。

## Finding quality management protocol (#819, 2026-11-01 merged engineering slice)

Nine routes are registered under `/projects/:id/finding-quality`: GET `/assets`; POST `/protocols`; GET `/protocols/:protocolId`; GET `/protocols/:protocolId/report`; POST protocol `/freeze`, `/declarations`, `/declarations/:declarationId/payload`, `/reviews` and `/revoke`. [Registrar and strict bodies](<../../apps/scheduler/src/domains/project-finding-research/quality-api.ts>) and [OpenAPI input schemas/response allowlists](<../../apps/scheduler/src/domains/project-finding-research/quality-openapi.ts>) are the machine authority; root routing and scope manifests are wired. The agreed SQL/HTTP engineering slice passed at fdb55a01 in Actions; [acceptance evidence](<../PROJECT_FINDING_EVALUATION.md#819-sql-quality-engineering-2026-11-01-merged-engineering-slice>) does not cover subsequent repair/final-main checks or independent quality.

Every route requires a true authenticated user session with admin/operator role, admin scope and same-project ownership before body handling; API token, bootstrap, internal and Job actors cannot become review humans. Queries/unknown fields are rejected, responses are no-store. CAS expected_version is a canonical decimal string within signed-bigint range, never a JSON number. Actor, timestamps, quality flags and future report digests are server-owned.

Payload preParsing commits holdout access separately before decoding JSON, media rejection, body-limit processing or admission. Rejection cannot roll it back; a reused request key with unknown raw identity conflicts before body consumption and does not append a second exposure. Late freeze, receipt/scope/loaded-asset mismatch and stale CAS fail closed. Error codes come from the contract/registrar, including the verified QUALITY_HEAD_VERSION_CONFLICT; error projection is finite and does not echo raw labels.

Report GET uses one caller repeatable-read snapshot to reconstruct completed work, immutable observations, actual evaluation and current source/identity bindings, then recompute metrics/digests. Its explicit allowlist exposes bindings, aggregate ratios/counts and blockers, not report.input, raw labels or selector traces. Review checks durable chain/account conflicts and this current report in the same snapshot. Both still return quality_status=not_evaluated; structural review/revoke is not external human verification, a current certificate, promotion or public strong-relation authority.

## Job-scoped Control API

Control API 由 Scheduler 动态注册 operation、schema 和当前 Job 的 allowlist。Agent 持有短期 capability Bearer token，调用 `/control/v1/jobs/{jobId}/capabilities`、`/openapi.json` 和 operation 入口。宿主依次校验 token hash/Job/project/canvas、Job active 状态、过期/撤销、snapshot hash、operation allowlist、共享 Zod schema、可见引用和业务状态；Job 终态后 token 失效。只读 graph/capability/Skill 查询也受 Job 预算和脱敏约束。

所有 `/control/v1/jobs/{jobId}/operations/{operationId}` POST（包括只读 discovery、graph/capability 查询和 Skill 拉取）都必须带 UUID `Idempotency-Key`。在同一 Scheduler 进程的接口缓存仍存在时，同 key、同 operation 和同输入可返回已有结果；同 key 改变 operation/input 返回冲突。只读 operation 的 key 只提供请求级缓存和冲突检查，不产生 durable event/effect receipt；改变语义或外部效果的 operation 才继续依赖具体领域的事件 dedup、唯一键或 effect settlement。当前接口层缓存是进程内的，Scheduler 重启后会丢失；重启后的重复请求不能把内存缓存当成跨重启幂等保证。

Control operation 分为两类：能力发现、graph 查询和 Skill 拉取返回受治理只读结果；`emit_progress`、`emit_fact`、`emit_finding`、`submit_hub_decision`、`mark_job_done`、`request_human`、人工 ACK 及 Plan/PlanResult 是语义提交。当前 v2 Plan/Result 在事件事务内驱动 Scheduler 复用既有 Intent admission/materializer 执行依赖任务，complete/报告仍受当前全判据 authority 校验。operation 不直接暴露数据库、容器、长期凭据、快照或终态修改；语义副作用只由 event-ingestion/application transaction 执行，v1 历史读取不是新执行输入。

### 完成恢复提案（#874）

`submit_hub_decision` 在既有 complete/intents/payload_file 之外增加严格互斥的 `recovery` 分支，并与 plan_basis 互斥；字段只在[共享 schema](../../packages/shared-types/src/completion-recovery.ts)定义。Scheduler 冻结的 `trigger.recovery_refs` 授予精确 target Job/Attempt、scope、快照、恢复 revision 与 evidence hash；普通 Hub、猜测 UUID 或只读图 metadata 不取得此权限。shared schema、宿主 handler 和最终语义事务复核同一契约及当前 token/lease/allowlist、原预算、授权与证据 CAS。

合法 action 为 `reconcile_effects` / `stop` / `release_stale`（后者用原 grant 无目标效果退出）；reason 不作为证据。200 `persisted_deferred` 仅证明提案持久接纳，不表示对账执行、Job 成功或模型理解。稳定拒绝码 `recovery_not_authorized`、`recovery_paused`、`recovery_stale`、`recovery_inactive` 默认 fail closed，不能靠自动重试扩大权限。原 completion key 的负回执保持不可变；活动原 Attempt 在证据修复后需用新 revision/key 重新走完成门。详见 [ADR 0015](adr/0015-governed-completion-recovery.md)及[专题](../REPAIR_FEEDBACK_DONE_REPAIR.md#completion-recovery-v1)。当前分支最终 SHA 的 Actions 尚待验收。

## 项目知识接口（#752 分支）

Management API 的 `/projects/:id/knowledge` 提供按项目授权的目录、版本、work、评测、usage/feedback、receipt 查询，以及来源项目管理者的精确 Skill 授权和不可逆撤销；grant 入口还要校验该版本已经审批，不能以授权激活 candidate。Job-scoped Control 增加知识搜索/读取、请求整理、提案、评测、审查和反馈；平台推导 project、Job、Attempt 与 stage，不接受调用方自报身份。只读输入受冻结 manifest、audience 和当前权限约束；mutation 经 shared schema、宿主和领域事务校验，返回 `accepted`、operation、`receipt_ref`，同 Job 同 key 同输入返回持久结果，同 key 异输入冲突。当前 Job 可用 `get_knowledge_receipt`，终态历史由项目管理入口查询。接口字段见 [OpenAPI](../../apps/scheduler/src/openapi.ts) 与[项目知识专题](../PROJECT_KNOWLEDGE.md)；领域 receipt 不等于全平台通用回执。

## Gateway、流和导入接口

Gateway 的请求次数额度在 Job 锁内跨 token/Attempt 累计；撤销/过期 token 仍参与用量与有限上限求交，普通 main 与 OM 均不能通过恢复、换 token 或新配置的 0/未配置重置额度。首次 mint 用内核 `control_receipt/gateway_request_budget` 冻结包括未签发 workload 的完整策略，后续只可追加收紧；恢复必须在替换旧快照前同事务保存旧策略。缺失或损坏的冻结策略明确拒绝，mint 固化交集，`_allowance` 在请求额度耗尽时返回 `JOB_REQUEST_EXHAUSTED`，最终 dispatch 仍重新准入；拒绝无模型出站、模型 effect 或请求计数变化。策略无效/历史缺失的模型准入拒绝保存 scoped `policy_rejected` settlement 回执，OM 仅凭可信回执分类为不可重试策略硬失败，不使用 quota/transient 软降级路径。详见[透明预算契约](../MODEL_GATEWAY_TRANSPARENCY.md#预算与-om-迁移)。

缺损 runtime knobs 的普通 resume 拒绝保留 `GATEWAY_REQUEST_BUDGET_INVALID` / `missing_fields`。仅当只读核验确认显式 rerun-current 的预算/效果/权限条件满足时返回 `next_action=rerun-current`，否则 `inspect-job-recovery`；读取诊断不补冻、不撤 grant、不入队。显式补冻缺少可信完整策略或执行前证明时为 `GATEWAY_REQUEST_BUDGET_HISTORY_MISSING`，交集额度耗尽沿用 `REPAIR_REQUESTS_EXHAUSTED`。Web 按宿主下一步提示显式选择或核对历史，不冒充账号错误、不自动重跑。批量旧快照恢复仍保守拒绝；详见[可信显式恢复](../AGENT_REPAIR_LIFECYCLE.md#缺损快照的可信显式恢复943)，最终 SHA Actions 待验。

- **Model Gateway：** Provider 选择、凭据、网络、模型和用量归 Scheduler 所有。Gateway 上游请求/响应体不落库（usage 计数除外）；Job 执行流由 Evidence writer 归档并对已登记的运行时 secret 脱敏。Provider 错误不成为 Agent 可伪造的语义事件。实现见 [`gateway.ts`](../../apps/scheduler/src/gateway.ts) 与 [`evidence.ts`](../../apps/scheduler/src/evidence.ts)。
- **过程流：** WS 使用一次性 ticket、项目/Job scope 和本地 Evidence catch-up。stream-bus 只做实时投递；本地副本不可见时返回 `visibility=unavailable`，不能从另一副本补造原始流。终端 WS 另有更严格的 control/admin scope、lease、帧大小和空闲限制。
- **导入/导出：** transfer 域校验格式、hash、版本/计数、项目 scope、路径和 provenance。导入可以保留历史 Job 的终态、旧 Attempt/effect 和 provenance，但不能恢复历史 token、沙箱或 secret，也不能直接授权新的 active execution；需要重跑时必须按当前 admission 和 snapshot 重新治理。导入与导出均审计。

[#776 A 基线](../REPAIR_FEEDBACK_BASELINE.md)冻结当前字段完整性与 operation/error/effect 恢复矩阵；进程内幂等缓存和广告预算不构成持久修正链。

[#776 B](../REPAIR_FEEDBACK_DONE_REPAIR.md)给 mark_job_done 增加必填 proposal revision header、原 key 的只读回执查询和持久拒绝计数。原 Control 权限仍有效；accepted/persisted_deferred 不是终态或效果结算。

## Pi RPC 完整归档回读（#990 切片）

`GET /jobs/:id/evidence/runtime` 是 Management 只读接口，沿用 `tasks:read` 和项目/Job 鉴权，不新增 Control operation。严格 query 选择 `path/attempt_id/sha256`、可选 RFC 6901 `pointer` 和返回值 `bytes` 校验；仅读取该 Job manifest 的对应 Attempt RPC 文件。先校验不可变源长度/hash，再完整脱敏、选值；`value` 保持类型，`source` 与返回值 hash/字节范围明确分离。未知字段、源冲突、Pointer/字节/预算/本地可见性错误返回稳定 `PI_RPC_*`，忙返回可审查拒绝，不以预览降级成成功。既有证据列表/下载按需访问，无新开关、通知或自动大输入。完整字段见 [OpenAPI](../../apps/scheduler/src/openapi.ts) 和 [Pi RPC 专题](../PI_RPC_PAYLOAD_LIMITS.md)，最终 SHA Actions 待验。

## 稳定错误和 RepairFeedback

#951 候选在实际 `executeReal` 运行结束后的本地缺 done 路径使用 `AGENT_COMPLETION_UNOBSERVED`；原 runner/语义错误仍保留原错误对象/分类。诊断写入现有 Job Evidence stream，由既有项目/Job 权限读取，不增加公开 transcript/工具输入或新恢复接口。原控制回执按 Job/Attempt/snapshot/receipt identity 验证后只投影元数据；接纳或 done 事件存在不表示最终 Job 成功，读取不可用不表示无提案、零用量或可重放。终态 token 失效后应由有权用户通过既有 Job 详情/证据检查，不建议猜测新 token/key。详细字段及候选待验范围见[完成失败诊断](../AGENT_REPAIR_LIFECYCLE.md#完成失败诊断候选951)。

| 层 | 典型错误 | 调用方动作 |
| --- | --- | --- |
| 认证/作用域 | 未认证、项目越界、token 过期/撤销 | 停止调用并重新走管理授权；不能用新输入绕过 scope |
| 操作/状态 | operation 不存在、不在 allowlist、Job 不在运行态、状态冲突 | 读取当前 capability/Job 状态；权限和错误状态 fail closed |
| 输入/引用 | 未知字段、坏 UUID、不可见节点/Finding、超字节/计数 | `model_correctable` 时按反馈重新读取有界状态并用新 key 修正 |
| 速率/瞬态 | 429、Provider/Handler 暂时不可用、Gateway stream 截断 | 只按反馈延迟和预算重试同一语义；不重放未知效果 |
| 外部效果 | effect 已发出但结果不明、清理回执缺失 | `unknown_external_effect`，保留 effect id，转对账或人工 |
| 永久失败 | 工具未准入、快照/权限不匹配、禁止的控制文件 | `permanent_failure`，停止自动重试并进入失败/人工处理 |

规范要求 [`RepairFeedback`](../../packages/shared-types/src/repair-feedback.ts) 至少包含版本、category、code、operation、字段 path、脱敏 message、expected、observed_shape、current_state_ref、accepted_effects、idempotency_key、proposal_revision、repair_attempt、remaining_budget 和 next_action。`observed_shape` 只描述类型/长度/计数，不回显不可信正文、凭据、Provider 原文或堆栈。当前实现只在部分 Control schema/语义 payload 校验路径构造完整 envelope；auth、allowlist 和部分状态错误仍可能只返回稳定 error code，Hub、Verify、Completion Gate 与完整 Proposal/Receipt/Settlement 也尚未统一。该覆盖缺口登记于 [D-03 风险登记](12-risks-and-tech-debt.md#2-当前实现债务)，不能反向缩小规范要求。模型可修正错误必须重新读取当前状态，用新的 proposal revision 和 Idempotency-Key；瞬态错误遵守反馈的 retry delay；未知效果禁止自动重放。

Knowledge/Skill runtime 拒绝显式保留领域分类和 `next_action`，生命周期失效、权限/撤销拒绝不得在适配过程中变成可修正或安全可重试；真正可修正的输入仍交回当前合法 Agent。外层准入与域分支的验证边界见[知识拒绝反馈](../PROJECT_KNOWLEDGE.md#knowledgeskill-拒绝反馈903-切片)。

Control handler 的错误响应保持稳定 code 和人类可读消息；下游原始错误文本不会直接透传。失败响应是否缓存遵循幂等语义：限流和未建立结果的瞬态失败不制造虚假的成功结果。Control 路由没有承诺一个跨重启的通用 receipt 查询 API；结果能否重读由具体事件、effect 或领域查询接口决定。

`submit_hub_decision` 的可修正 `invalid_node_ref` 可返回由当前 Job principal 生成的 `current_state_ref`，仅当 Canvas 存在且 token 已允许 `graph_query`。该链接 GET 只读 operation Schema，需按 `next_action` POST 有界查询；每次查询和重提重新鉴权/校验，不授予新权限，也不提供图版本锁。无权限时停止猜测，详见 [C0 边界](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

Hub `complete` 被现有分析完成门拒绝时，保持 `invalid_payload` / `complete` 路径，通过 `repair.expected` 提供由宿主门结果生成的有界缺失项。自由文本标题、证据正文与内部错误不进入该投影；反馈不是状态锁或效果接受凭据，提交仍须通过当前权限、引用及最终完成门。详见 [C1 边界](../REPAIR_FEEDBACK_DONE_REPAIR.md)。

## 宿主维护升级接口

平台版本发现 API 保持只读，不能触发 Compose 变更。宿主维护控制器使用固定目标、结构计划 hash、generation 和部署绑定推进；风险计划需要明确批准，角色身份清除不是维护许可的隐含动作。目标 schema CLI 以 stdin 接收连接及动作，plan 使用只读事务，apply 只接受归属明确的候选库；返回结构化错误，不输出驱动原始错误或秘密。管理入口在 preparing 或身份不匹配时拒绝业务请求；当前宿主动作包括 `check`、`apply`、`rollback`、`resume-rollback`，风险批准使用 `--approve-plan-hash`，受管清单使用 `--nodes`。`--reset-role-identity` 已接 #758 目标重建，只在明确选择并批准对应 hash 时清角色 CLI 与项目 model，保留全局 model 和历史快照。`resume-rollback` 已接本地回执与维护源代的受管节点恢复；旧源没有维护契约且含远程节点时仍保持隔离。最终组合基线的多节点升级、第二代失败回滚和显式恢复已有隔离演练证据，范围见 [升级演练](../../deploy/UPGRADE_REHEARSAL.md)；不等同于 Windows Docker 或真实模型验收。具体参数以 [部署说明](../../deploy/README.md) 为准。[ADR 0008](adr/0008-maintenance-candidate-upgrade.md) 规定了激活未知不得回旧的恢复边界。

## Plan 判据管理读取与人工绑定

既有 Job 详情暴露 Plan 内容 SHA/判据；Fact 详情暴露当前来源版本与有界绑定历史。Fact verification PATCH 可附 plan_binding，必须 verified+note、jobs:control；expected_binding_id 与内容 SHA 冲突/不可用返回 409。它不改变 Agent 控制操作或派发契约。字段及限制见 [专题](../PLAN_GAP_PROJECTION.md) 与 OpenAPI。

## Plan 决策元数据（#775 B 首片）

Control graph_query 新增 plan_gap 分页只读类型；submit_hub_decision/request_human 可带严格版本化 plan_basis。字段、只读证明、单步预算、错误/重试边界见 [Plan 协议范围](../PLAN_GAP_PROJECTION.md#b既有-intent-上的一次补证)；OpenAPI 输入 schema 由 shared-types 派生，无新写入 API。

`graph_query(kind=plan_objective)` 是独立的 Job-scoped 只读入口：初始 L0/overview 仅返回有界 handle，objective 查询独立于已接受 Plan 返回 `items[0]` 完整持久化 tuple；selectors、cross-scope、wholeGraph 不在契约内。预算或 input hash 不满足时返回明确失败，不以部分响应证明已完整读取。

### 修正模型请求额度（#776）

Gateway 在 Job 锁内按首个完成拒绝回执识别修正请求，并复用 Attempt effect / usage ledger 累计。`REPAIR_USAGE_PENDING`、`REPAIR_USAGE_UNKNOWN`、`REPAIR_TOKEN_LIMIT_UNCONFIGURED`、`REPAIR_TOKEN_EXHAUSTED` 返回 409 与有界预算投影，不转发模型请求；未知用量的 remaining_tokens 为 null。显式配置、调用前成本限制和恢复行为见 [修正预算](../REPAIR_FEEDBACK_DONE_REPAIR.md#独立修正-token-用量与额度)。

带 plan_basis 的 submit_hub_decision/request_human（含 payload_file）返回 persisted_deferred 接纳回执；GET receipt_key 只读原响应，完全相同 POST 仅尝试恢复原活动 Attempt。changed input/operation 返回409；权限仍受原 Job capability 限制。 详见 [持久化边界](../PLAN_BOUNDED_INTENT_DESIGN.md#持久化与原子性)。

## 成果候选入口（#767）

已提供 TaskContract 的 objective/targets/scope/evidence/acceptance 在创建和派发时检查基本完整性，不因 outcome 省略或 task_defined 而绕过。emit_finding 的 outcome_claim 绑定整个冻结 task_contract_sha256、target、可选 baseline 及逐判据 Fact 引用；赏金 rule_assessments 只是附加筛选。objective/scope/evidence/exclusion:N 必评，acceptance:N 至少一项 matches 表示贡献关联，不是全任务完成。通过仅 admitted_for_research，submission_eligibility:not_assessed；无契约旧入口仍 unassessed。详见[通用标准与研究候选](../TASK_OUTCOME_ADMISSION.md)。

## 目标结果与 Plan 显式关联（#767）

emit_fact.artifact.task_result 接收 delivery/negative_result/blocked/not_executed；goal_review 请求恰好选 finding_id 或 fact_id，均绑定 candidate_artifact_id。Plan verification PATCH 本轮加入可选 plan_binding.goal_review 显式引用，不按索引映射，不替代 verified+note、jobs:control 或原绑定。详见[结果评审](../TASK_RESULT_REVIEW.md)、[Plan 关联](../PLAN_GAP_PROJECTION.md#可选目标评审关联767)及[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

## 程序规则附加评审（#767）

goal_review criterion_ids 增加 program_rule:<ruleid>，仅 supplied bounty Finding 主体可用，fact_id 禁止。报告附加 program_rule_review status=not_assessed/partially_satisfied/rules_satisfied/blocked，通用 criteria 不变；exclusion satisfied 表示未命中排除。详见[评审](../TASK_GOAL_REVIEW.md)与[验收矩阵](../TASK_DISPATCH_ACCEPTANCE.md)。

程序规则报告按[源码累计上限](../../apps/scheduler/src/task-program-rule-report.ts)限制 Finding×rule 判据；超限所有 program_rule_review blocked、criteria 为空，原因 program_rule_projection_limit_exceeded，可读取单 Finding 报告。Plan goal_review_options 过滤程序规则 ID，不扩展通用 Plan 映射。

## 证据追踪诊断修复

GET /findings/:id/evidence-trace 与详情诊断逐 Fact 增加 execution_assurance:not_attested、runtime_claim_structured、retained_bytes_verified；runtime_proof=false，replay.kind=evidence_integrity_check，不执行命令。详见[证据追踪](../EVIDENCE_TRACE.md)。

plan_gap 的 supplementation_execution 只读提供单次补证状态、来源与独立 source_sha256，不改变判据授权摘要或已见引用。Agent 报告的 blocker 类别不认证环境条件。 见 [Plan 执行投影](../PLAN_GAP_PROJECTION.md#一次补证的执行投影)。

## Finding 特征元数据（#770 C）

既有 GET /findings/:id 增加 project_research_features 状态与声明字段覆盖，沿用 findings:read 和项目授权。失败/过期不返回旧特征正文，普通 Job 无新增接口；无关系写入/自动处置接口。细节、质量门与验证见[项目 Finding 特征研究](../PROJECT_FINDING_RESEARCH.md)。

## Finding 词法检索（#770 D 检索首片）

`GET /findings/:id/lexical-search` 使用 `findings:read` 与项目鉴权，按[研究专题](../PROJECT_FINDING_RESEARCH.md#当前声明文本检索770-d-检索首片)指向的有界来源窗口 seek 后排名，返回游标、窗口/排名截断、声明摘要与规则版本。主体变更使游标 409 失效；无 Evidence 内容或资产权限扩张。详情只展示待核验词法候选，不作全项目 top-K 或同问题判定。


`GET /findings/:id/candidates` 沿用 findings:read/项目权限，在[持久候选协议](../PROJECT_FINDING_RESEARCH.md#持久词法候选与代际失效770-d-后续切片)规定的有界窗口读取当前有效词法候选。活动代/主体改变使游标 409 失效；失效记录不补扫，可能返回有下一页的空窗口。Web 区分待计算、失败、过期、成功零项与重建。该接口不写关系、不传播处置；#819 身份管理与关系状态读取是本视图另列的独立入口。

### #778 Skill 条件建议接口

新增 Job-scoped `suggest_project_skills`（只读）与 `record_skill_choice`（knowledge 事件及 durable receipt），使用 shared strict schema 和动态 OpenAPI。target 是调用者声明；策略/context/catalog 摘要绑定上下文，宿主在选择时重算，摘要不授予权限。两个 operation 必须已在冻结 allowlist 中；不存在隐式启用。候选完整有界过滤后分页，超限整次拒绝。详细条件、未知语义及验收见[专题](../SKILL_SUGGESTIONS.md)。

## 独立程序资格管理接口（#822）

FR-FIND-008 增加 `/program-materials` 的登记/读取、单材料读取/撤销，以及 `/findings/{id}/program-eligibility` 的当前投影和 `/reviews` 的写入/历史查询。`GET /program-materials` 与单材料读取沿用 `projects:read`，材料登记/撤销沿用 `projects:write`；当前资格/历史评审读取要求 `findings:read`，评审写入要求 `findings:write`。平台材料准入另要求未绑定项目的管理员，项目材料遵守 actor 项目边界；评审写入另校验认证操作员与 maker 隔离。Job capability 不可调用管理写入。输入使用 [shared strict schema](../../packages/shared-types/src/program-eligibility.ts)，主体/权限由宿主推导，不能在请求体自报 reviewer、权限或资格状态；幂等重放仍检查项目范围。接口字段以[域 OpenAPI](../../apps/scheduler/src/domains/program-eligibility/openapi.ts)为准，当前资格在 repeatable-read 读取中重核 Finding/Artifact/Verify Attempt、材料版本和可重读证据；来源或证据变化、材料替代/撤销、多条有效评审冲突、历史损坏/截断或读取预算不足都保持 `blocked`，不由最后写入覆盖历史。该评审是操作员见证，不认证外部官方规则或自然人/模型之间的物理独立性，不改变技术 Verify、任务判据或执行授权；语义见[专题](../PROGRAM_ELIGIBILITY.md)与 [ADR-0010](adr/0010-program-eligibility-authority.md)。

## Plan v2 目标与路线 CAS（#775）

`PATCH /tasks/:canvasId` 是 Management `tasks:write` 入口，按认证 actor 的项目权限与 Canvas 行锁校验 `plan_objective.expected_revision`；授权用户显式提供 goal、completion 和有限 lifetime budget，响应返回当前 objective/revision。活跃及历史 Job snapshot/Attempt/事件不被编辑；模型不能调用该管理输入改写目标。

Job-scoped `submit_plan` 当前严格要求 `{plan: PlanV2, revision: execution_route}`；`submit_plan_result` 同样只接收 v2。objective/revision、owner、route CAS、Plan SHA 与已派发 task 的字节身份必须匹配；模型只能调整未派发路线，不能重置 lifetime 计数。v1 Plan/Result 只供历史读；普通 HubIntent 走原 handler，不制造新的 v1 `plan_protocol`，不可变 v1 与 `hub_intent_adapter` 审计只作历史解析。接纳 receipt 查询只恢复原响应，不证明执行或语义完成；工程执行投影和操作员完成门分开。机器字段以 [plan.ts](../../packages/shared-types/src/plan.ts)、[objective](../../apps/scheduler/src/domains/plan-protocol/objective.ts)和[任务路由](../../apps/scheduler/src/domains/project-task/routes.ts)为准。


## 透明数据面与 scoped 回执（#923）

#958 不新增管理或 Control 路由、Role/Job 输出配置字段：`maxTokens` 仍由 Pi 选定模型原生配置提供。发现目录描述增加逐字段来源/有效性，Job JSON 快照冻结 `model_budget` 的 configured/declared/effective/source；发现不扩大配置名单，实际 CLI 限制只作运行诊断。输入 schema 与历史快照不因新增诊断自动放宽或回写，详见[预算与恢复契约](../PI_MODEL_BUDGET_RECOVERY.md)。OpenAI 两种输出字段的生成和透传分别接实际 SDK 与 HTTP/PG 回归，最终 SHA Actions 待验。

Model Gateway 支持原始方法/相对路径/query、未知端到端头及原始 body；保留上游状态、错误、头和 SSE，不隐式重试或重定向。Host、认证及必要逐跳/framing 在内核边界处理。`x-deepsonar-request-id` 是被消费的精确控制字段；`GET /gateway/_settlement/:id` 是当前 Job/Attempt/token/workload 范围内、不可缓存的只读结算查询，不是上游路由或模型调用。返回 settled、not_started、policy_rejected、pending、unknown 或 not_found，不泄露其他 scope 的 ledger。预算准入可返回 `GATEWAY_OUTPUT_BUDGET_REQUIRED`，客户端须显式提供受预算约束的输出参数。原始请求流有界缓冲、HEAD/OPTIONS、编码及升级限制见[契约](../MODEL_GATEWAY_TRANSPARENCY.md)，实现见[Gateway](../../apps/scheduler/src/gateway.ts)。

`GET /gateway/_allowance` 接受当前有效的 main 或 observational_memory token 与活动 Attempt，返回 `{ remaining_tokens: null | number, policy_required: boolean }`，禁止缓存。查询在 Job 锁内读取原预算，不预留、不增加模型请求计数；main 取 Job 总量或 OM main-workload 额度与修正链余额的交集，后台保持自身额度。pending/unknown 拒绝；返回提示后最终出站仍须锁内重验，不能扩大授权。主执行由沙箱请求生成适配器处理输出参数，OM 由受审 wrapper 处理；两者都不替代 Gateway 准入。

配额/已回滚 DB admission 拒绝的 `not_started` 查询来自同 scope 的宿主 `events.control_receipt`（`operation=gateway_admission`、`authority=kernel`），不以错误正文授权降级；无持久回执则 unknown，同 UUID 不得重发。详见[透明传输](../MODEL_GATEWAY_TRANSPARENCY.md)。
#903 的当前 `execution_state` 与历史回执分离、恢复代际及 HTTP 分类见 [生命周期契约](../AGENT_REPAIR_LIFECYCLE.md)。

Hub Intent 的 OM 配额冻结遇到已知宿主配置错误时返回 `pi_om_configuration_invalid`，`retryable=false`，RepairFeedback 为 `permanent_failure`；`expected` 保留受控 reason 与 `platform_administrator` owner，下一步要求平台修复后重新准入，不授予 Agent 扩额或自动重试权。仅映射已知配额异常；其他 DB、schema、resolver 错误不降级为确定无效果。
