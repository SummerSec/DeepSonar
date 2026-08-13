# DeepSonar 项目深度评审与优先级建议

**日期：** 2026-08-13（快照刷新：2026-08-13 晚）  
**状态：** 独立评审意见，**非** `DESIGN.md` 共识演进；仅作决策参考。实施前以代码、schema、OpenAPI 与 Issue 为准。  
**证据基准：** main @ `d170de4`；`SCHEMA_VERSION = 29`。

> 本文件会随时间漂移。若与 as-built 冲突，以代码与 `DESIGN.md` 为准，不要把下文当缺陷清单。

## 1. 总体判断

DeepSonar 在多智能体编排里把纪律做硬：四层真相、Agent 只提案、fact–intent 二分图、验证硬门。差异化是「可审计、可回滚、可收敛」，而不是「Agent 干更多事」。

主要矛盾仍是**迭代速度 vs 维护咬合**：runtime 大文件、测试入口、专项镜像维护税。部署/镜像类过时方案稿已清理；schema 版本号漂移已修正（见 §4.1）。  
**#34 增量 migration 短期搁置**——项目未完全成熟、表结构仍有多轮优化空间，继续「基线 + 重建库」即可。

## 2. 证据快照（刷新）

| 指标 | 值 | 证据 |
|---|---|---|
| TS 源文件（apps+packages，排除 dist） | ~278 | `Get-ChildItem … *.ts` |
| 领域目录 | 25 | `apps/scheduler/src/domains/` |
| `*.test.ts` | ~128 | 全仓 apps/packages |
| Schema | ~1488 行，**v29**，无增量 migration | `database/schema.sql`、`schema-version.ts` |
| Commit 数 | ~384 | `git rev-list --count HEAD` |
| Agent CLI | Claude Code / Codex / OpenCode / Pi | 代码注册表 |
| 官方/专项镜像 | base/audit/kali-minimal + Chrome×3 + OpenHarmony×3 | `agent-harness/*-runtime.json` |
| 大文件（行数约） | `agentbox.ts` ~2577、`executor-real.ts` ~1521 | runtime-sandbox / scheduler |
| Skills | `deepsonar-management` | `skills/` |

## 3. 值得肯定的架构决策（仍成立）

1. **D1–D6 控制面 doctrine**：默认拒绝 + 三层校验 + 稳定错误码。  
2. **Job Attempt + effects 账本**：intent → settlement、`replay_policy=never`、未知不重放。  
3. **Bounded contexts（#37）**：领域 application/ports + characterization。  
4. **发布工程**：指纹构建、ACR→GHCR→Docker Hub、fail-closed。  
5. **部署默认路径**：`deploy/deploy.sh up` = **real + ACR pull**（见 `docs/ONE_CLICK_DEPLOYMENT.md`）。

## 4. 风险与建议

### 4.1 文档版本漂移

**原状（评审时）：** 代码 v27/v29 一带，README 写 schema v23、AGENTS 写 v22。  

**现状（刷新后）：** AGENTS / DESIGN / `database/README` 对齐 **v29**；README 不再用过期基线号冒充当前版本。  

**仍建议：** 加「文档表征测试」断言 `SCHEMA_VERSION` 与 AGENTS/DESIGN/database README 中的版本字面量一致，避免再漂。

### 4.2 无 migration 策略（短期不推进）

「改表 = 重建库」在真实部署下有利息，但**短期不考虑增量 migration（#34）**：产品与 schema 仍在快速迭代，过早上迁移会锁死演进、增加维护面。  

**当前纪律不变**：基线 + bump + 重建库；破坏性变更在 Release / 运维说明里写清楚即可。  
**再评估时机**：产品形态与表结构明显稳定、且已有不可轻易重建的生产库之后。

### 4.3 维护面 vs 单兵

4 CLI + Chrome×3 + OpenHarmony×3 的专项税仍在。  

**建议：** project-opt-in 运行时按客户驱动保留/冻结；避免预研镜像吃主线。

### 4.4 执行心脏未域化

`agentbox.ts` / `executor-real.ts` 仍是最大未域化块。  

**建议：** 按 #37 同一方法拆 runtime 域，characterization 先行。

### 4.5 测试入口分散

多 `ci:*` script + `tsx --test` + 冒烟脚本。  

**建议：** 薄统一入口（如 `pnpm test`）降低「写了但没挂 CI」的概率。

### 4.6 生态冷启动

官方 skill 仍以 management 为主；缺 10 分钟可见闭环的预置审计工作流。

## 5. Pi 能力扩展（路线约束，仍成立）

1. 扩展只走 RoleConfig materializer 治理下发，不破 `--no-extensions`。  
2. Web 能力不得裸出网，须经 Gateway / `allow_egress` 纪律。  
3. 审计场景优先：执行 + Web + 子任务；编辑/LSP 低优先级。

## 6. 优先级建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | #38 WS 鉴权（及同类运行时安全咬合） | 产品化硬门槛；**不含** #34 |
| P1 | executor/agentbox 域化、测试统一入口、文档版本 CI 断言 | 纪律咬合、优化空间 |
| P2 | Pi 扩展治理下发 + 预置杀手审计工作流 | 能力与冷启动 |
| P3 | 开源策略 | 审计导向 + 中国区可部署 |
| 搁置 | #34 增量 migration | 项目未完全成熟；表结构仍多优化空间，短期坚持重建库 |

## 7. 给实现者的提醒

- 事实以**证据基准 commit** 与当前 `SCHEMA_VERSION` 为准；动手前再对一遍行数与 Issue。  
- 采纳条目须回写 `DESIGN.md` §11 与 GitHub Issue，保持「文档以代码为准」。  
- 部署与镜像：以 `deploy/README.md`、`docs/ONE_CLICK_DEPLOYMENT.md`、`docs/RELEASE_RUNTIME_IMAGES.md` 为准；过时 TODO 方案稿已删除。
