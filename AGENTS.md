# AGENTS.md

本文件是 DeepSonar 仓库内编码 Agent 的工作说明。它描述协作方式、事实入口和不可绕过的工程边界；细节冲突时以代码、`database/schema.sql`、OpenAPI 和测试为准。

## 角色分工

主 Agent（Sol）负责理解目标、拆解任务、架构取舍、验收、合并结果和最终答复。具体、清晰、可重复的执行任务默认交给 `luna_worker`（`~/.codex/agents/luna-worker.toml`，`gpt-5.6-luna`，reasoning `max`）。

委派任务必须自包含，写明：

1. 一句话目标；
2. 范围内与范围外路径；
3. 相关符号或入口；
4. 风格、测试和不可修改区域；
5. 期望的文件、摘要和验证结果。

子 Agent 返回后不能盲信摘要。主 Agent 必须检查目标是否完成、抽查关键 diff、运行适合的验证，并在必要时重新派发更窄的任务。不同 Agent 不得同时编辑同一组文件。破坏性操作、生产凭据和不可逆外部操作留在主线程；秘密不得进入 prompt、日志或 commit。

## 设计事实入口

开始改动前按以下顺序阅读：

1. [`DESIGN.md`](DESIGN.md)：当前 as-built 模型、内核边界、Hub、Capability Pack、Job、Verify、Research、Report、UI 和实现硬约束；
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：完整架构、威胁模型、存储和状态机细节；
3. [`docs/README.md`](docs/README.md)：专题文档的 as-built / 历史 / 进行中状态；
4. [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期 AI-native 可信内核、插件准入、RepairFeedback、Receipt 和 Crash Matrix；
5. 代码、`database/schema.sql`、OpenAPI 和测试。

历史 `*_PLAN.md`、旧 Issue 或角色名称都不能单独证明能力尚未落地。改完结构性设计或安全边界，必须同步更新 `DESIGN.md`、相关专题文档和状态索引。`CLAUDE.md` 应与本文件保持同步。

## 常用命令

```bash
pnpm db:up
pnpm db:up:deploy              # 与 db:up 互斥
pnpm db:rebuild -- --plan
pnpm db:rebuild -- --apply
pnpm dev                       # Scheduler: http://127.0.0.1:3100
pnpm dev:web                   # Web: http://127.0.0.1:5173
pnpm build
pnpm typecheck
```

`.env` 放在仓库根目录并由 Scheduler 加载。`AGENT_MODE=fake` 用于无模型凭据的状态机联调；`AGENT_MODE=real` 使用 OpenSandbox。生产 Compose 通过 `deploy/deploy.sh` 或 `deploy/deploy.ps1` 管理，默认使用已发布的不可变镜像。

测试入口按改动范围选择，不能以 typecheck 代替行为测试：

```bash
pnpm ci:unit:capability-pack
pnpm ci:unit:finding-research
pnpm ci:unit:canvas-facts
pnpm ci:unit:web-facts
pnpm ci:integration:finding-research
pnpm ci:integration:platform-api
pnpm ci:smoke:control-api
pnpm ci:smoke:hub
pnpm ci:images
```

全量脚本见根目录 `package.json`。测试数据库需要 `TEST_DATABASE_URL`；只依赖真实沙箱的测试要明确检查运行时是否可用。镜像改动还要检查 Dockerfile、`.dockerignore`、runtime registry fingerprint、平台架构和体积预算。

## 总体架构纪律

DeepSonar 是“最小可信执行内核 + 可组合能力”：

> PostgreSQL 是管理真相，Canvas 是过程真相，Sandbox/Evidence 是执行真相，Scheduler 是唯一有副作用的执行者。

### 内核拥有的边界

内核永久拥有沙箱、网络、凭据、镜像 digest、Job/Attempt 生命周期、lease、并发和资源预算、capability token、幂等、Evidence 来源、Proposal/Receipt/Settlement、审计、Reaper、未知外部效果和资源清理。模型和插件不能直接修改数据库、容器、凭据、Job 快照、镜像准入、权限或终态。

现有 `explore`、`analyze`、`review`、`test`、`code`、`audit` 是内置 capability pack 的默认组合。新增业务能力优先做 Pack，不增加新的固定角色分支；Pack 必须使用现有 Job/Attempt/effect、Control API、沙箱和审计，不能建立第二执行通道。

### Capability Pack

机器契约是 `deepsonar.capability-pack/v1`，源文件为 `packages/shared-types/src/capability-pack.ts`。Manifest 声明 id/version/scope/digest、inputs/outputs、`platform_tools`、网络权限、预算、失败策略和可选 evaluator。

当前已落地的 Job 级只读发现 operation：

- `list_capabilities`
- `search_capabilities`
- `describe_capability`
- `validate_composition`
- `preview_materialization`

发现不是授权。Scheduler 必须用冻结 Job snapshot、项目 scope、当前 operation allowlist、镜像兼容性和网络策略重新校验。Pack 不能扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。Job 创建时冻结 selector、digest、模块内容 hash 和 missing modules；运行时物化不能把 Job 创建后的 source sync 当成新权限。当前发现接口会读取已信任 catalog，因此任何组合/物化改动都必须显式以冻结 selector/digest 为上限，直到这条边界完全由实现强制前，不得把目录结果直接当授权。

任务级/会话级 Pack 生命周期、评估晋升和跨任务经验推荐属于后续阶段，不能在实现或文档中冒充 as-built。

### Agent 只提案

真实 Job 注入不可由 RoleConfig 同名覆盖的 `deepsonar-control` Skill。Agent 使用短期 Job capability token，通过 Job 级 HTTP API 提交 `emit_progress`、`emit_fact`、`emit_finding`、`submit_hub_decision`、`mark_job_done`、`request_human` 和能力发现等 operation。语义事件不得来自普通文本、CLI 输出、伪造 MCP tool call、Shell 控制文件或管理 API 猜测；失败不得回退到另一套控制通道。

Control API 必须经过 shared Zod schema、宿主 handler、event-ingestion/application transaction 三层校验。未知字段默认拒绝；错误要保持稳定 `error_code` 和人类可读消息。`accepted` 只能表示 Scheduler 已接收并建立可查询的 durable receipt 语义，不能表示模型已完成。

### RepairFeedback

可修正的 schema、引用、权限、状态和字节限制错误必须返回版本化 `RepairFeedback`。至少包括：

- `category`：`model_correctable`、`transient_retryable`、`unknown_external_effect`、`permanent_failure`；
- `code`、`operation`、字段 `path`、脱敏 `message`；
- `expected`、类型/长度/计数形式的 `observed_shape`；
- `current_state_ref`、`accepted_effects`、`idempotency_key`；
- `proposal_revision`、`repair_attempt`、`remaining_budget`、`next_action`。

反馈不能回显凭据、Provider 原文、完整不可信输入或内部堆栈。模型收到 `model_correctable` 后应重新读取能力目录或当前状态，用新的 revision/Idempotency-Key 修正；预算耗尽要明确进入 `blocked` 或 `needs_human`。瞬态错误有界恢复，权限/版本/快照错误 fail closed，未知外部效果禁止自动重放。

### Artifact、Finding、Research 与 Report

- Artifact 是版本化内部写入真相，保存 claims、evidence、relations 和 provenance；`emit_finding` 进入 Artifact 再投影 Finding。
- Fact 是观察或验证证据，有自己的 `verification_status`；Finding 的 `verify_status` 和人的 `disposition` 是独立状态机。
- Verify 只消费结构化 Fact、Artifact、Evidence 和独立 Evaluation，不从 maker 文本推断结论。
- Finding Research 只做语义 cluster、canonical anchor、重复理由和相对 priority；不改 severity、verify 门、Fact 状态或报告收敛。Research 写失败必须显式记录，savepoint 不能回滚主 Finding/Report 写入。
- Task/Finding Report 是冻结输入后的 Projection；相同输入幂等，输入变化追加版本；Projection 失败不能改写内部事实。

### Job、Attempt 与恢复

Job 状态由 Scheduler 判定：

```text
pending → claimed → provisioning → running
                         ├→ waiting_human → pending
                         └→ succeeded / failed / timeout / cancelled / orphan
```

每个 Job 领取创建 Scheduler-owned Attempt。外部效果先写 `job_attempt_effects` 的 `effect_pending`，之后写 settlement；`unknown` 或 `replay_policy=never` 不得自动重放。启动 reconcile 只有在“尚未开始且无效果”的准备阶段才可回到 pending；未知效果进入 orphan/对账路径。Lease、Reaper、取消、超时、迟到回调和容器清理必须幂等。

### 配置、运行时和快照

覆盖优先级固定为 **Job > 角色/项目 > 平台 > env 引导**。Job 只认创建期 `agent_snapshot_json`，Dispatcher 不在运行时回退最新 RoleConfig。快照冻结 CLI、Provider/model、运行时镜像 digest、工具清单、能力 selector/digest、Finding protocol、网络和 runtime knobs。

当前新 Job 的治理 CLI 为 Claude Code、Pi、DSH；历史 Codex/OpenCode 只读归档不能作为新运行时默认。新增 CLI 必须同时实现 runtime adapter、Session archive adapter、Web viewer parser、测试和原始归档下载。

镜像必须来自准入市场；第三方镜像先由 `apps/image-admission` 扫描、批准、启用并以不可变 digest 执行。Agent/Hub/任务内容不能提交任意 OCI 地址。真实模型请求经 Scheduler-owned Model Gateway，长期密钥不进入快照、沙箱或 evidence。

## 数据库与迁移纪律

- `database/schema.sql` 是唯一 schema 基线；`apps/scheduler/src/schema-version.ts` 必须与之同步（当前主线 v48）。
- 空库启动时套用基线；非空库版本或结构不匹配时 fail closed。没有增量 ALTER 链。
- 改表只能修改 schema 基线、bump `SCHEMA_VERSION`，再运行 `pnpm db:rebuild -- --plan` / `--apply` 并验证备份和列交集回填。
- 稳定状态、幂等键、外键和权限骨架进定列；开放内容进 JSONB。类型字段使用字符串，不用 Postgres enum 锁死演进。
- `events` 只保存语义事件；原始运行流进 evidence 冷存储；`stream-bus` 只作非权威实时投递。
- API Token、Job token、Provider secret、Session artifact 和 `.deepsonarpack` 导入导出必须遵守各自的脱敏、权限和 provenance 规则。

## Web 与交互事实

前端是 React 19、`@xyflow/react`、elkjs、Tailwind 4。任务工作台固定提供总览、研究地图、事实证据、任务发现、任务运行和报告六个一级视图；URL 的 `tab` 是当前视图真相，后台刷新不能强制切换。

Canvas 只读，节点坐标由服务端布局生成。Finding 详情按 Issue 风格展示 disposition、评论、验证追踪和证据链。Job 详情展示 Attempt、Session、过程流、工具调用、广播账本、人工消息和用量。`injected` 只表示写入 Agent 输入，不代表模型已读；ACK 必须来自显式受治理 operation。

## 开发与变更检查清单

提交实现前：

1. 先确认 DESIGN、ARCHITECTURE、schema、OpenAPI 和现有测试的事实；
2. 复用已有领域、shared-types、runtime sandbox 和成熟依赖；
3. 设计权限、项目 scope、快照、幂等、失败反馈和未知效果路径；
4. 若涉及结构性边界，更新 DESIGN、专题文档和状态表；
5. 为合法、非法、重复、冲突、超时、取消、重启和跨项目输入补测试。

提交验证后：

- `git diff --check`；
- 与改动面匹配的 `ci:unit:*` / `ci:integration:*` / `ci:smoke:*`；
- 运行时/镜像改动执行 `pnpm ci:images` 和相应 sandbox smoke；
- UI 改动执行对应 Web tests，并核对 URL、空态、错误态、刷新和权限边界；
- 文档中的路径、命令、schema 版本、状态和链接重新检查。

## 工程原则

1. 删除优先，避免无需求的抽象、状态、配置、依赖和兼容层。
2. 先跑通最小端到端闭环，再按真实瓶颈扩展。
3. 领域边界清楚；入口只组装，领域模块负责规则，基础设施负责外部效果。
4. 优先成熟开源协议和产品；引入依赖前检查维护、许可证、安全记录、生态和可替换性。
5. 设计长期稳定的所有权、安全和副作用边界，局部实现保持可删除、可替换。
6. 参考用户已理解的成熟交互和运维模式，不凭空创造第二套术语或工作流。
7. Windows 下避免 PowerShell 破坏 `node -e` 模板字符串；临时检查脚本放在仓库临时文件并在任务结束清理。
8. 不在代码、测试或文档示例中写死真实凭据、长期 Token、个人域名、中转地址或可变 `latest`；可运行 URL 夹具使用 `127.0.0.1`、RFC1918 或 Docker 内部主机名。
