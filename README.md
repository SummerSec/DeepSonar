# DeepSonar

> 深流循迹：让复杂的 AI 执行持续收敛。

DeepSonar 是一个面向安全研究与工程任务的 AI-native 执行平台。它把模型放在“提出计划、组合能力、读取证据、修正失败、判断是否继续”的位置，把沙箱、权限、资源、幂等、副作用记账和审计放在一个可信执行内核里。

当前可运行主路径仍是 Loop Graph：用户创建项目和任务，Hub 根据画布状态提出下一步 Intent，Worker 在一次性沙箱中执行，Fact/Artifact/Finding 写回画布，验证与报告由调度器收敛。`explore`、`analyze`、`review`、`test`、`code`、`audit` 是现有内置 capability pack 的默认组合；它们是可替换的工作能力，不是模型必须服从的永久岗位分类。

设计入口是 [DESIGN.md](DESIGN.md)。长期演进的协议边界见 [docs/AI_NATIVE_TRUSTED_KERNEL.md](docs/AI_NATIVE_TRUSTED_KERNEL.md)。行为以代码、[database/schema.sql](database/schema.sql)、OpenAPI 和测试为准。

## 核心模型

```text
人类目标 / 外部事件
        │
        ▼
  Canvas（任务与过程真相）
        │
        ▼
  Hub / Plan：模型选择能力与下一步工作
        │
        ▼
  Capability Pack → Intent → Job → Attempt → Sandbox
        │                              │
        │                              └─ RepairFeedback → 同会话修正
        ▼
  Artifact / Fact / Finding / Evidence
        │
        ├─ Verify：独立证据硬门
        ├─ Research：语义去重与相对优先级
        └─ Projection：Finding Report / Task Report / SARIF
```

系统遵守四个真相边界：

| 层 | 真相 | 负责的事情 |
| --- | --- | --- |
| PostgreSQL / API | 管理真相 | 项目、任务、配置、权限、状态、账本 |
| Canvas | 过程真相 | 目标、Intent、Fact、Artifact、Finding、Job 及其关系 |
| Sandbox / Evidence | 执行真相 | 进程、工具调用、会话、运行产物和原始证据 |
| Scheduler | 副作用唯一执行者 | 调度、状态迁移、验证/报告派生、资源清理和审计 |

模型可以提出业务计划和能力组合，但不能直接修改数据库、容器、凭据、镜像准入、Job 快照或最终状态。所有真实 Job 通过短期 Job capability token 调用 Job 级 HTTP Control API；平台不从普通文本、伪造 MCP 调用或控制文件推断语义事件。

## 当前已经落地的 AI-native 基础

- **Artifact-first 写入**：Artifact 是版本化的内部写入真相，包含 claims、evidence、relations 和 provenance；Finding 是安全、可查询的投影，报告是更下游的投影。
- **统一失败修复**：严格契约、引用、权限和状态错误返回版本化 `RepairFeedback`，包括 `error_code`、字段路径、expected、脱敏 observed shape、当前状态、已接受效果、剩余预算和下一步动作。模型可以在同一 Session 修正并重新提交。
- **Capability Pack 契约**：`deepsonar.capability-pack/v1` Manifest 声明 inputs、outputs、权限、预算、失败策略和 digest。Job 级只读发现操作包括 `list_capabilities`、`search_capabilities`、`describe_capability`、`validate_composition` 和 `preview_materialization`。
- **Job 快照冻结**：创建 Job 时冻结 CLI、Provider、模型、镜像 digest、工具清单、能力 selector/digest、Finding 协议和运行参数；运行时只能使用这份快照。能力发现是只读目录提示，不能单独授予权限，组合和物化必须受快照上限约束。
- **Finding 研究与验证分离**：Research 层维护语义去重 cluster、canonical anchor 和相对 `priority_score`，用于安排注意力；它不修改 `verify_status`、severity、Fact 证据门或报告收敛门。
- **任务工作台**：任务详情默认进入总览，并提供研究地图、事实证据、任务发现、任务运行和报告视图。过程画布、Finding、Job、Session、广播账本与报告各自展示真实状态，不把“已注入”冒充“模型已读”。
- **质量与回放**：只读质量指标和 Hub replay 可查看确认率、误报率、Verify 分歧、人工介入、token/时间成本以及每轮决策输入和结果；经验召回层仍在后续阶段。

## 可信内核与插件边界

内核永久拥有沙箱、网络、凭据、镜像 digest、Job/Attempt 生命周期、租约、并发和预算、幂等、Evidence 来源、Proposal/Receipt/Settlement、未知外部效果处理、审计和资源清理。插件可以提出以下内容：

- Plan、子任务、依赖、完成理由和验证路径；
- Capability、工具、运行时和 Artifact 输入需求；
- Claim、Evidence 引用、关系、Evaluation 和 Projection 请求；
- 继续、收敛、阻塞或请求人工的业务判断。

插件准入的标准不是“能启动”，而是能完成“错误反馈 → 模型修正 → 重新验证 → durable acceptance”。失败必须归类为：

| 分类 | 行为 |
| --- | --- |
| `model_correctable` | 返回字段级反馈，在预算内同会话修正 |
| `transient_retryable` | 有界退避或恢复，保留幂等语义 |
| `unknown_external_effect` | 停止自动重放，交给对账、orphan 或人工处理 |
| `permanent_failure` | fail closed，给出权限、配置、版本或快照修复方向 |

`accepted` 只表示可查询的 durable receipt。它不表示模型已经完成，也不允许绕过 `job_attempt_effects` 的 `effect_pending`、`unknown` 和 `replay_policy=never` 边界。

## 控制闭环与证据口径

当前 Hub 主路径为：

1. 创建标准任务或带冻结 Finding 种子的 compose 任务；
2. Hub 读取有预算的图投影，提出带完整 prompt 的 Intent；
3. Scheduler 校验 canonical UUID、角色/能力、权限、预算、项目范围和镜像 readiness 后创建 Job；
4. Worker 在全新 `/workspace` 沙箱中通过 Control API 提交 Fact、Artifact、Finding、进度和完成提案；
5. Job 结束后，Scheduler 触发 Verify、Research、下一轮 Hub 或 Report；
6. 所有证据不足、冲突、版本不匹配和可修正错误回到模型或人工入口，未知外部效果进入对账路径。

Finding 的技术确认使用 Fact-first 硬门：review/test/worker 只能提交带 `finding_id`、`subject_revision`、`ownership`、`expected`、`actual` 和 `outcome` 的结构化 Fact。Finding 的 `verify_status`、Fact 的 `verification_status` 和人的 `disposition` 是三个不同维度，不能互相代写。

任务状态以活跃 Job、根节点和报告状态综合判断；不能用 `last_job_status=succeeded` 单独推断任务完成。Job 状态由 Scheduler 判定：`pending → claimed → provisioning → running → succeeded/failed/timeout/cancelled/orphan`，并由 Lease、Reaper 和启动对账处理悬挂、超时与孤儿。

## 用户界面

日常路径是“项目 → 任务 → 工作台”：

- Dashboard 查看项目、任务、Finding、Job、质量和用量概览；
- Project 查看任务、项目风险、项目账本、报告和数据导入导出；
- Task Workbench 查看总览、研究地图、事实证据、任务发现、任务运行和报告；
- Canvas 作为高级过程审计入口，保持只读布局，节点位置由服务端布局生成；
- Finding 详情按 Issue 风格管理 disposition、评论、验证追踪和证据链；
- Job 详情查看 Attempt、运行流、Session、工具调用、用量账本、人工消息和广播投递状态；
- Agent Marketplace 管理 `deepsonar.agentpack/v1` 角色包，Runtime Images 管理已准入镜像；凭据、Token、全局 RoleConfig 和平台规则分开管理。

`planned`、`injected`、`acknowledged`、`unknown`、`failed` 都是可观测状态。`injected` 仅表示平台把消息写入 Agent 输入通道，不代表模型已经读取或处理。

## 本地开发

要求 Node.js 20+、pnpm、Docker 和 PostgreSQL（推荐使用仓库 Compose）。

```bash
corepack enable
pnpm install
cp .env.example .env                 # PowerShell: Copy-Item .env.example .env
pnpm db:up                           # 独立开发 PostgreSQL
pnpm dev                             # Scheduler: http://127.0.0.1:3100
pnpm dev:web                         # Web: http://127.0.0.1:5173
```

本地状态机联调可以将 `.env` 设为 `AGENT_MODE=fake`；真实执行使用 `AGENT_MODE=real` 和 OpenSandbox。`pnpm db:up` 与 `pnpm db:up:deploy` 使用不同 Compose 数据库，不能同时占用同一个端口。

常用验证：

```bash
pnpm typecheck
pnpm build
pnpm ci:unit:capability-pack
pnpm ci:unit:finding-research
pnpm ci:unit:web-facts
pnpm ci:images
```

按改动范围选择单元、集成或 `agent-harness` 冒烟测试；只跑 typecheck 不能替代行为验证。当前 schema 版本以 `apps/scheduler/src/schema-version.ts` 和 `database/schema.sql` 为准（主线当前为 v48）。

改表时直接修改 `database/schema.sql`、同步 bump `SCHEMA_VERSION`，再用 `pnpm db:rebuild -- --plan` / `--apply` 重建并回填交集列。Scheduler 不执行增量 ALTER，也不会在启动时静默升级非空库。

## 一键部署

生产 Compose 和镜像清单位于 `deploy/`。默认使用已发布、不可变 digest 的平台镜像；需要本地构建时显式选择 build。

```bash
./deploy/deploy.sh up real pull
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh down
```

Windows：

```powershell
pwsh -NoProfile -File .\deploy\deploy.ps1 -Action up -Mode real -Source pull
.\deploy\deploy.ps1 status
```

详细部署、对象存储、镜像发布和回滚规则见 [docs/ONE_CLICK_DEPLOYMENT.md](docs/ONE_CLICK_DEPLOYMENT.md)、[deploy/README.md](deploy/README.md) 和 [docs/RELEASE_RUNTIME_IMAGES.md](docs/RELEASE_RUNTIME_IMAGES.md)。不要在仓库文档、Issue 或配置示例中写入真实凭据、长期 Token 或可变 `latest` 镜像。

## 仓库地图

```text
apps/scheduler/       Fastify API、Hub、Dispatcher、Verify、Research、Report、Gateway
apps/web/              React 控制台、任务工作台、过程画布和 Session 查看器
apps/image-admission/  第三方 OCI 镜像准入与扫描
packages/shared-types/ 前后端共享 Zod 契约、Capability Pack、RepairFeedback
packages/runtime-sandbox/  Noop/OpenSandbox、CLI adapter、Session 归档
database/schema.sql    唯一 schema 基线
agent-harness/         API 冒烟、运行时和镜像校验
deploy/                Compose、生产脚本、镜像与发布流程
docs/                  架构、契约、AI-native 长期设计和专题索引
```

进一步阅读：

- [DESIGN.md](DESIGN.md)：当前 as-built 设计、数据模型、状态机、UI 和实现硬约束；
- [docs/README.md](docs/README.md)：专题文档与状态索引；
- [docs/AI_NATIVE_TRUSTED_KERNEL.md](docs/AI_NATIVE_TRUSTED_KERNEL.md)：内核、插件、RepairFeedback、Receipt 和分阶段路线；
- [docs/AGENT_CLI_RUNTIME_ADAPTERS.md](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)：Agent CLI、运行时和 Session 归档契约；
- [CHANGELOG.md](CHANGELOG.md)：已发布变更；
- `/api/openapi.json`：当前 HTTP 契约。

## License

当前仓库版本为专有源码。使用、复制、修改、分发、再许可或销售前，请取得 SummerSec 书面授权。第三方组件适用各自许可证，详见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
