# agent-harness — 沙箱镜像与工具约定

ARCHITECTURE §8：harness 已收缩为「镜像定义 + hooks/MCP 白名单工具约定」，事件经 agentbox-sdk 控制通道回传（沙箱可断网、零凭据）。

## 官方镜像

- `deepsonar-base`：固定 digest 的 Node 22 Debian slim + 最小通用 CLI。
- `deepsonar-audit`：在 base 清单上增加 Semgrep、Gitleaks、ShellCheck、binutils，默认供 Audit 使用。
- `deepsonar-kali-minimal`（市场名 Kali Test）：仅 Test 的默认环境。固定官方 Kali last-release digest，预装 Python 3.10–3.14、Temurin JDK 8/11/17（默认 17，不含 21）、Go、Rust 与原有审计 CLI；不安装 `kali-linux-*`、`kali-tools-*`、GUI 或桌面。Verify 默认使用最小的 `deepsonar-base`，需要专项工具时再由 RoleConfig 覆盖。

`runtime-images.json` 与 `kali-minimal-runtime.json` 记录工具、来源、校验和、平台与 `maxSizeMiB`。`maxSizeMiB` 约束 `docker save` 后 gzip 压缩的可分发镜像包；CI 同时报告解压层大小。压缩包超预算、定义漂移或断网硬化冒烟失败都会阻断 CI。

构建 base/audit：`DEEPSONAR_IMAGE_TOOLSET=base|audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs`。Kali Test 使用 `deploy/Dockerfile.agent-kali-minimal`；Python 版本化命令为 `python3.10`…`python3.14`，Java 可用 `java8`/`javac8`、`java11`/`javac11` 与默认的 `java17`/`javac17`。

## 白名单工具注入（§3.4）

每个 Job 经 agentbox-sdk 动态注入本地 `deepsonar-control` MCP；工具按角色裁剪：

- `emit_progress` → 调度器 `progress` 事件
- `emit_fact` → 调度器 `fact` 事件（运行中可多次调用）
- `emit_finding`（payload = SARIF 子集，见 shared-types FindingPayload）→ `finding` 事件
- `submit_hub_decision` → 调度器 `hub_decision` 事件
- `mark_job_done` → `done` 事件
- `request_human` → `human` 事件

MCP 只写本地控制队列，调度器通过 agentbox 控制通道增量读取，不需要 Scheduler API/数据库凭据，也不受 Worker 目标出网策略影响。沙箱内权限完全开放（`approvalMode: "auto"`），安全边界 = 网络策略 + 一次性容器。

同一画布产生新 Fact/Finding 时，数据库 `NOTIFY` 唤醒调度器；调度器使用 `Agent.attach(...).sendMessage(...)` 给仍在运行的其他 Agent CLI 追加一条增量通知。首次 prompt 仍是完整任务，追加消息只携带提交后的新画布数据。

本地 MCP 协议冒烟：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-control-mcp.ts`。
画布增量消息冒烟（需本地 PostgreSQL）：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-canvas-updates.ts`。

## CI P0 门禁（`.github/workflows/ci.yml`）

在 `AGENT_MODE=fake` 下串跑：

| 脚本 | 覆盖 |
|---|---|
| `test-control-mcp.ts` | 控制 MCP 协议 + 工具说明 |
| `test-roles-api.py` | 角色注册表 / RoleConfig |
| `test-hub-loop.py` | Hub→Audit→Finding→Verify→complete |
| `test-local-project-api.py` | 项目/任务/事件/重试/归档 |
| `test-auth-api.py` | API Token 鉴权（独立 3101 + `DEEPSONAR_AUTH_REQUIRED`） |
| `test-runtime-images-api.py` | 镜像目录、隔离导入、审批门禁、项目启用与 Job digest 冻结 |

环境变量：`DEEPSONAR_BASE`（默认 `http://127.0.0.1:3100`）、`DEEPSONAR_ADMIN_TOKEN`、`DEEPSONAR_HUB_SMOKE_TIMEOUT`。
本地快捷：`pnpm ci:smoke:mcp` / `ci:smoke:roles` / `ci:smoke:hub` / `ci:smoke:projects` / `ci:smoke:auth`。
