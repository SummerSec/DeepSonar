# AGENTS.md

本文件是 DeepSonar 仓库内编码 Agent 的工作说明。它描述协作方式、事实入口和不可绕过的工程边界；实现事实以代码、`database/schema.sql`、OpenAPI 和测试为准；若实现违反已采纳约束，记录缺陷，不通过修改规范消除违约。

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
2. [`docs/architecture/README.md`](docs/architecture/README.md)：系统规格、追溯矩阵、架构视图与 ADR；按改动面读取权威正文；
3. [`docs/README.md`](docs/README.md)：专题文档的 as-built / 历史 / 进行中状态；
4. [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期 AI-native 可信内核、插件准入、RepairFeedback、Receipt 和 Crash Matrix；
5. 代码、`database/schema.sql`、OpenAPI 和测试。

历史 `*_PLAN.md`、旧 Issue 或角色名称都不能单独证明能力尚未落地。改完结构性设计或安全边界，必须同步更新 `DESIGN.md`、相关专题文档和状态索引。`CLAUDE.md` 应与本文件保持同步。

## 系统功能变更文档同步（#741）

涉及系统功能、领域规则、Control/Management API、数据库、状态机、运行时/镜像、安全权限或删除旧契约时，必须读取并执行仓库内[文档同步与检查 Skill](.agents/skills/architecture-doc-sync/SKILL.md)。它是开发治理 Skill，不是 Job 运行时业务能力。

同一 PR 核对受影响需求 ID、追溯矩阵、对应架构视图、专题文档及 DESIGN/文档索引；重大取舍新增 ADR 或标记旧 ADR 被取代。提交摘要记录“变更面 → 文档/需求 → 验证结果”；核查后确实无需更新文档时，写明范围和理由，不机械刷新日期。规范要求、实现状态、运行证据分开；未执行的测试不能写成已通过。

每个主题的权威正文及旧章节迁移状态见[归属表](docs/architecture/README.md)。旧 `docs/ARCHITECTURE.md` 保留作历史对照，不能单独作为现行实现依据。`CLAUDE.md` 是指向本文件的 Git 符号链接；Windows 禁用符号链接时检出为目标路径文本，不另维护副本。

## 平台任务下发必须加载 Skill（#767）

创建、拆分或重新下发 DeepSonar 平台任务前，必须加载并执行 [deepsonar-management](skills/deepsonar-management/SKILL.md)，按其中指向的任务下发流程完成整理与复核。详细规则只在该 Skill 维护，不在本文件复制。普通仓库代码修改、代码评审和编码子任务委派不属于平台任务下发，不因此套用业务任务模板。

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
pnpm ci:unit:searchable-selects     # gate 守则：Web 下拉必须用可搜索选择原语
pnpm ci:unit:file-size              # gate 守则：文件体量棘轮（max-lines）
pnpm ci:unit:docs-freshness         # gate 守则：文档保鲜（版本字面量 / pnpm 脚本 / 链接 / 已删机制）
pnpm ci:integration:finding-research
pnpm ci:integration:platform-api
pnpm ci:smoke:control-api
pnpm ci:smoke:hub
pnpm ci:images
```

`gate` 里的守则套件分散在多个脚本（如 `ci:unit:searchable-selects` 禁止原生 `<select>`、`ci:unit:file-size` 文件体量棘轮、`ci:unit:bounded-contexts` 固定路由面与 bounded-context 所有权、`ci:unit:docs-freshness` 文档保鲜），`ci:unit:web-facts` 覆盖不到：Web 或路由面改动要按需补跑，否则 CI 才第一次报错。`ci:unit:authz` 内的 `ci-test-hook.test.ts` 保证每个被跟踪的 `*.test.ts` 都有测试入口引用（未接线的进 `apps/scheduler/src/ci-test-hook.manifest.json` 基线，只能缩小），但**脚本本身是否被 workflow 调用仍需人工确认**：全量脚本见根目录 `package.json`，已进 CI 的以 `.github/workflows/ci.yml` 为准（`ci:unit:bounded-contexts` 自 #684 起已进 CI；`ci:unit:file-size` 自 2026-10-31 起在 gate 中显式执行，此前仅通过 `ci:unit:authz` 的文件列表间接运行，调整该列表会让棘轮静默失效）。测试数据库需要 `TEST_DATABASE_URL`；只依赖真实沙箱的测试要明确检查运行时是否可用。镜像改动还要检查 Dockerfile、`.dockerignore`、runtime registry fingerprint、平台架构和体积预算。

## 总体架构纪律

DeepSonar 是“最小可信执行内核 + 可组合能力”：

> PostgreSQL 是管理真相，Canvas 是过程真相，Sandbox/Evidence 是执行真相，Scheduler 是唯一有副作用的执行者。

Hub 与 Agent 的上下文采用按需读取模型：启动输入只提供任务目标和有界画布骨架；小图可以提供完整的小投影，大图必须由 Hub 通过当前 Job 的有界只读 `graph_query` 自主读取索引、节点、边或证据。平台只负责 Job scope、查询预算、脱敏、审计和已见引用校验，不把整张画布或业务能力目录默认塞进模型上下文。

### 核心可插拔原则

DeepSonar 的能力、Skill、工具和运行时组件都应保持可插拔。平台负责准入、沙箱、网络、凭据、预算、审计、幂等和结果记账等工程控制；在这些边界以内，Agent 自主发现、选择、拉取、加载和组合所需能力。不要把业务 Skill 或 Pi 等 CLI 的扩展插件选择塞进 RoleConfig；角色通过 Capability/Pack 组合声明所需能力，平台准入并在 Job 快照中冻结解析结果。也不要用固定角色分支替代 Agent 的能力选择。Agent 的自主拉取必须通过受治理的 Job-scoped 操作完成，不能扩大 Job 范围，也不能通过任意安装脚本绕过平台控制。

### 不向后兼容

所有设计以当前目标契约为唯一受支持形态，不为旧版本或旧设计保留向后兼容。废弃契约应直接从 schema、API、UI 和运行时移除，不保留双读双写、fallback、shim、legacy 模式、旧配置转换或兼容窗口。旧配置不符合新契约时必须 fail closed，并要求按新契约重新配置；不得自动迁移旧配置以延续旧语义，也不得静默沿用旧行为。

这条规则不要求改写已创建 Job 的冻结快照、Evidence、审计记录或历史结果；这些是不可变历史真相，不是新运行时的兼容输入。已有代码仍读取旧契约时，应如实标注为待删除的实现债务，不能据此把它视为受支持设计。Provider 账号到 RoleConfig 的 `role_credentials` 绑定与 `RoleConfig.pi_extensions` 已按 #690 删除；Pi 扩展归入角色能力组合 / Hub `pi_extension_ids`。

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

当前已落地的 Agent 自主 Skill 拉取 operation：

- `list_available_skills`
- `search_skills`
- `pull_skill`

目录只用于选择入口；实际授权由对应的 Job-scoped 操作完成。Scheduler 必须用当前 Job 的 operation allowlist、平台 trusted+enabled 源、镜像兼容性和网络策略重新校验。Pack 不能扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。Agent 可在 Job 内自主调用 `list_available_skills` / `search_skills`，再用本轮返回的 selector 与 content hash 调用 `pull_skill` 拉取业务 Skill；拉取结果不能改变 Job 快照的权限边界。

任务级/会话级 Pack 生命周期、评估晋升和跨任务经验推荐属于后续阶段，不能在实现或文档中冒充 as-built。

### Agent 只提案

真实 Job 注入不可由 RoleConfig 同名覆盖的 `deepsonar-control` Skill。Agent 使用短期 Job capability token，通过 Job 级 HTTP API 提交 `emit_progress`、`emit_fact`、`emit_finding`、`submit_hub_decision`、`mark_job_done`、`request_human`、能力发现和 Skill 拉取等 operation。Agent 可以在范围内自主选择并拉取业务 Skill；语义事件不得来自普通文本、CLI 输出、伪造 MCP tool call、Shell 控制文件或管理 API 猜测；失败不得回退到另一套控制通道。

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

- `database/schema.sql` 是唯一 schema 基线；`apps/scheduler/src/schema-version.ts` 必须与之同步（当前集成编号以源码为准，不代表已发布版本）。

- 空库启动时套用基线；非空库版本或结构不匹配时 fail closed。没有增量 ALTER 链。
- 改表只能修改 schema 基线、bump `SCHEMA_VERSION`，再运行 `pnpm db:rebuild -- --plan` / `--apply` 并验证备份和列交集回填。
- 稳定状态、幂等键、外键和权限骨架进定列；开放内容进 JSONB。类型字段使用字符串，不用 Postgres enum 锁死演进。
- `events` 只保存语义事件；原始运行流进 evidence 冷存储；`stream-bus` 只作非权威实时投递。过程流补读只认可见 `BLOB_DIR`；跨副本无共享卷时 `visibility=unavailable` / WS `4415`（#388）。
- API Token、Job token、Provider secret、Session artifact 和 `.deepsonarpack` 导入导出必须遵守各自的脱敏、权限和 provenance 规则。

## Web 与交互事实

前端是 React 19、`@xyflow/react`、elkjs、Tailwind 4。任务工作台固定提供总览、研究地图、事实证据、任务发现、任务运行和报告六个一级视图；URL 的 `tab` 是当前视图真相，后台刷新不能强制切换。

Canvas 只读，Web 对当前可见投影使用 elkjs 布局，超阈值或失败时采用固定列布局；服务端 `x/y` 只作 placement/exchange hint，全图服务端权威布局按 #148 暂缓。Finding 详情按 Issue 风格展示 disposition、评论、验证追踪和证据链。Job 详情展示 Attempt、Session、过程流、工具调用、广播账本、人工消息和用量。`injected` 只表示写入 Agent 输入，不代表模型已读；ACK 必须来自显式受治理 operation。

## 开发与变更检查清单

提交实现前：

1. 先确认 DESIGN、docs/architecture 归属表与相关视图、schema、OpenAPI 和现有测试的事实；
2. 复用已有领域、shared-types、runtime sandbox 和成熟依赖；
3. 设计权限、项目 scope、快照、幂等、失败反馈和未知效果路径；
4. 若涉及结构性边界，更新 DESIGN、专题文档和状态表；
5. 为合法、非法、重复、冲突、超时、取消、重启和跨项目输入补测试。

提交验证后：

- `git diff --check`；
- 与改动面匹配的 `ci:unit:*` / `ci:integration:*` / `ci:smoke:*`（Web 改动补 `ci:unit:searchable-selects` 等 gate 守则套件）；
- 运行时/镜像改动执行 `pnpm ci:images` 和相应 sandbox smoke；
- UI 改动执行对应 Web tests，并核对 URL、空态、错误态、刷新和权限边界；
- 文档中的路径、命令、schema 版本、状态和链接重新检查。

## 发布前的文档保鲜（发版硬门）

**每次改 `CHANGELOG.md`、打 `v*` tag、建 release 之前，必须先做一轮文档保鲜。** 未通过不得发版；发现的漂移修在同一个 release 分支里，不留给下一个版本。同一条硬门也写在 `DESIGN.md` §13 与 `docs/architecture/11-engineering-specs.md`；旧 `docs/ARCHITECTURE.md` §17.5 仅作历史对照。

检查范围（每版必做，不能因为“本版没动文档”跳过）：

1. **版本字面量**：`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` 与本文件、`DESIGN.md`、`docs/**` 里写的主线数字一致；产品发布版本以不可变 `vX.Y.Z` Git tag 为唯一来源，须与 `CHANGELOG.md` 对应标题和 compare link 一致；根目录及第一方 workspace 的私有 `package.json` 版本仅是内部元数据，不参与发布版本解析，也不因平台发版而 bump（见 `docs/RELEASE_RUNTIME_IMAGES.md`）。
2. **本版删掉/收敛的机制**：代码注释、OpenAPI 描述串、`docs/**`、`skills/**` 全部搜一遍，命中只能是「已移除 / 物理清扫」这类解释性出现（规则自身与 `CHANGELOG.md` 历史条目除外）：
   ```bash
   rg -n "project_managed|image_strategy|role_runtime_images|项目镜像策略" \
     AGENTS.md DESIGN.md docs skills apps/scheduler/src/openapi.ts
   ```
3. **as-built 与代码相反**：本版触及的机制逐条核 `DESIGN.md`、`docs/architecture/README.md` 归属表指定的视图与专题；描述错误时回写文档，实现违反已采纳约束时登记缺陷，不通过修改规范掩盖违约。
4. **状态索引**：`docs/README.md` 的同步状态与日期、专题文档文首状态行、新增/收口的 issue 表。
5. **命令、路径与链接**：文档里引用的 `pnpm` 脚本、文件路径、schema 版本、交叉链接逐条验证存在（参考：把所有 `pnpm <script>` 与 `package.json` 对账）。

其中 1 的版本字面量、5 的命令与链接、以及 2 的已删机制残留已由 `pnpm ci:unit:docs-freshness` 机检并在 CI 中阻断；**第 3 项（as-built 与代码相反）无法自动化**，必须人工逐条核——这正是本条硬门不能省的理由。

为什么写死成硬门：`docs/PROJECT_REVIEW_2026-08.md` 早就建议加「文档表征测试」断言 schema 版本字面量一致，而该断言一直没落地，于是 v0.4.x 期间本文件与 `DESIGN.md` 的版本号真实漂移了两代，另有一批按已删机制写的段落（PR #696 修正）。**现已落地为 `pnpm ci:unit:docs-freshness`**（版本字面量、文档里的 `pnpm` 脚本存在性、相对链接、已删机制残留），已挂进 CI；但机检覆盖不到语义——「as-built 段落是否与代码相反」仍需人工按上面第 3 项逐条核。

### 失败发布恢复：经授权删除并重建同名 Git tag

仅适用于**尚未成功正式发布**的失败版本，且必须先取得用户对该版本删除并重建 Git tag 的明确授权。已正式发布的版本保持不可变，不得以恢复为名移动 tag。此流程不豁免上面的文档保鲜与 [`docs/RELEASE_RUNTIME_IMAGES.md`](docs/RELEASE_RUNTIME_IMAGES.md) 的发布硬门。

1. **先核对并留证**：检查现有 GitHub Release、registry 各通道的版本标签 / digest、descriptor / catalog，以及运行中或排队的发布任务。保存旧 tag 的对象 SHA、解引用 commit SHA、失败 run 链接及已产出镜像证据，供审计和必要的恢复使用；不能只凭某个 job 失败就认定整个版本从未正式发布，也不能在并行发布未协调时删 tag。
2. **修复先合主线，再确认恢复版本**：相关修复必须走正常 review / merge；删除和重建前重新 `git fetch origin main`，解析 `origin/main` 的最新 commit，并核对所需修复确已包含。目标 tag、`CHANGELOG.md` 对应版本 / compare link 和发布文档必须一致；若最新 main 已准备另一个版本、已有更高版本 tag，或新版本发布正在进行，先停下协调恢复版本，不能机械地把旧版本 tag 指向版本不匹配的提交，也不能降级 changelog 门禁。
3. **在最终 SHA 上验收**：完成文档保鲜、实际 changelog 校验、该 SHA 的核心 CI 和适用的原生 `linux/amd64` / `linux/arm64` 与真实 Job 验收。纯文档合并若未触发 `push@main` CI，按发布文档手动触发并核对 SHA。发布复制的单次 timeout、重试次数、退避、各通道串行耗时和 workflow job 的总预算须一起核对；增加重试不能代替足够的总预算，未有日志证据不能把 HTTP/2 等猜测写成已证实根因。
4. **重建必须指向最新已核验 main**：前置条件满足后才删除远端及本地旧 tag，并确认远端已删除；重建前再次 fetch / 核对 main。若 main 已推进，回到前两步完成版本与新 SHA 验收，不能沿用旧发布 SHA 或先前记下的固定 SHA。可创建 annotated tag，但必须显式以此时最新、已验收的 main commit 为目标；推送后核对远端 tag 解引用 SHA。回退旧 tag 也会产生外部效果，不得静默执行。
5. **启动新运行并核对源码**：推送 `v*` tag 会触发 `.github/workflows/release.yml`；检查新 run 的 `head_sha`、实际 checkout SHA 和 tag 解引用 SHA 均等于目标提交。直接 rerun 旧 run 仍使用原运行的 ref / SHA，不能据此宣称已应用 main 上的新脚本。
6. **Git tag 与镜像分开处理**：删除 Git tag 不会删除 GHCR / ACR / Docker Hub 镜像，不能默认清空 registry。Reverse 已有 index / payload 必须与本轮原生验收的两个 runnable manifest 完全匹配；匹配时保留原 index bytes / digest，仅补缺失通道。payload 不匹配或既有目的地 index digest 冲突时必须 fail closed，协调新的版本，不能强制覆盖已有不可变镜像来掩盖差异。
7. **以完整发布闭环收口**：新 Release workflow 必须实际成功，取得真实 `reverse.json`、所有配置通道的 descriptor / inspect 证据，通过最终 catalog 的双平台 payload 门禁，完成 catalog 与部署 tag 回写以及正式 GitHub Release / 附件。tag 存在、CI 通过或部分镜像推送成功都不等于发布完成；未完成项必须如实保留为阻塞。

## 工程原则

1. 删除优先，避免无需求的抽象、状态、配置、依赖和兼容层。
2. 先跑通最小端到端闭环，再按真实瓶颈扩展。
3. 领域边界清楚；入口只组装，领域模块负责规则，基础设施负责外部效果。
4. 优先成熟开源协议和产品；引入依赖前检查维护、许可证、安全记录、生态和可替换性。
5. 设计长期稳定的所有权、安全和副作用边界，局部实现保持可删除、可替换。
6. 参考用户已理解的成熟交互和运维模式，不凭空创造第二套术语或工作流。
7. Windows 下避免 PowerShell 破坏 `node -e` 模板字符串；临时检查脚本放在仓库临时文件并在任务结束清理。
8. 不在代码、测试或文档示例中写死真实凭据、长期 Token、个人域名、中转地址或可变 `latest`；可运行 URL 夹具使用 `127.0.0.1`、RFC1918 或 Docker 内部主机名。
