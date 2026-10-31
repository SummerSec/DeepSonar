# 11. 工程规范

> 状态：**as-built（#741 PR 5 回填）**。本文记录当前仓库开发、验证和文档治理必须遵守的工程规则；实现冲突时以代码、schema、OpenAPI 和测试为准。
> 同步日期：2026-10-31

本文是 DeepSonar 的开发规范视图。它把可重复的工程约束、测试分层、文档保鲜和发布前核查集中在一个位置；新架构事实以 [`docs/architecture/README.md`](README.md)、相关架构视图、追溯矩阵和 ADR 为准，`DESIGN.md`、`docs/README.md` 与其他专题文档提供摘要或专题证据。

## 1. 规范边界与事实顺序

本规范适用于仓库内的产品代码、schema、OpenAPI、测试、架构文档和仓库开发 Skill。它不授予模型、插件或运行时额外权限，也不改变 Scheduler、沙箱或数据库行为。

发生事实冲突时按以下顺序核对：

1. 运行时代码、`database/schema.sql`、OpenAPI 和行为测试；
2. [`docs/architecture/README.md`](README.md)、`01`/`traceability`、受影响的 `02`–`12` 视图和 ADR；
3. [`DESIGN.md`](../../DESIGN.md)、[`docs/README.md`](../README.md) 和专题文档的摘要或专题证据；
4. `docs/ARCHITECTURE.md`、issue、历史计划和讨论记录仅作为历史迁移对照。

历史材料可以说明决策来源，但不能单独证明能力当前存在。发现文档与实现不一致时登记偏差并回写文档，不能改规范去迎合未实现的行为。

## 2. 代码与数据规范

### 2.1 领域边界

- 入口负责鉴权、解析和组装；领域模块负责状态、不变量和事务规则；基础设施模块负责数据库、沙箱、文件、网络等外部效果。
- PostgreSQL 保存管理与审计真相，Canvas 保存过程投影，Sandbox/Evidence 保存执行与原始证据，Scheduler 是唯一有副作用的执行者。
- Agent、模型和插件只提交受治理提案。它们不能直接写数据库、改变 Job 快照、选择未准入镜像、读取长期凭据或推进终态。
- 新业务能力优先进入 Capability Pack，并复用 Job/Attempt/effect、Control API、沙箱和审计；不得另建执行通道或固定角色分支。

### 2.2 状态、幂等和快照

- 状态字段、幂等键、外键、权限骨架、租约和时间戳使用定列；开放内容进入 JSONB。类型字段使用字符串，不用 PostgreSQL enum 锁死后续演进。
- Job 只消费创建期的 `agent_snapshot_json`。运行中配置、Provider/model、CLI、镜像 digest、工具清单、能力 selector、网络和 runtime knobs 不从最新配置回读。
- 语义事件必须有稳定 `event_id`，写入路径执行项目/画布/Job/Attempt 归属校验和同 Job 顺序校验；重复语义写入由事件账本或领域唯一约束返回既有结果。只读 discovery 的请求级幂等不能替代 durable event/effect identity。
- 对外部效果先记录 intent/effect 状态，再记录 settlement。`unknown` 或 `replay_policy=never` 不得由模型猜测重放；取消、超时、迟到回调、Reaper 和资源清理必须幂等。
- 历史 Job 快照、Evidence、审计记录和历史投影是不可变事实。新的运行时契约不为旧配置保留兼容输入，具体规则见 [ADR 0001](adr/0001-no-backward-compatibility.md)。

### 2.3 Schema 基线

`database/schema.sql` 是唯一 schema 基线，当前主线版本由 [`apps/scheduler/src/schema-version.ts`](../../apps/scheduler/src/schema-version.ts) 的 `SCHEMA_VERSION` 导出并与基线校验一致。空库在保留连接和 advisory lock 下套用基线；非空库必须匹配 `schema_meta` 版本和表/列结构，否则拒绝启动。改表时直接修改基线、递增版本并用 `pnpm db:rebuild -- --plan` / `pnpm db:rebuild -- --apply` 走备份、列交集回填和序列校验；不写增量 ALTER 链。详细决策见 [ADR 0002](adr/0002-schema-baseline.md)。

稳定状态和约束写入基线的定列，易变业务内容写入 JSONB。Schema、shared types、OpenAPI 和测试出现分歧时，先修正事实入口和受影响文档，再补齐行为验证。

## 3. API、失败和安全规范

### 3.1 Control API

真实 Job 的语义写入只通过 Job-scoped Control API 完成。受治理的普通 MCP/CLI 工具仍可作为业务执行手段，但不得绕过 Control API 写入语义状态。短期 Job capability token 只保存可审计的 hash/prefix 表示，按 operation allowlist、项目 scope、Job 状态、过期时间和预算校验；终态同时撤销相关 token。发现接口只提供选择入口，不能把发现结果当成授权。

Control API 的每个 operation 必须经过三层校验：

1. shared types/Zod 对字段、未知键、字节数和结构做严格解析；
2. 宿主 handler 重新校验 Job、Attempt、项目、画布、Finding、能力、镜像和权限边界；
3. event-ingestion/application 在同一事务中锁定真相、做幂等和状态迁移，再应用领域副作用。

普通文本、未治理的 CLI/MCP 输出、Session 标题、伪造的 tool call 或控制文件不能直接产生语义事件；受治理的普通 MCP/CLI 调用仍须通过 Control API 提交语义写入。规范要求 `accepted` 表示 Scheduler 已接收并建立可查询的 durable receipt 语义，不表示模型已经完成。当前实现依赖具体事件/效果的持久化身份；进程内请求缓存不是通用 durable receipt API，完整统一协议仍登记为技术债。

### 3.2 RepairFeedback 与日志

可修正的 schema、引用、权限、状态和字节限制错误返回版本化、脱敏的 `RepairFeedback`：分类、稳定错误码、operation、字段路径、消息、期望形状、观测形状、当前状态引用、已接受效果、幂等键、提案/修正次数、剩余预算和下一步。观测形状只允许类型、长度、计数或摘要，不能回显凭据、Provider 原文、完整不可信输入或内部堆栈。

错误分类必须区分 `model_correctable`、`transient_retryable`、`unknown_external_effect` 和 `permanent_failure`。瞬态故障只能有界重试；未知外部效果进入对账、orphan 或人工路径；权限、版本、快照和能力准入错误 fail closed。修复预算耗尽时显式进入 `blocked` 或 `needs_human`。

日志、审计、Evidence、Session 归档和错误反馈必须脱敏。长期 Token、Provider secret、完整上游响应、个人部署地址和可变镜像标签不得写入快照、沙箱工作区、Evidence 或文档夹具。

### 3.3 运行时与镜像

运行时执行只使用平台目录中可见、已准入且以不可变 digest 标识的镜像版本。第三方版本须先由 `apps/image-admission` 扫描、批准并绑定可见项目；Agent/Hub/任务内容不能提交任意 OCI 地址。Job 创建重新检查镜像 readiness、平台、CLI 兼容性、工具清单和网络策略，并把结果冻结到快照。

运行时能力缺失返回结构化 `capability_unavailable` 或稳定准入错误，不通过包管理器、下载脚本或未登记命令静默安装。镜像目录、签名/扫描、版本引用和 pull/reconcile 的细则见 [ADR 0006](adr/0006-runtime-image-admission.md)。

## 4. 测试分层与实际接线

测试入口按风险和依赖分层，脚本只代表已接线的测试；没有运行的环境验收不能在文档或 PR 中写成通过。

| 层级 | 目的与边界 | 当前入口 / 证据 |
| --- | --- | --- |
| 静态与构建 | 类型、包边界、生成物和基础编译 | `pnpm typecheck`、`pnpm build`；CI `gate` job 执行 `pnpm -r typecheck` 和 `pnpm -r build` |
| 单元与契约 | 纯函数、Zod/OpenAPI、状态转换、能力和错误反馈 | `pnpm ci:unit:capability-pack`、`pnpm ci:unit:canvas-facts`、`pnpm ci:unit:finding-research`、`pnpm ci:unit:verify-eligibility`、`pnpm ci:unit:runtime-images` |
| bounded-context 与路由守则 | 固定路由面、所有权、事件摄入、生命周期和测试接线 | `pnpm ci:unit:bounded-contexts`、`pnpm ci:unit:scheduler-characterization`、`pnpm ci:unit:ci-test-hook`、`pnpm ci:unit:file-size` |
| PostgreSQL 集成 | 事务锁、幂等、投影、恢复和跨进程行为 | 需要 `TEST_DATABASE_URL` 的 `pnpm ci:integration:finding-research`、`pnpm ci:integration:finding-protocol`、`pnpm ci:integration:platform-api`、`pnpm ci:integration:event-ingestion` 等；CI gate 显式注入测试数据库 |
| Web 与接口集成 | URL 真相、权限、空态/错误态、刷新和事实投影 | `pnpm ci:unit:web-facts`、`pnpm ci:unit:searchable-selects`、`pnpm ci:integration:report-download` 等；Web 下拉必须通过可搜索选择门禁 |
| Sandbox / images / smoke | 镜像、OpenSandbox、清理、控制面和真实部署边界 | `pnpm ci:images`、`pnpm ci:smoke:control-api`、`pnpm ci:smoke:hub`、`pnpm ci:unit:runtime-sandbox`；需要真实 Docker、OpenSandbox 或 registry 的测试必须声明前置条件 |
| 文档与发布门 | 版本字面量、脚本和链接、已删机制、架构文档结构 | `pnpm ci:unit:docs-freshness`；CI 已在 `.github/workflows/ci.yml` 的 docs-freshness job 接线 |

单元测试不替代 PostgreSQL 集成，typecheck 不替代行为测试，fake 模式冒烟不替代真实沙箱或多架构镜像证据。`ci:unit:ci-test-hook` 维护 `*.test.ts` 的脚本接线棘轮；它不能证明对应 script 已被 workflow 调用，workflow 仍需人工核对。测试数据库或真实沙箱不可用时保留跳过/未执行事实，不改写为成功。

当前 CI 在单 workflow 内分类 PR：只有新增/修改且位于 [明确文件白名单](../../agent-harness/classify-ci-changes.mjs) 内的纯文本文件可跳过重活；不按 Markdown 后缀或 docs/skills 目录前缀放行。运行时手册、Skill、提示、配置、未知路径、混合改动、删除及重命名都运行全量。分类器使用 NUL 分隔的 Git diff 保留文件名身份。文档保鲜与 `pnpm ci:unit:ci-routing` 始终执行，ci-summary 验证分类结果、文档与每个应运行 job，失败、取消或意外跳过不能通过。分类失败/缺失输出不允许走文档路径；已触发的 push 与 workflow_dispatch 强制 full。

合并到 `main` 的 push 对文档路径使用 `paths-ignore`，所以纯文档变更是否触发主干 CI 不能靠经验推断，必要时按发布硬门手动补跑并核对 SHA。

Chrome Fuzz ARM64 的 CI/Release cache miss 构建前执行[受控宿主磁盘准备](../../.github/ci/prepare-hosted-runner-disk.mjs)，只清理 GitHub-hosted runner 的显式 SDK 白名单，保护工作区和 Docker 状态。always-running docs-freshness job 另运行该脚本的 mock 安全测试。实际磁盘耗尽证据、信任限制和待验证运行见[发布专题](../RELEASE_RUNTIME_IMAGES.md#chrome-fuzz-arm64-的宿主磁盘准备)；不以清理测试代替原生构建或 smoke。

## 5. 文档、需求和发布保鲜

结构性变更包括功能域、API、schema、状态机、配置快照、运行时镜像、权限或安全边界变化。提交前必须从完整变更面判断影响，并同步：

| 变更面 | 必须更新或核对 |
| --- | --- |
| 需求、功能域或质量属性 | `docs/architecture/01-system-specification.md` 与 `traceability.md`；引用既有需求，不重复定义 |
| 上下文、约束、构件、运行时、部署、数据、接口或安全 | `02`–`10` 中的权威视图和受影响专题；每个视图文首状态/同步日期 |
| 工程规范或风险边界 | 本文、`12-risks-and-tech-debt.md`，必要时更新 ADR 索引 |
| 已定案的内核边界或长期取舍 | 相应 ADR；决策内容改变应新增 ADR，不能改写已采纳正文 |
| 顶层入口和专题状态 | `docs/architecture/README.md`、`docs/README.md`、`DESIGN.md` 及仓库入口，按仓库协作边界同步 |

允许不更新文档的例外：局部实现未改变外部契约、架构边界、状态、不变量、测试接线和已有 as-built 描述。PR 必须写明核对过的文件及无需更新的理由；不能为了“保鲜”机械改同步日期。所有新架构文档前 12 行包含 `状态` 和 `同步日期：YYYY-MM-DD`，日期表示最近一次事实核对而不是编辑时间。

发版、修改 `CHANGELOG.md`、创建或移动 `v*` tag 前，执行 [`AGENTS.md`](../../AGENTS.md) 的文档保鲜清单：schema 主线版本与代码一致、文档命令和链接可解析、已删机制只作解释性出现、as-built 段落人工对照代码、可变数字带核对基线，并核对状态索引和发布证据。`pnpm ci:unit:docs-freshness` 只能覆盖其中的机检项，不能替代语义审查。

**可变数字的时效要求（人工项）**：env 默认值、阈值、上限、超时、计数、池大小、冻结额度这类会随代码变化的值，只能二选一——写核对基线（`main <sha>` 或 `YYYY-MM-DD`），或不复制数字、直接链接代码与权威文档（如 [`USAGE_LIMITS.md`](../USAGE_LIMITS.md)）。同一数字已存在于权威文档时，其他文档应链接而不复述。禁止「本 PR 基线默认 N」这类无归属写法；这类漂移机检抓不到，实测案例是默认请求额度从 500 改为 0 后，一份标了基线但正文复述旧数字的文档在门禁全绿的情况下过期了一整轮。

## 6. 变更验收输出

完成架构或安全边界变更时，交付摘要至少说明：

- 改动文件、受影响的架构视图和 ADR；
- 事实来源（代码、schema、OpenAPI、测试和必要的 issue）与任何日期未核实项；
- 已运行命令、环境前置条件、通过/跳过/未执行结果；
- 合法、非法、重复、冲突、超时、取消、重启和跨项目输入是否覆盖；
- 未实现或暂缓的边界、风险债务、后续 issue 和是否需要人工验收。

仓库开发 Skill [`architecture-doc-sync`](../../.agents/skills/architecture-doc-sync/SKILL.md) 将上述同步面和验收输出用于后续开发任务；它只治理仓库文档，不改变运行时。

Plan [冻结离线回放](../../agent-harness/plan-replay/README.md)独立锁定期望样本和摘要，从实际SQL/HTTP夹具采集观测。CI输出逐例差异、缺失和分母，失败/跳过不能算通过；未测模型指标保持null，不推导收益或C阶段准入。
