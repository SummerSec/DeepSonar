# AGENTS.md

本文件是 DeepSonar 仓库内编码 Agent 的操作手册：明确事实入口、协作边界、CI 门禁、工程纪律与不可绕过的安全约束。实现事实以代码、[`database/schema.sql`](database/schema.sql)、OpenAPI 和测试为准；**实现违反已采纳规范时必须登记缺陷，不得修改规范迎合 bug**。

> `CLAUDE.md` 是指向本文件的 Git 符号链接（Windows 禁用符号链接时检出为目标路径文本，不另维护副本）。

---

## 快速导航（不可绕过红线）

| 主题 | 核心要求 | 事实入口 |
| --- | --- | --- |
| 注意力与无人值守 | 在既有授权内先核实并完成；少打扰不靠隐瞒失败、扩权或降门 | [设计原则](#开发与设计依据) · [`DESIGN.md`](DESIGN.md#核心理念优化人的注意力) |
| Superagent 协作 | 单账号 `SummerSec` + `/sumbot` 指令 + 披露与防回环标记 + 独立 worktree | [Superagent 规则](#superagent-单账号协作规则sumbot) |
| 分支命名（#931） | 仅允许 `feat/`、`fix/`、`docs/`、`refactor/`、`test/`、`chore/`；禁 AI 工具前缀 | [`branch-name-policy.mjs`](agent-harness/branch-name-policy.mjs) |
| 文档同步（#741） | 功能/契约/Schema/安全变更必须执行文档同步 Skill | [`architecture-doc-sync`](.agents/skills/architecture-doc-sync/SKILL.md) |
| 平台任务下发（#767） | 创建/拆分/重派 DeepSonar 平台任务必须加载管理 Skill | [`deepsonar-management`](skills/deepsonar-management/SKILL.md) |
| CI 与验收 | 开发按需跑定向测试；合并前必须确认最终 SHA `ci-summary` 与适用专项全绿 | [CI gate](#ci-gate何时触发何时必须等) · [验收边界](#验收边界不要求生产测试部署2026-10-31) |
| 架构与安全底线 | 模型只提案、内核拥有副作用、不向后兼容、未知外部效果禁止自动重放 | [架构与运行时纪律](#架构与运行时纪律) · [`DESIGN.md`](DESIGN.md) |
| 发版硬门 | 改 `CHANGELOG.md` / 打 `v*` tag 前必须通过文档保鲜；正式 tag 不可变 | [发布前文档保鲜](#发布前的文档保鲜发版硬门) |

---

## 设计事实入口

改动前按顺序核对：

1. [`DESIGN.md`](DESIGN.md)：当前 as-built 执行摘要、四层真相、核心实体、能力模型、运行时与安全硬门；
2. [`docs/architecture/README.md`](docs/architecture/README.md)：编号规格、追溯矩阵、十二视图、ADR 索引与章节归属表（按改动面读取权威正文；旧 `docs/ARCHITECTURE.md` 仅作历史对照）；
3. [`docs/README.md`](docs/README.md)：专题文档的 as-built / 进行中 / 历史状态索引；
4. [`docs/AI_NATIVE_TRUSTED_KERNEL.md`](docs/AI_NATIVE_TRUSTED_KERNEL.md)：长期 AI-native 可信内核、插件准入、RepairFeedback、Receipt 与 Crash Matrix；
5. 代码、[`database/schema.sql`](database/schema.sql)、[`apps/scheduler/src/openapi.ts`](apps/scheduler/src/openapi.ts) 和测试。

历史 `*_PLAN.md`、旧 Issue 或静态角色名称都不能单独证明能力尚未落地。改完结构性设计或安全边界，必须同步更新 `DESIGN.md`、对应架构视图、专题文档与状态索引。

---

## 开发与设计依据

- **注意力原则**：需求、架构、交互与代码评审统一遵守 [DESIGN 的注意力原则](DESIGN.md#核心理念优化人的注意力)。既有授权内能自行核实或完成的事项先自行处理；必须询问时说明缺失输入、影响及具体决定，不重复索取仍有效的授权，也不隐瞒失败或扩大权限。新增界面、通知、配置、工作流和自动化行为按[工程评审问题与示例](docs/architecture/11-engineering-specs.md#11-注意力成本评审830)说明注意力成本；纯内部修改不强制增加表格。
- **无人值守目标（#1182）**：设计常规只读检查、项目维护等已授权流程时，不把人工回复或确认按钮设为正常路径依赖；能从已授权信息得出可靠结论的，由系统完成并交付结果。缺少不可替代输入、必要授权或可核实证据时，保留已完成结果并明确结束为未完成/受阻：不无限等人、不把沉默当同意、不跳过安全门、不把停止报成成功；保留确需人工决策的独立授权与恢复通道。此项是设计与评审原则，不是运行时授权——不放宽仓库评审、合并、发布、生产部署、权限、凭据或高风险操作规则，不扩展到自动化攻防操作。
- **系统功能变更文档同步（#741）**：涉及系统功能、领域规则、Control/Management API、数据库、状态机、运行时/镜像、安全权限或删除旧契约时，必须读取并执行 [文档同步与检查 Skill](.agents/skills/architecture-doc-sync/SKILL.md)（开发治理 Skill，非 Job 运行时业务能力）。同一 PR 核对受影响需求 ID、追溯矩阵、对应视图、专题文档及索引；重大取舍新增 ADR 或标记旧 ADR 被取代。交付摘要记录「变更面 → 文档/需求 → 验证结果」；确无需更新时写明范围和理由，不机械刷新日期。
- **平台任务下发 Skill（#767）**：创建、拆分或重新下发 DeepSonar 平台任务前，必须加载并执行 [deepsonar-management](skills/deepsonar-management/SKILL.md)。普通仓库代码修改、代码评审和编码子任务委派不属于平台任务下发。

---

## Superagent 单账号协作规则（`/sumbot`）

> 适用于 dsh-superagent 在 `SummerSec/DeepSonar` 上的仓库开发协作（配置核对基线：2026-10-31），不是 DeepSonar 平台 Job 运行时协议。实际授权以宿主配置、GitHub 发送者元数据及允许名单为准，本文件不授予执行权限。

### 请求与授权

- **单账号**：`SummerSec` 既是运行账号，也是唯一允许发起工作的请求者。`/sumbot` 是自定义指令，不使用 `@sumbot`，不另行注册/登录/切换账号。
- **指令匹配**：新 Issue、PR 正文或新评论的首个非空白位置必须是 `/sumbot`（后接空白或正文结束，不区分大小写）。正文中间、引用块、代码块以及 `/sumbot-other`、`/sumbot:` 均不触发；新增或补充任务继续使用此前缀，不依赖重放历史正文。
- **发现与边界**：依赖仓库扫描而非提及通知；正文署名、自称管理员或转述不改变真实发送者身份。主动候选模式保持 `observe`（只观察，不自动接单），全量观察开关保持关闭。

### 自动输出与防回环

- 所有自动 GitHub 评论及 PR 正文的**首个可见段落**必须明确披露：内容由 dsh-superagent 自动生成，使用 `SummerSec` 账号，不得冒充用户本人。
- 宿主消息含 `<!-- dsh-superagent:<message-id> -->`（编辑时必须保留）；Worker 直接用 `gh` 发帖或编辑时，必须加入并保留 `<!-- dsh-superagent:worker -->`（含失败说明与总结）。
- 自动正文不得以 `/sumbot` 开头；复述用户指令须放在身份说明之后的引用或代码块中。含上述标记的正文不会触发新 `/sumbot` 指令，不得删标记以重新触发。

```markdown
本消息由 dsh-superagent 自动生成，使用 SummerSec 账号。

已完成修复；验证结果与 PR 链接如下。

<!-- dsh-superagent:worker -->
```

### 开发与交付

- **身份与隔离**：使用宿主提供的 `gh` 维持 `SummerSec` 身份；Git commit 作者与提交者均使用 `SummerSec <SummerSec@users.noreply.github.com>`，不修改全局 Git 身份配置。在独立 worktree 中开发，不污染共享主线，不直推 `main` 绕过 PR。
- **分支命名（#931）**：
  - 推荐前缀：`feat/`、`fix/`、`docs/`、`refactor/`、`test/`、`chore/`（带 Issue 可写 `fix/123-short-topic`）。
  - 禁止以 AI / Agent 工具名开头（不区分大小写，含 `/`、`-`、`_` 与嵌套路径）：`agent`、`codex`、`cursor`、`claude`、`copilot`、`chatgpt`、`gemini`、`openai`。
  - 唯一校验实现见 [`agent-harness/branch-name-policy.mjs`](agent-harness/branch-name-policy.mjs)（`pnpm ci:unit:ci-routing` 覆盖回归），服务端由 GitHub [Block AI tool branch prefixes](https://github.com/SummerSec/DeepSonar/rules/20986002) ruleset 拦截。推送前可自检：
    ```bash
    node -e "import('./agent-harness/branch-name-policy.mjs').then(m=>m.assertBranchName(process.argv[1]))" <branchname>
    ```
- **合并条件**：仅当 PR 非 Draft、最终 head SHA 的 `ci-summary` 与全部适用专项全绿、评审通过且无阻塞意见、且**非重大功能变更**（不涉及 API/schema 契约增删、安全与权限边界、运行时/镜像准入、发布流程、跨模块重构）时，主 Agent 可自主合并（bug 修复优先）；否则由用户人工合并。严禁无人值守 `--auto`、自动批准 PR、直推 `main` 或降级 ruleset / required check；合并须绑定全绿 head SHA 并留存 merged 证据。
- **如实交付**：摘要必须区分已通过、失败和未执行的验证；无真实端到端证据时不宣称已实测；生产部署、发版及不可逆外部操作需各自明确授权。

---

## CI gate：何时触发，何时必须等

**开发不必逐个 commit 等全量 CI；合并或宣告工程验收通过前，必须核对最新合并候选的最终 SHA。**

### 触发与等待规则（以 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 为准）

| 操作 | 当前行为 |
| --- | --- |
| 本地 `git commit`；推到未开 PR 的普通分支 | 不触发核心 `ci`。本地按改动面做定向验证，集中推送。 |
| 打开/重开 PR、推送新提交、Draft ↔ Ready | 触发 `ci`（按整个 PR 分类，文档保鲜每轮必跑）。`CI_PR_MODE=tiered`（2026-11-03 核对已启用）时 Draft 代码 PR 跑 `draft-fast`，转 Ready 同一 SHA 自动跑完整验收，无需空 commit；非 `tiered` 或 `full` 时恢复完整 PR 验收。仅纯安全文档白名单跳过重型 `gate`。 |
| 合并/推送 `main`；手动 `workflow_dispatch` | 跑完整核心 CI（非快检）；手动运行仅用于排障或补缺，不与同 SHA 在途运行重复。 |

**等待规则**：CI 排队或运行时，记录 PR、SHA、运行链接和未完成项即可继续其他工作或交接；**不轮询、不推空提交、不要求用户在线等候**。失败先看失败步骤再集中修复；旧提交绿灯、必跑项缺失、失败或取消均不构成通过依据。

### PR 的 Draft / Ready 分层（#836）与核心架构

统一分类器 [`agent-harness/ci-run-plan.mjs`](agent-harness/ci-run-plan.mjs)（`CI_PR_MODE=tiered` 生效，无 `off`/`skip-all`；出现漏测或错配时先将 `CI_PR_MODE` 切回 `full` 再修路由）：

| 模式 | 触发条件 | 执行内容 |
| --- | --- | --- |
| `docs` | 纯文档白名单 | 文档保鲜 + 路由回归，跳过重型门禁 |
| `draft-fast` | Draft 代码 PR | frozen install、typecheck、路径映射无服务单测；发非 required 的 `ci-preview`（注意 GitHub 视 `skipped` 的 required check 为通过，禁靠跳过挡 Draft 合并） |
| `ready-full` | Ready PR、`push@main`、手动运行 | 完整核心与适用专项，发稳定 required check `ci-summary`（`main` ruleset 要求；无 merge queue，勿加死 `merge_group` 配置） |

**分片、专项与镜像缓存边界（#961 / #972 / #975 / #976 / #992 / #995）**：

- **五片有界并行 `gate`**：`gate-contract`、`gate-runtime`（两片无 PostgreSQL）、`gate-db-core`、`gate-db-domain`（各自独立 PG）、`gate-e2e`（3100/3101 与 setval 竞态同片）。套件归属唯一权威见 [`agent-harness/gate-shards.mjs`](agent-harness/gate-shards.mjs)（`gate-shards.test.mjs` 断言零遗漏零重复）；`ci-summary` 按 `EXPECTED_GATE_SHARDS` 逐片要求 `success`。新增 #971–#974 类纯 Node 契约回归须同步加入 `docs-freshness` job 的契约回归 step。
- **Chrome Fuzz ARM 与 V8 Builder（#961）**：tiered Ready PR 仅当全部改动属于已核对非镜像业务输入或文档白名单时跳过 Chrome ARM build/smoke，未知路径/空 diff/分析失败保守必跑，`ci-summary` 校验计划与结果一致。`deploy/Dockerfile.agent-chrome-fuzz` 的 V8 编译阶段使用 digest 钉死的 `V8_BUILDER_IMAGE`，勿改可变 tag。
- **构建缓存命名空间隔离（#961 P3）**：`image-build-fingerprint.mjs` 输出 `ci_src_tag`（`src-ci-<fp>`，仅 CI 读写）与 `release_src_tag`（`src-release-<fp>`，仅 release 读写）；`release.yml` 严禁查旧 `src-<fp>`（改动须同步 `agent-harness/image-cache-trust.test.mjs`）。
- **四个专家工作流（Reverse / Chrome / Mobile / OpenHarmony）**：共用 `ci-run-plan.mjs`，仅 `mode == ready-full` 启动重活矩阵；`ci-summary` 不跨工作流聚合，合并前须逐项核对适用专项。Reverse 由 [`agent-harness/reverse-suite-plan.mjs`](agent-harness/reverse-suite-plan.mjs) 分流 `reverse`/`claude`/`pi-om` 及 shared/routing 保守输入（`package.json` 仅对「新增且不被专项消费的 `ci:unit:*` `--test` 脚本」判无影响；路由与输入覆盖由 `reverse-suite-plan.test.mjs` 守卫）。`vars.REVERSE_BASE_REUSE=on` 时才启用同 SHA base artifact 复用（默认关闭）。
- **成本观测（#992）**：[`agent-harness/ci-run-cost.mjs`](agent-harness/ci-run-cost.mjs) 仅作只读观测，不替代结果检查；GitHub 原生重跑会给保留结果生成新 ID，需对比 attempt 时间/步骤而非按 ID 推算。验收证据见 [`docs/CI_COST_ACCEPTANCE_992.md`](docs/CI_COST_ACCEPTANCE_992.md)。修改分类器/汇总/路由本身属高风险改动，须独立评审与完整验收。

---

## 常用命令与定向测试

`.env` 位于仓库根目录由 Scheduler 加载。`AGENT_MODE=fake` 用于无模型凭据状态机联调；`AGENT_MODE=real` 使用 OpenSandbox。生产 Compose 由 `deploy/deploy.sh` / `deploy/deploy.ps1` 管理并默认拉取不可变镜像。

```bash
# 本地运行与数据库
pnpm db:up                      # 与 db:up:deploy 互斥
pnpm db:up:deploy
pnpm db:rebuild -- --plan
pnpm db:rebuild -- --apply
pnpm dev                        # Scheduler: http://127.0.0.1:3100
pnpm dev:web                    # Web: http://127.0.0.1:5173
pnpm build && pnpm typecheck
```

按改动面选择定向测试（**禁止以 `typecheck` 替代行为测试**；集成测试需 `TEST_DATABASE_URL`，真实沙箱测试须检查运行时可用性；镜像改动还需核查 Dockerfile、`.dockerignore`、fingerprint、平台架构与体积预算）：

```bash
# 常见门禁守则（Web / 路由 / 文档改动极易在此处首次报错）
pnpm ci:unit:docs-freshness     # 文档保鲜：schema 版本 / pnpm 脚本 / 相对链接 / 已删机制 / 架构索引
pnpm ci:unit:ci-routing         # CI 路由分类器 + 分支命名策略回归
pnpm ci:unit:searchable-selects # Web 禁止原生 <select>
pnpm ci:unit:file-size          # 文件体量棘轮（max-lines）
pnpm ci:unit:bounded-contexts   # 路由面与 bounded-context 所有权
pnpm ci:unit:authz              # 含 ci-test-hook.test.ts（确保 *.test.ts 已接线，基线只能缩小）

# 典型领域 / 集成 / 冒烟 / 镜像套件（全量脚本见 package.json，CI 接线以 ci.yml 为准）
pnpm ci:unit:capability-pack
pnpm ci:unit:finding-research
pnpm ci:unit:canvas-facts
pnpm ci:unit:web-facts
pnpm ci:unit:runtime-timing     # 分项量测与离线采集器（见 docs/RUNTIME_BUILD_TIMING.md）
pnpm ci:integration:finding-research
pnpm ci:integration:platform-api
pnpm ci:smoke:control-api
pnpm ci:smoke:hub
pnpm ci:images
```

> `ci-test-hook.test.ts` 检查每个 `*.test.ts` 均有脚本引用（未接线名单见 `apps/scheduler/src/ci-test-hook.manifest.json`，只减不增），但**脚本是否已接入 `.github/workflows/ci.yml` 仍需人工确认**。

---

## 验收边界：不要求生产测试部署（2026-10-31）

后续开发**不要求生产环境测试部署**。工程验收以 GitHub Actions 在最终 SHA 上实际通过的全部适用 CI 门禁为准，不因缺少生产重跑、生产数据验证或真实模型试验阻塞合并与 Issue 关闭。

### 豁免范围

- **仅豁免生产执行**：生产部署、生产重跑、生产数据验证、真实模型试验。
- **非模型质量验收原则上不豁免**（独立人工标注集、问题家族/资产隔离调参与留出集、先冻结的质量阈值、人工独立复核）。无法取得对应输入时必须记为**未交付/暂缓**，不得把「工程验收通过」写成「质量验收通过」。
- **当前阶段范围决定（2026-11-01，用户明确决定）**：为优先发布，独立质量验证、脱敏人工标注、隔离调参/留出及后续质量门暂缓，不作为本阶段 PR 合并、工程 Issue 收口或发布前置条件；所有测试/构建/typecheck 仅在 GitHub Actions 最终 SHA 全绿验收。质量效果如实记 `unknown` / `not_evaluated`，未交付的当前证书、晋升和公开强关系建议不得冒充已实现或通过；`#833`、`#834` 按用户要求忽略（不实现、不关闭、不阻塞发布）。

### 证据口径

- 始终区分 **规范要求 / 代码实现 / 工程 CI 证据 / 质量评测 / 生产实测**，未执行的测试不得写成已通过。
- 替身/离线/受控夹具结果不冒充真实模型理解效果或真实生产根因。

---

## 架构与运行时纪律

详细模型见 [`DESIGN.md`](DESIGN.md) 与 [`docs/architecture/README.md`](docs/architecture/README.md)；编码与评审必须守住以下硬边界：

1. **核心可插拔原则**：一切皆插件仅适用于业务能力、角色组合与交付投影；**沙箱、凭据、镜像准入、Job/Attempt、租约、并发、预算、幂等、副作用结算、审计与未知外部效果永远属于可信内核**。
2. **不向后兼容**：只支持当前目标契约，删旧设计时同步删除旧 schema、API、UI 与运行时路径，不留双读双写、shim、legacy fallback 或自动迁移兼容窗口；旧配置不满足新契约时 fail closed。已创建 Job 的冻结快照、Evidence 与审计是不可变历史事实，不作新运行兼容输入。
3. **能力发现与 Skill 拉取 ≠ 授权**：Capability Pack（`list_capabilities` / `search_capabilities` / `describe_capability` / `validate_composition` / `preview_materialization`）和业务 Skill 拉取（`list_available_skills` / `search_skills` / `pull_skill`）均须经 Scheduler 按 Job operation allowlist、trusted+enabled 源、镜像兼容性和网络策略重验；不得扩大 `platform_tools`、凭据、镜像、`allow_egress` 或项目范围。未落地的 task/session Pack 生命周期、评估晋升与跨任务推荐不得冒充 as-built。
4. **Agent 只提案**：真实 Job 强制注入不可被 RoleConfig 同名覆盖的 `deepsonar-control` Skill，通过短期 Job capability token 调用 Control API（经 shared Zod schema、宿主 handler、event-ingestion 事务三层校验，默认拒绝未知字段）。语义事件不得来自普通 CLI 输出、伪造 MCP tool call、Shell 控制文件或管理 API 猜测；失败不得回退第二控制通道。`accepted` 仅表示建立 durable receipt，不代表效果结算或任务完成。
5. **Agent 操作错误：先反馈，再由 Agent 修正（RepairFeedback）**：
   沿用 [DESIGN 的失败分类](DESIGN.md#43-失败反馈与修正)（`model_correctable` / `transient_retryable` / `unknown_external_effect` / `permanent_failure`）、[可信内核同会话修复闭环](docs/AI_NATIVE_TRUSTED_KERNEL.md#62-同会话修复闭环)与[完成回执协议](docs/REPAIR_FEEDBACK_DONE_REPAIR.md)，不另建错误协议或控制通道：
   - **拒绝错误但不误杀任务**：在授权、有效租约、时间与预算内的可修正输入错误，返回含 `category`、`code`、`operation`、`path`、脱敏 `message`、`expected`、形状化 `observed_shape`（禁回显凭据/Provider 原文/完整不可信输入/堆栈）、`current_state_ref`、`accepted_effects`、`idempotency_key`、`proposal_revision`、`repair_attempt`、`remaining_budget`、`next_action` 的版本化反馈，让当前 Agent 读取状态后修正重提；不得仅因单次可修正拒绝就冻结会话、结束 Job 或转人工。
   - **事实与预算一致**：无法确认的状态/额度标为未知；修正次数、时间、token 与效果预算不得因重发回执、重启、换 key/token 或换 Attempt 重置。
   - **先认已接受结果**：例如 `request_human` 与 `mark_job_done` 互斥，若其一已接受须遵守其生命周期，不得静默丢弃冲突输入或回滚已确认效果。
   - **区分传输重试与新提案**：传输重试保原 Idempotency-Key / revision / payload 查原结果；修正内容用新 revision / key 提交并保留与原拒绝和预算的关联。
   - **生命周期与身份感知**：可继续纠错 ≠ `waiting_human`；不删 attempt fencing、不改冻结快照、不重绑历史回执；不支持跨 Attempt 续接时明确停止。
   - **不盲目重放**：`transient_retryable` 仅按已证安全策略有界退避；权限/版本/快照/租约失效 fail closed；`effect_pending` / `unknown` / `replay_policy=never` 严禁降格为模型错误自动重放。验收须覆盖「拒绝 → 反馈可读 → 修正提交 → 接受/明确停止」完整闭环，不只断言 4xx。
6. **Artifact / Finding / Verify / Research / Report 分层**：Artifact 为内部写入真相，Finding 为对外风险投影，Fact 为独立观察/验证证据；Fact `verification_status`、Finding `verify_status`、人工 `disposition` 三机分离。Verify 不读 maker 文本自述；Research 只做语义聚类与相对优先级，不改 severity/verify 门，与主写入同事务时须用 savepoint 隔离；Report 为冻结输入后的幂等/追加版本 Projection，失败不改内部事实。
7. **Job / Attempt 与恢复**：状态由 Scheduler 判定（`pending → claimed → provisioning → running → succeeded | failed | timeout | cancelled | orphan`，及 `running → waiting_human → pending`）。外部效果先写 `job_attempt_effects`（`effect_pending`）再写 settlement；`unknown` 或 `replay_policy=never` 禁止自动重放；启动 reconcile 仅对「尚未开始且无效果」准备阶段回 `pending`，未知效果入 `orphan`/对账。Lease、Reaper、取消、超时、迟到回调与清理必须幂等。
8. **配置、运行时与快照**：优先级固定 **Job > 角色/项目 > 平台 > env 引导**；执行只认 `agent_snapshot_json`，不回退最新 RoleConfig。当前新 Job 治理 CLI 为 **Claude Code、Pi、DSH**（历史 Codex/OpenCode 只读归档）；新增 CLI 须同步 runtime adapter、Session archive adapter、Web viewer parser、测试和原始归档下载。镜像须来自准入市场（第三方先经 `apps/image-admission` 扫描批准启用），以不可变 digest 执行，Agent/Hub 不可提交任意 OCI 地址。真实模型请求经 Scheduler-owned Model Gateway，长期密钥不进快照、沙箱或 evidence。

---

## 数据库与迁移纪律

- [`database/schema.sql`](database/schema.sql) 是唯一 schema 基线；[`apps/scheduler/src/schema-version.ts`](apps/scheduler/src/schema-version.ts) 的 `SCHEMA_VERSION` 必须同步（不写增量 ALTER 链）。
- 空库启动套用基线；非空库版本或结构不匹配时 fail closed。改表须改基线、bump `SCHEMA_VERSION`，再以 `pnpm db:rebuild -- --plan` / `--apply` 验证备份与列交集回填。
- 稳定状态、幂等键、外键与权限骨架进定列，开放内容进 JSONB；类型字段用字符串，不用 Postgres enum 锁死演进。
- `events` 仅存语义事件；原始过程流进 evidence 冷存储；`stream-bus` 仅作非权威实时投递。过程流补读只认可见 `BLOB_DIR`，跨副本无共享卷返回 `visibility=unavailable` / WS `4415`（#388）。
- API Token、Job token、Provider secret、Session artifact 与 `.deepsonarpack` 导入导出遵守各自脱敏、权限与 provenance 规则。

---

## Web、体验与动效纪律

- **前端事实**：React 19 + `@xyflow/react` + elkjs + Tailwind 4。任务工作台固定 6 个一级视图（总览、研究地图、事实证据、任务发现、任务运行、报告）；URL `tab` 为当前视图真相，后台刷新不得抢切。Canvas 只读（elkjs 布局，超阈值/失败退固定列；服务端 `x/y` 仅 hint，全图服务端布局按 #148 暂缓）。`injected` 仅表示写入 Agent 输入，ACK 须来自显式受治理 operation。
- **用户体验优先（「复杂留给系统」）**：沿真实用户任务流审查页面、交互、文案与恢复；发现问题先修系统判断与流程，再改界面与文案：
  - 系统在既有权限和可靠证据内能判断、能安全自动做的直接做并告知；不可逆/高风险/越权动作不代做、不默认同意。
  - 首屏只放结果、状态与可行动下一步，低频项与诊断按需展开，但不藏必要风险、权限与未确认结论。
  - 同一状态/操作全站统一名称、入口、视觉与反馈；操作立即回应，可逆支持撤销，长操作按真实能力支持取消，不伪造不可逆撤销。
  - 保留焦点、滚动、输入与上下文，非紧急提示就地/合并呈现；高频路径短，危险操作隔离并说明对象、后果及能否恢复；文案自解释，不要求懂内部协议。
- **按状态变化审查动效**：不解释状态的动效不做；统一项目时长/缓动，高频更短、不挡输入；拖拽/缩放跟手且可打断反向；优先非重排属性，长内容与重复操作须实测帧耗时/掉帧/布局偏移；适配手机/窄窗/宽屏与浅深主题，尊重 `prefers-reduced-motion` 并保留状态与键盘可访问性。
- **体验复核**：实现者在隔离开发/预览环境亲手走过空态、错误、取消/撤销与快速重复操作；重大或跨页面改动安排独立复核，提交说明区分实测范围与未验证项。

---

## 开发与变更检查清单

**提交实现前**：
1. 核对 `DESIGN.md`、`docs/architecture` 归属表与视图、schema、OpenAPI 与现有测试事实；
2. 复用既有领域、`shared-types`、`runtime-sandbox` 与成熟依赖；
3. 补齐权限、项目 scope、快照、幂等、失败反馈与未知效果路径；
4. 涉及结构性边界或功能契约时执行文档同步 Skill 并更新对应文档；
5. 覆盖合法、非法、重复、冲突、超时、取消、重启与跨项目测试；
6. 涉及用户关注/设置/决策时按注意力成本评审核对必要性与可见性。

**提交验证后**：
- `git diff --check`；
- 与改动面匹配的 `ci:unit:*` / `ci:integration:*` / `ci:smoke:*`（Web/路由改动补跑 `ci:unit:searchable-selects`、`ci:unit:file-size`、`ci:unit:bounded-contexts` 等门禁守则）；
- 运行时/镜像改动跑 `pnpm ci:images` 与相应 sandbox smoke；
- UI 改动核对 URL、空态、错误态、刷新与权限边界；
- 文档变更跑 `pnpm ci:unit:docs-freshness`（改 `AGENTS.md` 或路由另跑 `pnpm ci:unit:ci-routing`）。

---

## 发布前的文档保鲜（发版硬门）

**每次修改 `CHANGELOG.md`、打 `v*` tag 或创建 Release 前，必须完成本轮文档保鲜**；未通过不得发版，漂移修在同一个 release 分支（对应 `DESIGN.md` §13 与 `docs/architecture/11-engineering-specs.md`）。每版必查，不能因「本版未动文档」跳过：

1. **版本字面量**：`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` 与文档声明的主线数字一致；产品发布版本唯一来源为不可变 `vX.Y.Z` Git tag（须与 `CHANGELOG.md` 标题及 compare link 一致）；私有 `package.json` 版本仅内部元数据，不随平台发版 bump（见 [`docs/RELEASE_RUNTIME_IMAGES.md`](docs/RELEASE_RUNTIME_IMAGES.md)）。
2. **已删/收敛机制残留**：全仓核对注释、OpenAPI、`docs/**`、`skills/**`，命中仅允许解释性移除说明：
   ```bash
   rg -n "project_managed|image_strategy|role_runtime_images|项目镜像策略" \
     AGENTS.md DESIGN.md docs skills apps/scheduler/src/openapi.ts
   ```
3. **as-built 与代码一致性（须人工核）**：本版触及机制逐条对照 `DESIGN.md`、`docs/architecture/README.md` 归属表与专题；文档漂移则回写，实现违约则登记缺陷。
4. **状态索引**：核对 `docs/README.md` 同步状态与日期、专题文首状态行及 Issue 表。
5. **命令、路径与链接**：所有 `pnpm <script>`、相对链接、路径与 schema 版本均真实有效。
6. **可变数字须带核对基线（须人工核）**：env 默认值、阈值、上限、超时、计数、池大小、冻结额度等可变量，只能二选一：
   - 注明核对基线（`main <sha>` 或 `YYYY-MM-DD`，至少其一），如「`DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` 未设置即 0 = 不限（核对 main `2b76ac25`）」；
   - 或**不复制数字**，直接链接代码或权威文档（如 [`docs/USAGE_LIMITS.md`](docs/USAGE_LIMITS.md)、`apps/scheduler/src/config.ts`）。禁止写「本 PR 基线默认 N」「当前默认 N」等无归属数字。

> 第 1、2、5 项已由 `pnpm ci:unit:docs-freshness` 接入 CI 机检阻断；**第 3 项（语义与代码一致）与第 6 项（可变数字时效）无法机检，必须人工核对**。

### 失败发布恢复：经授权删除并重建同名 Git tag

仅适用于**尚未成功正式发布**的失败版本，且必须先取得用户明确授权；**已正式发布的版本 tag 不可变**。本流程不豁免上述文档保鲜与 [`docs/RELEASE_RUNTIME_IMAGES.md`](docs/RELEASE_RUNTIME_IMAGES.md) 发布硬门：

1. **先核对并留证**：检查现有 Release、各 registry 通道标签/digest、descriptor/catalog 及在途任务；留存旧 tag SHA、解引用 commit SHA、失败 run 链接及已产出镜像证据；并行发布未协调时禁止删 tag。
2. **修复先合主线，再确认版本**：修复走正常 review/merge，重新 `git fetch origin main` 核对修复已合入且与目标 tag、`CHANGELOG.md` 一致；若 main 已推进到新版本或有更高 tag，先停下协调，不降级 changelog 门禁。
3. **最终 SHA 验收**：完成文档保鲜、changelog 校验、该 SHA 核心 CI 与适用双架构原生及真实 Job 验收；纯文档合并未触发 `push@main` 时手动触发并核对 SHA。同时核对发布复制的 timeout、重试、退避、串行耗时与 job 总预算，无日志证据不臆断根因。
4. **指向最新已核验 main 重建**：前置全部满足后删除远端与本地旧 tag 并确认删除；重建前再次 fetch 核对 main，显式指向当前已验收 main commit（不沿用旧固定 SHA），推送后核对远端解引用 SHA；回退旧 tag 同样产生外部效果，不得静默执行。
5. **核对新 run 源码**：推送 `v*` 触发 `.github/workflows/release.yml` 后核对新 run 的 `head_sha`、checkout SHA 与 tag 解引用 SHA 一致；直接 rerun 旧 run 仍用旧 ref/SHA，不等于应用了新脚本。
6. **Git tag 与镜像分离处理**：删 tag 不删 GHCR / ACR / Docker Hub 镜像，勿默认清空 registry。Reverse 已有 index/payload 与本轮双架构 runnable manifest 完全匹配时保留原 index bytes/digest 仅补缺通道；不匹配或 digest 冲突时 fail closed 并协调新版本，严禁覆盖不可变镜像。
7. **完整闭环收口**：新 Release workflow 须实际成功并取得真实 `reverse.json`、各通道 descriptor/inspect 证据、通过双平台 catalog 门禁，完成回写与正式 GitHub Release/附件；部分成功须如实保留为阻塞。

---

## 工程原则

1. 删除优先，拒绝无需求的抽象、状态、配置、依赖与兼容层。
2. 先跑通最小端到端闭环，再按真实瓶颈扩展。
3. 领域边界清晰：入口只组装，领域模块负责规则，基础设施负责外部效果。
4. 优先成熟开源协议和产品；引入依赖前核查维护状态、许可证、安全记录、生态与可替换性。
5. 稳定长期所有权、安全与副作用边界，保持局部实现可删除、可替换。
6. 复用用户已理解的成熟交互与运维模式，不凭空创造第二套术语或工作流。
7. Windows 下避免 PowerShell 破坏 `node -e` 模板字符串；临时检查脚本放仓库临时文件并在任务结束清理。
8. 严禁在代码、测试或文档示例中写死真实凭据、长期 Token、个人域名、中转地址或可变 `latest`；可运行 URL 夹具仅用 `127.0.0.1`、RFC1918 或 Docker 内部主机名。
