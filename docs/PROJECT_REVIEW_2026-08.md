# DeepSonar 项目深度评审与优先级建议

**日期：** 2026-08-13
**状态：** 独立评审意见，非 DESIGN.md 共识演进；仅作决策参考，实施前以代码、schema 与 Issue 为准。
**证据基准：** main @ `94cb558`；`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION = 27`。

## 1. 总体判断

DeepSonar 是同类多智能体编排平台中架构纪律最严的项目之一，且选对了差异化方向：多数 agentic 平台在解决"让 Agent 干更多事"，DeepSonar 在解决"让 Agent 干的每件事都可审计、可回滚、可收敛"。四层真相、Agent 只提案、fact–intent 二分图、验证硬门构成"收敛纪律"，是最难被复制的护城河。

当前主要矛盾不是缺能力，而是**迭代速度已超过部分纪律的维护速度**——文档漂移、schema 重建策略、测试入口分散等问题已经开始显现。本评审建议先做一轮"咬合"，再继续扩面。

## 2. 证据快照

| 指标 | 值 | 证据 |
|---|---|---|
| 业务代码规模 | 约 64K 行 TS（apps + packages） | `find apps packages -name "*.ts"` 排除 node_modules/dist |
| 领域目录 | 25 个 | `apps/scheduler/src/domains/` |
| 测试文件 | 121 个 `*.test.ts` | 全仓统计 |
| Schema | 1699 行，v27，无增量 migration | `database/schema.sql`、`schema-version.ts` |
| Commit 数 | 368 | `git log` |
| Agent CLI | 4 个：Claude Code、Codex、OpenCode、Pi | `SupportedAgentCli` |
| 官方/专项镜像 | base/audit/kali-minimal + Chrome×3 + OpenHarmony×3 | `agent-harness/*-runtime.json` |
| 最大文件 | `agentbox.ts` 2701 行、`executor-real.ts` 1657 行 | `packages/runtime-sandbox/`、`apps/scheduler/` |
| Skills | 1 个（`deepsonar-management`） | `skills/` |

## 3. 值得肯定的架构决策

以下决策正确且应继续坚持：

1. **D1–D6 控制面 doctrine**：默认拒绝 + 三层纵深校验 + 稳定错误码，把"被审计代码 = 不可信输入"落实到了工具 schema 级别，是安全审计平台的立身之本。
2. **Job Attempt + effects 账本**：外部副作用先写 intent、完成同事务 settlement、`replay_policy=never`、未知窗口不重放——分布式系统最难的状态机语义，处理正确。
3. **Bounded contexts（#37）**：25 个领域经 application/ports 暴露窄接口，配合 characterization 测试防止回归，在单兵项目中极为罕见。
4. **发布工程**：指纹构建、ACR→GHCR→Docker Hub 逐仓验证、fail-closed，成熟度超过多数商业产品。

## 4. 风险与证据

### 4.1 文档版本漂移（已确认）

`SCHEMA_VERSION = 27`（代码），但 README 写 "schema v23"，AGENTS.md 写 "当前 v22"。DESIGN.md 是 Agent 的"先读"入口，文档不可靠会迫使 Agent 猜代码、写错实现。

**建议**：加"文档表征测试"——断言 README/AGENTS.md/DESIGN.md 中的 schema 版本等于 `schema-version.ts`。复用 characterization 测试的思路，把文档一致性变成 CI 门禁。

### 4.2 无 migration 策略的利息正在累积

"改表 = 重建库"在早期是最简实现，但 v27 意味着已发生 27 次 schema 变更，而一键部署、备份脚本、`.deepsonarpack` 导入导出表明真实部署已存在。每推迟一个版本，重建成本就多一批用户。

**建议**：将 #34 迁移方案列为产品化第一硬门槛，优先于任何新功能；过渡期内至少在 Release 说明中把"必须重建库"写成显式破坏性变更。

### 4.3 维护面扩张 vs 单兵作战

4 个 CLI adapter + Chrome 三镜像 + OpenHarmony 三镜像。最近 30 个 commit 中约四成集中在 runtime/镜像/CI 修复；OpenHarmony 专项的 arm64 交叉编译、QEMU 组装、原生 runner smoke 是巨大的持续维护税。

**建议**：对每个 project-opt-in 运行时做"年度维护小时数"核算；客户驱动则保留，预研性质则外置或冻结，避免专项镜像吃掉主线速度。

### 4.4 执行心脏未域化

`agentbox.ts`（2701 行）与 `executor-real.ts`（1657 行）是最后两个未域化的大文件，而最近回归修复恰好集中在 runtime 领域。bounded contexts 完成之后，这两个文件是下一个域化对象。

**建议**：按 application/ports 模式拆分 runtime 域，characterization 测试先行，与 #37 同一方法。

### 4.5 测试入口分散

121 个测试文件、30+ 个 `ci:*` scripts、Python 冒烟与 `tsx --test` 混用。问题不在测试数量，而在新测试的发现成本：写完测试必须记得挂到正确的 `ci:*` script，否则永远不跑。

**建议**：加一个薄 runner 统一入口（如 `pnpm test` 跑全量 node:test + 冒烟标记），让"写了测试"自动等于"CI 跑了"。

### 4.6 生态冷启动

多智能体平台的价值在网络效应，目前仅官方 `deepsonar-management` 一个 skill。Agent 市场已具备安全 MVP（agentpack、256KiB、凭据隔离），缺的是让新用户快速看到端到端价值的预置工作流。

**建议**：预置一条"审计一条龙"杀手工作流（GitHub repo → Finding → Verify → PoC → 报告），让新用户 10 分钟看到闭环，而非先学平台概念。

## 5. Pi 能力扩展的路线承接

DeepSonar 集成 Pi 的方式（`pi --mode rpc --no-approve`、`--no-extensions`、精确 sessionFile 恢复、受治理扩展显式加载）实质上是"消费上游稳定 API、绝不 fork"的路线。pi-capability-lab 的四组能力若落到 DeepSonar，应遵循三点修正：

1. **扩展走治理下发，不破 `--no-extensions` 纪律**：扩展包由 RoleConfig modules 的 materializer 显式下发并随 Job 快照冻结，与 skill 源共用同一套治理；Agent 不得自装。
2. **Web 能力不得裸出网**：`cap_web_search` / `cap_read_url` 直接 fetch 会绕开 `allow_egress` 治理。禁网沙箱中的 Web 能力必须经 Gateway/受治理通道，否则等于给沙箱开后门。这条约束不在 pi-capability-lab 验收矩阵内，DeepSonar 语境必须补上。
3. **能力优先级重排**：审计场景下 audit 角色主要读代码（编辑次要）、test 角色需要执行与 PoC、Web 搜索用于情报补充。DeepSonar 真正需要的是**执行 + Web + 子任务**，编辑/LSP 属低优先级；pi-capability-lab 若为 DeepSonar 服务，验收顺序应照此调整。

## 6. 优先级建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | #34 数据库迁移 + #38 WS 鉴权 | 两处均为文档自认的已知缺口，且都是产品化硬门槛 |
| P1 | executor/agentbox 域化、测试统一入口、文档版本 CI 断言 | 三项都是低成本"让纪律重新咬合"的修复 |
| P2 | Pi 扩展治理下发（承接 §5）+ 预置杀手审计工作流 | 能力纵深与生态冷启动 |
| P3 | 开源策略决策 | 差异化清晰（审计导向 + 收敛纪律 + 中国区可部署）；开源核心 + 专有控制台是值得认真考虑的路径 |

## 7. 给实现者的提醒

- 本评审的事实快照以证据基准 commit 为准；实施前重新确认行数、版本与 Issue 状态。
- 本文件是评审意见，不构成设计共识；如采纳其中条目，请同步到 DESIGN.md §11 与对应 Issue，保持"文档以代码为准"的纪律。
