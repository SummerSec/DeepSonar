# agent-harness — 沙箱镜像与工具约定

ARCHITECTURE §8：harness 已收缩为「镜像定义 + Job-scoped HTTP API 控制约定」。真实 Job 只使用平台注入的静态 `deepsonar-control` Skill 和短期 capability token，语义事件经 Job 级 API 回传（沙箱可断网、零长期凭据）。

## 官方镜像

- `deepsonar-base`：固定 digest 的 Node 22 Debian slim + 最小通用 CLI。
- `deepsonar-audit`：在 base 清单上增加 Semgrep、Gitleaks、ShellCheck、binutils，默认供 Audit 使用。
- `deepsonar-kali-minimal`（市场名 Kali Test）：仅 Test 的默认环境。固定官方 Kali last-release digest，预装 Python 3.10–3.14、Temurin JDK 8/11/17（默认 17，不含 21）、固定 Apache Maven 3.9.16、Go、Rust 与原有审计 CLI；Maven 安装到 `/opt/deepsonar/maven`，镜像不预置 `.m2` 缓存。不安装 `kali-linux-*`、`kali-tools-*`、GUI 或桌面。Verify 默认使用最小的 `deepsonar-base`，需要专项工具时再由 RoleConfig 覆盖。
- `deepsonar-openharmony-test` / `deepsonar-openharmony-audit` / `deepsonar-openharmony-fuzz`：OpenHarmony 专项（`project_opt_in`）。Test 负责源码同步、构建，并钉死官方 SDK `toolchains/hdc` 设备协议（冒烟 `hdc version` / `hdc -v`，不要求真机）；Audit 面向高危主机静态分析（Clang/clang-tidy/cppcheck/sparse + ASan/UBSan）；Fuzz 面向主机动态验证（libFuzzer/AFL++）。均基于 `deepsonar-base`，Dockerfile 见 `deploy/Dockerfile.agent-openharmony*`。
- `deepsonar-chrome-audit` / `deepsonar-chrome-test` / `deepsonar-chrome-fuzz`：Chrome 专项（`project_opt_in`）。Audit 提供 C++ 静态分析；Test 提供固定 Chromium/CDP；Fuzz 提供固定 V8 `d8` 与 libFuzzer。均基于 `deepsonar-base`，Dockerfile 见 `deploy/Dockerfile.agent-chrome*`。

`runtime-images.json` 与 `kali-minimal-runtime.json` 记录工具、来源、校验和、平台与 `maxSizeMiB`。`maxSizeMiB` 约束 `docker save` 后 gzip 压缩的可分发镜像包；CI 同时报告解压层大小。压缩包超预算、定义漂移或断网硬化冒烟失败都会阻断 CI。

### Fingerprint 与专项 CI

`agent-harness/image-build-fingerprint.mjs` 使用显式的 `FINGERPRINT_SCHEMA_VERSION`；所有 preset 统一把根目录 `.dockerignore` 纳入输入，以便构建上下文规则变化不会错误复用 GHCR `src-*` 标签。算法语义变化时必须 bump schema version；新增无关 preset 不应使既有镜像全部重编。

核心门禁与 base/audit/Kali 镜像入口是 `.github/workflows/ci.yml`。Chrome amd64 合同冒烟与缓存复用入口是 `.github/workflows/chrome-runtime.yml`；OpenHarmony test/audit/fuzz 保持 amd64/arm64 矩阵、QEMU 与离线环境冒烟（Test 含 hdc version，不要求真机），入口是 `.github/workflows/openharmony-runtime.yml`。两个专项 workflow 都支持 PR/main 路径过滤与 `workflow_dispatch`，仅在自身输入、`.dockerignore`、共享 fingerprint/cache 机制或 workflow 改动时触发。

构建 base/audit：`DEEPSONAR_IMAGE_TOOLSET=base|audit npx agentbox image build --provider local-docker --file agent-harness/image.mjs`。Kali Test 使用 `deploy/Dockerfile.agent-kali-minimal`；Python 版本化命令为 `python3.10`…`python3.14`，Java 可用 `java8`/`javac8`、`java11`/`javac11` 与默认的 `java17`/`javac17`，Maven 可用 `mvn`（3.9.16）。断网硬化冒烟执行 `mvn -v`；联网最小 POM 构建可运行 `node agent-harness/test-maven-package.mjs deepsonar-kali-minimal:local`。

动态测试的 RoleConfig/证据纪律、Java/Python/Go/Rust 静态—动态矩阵见 [`docs/RUNTIME_TEST_TOOLCHAINS.md`](../docs/RUNTIME_TEST_TOOLCHAINS.md)。系统 Verify 仍默认使用 Base；只在项目级 RoleConfig 中显式选择已准入的动态镜像，不把 Kali 全局化。

### 静态审计 vs 动态验证（多语言）

| 阶段 | 角色 | 推荐镜像 | 说明 |
|------|------|----------|------|
| 静态审计 | audit | `deepsonar-audit` | 读仓 + Semgrep 等；多数语言可起步 |
| 动态验证 / PoC | test | `deepsonar-kali-minimal` | 需编译运行时**必须**用 Kali（或专项），勿绑 base |
| 系统验证 | verify | 默认 base；需 runtime 时 RoleConfig 覆盖为 Kali/专项 | 与 test 同样受语言工具链约束 |

| 语言 / 能力 | base | Kali Test |
|-------------|------|-----------|
| Python | 系统 python3 单版本 | 3.10–3.14 + `uv` |
| Go | 无 | `golang-go` |
| Rust | 无 | `rustc` + `cargo` |
| Java | 无 | JDK 8/11/17 + Maven 3.9.16（`/opt/deepsonar/maven`，无预置 `.m2`）；无 Gradle |
| Docker-in-Docker | 无 | 无 |

- test 误绑 base 时：Go/Rust/Java/Maven 会 `command not found`，Python 仅有弱单版本；Agent 常在 Job 内下载工具链，不可复现且易 rework 空转。
- 正确使用 Kali 时：Java 可用 `java*`/`javac*`/`mvn`；Python/Go/Rust 亦有预装工具链。依赖下载仍受冻结的 `DEEPSONAR_ALLOW_EGRESS` 约束。
- 不把完整语言矩阵塞进 base；重型栈（DB/Compose/K8s）用专项镜像或宿主编排，不默认进 Kali metapackage。
- 证据纪律与矩阵细节见 [`docs/RUNTIME_TEST_TOOLCHAINS.md`](../docs/RUNTIME_TEST_TOOLCHAINS.md)。

## Job-scoped API 能力（§3.4）

每个真实 Job 都注入同一份平台内置、不可由 RoleConfig 同名覆盖的静态 `deepsonar-control` Skill。Job 创建时冻结角色允许的 operation，运行时只提供对应的 Job-scoped HTTP API 和短期 capability token：

- Agent 通过自身可用的 HTTP 工具调用 `$DEEPSONAR_API_BASE_URL/agent/capabilities_list` 发现当前 Job 的精确 operation allowlist；需要完整机器可读描述时读取 `$DEEPSONAR_API_BASE_URL/openapi.json`。
- 语义操作统一调用 `$DEEPSONAR_API_BASE_URL/operations/:operationId`，使用 `Authorization: Bearer $DEEPSONAR_API_TOKEN`、JSON `Content-Type` 和规范 UUID `Idempotency-Key`。
- `emit_progress`、`emit_fact`、`emit_finding`、`submit_hub_decision`、`mark_job_done`、`request_human` 等 operation 仍按角色裁剪，分别提交进度、事实、Finding、Hub 决策、完成或人工阻塞提案。
- API 返回 `accepted` 只表示 Scheduler 已接收输入，仍会按 Job 状态、冻结 operation 和严格 payload 契约重验并记账；HTTP 错误响应按返回的稳定错误码处理，临时错误使用相同幂等键重试。

真实 Job 不注入控制 MCP，不从 CLI 结构化流映射伪造的 MCP tool call，也不在 API 失败后回退其他控制通道；Agent 不持有管理 API、数据库或宿主凭据。沙箱内权限完全开放（`approvalMode: "auto"`），安全边界 = 网络策略 + 一次性容器。

同一画布产生新 Fact/Finding 时，数据库 `NOTIFY` 唤醒调度器；调度器使用 `Agent.attach(...).sendMessage(...)` 给仍在运行的其他 Agent CLI 追加一条增量通知。首次 prompt 仍是完整任务，追加消息只携带提交后的新画布数据。

Job 控制 API-only 契约冒烟：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-control-api.ts`。
画布增量消息冒烟（需本地 PostgreSQL）：`pnpm --filter @deepsonar/scheduler exec tsx ../../agent-harness/test-canvas-updates.ts`。

## CI P0 门禁（`.github/workflows/ci.yml`）

Chrome/OpenHarmony 专项镜像检查不在核心 workflow 中：分别由 `.github/workflows/chrome-runtime.yml` 与 `.github/workflows/openharmony-runtime.yml` 按路径过滤触发。

在 `AGENT_MODE=fake` 下串跑：

| 脚本 | 覆盖 |
|---|---|
| `test-control-api.ts` | Job 控制 API-only 契约、静态 Skill、冻结权限与 OpenAPI 投影 |
| `test-roles-api.py` | 角色注册表 / RoleConfig |
| `test-hub-loop.py` | Hub→Audit→Finding→Verify→complete |
| `test-local-project-api.py` | 项目/任务/事件/重试/归档 |
| `test-auth-api.py` | API Token 鉴权（独立 3101 + `DEEPSONAR_AUTH_REQUIRED`） |
| `test-runtime-images-api.py` | 镜像目录、隔离导入、审批门禁、项目启用与 Job digest 冻结 |

环境变量：`DEEPSONAR_BASE`（默认 `http://127.0.0.1:3100`）、`DEEPSONAR_ADMIN_TOKEN`、`DEEPSONAR_HUB_SMOKE_TIMEOUT`。
本地快捷：`pnpm ci:smoke:control-api` / `ci:smoke:roles` / `ci:smoke:hub` / `ci:smoke:projects` / `ci:smoke:auth`。
