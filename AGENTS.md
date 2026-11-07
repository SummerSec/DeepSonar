# AGENTS.md

本文件是 DeepSonar 仓库内编码 Agent 的工作说明。它描述协作方式、事实入口和不可绕过的工程边界；实现事实以代码、`database/schema.sql`、OpenAPI 和测试为准；若实现违反已采纳约束，记录缺陷，不通过修改规范消除违约。

## 开发与设计依据

需求、架构、交互与代码评审统一遵守 [DESIGN 的注意力原则](DESIGN.md#核心理念优化人的注意力)。在既有授权内能核实或完成的事项先自行处理；必须询问时给出缺失输入、影响及具体决定，不重复索取仍有效的授权，也不隐瞒失败或扩大权限。新增界面、通知、配置、工作流和自动化行为按[工程评审问题与示例](docs/architecture/11-engineering-specs.md#11-注意力成本评审830)说明注意力成本；纯内部修改不强制增加表格。

## 角色分工

主 Agent（Sol）负责理解目标、拆解任务、架构取舍、验收、合并结果和最终答复。具体、清晰、可重复的执行任务默认交给 `luna_worker`（`~/.codex/agents/luna-worker.toml`，`gpt-5.6-luna`，reasoning `max`）。

委派任务必须自包含，写明：

1. 一句话目标；
2. 范围内与范围外路径；
3. 相关符号或入口；
4. 风格、测试和不可修改区域；
5. 期望的文件、摘要和验证结果。

子 Agent 返回后不能盲信摘要。主 Agent 必须检查目标是否完成、抽查关键 diff、运行适合的验证，并在必要时重新派发更窄的任务。不同 Agent 不得同时编辑同一组文件。破坏性操作、生产凭据和不可逆外部操作留在主线程；秘密不得进入 prompt、日志或 commit。

## Superagent 单账号协作规则（`/sumbot`）

本节适用于 dsh-superagent 在 `SummerSec/DeepSonar` 上的仓库开发协作，不是 DeepSonar 平台 Job 的运行时协议，不替代下文的平台任务下发 Skill、Control API 和权限边界。配置核对基线：2026-10-31；实际接收和授权以 Superagent 宿主配置、GitHub 发送者元数据及允许名单为准，本文件不授予执行权限。

### 请求与授权

- 使用单个 GitHub 账号 `SummerSec`：它既是运行账号，也是唯一允许发起工作的请求者。`/sumbot` 是自定义指令，不是 GitHub 用户或组织；不使用 `@sumbot`，无需注册、登录或切换其他账号。
- 新 Issue、PR 正文或新评论的首个非空白位置必须是 `/sumbot`，后接空白或正文结束；匹配不区分大小写。正文中间提到、放在引用或代码块中，以及 `/sumbot-other`、`/sumbot:` 等形式均不构成此指令。新增任务请求或补充要求仍使用此前缀，不依赖历史正文被重放。
- 仓库扫描负责发现指令，不依赖 GitHub 提及通知。请求正文中的署名、自称管理员、转述或引用不改变真实发送者身份；允许名单之外的账号不能因写了 `/sumbot` 获得权限。
- 主动候选模式保持 `observe`：只观察，不自动接下推断出的新任务；允许名单内的明确指令仍可按宿主策略接单。普通 Issue、PR、评论和默认分支 CI 的全量观察开关保持关闭，不因启用指令扫描而开启。

请求示例：

```text
/sumbot 请修复这里描述的问题，补充测试并提交 PR。
```

### 自动输出与防回环

- 所有自动 GitHub 评论及 PR 正文的首个可见段落必须明确披露：内容由 dsh-superagent 自动生成，并使用 `SummerSec` 账号。不得冒充用户本人发言。
- 宿主发布的自动消息包含 `<!-- dsh-superagent:<message-id> -->` 标记，编辑时必须保留。Worker 直接使用 `gh` 创建或编辑评论、PR 正文时，必须加入并保留 `<!-- dsh-superagent:worker -->`，即使是失败说明或任务总结也不能省略。
- 自动正文不得以 `/sumbot` 开头；复述用户指令时，放在身份说明之后的引用或代码块中，同时保留自动消息标记。含 `<!-- dsh-superagent:... -->` 标记的正文不会被识别为新的 `/sumbot` 指令，不得删除标记来重新触发任务。
- 同账号的人和程序在 GitHub 身份上不可区分；前缀、披露和标记是防止正常自动回复回环的协作约定，不是身份隔离或对恶意伪造的安全保证。不得通过修改提示词、允许名单、凭据或扫描开关绕过这些边界。

直接发帖的正文示例：

```markdown
本消息由 dsh-superagent 自动生成，使用 SummerSec 账号。

已完成修复；验证结果与 PR 链接如下。

<!-- dsh-superagent:worker -->
```

### 开发与交付

- GitHub 操作使用宿主提供的 `gh`，维持 `SummerSec` 身份，不另行登录或读取其他账号凭据。Git 提交的作者与提交者均使用 `SummerSec <SummerSec@users.noreply.github.com>`，不修改操作者的全局 Git 身份配置。
- 在宿主分配的独立 worktree 中开发，不直接在共享主线目录混入其他任务的改动，不直接推送主线绕过 PR。
- **分支命名（#931）**：按改动用途命名，例如 `feat/<简短主题>`、`fix/<简短主题>`、`docs/<简短主题>`、`refactor/<简短主题>`、`test/<简短主题>`、`chore/<简短主题>`；有 issue 时可写 `fix/123-short-topic`。禁止以 AI / Agent 工具名作为分支名开头（不区分大小写的 `agent`、`codex`、`cursor`、`claude`、`copilot`、`chatgpt`、`gemini`、`openai`，含 `/`、`-`、`_` 与嵌套路径形式）。校验规则以 [`agent-harness/branch-name-policy.mjs`](agent-harness/branch-name-policy.mjs) 为唯一实现，`pnpm ci:unit:ci-routing` 会跑其回归；推送前可用 `node -e "import('./agent-harness/branch-name-policy.mjs').then(m=>m.assertBranchName(process.argv[1]))" <branchname>` 自检。GitHub 的 [Block AI tool branch prefixes](https://github.com/SummerSec/DeepSonar/rules/20986002) ruleset 负责服务端拦截，其模式列表与上述 token 清单一致；仓库外宿主若自行拼分支名前缀，需按同一规则修改。
- 默认由用户人工审查和合并；CI 通过不等于获得合并授权。只有当前用户明确授权特定任务范围的合并、且授权条件与最终提交的完整检查均满足时，主 Agent 才可执行该范围的合并；不得启用无人值守 `--auto`、自动批准 PR 或降低门禁。本文件不自动变更 Superagent 宿主的默认人工合并策略；下文“合并结果”本身只指整合子 Agent 的工作。
- 继续遵守本文件的工程、文档同步和验收规则。交付摘要区分已通过、失败和未执行的验证；没有真实 GitHub 请求到 PR 的端到端运行证据时，不宣称该流程已经实测通过。生产部署、发版和其他不可逆外部操作仍需各自的明确授权。

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

## CI gate：何时触发，何时必须等

**开发不必逐个 commit 等全量 CI；合并或宣告工程验收通过前，必须核对最新合并候选。** 维护者反馈一次完整检查可能接近 1 小时（2026-11-01）；这是整轮 CI 的等待时间，不是 `gate` 单个 job 的固定时长。

| 操作 | 当前行为（以 [ci.yml](.github/workflows/ci.yml) 为准） |
| --- | --- |
| 本地 `git commit`；推送到尚未开 PR 的普通功能分支 | 不触发核心 `ci`。开发中按改动面做定向验证，把相关修复集中推送，不必为每个 commit 开 PR 或手动补跑。 |
| 打开、重新打开 PR，向已打开 PR 推送新提交，或切换 Draft / Ready | 触发 `ci`；按整个 PR 而非最后一个 commit 分类，文档检查每轮都跑。仓库变量 `CI_PR_MODE=tiered` 时，Draft 代码 PR 跑 `draft-fast`，转 Ready 同一 SHA 触发完整核心与适用专项；未设置、非法值或 `full` 则恢复完整 PR 验收。纯安全文档白名单才跳过重型 `gate`。 |
| 合并或推送到 `main`；手动运行 `ci` | `main` 的改动未被 `paths-ignore` 排除时自动跑完整核心 CI。手动运行也跑完整核心 CI，不是快检；只在缺少必要验证或需要排障时使用，不要与同一提交正在运行的检查重复。 |

**Agent 的等待规则：** 开发中 CI 排队或运行时，记录 PR、提交 SHA、运行链接和未完成项，即可继续不依赖结果的工作或向用户交接；不要反复轮询、推空提交或要求用户在线等候。出现失败先看失败步骤，再集中推送修复。合并前查看 PR 的 Checks，确认最新 head 对应的 `ci-summary` 和所有适用专项通过；旧提交全绿、必跑项缺失、失败或取消都不能作为通过依据。发布仍按原有发布门禁执行。

**[#836 分层方案](https://github.com/SummerSec/DeepSonar/issues/836) 已启用**（2026-11-03 核对：工作流已合入，`CI_PR_MODE=tiered`）。开发中保留 Draft 跑快检，准备合并时转 Ready，同一 SHA 无需空提交即可跑完整核心及适用专项；Ready 后再推新提交必须重新验收。实际仓库变量与工作流是当前行为依据，不能把旧状态说明当作开关。

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
pnpm ci:unit:runtime-timing         # #961 P0：分项量测与离线采集器回归，见 docs/RUNTIME_BUILD_TIMING.md
pnpm ci:integration:finding-research
pnpm ci:integration:platform-api
pnpm ci:smoke:control-api
pnpm ci:smoke:hub
pnpm ci:images
```

`gate` 里的守则套件分散在多个脚本（如 `ci:unit:searchable-selects` 禁止原生 `<select>`、`ci:unit:file-size` 文件体量棘轮、`ci:unit:bounded-contexts` 固定路由面与 bounded-context 所有权、`ci:unit:docs-freshness` 文档保鲜），`ci:unit:web-facts` 覆盖不到：Web 或路由面改动要按需补跑，否则 CI 才第一次报错。`ci:unit:authz` 内的 `ci-test-hook.test.ts` 保证每个被跟踪的 `*.test.ts` 都有测试入口引用（未接线的进 `apps/scheduler/src/ci-test-hook.manifest.json` 基线，只能缩小），但**脚本本身是否被 workflow 调用仍需人工确认**：全量脚本见根目录 `package.json`，已进 CI 的以 `.github/workflows/ci.yml` 为准（`ci:unit:bounded-contexts` 自 #684 起已进 CI；`ci:unit:file-size` 自 2026-10-31 起在 gate 中显式执行，此前仅通过 `ci:unit:authz` 的文件列表间接运行，调整该列表会让棘轮静默失效）。测试数据库需要 `TEST_DATABASE_URL`；只依赖真实沙箱的测试要明确检查运行时是否可用。镜像改动还要检查 Dockerfile、`.dockerignore`、runtime registry fingerprint、平台架构和体积预算。

**#972/#992 的 `gate` 为五个有界并行分片**（2026-11-07 核对）：`gate-contract`（无服务单测/契约）、`gate-runtime`（运行时/锁版本 SDK/真实 executor 单测，两片均不声明 `services.postgres`）、`gate-db-core` / `gate-db-domain`（各自独立 PostgreSQL 服务与库）、`gate-e2e`（scheduler 3100/3101 与同库 setval 竞态相关的启动/端到端冒烟必须同片）。每片独立 `needs: changes`、独立 `install`/`typecheck`/`build` 生命周期，不复用跨提交结果；`ci-summary` 用 `EXPECTED_GATE_SHARDS` 显式期望矩阵逐片要求 `success`，缺片/取消/超时/失败一律拒绝。完整套件清单与归属以 `agent-harness/gate-shards.mjs` 及 `agent-harness/gate-shards.test.mjs` 的覆盖率断言为准（每个原套件恰好覆盖一次），改 gate 步骤必须同步更新该清单。#971/#972/#973/#974 的纯 Node 契约回归统一在 `docs-freshness` job 的 `perf(ci) contract regressions and hosted runner disk safety` step 显式列出，新增测试文件必须同步加到该 step 才会被门禁执行。

**#976 起 Reverse 家族按子套件分流**：`agent-harness/reverse-suite-plan.mjs` 把 Reverse workflow 的宽 `pull_request.paths` 拆成 `reverse` / `claude` / `pi-om` 三份显式依赖清单，外加 shared（共享 base、lockfile、runtime-sandbox、沙箱启动器）与 routing（本模块、`ci-run-plan.mjs`、`classify-ci-changes.mjs`、workflow 自身）两组保守输入。`ci-run-plan.mjs` 输出 `reverse_suites`，三个重活 job 各自按计划决定是否启动；`reverse-runtime-acceptance` 逐项核对计划与实际：计划内必须 `success`，计划外必须 `skipped`，失败/取消/超时永远拒绝。`package.json` 只做字段级安全分类——仅「新增且不被三个专项消费、命令含 `--test`、名字为 `ci:unit:*`」的脚本可判无影响；依赖、lockfile、脚本删改、删除/改名、解析失败、缺 SHA 一律全跑。

**#975 的 Reverse base 复用默认关闭**：`vars.REVERSE_BASE_REUSE=on` 时才启用「每架构只构建一次当前 checkout 的 base、按不可变 SHA/架构/平台/工具集标签共享 artifact」，消费者 `docker load` 后必须校验标签；未开启时保持原来每个 job 各自构建的路径，零行为变化。

## PR 的 Draft / Ready 分层（#836）

`ci.yml` 按当前 PR 状态出运行计划（`agent-harness/ci-run-plan.mjs`），只有同一个分类器，不另造第二套判断：

| 模式 | 何时 | 跑什么 |
| --- | --- | --- |
| `docs` | 纯文档白名单 | 文档保鲜 + 路由回归，重活全跳 |
| `draft-fast` | Draft PR 的代码改动 | frozen install、workspace typecheck、按路径映射的无服务单测；不启动 PostgreSQL、镜像矩阵、Chrome ARM64 或 Windows 专项 |
| `ready-full` | Ready for review、`push@main`、手动运行 | 完整核心与适用专项；Chrome Fuzz ARM 按下述运行计划核对 |

- **开关是仓库变量 `CI_PR_MODE`**：只有值为 `tiered` 才启用分层；未设置、非法值或 `full` 时恢复分层前的完整 PR 验收（纯文档例外保留）。没有 `off` / `skip-all`。
- Draft 只发非 required 的 `ci-preview`，`ci-summary` 在 Draft 上跳过；Ready 才产生稳定 `ci-summary`。
  **注意 GitHub 把 `skipped` 的 required check 视为满足**：跳过本身挡不住合并，要阻止 Draft 合并必须靠 ruleset / 单独的 required check，不能依赖本工作流的跳过行为。
- 连续推送时 Draft 每次都有实际快检；同一 SHA 从 Draft 转 Ready 会重新出计划并跑完整验收，不需要再推空 commit。旧 run 的绿灯不能顶替最新候选。
- 手动运行某个工作流强制该工作流完整验收；`push@main` 不进入快路。
- #961 的核心 Chrome Fuzz ARM build/native smoke 由同一运行计划决定：tiered Ready PR 仅在全部改动属于已核对的非镜像业务输入或原文档白名单时可跳过两项；Chrome/base/路由输入、未知路径、空 diff 或分析失败保守必跑。`ci-summary` 必须核对计划与结果一致，缺输出、失败、取消或意外跳过不能放行；main、手动运行与 `CI_PR_MODE=full` 仍完整验收。

- #961 P2：`deploy/Dockerfile.agent-chrome-fuzz` 的 V8 编译阶段 `FROM --platform=$BUILDPLATFORM ${V8_BUILDER_IMAGE}` 用的是**按 digest 钉死的 builder 镜像**（与 base 同源的 node bookworm-slim），不再继承 `${BASE_IMAGE}`；只有 `runtime-rootfs` 跟随本次解析出的 base。这样 base 的运行时变化（CLI 版本、手册、包装脚本）不会让 V8 下载/GN/编译层失效。改 builder 镜像或 V8/depot_tools/compiler-rt 版本时，Dockerfile 内容变化会自然改变指纹；不要改成可变 tag。
- #961 P3：`image-build-fingerprint.mjs` 输出三个互不复用的命名空间——`src_tag`（`src-<fp>`，历史遗留，**已无消费方**）、`ci_src_tag`（`src-ci-<fp>`，CI 读写）、`release_src_tag`（`src-release-<fp>`，release 读写）。`ci.yml`/`chrome-runtime.yml`/`mobile-runtime.yml`/`openharmony-runtime.yml` 只用 `ci_src_tag`；`release.yml` 只用 `release_src_tag`。**release 不得再查 `src-<fp>`**：该 tag 在本改动前可由 PR job 推送，而 `resolve-image-src-cache.sh` 只要能解析出 digest 就回 `skip=true`，等于让发布跳过真实构建。改这条边界必须同步 `agent-harness/image-cache-trust.test.mjs`。
- 专家套件（reverse / chrome / mobile / openharmony）的路径基线直接读各自 workflow 的 `pull_request.paths`，因此清单不会与计划漂移。

- 四个专家工作流各自跑同一个 `ci-run-plan.mjs`（不是四份判断），重活矩阵只在 `mode == ready-full` 时启动；`push@main` 与手动运行仍是完整验收。专家套件的 PR 触发保留，尚未迁移到 `ci.yml` 的 `workflow_call` 统一入口。
- 改分类器、汇总或本套路由本身时按高风险改动处理：需要独立评审与完整验收，不能用自己的快检规则给自己放行。
- 出现漏测、重复触发或 required check 错配时，先把 `CI_PR_MODE` 设回 `full`（或删掉变量），再修路由。
- 现状核对（2026-11-03）：`main` 的 active ruleset `main required ci-summary` 要求 `ci-summary`，另有 AI 工具分支前缀规则；没有 merge queue。required check 不替代最终 SHA 的全部适用检查或人工合并授权。启用 merge queue 必须同时加 `merge_group: checks_requested` 并验队列 SHA，**没有队列就不要先加 `merge_group`**（死配置）。

## 验收边界：不要求生产测试部署（2026-10-31）

后续项目开发**不要求生产环境测试部署**。验收以 GitHub Actions 实际通过的 CI 为准：`.github/workflows/ci.yml` 调用的 `ci:unit:*`、`ci:integration:*`、`ci:smoke:*`、`ci:images` 等门禁全部通过，即视为本仓库的**工程验收**完成。用户已明确此类生产执行无需进行，不因缺少生产重跑、生产数据验证或真实模型试验阻塞合并与 issue 关闭。

### 豁免范围

豁免的只有**生产执行**：生产环境测试部署、生产重跑、生产数据验证、真实模型试验。

**非模型质量验收不在豁免范围。** 下列要求仍按各自 issue 的验收条款执行，不因本节失效：

- 独立人工标注集，以及按问题家族 / 资产隔离的调参集与留出集；
- 在查看留出结果之前冻结的质量阈值；
- 需要人工判定、独立复核或外部真实输入的验收项。

无法取得这些输入时，对应能力记为**未交付或暂缓**（或拆出独立跟踪项），不能用 CI 通过替代质量结论，也不能把「工程验收完成」表述为「质量验收通过」。

**v0.6.3 本轮范围调整（2026-11-01，用户明确决定）**：为优先发布，本轮独立质量验证、脱敏独立人工标注及按问题家族/资产分离的调参/留出集，以及后续质量门建设暂缓，不作为本轮 PR 合并、工程 issue 收口或发布的前置条件。保留已实现软件和现有工程门禁，所有测试、构建和 typecheck 仅在 GitHub Actions 执行；各最终 SHA 的完整适用检查必须实际全绿。质量效果仍记 `unknown` / `not_evaluated`，未交付的当前证书、晋升和公开强关系建议不得冒充已实现或质量通过；后续问题再补相应 Actions 质量卡点。#833、#834 另按用户要求忽略，不实现、不关闭，也不作为本轮发布前置条件。

**v0.6.4 发布续接（2026-11-02，用户明确决定）**：保留失败的 v0.6.3 tag 及既有镜像，改发 v0.6.4；上述本轮范围及仅 GitHub Actions 验收的约定沿用至 v0.6.4。旧 tag 不删除、不移动，已有镜像不覆盖；版本比较与正式升级基线分别按[发布专题](docs/RELEASE_RUNTIME_IMAGES.md#发布前门禁)核对。

### 证据口径

- 未执行的生产验收、未运行的真实模型试验、未取得的人工标注，仍须在交付摘要和文档中如实标注为未验证；不能写成已通过，也不能用离线/合成结果代替效果数据。
- 离线、合成和替身证据可以支撑工程行为验收，但质量收益、容量和 SLA 结论在没有实测数据时保持 `unknown`。
- 生产部署（`deploy/deploy.sh` / `deploy/deploy.ps1`）仍是独立运维动作，不因本节的 CI 验收约定自动获得授权。

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

#### Agent 操作错误：先反馈，再由 Agent 修正

这是开发与评审约束，不表示所有入口已完成实现。沿用 [DESIGN 的失败分类](DESIGN.md#43-失败反馈与修正)、[可信内核的同会话修复闭环](docs/AI_NATIVE_TRUSTED_KERNEL.md#62-同会话修复闭环)和[完成回执协议](docs/REPAIR_FEEDBACK_DONE_REPAIR.md)，不另建控制通道、错误协议或状态机。

1. **拒绝错误操作，不直接判死任务。** 对仍在授权、有效租约、时间和预算内的可修正输入错误，平台应明确拒绝本次提案，把原因及下一步交回当前 Agent，让它读取状态、修正并重新提交。不能只返回 HTTP 状态码、固定催促语句或写日志，也不能仅因一次可修正拒绝就冻结会话、结束 Job 或交给人工。Runtime Adapter、Control API 与完成门必须保证反馈能回到实际调用者。
2. **反馈必须可行动且与事实一致。** 说明失败的 operation/字段、违反的约束、当前可引用状态、已经接受的效果、可选动作和真实剩余额度；无法确认的状态或额度明确标为未知，不编造“仍可修正”。修正次数、时间、token 和效果预算不能因重发同一回执、进程重启、换 key/token 或换 Attempt 而被错误重置；不得用扩大预算掩盖无法继续的生命周期。
3. **先判断已接受结果，再决定如何修正。** 例如 `request_human` 与 `mark_job_done` 冲突：若均未接受，应说明互斥原因，让 Agent 选择符合当前目标的合法提案；若人工请求或完成已接受，应返回该事实并遵守其生命周期，不能再建议提交相冲突的终态。不得猜测 Agent 的业务选择、静默丢弃冲突输入后宣称整笔成功，或回滚已确认的效果来制造重试机会。
4. **区分传输重试与新提案。** 同一提交的传输重试保持原 Idempotency-Key、revision 和 payload，先查询原结果；修正内容则按现有 operation 契约提交新 revision/key，并保留与原拒绝和修正预算的关联。回执缺失不等于没有副作用，`accepted` 不等于效果已结算或 Job 已完成。
5. **恢复必须感知生命周期与执行身份。** 可继续的纠错不是 `waiting_human`；已接受的人工等待也不能继续按普通运行催促完成。Scheduler、lease、Reaper、取消和超时处理须依据真实状态及原 deadline 协调。若允许切换 Attempt，必须先明确旧修正链如何结束或受治理地续接，并一致核验新执行器、Control/Gateway token、回执、预算和效果的归属；不支持续接时明确停止并保留原因，不能创建一个注定沿用旧身份而失败的新尝试。不得删除 attempt fencing、改写冻结快照或重绑历史回执来消除身份拒绝。
6. **可恢复不等于无条件重试。** `transient_retryable` 只按已证明安全的策略有界退避；权限、版本、快照、租约失效等边界继续 fail closed。未知外部效果、`effect_pending`、`unknown` 或 `replay_policy=never` 不能降格成模型输入错误后自动重放。预算耗尽、取消、真实超时、不可修正或需要新增授权时，明确停止或走既有人工/对账路径，保留最后反馈、已接受效果和具体阻塞，不无限循环、不伪装成功。

涉及上述路径的实现，验收必须覆盖“拒绝 → 反馈实际可读 → 修正提交 → 接受/明确停止”的闭环，并检查重复旧 key、修正新 key、终态竞争、已接受人工等待、取消/超时、Reaper 与重启/新 Attempt、未知效果和跨权限输入。只断言返回 4xx 或反馈字段存在，不足以证明恢复成立；替身/离线工程证据与真实模型理解效果仍按本文件的验收边界分别报告。

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
5. 为合法、非法、重复、冲突、超时、取消、重启和跨项目输入补测试；
6. 涉及用户关注、设置或决策时，按上述注意力成本评审核对必要性、可自动处理范围、合并去重和状态/风险/证据可见性。

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
6. **可变数字必须带核对基线**：文档里的任何**可变量**——env 默认值、阈值、上限、超时、计数、池大小、冻结额度——必须属于下列两种写法之一：
   - 写上核对基线（`main <sha>` 或 `YYYY-MM-DD`，二者至少一项），例如「`DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` 未设置即 0 = 不限（核对 main `2b76ac25`）」；
   - 或**不复制数字**，直接指向代码或权威文档（如 [USAGE_LIMITS.md](docs/USAGE_LIMITS.md)、`apps/scheduler/src/config.ts`）。

   禁止写「本 PR 基线默认 N」「当前默认 N」这类**无归属的数字**。理由：这类漂移机检抓不到——实测案例是 `DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` 默认值从 500 改为 0（不限），而一份文档的「本 PR 基线默认 500」在 `docs-freshness` 全绿的情况下静默过期了整轮。若同一数字同时存在于权威文档（如 `USAGE_LIMITS.md`），其他文档应链接而不复述。

其中 1 的版本字面量、5 的命令与链接、以及 2 的已删机制残留已由 `pnpm ci:unit:docs-freshness` 机检并在 CI 中阻断；**第 3 项（as-built 与代码相反）与第 6 项（可变数字的时效）无法自动化**，必须人工逐条核——这正是本条硬门不能省的理由。

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
